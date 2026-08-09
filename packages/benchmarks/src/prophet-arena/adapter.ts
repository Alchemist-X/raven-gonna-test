import type { ForecastAnswer, ForecastResult, ForecastTask } from "@raven-gonna-test/forecast-core";
import { clampProbability, prophetArenaPolicy } from "@raven-gonna-test/forecast-core";
import type { ValidationReport } from "../contract.js";
import {
  ProphetCurrentRequestSchema,
  ProphetCurrentResponseSchema,
  ProphetLegacyRequestSchema,
  ProphetLegacyResponseSchema,
  type CanonicalProphetEvent,
  type ProphetCurrentResponse,
  type ProphetGeometry,
  type ProphetLegacyResponse,
  type ProphetMarketStats,
  type ProphetWireMode
} from "./schema.js";

export function detectProphetWireVersion(body: unknown): "current" | "legacy" {
  if (!body || typeof body !== "object") throw new Error("Prophet request must be an object.");
  const record = body as Record<string, unknown>;
  if (Array.isArray(record.outcomes)) return "current";
  if (Array.isArray(record.markets)) return "legacy";
  throw new Error("Prophet request has neither outcomes nor markets.");
}

export function normalizeProphetRequest(body: unknown, mode: ProphetWireMode = "auto"): CanonicalProphetEvent {
  const detected = detectProphetWireVersion(body);
  if (mode !== "auto" && mode !== detected) throw new Error(`Expected Prophet ${mode} wire format; received ${detected}.`);
  if (detected === "current") {
    const request = ProphetCurrentRequestSchema.parse(body);
    if (request.resolved_outcome !== null && request.resolved_outcome !== undefined) {
      throw new Error("Resolved outcomes are forbidden on the live Prophet endpoint.");
    }
    return {
      wireVersion: "current",
      eventId: request.event_ticker,
      title: request.title,
      category: request.category || null,
      rules: request.rules ?? null,
      closeTime: request.close_time ?? null,
      outcomes: request.outcomes,
      resolvedOutcome: request.resolved_outcome ?? null,
      marketStats: request.market_stats
    };
  }
  const request = ProphetLegacyRequestSchema.parse(body);
  return {
    wireVersion: "legacy",
    eventId: request.event_id,
    title: request.title,
    category: request.category ?? null,
    rules: request.rules ?? null,
    closeTime: request.close_time ?? null,
    outcomes: request.markets,
    resolvedOutcome: null,
    marketStats: request.market_stats
  };
}

function validProbability(value: number | null | undefined): value is number {
  return value !== null && value !== undefined && Number.isFinite(value) && value >= 0 && value <= 1;
}

export function prophetQuoteMidpoint(quote: ProphetMarketStats | undefined): number {
  if (!quote) return 0.5;
  const values: number[] = [];
  if (validProbability(quote.yes_ask)) values.push(quote.yes_ask);
  if (validProbability(quote.no_ask)) values.push(1 - quote.no_ask);
  if (values.length) return values.reduce((sum, value) => sum + value, 0) / values.length;
  if (validProbability(quote.last_price)) return quote.last_price;
  return 0.5;
}

export function prophetTaskId(eventId: string, outcome: string): string {
  return `prophet-arena:${encodeURIComponent(eventId)}:${encodeURIComponent(outcome)}`;
}

function closeTimeIso(value: string | null): string | undefined {
  if (!value) return undefined;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : undefined;
}

export function prophetEventToTasks(event: CanonicalProphetEvent, asOfUtc: string): ForecastTask[] {
  return event.outcomes.map((outcome) => {
    const prior = prophetQuoteMidpoint(event.marketStats[outcome]);
    const deadline = closeTimeIso(event.closeTime);
    return {
      taskId: prophetTaskId(event.eventId, outcome),
      origin: {
        benchmark: "prophet-arena",
        roundId: event.eventId,
        externalId: `${event.eventId}:${outcome}`,
        source: "kalshi"
      },
      kind: "binary_probability",
      prompt: [
        `Event: ${event.title}`,
        event.category ? `Category: ${event.category}` : "",
        `Market/outcome: ${outcome}`,
        `Will this market resolve YES?`,
        event.rules ? `Rules: ${event.rules}` : ""
      ].filter(Boolean).join("\n\n"),
      asOfUtc,
      ...(deadline ? { deadlineUtc: deadline } : {}),
      resolution: {
        criteria: event.rules ?? `Resolves according to Prophet Arena/Kalshi rules for ${outcome}.`,
        ...(deadline ? { dateUtc: deadline } : {}),
        source: "Prophet Arena supplied event rules"
      },
      priorProbability: prior,
      metadata: {
        eventId: event.eventId,
        outcome,
        category: event.category,
        marketPrior: prior,
        quote: event.marketStats[outcome] ?? null,
        wireVersion: event.wireVersion
      }
    };
  });
}

