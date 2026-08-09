import {
  ForecastBenchForecastSetSchema,
  FORECASTBENCH_DATASET_SOURCES,
  ForecastBenchOfficialResolutionSetSchema,
  ForecastBenchQuestionSetSchema,
  ForecastBenchResolutionSchema,
  type ForecastBenchSource
} from "./schema.js";
import { expandForecastBenchQuestionSet, forecastBenchKey, validateForecastBenchCoverage } from "./adapter.js";

export function rawBrierIndex(brier: number): number {
  if (!Number.isFinite(brier) || brier < 0 || brier > 1) throw new Error(`Invalid raw Brier score: ${brier}`);
  return (1 - Math.sqrt(brier)) * 100;
}

export function scoreForecastBenchRaw(
  questionSetInput: unknown,
  forecastSetInput: unknown,
  resolutionInput: unknown
) {
  const questionSet = ForecastBenchQuestionSetSchema.parse(questionSetInput);
  const forecastSet = ForecastBenchForecastSetSchema.parse(forecastSetInput);
  const validation = validateForecastBenchCoverage(questionSet, forecastSet);
  const structuralErrors = validation.errors.filter((error) => !error.startsWith("Submission is not 100%"));
  if (structuralErrors.length) throw new Error(structuralErrors.join("\n"));
  const tasks = expandForecastBenchQuestionSet(questionSet);
  const taskByKey = new Map(tasks.map((task) => [task.key, task]));
  const forecastByKey = new Map(
    forecastSet.forecasts.map((row) => [forecastBenchKey(row.source, row.id, row.resolution_date), row.forecast])
  );
  const seen = new Set<string>();
  let resolutionInputs: unknown[];
  if (!Array.isArray(resolutionInput)) {
    const official = ForecastBenchOfficialResolutionSetSchema.parse(resolutionInput);
    if (official.question_set !== questionSet.question_set || official.forecast_due_date !== questionSet.forecast_due_date) {
      throw new Error("Official resolution set does not match the question set/forecast due date.");
    }
    resolutionInputs = official.resolutions.map((row) => ({
      id: row.id,
      source: row.source,
      resolution_date: FORECASTBENCH_DATASET_SOURCES.includes(row.source as never) ? row.resolution_date : null,
      outcome: row.resolved ? row.resolved_to : null
    }));
  } else {
    resolutionInputs = resolutionInput;
  }
  const rows: Array<{
    key: string;
    category: "market" | "dataset";
    source: ForecastBenchSource;
    probability: number;
    outcome: 0 | 1;
    brier: number;
    imputed: boolean;
  }> = [];
  for (const input of resolutionInputs) {
    const resolution = ForecastBenchResolutionSchema.parse(input);
    const key = forecastBenchKey(resolution.source, resolution.id, resolution.resolution_date);
    if (seen.has(key)) throw new Error(`Duplicate resolution: ${key}`);
    seen.add(key);
    const task = taskByKey.get(key);
    if (!task) throw new Error(`Resolution not in question set: ${key}`);
    if (resolution.outcome === null) continue;
    const submitted = forecastByKey.get(key);
    const probability = submitted ?? 0.5;
    rows.push({
      key,
      category: task.category,
      source: task.source,
      probability,
      outcome: resolution.outcome,
      brier: (probability - resolution.outcome) ** 2,
      imputed: submitted === undefined
    });
  }
  const missingResolutionRows = tasks.filter((task) => !seen.has(task.key)).map((task) => task.key);
  if (missingResolutionRows.length > 0) {
    throw new Error(`Resolution input is incomplete; missing ${missingResolutionRows.length} rows (first: ${missingResolutionRows[0]}).`);
  }
  const mean = (values: number[]): number | null =>
    values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
  const marketBrier = mean(rows.filter((row) => row.category === "market").map((row) => row.brier));
  const datasetBrier = mean(rows.filter((row) => row.category === "dataset").map((row) => row.brier));
  const overallBrier = marketBrier !== null && datasetBrier !== null ? (marketBrier + datasetBrier) / 2 : null;
  const bySource = Object.fromEntries(
    [...new Set(rows.map((row) => row.source))].map((source) => [
      source,
      mean(rows.filter((row) => row.source === source).map((row) => row.brier))
    ])
  );
  return {
    scoreKind: "raw-local-not-official-adjusted" as const,
    resolvedRows: rows.length,
    imputedRows: rows.filter((row) => row.imputed).length,
    marketBrier,
    datasetBrier,
    overallBrier,
    marketBrierIndex: marketBrier === null ? null : rawBrierIndex(marketBrier),
    datasetBrierIndex: datasetBrier === null ? null : rawBrierIndex(datasetBrier),
    overallBrierIndex: overallBrier === null ? null : rawBrierIndex(overallBrier),
    bySource,
    rows
  };
}
