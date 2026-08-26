import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ForecastTask, ModelRequest } from "@raven-gonna-test/forecast-core";
import { describe, expect, it } from "vitest";
import {
  answerSchemaForTask,
  buildCodexExecArgs,
  CodexCliPredictor,
  isRetryableCodexFailure,
  parseCodexExecStream
} from "./codex-cli.js";

const request = (overrides: Partial<ModelRequest> = {}): ModelRequest =>
  ({
    task: {} as ModelRequest["task"],
    policy: {} as ModelRequest["policy"],
    systemPrompt: "Be calibrated.",
    userPrompt: "Will it rain?",
    answerType: "binary",
    research: true,
    reasoningEffort: "medium",
    ...overrides
  }) as ModelRequest;

const files = { schemaFile: "/tmp/schema.json", lastMessageFile: "/tmp/last.json", workDir: "/tmp/work" };

// Schema generation only reads kind-specific shape fields; a full valid task
// is irrelevant to these tests.
const task = (shape: Record<string, unknown>): ForecastTask => shape as unknown as ForecastTask;
const property = (schema: Record<string, unknown>, name: string): Record<string, unknown> =>
  (schema.properties as Record<string, Record<string, unknown>>)[name]!;

// Predictor tests need a real per-call scratch home, which needs a real
// auth.json source. An empty directory works: the symlink is simply dangling.
const fakeAuthHome = (): string => mkdtempSync(path.join(tmpdir(), "codex-auth-"));

// Stand in for the real CLI so the port can be exercised without spending
// quota. Unlike the Claude fake, this one must honour --output-last-message,
// because the port treats that file as the authoritative final answer.
function fakeCodex(
  stdoutBody: string,
  exitCode = 0,
  options: { sleepMs?: number; lastMessage?: string; countFile?: string; failFirstFlag?: string } = {}
): string {
  const directory = mkdtempSync(path.join(tmpdir(), "codex-cli-test-"));
  const file = path.join(directory, "fake-codex");
  const lines = [
    "#!/bin/sh",
    'out=""; prev=""',
    'for a in "$@"; do',
    '  [ "$prev" = "--output-last-message" ] && out="$a"',
    '  prev="$a"',
    "done",
    "cat > /dev/null",
    ...(options.countFile ? [`echo attempt >> "${options.countFile}"`] : []),
    ...(options.failFirstFlag
      ? [
          `if [ ! -f "${options.failFirstFlag}" ]; then`,
          `  touch "${options.failFirstFlag}"`,
          `  echo '{"type":"error","message":"stream disconnected before completion"}'`,
          "  exit 1",
          "fi"
        ]
      : []),
    ...(options.sleepMs ? [`sleep ${options.sleepMs / 1000}`] : []),
    ...(options.lastMessage ? [`[ -n "$out" ] && printf '%s' '${options.lastMessage}' > "$out"`] : []),
    "cat <<'STREAM'",
    stdoutBody,
    "STREAM",
    `exit ${exitCode}`
  ];
  writeFileSync(file, `${lines.join("\n")}\n`);
  chmodSync(file, 0o755);
  return file;
}

const agentMessage = (text: string): string =>
  JSON.stringify({ type: "item.completed", item: { id: "i", type: "agent_message", text } });
const webSearch = (query: string): string =>
  JSON.stringify({ type: "item.completed", item: { id: "i", type: "web_search", query, action: { type: "search", query } } });
const turnCompleted = (usage: Record<string, unknown>): string => JSON.stringify({ type: "turn.completed", usage });

