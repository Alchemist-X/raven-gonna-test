import { z } from "zod";

export const BenchmarkNameSchema = z.enum(["futurex", "forecastbench", "prophet-arena"]);
export type BenchmarkName = z.infer<typeof BenchmarkNameSchema>;

export const TaskOriginSchema = z.object({
  benchmark: BenchmarkNameSchema,
  roundId: z.string().min(1),
  externalId: z.string().min(1),
  source: z.string().min(1).optional()
});

const TaskBaseShape = {
  taskId: z.string().min(1),
  origin: TaskOriginSchema,
  prompt: z.string().min(1),
  asOfUtc: z.string().datetime({ offset: true }),
  deadlineUtc: z.string().datetime({ offset: true }).optional(),
  resolution: z.object({
    criteria: z.string(),
    dateUtc: z.string().datetime({ offset: true }).optional(),
    source: z.string().optional()
  }),
  metadata: z.record(z.unknown()).default({})
} as const;

export const BinaryProbabilityTaskSchema = z.object({
  ...TaskBaseShape,
  kind: z.literal("binary_probability"),
  priorProbability: z.number().min(0).max(1).optional()
});

export const CategoricalTaskSchema = z.object({
  ...TaskBaseShape,
  kind: z.literal("categorical"),
  choices: z.array(z.string().min(1)).min(2)
});

export const MultiLabelTaskSchema = z.object({
  ...TaskBaseShape,
  kind: z.literal("multi_label"),
  choices: z.array(z.string().min(1)).min(1),
  minimumSelections: z.number().int().min(0).default(1),
  maximumSelections: z.number().int().min(1).optional()
});

export const RankingTaskSchema = z.object({
  ...TaskBaseShape,
  kind: z.literal("ranking"),
  candidates: z.array(z.string().min(1)),
  rankCount: z.number().int().min(1)
});

export const NumericTaskSchema = z.object({
  ...TaskBaseShape,
  kind: z.literal("numeric"),
  unit: z.string().optional(),
  minimum: z.number().finite().optional(),
  maximum: z.number().finite().optional()
});

export const FreeResponseTaskSchema = z.object({
  ...TaskBaseShape,
  kind: z.literal("free_response")
});

export const ForecastTaskSchema = z.discriminatedUnion("kind", [
  BinaryProbabilityTaskSchema,
  CategoricalTaskSchema,
  MultiLabelTaskSchema,
  RankingTaskSchema,
  NumericTaskSchema,
  FreeResponseTaskSchema
]).superRefine((task, context) => {
  if (task.kind === "categorical" || task.kind === "multi_label") {
    if (new Set(task.choices).size !== task.choices.length) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["choices"], message: "Choices must be unique" });
    }
  }
  if (task.kind === "multi_label") {
    const maximum = task.maximumSelections ?? task.choices.length;
    if (maximum > task.choices.length || task.minimumSelections > maximum) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["maximumSelections"], message: "Selection bounds exceed available choices" });
    }
  }
  if (task.kind === "ranking") {
    if (new Set(task.candidates).size !== task.candidates.length) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["candidates"], message: "Candidates must be unique" });
    }
    if (task.candidates.length > 0 && task.rankCount > task.candidates.length) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["rankCount"], message: "rankCount exceeds candidate count" });
    }
  }
});

export type BinaryProbabilityTask = z.infer<typeof BinaryProbabilityTaskSchema>;
export type CategoricalTask = z.infer<typeof CategoricalTaskSchema>;
export type MultiLabelTask = z.infer<typeof MultiLabelTaskSchema>;
export type RankingTask = z.infer<typeof RankingTaskSchema>;
export type NumericTask = z.infer<typeof NumericTaskSchema>;
export type FreeResponseTask = z.infer<typeof FreeResponseTaskSchema>;
export type ForecastTask = z.infer<typeof ForecastTaskSchema>;

export const InformationPolicySchema = z.object({
  id: z.string().min(1),
  asOfUtc: z.string().datetime({ offset: true }),
  web: z.enum(["deny", "allow"]),
  predictionMarket: z.enum(["deny", "resolution_metadata_only", "observe", "anchor"]),
  suppliedMarketStats: z.enum(["deny", "observe", "anchor"]),
  financialMarketData: z.enum(["deny", "allow"]),
  postCutoffEvidence: z.literal("reject"),
  allowedDomains: z.array(z.string()).optional(),
  blockedDomains: z.array(z.string()).optional()
});
export type InformationPolicy = z.infer<typeof InformationPolicySchema>;

