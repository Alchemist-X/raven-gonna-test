// ModelPort backed by the Claude Code CLI (`claude --print`).
//
// Why a subprocess rather than an HTTP client: this port spends a Claude
// subscription rather than API credit, and the CLI is what holds that
// credential. It also brings server-side WebSearch/WebFetch, which the
// forecasting prompts depend on and which a bare completions endpoint has no
// equivalent for.
//
// stream-json (rather than plain text) is what makes the run auditable: the
// per-event stream carries the tool calls the model actually made, so a cited
// URL can be reconciled against a URL that was really retrieved. A model that
// invents a source is then visible in the artifact instead of indistinguishable
// from one that did the work.
//
// No credential is read or written here. The CLI resolves auth itself, in its
// own precedence (ANTHROPIC_API_KEY, CLAUDE_CODE_OAUTH_TOKEN, or its stored
// login); an unauthenticated CLI fails the call with its own message.

import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import type { ModelPort, ModelRequest, ModelResponse } from "@raven-gonna-test/forecast-core";

export interface ClaudeCliConfig {
  /** Model id passed to `--model`, e.g. "claude-opus-5". */
  model: string;
  /** Tools the CLI may use, space-separated. Forecasting needs retrieval. */
  allowedTools?: string;
  /** Hard ceiling per call. The engine also races its own timeout. */
  timeoutMs?: number;
  /** Overrides the effort derived from ModelRequest.reasoningEffort. */
  effort?: ClaudeCliEffort;
  /** Executable to spawn; injectable for tests. */
  executable?: string;
  /** Working directory for the spawned CLI. */
  cwd?: string;
  /** Retries for transient failures. Earned the hard way: one transient burst
   *  from a slow upstream (kimi via ANTHROPIC_BASE_URL, 2026-08-22) failed
   *  every trial of a six-question batch that passed cleanly when rerun. */
  maxRetries?: number;
  retryBaseMs?: number;
}

export type ClaudeCliEffort = "low" | "medium" | "high" | "xhigh" | "max";

const DEFAULT_ALLOWED_TOOLS = "WebSearch WebFetch";
const DEFAULT_TIMEOUT_MS = 15 * 60_000;

// ModelRequest.reasoningEffort tops out at "high" while the CLI also accepts
// xhigh and max. Mapping high -> high would silently cap the top tier below
// what the hardest questions warrant, so callers reach the upper levels by
// setting config.effort explicitly.
const EFFORT_BY_REASONING: Record<ModelRequest["reasoningEffort"], ClaudeCliEffort> = {
  low: "low",
  medium: "medium",
  high: "high"
};

export function buildClaudeCliArgs(
  config: ClaudeCliConfig,
  request: Pick<ModelRequest, "reasoningEffort" | "systemPrompt" | "research">
): string[] {
  // The information policy decides whether live research is permitted. Passing
  // retrieval tools regardless would let a task run under a no-web policy
  // search anyway — the prompt says not to, but a prompt is not an enforcement
  // boundary. Withholding the tools is.
  const allowedTools = request.research === false ? "" : (config.allowedTools ?? DEFAULT_ALLOWED_TOOLS);
  const args = [
    "--print",
    "--output-format",
    "stream-json",
    "--verbose",
    // Context isolation, so the same model is the same harness on every
    // machine. Without these the CLI injects the operator's user-level rules
    // files into every forecast (measured: ~29k tokens of engineering/server
    // docs on the dev machine, different again on the fleet server), and a
    // cross-machine comparison silently stops being one. An empty
    // --setting-sources drops user/project/local settings while WebSearch and
    // the CLI's own auth keep working (verified empirically);
    // --strict-mcp-config guarantees no MCP servers ride along.
    "--setting-sources",
    "",
    "--strict-mcp-config",
    ...(allowedTools ? ["--allowedTools", allowedTools] : []),
    "--model",
    config.model,
    "--effort",
    config.effort ?? EFFORT_BY_REASONING[request.reasoningEffort]
  ];
  // Appended rather than replacing: the default system prompt carries the
  // tool-use machinery the retrieval steps rely on.
  if (request.systemPrompt.trim()) args.push("--append-system-prompt", request.systemPrompt);
  return args;
}