describe("buildCodexExecArgs", () => {
  it("runs isolated: private-home flags, read-only sandbox, scratch cwd, machine output", () => {
    const args = buildCodexExecArgs({ model: "gpt-5.6-sol" }, request(), files);
    expect(args[0]).toBe("exec");
    for (const flag of ["--json", "--ephemeral", "--skip-git-repo-check", "--ignore-user-config", "--ignore-rules"]) {
      expect(args).toContain(flag);
    }
    expect(args[args.indexOf("--sandbox") + 1]).toBe("read-only");
    expect(args[args.indexOf("--cd") + 1]).toBe("/tmp/work");
    expect(args[args.indexOf("--model") + 1]).toBe("gpt-5.6-sol");
    expect(args[args.indexOf("--output-schema") + 1]).toBe("/tmp/schema.json");
    expect(args[args.indexOf("--output-last-message") + 1]).toBe("/tmp/last.json");
  });

  it("passes effort as quoted TOML and lets config reach tiers ModelRequest cannot express", () => {
    const derived = buildCodexExecArgs({ model: "m" }, request({ reasoningEffort: "high" }), files);
    expect(derived).toContain('model_reasoning_effort="high"');
    const overridden = buildCodexExecArgs({ model: "m", effort: "ultra" }, request({ reasoningEffort: "high" }), files);
    expect(overridden).toContain('model_reasoning_effort="ultra"');
  });

  it("states web_search explicitly so a default flip cannot silently remove research", () => {
    expect(buildCodexExecArgs({ model: "m" }, request(), files)).toContain("tools.web_search=true");
  });

  it("fails closed on a no-web policy, because this build cannot disable search", () => {
    // Measured: -c tools.web_search=false and the browser_use feature switches
    // all left the model able to search. An unenforceable policy must refuse,
    // not degrade to a politely-worded prompt.
    expect(() => buildCodexExecArgs({ model: "m" }, request({ research: false }), files)).toThrow(/no-web/);
  });
});

describe("answerSchemaForTask", () => {
  it("puts rationale first so constrained decoding reasons before it answers", () => {
    for (const kind of ["binary_probability", "numeric", "free_response"] as const) {
      const schema = answerSchemaForTask(task({ kind, choices: ["A"], candidates: [], rankCount: 1 }));
      expect(Object.keys(schema.properties as Record<string, unknown>)[0]).toBe("rationale");
      expect(schema.additionalProperties).toBe(false);
    }
  });

  it("matches the field names parseModelAnswer already accepts", () => {
    const binary = answerSchemaForTask(task({ kind: "binary_probability" }));
    expect(Object.keys(binary.properties as Record<string, unknown>)).toContain("probability");
    expect(binary.required).toEqual(["rationale", "sources", "probability"]);

    const numeric = answerSchemaForTask(task({ kind: "numeric", integerValued: false }));
    expect(numeric.required).toEqual(["rationale", "sources", "value", "standard_deviation"]);

    const free = answerSchemaForTask(task({ kind: "free_response" }));
    expect(free.required).toEqual(["rationale", "sources", "answer"]);
  });

  it("pins categorical probabilities to exactly the offered choices", () => {
    const schema = answerSchemaForTask(task({ kind: "categorical", choices: ["Yes", "No", "Tie"] }));
    const probabilities = property(schema, "probabilities");
    expect(Object.keys(probabilities.properties as Record<string, unknown>)).toEqual(["Yes", "No", "Tie"]);
    expect(probabilities.required).toEqual(["Yes", "No", "Tie"]);
    expect(probabilities.additionalProperties).toBe(false);
  });

  it("enumerates ranking candidates when the task names them, and not otherwise", () => {
    const named = answerSchemaForTask(task({ kind: "ranking", candidates: ["A", "B", "C"], rankCount: 2 }));
    expect((property(named, "ranking").items as Record<string, unknown>).enum).toEqual(["A", "B", "C"]);
    const open = answerSchemaForTask(task({ kind: "ranking", candidates: [], rankCount: 3 }));
    expect((property(open, "ranking").items as Record<string, unknown>).enum).toBeUndefined();
  });

  it("constrains multi_label selections to the offered options", () => {
    const schema = answerSchemaForTask(task({ kind: "multi_label", choices: ["A", "B"] }));
    expect((property(schema, "selected").items as Record<string, unknown>).enum).toEqual(["A", "B"]);
  });
});

