import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ModelRequest } from "@raven-gonna-test/forecast-core";
import { describe, expect, it } from "vitest";
import { buildClaudeCliArgs, ClaudeCliPredictor, isRetryableClaudeFailure, parseClaudeStream } from "./claude-cli.js";

describe("isRetryableClaudeFailure", () => {
  it("retries the transient 403 burst seen under concurrent CLIs, but not a revoked credential or a timeout", () => {
    expect(isRetryableClaudeFailure("Claude CLI exited 1: Failed to authenticate. API Error: 403 Request not allowed")).toBe(true);
    expect(isRetryableClaudeFailure("Claude CLI exited 1: OAuth token revoked")).toBe(false);
    expect(isRetryableClaudeFailure("Claude CLI exited 1: 403 forbidden")).toBe(false);
    expect(isRetryableClaudeFailure("Claude CLI timed out after 900000ms.")).toBe(false);
    expect(isRetryableClaudeFailure("Claude CLI exited 1: stream disconnected")).toBe(true);
  });
});

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

// Stand in for the real CLI so the port can be exercised without spending
// quota: a script that prints the supplied stream-json and exits with a code.
function fakeClaude(stdoutBody: string, exitCode = 0, options: { sleepMs?: number } = {}): string {
  const directory = mkdtempSync(path.join(tmpdir(), "claude-cli-test-"));
  const file = path.join(directory, "fake-claude");
  const sleep = options.sleepMs ? `sleep ${options.sleepMs / 1000}\n` : "";
  writeFileSync(file, `#!/bin/sh\ncat > /dev/null\n${sleep}cat <<'STREAM'\n${stdoutBody}\nSTREAM\nexit ${exitCode}\n`);
  chmodSync(file, 0o755);
  return file;
}

const resultEvent = (result: string, extra: Record<string, unknown> = {}): string =>
  JSON.stringify({ type: "result", result, usage: { input_tokens: 10, output_tokens: 4 }, ...extra });

describe("buildClaudeCliArgs", () => {
  it("requests auditable stream-json and passes model, effort and tools", () => {
    const args = buildClaudeCliArgs({ model: "claude-opus-5" }, request());
    expect(args.slice(0, 4)).toEqual(["--print", "--output-format", "stream-json", "--verbose"]);
    expect(args[args.indexOf("--model") + 1]).toBe("claude-opus-5");
    expect(args[args.indexOf("--effort") + 1]).toBe("medium");
    expect(args[args.indexOf("--allowedTools") + 1]).toBe("WebSearch WebFetch");
  });

  it("isolates the call from operator context so every machine runs the same harness", () => {
    const args = buildClaudeCliArgs({ model: "m" }, request());
    // Empty setting-sources drops user/project/local settings (and the rules
    // files they inject) while retrieval and auth keep working.
    expect(args[args.indexOf("--setting-sources") + 1]).toBe("");
    expect(args).toContain("--strict-mcp-config");
  });

  it("appends rather than replaces the system prompt, keeping tool-use behaviour", () => {
    const args = buildClaudeCliArgs({ model: "m" }, request({ systemPrompt: "Cutoff: 2026-08-17." }));
    expect(args).toContain("--append-system-prompt");
    expect(args[args.indexOf("--append-system-prompt") + 1]).toBe("Cutoff: 2026-08-17.");
    expect(args).not.toContain("--system-prompt");
    // An empty system prompt must not pass a bare flag with no value.
    expect(buildClaudeCliArgs({ model: "m" }, request({ systemPrompt: "  " }))).not.toContain(
      "--append-system-prompt"
    );
  });

  it("withholds retrieval tools when the policy forbids live research", () => {
    // A prompt saying "do not use live web research" is guidance; not passing
    // the tools is enforcement. Under a no-web policy the model must be unable
    // to search, not merely asked not to.
    const denied = buildClaudeCliArgs({ model: "m" }, request({ research: false }));
    expect(denied).not.toContain("--allowedTools");
    expect(denied.join(" ")).not.toMatch(/WebSearch|WebFetch/);

    expect(buildClaudeCliArgs({ model: "m" }, request({ research: true }))).toContain("--allowedTools");
    const scoped = buildClaudeCliArgs({ model: "m" }, request({ research: { sources: ["news"] } }));
    expect(scoped[scoped.indexOf("--allowedTools") + 1]).toBe("WebSearch WebFetch");
  });

  it("lets config reach xhigh/max, which ModelRequest.reasoningEffort cannot express", () => {
    expect(buildClaudeCliArgs({ model: "m" }, request({ reasoningEffort: "high" }))).toContain("high");
    const capped = buildClaudeCliArgs({ model: "m", effort: "max" }, request({ reasoningEffort: "high" }));
    expect(capped[capped.indexOf("--effort") + 1]).toBe("max");
  });
});

