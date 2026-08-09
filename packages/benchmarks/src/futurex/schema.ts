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
export const FutureXRouteOverrideSchema = z.object({
  kind: FutureXTaskKindSchema,
  choices: z.array(z.object({ key: z.string().min(1), text: z.string().min(1) })).optional(),
  rankCount: z.number().int().min(1).optional()
}).strict();
export const FutureXRouteOverrideFileSchema = z.object({
  schemaVersion: z.literal("raven-gonna-test.futurex-routes.v1"),
  revision: z.string().regex(/^[0-9a-f]{40}$/i),
  routes: z.record(FutureXRouteOverrideSchema)
}).strict();

export type FutureXRouteOverride = z.infer<typeof FutureXRouteOverrideSchema>;
export type FutureXRouteOverrideFile = z.infer<typeof FutureXRouteOverrideFileSchema>;

export interface FutureXRoute {
  kind: FutureXTaskKind;
  choices: Array<{ key: string; text: string }>;
  rankCount?: number;
  confidence: number;
  reasons: string[];
}