describe("parseCodexExecStream", () => {
  it("keeps message order and the searches actually issued", () => {
    // Real shape from a probed run: the model emitted a schema-conforming
    // placeholder BEFORE searching, then the real answer.
    const stream = [
      JSON.stringify({ type: "thread.started", thread_id: "t1" }),
      agentMessage('{"mean":0,"standard_deviation":0}'),
      webSearch("site:bankofengland.co.uk Bank Rate current"),
      webSearch("site:bankofengland.co.uk Bank Rate current"),
      agentMessage('{"mean":3.75,"standard_deviation":0.0}'),
      turnCompleted({ input_tokens: 33956, output_tokens: 200, reasoning_output_tokens: 98 })
    ].join("\n");
    const parsed = parseCodexExecStream(stream);
    expect(parsed.messages).toEqual(['{"mean":0,"standard_deviation":0}', '{"mean":3.75,"standard_deviation":0.0}']);
    expect(parsed.searchQueries).toEqual(["site:bankofengland.co.uk Bank Rate current"]);
    expect(parsed.usage).toMatchObject({ input_tokens: 33956, reasoning_output_tokens: 98 });
    expect(parsed.isError).toBe(false);
  });

  it("treats turn.failed as fatal and keeps its message for the rejection", () => {
    const stream = [
      JSON.stringify({ type: "error", message: "upstream 400" }),
      JSON.stringify({ type: "turn.failed", error: { message: "The model is not supported" } })
    ].join("\n");
    const parsed = parseCodexExecStream(stream);
    expect(parsed.isError).toBe(true);
    expect(parsed.failureMessage).toBe("The model is not supported");
  });

  it("does not treat benign error items as fatal", () => {
    // The CLI routinely emits item-level errors for feature warnings; a run
    // that produced an answer despite them succeeded.
    const stream = [
      JSON.stringify({ type: "item.completed", item: { id: "i", type: "error", message: "Skill descriptions were shortened" } }),
      agentMessage("done")
    ].join("\n");
    const parsed = parseCodexExecStream(stream);
    expect(parsed.isError).toBe(false);
    expect(parsed.messages).toEqual(["done"]);
  });

  it("collects reasoning items as thinking when the CLI surfaces them", () => {
    const stream = [
      JSON.stringify({ type: "item.completed", item: { id: "i", type: "reasoning", text: "weighing base rates" } }),
      agentMessage("done")
    ].join("\n");
    expect(parseCodexExecStream(stream).thinking).toBe("weighing base rates");
  });

  it("survives interleaved non-JSON and partial lines", () => {
    const stream = ["Reading prompt from stdin...", "{ truncated", "", agentMessage("done")].join("\n");
    expect(parseCodexExecStream(stream).messages).toEqual(["done"]);
  });
});

describe("isRetryableCodexFailure", () => {
  it("retries transport flakes but never permanent failures", () => {
    expect(isRetryableCodexFailure("Codex CLI exited 1: stream disconnected")).toBe(true);
    expect(isRetryableCodexFailure("Codex CLI exited 1: 502 bad gateway")).toBe(true);
    expect(isRetryableCodexFailure("invalid_request_error: The 'gpt-5.2' model is not supported")).toBe(false);
    expect(isRetryableCodexFailure("You have hit your usage limit")).toBe(false);
    expect(isRetryableCodexFailure("Not logged in")).toBe(false);
    expect(isRetryableCodexFailure("Codex CLI timed out after 60ms.")).toBe(false);
  });
});

