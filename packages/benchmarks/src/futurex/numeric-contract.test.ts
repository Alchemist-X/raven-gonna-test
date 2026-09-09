import { describe, expect, it } from "vitest";
import type { ForecastResult } from "@raven-gonna-test/forecast-core";
import { analyzeFutureXQuestions, assertFutureXNumericResults, buildFutureXSubmission, futureXQuestionsToTasks, FutureXRouteOverrideSchema } from "./index.js";

const question = { id: "revenue", en_title: "What quarterly revenue will be reported?", prompt: "Return exactly the source-native value required by the settlement contract.", level: 3, end_time: "2026-09-10" };
const contract = { targetField: "total_revenue", definition: "Total quarterly revenue in the first issuer release for the period named in the question.", unit: "USD million", scale: "One million USD per output unit." };
const options = { revision: "a".repeat(40), roundId: "test", asOfUtc: "2026-09-09T00:00:00Z", requireNumericContracts: true };
const routeOverrides = { revenue: { kind: "numeric" as const, numericContract: contract } };
const tasks = () => futureXQuestionsToTasks([question], { ...options, routeOverrides }).tasks;
const result = (): ForecastResult => {
  const answer = { kind: "numeric" as const, value: 2728, targetField: "total_revenue", unit: "USD million" };
  return { schemaVersion: "raven-gonna-test.forecast-result.v1", taskId: tasks()[0]!.taskId, answer, trials: [{ trial: 0, answer, citations: [], rawResponse: "", latencyMs: 1 }], model: "fake", strategyId: "test", policyId: "test", generatedAtUtc: options.asOfUtc, fallbackUsed: false, warnings: [] };
};

describe("FutureX numeric candidate gates", () => {
  it("requires explicit reviewed contracts for live tasks, including prompts with a unit", () => {
    for (const prompt of [question.prompt, `${question.prompt}\nReport the value in USD million.`]) {
      expect(() => futureXQuestionsToTasks([{ ...question, prompt }], options)).toThrow(/requires a reviewed numericContract/);
    }
    expect(analyzeFutureXQuestions([question]).routeReview.missingNumericContracts).toBe(1);
    expect(tasks()[0]).toMatchObject({ numericContract: contract, unit: "USD million" });
    expect(() => FutureXRouteOverrideSchema.parse({ kind: "open_text", numericContract: contract })).toThrow(/only valid/);
  });

  it("keeps historical offline data readable without implying it passed the new gate", () => {
    expect(() => futureXQuestionsToTasks([question], { ...options, requireNumericContracts: false })).not.toThrow();
    expect(() => assertFutureXNumericResults(tasks(), [{ ...result(), answer: { kind: "numeric", value: 2728 } }])).toThrow(/target_field/);
  });

  it("accepts validated results while preserving the official two-field wire format", () => {
    expect(() => assertFutureXNumericResults(tasks(), [result()])).not.toThrow();
    expect(buildFutureXSubmission([question], [result()])).toEqual([{ id: "revenue", prediction: "2728" }]);
  });

  it("blocks fallback, missing trials and mismatched resumed trial metadata before export", () => {
    expect(() => assertFutureXNumericResults(tasks(), [{ ...result(), fallbackUsed: true, warnings: ["All model trials failed."] }])).toThrow(/fallback/);
    expect(() => assertFutureXNumericResults(tasks(), [{ ...result(), trials: [] }])).toThrow(/no validated trials/);
    const invalid = result();
    invalid.trials[0]!.answer = { kind: "numeric", value: 2.728, unit: "USD billion", targetField: "total_revenue" };
    expect(() => assertFutureXNumericResults(tasks(), [invalid])).toThrow(/unit mismatch/);
  });

  it("permits only explicitly allowlisted, labelled closed-question fallbacks", () => {
    const fallback = { ...result(), fallbackUsed: true, trials: [], warnings: ["Live research skipped: task cutoff reached."] };
    expect(() => assertFutureXNumericResults(tasks(), [fallback], { allowFallbackTaskIds: new Set([fallback.taskId]) })).not.toThrow();
    expect(() => assertFutureXNumericResults(tasks(), [fallback], { allowFallbackTaskIds: new Set() })).toThrow(/fallback/);
  });
});