export const EvidenceRecordSchema = z.object({
  id: z.string().min(1),
  claim: z.string().min(1),
  url: z.string().url(),
  sourceClass: z.enum([
    "primary",
    "press",
    "prediction_market_price",
    "financial_market_data",
    "benchmark_supplied_prior"
  ]),
  use: z.enum(["fact", "prior", "resolution_metadata"]),
  publishedAtUtc: z.string().datetime({ offset: true }).optional(),
  retrievedAtUtc: z.string().datetime({ offset: true }),
  observedValueAtUtc: z.string().datetime({ offset: true }).optional(),
  contentHash: z.string().optional()
});
export type EvidenceRecord = z.infer<typeof EvidenceRecordSchema>;

export const BinaryAnswerSchema = z.object({
  kind: z.literal("binary"),
  pYes: z.number().finite().min(0).max(1)
});

export const CategoricalAnswerSchema = z.object({
  kind: z.literal("categorical"),
  choice: z.string().min(1),
  probabilities: z.record(z.number().finite().min(0).max(1))
});

export const MultiLabelAnswerSchema = z.object({
  kind: z.literal("multi_label"),
  selected: z.array(z.string()),
  probabilities: z.record(z.number().finite().min(0).max(1))
});

export const RankingAnswerSchema = z.object({
  kind: z.literal("ranking"),
  order: z.array(z.string().min(1)),
  scores: z.record(z.number().finite()).optional()
});

export const NumericAnswerSchema = z.object({
  kind: z.literal("numeric"),
  value: z.number().finite(),
  interval: z.tuple([z.number().finite(), z.number().finite()]).optional(),
  unit: z.string().optional()
});

export const FreeResponseAnswerSchema = z.object({
  kind: z.literal("free_response"),
  value: z.string().min(1)
});

export const ForecastAnswerSchema = z.discriminatedUnion("kind", [
  BinaryAnswerSchema,
  CategoricalAnswerSchema,
  MultiLabelAnswerSchema,
  RankingAnswerSchema,
  NumericAnswerSchema,
  FreeResponseAnswerSchema
]);
export type ForecastAnswer = z.infer<typeof ForecastAnswerSchema>;

export const TrialPredictionSchema = z.object({
  trial: z.number().int().min(0),
  answer: ForecastAnswerSchema,
  confidence: z.number().min(0).max(1).optional(),
  rationale: z.string().optional(),
  citations: z.array(z.string().url()).default([]),
  rawResponse: z.string(),
  latencyMs: z.number().nonnegative(),
  usage: z.record(z.unknown()).optional()
});
export type TrialPrediction = z.infer<typeof TrialPredictionSchema>;

export const ForecastResultSchema = z.object({
  schemaVersion: z.literal("raven-gonna-test.forecast-result.v1"),
  taskId: z.string(),
  answer: ForecastAnswerSchema,
  trials: z.array(TrialPredictionSchema),
  model: z.string(),
  strategyId: z.string(),
  policyId: z.string(),
  generatedAtUtc: z.string().datetime({ offset: true }),
  fallbackUsed: z.boolean(),
  warnings: z.array(z.string())
});
export type ForecastResult = z.infer<typeof ForecastResultSchema>;

export interface ModelRequest {
  task: ForecastTask;
  policy: InformationPolicy;
  systemPrompt: string;
  userPrompt: string;
  answerType: "binary" | "continuous" | "multiple_choice" | "free_response" | "auto";
  research: boolean | { sources: string[] };
  reasoningEffort: "low" | "medium" | "high";
}

export interface ModelResponse {
  content: string;
  thinking?: string;
  citations: string[];
  usage?: Record<string, unknown>;
  model?: string;
}

export interface ModelPort {
  readonly model: string;
  generate(request: ModelRequest, signal: AbortSignal): Promise<ModelResponse>;
}

export interface ClockPort {
  now(): Date;
}
