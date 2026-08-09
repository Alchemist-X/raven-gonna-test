import type { ModelPort, ModelRequest, ModelResponse } from "@raven-gonna-test/forecast-core";
import { z } from "zod";
import type { PredictorConfig } from "./config.js";

const ResponseSchema = z.object({
  model: z.string().optional(),
  choices: z.array(z.object({
    message: z.object({
      content: z.union([
        z.string(),
        z.array(z.object({ type: z.string().optional(), text: z.string().optional() }).passthrough())
      ]),
      thinking: z.string().nullable().optional(),
      annotations: z.array(z.unknown()).nullable().optional()
    }).passthrough()
  })).min(1),
  usage: z.record(z.unknown()).nullable().optional()
}).passthrough();

function joinUrl(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`;
}

function contentText(content: string | Array<Record<string, unknown>>): string {
  return typeof content === "string"
    ? content
    : content.map((part) => typeof part.text === "string" ? part.text : "").join("");
}

function citationUrls(value: unknown): string[] {
  const found = new Set<string>();
  const visit = (current: unknown): void => {
    if (typeof current === "string" && /^https?:\/\//i.test(current)) {
      try {
        const url = new URL(current);
        url.username = "";
        url.password = "";
        url.search = "";
        url.hash = "";
        found.add(url.toString());
      } catch {
        // Ignore malformed annotation values.
      }
      return;
    }
    if (Array.isArray(current)) {
      current.forEach(visit);
      return;
    }
    if (current && typeof current === "object") Object.values(current as Record<string, unknown>).forEach(visit);
  };
  visit(value);
  return [...found];
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

function retryDelay(response: Response, attempt: number, baseMs: number): number {
  const header = response.headers.get("retry-after");
  if (header) {
    const seconds = Number(header);
    if (Number.isFinite(seconds)) return Math.min(60_000, Math.max(0, seconds * 1000));
    const date = new Date(header).getTime();
    if (Number.isFinite(date)) return Math.min(60_000, Math.max(0, date - Date.now()));
  }
  return Math.min(30_000, baseMs * 2 ** attempt);
}

export class OpenAICompatiblePredictor implements ModelPort {
  readonly model: string;

  constructor(
    private readonly config: PredictorConfig,
    private readonly fetchFn: typeof fetch = fetch
  ) {
    this.model = config.model;
  }

  async generate(request: ModelRequest, signal: AbortSignal): Promise<ModelResponse> {
    const controller = new AbortController();
    const abort = (): void => controller.abort(signal.reason);
    if (signal.aborted) abort();
    else signal.addEventListener("abort", abort, { once: true });
    const timeout = setTimeout(
      () => controller.abort(new Error(`Predictor request timed out after ${this.config.timeoutMs}ms.`)),
      this.config.timeoutMs
    );
    try {
      const maxRetries = this.config.maxRetries ?? 2;
      const retryBaseMs = this.config.retryBaseMs ?? 1000;
      for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
        let response: Response;
        try {
          response = await this.fetchFn(joinUrl(this.config.baseUrl, "chat/completions"), {
            method: "POST",
            headers: {
              authorization: `Bearer ${this.config.apiKey}`,
              "content-type": "application/json"
            },
            body: JSON.stringify({
              model: this.config.model,
              messages: [
                { role: "system", content: request.systemPrompt },
                { role: "user", content: request.userPrompt }
              ],
              answer_type: request.answerType,
              research: request.research,
              reasoning_effort: request.reasoningEffort
            }),
            signal: controller.signal,
            redirect: "error"
          });
        } catch (error) {
          if (controller.signal.aborted || attempt >= maxRetries) throw error;
          await abortableDelay(Math.min(30_000, retryBaseMs * 2 ** attempt), controller.signal);
          continue;
        }
        const raw = await response.text();
        if (!response.ok) {
          const retryable = [429, 502, 503, 504].includes(response.status);
          if (retryable && attempt < maxRetries) {
            await abortableDelay(retryDelay(response, attempt, retryBaseMs), controller.signal);
            continue;
          }
          const retry = response.headers.get("retry-after");
          throw new Error(`Predictor HTTP ${response.status}${retry ? ` (retry-after ${retry})` : ""}.`);
        }
        let decoded: unknown;
        try {
          decoded = JSON.parse(raw);
        } catch {
          throw new Error("Predictor returned invalid JSON.");
        }
        const parsed = ResponseSchema.parse(decoded);
        const message = parsed.choices[0]?.message;
        if (!message) throw new Error("Predictor response did not contain a message.");
        const result: ModelResponse = {
          content: contentText(message.content),
          citations: citationUrls(message.annotations)
        };
        if (message.thinking != null) result.thinking = message.thinking;
        if (parsed.usage != null) result.usage = parsed.usage;
        if (parsed.model !== undefined) result.model = parsed.model;
        return result;
      }
      throw new Error("Predictor retry loop exited unexpectedly.");
    } finally {
      clearTimeout(timeout);
      signal.removeEventListener("abort", abort);
    }
  }
}
