import type { ValidationReport } from "../contract.js";
import { futureXEndTimeUtc, routeFutureXQuestion, validateFutureXSubmission } from "./adapter.js";
import {
  FutureXQuestionsSchema,
  FutureXResearchSnapshotSchema,
  type FutureXLevel,
  type FutureXQuestion,
  type FutureXRouteOverride,
  type FutureXTaskKind
} from "./schema.js";

const LEVEL_WEIGHTS: Record<FutureXLevel, number> = { 1: 0.1, 2: 0.2, 3: 0.3, 4: 0.4 };

export interface FutureXInventoryRow {
  id: string;
  title: string;
  level: FutureXLevel;
  endTime: string;
  endTimeUtc: string | null;
  inferredKind: FutureXTaskKind;
  effectiveKind: FutureXTaskKind;
  inferredConfidence: number;
  inferredReasons: string[];
  reviewStatus: "missing" | "pending" | "approved" | "edited";
  openAtCutoff: boolean | null;
  theoreticalOverallWeight: number;
}

export function analyzeFutureXQuestions(
  questionsInput: unknown,
  options: { routeOverrides?: Record<string, FutureXRouteOverride>; asOfUtc?: string } = {}
) {
  const questions = FutureXQuestionsSchema.parse(questionsInput);
  const asOfMs = options.asOfUtc === undefined ? undefined : new Date(options.asOfUtc).getTime();
  if (asOfMs !== undefined && !Number.isFinite(asOfMs)) throw new Error("FutureX inventory as-of must be a valid timestamp.");
  const levelCounts = new Map<FutureXLevel, number>();
  for (const question of questions) levelCounts.set(question.level, (levelCounts.get(question.level) ?? 0) + 1);
  const rows: FutureXInventoryRow[] = questions.map((question) => {
    const inferred = routeFutureXQuestion(question);
    const override = options.routeOverrides?.[question.id];
    const effective = override ? routeFutureXQuestion(question, override) : inferred;
    const endUtc = futureXEndTimeUtc(question.end_time);
    const endMs = endUtc ? new Date(endUtc).getTime() : Number.NaN;
    return {
      id: question.id,
      title: question.en_title,
      level: question.level,
      endTime: question.end_time,
      endTimeUtc: endUtc ?? null,
      inferredKind: inferred.kind,
      effectiveKind: effective.kind,
      inferredConfidence: inferred.confidence,
      inferredReasons: inferred.reasons,
      reviewStatus: override?.review?.status ?? (override ? "pending" : "missing"),
      openAtCutoff: asOfMs === undefined || !Number.isFinite(endMs) ? null : asOfMs < endMs,
      theoreticalOverallWeight: LEVEL_WEIGHTS[question.level] / (levelCounts.get(question.level) ?? 1)
    };
  });
  const byKind = Object.fromEntries(
    (["single_choice", "multi_choice", "numeric", "ranking", "open_text"] as const)
      .map((kind) => [kind, rows.filter((row) => row.effectiveKind === kind).length])
  );
  const byLevel = Object.fromEntries(([1, 2, 3, 4] as const).map((level) => {
    const levelRows = rows.filter((row) => row.level === level);
    return [level, {
      count: levelRows.length,
      overallWeight: LEVEL_WEIGHTS[level],
      perQuestionWeight: levelRows.length === 0 ? 0 : LEVEL_WEIGHTS[level] / levelRows.length
    }];
  }));
  return {
    schemaVersion: "raven-gonna-test.futurex-inventory.v1" as const,
    asOfUtc: options.asOfUtc ?? null,
    recordCount: rows.length,
    byKind,
    byLevel,
    openAtCutoff: rows.filter((row) => row.openAtCutoff === true).length,
    closedAtCutoff: rows.filter((row) => row.openAtCutoff === false).length,
    routeReview: {
      approved: rows.filter((row) => row.reviewStatus === "approved" || row.reviewStatus === "edited").length,
      pending: rows.filter((row) => row.reviewStatus === "pending").length,
      missing: rows.filter((row) => row.reviewStatus === "missing").length,
      lowConfidence: rows.filter((row) => row.inferredConfidence < 0.8).length
    },
    rows
  };
}

