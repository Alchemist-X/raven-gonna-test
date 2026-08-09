import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import {
  buildProphetCurrentResponse,
  buildProphetLegacyResponse,
  normalizeProphetRequest,
  policyForProphetTask,
  prophetEventToTasks,
  prophetFallbackAnswer,
  validateProphetCurrentResponse,
  validateProphetLegacyResponse,
  type CanonicalProphetEvent,
  type ProphetWireMode
} from "@raven-gonna-test/benchmarks";
import { ForecastEngine, type ForecastResult, type ForecastTask } from "@raven-gonna-test/forecast-core";
import {
  ConcurrencyLimitedModel,
  OpenAICompatiblePredictor,
  loadPredictorConfig,
  runForecastBatch,
  timestampSlug,
  writeJsonAtomic
} from "@raven-gonna-test/runtime";

export interface ProphetServerConfig {
  host: string;
  port: number;
  bearerToken: string | null;
  maxConcurrent: number;
  requestTimeoutMs: number;
  residualCap: number;
  bodyLimitBytes: number;
  maxOutcomes: number;
  maxTotalPromptBytes: number;
  providerConcurrency: number;
  allowBaselineOnly: boolean;
  wireMode: ProphetWireMode;
  artifactRoot: string;
  pipelineVersion: string;
}

export interface ProphetServerDependencies {
  forecast?: (
    event: CanonicalProphetEvent,
    tasks: ForecastTask[],
    signal: AbortSignal
  ) => Promise<ForecastResult[]>;
  now?: () => Date;
}

export function loadProphetServerConfig(env: NodeJS.ProcessEnv = process.env): ProphetServerConfig {
  const integer = (key: string, fallback: number): number => {
    const value = Number(env[key] ?? fallback);
    if (!Number.isInteger(value) || value < 1) throw new Error(`${key} must be a positive integer.`);
    return value;
  };
  const residualCap = Number(env.PROPHET_RESIDUAL_CAP ?? 0.05);
  if (!Number.isFinite(residualCap) || residualCap < 0 || residualCap > 1) {
    throw new Error("PROPHET_RESIDUAL_CAP must be in [0,1].");
  }
  const wireMode = env.PROPHET_WIRE_MODE ?? "auto";
  if (!(["current", "legacy", "auto"] as const).includes(wireMode as ProphetWireMode)) {
    throw new Error("PROPHET_WIRE_MODE must be current, legacy, or auto.");
  }
  const host = env.PROPHET_HOST ?? "127.0.0.1";
  const bearerToken = env.PROPHET_BEARER_TOKEN?.trim() || null;
  const loopback = ["localhost", "127.0.0.1", "::1"].includes(host);
  if (!loopback && !bearerToken) {
    throw new Error("PROPHET_BEARER_TOKEN is required when PROPHET_HOST is not loopback.");
  }
  if (bearerToken && Buffer.byteLength(bearerToken, "utf8") < 32) {
    throw new Error("PROPHET_BEARER_TOKEN must be at least 32 bytes.");
  }
  return {
    host,
    port: integer("PROPHET_PORT", 8788),
    bearerToken,
    maxConcurrent: integer("PROPHET_MAX_CONCURRENT", 8),
    requestTimeoutMs: Math.min(integer("PROPHET_REQUEST_TIMEOUT_MS", 3_300_000), 3_540_000),
    residualCap,
    bodyLimitBytes: integer("PROPHET_BODY_LIMIT_BYTES", 256 * 1024),
    maxOutcomes: Math.min(integer("PROPHET_MAX_OUTCOMES", 40), 100),
    maxTotalPromptBytes: Math.min(integer("PROPHET_MAX_TOTAL_PROMPT_BYTES", 1_000_000), 4_000_000),
    providerConcurrency: Math.min(integer("PROPHET_PROVIDER_CONCURRENCY", 8), 120),
    allowBaselineOnly: env.PROPHET_ALLOW_BASELINE_ONLY === "1",
    wireMode: wireMode as ProphetWireMode,
    artifactRoot: env.PROPHET_ARTIFACT_ROOT ?? "runtime-artifacts/prophet-arena-api",
    pipelineVersion: env.PROPHET_PIPELINE_VERSION ?? "prophet-bounded-residual-v1"
  };
}

function safeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

function authorized(request: IncomingMessage, token: string | null): boolean {
  if (!token) return true;
  const header = request.headers.authorization ?? "";
  return header.startsWith("Bearer ") && safeEqual(header.slice(7), token);
}

function sendJson(response: ServerResponse, status: number, body: unknown, extraHeaders: Record<string, string> = {}): void {
  const payload = `${JSON.stringify(body)}\n`;
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
    "cache-control": "no-store",
    ...extraHeaders
  });
  response.end(payload);
}

async function readBody(request: IncomingMessage, limit: number): Promise<string> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > limit) throw Object.assign(new Error(`Request body exceeds ${limit} bytes.`), { statusCode: 413 });
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
}

function requestHash(body: unknown, pipelineVersion: string): string {
  return createHash("sha256").update(pipelineVersion).update("\0").update(canonicalJson(body)).digest("hex");
}

interface PredictionEnvelope {
  body: unknown;
  eventId: string;
  fallbackUsed: boolean;
  fallbackCount: number;
  fallbackReason?: "predictor_not_configured" | "forecast_error" | "trial_fallback";
}

interface SharedFlight {
  controller: AbortController;
  promise: Promise<PredictionEnvelope>;
  waiters: number;
  settled: boolean;
}

function statusError(message: string, statusCode: number): Error & { statusCode: number } {
  return Object.assign(new Error(message), { statusCode });
}

async function waitForFlight(flight: SharedFlight, signal: AbortSignal): Promise<PredictionEnvelope> {
  if (signal.aborted) throw signal.reason ?? statusError("Request aborted.", 499);
  flight.waiters += 1;
  let onAbort: (() => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(signal.reason ?? statusError("Request aborted.", 499));
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    return await Promise.race([flight.promise, aborted]);
  } finally {
    if (onAbort) signal.removeEventListener("abort", onAbort);
    flight.waiters -= 1;
    if (flight.waiters === 0 && !flight.settled) {
      flight.controller.abort(statusError("All request waiters disconnected.", 499));
    }
  }
}

async function waitWithAbort<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) throw signal.reason ?? statusError("Forecast aborted.", 499);
  let onAbort: (() => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(signal.reason ?? statusError("Forecast aborted.", 499));
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    return await Promise.race([operation, aborted]);
  } finally {
    if (onAbort) signal.removeEventListener("abort", onAbort);
  }
}

function createLiveForecaster(providerConcurrency: number): ProphetServerDependencies["forecast"] | undefined {
  if (!process.env.PREDICTOR_API_KEY?.trim()) return undefined;
  const config = loadPredictorConfig();
  const model = new ConcurrencyLimitedModel(new OpenAICompatiblePredictor(config), providerConcurrency);
  const engine = new ForecastEngine(model);
  return async (_event, tasks, signal) => runForecastBatch(tasks, engine, policyForProphetTask, {
    concurrency: config.concurrency,
    fallbackFor: prophetFallbackAnswer,
    forecastOptions: {
      trials: config.trials,
      concurrency: Math.min(config.trials, 3),
      timeoutMs: config.timeoutMs,
      reasoningEffort: config.reasoningEffort,
      researchSources: config.researchSources,
      priorWeight: 0.7,
      probabilityFloor: 0.001,
      signal
    }
  });
}

