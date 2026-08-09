import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { ForecastResult } from "@raven-gonna-test/forecast-core";
import {
  analyzeFutureXQuestions,
  buildForecastBenchForecastSet,
  buildFutureXSubmission,
  buildProphetLegacyResponse,
  buildProphetCurrentResponse,
  expandForecastBenchQuestionSet,
  futureXQuestionsToTasks,
  normalizeProphetRequest,
  prophetEventToTasks,
  scoreForecastBenchRaw,
  scoreFutureX,
  selectFutureXQuestions,
  sourceBaseline,
  routeFutureXQuestion,
  validateForecastBenchCoverage,
  validateForecastBenchLiveQuestionSet,
  validateFutureXSubmission,
  validateFutureXResearchSnapshot,
  validateProphetCurrentResponse,
  validateProphetLegacyResponse
} from "./index.js";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const fixture = (name: string): unknown => JSON.parse(readFileSync(`${root}fixtures/${name}`, "utf8"));

function binaryResult(taskId: string, pYes: number): ForecastResult {
  return {
    schemaVersion: "raven-gonna-test.forecast-result.v1",
    taskId,
    answer: { kind: "binary", pYes },
    trials: [],
    model: "mock",
    strategyId: "test",
    policyId: "test",
    generatedAtUtc: "2026-08-16T01:00:00.000Z",
    fallbackUsed: false,
    warnings: []
  };
}

