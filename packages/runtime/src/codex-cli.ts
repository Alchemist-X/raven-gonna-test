// ModelPort backed by the OpenAI Codex CLI (`codex exec`).
//
// Why a subprocess rather than an HTTP client: like the Claude CLI port, this
// spends a subscription (ChatGPT) rather than API credit, and the CLI holds
// that credential. It also brings the server-side web_search tool the
// forecasting prompts depend on.
//
// The port is NOT a transliteration of claude-cli.ts; every deviation below
// was forced by measured behaviour of codex-cli 0.144.4 (probed 2026-08-21):
//
//   - CODEX_HOME is redirected to a fresh per-call scratch directory holding
//     only a symlink to the real auth.json. `--ignore-user-config` alone does
//     NOT stop the CLI injecting ~/.codex/AGENTS.md into the context (measured:
//     the file was quoted back verbatim), and a shared home accumulates a
//     cross-call memories database — both would contaminate what is supposed to
//     be an isolated, independent trial.
//   - Web search CANNOT be disabled on this build: `-c tools.web_search=false`
//     and the browser_use feature switches were all ignored (the model searched
//     anyway). A no-web policy therefore cannot be enforced for this provider —
//     only requested — so buildCodexExecArgs fails closed and refuses the task
//     instead of running it unenforced.
//   - Search events carry only the QUERY, never the result URLs. Citations are
//     therefore emitted as `search://<encoded query>` markers: real evidence
//     that retrieval happened, deliberately distinguishable from the fetched
//     URLs the Claude port records. Do not compare the two as equals.
//   - The model may emit schema-conforming interim messages before it finishes
//     researching (measured: a `{"mean":0,...}` placeholder preceding the real
//     answer). The final answer is the LAST agent message; `--output-last-message`
//     is the authoritative copy of it.
//
// `--output-schema` constrains the final message to the exact JSON shape the
// task's parser expects — the structural guarantee the Claude port lacks. That
// asymmetry is recorded here on purpose: a lower parse-failure rate for this
// provider is partly the harness, not the model.

import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import type { ForecastTask, ModelPort, ModelRequest, ModelResponse } from "@raven-gonna-test/forecast-core";

/** Effort tiers the CLI accepts; ModelRequest tops out at "high". */
export type CodexCliEffort = "low" | "medium" | "high" | "xhigh" | "max" | "ultra";

export interface CodexCliConfig {
  /** Model slug passed to `--model`, e.g. "gpt-5.6-sol". */
  model: string;
  /** Hard ceiling per attempt. The engine also races its own timeout. */
  timeoutMs?: number;
  /** Overrides the effort derived from ModelRequest.reasoningEffort. */
  effort?: CodexCliEffort;
  /** Executable to spawn; injectable for tests. */
  executable?: string;
  /** Directory whose auth.json the scratch home links to (default: $CODEX_HOME or ~/.codex). */
  authHome?: string;
  /** Retries for transient failures; the Claude port has none, this one should. */
  maxRetries?: number;
  retryBaseMs?: number;
}

const DEFAULT_TIMEOUT_MS = 15 * 60_000;

export interface CodexExecFiles {
  schemaFile: string;
  lastMessageFile: string;
  workDir: string;
}

export function buildCodexExecArgs(
  config: CodexCliConfig,
  request: Pick<ModelRequest, "reasoningEffort" | "research">,
  files: CodexExecFiles
): string[] {
  // The information policy decides whether live research is permitted, and for
  // every other provider the enforcement is withholding the tools. On this
  // Codex build the web_search tool is server-side and no config switch turns
  // it off (verified empirically), so a deny-web task can only be *asked* not
  // to search. A prompt is not an enforcement boundary — refuse the task.
  if (request.research === false) {
    throw new Error(
      "Codex CLI cannot enforce a no-web policy: this build's web_search tool is always on " +
        "(no config switch disables it; verified against codex-cli 0.144.4). " +
        "Route no-web tasks to a provider whose retrieval can actually be withheld."
    );
  }
  const effort = config.effort ?? request.reasoningEffort;
  return [
    "exec",
    "--json",
    // No session rollout files; the per-call scratch home already isolates the rest.
    "--ephemeral",
    // The scratch workDir is not a git repository, deliberately.
    "--skip-git-repo-check",
    // Belt and braces on top of the CODEX_HOME redirect: even if the scratch
    // home somehow gains a config.toml or .rules, they must not load.
    "--ignore-user-config",
    "--ignore-rules",
    "--color",
    "never",
    // Shell stays available to the model, but read-only and network-less: the
    // sandbox is what guarantees research flows through the auditable
    // web_search tool rather than an invisible `curl`.
    "--sandbox",
    "read-only",
    "--cd",
    files.workDir,
    "--model",
    config.model,
    // The value must parse as TOML, hence the embedded quotes.
    "-c",
    `model_reasoning_effort="${effort}"`,
    // Currently default-on for this build; stated explicitly so a future
    // default flip cannot silently remove research from a paid run.
    "-c",
    "tools.web_search=true",
    "--output-schema",
    files.schemaFile,
    "--output-last-message",
    files.lastMessageFile
  ];
}

