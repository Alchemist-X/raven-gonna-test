import type {
  ClockPort,
  ForecastAnswer,
  ForecastResult,
  ForecastTask,
  InformationPolicy,
  ModelPort,
  ModelRequest,
  ModelResponse,
  TrialPrediction
} from "./contracts.js";
import { ForecastAnswerSchema, ForecastTaskSchema, InformationPolicySchema } from "./contracts.js";
import { aggregateTrialPredictions, type AggregationOptions } from "./aggregation.js";
import { validatePolicyForTask } from "./policy.js";
import { answerTypeForTask, buildPrompts } from "./prompt.js";
import { extractJsonLenient, salvageChoice, salvageNumber } from "./parse.js";
import { normalizeProbabilities } from "./probability.js";

export interface ForecastEngineOptions extends AggregationOptions {
  trials?: number;
  concurrency?: number;
  timeoutMs?: number;
  reasoningEffort?: "low" | "medium" | "high";
  researchSources?: string[];
  strategyId?: string;
  fallback?: ForecastAnswer;
  signal?: AbortSignal;
}

const systemClock: ClockPort = { now: () => new Date() };

// Delegates to the tolerant scanner: a stray brace in prose must not throw,
// because a thrown trial is deleted and deleted trials produce no answer at all.
function extractJson(content: string): unknown {
  return extractJsonLenient(content);
}

/**
 * A probability written as a percentage means a fraction: "62%" is 0.62.
 */
function parseProbability(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number(value.replace(/%$/, ""));
    if (Number.isFinite(parsed)) return value.trim().endsWith("%") ? parsed / 100 : parsed;
  }
  throw new Error(`Expected a finite number, received ${JSON.stringify(value)}.`);
}

/**
 * A measured quantity written as a percentage keeps its scale: an answer of
 * "2.7%" to "what exact CPI rate" is 2.7, because the published value — and so
 * the grading truth — is 2.7. Dividing by 100 here yields 0.027 against a
 * tolerance of sigma = 5% * |2.7| = 0.135, which scores exactly 0. Percentage-
 * valued questions dominate the L3/L4 numeric pool, so this distinction is
 * worth a great deal of score.
 */
function parseQuantity(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number(value.trim().replace(/%$/, "").replace(/(\d),(\d{3})/g, "$1$2"));
    if (Number.isFinite(parsed)) return parsed;
  }
  throw new Error(`Expected a finite number, received ${JSON.stringify(value)}.`);
}

function stringArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String).map((item) => item.trim()).filter(Boolean);
  if (typeof value === "string") return value.split(",").map((item) => item.trim()).filter(Boolean);
  throw new Error(`Expected a string list, received ${JSON.stringify(value)}.`);
}