describe("FutureX adapter", () => {
  const questions = fixture("futurex/questions.json");
  const options = {
    revision: "a".repeat(40),
    roundId: "2026-08-12-to-2026-08-18",
    asOfUtc: "2026-08-12T14:00:00.000Z",
    deadlineUtc: "2026-08-12T15:59:00.000Z"
  };

  it("routes all supported task kinds and serializes only id/prediction", () => {
    const { tasks } = futureXQuestionsToTasks(questions, options);
    expect(tasks.map((task) => task.kind)).toEqual(["categorical", "multi_label", "numeric", "ranking"]);
    const answers = [
      { kind: "categorical" as const, choice: "A", probabilities: { A: 0.7, B: 0.3 } },
      { kind: "multi_label" as const, selected: ["A", "C"], probabilities: { A: 0.8, B: 0.1, C: 0.7 } },
      { kind: "numeric" as const, value: 42.5 },
      { kind: "ranking" as const, order: ["B", "A", "C"] }
    ];
    const results = tasks.map((task, index): ForecastResult => ({
      ...binaryResult(task.taskId, 0.5),
      answer: answers[index]!
    }));
    const submission = buildFutureXSubmission(questions, results);
    expect(submission).toEqual([
      { id: "fx-single", prediction: "A" },
      { id: "fx-multi", prediction: "A, C" },
      { id: "fx-number", prediction: "42.5" },
      { id: "fx-ranking", prediction: "B, A, C" }
    ]);
    expect(validateFutureXSubmission(questions, submission, { deadlineUtc: options.deadlineUtc, now: new Date("2026-08-12T15:00:00Z") }).valid).toBe(true);
  });

  it("scores deterministic FutureX types and returns null for unavailable semantics", () => {
    const resolved = [
      { id: "a", prompt: "A or B", end_time: "2026-01-01", level: 1, en_title: "choice", task_type: "single_choice", ground_truth: "A" },
      { id: "b", prompt: "multi", end_time: "2026-01-01", level: 2, en_title: "multi", task_type: "multi_choice", ground_truth: ["A", "B", "C"] },
      { id: "c", prompt: "number", end_time: "2026-01-01", level: 3, en_title: "number", task_type: "numeric", ground_truth: 100 },
      { id: "d", prompt: "rank", end_time: "2026-01-01", level: 4, en_title: "rank", task_type: "ranking", ground_truth: ["A", "B", "C"] }
    ];
    const report = scoreFutureX(resolved, [
      { id: "a", prediction: "A" },
      { id: "b", prediction: "A, B" },
      { id: "c", prediction: "100" },
      { id: "d", prediction: "A, C, B" }
    ]);
    const scores = report.questions.map((row) => row.score);
    expect(scores.slice(0, 3)).toEqual([1, 0.8, 1]);
    expect(scores[3]).toBeCloseTo(0.8);
    expect(report.overall).toBeCloseTo(0.88);
  });

  it("routes current wire patterns for boxed alternatives, open rankings, and numeric values", () => {
    const common = { end_time: "2026-08-18", level: 4 as const };
    const boxed = routeFutureXQuestion({
      ...common,
      id: "boxed",
      en_title: "Winner of the primary",
      prompt: "IMPORTANT: final answer must be \\boxed{Penny Flanagan} or \\boxed{Angie Craig}"
    });
    expect(boxed).toMatchObject({ kind: "single_choice", confidence: 1 });
    expect(boxed.choices.map((choice) => choice.key)).toEqual(["Penny Flanagan", "Angie Craig"]);
    expect(routeFutureXQuestion({
      ...common,
      id: "rank",
      en_title: "Who will be ranked from 13 to 15?",
      prompt: "Give the three names only."
    })).toMatchObject({ kind: "ranking", rankCount: 3 });
    expect(routeFutureXQuestion({
      ...common,
      id: "number",
      en_title: "Cloudflare Q2 revenue (USD millions)",
      prompt: "Return YOUR_PREDICTION."
    }).kind).toBe("numeric");
    for (const title of [
      "what will be the Grain Index of the China Coastal Bulk Freight Index?",
      "what will be the day's close for India Market Fund LOF?",
      "what will be the average price of pork?"
    ]) {
      expect(routeFutureXQuestion({ ...common, id: title, en_title: title, prompt: "Return YOUR_PREDICTION." }).kind).toBe("numeric");
    }
  });

  it("rejects duplicate structured answers and wrong boxed alternatives", () => {
    const question = {
      id: "multi",
      prompt: "Select all that apply.\nA. Alpha\nB. Beta",
      end_time: "2026-08-18",
      level: 2,
      en_title: "Which outcomes occur?"
    };
    expect(validateFutureXSubmission([question], [{ id: "multi", prediction: "A, A" }]).valid).toBe(false);
    const yesNo = {
      id: "yn",
      prompt: "Final answer: \\boxed{Yes} or \\boxed{No}",
      end_time: "2026-08-18",
      level: 1,
      en_title: "Will it happen?"
    };
    expect(validateFutureXSubmission([yesNo], [{ id: "yn", prediction: "Maybe" }]).valid).toBe(false);
  });

  it("reports task mix and keeps generated routes pending until explicitly reviewed", () => {
    const rows = questions as Array<{ id: string }>;
    const routeOverrides = Object.fromEntries(rows.map((row) => [row.id, {
      kind: row.id === "fx-number" ? "numeric" as const :
        row.id === "fx-ranking" ? "ranking" as const :
          row.id === "fx-multi" ? "multi_choice" as const : "single_choice" as const,
      review: { status: "pending" as const }
    }]));
    const report = analyzeFutureXQuestions(questions, {
      routeOverrides,
      asOfUtc: "2026-08-12T14:00:00.000Z"
    });
    expect(report.recordCount).toBe(4);
    expect(report.byKind).toMatchObject({ single_choice: 1, multi_choice: 1, numeric: 1, ranking: 1 });
    expect(report.routeReview.pending).toBe(4);
    expect(report.openAtCutoff).toBe(4);
  });

  it("validates a partial research snapshot without making it submission eligible", () => {
    const snapshot = {
      schemaVersion: "raven-gonna-test.futurex-research-snapshot.v1",
      status: "research_only",
      submissionEligible: false,
      revision: "a".repeat(40),
      asOfUtc: "2026-08-12T14:00:00.000Z",
      generatedAtUtc: "2026-08-12T14:05:00.000Z",
      predictions: [{
        id: "fx-single",
        prediction: "A",
        confidence: 0.7,
        method: "manual_research",
        rationaleSummary: ["Primary source supports A."],
        counterEvidence: ["Outcome remains unresolved."],
        evidence: [{
          title: "Official source",
          url: "https://example.com/source",
          observedAtUtc: "2026-08-12T13:59:00.000Z"
        }]
      }]
    };
    const report = validateFutureXResearchSnapshot(questions, snapshot, { expectedRevision: "a".repeat(40) });
    expect(report.valid).toBe(true);
    expect(report.stats).toMatchObject({ predicted: 1, submissionEligible: false });
    expect(report.warnings).toContain("Research snapshot is not eligible for FutureX submission.");
    expect(() => selectFutureXQuestions(questions, ["fx-single", "fx-single"])).toThrow(/duplicate/i);
  });
});

