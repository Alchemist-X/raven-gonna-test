/**
 * "openai-compatible" talks HTTP to a completions endpoint and needs an API
 * key. "claude-cli" shells out to the Claude Code CLI, which holds its own
 * credential and spends a subscription rather than API credit — so it must not
 * demand PREDICTOR_API_KEY.
 */
export type PredictorProvider = "openai-compatible" | "claude-cli";

export const PREDICTOR_PROVIDERS: readonly PredictorProvider[] = ["openai-compatible", "claude-cli"];

export interface PredictorConfig {
  provider: PredictorProvider;
  baseUrl: string;
  apiKey: string;
  model: string;
  timeoutMs: number;
  trials: number;
  concurrency: number;
  reasoningEffort: "low" | "medium" | "high";
  /**
   * Claude CLI effort, which reaches two levels above ModelRequest's
   * low|medium|high. Only meaningful for the claude-cli provider.
   */
  claudeEffort?: "low" | "medium" | "high" | "xhigh" | "max";
  researchSources: string[];
  maxRetries?: number;
  retryBaseMs?: number;
}

function integer(env: NodeJS.ProcessEnv, key: string, fallback: number, minimum = 1): number {
  const raw = env[key];
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < minimum) throw new Error(`${key} must be an integer >= ${minimum}.`);
  return parsed;
}

function isPrivateAddress(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (["localhost", "::1"].includes(host)) return true;
  if (isIP(host) === 4) {
    const parts = host.split(".").map(Number);
    const [a = 0, b = 0] = parts;
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
  }
  if (isIP(host) === 6) return host === "::1" || host.startsWith("fe80:") || host.startsWith("fc") || host.startsWith("fd");
  return false;
}

function isSafeBaseUrl(value: string, allowPrivate: boolean): boolean {
  const url = new URL(value);
  if (url.username || url.password || url.search || url.hash) return false;
  const privateAddress = isPrivateAddress(url.hostname);
  if (privateAddress && !allowPrivate && !["localhost", "127.0.0.1", "::1"].includes(url.hostname)) return false;
  return url.protocol === "https:" || (["localhost", "127.0.0.1", "::1"].includes(url.hostname) && url.protocol === "http:");
}

export function loadPredictorConfig(env: NodeJS.ProcessEnv = process.env): PredictorConfig {
  const provider = (env.PREDICTOR_PROVIDER ?? "openai-compatible") as PredictorProvider;
  if (!PREDICTOR_PROVIDERS.includes(provider)) {
    throw new Error(`PREDICTOR_PROVIDER must be one of ${PREDICTOR_PROVIDERS.join(", ")}.`);
  }
  const baseUrl = (env.PREDICTOR_BASE_URL ?? "https://api.lightningrod.ai/v1/openai").replace(/\/+$/, "");
  if (!isSafeBaseUrl(baseUrl, env.PREDICTOR_ALLOW_PRIVATE_BASE_URL === "1")) {
    throw new Error("PREDICTOR_BASE_URL must be credential-free HTTPS without query/fragment; private IPs require explicit opt-in.");
  }
  const apiKey = env.PREDICTOR_API_KEY?.trim() ?? "";
  // The CLI provider resolves its own credential; demanding a key here would
  // block the only model access a subscription-based run has.
  if (!apiKey && provider === "openai-compatible") {
    throw new Error("PREDICTOR_API_KEY is required for live model calls.");
  }
  const claudeEffort = env.PREDICTOR_CLAUDE_EFFORT;
  if (claudeEffort && !["low", "medium", "high", "xhigh", "max"].includes(claudeEffort)) {
    throw new Error("PREDICTOR_CLAUDE_EFFORT must be low, medium, high, xhigh, or max.");
  }
  const effort = env.PREDICTOR_REASONING_EFFORT ?? "medium";
  if (!(["low", "medium", "high"] as const).includes(effort as "low" | "medium" | "high")) {
    throw new Error("PREDICTOR_REASONING_EFFORT must be low, medium, or high.");
  }
  const timeoutMs = integer(env, "PREDICTOR_TIMEOUT_MS", 15 * 60_000);
  const trials = integer(env, "PREDICTOR_TRIALS", 3);
  const concurrency = integer(env, "PREDICTOR_CONCURRENCY", 8);
  if (timeoutMs > 60 * 60_000) throw new Error("PREDICTOR_TIMEOUT_MS must not exceed one hour.");
  if (trials > 20) throw new Error("PREDICTOR_TRIALS must not exceed 20.");
  if (concurrency > 120) throw new Error("PREDICTOR_CONCURRENCY must not exceed 120.");
  return {
    provider,
    baseUrl,
    apiKey,
    // The default model is provider-specific: "foresight-v4" is meaningless to
    // the Claude CLI and would fail every call.
    model: env.PREDICTOR_MODEL?.trim() || (provider === "claude-cli" ? "claude-sonnet-5" : "foresight-v4"),
    timeoutMs,
    trials,
    concurrency,
    reasoningEffort: effort as "low" | "medium" | "high",
    ...(claudeEffort ? { claudeEffort: claudeEffort as Exclude<PredictorConfig["claudeEffort"], undefined> } : {}),
    researchSources: (env.PREDICTOR_RESEARCH_SOURCES ?? "perplexity,google_news")
      .split(",")
      .map((source) => source.trim())
      .filter(Boolean),
    maxRetries: integer(env, "PREDICTOR_MAX_RETRIES", 2, 0),
    retryBaseMs: integer(env, "PREDICTOR_RETRY_BASE_MS", 1000)
  };
}
import { isIP } from "node:net";