describe("parseClaudeStream", () => {
  it("takes the final result text and the URLs tools actually touched", () => {
    const stream = [
      JSON.stringify({
        type: "assistant",
        message: {
          model: "claude-opus-5",
          content: [
            { type: "tool_use", name: "WebSearch", input: { query: "official guidance midpoint" } },
            { type: "tool_use", name: "WebFetch", input: { url: "https://fetched.example/a" } },
            { type: "text", text: "thinking out loud" }
          ]
        }
      }),
      JSON.stringify({
        type: "user",
        message: { content: [{ type: "tool_result", content: [{ title: "Result", url: "https://search.example/b" }] }] }
      }),
      resultEvent("<answer>0.62</answer>", { total_cost_usd: 0.25, num_turns: 3 })
    ].join("\n");

    const parsed = parseClaudeStream(stream);
    expect(parsed.content).toBe("<answer>0.62</answer>");
    expect(parsed.citations.sort()).toEqual(["https://fetched.example/a", "https://search.example/b"]);
    expect(parsed.searchQueries).toEqual(["official guidance midpoint"]);
    expect(parsed.usage).toMatchObject({ input_tokens: 10, total_cost_usd: 0.25, num_turns: 3 });
    expect(parsed.model).toBe("claude-opus-5");
    expect(parsed.isError).toBe(false);
  });

  it("keeps extended-thinking blocks, which are what make a resolved miss diagnosable", () => {
    const stream = [
      JSON.stringify({
        type: "assistant",
        message: {
          content: [
            { type: "thinking", thinking: "Guidance midpoint is 3.30 against a 3.00 threshold." },
            { type: "text", text: "visible prose" }
          ]
        }
      }),
      JSON.stringify({
        type: "assistant",
        // A redacted block carries no readable text and must not become "undefined".
        message: { content: [{ type: "thinking", data: "redacted-blob" }, { type: "thinking", thinking: "second block" }] }
      }),
      resultEvent("done")
    ].join("\n");
    const parsed = parseClaudeStream(stream);
    expect(parsed.thinking).toBe("Guidance midpoint is 3.30 against a 3.00 threshold.\n\nsecond block");
    expect(parsed.content).toBe("done");
  });

  it("reports thinking as empty rather than undefined when the model emitted none", () => {
    expect(parseClaudeStream(resultEvent("done")).thinking).toBe("");
  });

  it("falls back to the last assistant turn when the stream ends without a result", () => {
    const stream = [
      JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "first" }] } }),
      JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "salvageable" }] } })
    ].join("\n");
    // A salvageable answer beats a deleted trial, which pushes the task toward
    // all-trials-failed.
    expect(parseClaudeStream(stream).content).toBe("salvageable");
  });

  it("survives interleaved non-JSON and partial lines", () => {
    const stream = ["not json at all", "{ truncated", "", resultEvent("done")].join("\n");
    expect(parseClaudeStream(stream).content).toBe("done");
  });

  it("reports the CLI's own error flag", () => {
    expect(parseClaudeStream(resultEvent("boom", { is_error: true })).isError).toBe(true);
  });
});