/**
 * Collect URLs the model actually interacted with through a tool, so a cited
 * source can be checked against something really retrieved. Two signals, chosen
 * to avoid over-capturing links merely embedded in a fetched page:
 *   - tool_use blocks carrying an `input.url` (a WebFetch the model requested)
 *   - `{title, url}` pairs (WebSearch results handed back to the model)
 */
function collectToolActivity(node: unknown, urls: Set<string>, queries: Set<string>): void {
  if (!node || typeof node !== "object") return;
  if (Array.isArray(node)) {
    for (const item of node) collectToolActivity(item, urls, queries);
    return;
  }
  const record = node as Record<string, unknown>;
  if (record.type === "tool_use" && record.input && typeof record.input === "object") {
    const input = record.input as Record<string, unknown>;
    const url = input.url;
    if (typeof url === "string" && url) urls.add(url);
    const query = input.query;
    if (typeof query === "string" && query) queries.add(query);
  }
  if (typeof record.url === "string" && typeof record.title === "string") urls.add(record.url);
  for (const value of Object.values(record)) collectToolActivity(value, urls, queries);
}

export interface ParsedClaudeStream {
  content: string;
  /**
   * Extended-thinking blocks, concatenated. Kept because after a round
   * resolves, "why was this wrong" is answerable only from the reasoning that
   * produced the number — and a benchmark that discards it can be scored but
   * not improved.
   */
  thinking: string;
  citations: string[];
  searchQueries: string[];
  usage: Record<string, unknown> | undefined;
  model: string | undefined;
  isError: boolean;
}

export function parseClaudeStream(stdout: string): ParsedClaudeStream {
  const urls = new Set<string>();
  const searchQueries = new Set<string>();
  const assistantTexts: string[] = [];
  const thinkingBlocks: string[] = [];
  let content = "";
  let usage: Record<string, unknown> | undefined;
  let model: string | undefined;
  let isError = false;

  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed[0] !== "{") continue;
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      continue; // A partial or non-JSON line is not fatal; keep reading.
    }
    collectToolActivity(event, urls, searchQueries);
    if (event.type === "assistant") {
      const message = event.message as { content?: unknown; model?: unknown } | undefined;
      if (typeof message?.model === "string") model = message.model;
      for (const block of (message?.content as unknown[]) ?? []) {
        const part = block as Record<string, unknown>;
        if (part.type === "text" && typeof part.text === "string") assistantTexts.push(part.text);
        // Redacted thinking arrives as an opaque block with no readable text;
        // there is nothing to keep in that case.
        if (part.type === "thinking" && typeof part.thinking === "string") thinkingBlocks.push(part.thinking);
      }
    } else if (event.type === "result") {
      if (typeof event.result === "string") content = event.result;
      if (event.is_error === true) isError = true;
      const raw = event.usage;
      if (raw && typeof raw === "object" && !Array.isArray(raw)) {
        usage = { ...(raw as Record<string, unknown>) };
        if (typeof event.total_cost_usd === "number") usage.total_cost_usd = event.total_cost_usd;
        if (typeof event.num_turns === "number") usage.num_turns = event.num_turns;
      }
    }
  }

  // The CLI omits the result event when it dies mid-stream; the last assistant
  // turn is still usable, and a salvageable answer beats a deleted trial.
  if (!content && assistantTexts.length) content = assistantTexts[assistantTexts.length - 1] ?? "";
  return {
    content,
    thinking: thinkingBlocks.join("\n\n"),
    citations: [...urls],
    searchQueries: [...searchQueries],
    usage,
    model,
    isError
  };
}

/**
 * Permanent failures a retry cannot fix: revoked or missing credentials,
 * malformed requests, and our own per-attempt timeout (retrying a full timeout
 * doubles the damage; the engine's trial timeout governs the total). Everything
 * else — dropped streams, 5xx bursts from an ANTHROPIC_BASE_URL upstream,
 * process flakes — is worth a bounded retry.
 */
export function isRetryableClaudeFailure(message: string): boolean {
  return !/401|403|OAuth|revoked|unauthorized|invalid_request|log.?in|logged.?in|timed out/i.test(message);
}