describe("ForecastBench adapter", () => {
  const questionSet = fixture("forecastbench/question-set.json");

  it("expands dynamic horizons and produces a safe upload", () => {
    const tasks = expandForecastBenchQuestionSet(questionSet);
    expect(tasks).toHaveLength(3);
    expect(tasks[1]?.renderedQuestion).toContain("2026-08-23");
    const results = tasks.map((item, index) => binaryResult(item.task.taskId, [0.8, 0.2, 0.5][index]!));
    const forecastSet = buildForecastBenchForecastSet(questionSet, {
      organization: "Raven",
      model: "foresight-v4",
      modelOrganization: "Lightning Rod Labs"
    }, results);
    const report = validateForecastBenchCoverage(questionSet, forecastSet);
    expect(report.valid).toBe(true);
    const score = scoreForecastBenchRaw(questionSet, forecastSet, [
      { id: "market-1", source: "manifold", resolution_date: null, outcome: 1 },
      { id: "SERIES", source: "fred", resolution_date: "2026-08-23", outcome: 0 },
      { id: "SERIES", source: "fred", resolution_date: "2026-09-16", outcome: 1 }
    ]);
    expect(score.marketBrier).toBeCloseTo(0.04);
    expect(score.datasetBrier).toBeCloseTo((0.04 + 0.25) / 2);
  });

  it("uses source-specific safety baselines", () => {
    const tasks = expandForecastBenchQuestionSet(questionSet);
    expect(sourceBaseline(tasks[0]!).probability).toBe(0.7);
    expect(sourceBaseline(tasks[1]!).probability).toBe(0.42);
  });

  it("rejects truncated fixtures as live and imports the official resolution root schema", () => {
    expect(validateForecastBenchLiveQuestionSet(questionSet).valid).toBe(false);
    const tasks = expandForecastBenchQuestionSet(questionSet);
    const forecastSet = buildForecastBenchForecastSet(questionSet, {
      organization: "Raven",
      model: "baseline",
      modelOrganization: "Raven"
    }, tasks.map((item) => binaryResult(item.task.taskId, 0.5)));
    const score = scoreForecastBenchRaw(questionSet, forecastSet, {
      forecast_due_date: "2026-08-16",
      question_set: "2026-08-16-llm.json",
      resolutions: [
        { id: "market-1", source: "manifold", direction: null, resolution_date: "2026-08-20", resolved_to: 1, resolved: true },
        { id: "SERIES", source: "fred", direction: null, resolution_date: "2026-08-23", resolved_to: 0, resolved: true },
        { id: "SERIES", source: "fred", direction: null, resolution_date: "2026-09-16", resolved_to: 0.4, resolved: false }
      ]
    });
    expect(score.resolvedRows).toBe(2);
  });
});

describe("Prophet Arena adapter", () => {
  const request = fixture("prophet-arena/current-request.json");

  it("preserves exact labels and independent probability geometry", () => {
    const event = normalizeProphetRequest(request, "current");
    const tasks = prophetEventToTasks(event, "2026-08-09T10:00:00.000Z");
    const response = buildProphetCurrentResponse(event, [
      binaryResult(tasks[0]!.taskId, 0.9),
      binaryResult(tasks[1]!.taskId, 0.1)
    ], { residualCap: 0.05 });
    expect(response.probabilities.map((row) => row.market)).toEqual(event.outcomes);
    expect(response.probabilities[0]?.probability).toBeCloseTo(0.65);
    expect(response.probabilities[1]?.probability).toBeCloseTo(0.25);
    expect(validateProphetCurrentResponse(event, response).valid).toBe(true);
  });

  it("projects explicitly exclusive outcomes to a fixed sum", () => {
    const event = normalizeProphetRequest(request, "current");
    const tasks = prophetEventToTasks(event, "2026-08-09T10:00:00.000Z");
    const response = buildProphetCurrentResponse(event, [
      binaryResult(tasks[0]!.taskId, 0.7),
      binaryResult(tasks[1]!.taskId, 0.4)
    ], { residualCap: 0.2, geometry: { kind: "exclusive", sum: 1 } });
    expect(response.probabilities.reduce((sum, row) => sum + row.probability, 0)).toBeCloseTo(1, 10);
  });

  it("encodes the legacy contract as an exact-label simplex", () => {
    const legacy = normalizeProphetRequest({
      event_id: "EVT",
      title: "Legacy event",
      markets: ["YES", "NO"],
      rules: "One outcome wins.",
      market_stats: { YES: { last_price: 0.7 }, NO: { last_price: 0.2 } }
    }, "legacy");
    const response = buildProphetLegacyResponse(legacy, [], { residualCap: 0.05 });
    expect(Object.values(response.prediction).reduce((sum, value) => sum + value, 0)).toBeCloseTo(1, 10);
    expect(validateProphetLegacyResponse(legacy, response).valid).toBe(true);
  });
});