describe("CodexCliPredictor", () => {
  it("rejects an empty model id rather than spawning a doomed call", () => {
    expect(() => new CodexCliPredictor({ model: "  " })).toThrow(/model id/);
  });

  it("prefers the last-message file over interim stream messages", async () => {
    const stream = [agentMessage('{"probability":0}'), webSearch("who won"), agentMessage("stream-final")].join("\n");
    const predictor = new CodexCliPredictor({
      model: "gpt-5.6-sol",
      authHome: fakeAuthHome(),
      executable: fakeCodex(stream, 0, { lastMessage: '{"probability":0.62,"rationale":"seen"}' })
    });
    const response = await predictor.generate(request(), new AbortController().signal);
    expect(response.content).toBe('{"probability":0.62,"rationale":"seen"}');
    expect(response.citations).toEqual(["search://who%20won"]);
    expect(response.usage).toMatchObject({ web_search_requests: 1 });
    expect(response.model).toBe("gpt-5.6-sol");
  });

  it("falls back to the last stream message when the CLI died before writing the file", async () => {
    const stream = [agentMessage("first"), agentMessage("salvageable"), turnCompleted({ output_tokens: 5 })].join("\n");
    const predictor = new CodexCliPredictor({ model: "m", authHome: fakeAuthHome(), executable: fakeCodex(stream) });
    const response = await predictor.generate(request(), new AbortController().signal);
    expect(response.content).toBe("salvageable");
    expect(response.usage).toMatchObject({ output_tokens: 5, web_search_requests: 0 });
  });

  it("retries a transient failure and succeeds on the second attempt", async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "codex-retry-"));
    const predictor = new CodexCliPredictor({
      model: "m",
      authHome: fakeAuthHome(),
      maxRetries: 1,
      retryBaseMs: 1,
      executable: fakeCodex(agentMessage("recovered"), 0, { failFirstFlag: path.join(directory, "failed-once") })
    });
    const response = await predictor.generate(request(), new AbortController().signal);
    expect(response.content).toBe("recovered");
  });

  it("does not retry a permanent failure, which would only burn quota", async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "codex-count-"));
    const countFile = path.join(directory, "attempts");
    const stream = JSON.stringify({ type: "turn.failed", error: { message: "invalid_request_error: model not supported" } });
    const predictor = new CodexCliPredictor({
      model: "m",
      authHome: fakeAuthHome(),
      maxRetries: 2,
      retryBaseMs: 1,
      executable: fakeCodex(stream, 1, { countFile })
    });
    await expect(predictor.generate(request(), new AbortController().signal)).rejects.toThrow(/not supported/);
    expect(readFileSync(countFile, "utf8").trim().split("\n")).toHaveLength(1);
  });

  it("fails rather than returning an empty answer the parser would choke on", async () => {
    const predictor = new CodexCliPredictor({
      model: "m",
      authHome: fakeAuthHome(),
      maxRetries: 0,
      executable: fakeCodex(turnCompleted({ output_tokens: 0 }))
    });
    await expect(predictor.generate(request(), new AbortController().signal)).rejects.toThrow(/Codex CLI exited/);
  });

  it("rejects immediately when the signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort(new Error("cancelled upstream"));
    const predictor = new CodexCliPredictor({ model: "m", authHome: fakeAuthHome(), executable: fakeCodex(agentMessage("x")) });
    await expect(predictor.generate(request(), controller.signal)).rejects.toThrow(/cancelled upstream/);
  });

  it("kills the child on abort instead of orphaning it", async () => {
    const controller = new AbortController();
    const predictor = new CodexCliPredictor({
      model: "m",
      authHome: fakeAuthHome(),
      maxRetries: 0,
      executable: fakeCodex(agentMessage("too late"), 0, { sleepMs: 5_000 })
    });
    const pending = predictor.generate(request(), controller.signal);
    setTimeout(() => controller.abort(new Error("engine timeout")), 50);
    await expect(pending).rejects.toThrow(/engine timeout/);
  });

  it("enforces its own per-attempt timeout without retrying it", async () => {
    const predictor = new CodexCliPredictor({
      model: "m",
      authHome: fakeAuthHome(),
      timeoutMs: 60,
      executable: fakeCodex(agentMessage("too late"), 0, { sleepMs: 5_000 })
    });
    await expect(predictor.generate(request(), new AbortController().signal)).rejects.toThrow(/timed out after 60ms/);
  });
});