export function selectFutureXQuestions(
  questionsInput: unknown,
  ids: readonly string[]
): FutureXQuestion[] {
  const questions = FutureXQuestionsSchema.parse(questionsInput);
  if (ids.length === 0) throw new Error("FutureX pilot selection must contain at least one id.");
  const unique = new Set(ids);
  if (unique.size !== ids.length) throw new Error("FutureX pilot selection contains duplicate ids.");
  const byId = new Map(questions.map((question) => [question.id, question]));
  const unknown = ids.filter((id) => !byId.has(id));
  if (unknown.length > 0) throw new Error(`Unknown FutureX pilot ids: ${unknown.join(", ")}`);
  return ids.map((id) => byId.get(id)!);
}

export function validateFutureXResearchSnapshot(
  questionsInput: unknown,
  snapshotInput: unknown,
  options: { expectedRevision?: string; routeOverrides?: Record<string, FutureXRouteOverride> } = {}
): ValidationReport {
  const questions = FutureXQuestionsSchema.parse(questionsInput);
  const snapshot = FutureXResearchSnapshotSchema.parse(snapshotInput);
  const errors: string[] = [];
  const warnings: string[] = ["Research snapshot is not eligible for FutureX submission."];
  if (options.expectedRevision && snapshot.revision.toLowerCase() !== options.expectedRevision.toLowerCase()) {
    errors.push(`Snapshot revision ${snapshot.revision} does not match ${options.expectedRevision}.`);
  }
  const asOfMs = new Date(snapshot.asOfUtc).getTime();
  const generatedMs = new Date(snapshot.generatedAtUtc).getTime();
  if (generatedMs < asOfMs) errors.push("Snapshot generatedAtUtc cannot be earlier than asOfUtc.");
  const byId = new Map(questions.map((question) => [question.id, question]));
  const seen = new Set<string>();
  let pendingRoutes = 0;
  for (const row of snapshot.predictions) {
    if (seen.has(row.id)) {
      errors.push(`Duplicate research prediction id: ${row.id}`);
      continue;
    }
    seen.add(row.id);
    const question = byId.get(row.id);
    if (!question) {
      errors.push(`Unknown research prediction id: ${row.id}`);
      continue;
    }
    const endUtc = futureXEndTimeUtc(question.end_time);
    if (!endUtc || asOfMs >= new Date(endUtc).getTime()) {
      errors.push(`Research prediction ${row.id} was created at or after its task end time.`);
    }
    for (const evidence of row.evidence) {
      if (new Date(evidence.observedAtUtc).getTime() > asOfMs) {
        errors.push(`Evidence for ${row.id} was observed after the snapshot cutoff: ${evidence.url}`);
      }
    }
    if (row.method !== "baseline" && row.evidence.length === 0) {
      warnings.push(`Research prediction ${row.id} has no cited evidence.`);
    }
    const override = options.routeOverrides?.[row.id];
    if (!override || override.review?.status === "pending" || override.review === undefined) pendingRoutes += 1;
    const rowReport = validateFutureXSubmission([question], [{ id: row.id, prediction: row.prediction }], {
      ...(override ? { routeOverrides: { [row.id]: override } } : {}),
      requireComplete: true
    });
    errors.push(...rowReport.errors);
    warnings.push(...rowReport.warnings);
  }
  if (pendingRoutes > 0) warnings.push(`${pendingRoutes} selected routes are not marked approved; snapshot remains research-only.`);
  return {
    valid: errors.length === 0,
    errors,
    warnings: [...new Set(warnings)],
    stats: {
      totalQuestions: questions.length,
      predicted: snapshot.predictions.length,
      coverage: snapshot.predictions.length / questions.length,
      pendingRoutes,
      submissionEligible: false
    }
  };
}
