import type { ForecastResult, ForecastTask } from "@raven-gonna-test/forecast-core";
import { forecastBenchDatasetPolicy, forecastBenchMarketPolicy } from "@raven-gonna-test/forecast-core";
import type { ValidationReport } from "../contract.js";
import {
  FORECASTBENCH_DATASET_SOURCES,
  ForecastBenchForecastSetSchema,
  ForecastBenchQuestionSetSchema,
  type ForecastBenchForecastRow,
  type ForecastBenchForecastSet,
  type ForecastBenchQuestion,
  type ForecastBenchQuestionSet,
  type ForecastBenchSource
} from "./schema.js";

export type ForecastBenchCategory = "market" | "dataset";

export interface ForecastBenchExpandedTask {
  key: string;
  category: ForecastBenchCategory;
  source: ForecastBenchSource;
  id: string;
  resolutionDate: string | null;
  forecastDueDate: string;
  renderedQuestion: string;
  question: ForecastBenchQuestion;
  task: ForecastTask;
}

export function forecastBenchKey(source: string, id: string, resolutionDate: string | null): string {
  return JSON.stringify([source, id, resolutionDate]);
}

export function forecastBenchQuestionKey(source: string, id: string): string {
  return JSON.stringify([source, id]);
}

function renderQuestion(template: string, dueDate: string, resolutionDate: string): string {
  return template
    .split("{forecast_due_date}").join(dueDate)
    .split("{resolution_date}").join(resolutionDate);
}

function openingUtc(dueDate: string): string {
  return `${dueDate}T00:00:00.000Z`;
}

function deadlineUtc(dueDate: string): string {
  return `${dueDate}T23:59:59.000Z`;
}

function internalTask(
  set: ForecastBenchQuestionSet,
  question: ForecastBenchQuestion,
  renderedQuestion: string,
  resolutionDate: string | null,
  actualAsOfUtc: string
): ForecastTask {
  const prior = Number(question.freeze_datetime_value);
  const key = forecastBenchKey(question.source, question.id, resolutionDate);
  const isDataset = FORECASTBENCH_DATASET_SOURCES.includes(question.source as never);
  const resolution: ForecastTask["resolution"] = {
    criteria: question.resolution_criteria || question.market_info_resolution_criteria,
    source: question.url
  };
  if (resolutionDate) resolution.dateUtc = `${resolutionDate}T23:59:59.000Z`;
  return {
    taskId: `forecastbench:${set.question_set}:${key}`,
    origin: {
      benchmark: "forecastbench",
      roundId: set.forecast_due_date,
      externalId: question.id,
      source: question.source
    },
    kind: "binary_probability",
    prompt: [question.source_intro, renderedQuestion, question.background].filter(Boolean).join("\n\n"),
    asOfUtc: actualAsOfUtc,
    deadlineUtc: deadlineUtc(set.forecast_due_date),
    resolution,
    ...(!isDataset && Number.isFinite(prior) && prior >= 0 && prior <= 1 ? { priorProbability: prior } : {}),
    metadata: {
      forecastKey: key,
      category: isDataset ? "dataset" : "market",
      resolutionDate,
      freezeDatetime: question.freeze_datetime,
      freezeValue: question.freeze_datetime_value,
      url: question.url
    }
  };
}