export function parseModelAnswer(task: ForecastTask, response: ModelResponse): ForecastAnswer {
  const parsed = extractJson(response.content);
  switch (task.kind) {
    case "binary_probability": {
      const source = typeof parsed === "object" && parsed !== null
        ? (parsed as Record<string, unknown>).pYes ?? (parsed as Record<string, unknown>).probability ?? parsed
        : parsed;
      return ForecastAnswerSchema.parse({ kind: "binary", pYes: Math.min(1, Math.max(0, parseProbability(source))) });
    }
    case "categorical": {
      const raw = typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {};
      const candidate = "probabilities" in raw && typeof raw.probabilities === "object" && raw.probabilities !== null
        ? (raw.probabilities as Record<string, unknown>)
        : raw;
      const supplied = Object.fromEntries(task.choices.map((choice) => [choice, Number(candidate[choice] ?? 0)]));
      // A prose-only reply leaves every weight at 0, which would normalize to a
      // uniform vector and pick a choice alphabetically — discarding a verdict
      // the model actually stated. Read the conclusion out of the prose instead.
      if (Object.values(supplied).every((weight) => !Number.isFinite(weight) || weight === 0)) {
        const salvaged = salvageChoice(response.content, task.choices);
        if (salvaged) {
          const probabilities = normalizeProbabilities(
            Object.fromEntries(task.choices.map((choice) => [choice, choice === salvaged ? 1 : 0])),
            task.choices
          );
          return ForecastAnswerSchema.parse({ kind: "categorical", choice: salvaged, probabilities });
        }
      }
      const probabilities = normalizeProbabilities(supplied, task.choices);
      const choice = task.choices.reduce((best, current) =>
        (probabilities[current] ?? 0) > (probabilities[best] ?? 0) ? current : best
      );
      return ForecastAnswerSchema.parse({ kind: "categorical", choice, probabilities });
    }
    case "multi_label": {
      const raw = typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {};
      const provided = typeof raw.probabilities === "object" && raw.probabilities !== null
        ? (raw.probabilities as Record<string, unknown>)
        : raw;
      const probabilities = Object.fromEntries(
        task.choices.map((choice) => {
          const numeric = Number(provided[choice]);
          return [choice, Number.isFinite(numeric) ? Math.min(1, Math.max(0, numeric)) : 0];
        })
      );
      const selectedValue = raw.selected ?? raw.selection;
      const selected = selectedValue === undefined
        ? task.choices.filter((choice) => (probabilities[choice] ?? 0) >= 0.5)
        : stringArray(selectedValue).filter((choice) => task.choices.includes(choice));
      for (const choice of selected) {
        if ((probabilities[choice] ?? 0) === 0) probabilities[choice] = 1;
      }
      return ForecastAnswerSchema.parse({ kind: "multi_label", selected: [...new Set(selected)], probabilities });
    }
    case "ranking": {
      const raw = typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {};
      const allowed = new Set(task.candidates);
      const order = stringArray(raw.order ?? raw.ranking ?? parsed)
        .filter((candidate) => allowed.size === 0 || allowed.has(candidate));
      const unique = [...new Set(order)].slice(0, task.rankCount);
      if (unique.length !== task.rankCount) throw new Error(`Expected ${task.rankCount} ranked items; received ${unique.length}.`);
      return ForecastAnswerSchema.parse({ kind: "ranking", order: unique });
    }
    case "numeric": {
      const raw = typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {};
      const supplied = raw.mean ?? raw.value ?? parsed;
      // parseQuantity throws on prose. Scrape a figure out of the reply instead
      // of deleting the trial — and via salvageNumber, which likewise keeps a
      // percentage at its point value.
      const salvaged = typeof supplied === "string" ? salvageNumber(supplied) : null;
      const value = salvaged ?? parseQuantity(supplied);
      const standardDeviation = Number(raw.standard_deviation ?? raw.standardDeviation);
      const answer: ForecastAnswer = { kind: "numeric", value };
      if (task.unit !== undefined) answer.unit = task.unit;
      if (Number.isFinite(standardDeviation) && standardDeviation >= 0) {
        answer.interval = [value - 1.96 * standardDeviation, value + 1.96 * standardDeviation];
      }
      return ForecastAnswerSchema.parse(answer);
    }
    case "free_response": {
      const raw = typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {};
      const value = String(raw.answer ?? raw.prediction ?? parsed).trim();
      if (!value) throw new Error("Model returned an empty answer.");
      return ForecastAnswerSchema.parse({ kind: "free_response", value });
    }
  }
}

async function mapConcurrent<T>(count: number, concurrency: number, worker: (index: number) => Promise<T>): Promise<T[]> {
  const results = new Array<T>(count);
  let next = 0;
  async function run(): Promise<void> {
    while (true) {
      const index = next++;
      if (index >= count) return;
      results[index] = await worker(index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(count, concurrency) }, () => run()));
  return results;
}

async function withAbort<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) throw signal.reason ?? new Error("Operation aborted.");
  let onAbort: (() => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(signal.reason ?? new Error("Operation aborted."));
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    return await Promise.race([operation, aborted]);
  } finally {
    if (onAbort) signal.removeEventListener("abort", onAbort);
  }
}

export class ForecastEngine {
  constructor(
    private readonly model: ModelPort,
    private readonly clock: ClockPort = systemClock
  ) {}

  /** The port's model id, so a caller synthesising a degraded result can label it accurately. */
  get modelId(): string {
    return this.model.model;
  }

