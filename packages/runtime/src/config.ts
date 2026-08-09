export interface PredictorConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  timeoutMs: number;
  trials: number;
  concurrency: number;
  reasoningEffort: "low" | "medium" | "high";
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
  const baseUrl = (env.PREDICTOR_BASE_URL ?? "https://api.lightningrod.ai/v1/openai").replace(/\/+$/, "");
  if (!isSafeBaseUrl(baseUrl, env.PREDICTOR_ALLOW_PRIVATE_BASE_URL === "1")) {
    throw new Error("PREDICTOR_BASE_URL must be credential-free HTTPS without query/fragment; private IPs require explicit opt-in.");
  }
  const apiKey = env.PREDICTOR_API_KEY?.trim() ?? "";
  if (!apiKey) throw new Error("PREDICTOR_API_KEY is required for live model calls.");
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
    baseUrl,
    apiKey,
    model: env.PREDICTOR_MODEL?.trim() || "foresight-v4",
    timeoutMs,
    trials,
    concurrency,
    reasoningEffort: effort as "low" | "medium" | "high",
    researchSources: (env.PREDICTOR_RESEARCH_SOURCES ?? "perplexity,google_news")
      .split(",")
      .map((source) => source.trim())
      .filter(Boolean),
    maxRetries: integer(env, "PREDICTOR_MAX_RETRIES", 2, 0),
    retryBaseMs: integer(env, "PREDICTOR_RETRY_BASE_MS", 1000)
  };
}
import { isIP } from "node:net";
