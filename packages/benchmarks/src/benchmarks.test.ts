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
  isCountQuestion,
  normalizeProphetRequest,
  numericTargetField,
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

  it("drops commas inside ranking entities so the official comma split keeps the cardinality", () => {
    const id = "comma-rank";
    const question = {
      id,
      prompt: "Return the top five titles in order.",
      end_time: "2026-09-01T23:59:59+08:00",
      level: 4 as const,
      en_title: "Billboard top five titles"
    };
    const result: ForecastResult = {
      ...binaryResult(`futurex:${"a".repeat(40)}:${id}`, 0.5),
      answer: {
        kind: "ranking",
        order: ["Boston", "Choosin' Texas", "I Knew It, I Knew You", "Been By Now", "Second Wind"]
      }
    };
    const submission = buildFutureXSubmission([question], [result]);
    expect(submission[0]?.prediction).toBe("Boston, Choosin' Texas, I Knew It I Knew You, Been By Now, Second Wind");
    // What the official extractor does: a raw split on commas must still yield five items.
    expect(submission[0]!.prediction.split(",").map((part) => part.trim())).toHaveLength(5);
    expect(validateFutureXSubmission([question], submission).valid).toBe(true);
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

  it("trusts an explicit numeric output contract over title phrasing", () => {
    const common = { end_time: "2026-08-19", level: 4 as const };
    // "what exact <rate> will X report" is the dominant phrasing in this round
    // and matches none of NUMERIC_PATTERN's domain nouns; the prompt's own
    // contract does. Routed as free text these are aggregated by exact-string
    // vote and tie-broken alphabetically, which decides them at random.
    const route = routeFutureXQuestion({
      ...common,
      id: "cpi",
      en_title: "South Africa July 2026 CPI: what exact year-on-year headline consumer inflation rate will be reported?",
      prompt:
        "Return only the exact published numeric value for headline_cpi_yoy_percent. Do not include units.\n" +
        "IMPORTANT: Your final answer MUST end with exactly one boxed numeric value."
    });
    expect(route).toMatchObject({ kind: "numeric", confidence: 0.97 });

    // Questions with no such declaration must still route by the old heuristics.
    expect(routeFutureXQuestion({
      ...common,
      id: "runs",
      en_title: "How many combined runs will be scored in White Sox at Cubs?",
      prompt: "Return YOUR_PREDICTION."
    }).kind).toBe("numeric");
  });

  it("routes 'what exact <measurement>' to numeric even with a generic boxed envelope", () => {
    const common = { end_time: "2026-08-21", level: 4 as const };
    // These carry only \\boxed{YOUR_PREDICTION}, so the explicit-contract
    // pattern misses them. Left as free text they emit prose the grader scores
    // 0 on — one shipped as "Composite CPI +2.1% year-on-year (Census...".
    for (const title of [
      "Hong Kong's July 2026 CPI release: what exact year-on-year change will the Composite CPI report?",
      "HMRC's 21 August 2026 receipts release: what exact total HMRC cash receipts will it report?",
      "Hungary's Monetary Council decision: what exact central-bank base rate will it set?"
    ]) {
      expect(routeFutureXQuestion({ ...common, id: title, en_title: title, prompt: "IMPORTANT: end with \\boxed{YOUR_PREDICTION}" }).kind).toBe("numeric");
    }
    // An entity question that also says "what exact" must stay open text.
    expect(routeFutureXQuestion({
      ...common,
      id: "film",
      en_title: "What exact film will the festival announce as its opening selection?",
      prompt: "IMPORTANT: end with \\boxed{YOUR_PREDICTION}"
    }).kind).toBe("open_text");
  });

  it("routes the 2026-08-26 source-native wire format without flattening lists into numerics", () => {
    const common = { end_time: "2026-09-01", level: 4 as const };
    const prompt = (title: string) =>
      `The event to be predicted: "${title}"\n` +
      "Return exactly the source-native value required by the settlement contract, with no units or commentary.";
    for (const title of [
      "U.S. job openings — July 2026 JOLTS",
      "Utility patents issued in the USPTO Official Gazette dated 1 September 2026",
      "Australia total construction work done — June quarter 2026"
    ]) {
      expect(routeFutureXQuestion({ ...common, id: title, en_title: title, prompt: prompt(title) })).toMatchObject({
        kind: "numeric"
      });
    }
    for (const [title, rankCount] of [
      ["Box Office Mojo Domestic Weekend 35 top five film titles", 5],
      ["La Vuelta 2026 official general-classification top ten after Stage 9", 10],
      ["Official winners of the six UFC Shanghai main-card bouts", 6]
    ] as const) {
      expect(routeFutureXQuestion({ ...common, id: title, en_title: title, prompt: prompt(title) })).toMatchObject({
        kind: "ranking",
        rankCount
      });
    }
  });

  it("does not call a question a ranking when there is nothing to order", () => {
    const common = { end_time: "2026-08-19", level: 3 as const };
    // "ranking" here is a noun for the standings, not an instruction to order.
    // With neither a rank count nor candidates this used to route to ranking and
    // then throw in task building, taking the entire run down with it.
    const route = routeFutureXQuestion({
      ...common,
      id: "esports",
      en_title: "Which club will be first in the final 2026 Esports World Cup Club Championship ranking?",
      prompt: "IMPORTANT: Your final answer MUST end with exactly one \\boxed{YOUR_PREDICTION}."
    });
    expect(route.kind).not.toBe("ranking");
    expect(route.kind).toBe("open_text");

    // A genuine ranking request is unaffected.
    expect(routeFutureXQuestion({
      ...common,
      id: "rank-real",
      en_title: "Who will be ranked from 1 to 3?",
      prompt: "Give the three names in order."
    })).toMatchObject({ kind: "ranking", rankCount: 3 });
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

describe("FutureX open-text submission validation", () => {
  const question = {
    id: "ot1",
    prompt: "Who will win? IMPORTANT: end with \\boxed{YOUR_PREDICTION}",
    end_time: "2026-08-24",
    level: 3 as const,
    en_title: "Who will win the race?"
  };

  const check = (prediction: string) =>
    validateFutureXSubmission([question], [{ id: "ot1", prediction }], { requireComplete: true });

  it("accepts a bare entity name", () => {
    expect(check("Kyle Larson").valid).toBe(true);
    // A slash can be part of one official bilingual/alias answer; it is not a
    // candidate-list separator.
    expect(check("Geister / Ghost Song").valid).toBe(true);
  });

  it("rejects packed candidates and flags the 2026-08-19 AFL regression for cardinality review", () => {
    for (const prediction of [
      "St Kilda v Gold Coast | Carlton v Fremantle | Essendon v Port Adelaide",
      "St Kilda v Gold Coast; Essendon v Port Adelaide",
      "St Kilda v Gold Coast\nEssendon v Port Adelaide",
      '["St Kilda v Gold Coast", "Essendon v Port Adelaide"]'
    ]) {
      const report = check(prediction);
      expect(report.valid).toBe(false);
      expect(report.errors.join("\n")).toMatch(/packs multiple candidates/i);
    }

    const aflQuestion = {
      ...question,
      id: "25cd695a325d2ab9b3474844",
      en_title: "Which AFL Round 24 fixtures will be decided by 12 points or fewer?"
    };
    expect(routeFutureXQuestion(aflQuestion)).toMatchObject({
      kind: "open_text",
      confidence: 0.55,
      reasons: ["open-ended multi-answer wording requires explicit answer-cardinality review"]
    });
  });

  it("rejects prose, which the grader scores 0 on an exact-string comparison", () => {
    // Real submitted values from a live run before this check existed.
    expect(check("Composite CPI +2.1% year-on-year (Census and Statistics Dept)").valid).toBe(false);
    expect(check("Approximately £92 billion in total HMRC receipts").valid).toBe(false);
    expect(check("MAS Core Inflation (YoY, July 2026): about 1.2%").valid).toBe(false);
  });

  it("rejects a hedge, since abstaining scores the same as a wrong guess", () => {
    expect(check("Not yet publicly confirmed as of Aug 18, 2026").valid).toBe(false);
    expect(check("unknown").valid).toBe(false);
    expect(check("To be announced").valid).toBe(false);
  });
});

describe("FutureX prose-unit wire format (2026-09-02)", () => {
  const base = {
    id: "0794938eee8080b862598e67",
    end_time: "2026-09-02T23:30:00+08:00",
    level: 3,
    en_title: "What U.S. commercial crude-oil stock level will EIA report for the week ending 28 August 2026?",
    prompt:
      "You are an agent that can predict future events. The event to be predicted: \"What U.S. commercial crude-oil stock level will EIA report for the week ending 28 August 2026? (resolved around 2026-09-02T23:30:00+08:00 (GMT+8)).\"\n" +
      "Return exactly the source-native value required by the settlement contract, with no units or commentary.\n" +
      "Report the value in thousand barrels.\n" +
      "IMPORTANT: End with \\boxed{YOUR_PREDICTION}."
  };
  const options = { revision: "c8fcda646d7186ffcdff745b10862a116f9df36e", roundId: "2026-09-02", asOfUtc: "2026-09-02T08:00:00.000Z" };

  it("carries the prose unit sentence onto the task as its unit", () => {
    expect(numericTargetField(base.prompt)).toBe("thousand barrels");
    const { tasks } = futureXQuestionsToTasks([base], options);
    expect(tasks[0]).toMatchObject({ kind: "numeric", unit: "thousand barrels" });
    expect((tasks[0] as { integerValued?: boolean }).integerValued).toBeUndefined();
    expect(numericTargetField("Return only the exact published numeric value for revenue_usd_millions.")).toBe("revenue_usd_millions");
  });

  it("marks a prose count unit and a 'total runs' title as integer-valued, but not a scaled unit", () => {
    expect(isCountQuestion("How many filtered wind reports will NOAA SPC list?", "filtered wind reports")).toBe(true);
    expect(isCountQuestion("What cumulative number of cases will ECDC state?", "cases")).toBe(true);
    expect(isCountQuestion("What exact total runs will the Yankees and Angels score in MLB game 823983?")).toBe(true);
    expect(isCountQuestion("What U.S. goods-and-services trade deficit will BEA report?", "USD billion")).toBe(false);
    expect(isCountQuestion("What current-account balance will Japan report?", "JPY 100 million")).toBe(false);
    const counted = futureXQuestionsToTasks([{ ...base, id: "c5b37f70132c134c0d1f0f41", en_title: "How many filtered wind reports will NOAA SPC list for the convective day of 5 September 2026?", prompt: base.prompt.replace("thousand barrels", "filtered wind reports") }], options).tasks[0];
    expect(counted).toMatchObject({ kind: "numeric", unit: "filtered wind reports", integerValued: true });
  });
});