export function prophetFallbackAnswer(task: ForecastTask): ForecastAnswer {
  if (task.kind !== "binary_probability") throw new Error("Prophet fallback expects a binary task.");
  return { kind: "binary", pYes: task.priorProbability ?? 0.5 };
}

export function applyBoundedResidual(modelProbability: number, prior: number, cap = 0.05): number {
  if (!Number.isFinite(cap) || cap < 0 || cap > 1) throw new Error("Residual cap must be in [0,1].");
  const residual = Math.max(-cap, Math.min(cap, modelProbability - prior));
  return clampProbability(prior + residual, 0, 1);
}

function projectFixedSum(values: number[], priors: number[], cap: number, target: number): number[] {
  const lower = priors.map((prior) => Math.max(0, prior - cap));
  const upper = priors.map((prior) => Math.min(1, prior + cap));
  const minimum = lower.reduce((sum, value) => sum + value, 0);
  const maximum = upper.reduce((sum, value) => sum + value, 0);
  if (target < minimum - 1e-9 || target > maximum + 1e-9) throw new Error("Fixed-sum target is infeasible under the residual cap.");
  let lo = -2;
  let hi = 2;
  for (let iteration = 0; iteration < 100; iteration += 1) {
    const tau = (lo + hi) / 2;
    const sum = values.reduce((total, value, index) => {
      const projected = Math.max(lower[index] ?? 0, Math.min(upper[index] ?? 1, value - tau));
      return total + projected;
    }, 0);
    if (sum > target) lo = tau;
    else hi = tau;
  }
  const tau = (lo + hi) / 2;
  return values.map((value, index) => Math.max(lower[index] ?? 0, Math.min(upper[index] ?? 1, value - tau)));
}

function projectMonotone(values: number[], direction: "nonIncreasing" | "nonDecreasing"): number[] {
  const sign = direction === "nonIncreasing" ? -1 : 1;
  const blocks = values.map((value, index) => ({ start: index, end: index, sum: sign * value, count: 1 }));
  for (let index = 0; index < blocks.length - 1;) {
    const left = blocks[index];
    const right = blocks[index + 1];
    if (!left || !right) break;
    if (left.sum / left.count <= right.sum / right.count) {
      index += 1;
      continue;
    }
    blocks.splice(index, 2, {
      start: left.start,
      end: right.end,
      sum: left.sum + right.sum,
      count: left.count + right.count
    });
    if (index > 0) index -= 1;
  }
  const result = new Array<number>(values.length);
  for (const block of blocks) {
    const value = sign * block.sum / block.count;
    for (let index = block.start; index <= block.end; index += 1) result[index] = value;
  }
  return result;
}

function projectMonotoneWithBounds(
  values: number[],
  priors: number[],
  cap: number,
  direction: "nonIncreasing" | "nonDecreasing"
): number[] {
  const lower = priors.map((prior) => Math.max(0, prior - cap));
  const upper = priors.map((prior) => Math.min(1, prior + cap));
  let projected = [...values];
  for (let iteration = 0; iteration < 2_000; iteration += 1) {
    const previous = projected;
    const monotone = projectMonotone(previous, direction);
    projected = monotone.map((value, index) => Math.max(lower[index] ?? 0, Math.min(upper[index] ?? 1, value)));
    const delta = Math.max(...projected.map((value, index) => Math.abs(value - (previous[index] ?? value))));
    if (delta < 1e-12) break;
  }
  const monotone = projected.every((value, index) => {
    if (index === 0) return true;
    const previous = projected[index - 1] ?? value;
    return direction === "nonIncreasing" ? value <= previous + 1e-10 : value >= previous - 1e-10;
  });
  const bounded = projected.every((value, index) => value >= (lower[index] ?? 0) - 1e-10 && value <= (upper[index] ?? 1) + 1e-10);
  if (!monotone || !bounded) throw new Error("Threshold geometry is infeasible under the configured residual cap.");
  return projected;
}