export function expandForecastBenchQuestionSet(
  input: unknown,
  options: { asOfUtc?: string; marketPriorByQuestion?: ReadonlyMap<string, number> } = {}
): ForecastBenchExpandedTask[] {
  const set = ForecastBenchQuestionSetSchema.parse(input);
  const actualAsOfUtc = options.asOfUtc ?? openingUtc(set.forecast_due_date);
  const parsedAsOf = new Date(actualAsOfUtc);
  if (!Number.isFinite(parsedAsOf.getTime())) throw new Error(`Invalid ForecastBench as-of timestamp: ${actualAsOfUtc}`);
  const seenQuestions = new Set<string>();
  const tasks: ForecastBenchExpandedTask[] = [];
  for (const question of set.questions) {
    const qKey = forecastBenchQuestionKey(question.source, question.id);
    if (seenQuestions.has(qKey)) throw new Error(`Duplicate ForecastBench question: ${qKey}`);
    seenQuestions.add(qKey);
    if (question.resolution_dates === "N/A") {
      const key = forecastBenchKey(question.source, question.id, null);
      const task = internalTask(set, question, question.question, null, parsedAsOf.toISOString());
      const fresh = options.marketPriorByQuestion?.get(forecastBenchQuestionKey(question.source, question.id));
      if (fresh !== undefined) {
        if (!Number.isFinite(fresh) || fresh < 0 || fresh > 1) throw new Error(`Invalid fresh market prior for ${qKey}.`);
        if (task.kind !== "binary_probability") throw new Error(`Internal ForecastBench task is not binary: ${qKey}.`);
        task.priorProbability = fresh;
        task.metadata.marketPriorSource = "fresh-snapshot";
      }
      tasks.push({
        key,
        category: "market",
        source: question.source,
        id: question.id,
        resolutionDate: null,
        forecastDueDate: set.forecast_due_date,
        renderedQuestion: question.question,
        question,
        task
      });
    } else {
      for (const date of question.resolution_dates) {
        const rendered = renderQuestion(question.question, set.forecast_due_date, date);
        const key = forecastBenchKey(question.source, question.id, date);
        tasks.push({
          key,
          category: "dataset",
          source: question.source,
          id: question.id,
          resolutionDate: date,
          forecastDueDate: set.forecast_due_date,
          renderedQuestion: rendered,
          question,
          task: internalTask(set, question, rendered, date, parsedAsOf.toISOString())
        });
      }
    }
  }
  return tasks;
}

export function validateForecastBenchLiveQuestionSet(input: unknown): ValidationReport {
  const set = ForecastBenchQuestionSetSchema.parse(input);
  const market = set.questions.filter((question) => question.resolution_dates === "N/A").length;
  const dataset = set.questions.length - market;
  const errors: string[] = [];
  if (set.questions.length !== 500) errors.push(`Live question set must contain 500 questions; got ${set.questions.length}.`);
  if (market !== 250) errors.push(`Live question set must contain 250 market questions; got ${market}.`);
  if (dataset !== 250) errors.push(`Live question set must contain 250 dataset questions; got ${dataset}.`);
  if (set.question_set !== `${set.forecast_due_date}-llm.json`) {
    errors.push(`question_set must equal ${set.forecast_due_date}-llm.json; got ${set.question_set}.`);
  }
  return {
    valid: errors.length === 0,
    errors,
    warnings: [],
    stats: { total: set.questions.length, market, dataset }
  };
}

export interface ForecastBenchMeta {
  organization: string;
  model: string;
  modelOrganization: string;
}

export function buildForecastBenchForecastSet(
  questionSetInput: unknown,
  meta: ForecastBenchMeta,
  results: readonly ForecastResult[],
  options: { allowMissing?: boolean } = {}
): ForecastBenchForecastSet {
  const questionSet = ForecastBenchQuestionSetSchema.parse(questionSetInput);
  const expanded = expandForecastBenchQuestionSet(questionSet);
  const byTaskId = new Map<string, ForecastResult>();
  for (const result of results) {
    if (byTaskId.has(result.taskId)) throw new Error(`Duplicate ForecastBench result: ${result.taskId}`);
    byTaskId.set(result.taskId, result);
  }
  const forecasts: ForecastBenchForecastRow[] = [];
  for (const item of expanded) {
    const result = byTaskId.get(item.task.taskId);
    if (!result) {
      if (!options.allowMissing) throw new Error(`Missing ForecastBench result: ${item.key}`);
      continue;
    }
    if (result.answer.kind !== "binary") throw new Error(`ForecastBench requires a binary result: ${item.key}`);
    forecasts.push({
      id: item.id,
      source: item.source,
      forecast: result.answer.pYes,
      resolution_date: item.resolutionDate,
      reasoning: null
    });
  }
  return ForecastBenchForecastSetSchema.parse({
    organization: meta.organization,
    model: meta.model,
    model_organization: meta.modelOrganization,
    question_set: questionSet.question_set,
    forecasts
  });
}

interface CoverageBucket {
  expectedRows: number;
  presentRows: number;
  rowRate: number;
  expectedQuestions: number;
  completeQuestions: number;
  completeQuestionRate: number;
}

