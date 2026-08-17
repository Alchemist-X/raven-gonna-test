import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ModelRequest } from "@raven-gonna-test/forecast-core";
import { describe, expect, it } from "vitest";
import { buildClaudeCliArgs, ClaudeCliPredictor, parseClaudeStream } from "./claude-cli.js";

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
    expect(parsed.usage).toMatchObject({ input_tokens: 10, total_cost_usd: 0.25, num_turns: 3 });
    expect(parsed.model).toBe("claude-opus-5");
    expect(parsed.isError).toBe(false);
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

  it("fails the trial when the CLI exits non-zero", async () => {
    const predictor = new ClaudeCliPredictor({ model: "m", executable: fakeClaude("Not logged in", 1) });
    await expect(predictor.generate(request(), new AbortController().signal)).rejects.toThrow(/exited 1/);
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
