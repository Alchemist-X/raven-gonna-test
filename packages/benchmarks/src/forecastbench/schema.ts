import { z } from "zod";

export const FORECASTBENCH_MARKET_SOURCES = ["infer", "manifold", "metaculus", "polymarket"] as const;
export const FORECASTBENCH_DATASET_SOURCES = ["acled", "dbnomics", "fred", "wikipedia", "yfinance"] as const;

export const ForecastBenchMarketSourceSchema = z.enum(FORECASTBENCH_MARKET_SOURCES);
export const ForecastBenchDatasetSourceSchema = z.enum(FORECASTBENCH_DATASET_SOURCES);
export const ForecastBenchSourceSchema = z.union([ForecastBenchMarketSourceSchema, ForecastBenchDatasetSourceSchema]);

export const IsoDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((value) => {
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}, "Invalid ISO calendar date");

const CommonQuestionSchema = z.object({
  id: z.string().min(1),
  source: ForecastBenchSourceSchema,
  question: z.string(),
  resolution_criteria: z.string(),
  background: z.string(),
  market_info_open_datetime: z.string(),
  market_info_close_datetime: z.string(),
  market_info_resolution_criteria: z.string(),
  url: z.string(),
  freeze_datetime: z.string(),
  freeze_datetime_value: z.string(),
  freeze_datetime_value_explanation: z.string(),
  source_intro: z.string()
}).passthrough();

export const ForecastBenchMarketQuestionSchema = CommonQuestionSchema.extend({
  source: ForecastBenchMarketSourceSchema,
  resolution_dates: z.literal("N/A")
});

export const ForecastBenchDatasetQuestionSchema = CommonQuestionSchema.extend({
  source: ForecastBenchDatasetSourceSchema,
  resolution_dates: z.array(IsoDateSchema).min(1)
}).superRefine((question, context) => {
  if (new Set(question.resolution_dates).size !== question.resolution_dates.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["resolution_dates"], message: "Duplicate resolution date" });
  }
});

export const ForecastBenchQuestionSchema = z.union([
  ForecastBenchMarketQuestionSchema,
  ForecastBenchDatasetQuestionSchema
]);

export const ForecastBenchQuestionSetSchema = z.object({
  forecast_due_date: IsoDateSchema,
  question_set: z.string().min(1),
  questions: z.array(ForecastBenchQuestionSchema).min(1)
}).passthrough();

export const ForecastBenchForecastRowSchema = z.object({
  id: z.string().min(1),
  source: ForecastBenchSourceSchema,
  forecast: z.number().finite().min(0).max(1),
  resolution_date: IsoDateSchema.nullable(),
  reasoning: z.string().nullable().optional()
}).strict();

export const ForecastBenchForecastSetSchema = z.object({
  organization: z.string().min(1),
  model: z.string().min(1),
  model_organization: z.string().min(1),
  question_set: z.string().min(1),
  forecasts: z.array(ForecastBenchForecastRowSchema)
}).strict();

export const ForecastBenchMarketSnapshotSchema = z.object({
  schemaVersion: z.literal("raven-gonna-test.forecastbench-market-snapshot.v1"),
  questionSet: z.string().min(1),
  capturedAtUtc: z.string().datetime({ offset: true }),
  quotes: z.array(z.object({
    source: ForecastBenchMarketSourceSchema,
    id: z.string().min(1),
    probability: z.number().finite().min(0).max(1),
    observedAtUtc: z.string().datetime({ offset: true }),
    url: z.string().url().optional()
  }).strict())
}).strict();

export const ForecastBenchResolutionSchema = z.object({
  id: z.string().min(1),
  source: ForecastBenchSourceSchema,
  resolution_date: IsoDateSchema.nullable(),
  outcome: z.union([z.literal(0), z.literal(1), z.null()])
}).strict();

export const ForecastBenchOfficialResolutionRowSchema = z.object({
  id: z.string().min(1),
  source: ForecastBenchSourceSchema,
  direction: z.string().nullable().optional(),
  resolution_date: IsoDateSchema.nullable(),
  resolved_to: z.number().finite(),
  resolved: z.boolean()
}).passthrough();

export const ForecastBenchOfficialResolutionSetSchema = z.object({
  forecast_due_date: IsoDateSchema,
  question_set: z.string().min(1),
  resolutions: z.array(ForecastBenchOfficialResolutionRowSchema)
}).passthrough();

export type ForecastBenchQuestionSet = z.infer<typeof ForecastBenchQuestionSetSchema>;
export type ForecastBenchQuestion = z.infer<typeof ForecastBenchQuestionSchema>;
export type ForecastBenchSource = z.infer<typeof ForecastBenchSourceSchema>;
export type ForecastBenchForecastRow = z.infer<typeof ForecastBenchForecastRowSchema>;
export type ForecastBenchForecastSet = z.infer<typeof ForecastBenchForecastSetSchema>;
export type ForecastBenchMarketSnapshot = z.infer<typeof ForecastBenchMarketSnapshotSchema>;
export type ForecastBenchResolution = z.infer<typeof ForecastBenchResolutionSchema>;
export type ForecastBenchOfficialResolutionSet = z.infer<typeof ForecastBenchOfficialResolutionSetSchema>;