export function createProphetServer(
  config: ProphetServerConfig,
  dependencies: ProphetServerDependencies = {}
): Server {
  const forecast = dependencies.forecast ?? createLiveForecaster(config.providerConcurrency);
  if (!forecast && !config.allowBaselineOnly) {
    throw new Error("PREDICTOR_API_KEY is missing. Set PROPHET_ALLOW_BASELINE_ONLY=1 only for an explicit baseline service.");
  }
  const now = dependencies.now ?? (() => new Date());
  let active = 0;
  const singleFlight = new Map<string, SharedFlight>();

  async function predict(input: unknown, signal: AbortSignal): Promise<PredictionEnvelope> {
    let event: CanonicalProphetEvent;
    try {
      event = normalizeProphetRequest(input, config.wireMode);
    } catch (error) {
      throw statusError(error instanceof Error ? error.message : "Invalid Prophet request schema.", 422);
    }
    if (event.outcomes.length > config.maxOutcomes) {
      throw statusError(`Event has ${event.outcomes.length} outcomes; maximum is ${config.maxOutcomes}.`, 422);
    }
    const totalPromptBytes = event.outcomes.reduce((total, outcome) => total + Buffer.byteLength(
      `${event.title}\n${event.category ?? ""}\n${event.rules ?? ""}\n${outcome}`,
      "utf8"
    ), 0);
    if (totalPromptBytes > config.maxTotalPromptBytes) {
      throw statusError(`Expanded prompt budget is ${totalPromptBytes} bytes; maximum is ${config.maxTotalPromptBytes}.`, 413);
    }
    const asOf = now();
    if (event.closeTime) {
      const close = new Date(event.closeTime).getTime();
      if (close <= asOf.getTime()) throw statusError("Event is already closed.", 422);
    }
    const tasks = prophetEventToTasks(event, asOf.toISOString());
    let results: ForecastResult[] = [];
    let fallbackReason: PredictionEnvelope["fallbackReason"];
    if (!forecast) {
      fallbackReason = "predictor_not_configured";
    } else {
      try {
        results = await waitWithAbort(forecast(event, tasks, signal), signal);
      } catch (error) {
        if (signal.aborted) throw signal.reason ?? error;
        fallbackReason = "forecast_error";
      }
    }
    const resultById = new Map(results.map((result) => [result.taskId, result]));
    const fallbackCount = tasks.filter((task) => !resultById.has(task.taskId) || resultById.get(task.taskId)?.fallbackUsed).length;
    if (!fallbackReason && fallbackCount > 0) fallbackReason = "trial_fallback";
    if (event.wireVersion === "legacy") {
      const body = buildProphetLegacyResponse(event, results, { residualCap: config.residualCap });
      const validation = validateProphetLegacyResponse(event, body);
      if (!validation.valid) throw statusError(validation.errors.join("\n"), 502);
      return { body, eventId: event.eventId, fallbackUsed: fallbackCount > 0, fallbackCount, ...(fallbackReason ? { fallbackReason } : {}) };
    }
    const body = buildProphetCurrentResponse(event, results, { residualCap: config.residualCap });
    const validation = validateProphetCurrentResponse(event, body);
    if (!validation.valid) throw statusError(validation.errors.join("\n"), 502);
    return { body, eventId: event.eventId, fallbackUsed: fallbackCount > 0, fallbackCount, ...(fallbackReason ? { fallbackReason } : {}) };
  }

  function flightFor(hash: string, input: unknown): SharedFlight {
    const existing = singleFlight.get(hash);
    if (existing) return existing;
    const controller = new AbortController();
    const flight: SharedFlight = {
      controller,
      promise: predict(input, controller.signal),
      waiters: 0,
      settled: false
    };
    singleFlight.set(hash, flight);
    const cleanup = (): void => {
      flight.settled = true;
      if (singleFlight.get(hash) === flight) singleFlight.delete(hash);
    };
    flight.promise.then(cleanup, cleanup);
    return flight;
  }

  return createServer(async (request, response) => {
    const started = Date.now();
    if (request.method === "GET" && request.url === "/healthz") {
      sendJson(response, 200, {
        ok: true,
        service: "raven-gonna-test-prophet-arena-api",
        pipelineVersion: config.pipelineVersion,
        active,
        ready: Boolean(forecast),
        mode: forecast ? "predictor-with-market-prior-fallback" : "baseline-only",
        fallback: "market-prior"
      });
      return;
    }
    if (request.method !== "POST" || !["/", "/forecast"].includes(request.url ?? "")) {
      sendJson(response, 404, { error: "not_found" });
      return;
    }
    if (!authorized(request, config.bearerToken)) {
      sendJson(response, 401, { error: "unauthorized" }, { "www-authenticate": "Bearer" });
      return;
    }
    if (!(request.headers["content-type"] ?? "").toLocaleLowerCase().startsWith("application/json")) {
      sendJson(response, 415, { error: "content_type_must_be_application_json" });
      return;
    }
    if (active >= config.maxConcurrent) {
      sendJson(response, 429, { error: "too_many_concurrent_requests" }, { "retry-after": "5" });
      return;
    }
    active += 1;
    let hash = "unknown";
    const requestId = randomUUID();
    const waiterController = new AbortController();
    const disconnect = (): void => {
      if (!response.writableEnded && !waiterController.signal.aborted) {
        waiterController.abort(statusError("Client disconnected.", 499));
      }
    };
    request.once("aborted", disconnect);
    response.once("close", disconnect);
    const timer = setTimeout(
      () => waiterController.abort(statusError(`Prophet request timed out after ${config.requestTimeoutMs}ms.`, 504)),
      config.requestTimeoutMs
    );
    try {
      const contentLength = Number(request.headers["content-length"] ?? 0);
      if (Number.isFinite(contentLength) && contentLength > config.bodyLimitBytes) {
        throw statusError(`Request body exceeds ${config.bodyLimitBytes} bytes.`, 413);
      }
      const raw = await readBody(request, config.bodyLimitBytes);
      let input: unknown;
      try {
        input = JSON.parse(raw);
      } catch {
        throw statusError("Malformed JSON request body.", 400);
      }
      hash = requestHash(input, config.pipelineVersion);
      const envelope = await waitForFlight(flightFor(hash, input), waiterController.signal);
      if (waiterController.signal.aborted) throw waiterController.signal.reason;
      sendJson(response, 200, envelope.body);
      void writeJsonAtomic(`${config.artifactRoot}/${timestampSlug()}.${hash.slice(0, 12)}.${requestId}.json`, {
        schemaVersion: "raven-gonna-test.prophet-audit.v1",
        requestId,
        requestHash: hash,
        eventId: envelope.eventId,
        pipelineVersion: config.pipelineVersion,
        status: "success",
        latencyMs: Date.now() - started,
        modelReady: Boolean(forecast),
        fallbackUsed: envelope.fallbackUsed,
        fallbackCount: envelope.fallbackCount,
        fallbackReason: envelope.fallbackReason ?? null
      }).catch((error) => process.stderr.write(`[WARN] audit write failed: ${String(error)}\n`));
    } catch (error) {
      const statusCode = typeof error === "object" && error !== null && "statusCode" in error
        ? Number((error as { statusCode: unknown }).statusCode)
        : error instanceof SyntaxError || (error instanceof Error && error.name === "ZodError") ? 422 : 500;
      const status = Number.isInteger(statusCode) && statusCode >= 400 && statusCode <= 599 ? statusCode : 500;
      if (!response.destroyed && !response.writableEnded && status !== 499) {
        sendJson(response, status, {
          error: status >= 500 ? "forecast_failed" : "invalid_request",
          request_id: requestId,
          ...(status < 500 ? { message: error instanceof Error ? error.message : String(error) } : {})
        });
      }
      void writeJsonAtomic(`${config.artifactRoot}/${timestampSlug()}.${hash.slice(0, 12)}.${requestId}.error.json`, {
        schemaVersion: "raven-gonna-test.prophet-audit.v1",
        requestId,
        requestHash: hash,
        pipelineVersion: config.pipelineVersion,
        status: "error",
        httpStatus: status,
        latencyMs: Date.now() - started,
        errorType: error instanceof Error ? error.name : typeof error
      }).catch(() => undefined);
    } finally {
      clearTimeout(timer);
      request.removeListener("aborted", disconnect);
      response.removeListener("close", disconnect);
      active -= 1;
    }
  });
}

export async function listen(server: Server, config: Pick<ProphetServerConfig, "host" | "port">): Promise<AddressInfo> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(config.port, config.host, () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Prophet server did not bind a TCP address.");
  return address;
}