  async forecast(
    task: ForecastTask,
    policy: InformationPolicy,
    options: ForecastEngineOptions = {}
  ): Promise<ForecastResult> {
    task = ForecastTaskSchema.parse(task);
    policy = InformationPolicySchema.parse(policy);
    validatePolicyForTask(task, policy);
    const trials = options.trials ?? 3;
    if (!Number.isInteger(trials) || trials < 1 || trials > 20) throw new Error("trials must be an integer in [1,20].");
    const concurrency = Math.max(1, options.concurrency ?? Math.min(3, trials));
    const timeoutMs = options.timeoutMs ?? 15 * 60_000;
    if (!Number.isFinite(timeoutMs) || timeoutMs < 1) throw new Error("timeoutMs must be positive.");
    const { systemPrompt, userPrompt } = buildPrompts(task, policy);
    const research: ModelRequest["research"] =
      policy.web === "deny" ? false : options.researchSources ? { sources: options.researchSources } : true;
    const baseRequest: ModelRequest = {
      task,
      policy,
      systemPrompt,
      userPrompt,
      answerType: answerTypeForTask(task),
      research,
      reasoningEffort: options.reasoningEffort ?? "medium"
    };
    const warnings: string[] = [];
    const successful: TrialPrediction[] = [];
    const roles = [
      "base-rate analyst",
      "case-specific evidence analyst",
      "adversarial skeptic",
      "resolution-criteria specialist",
      "calibration critic"
    ];

    const outcomes = await mapConcurrent(trials, concurrency, async (trial) => {
      const started = this.clock.now().getTime();
      const controller = new AbortController();
      const abortFromParent = (): void => controller.abort(options.signal?.reason);
      if (options.signal?.aborted) abortFromParent();
      else options.signal?.addEventListener("abort", abortFromParent, { once: true });
      const timeout = setTimeout(() => controller.abort(new Error(`Trial timed out after ${timeoutMs}ms.`)), timeoutMs);
      const role = roles[trial % roles.length] ?? "";
      try {
        const request: ModelRequest = {
          ...baseRequest,
          userPrompt: `${baseRequest.userPrompt}\n\nIndependent trial role: ${role}. Do the analysis independently before returning the required answer.`
        };
        const response = await withAbort(this.model.generate(request, controller.signal), controller.signal);
        const answer = parseModelAnswer(task, response);
        const result: TrialPrediction = {
          trial,
          answer,
          citations: response.citations,
          rawResponse: response.content,
          latencyMs: Math.max(0, this.clock.now().getTime() - started)
        };
        // Reasoning is the only thing that makes a resolved miss diagnosable,
        // so keep whatever the provider exposed rather than dropping it here.
        if (response.thinking !== undefined) result.thinking = response.thinking;
        if (role) result.role = role;
        if (response.usage !== undefined) result.usage = response.usage;
        return { ok: true as const, result };
      } catch (error) {
        return { ok: false as const, trial, error: error instanceof Error ? error.message : String(error) };
      } finally {
        clearTimeout(timeout);
        options.signal?.removeEventListener("abort", abortFromParent);
      }
    });

    for (const outcome of outcomes) {
      if (outcome.ok) successful.push(outcome.result);
      else warnings.push(`trial ${outcome.trial}: ${outcome.error}`);
    }

    let fallbackUsed = false;
    let answer: ForecastAnswer;
    if (successful.length > 0) {
      // Aggregation can detect problems the answer alone cannot express, so it
      // reports them here rather than emitting a plausible number in silence.
      const diagnostics: string[] = [];
      answer = aggregateTrialPredictions(task, successful, { ...options, diagnostics });
      warnings.push(...diagnostics);
    } else if (options.fallback) {
      answer = options.fallback;
      fallbackUsed = true;
      warnings.push("All model trials failed; deterministic fallback used.");
    } else {
      throw new AggregateError(warnings, `Every model trial failed for ${task.taskId}.`);
    }

    return {
      schemaVersion: "raven-gonna-test.forecast-result.v1",
      taskId: task.taskId,
      answer,
      trials: successful,
      model: this.model.model,
      strategyId: options.strategyId ?? "independent-trials-logit-v1",
      policyId: policy.id,
      generatedAtUtc: this.clock.now().toISOString(),
      fallbackUsed,
      warnings
    };
  }
}