const RATIONALE_PROPERTY = {
  type: "string",
  description:
    "Two to four sentences: the decisive evidence (with dates) and how it determined the answer. Written before the answer fields."
} as const;

const SOURCES_PROPERTY = {
  type: "array",
  description:
    "Sources actually opened or returned by web search. Preserve each original canonical URL; use an empty array only if no source was available.",
  items: {
    type: "object",
    properties: {
      title: { type: "string", description: "Source or page title." },
      url: { type: "string", description: "Original absolute http(s) URL, not a search-results URL." }
    },
    required: ["title", "url"],
    additionalProperties: false
  }
} as const;

function probabilityProperties(choices: readonly string[]): Record<string, unknown> {
  return Object.fromEntries(
    choices.map((choice) => [choice, { type: "number", description: "Probability between 0 and 1." }])
  );
}

function objectSchema(properties: Record<string, unknown>): Record<string, unknown> {
  // Structured output demands every property listed in `required` and
  // additionalProperties:false. `rationale` is deliberately FIRST so the
  // constrained decoding writes the justification before the answer — the
  // schema-level equivalent of "reason first, then answer".
  return {
    type: "object",
    properties: { rationale: RATIONALE_PROPERTY, sources: SOURCES_PROPERTY, ...properties },
    required: ["rationale", "sources", ...Object.keys(properties)],
    additionalProperties: false
  };
}

function sourceUrlsFromAnswer(content: string): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return [];
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return [];
  const sources = (parsed as Record<string, unknown>).sources;
  if (!Array.isArray(sources)) return [];
  const urls = new Set<string>();
  for (const source of sources) {
    const value = typeof source === "string"
      ? source
      : source && typeof source === "object" && !Array.isArray(source)
        ? (source as Record<string, unknown>).url
        : undefined;
    if (typeof value !== "string") continue;
    try {
      const url = new URL(value);
      if (url.protocol === "http:" || url.protocol === "https:") urls.add(url.toString());
    } catch {
      // The model-visible answer is still kept in rawResponse; malformed URLs
      // must not be promoted into the verified source list.
    }
  }
  return [...urls];
}

/**
 * The JSON Schema handed to `--output-schema`, shaped so the final message is
 * exactly what forecast-core's parseModelAnswer already accepts. Field names
 * intentionally match the `<answer>` examples in prompt.ts (probability, value,
 * ranking, …) so the schema constraint and the prompt never contradict each
 * other. Only keywords structured output reliably supports are used: type,
 * enum, required, additionalProperties, description — numeric ranges live in
 * descriptions, and the parser still clamps.
 */
export function answerSchemaForTask(task: ForecastTask): Record<string, unknown> {
  switch (task.kind) {
    case "binary_probability":
      return objectSchema({
        probability: { type: "number", description: "Calibrated probability of YES, between 0 and 1." }
      });
    case "categorical":
      return objectSchema({
        probabilities: {
          type: "object",
          description: "Probabilities for exactly the offered choices, summing to one.",
          properties: probabilityProperties(task.choices),
          required: [...task.choices],
          additionalProperties: false
        }
      });
    case "multi_label":
      return objectSchema({
        probabilities: {
          type: "object",
          description: "Independent probability per option; do NOT force them to sum to one.",
          properties: probabilityProperties(task.choices),
          required: [...task.choices],
          additionalProperties: false
        },
        selected: {
          type: "array",
          description: "The options predicted to occur.",
          items: { type: "string", enum: [...task.choices] }
        }
      });
    case "ranking":
      return objectSchema({
        ranking: {
          type: "array",
          description: `Exactly ${task.rankCount} entries in predicted order, best first.`,
          items:
            task.candidates.length > 0
              ? { type: "string", enum: [...task.candidates] }
              : { type: "string", description: "Canonical entity name." }
        }
      });
    case "numeric":
      return objectSchema({
        value: {
          type: "number",
          description: task.integerValued
            ? "The predicted count as a whole number. No units, commas or ranges."
            : "The predicted value as a bare number in the units the question specifies. No units, commas or ranges."
        },
        standard_deviation: {
          type: "number",
          description: "One-sigma uncertainty in the same units; 0 if the value is already published."
        }
      });
    case "free_response":
      return objectSchema({
        answer: {
          type: "string",
          description:
            "ONLY the official entity name or value, graded by exact string match. No sentence, gloss, units or qualifiers."
        }
      });
  }
}