describe("ClaudeCliPredictor", () => {
  it("rejects an empty model id rather than spawning a doomed call", () => {
    expect(() => new ClaudeCliPredictor({ model: "  " })).toThrow(/model id/);
  });

  it("returns content, citations and usage from a successful call", async () => {
    const stream = [
      JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", input: { url: "https://s.example" } }] } }),
      resultEvent("<answer>0.42</answer>")
    ].join("\n");
    const predictor = new ClaudeCliPredictor({ model: "claude-opus-5", executable: fakeClaude(stream) });
    const response = await predictor.generate(request(), new AbortController().signal);
    expect(response.content).toBe("<answer>0.42</answer>");
    expect(response.citations).toEqual(["https://s.example"]);
    expect(response.usage).toMatchObject({ output_tokens: 4 });
    expect(response.model).toBe("claude-opus-5");
  });

  it("surfaces thinking on the response, and omits the field when there is none", async () => {
    const withThinking = [
      JSON.stringify({ type: "assistant", message: { content: [{ type: "thinking", thinking: "weighing base rates" }] } }),
      resultEvent("<answer>0.4</answer>")
    ].join("\n");
    const port = new ClaudeCliPredictor({ model: "m", executable: fakeClaude(withThinking) });
    expect((await port.generate(request(), new AbortController().signal)).thinking).toBe("weighing base rates");

    const bare = new ClaudeCliPredictor({ model: "m", executable: fakeClaude(resultEvent("<answer>0.4</answer>")) });
    expect((await bare.generate(request(), new AbortController().signal)).thinking).toBeUndefined();
  });

  it("fails the trial when the CLI exits non-zero", async () => {
    const predictor = new ClaudeCliPredictor({ model: "m", maxRetries: 0, executable: fakeClaude("Not logged in", 1) });
    await expect(predictor.generate(request(), new AbortController().signal)).rejects.toThrow(/exited 1/);
  });

  it("retries a transient failure and succeeds on the second attempt", async () => {
    // Earned by a real incident: a transient upstream burst (kimi base URL)
    // failed every trial of a batch that passed cleanly when rerun.
    const directory = mkdtempSync(path.join(tmpdir(), "claude-retry-"));
    const flag = path.join(directory, "failed-once");
    const script = path.join(directory, "fake-claude");
    writeFileSync(
      script,
      `#!/bin/sh\ncat > /dev/null\nif [ ! -f "${flag}" ]; then\n  touch "${flag}"\n  echo "upstream 529 overloaded" >&2\n  exit 1\nfi\ncat <<'STREAM'\n${resultEvent("<answer>0.5</answer>")}\nSTREAM\nexit 0\n`
    );
    chmodSync(script, 0o755);
    const predictor = new ClaudeCliPredictor({ model: "m", maxRetries: 1, retryBaseMs: 1, executable: script });
    const response = await predictor.generate(request(), new AbortController().signal);
    expect(response.content).toBe("<answer>0.5</answer>");
  });

  it("does not retry a revoked credential, which no retry can fix", async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "claude-count-"));
    const countFile = path.join(directory, "attempts");
    const script = path.join(directory, "fake-claude");
    writeFileSync(
      script,
      `#!/bin/sh\ncat > /dev/null\necho attempt >> "${countFile}"\necho "API Error: 401 OAuth access token has been revoked." >&2\nexit 1\n`
    );
    chmodSync(script, 0o755);
    const predictor = new ClaudeCliPredictor({ model: "m", maxRetries: 2, retryBaseMs: 1, executable: script });
    await expect(predictor.generate(request(), new AbortController().signal)).rejects.toThrow(/revoked/);
    expect(readFileSync(countFile, "utf8").trim().split("\n")).toHaveLength(1);
  });

  it("fails rather than returning an empty answer the parser would choke on", async () => {
    const predictor = new ClaudeCliPredictor({ model: "m", executable: fakeClaude(resultEvent("   ")) });
    await expect(predictor.generate(request(), new AbortController().signal)).rejects.toThrow(/Claude CLI exited/);
  });

  it("rejects immediately when the signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort(new Error("cancelled upstream"));
    const predictor = new ClaudeCliPredictor({ model: "m", executable: fakeClaude(resultEvent("x")) });
    await expect(predictor.generate(request(), controller.signal)).rejects.toThrow(/cancelled upstream/);
  });

  it("kills the child on abort instead of orphaning it", async () => {
    const controller = new AbortController();
    const predictor = new ClaudeCliPredictor({
      model: "m",
      executable: fakeClaude(resultEvent("too late"), 0, { sleepMs: 5_000 })
    });
    const pending = predictor.generate(request(), controller.signal);
    setTimeout(() => controller.abort(new Error("engine timeout")), 50);
    await expect(pending).rejects.toThrow(/engine timeout/);
  });

  it("enforces its own timeout so a hung CLI cannot hold a concurrency slot", async () => {
    const predictor = new ClaudeCliPredictor({
      model: "m",
      timeoutMs: 60,
      executable: fakeClaude(resultEvent("too late"), 0, { sleepMs: 5_000 })
    });
    await expect(predictor.generate(request(), new AbortController().signal)).rejects.toThrow(/timed out after 60ms/);
  });
});
