import { z } from "zod";

export const FutureXLevelSchema = z.preprocess(
  (value) => typeof value === "string" ? Number(value.trim()) : typeof value === "bigint" ? Number(value) : value,
  z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4)])
);

export const FutureXQuestionSchema = z.object({
  id: z.string().min(1),
  prompt: z.string().min(1),
  end_time: z.string().min(1),
  level: FutureXLevelSchema,
  en_title: z.string().min(1)
}).passthrough();

export const FutureXQuestionsSchema = z.array(FutureXQuestionSchema).min(1);

export const FutureXSubmissionRowSchema = z.object({
  id: z.string().min(1),
  prediction: z.string()
}).strict();

export const FutureXSubmissionSchema = z.array(FutureXSubmissionRowSchema);

export const FutureXResolvedQuestionSchema = FutureXQuestionSchema.extend({
  ground_truth: z.union([z.string(), z.number(), z.array(z.string())]),
  task_type: z.enum(["single_choice", "multi_choice", "numeric", "ranking", "open_text"]).optional(),
  numeric_sigma: z.number().positive().optional()
});

export type FutureXQuestion = z.infer<typeof FutureXQuestionSchema>;
export type FutureXSubmissionRow = z.infer<typeof FutureXSubmissionRowSchema>;
export type FutureXResolvedQuestion = z.infer<typeof FutureXResolvedQuestionSchema>;
export type FutureXLevel = z.infer<typeof FutureXLevelSchema>;

export type FutureXTaskKind = "single_choice" | "multi_choice" | "numeric" | "ranking" | "open_text";

export const FutureXTaskKindSchema = z.enum(["single_choice", "multi_choice", "numeric", "ranking", "open_text"]);
export const FutureXRouteReviewStatusSchema = z.enum(["pending", "approved", "edited"]);
export const FutureXRouteOverrideSchema = z.object({
  kind: FutureXTaskKindSchema,
  choices: z.array(z.object({ key: z.string().min(1), text: z.string().min(1) })).optional(),
  rankCount: z.number().int().min(1).optional(),
  inference: z.object({
    kind: FutureXTaskKindSchema,
    confidence: z.number().min(0).max(1),
    reasons: z.array(z.string().min(1)).min(1)
  }).strict().optional(),
  review: z.object({
    status: FutureXRouteReviewStatusSchema,
    reviewedAtUtc: z.string().datetime({ offset: true }).optional(),
    notes: z.string().max(2_000).optional()
  }).strict().optional()
}).strict();
export const FutureXRouteOverrideFileSchema = z.object({
  schemaVersion: z.literal("raven-gonna-test.futurex-routes.v1"),
  revision: z.string().regex(/^[0-9a-f]{40}$/i),
  routes: z.record(FutureXRouteOverrideSchema)
}).strict();

export type FutureXRouteOverride = z.infer<typeof FutureXRouteOverrideSchema>;
export type FutureXRouteOverrideFile = z.infer<typeof FutureXRouteOverrideFileSchema>;

export const FutureXResearchEvidenceSchema = z.object({
  title: z.string().min(1).max(500),
  url: z.string().url(),
  observedAtUtc: z.string().datetime({ offset: true })
}).strict();

export const FutureXResearchPredictionSchema = z.object({
  id: z.string().min(1),
  prediction: z.string().min(1),
  confidence: z.number().min(0).max(1),
  method: z.enum(["manual_research", "predictor", "ensemble", "baseline"]),
  rationaleSummary: z.array(z.string().min(1).max(1_000)).min(1).max(12),
  counterEvidence: z.array(z.string().min(1).max(1_000)).max(8),
  evidence: z.array(FutureXResearchEvidenceSchema).max(20)
}).strict();

export const FutureXResearchSnapshotSchema = z.object({
  schemaVersion: z.literal("raven-gonna-test.futurex-research-snapshot.v1"),
  status: z.literal("research_only"),
  submissionEligible: z.literal(false),
  revision: z.string().regex(/^[0-9a-f]{40}$/i),
  asOfUtc: z.string().datetime({ offset: true }),
  generatedAtUtc: z.string().datetime({ offset: true }),
  predictions: z.array(FutureXResearchPredictionSchema).min(1)
}).strict();

export type FutureXResearchSnapshot = z.infer<typeof FutureXResearchSnapshotSchema>;

export interface FutureXRoute {
  kind: FutureXTaskKind;
  choices: Array<{ key: string; text: string }>;
  rankCount?: number;
  confidence: number;
  reasons: string[];
}
