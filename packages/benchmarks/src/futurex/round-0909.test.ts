import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { aggregateTrialPredictions, ForecastEngine, ForecastTaskSchema, futureXPolicy, parseModelAnswer, type ForecastTask, type ModelRequest } from "@raven-gonna-test/forecast-core";
import { analyzeFutureXQuestions, assertFutureXNumericResults, buildFutureXSubmission, futureXQuestionsToTasks, FutureXRouteOverrideFileSchema, routeFutureXQuestion, validateFutureXSubmission } from "./index.js";

const round = new URL("../../../../rounds/futurex/2026-09-09/", import.meta.url);
const questions = JSON.parse(readFileSync(new URL("questions.json", round), "utf8"));
const routes = FutureXRouteOverrideFileSchema.parse(JSON.parse(readFileSync(new URL("routes.json", round), "utf8")));
const asOfUtc = "2026-09-09T00:00:00Z";
const { tasks } = futureXQuestionsToTasks(questions, { revision: routes.revision, roundId: "2026-09-09", asOfUtc, routeOverrides: routes.routes, requireNumericContracts: true });

// Format-only simulation: these are synthetic values, never forecast candidates.
function response(task: ForecastTask): unknown {
  switch (task.kind) {
    case "categorical": return { probabilities: Object.fromEntries(task.choices.map((choice, index) => [choice, Number(index === 0)])) };
    case "ranking": return { ranking: task.candidates.length ? task.candidates : Array.from({ length: task.rankCount }, (_, index) => `Entity ${index + 1}`) };
    case "numeric": return { value: 2, target_field: task.numericContract!.targetField, unit: task.numericContract!.unit };
    case "free_response": return { answer: task.responseFormat === "identifier_set" ? [task.identifierPattern?.includes("CVE") ? "CVE-2026-12345" : "NCT12345678"] : "Example" };
    default: throw new Error(`Unexpected kind in this frozen round: ${task.kind}`);
  }
}

describe("September 9 frozen round", () => {
  it("has 80 reviewed routes, 21 numeric contracts and explicit cardinality for every task", () => {
    expect(tasks).toHaveLength(80);
    for (const task of tasks) expect(() => ForecastTaskSchema.parse(task)).not.toThrow();
    const inventory = analyzeFutureXQuestions(questions, { routeOverrides: routes.routes, asOfUtc });
    expect(inventory.byKind).toEqual({ single_choice: 40, multi_choice: 0, numeric: 21, ranking: 14, open_text: 5 });
    expect(inventory.routeReview.missingNumericContracts).toBe(0);
    expect(inventory.routeReview.approved).toBe(80);
  });

  it("passes an end-to-end 80-question synthetic run through parsing, aggregation and strict serialization", async () => {
    const engine = new ForecastEngine({ model: "synthetic-format-check", generate: async (request: ModelRequest) => ({ content: `<answer>${JSON.stringify(response(request.task))}</answer>`, citations: [] }) });
    const results = await Promise.all(tasks.map((task) => engine.forecast(task, { ...futureXPolicy(asOfUtc), web: "deny" }, { trials: 1 })));
    assertFutureXNumericResults(tasks, results);
    const submission = buildFutureXSubmission(questions, results);
    const report = validateFutureXSubmission(questions, submission, { requireComplete: true, routeOverrides: routes.routes });
    expect(report.errors).toEqual([]);
    expect(report.stats.coverage).toBe(1);
    expect(results.every((result) => !result.fallbackUsed)).toBe(true);
  });

  it("does not confuse entity answers or count buckets with numeric/ranking output", () => {
    const byId = new Map<string, any>(questions.map((q: any) => [q.id.slice(0, 8), q]));
    expect(routeFutureXQuestion(byId.get("4254aa7f"))).toMatchObject({ kind: "single_choice" });
    expect(routeFutureXQuestion(byId.get("356911c3"))).toMatchObject({ kind: "ranking", rankCount: 5 });
    expect(routeFutureXQuestion(byId.get("10fc6b7e"))).toMatchObject({ kind: "open_text" });
    expect(routeFutureXQuestion(byId.get("015307b6"))).toMatchObject({ kind: "open_text" });
  });

  it("votes on exact identifier sets and accepts an empty set without fuzzy matching", () => {
    const task = tasks.find((task) => task.origin.externalId.startsWith("cd393fae"))!;
    const replies = [["NCT12345678", "NCT12345679"], ["NCT12345679", "NCT12345678"], ["NCT12345670"]];
    const trials = replies.map((answer, trial) => ({ trial, answer: parseModelAnswer(task, { content: JSON.stringify({ answer }), citations: [] }), citations: [], rawResponse: "", latencyMs: 0 }));
    expect(aggregateTrialPredictions(task, trials)).toEqual({ kind: "free_response", value: "NCT12345678, NCT12345679" });
    expect(parseModelAnswer(task, { content: '{"answer":[]}', citations: [] })).toEqual({ kind: "free_response", value: "[]" });
    expect(() => parseModelAnswer(task, { content: '{"answer":["NCT1234567"]}', citations: [] })).toThrow(/Invalid identifier/);
  });
});
