import { describe, expect, it } from "vitest";
import { aggregateTrialPredictions } from "./aggregation.js";
import { ForecastTaskSchema, NumericOutputContractSchema, type NumericTask, type TrialPrediction } from "./contracts.js";
import { ForecastEngine, parseModelAnswer } from "./engine.js";
import { normalizeNumericAnswer } from "./numeric-contract.js";
import { futureXPolicy } from "./policy.js";
import { buildPrompts } from "./prompt.js";

const task: NumericTask = {
  taskId: "numeric-test", kind: "numeric", unit: "USD million",
  origin: { benchmark: "futurex", roundId: "test", externalId: "test" },
  prompt: "Forecast quarterly total revenue.", asOfUtc: "2026-08-26T00:00:00Z",
  resolution: { criteria: "Quarterly total revenue in the first issuer release." }, metadata: {},
  numericContract: {
    targetField: "revenue_usd_millions", definition: "Total quarterly revenue, first issuer release for the quarter named in the question.",
    unit: "USD million", scale: "One output unit equals one million USD.",
    acceptedUnits: [{ unit: "USD billion", multiplier: 1000 }, { unit: "USD", multiplier: 0.000001 }]
  }
};
const reply = (payload: unknown) => ({ content: `<answer>${JSON.stringify(payload)}</answer>`, citations: [] });
const modelAnswer = (value: number, unit = "USD million") => ({ value, unit, target_field: "revenue_usd_millions" });
const trial = (answer: TrialPrediction["answer"], index = 0): TrialPrediction => ({ trial: index, answer, citations: [], rawResponse: "", latencyMs: 1 });

describe("reviewed numeric contracts", () => {
  it("converts declared scales before aggregation, preserves uncertainty and conversion provenance", () => {
    const answer = parseModelAnswer(task, reply({ ...modelAnswer(2.728, "USD billion"), standard_deviation: 0.1 }));
    expect(answer).toMatchObject({ value: 2728, unit: "USD million", targetField: "revenue_usd_millions", normalization: { sourceValue: 2.728, sourceUnit: "USD billion", multiplier: 1000 } });
    if (answer.kind !== "numeric") throw new Error("numeric expected");
    expect(answer.interval?.[0]).toBeCloseTo(2532);
    expect(answer.interval?.[1]).toBeCloseTo(2924);
    // Conversion is idempotent when an already-normalized checkpoint is pooled.
    expect(normalizeNumericAnswer(task, answer)).toEqual(answer);
    expect(aggregateTrialPredictions(task, [trial(answer), trial(parseModelAnswer(task, reply(modelAnswer(2728))), 1)])).toMatchObject({ value: 2728, unit: "USD million", targetField: "revenue_usd_millions" });
  });

  it.each([
    { value: 2.7 },
    { value: 2.7, target_field: "net_income", unit: "USD million" },
    { ...modelAnswer(2.7), unit: "billions" },
    { ...modelAnswer(2.7), value: "" },
    { ...modelAnswer(2.7), value: "FY2027 revenue is 2.7 billion" },
    { ...modelAnswer(2.7), standard_deviation: -1 }
  ])("rejects absent/wrong field, undeclared units and malformed values: %j", (payload) => {
    expect(() => parseModelAnswer(task, reply(payload))).toThrow();
  });

  it("rejects unannotated imported trials even if other trials agree", () => {
    expect(() => aggregateTrialPredictions(task, [trial({ kind: "numeric", value: 2728 }), trial(parseModelAnswer(task, reply(modelAnswer(2728))), 1)])).toThrow(/target_field/);
  });

  it("keeps percent quantities at point scale and supports negative/zero outcomes", () => {
    const percentTask: NumericTask = { ...task, unit: "percent", numericContract: { targetField: "monthly_change", definition: "Headline monthly change, not index level.", unit: "percent", scale: "2.7 means 2.7 percent.", acceptedUnits: [{ unit: "fraction", multiplier: 100 }] } };
    for (const value of [0, -0.2, 2.7]) {
      const answer = parseModelAnswer(percentTask, reply({ value, unit: "percent", target_field: "monthly_change" }));
      expect(answer).toMatchObject({ value });
    }
    expect(parseModelAnswer(percentTask, reply({ value: 0.027, unit: "fraction", target_field: "monthly_change" }))).toMatchObject({ value: 2.7 });
    expect(() => parseModelAnswer(percentTask, reply({ value: 130, unit: "percent", target_field: "index_level" }))).toThrow(/target_field/);
  });

  it("rejects ambiguous conversion tables, conflicting task units and conversion overflow", () => {
    expect(() => NumericOutputContractSchema.parse({ ...task.numericContract, acceptedUnits: [{ unit: "USD million", multiplier: 1000 }] })).toThrow(/unique/);
    expect(() => ForecastTaskSchema.parse({ ...task, unit: "USD billion" })).toThrow(/canonical unit/);
    expect(() => parseModelAnswer(task, reply(modelAnswer(Number.MAX_VALUE, "USD billion")))).toThrow(/overflow/);
  });

  it("does not hide contract failures in the trial trace", async () => {
    const engine = new ForecastEngine({ model: "fake", generate: async () => reply({ value: 2.728 }) });
    const result = await engine.forecast(task, futureXPolicy(task.asOfUtc), { trials: 1, fallback: { kind: "numeric", value: 0 } });
    expect(result.fallbackUsed).toBe(true);
    expect(result.trials).toHaveLength(0);
    expect(result.warnings.join(" ")).toContain("target_field mismatch");
  });

  it("includes the exact target, definition and declared conversions in the prompt", () => {
    const { userPrompt } = buildPrompts(task, futureXPolicy(task.asOfUtc));
    expect(userPrompt).toContain('"target_field":"revenue_usd_millions"');
    expect(userPrompt).toContain("first issuer release");
    expect(userPrompt).toContain('"multiplier": 1000');
  });
});
