import { z } from "zod";

export const ProphetMarketStatsSchema = z.object({
  last_price: z.number().finite().min(0).max(1).nullable().optional(),
  yes_ask: z.number().finite().min(0).max(1).nullable().optional(),
  no_ask: z.number().finite().min(0).max(1).nullable().optional()
}).passthrough();

const EventIdSchema = z.string().trim().min(1).max(512);
const TitleSchema = z.string().trim().min(1).max(8_192);
const RulesSchema = z.string().max(128 * 1024).nullable().optional();
const CloseTimeSchema = z.string().datetime({ offset: true }).optional();
const OutcomeSchema = z.string().trim().min(1).max(2_048);
const OutcomesSchema = z.array(OutcomeSchema).min(1).max(100);

export const ProphetCurrentRequestSchema = z.object({
  event_ticker: EventIdSchema,
  title: TitleSchema,
  category: z.string().max(512).optional().default("unknown"),
  rules: RulesSchema,
  close_time: CloseTimeSchema,
  outcomes: OutcomesSchema,
  resolved_outcome: z.unknown().nullable().optional(),
  market_stats: z.record(ProphetMarketStatsSchema),
  market_ticker: z.string().optional(),
  subtitle: z.string().nullable().optional(),
  description: z.string().nullable().optional()
}).passthrough().superRefine((value, context) => {
  if (new Set(value.outcomes).size !== value.outcomes.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["outcomes"], message: "Duplicate outcome label" });
  }
});

export const ProphetLegacyRequestSchema = z.object({
  event_id: EventIdSchema,
  title: TitleSchema,
  category: z.string().max(512).optional(),
  rules: RulesSchema,
  close_time: CloseTimeSchema,
  markets: OutcomesSchema,
  market_stats: z.record(ProphetMarketStatsSchema)
}).passthrough().superRefine((value, context) => {
  if (new Set(value.markets).size !== value.markets.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["markets"], message: "Duplicate market label" });
  }
});

export const ProphetCurrentResponseSchema = z.object({
  probabilities: z.array(z.object({
    market: z.string().min(1),
    probability: z.number().finite().min(0).max(1)
  }).strict()).min(1)
}).strict();

export const ProphetLegacyResponseSchema = z.object({
  event_id: z.string().min(1),
  prediction: z.record(z.number().finite().min(0).max(1)),
  rationale: z.string()
}).strict();

export type ProphetMarketStats = z.infer<typeof ProphetMarketStatsSchema>;
export type ProphetCurrentRequest = z.infer<typeof ProphetCurrentRequestSchema>;
export type ProphetLegacyRequest = z.infer<typeof ProphetLegacyRequestSchema>;
export type ProphetCurrentResponse = z.infer<typeof ProphetCurrentResponseSchema>;
export type ProphetLegacyResponse = z.infer<typeof ProphetLegacyResponseSchema>;
export type ProphetWireMode = "current" | "legacy" | "auto";

export interface CanonicalProphetEvent {
  wireVersion: "current" | "legacy";
  eventId: string;
  title: string;
  category: string | null;
  rules: string | null;
  closeTime: string | null;
  outcomes: string[];
  resolvedOutcome: unknown | null;
  marketStats: Record<string, ProphetMarketStats>;
}

export type ProphetGeometry =
  | { kind: "independent" }
  | { kind: "exclusive"; sum: number }
  | { kind: "threshold_ladder"; direction: "nonIncreasing" | "nonDecreasing" };