export class ClaudeCliPredictor implements ModelPort {
  readonly model: string;

  constructor(private readonly config: ClaudeCliConfig) {
    if (!config.model.trim()) throw new Error("ClaudeCliPredictor requires a model id.");
    this.model = config.model;
  }

  async generate(request: ModelRequest, signal: AbortSignal): Promise<ModelResponse> {
    if (signal.aborted) throw signal.reason ?? new Error("Claude CLI call aborted before start.");
    const maxRetries = this.config.maxRetries ?? 2;
    const retryBaseMs = this.config.retryBaseMs ?? 1000;
    let lastError: Error | undefined;
    for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
      if (attempt > 0) await claudeRetryDelay(Math.min(30_000, retryBaseMs * 2 ** (attempt - 1)), signal);
      try {
        return await this.runOnce(request, signal);
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        if (signal.aborted || !isRetryableClaudeFailure(lastError.message)) throw lastError;
      }
    }
    throw lastError ?? new Error("Claude CLI retry loop exited unexpectedly.");
  }

  private async runOnce(request: ModelRequest, signal: AbortSignal): Promise<ModelResponse> {
    const args = buildClaudeCliArgs(this.config, request);
    const timeoutMs = this.config.timeoutMs ?? DEFAULT_TIMEOUT_MS;

    return await new Promise<ModelResponse>((resolve, reject) => {
      // Default the working directory away from any project tree: CLAUDE.md
      // auto-discovery walks up from cwd, and a forecast must not absorb
      // whatever repository the operator happened to launch from.
      const child = spawn(this.config.executable ?? "claude", args, { cwd: this.config.cwd ?? tmpdir() });
      let stdout = "";
      let stderr = "";
      let settled = false;

      // Without this the engine's timeout would resolve its own promise while
      // the CLI kept running, orphaning a process that still holds a
      // concurrency slot and keeps spending quota.
      const stop = (reason: Error): void => {
        if (settled) return;
        settled = true;
        cleanup();
        child.kill("SIGTERM");
        reject(reason);
      };
      const timer = setTimeout(() => stop(new Error(`Claude CLI timed out after ${timeoutMs}ms.`)), timeoutMs);
      const onAbort = (): void => stop((signal.reason as Error) ?? new Error("Claude CLI call aborted."));
      const cleanup = (): void => {
        clearTimeout(timer);
        signal.removeEventListener("abort", onAbort);
      };
      signal.addEventListener("abort", onAbort, { once: true });

      child.stdout.on("data", (chunk) => (stdout += String(chunk)));
      child.stderr.on("data", (chunk) => (stderr += String(chunk)));
      child.on("error", (error) => stop(error instanceof Error ? error : new Error(String(error))));
      child.on("close", (code) => {
        if (settled) return;
        settled = true;
        cleanup();
        const parsed = parseClaudeStream(stdout);
        if (code !== 0 || parsed.isError || !parsed.content.trim()) {
          const detail = stderr.trim().slice(-800) || parsed.content.trim().slice(0, 200) || "no output";
          reject(new Error(`Claude CLI exited ${code}: ${detail}`));
          return;
        }
        resolve({
          content: parsed.content,
          ...(parsed.thinking ? { thinking: parsed.thinking } : {}),
          citations: [
            ...parsed.searchQueries.map((query) => `search://${encodeURIComponent(query)}`),
            ...parsed.citations
          ],
          ...(parsed.usage ? { usage: parsed.usage } : {}),
          model: parsed.model ?? this.model
        });
      });

      child.stdin.on("error", () => {
        /* The child may exit before stdin drains; close() reports the real cause. */
      });
      child.stdin.end(request.userPrompt);
    });
  }
}

async function claudeRetryDelay(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) throw signal.reason ?? new Error("Retry wait aborted.");
  await new Promise<void>((resolve, reject) => {
    let onAbort: () => void;
    const cleanup = (): void => signal.removeEventListener("abort", onAbort);
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, milliseconds);
    onAbort = (): void => {
      clearTimeout(timer);
      cleanup();
      reject(signal.reason ?? new Error("Retry wait aborted."));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}