export function validateForecastBenchCoverage(
  questionSetInput: unknown,
  forecastSetInput: unknown,
  minimum = 0.95
): ValidationReport & { market: CoverageBucket; dataset: CoverageBucket } {
  const questionSet = ForecastBenchQuestionSetSchema.parse(questionSetInput);
  const parsedForecast = ForecastBenchForecastSetSchema.safeParse(forecastSetInput);
  const errors: string[] = [];
  if (!parsedForecast.success) {
    const empty: CoverageBucket = {
      expectedRows: 0,
      presentRows: 0,
      rowRate: 0,
      expectedQuestions: 0,
      completeQuestions: 0,
      completeQuestionRate: 0
    };
    return {
      valid: false,
      errors: parsedForecast.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`),
      warnings: [],
      stats: {},
      market: empty,
      dataset: empty
    };
  }
  const forecastSet = parsedForecast.data;
  if (forecastSet.question_set !== questionSet.question_set) errors.push("Forecast set points to the wrong question_set.");
  const expanded = expandForecastBenchQuestionSet(questionSet);
  const expected = new Map(expanded.map((task) => [task.key, task]));
  const submitted = new Set<string>();
  for (const row of forecastSet.forecasts) {
    const key = forecastBenchKey(row.source, row.id, row.resolution_date);
    if (!expected.has(key)) errors.push(`Unexpected forecast row: ${key}`);
    if (submitted.has(key)) errors.push(`Duplicate forecast row: ${key}`);
    submitted.add(key);
  }
  function calculate(category: ForecastBenchCategory): CoverageBucket {
    const selected = expanded.filter((task) => task.category === category);
    const grouped = new Map<string, string[]>();
    for (const task of selected) {
      const key = forecastBenchQuestionKey(task.source, task.id);
      grouped.set(key, [...(grouped.get(key) ?? []), task.key]);
    }
    const presentRows = selected.filter((task) => submitted.has(task.key)).length;
    const completeQuestions = [...grouped.values()].filter((keys) => keys.every((key) => submitted.has(key))).length;
    return {
      expectedRows: selected.length,
      presentRows,
      rowRate: selected.length ? presentRows / selected.length : 0,
      expectedQuestions: grouped.size,
      completeQuestions,
      completeQuestionRate: grouped.size ? completeQuestions / grouped.size : 0
    };
  }
  const market = calculate("market");
  const dataset = calculate("dataset");
  const rates = [market.rowRate, market.completeQuestionRate, dataset.rowRate, dataset.completeQuestionRate];
  const eligible = errors.length === 0 && rates.every((rate) => rate >= minimum);
  const safe = errors.length === 0 && rates.every((rate) => rate === 1);
  if (!safe) errors.push("Submission is not 100% complete; raven-gonna-test defaults to fail-closed upload readiness.");
  return {
    valid: safe,
    errors,
    warnings: eligible && !safe ? ["Meets the 95% eligibility-like threshold but is not safe for upload."] : [],
    stats: {
      leaderboardEligibleLike: eligible,
      safeToUpload: safe,
      expectedRows: expanded.length,
      submittedRows: submitted.size
    },
    market,
    dataset
  };
}

export function policyForForecastBenchTask(task: ForecastTask) {
  const category = task.metadata.category;
  return category === "market" ? forecastBenchMarketPolicy(task.asOfUtc) : forecastBenchDatasetPolicy(task.asOfUtc);
}

export async function fetchForecastBenchQuestionSet(
  questionSetName: string,
  fetchFn: typeof fetch = fetch
): Promise<ForecastBenchQuestionSet> {
  if (!/^\d{4}-\d{2}-\d{2}-llm\.json$/.test(questionSetName)) {
    throw new Error("ForecastBench question set must be a dated YYYY-MM-DD-llm.json file.");
  }
  const url = `https://raw.githubusercontent.com/forecastingresearch/forecastbench-datasets/main/datasets/question_sets/${questionSetName}`;
  const response = await fetchFn(url);
  if (!response.ok) throw new Error(`ForecastBench fetch failed: HTTP ${response.status}`);
  return ForecastBenchQuestionSetSchema.parse(await response.json());
}