export interface ParsedCodexStream {
  /** agent_message texts in emission order; the LAST one is the answer. */
  messages: string[];
  /** Reasoning summaries, when the CLI surfaces them. */
  thinking: string;
  /** Search queries actually issued — the only retrieval signal these events expose. */
  searchQueries: string[];
  usage: Record<string, unknown> | undefined;
  isError: boolean;
  /** turn.failed / error-event detail, for a diagnosable rejection. */
  failureMessage: string;
}

export function parseCodexExecStream(stdout: string): ParsedCodexStream {
  const messages: string[] = [];
  const thinkingBlocks: string[] = [];
  const searchQueries = new Set<string>();
  let usage: Record<string, unknown> | undefined;
  let isError = false;
  let failureMessage = "";

  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed[0] !== "{") continue;
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      continue; // A partial or non-JSON line is not fatal; keep reading.
    }
    if (event.type === "item.completed") {
      const item = (event.item ?? {}) as Record<string, unknown>;
      if (item.type === "agent_message" && typeof item.text === "string") messages.push(item.text);
      if (item.type === "reasoning") {
        const text = typeof item.text === "string" ? item.text : typeof item.summary === "string" ? item.summary : "";
        if (text) thinkingBlocks.push(text);
      }
      if (item.type === "web_search") {
        const action = (item.action ?? {}) as Record<string, unknown>;
        const query = typeof action.query === "string" && action.query ? action.query : item.query;
        if (typeof query === "string" && query) searchQueries.add(query);
      }
      // item.type === "error" is routinely benign (feature warnings, cache
      // misses); it must not fail the call. turn.failed is the fatal signal.
    } else if (event.type === "turn.failed") {
      isError = true;
      const error = (event.error ?? {}) as Record<string, unknown>;
      if (typeof error.message === "string") failureMessage = error.message;
    } else if (event.type === "error") {
      if (typeof event.message === "string") failureMessage = event.message;
    } else if (event.type === "turn.completed") {
      const raw = event.usage;
      if (raw && typeof raw === "object" && !Array.isArray(raw)) usage = { ...(raw as Record<string, unknown>) };
    }
  }

  return {
    messages,
    thinking: thinkingBlocks.join("\n\n"),
    searchQueries: [...searchQueries],
    usage,
    isError,
    failureMessage
  };
}

/**
 * Permanent failures that a retry cannot fix: malformed requests, unsupported
 * models, missing login, exhausted subscription quota, and our own per-attempt
 * timeout (retrying a full timeout doubles the damage; the engine's trial
 * timeout governs the total). Everything else — dropped streams, 5xx, process
 * flakes — is worth the bounded retry the Claude port never had.
 */
export function isRetryableCodexFailure(message: string): boolean {
  return !/invalid_request|not.?supported|unauthorized|401|403|usage.?limit|plan.?limit|log.?in|logged.?in|timed out/i.test(
    message
  );
}

export class CodexCliPredictor implements ModelPort {
  readonly model: string;

  constructor(private readonly config: CodexCliConfig) {
    if (!config.model.trim()) throw new Error("CodexCliPredictor requires a model id.");
    this.model = config.model;
  }