export function buildProphetCurrentResponse(
  event: CanonicalProphetEvent,
  results: readonly ForecastResult[],
  options: { residualCap?: number; geometry?: ProphetGeometry } = {}
): ProphetCurrentResponse {
  const cap = options.residualCap ?? 0.05;
  const resultById = new Map(results.map((result) => [result.taskId, result]));
  const priors = event.outcomes.map((outcome) => prophetQuoteMidpoint(event.marketStats[outcome]));
  let probabilities = event.outcomes.map((outcome, index) => {
    const result = resultById.get(prophetTaskId(event.eventId, outcome));
    const modelProbability = result?.answer.kind === "binary" ? result.answer.pYes : priors[index] ?? 0.5;
    return applyBoundedResidual(modelProbability, priors[index] ?? 0.5, cap);
  });
  const geometry = options.geometry ?? { kind: "independent" as const };
  if (geometry.kind === "exclusive") probabilities = projectFixedSum(probabilities, priors, cap, geometry.sum);
  if (geometry.kind === "threshold_ladder") {
    probabilities = projectMonotoneWithBounds(probabilities, priors, cap, geometry.direction);
  }
  return ProphetCurrentResponseSchema.parse({
    probabilities: event.outcomes.map((market, index) => ({
      market,
      probability: Number((probabilities[index] ?? 0.5).toFixed(12))
    }))
  });
}

export function buildProphetLegacyResponse(
  event: CanonicalProphetEvent,
  results: readonly ForecastResult[],
  options: { residualCap?: number; geometry?: ProphetGeometry } = {}
): ProphetLegacyResponse {
  const current = buildProphetCurrentResponse(event, results, {
    ...options,
    geometry: options.geometry ?? { kind: "exclusive", sum: 1 }
  });
  return ProphetLegacyResponseSchema.parse({
    event_id: event.eventId,
    prediction: Object.fromEntries(current.probabilities.map((row) => [row.market, row.probability])),
    rationale: "Market-prior forecast with bounded, evidence-gated residual adjustment."
  });
}

export function validateProphetLegacyResponse(
  event: CanonicalProphetEvent,
  responseInput: unknown
): ValidationReport {
  const parsed = ProphetLegacyResponseSchema.safeParse(responseInput);
  if (!parsed.success) {
    return {
      valid: false,
      errors: parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`),
      warnings: [],
      stats: {}
    };
  }
  const errors: string[] = [];
  if (parsed.data.event_id !== event.eventId) errors.push("Legacy response event_id does not match the request.");
  const labels = Object.keys(parsed.data.prediction);
  if (labels.length !== event.outcomes.length || labels.some((label, index) => label !== event.outcomes[index])) {
    errors.push("Legacy prediction labels/order must exactly match request markets.");
  }
  const sum = Object.values(parsed.data.prediction).reduce((total, value) => total + value, 0);
  if (Math.abs(sum - 1) > 1e-8) errors.push(`Legacy probabilities must sum to 1; got ${sum}.`);
  return {
    valid: errors.length === 0,
    errors,
    warnings: [],
    stats: { outcomes: labels.length, sum }
  };
}

export function validateProphetCurrentResponse(
  event: CanonicalProphetEvent,
  responseInput: unknown,
  geometry: ProphetGeometry = { kind: "independent" }
): ValidationReport {
  const parsed = ProphetCurrentResponseSchema.safeParse(responseInput);
  if (!parsed.success) {
    return {
      valid: false,
      errors: parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`),
      warnings: [],
      stats: {}
    };
  }
  const errors: string[] = [];
  const labels = parsed.data.probabilities.map((row) => row.market);
  if (labels.length !== event.outcomes.length || labels.some((label, index) => label !== event.outcomes[index])) {
    errors.push("Response labels/order must exactly match request outcomes.");
  }
  if (new Set(labels).size !== labels.length) errors.push("Response contains duplicate outcome labels.");
  const values = parsed.data.probabilities.map((row) => row.probability);
  if (geometry.kind === "exclusive") {
    const sum = values.reduce((total, value) => total + value, 0);
    if (Math.abs(sum - geometry.sum) > 1e-8) errors.push(`Exclusive probabilities must sum to ${geometry.sum}; got ${sum}.`);
  }
  if (geometry.kind === "threshold_ladder") {
    const invalid = values.some((value, index) => {
      if (index === 0) return false;
      const previous = values[index - 1] ?? value;
      return geometry.direction === "nonIncreasing" ? value > previous + 1e-12 : value < previous - 1e-12;
    });
    if (invalid) errors.push(`Threshold ladder is not ${geometry.direction}.`);
  }
  return {
    valid: errors.length === 0,
    errors,
    warnings: geometry.kind === "independent" ? ["No cross-market normalization was applied by design."] : [],
    stats: { outcomes: labels.length, geometry: geometry.kind }
  };
}

export function policyForProphetTask(task: ForecastTask) {
  return prophetArenaPolicy(task.asOfUtc);
}
