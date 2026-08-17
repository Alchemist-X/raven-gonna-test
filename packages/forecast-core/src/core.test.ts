import { describe, expect, it } from "vitest";
import { ForecastTaskSchema, type ForecastTask, type TrialPrediction } from "./contracts.js";
import { aggregateTrialPredictions } from "./aggregation.js";
import { parseModelAnswer } from "./engine.js";
import { forecastBenchDatasetPolicy, validateEvidence } from "./policy.js";
import { answerTypeForTask } from "./prompt.js";
import { logitPool, normalizeProbabilities } from "./probability.js";

const base = {
  origin: { benchmark: "forecastbench" as const, roundId: "2026-08-16", externalId: "q", source: "manifold" },
  prompt: "Will it happen?",
  asOfUtc: "2026-08-16T00:00:00.000Z",
  resolution: { criteria: "YES if it happens." },
  metadata: {}
};

describe("probability math", () => {
  it("normalizes vectors and pools probabilities in logit space", () => {
    expect(normalizeProbabilities({ A: 2, B: 1 })).toEqual({ A: 2 / 3, B: 1 / 3 });
    expect(logitPool([0.2, 0.8])).toBeCloseTo(0.5, 12);
  });
});

describe("aggregation", () => {
  it("aggregates binary trials and can shrink to a prior", () => {
    const task: ForecastTask = { ...base, taskId: "binary", kind: "binary_probability", priorProbability: 0.6 };
    const trials: TrialPrediction[] = [0.4, 0.6, 0.8].map((pYes, trial) => ({
      trial,
      answer: { kind: "binary", pYes },
      citations: [],
      rawResponse: String(pYes),
      latencyMs: 1
    }));
    const answer = aggregateTrialPredictions(task, trials, { priorProbability: 0.6, priorWeight: 0.5 });
    expect(answer.kind).toBe("binary");
    if (answer.kind === "binary") expect(answer.pYes).toBeGreaterThan(0.59);
  });

  it("uses Borda aggregation for rankings", () => {
    const task: ForecastTask = {
      ...base,
      taskId: "rank",
      kind: "ranking",
      candidates: ["A", "B", "C"],
      rankCount: 3
    };
    const orders = [["A", "B", "C"], ["A", "C", "B"], ["B", "A", "C"]];
    const trials: TrialPrediction[] = orders.map((order, trial) => ({
      trial,
      answer: { kind: "ranking", order },
      citations: [],
      rawResponse: JSON.stringify(order),
      latencyMs: 1
    }));
    expect(aggregateTrialPredictions(task, trials)).toMatchObject({ kind: "ranking", order: ["A", "B", "C"] });
  });

  it("aggregates open-candidate rankings without degrading to a string vote", () => {
    const task: ForecastTask = { ...base, taskId: "open-rank", kind: "ranking", candidates: [], rankCount: 3 };
    const trials: TrialPrediction[] = [
      ["Alpha", "Beta", "Gamma"],
      ["Alpha", "Gamma", "Beta"],
      ["Delta", "Alpha", "Beta"]
    ].map((order, trial) => ({ trial, answer: { kind: "ranking", order }, citations: [], rawResponse: "", latencyMs: 1 }));
    expect(aggregateTrialPredictions(task, trials)).toMatchObject({ kind: "ranking", order: ["Alpha", "Beta", "Gamma"] });
  });

  it("parses Foresight-style independent multi-label probabilities", () => {
    const task: ForecastTask = {
      ...base,
      taskId: "multi",
      kind: "multi_label",
      choices: ["A", "B", "C"],
      minimumSelections: 1,
      maximumSelections: 3
    };
    expect(answerTypeForTask(task)).toBe("free_response");
    expect(parseModelAnswer(task, {
      content: '<answer>{"A":0.7,"B":0.2,"C":0.6}</answer>',
      citations: []
    })).toEqual({ kind: "multi_label", selected: ["A", "C"], probabilities: { A: 0.7, B: 0.2, C: 0.6 } });
  });

  it("rejects duplicate choices and impossible ranking contracts", () => {
    expect(() => ForecastTaskSchema.parse({ ...base, taskId: "dup", kind: "categorical", choices: ["A", "A"] })).toThrow(/unique/);
    expect(() => ForecastTaskSchema.parse({ ...base, taskId: "bad-rank", kind: "ranking", candidates: ["A", "B"], rankCount: 3 })).toThrow(/exceeds/);
  });
});

describe("evidence policy", () => {
  it("rejects post-cutoff and prediction-market evidence for dataset questions", () => {
    const policy = forecastBenchDatasetPolicy("2026-08-16T00:00:00.000Z");
    expect(() => validateEvidence({
      id: "e1",
      claim: "Future result",
      url: "https://example.com/future",
      sourceClass: "primary",
      use: "fact",
      publishedAtUtc: "2026-08-17T00:00:00.000Z",
      retrievedAtUtc: "2026-08-16T00:00:00.000Z"
    }, policy)).toThrow(/after the cutoff/);
    expect(() => validateEvidence({
      id: "e2",
      claim: "Market price",
      url: "https://example.com/market",
      sourceClass: "prediction_market_price",
      use: "prior",
      observedValueAtUtc: "2026-08-15T00:00:00.000Z",
      retrievedAtUtc: "2026-08-16T00:00:00.000Z"
    }, policy)).toThrow(/forbids prediction-market prices/);
  });
});

describe("numeric vs probability parsing", () => {
  const numericTask = (unit?: string): ForecastTask =>
    ForecastTaskSchema.parse({
      ...base,
      taskId: "n1",
      kind: "numeric",
      prompt: "What exact CPI rate will be reported?",
      ...(unit ? { unit } : {})
    });

  const response = (content: string) => ({ content, citations: [] });

  it("keeps a measured percentage at its published scale", () => {
    // Gold for "what exact CPI rate" is 2.7. Converting to 0.027 scores exactly
    // 0 under sigma = 5% * |2.7| = 0.135.
    expect(parseModelAnswer(numericTask(), response('<answer>{"value": "2.7%"}</answer>'))).toMatchObject({
      kind: "numeric",
      value: 2.7
    });
    expect(parseModelAnswer(numericTask(), response('<answer>{"value": "1,234.5"}</answer>'))).toMatchObject({
      value: 1234.5
    });
  });

  it("still reads a probability percentage as a fraction", () => {
    const binaryTask = ForecastTaskSchema.parse({ ...base, taskId: "b1", kind: "binary_probability" });
    expect(parseModelAnswer(binaryTask, response('<answer>{"probability": "62%"}</answer>'))).toMatchObject({
      kind: "binary",
      pYes: 0.62
    });
  });

  it("salvages a figure from prose instead of deleting the trial", () => {
    const prose = "After weighing the evidence I expect the rate to print at 3.1% next week.";
    expect(parseModelAnswer(numericTask(), response(prose))).toMatchObject({ value: 3.1 });
  });

  it("carries the published field name through as the unit", () => {
    expect(parseModelAnswer(numericTask("revenue_usd_millions"), response('<answer>{"value": 3900}</answer>'))).toMatchObject({
      value: 3900,
      unit: "revenue_usd_millions"
    });
  });
});