  async generate(request: ModelRequest, signal: AbortSignal): Promise<ModelResponse> {
    if (signal.aborted) throw signal.reason ?? new Error("Codex CLI call aborted before start.");
    const maxRetries = this.config.maxRetries ?? 2;
    const retryBaseMs = this.config.retryBaseMs ?? 1000;
    let lastError: Error | undefined;
    for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
      if (attempt > 0) await abortableDelay(Math.min(30_000, retryBaseMs * 2 ** (attempt - 1)), signal);
      try {
        return await this.runOnce(request, signal);
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        if (signal.aborted || !isRetryableCodexFailure(lastError.message)) throw lastError;
      }
    }
    throw lastError ?? new Error("Codex CLI retry loop exited unexpectedly.");
  }

  private async runOnce(request: ModelRequest, signal: AbortSignal): Promise<ModelResponse> {
    // One scratch directory per call: a private CODEX_HOME (auth symlink only)
    // and an empty working directory. This is the isolation boundary — no
    // AGENTS.md, no config.toml, no plugins, no memories carried across calls.
    const scratch = await mkdtemp(path.join(tmpdir(), "codex-cli-"));
    try {
      const home = path.join(scratch, "home");
      const workDir = path.join(scratch, "work");
      await mkdir(home);
      await mkdir(workDir);
      const authSource = path.join(
        this.config.authHome ?? process.env.CODEX_HOME ?? path.join(homedir(), ".codex"),
        "auth.json"
      );
      // A symlink rather than a copy, so a token refresh written by the CLI
      // lands in the real file. If auth.json does not exist the CLI reports
      // the missing login itself, which is the accurate error.
      await symlink(authSource, path.join(home, "auth.json"));
      const files: CodexExecFiles = {
        schemaFile: path.join(scratch, "answer-schema.json"),
        lastMessageFile: path.join(scratch, "last-message.json"),
        workDir
      };
      await writeFile(files.schemaFile, `${JSON.stringify(answerSchemaForTask(request.task), null, 2)}\n`, "utf8");
      const args = buildCodexExecArgs(this.config, request, files);
      // codex exec has no system-prompt channel; the system text leads the
      // user message instead. A visible difference from the Claude port, where
      // it rides --append-system-prompt.
      const prompt = request.systemPrompt.trim()
        ? `${request.systemPrompt.trim()}\n\n${request.userPrompt}`
        : request.userPrompt;
      const { code, stdout, stderr } = await this.spawnCodex(args, home, prompt, signal);
      const parsed = parseCodexExecStream(stdout);
      // --output-last-message is authoritative: interim schema-conforming
      // messages can precede the answer, and the file holds only the final one.
      let content = "";
      try {
        content = (await readFile(files.lastMessageFile, "utf8")).trim();
      } catch {
        // The CLI omits the file when it dies mid-turn; the stream is the fallback.
      }
      if (!content) content = parsed.messages.at(-1)?.trim() ?? "";
      if (code !== 0 || parsed.isError || !content) {
        const detail = parsed.failureMessage || stderr.trim().slice(-800) || "no output";
        throw new Error(`Codex CLI exited ${code}: ${detail}`);
      }
      const sourceUrls = sourceUrlsFromAnswer(content);
      return {
        content,
        ...(parsed.thinking ? { thinking: parsed.thinking } : {}),
        // Queries, not URLs: the search:// scheme keeps them out of any "URL
        // we actually fetched" claim while still proving research happened.
        citations: [
          ...parsed.searchQueries.map((query) => `search://${encodeURIComponent(query)}`),
          ...sourceUrls
        ],
        usage: { ...(parsed.usage ?? {}), web_search_requests: parsed.searchQueries.length },
        model: this.config.model
      };
    } finally {
      await rm(scratch, { recursive: true, force: true }).catch(() => {
        /* best-effort cleanup; tmpdir reaping covers the rest */
      });
    }
  }

  private spawnCodex(
    args: string[],
    codexHome: string,
    prompt: string,
    signal: AbortSignal
  ): Promise<{ code: number | null; stdout: string; stderr: string }> {
    const timeoutMs = this.config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    return new Promise((resolve, reject) => {
      const child = spawn(this.config.executable ?? "codex", args, {
        env: { ...process.env, CODEX_HOME: codexHome }
      });
      let stdout = "";
      let stderr = "";
      let settled = false;

      // Same contract as the Claude port: the process must die with the
      // promise, or it keeps a concurrency slot and keeps spending quota.
      const stop = (reason: Error): void => {
        if (settled) return;
        settled = true;
        cleanup();
        child.kill("SIGTERM");
        reject(reason);
      };
      const timer = setTimeout(() => stop(new Error(`Codex CLI timed out after ${timeoutMs}ms.`)), timeoutMs);
      const onAbort = (): void => stop((signal.reason as Error) ?? new Error("Codex CLI call aborted."));
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
        resolve({ code, stdout, stderr });
      });

      child.stdin.on("error", () => {
        /* The child may exit before stdin drains; close() reports the real cause. */
      });
      child.stdin.end(prompt);
    });
  }
}

async function abortableDelay(milliseconds: number, signal: AbortSignal): Promise<void> {
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
