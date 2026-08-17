import type { FutureXLevel, FutureXResolvedQuestion, FutureXTaskKind } from "./schema.js";
import { FutureXResolvedQuestionSchema, FutureXSubmissionRowSchema } from "./schema.js";
import { routeFutureXQuestion } from "./adapter.js";

export type FutureXNumericProfile =
  | { id: "github-5pct-truth"; kind: "truth_relative"; ratio: 0.05; zeroSigma: 0.01 }
  | { id: "paper-7d-sigma"; kind: "provided_sigma" };

export interface FutureXScoreReport {
  profileId: string;
  compatibility: "deterministic-subset" | "approximate";
  overall: number | null;
  perLevel: Partial<Record<FutureXLevel, { mean: number | null; scored: number; total: number }>>;
  questions: Array<{ id: string; level: FutureXLevel; score: number | null; method: string }>;
  warnings: string[];
}

function normalized(value: string): string {
  return value.trim().toLocaleLowerCase().replace(/\s+/g, " ");
}

function labels(value: string | string[]): string[] {
  return (Array.isArray(value) ? value : value.split(","))
    .map((part) => normalized(part))
    .filter(Boolean);
}

function f1(gold: string[], predicted: string[]): number {
  const expected = new Set(gold);
  const actual = new Set(predicted);
  const overlap = [...actual].filter((item) => expected.has(item)).length;
  if (expected.size + actual.size === 0) return 1;
  return (2 * overlap) / (expected.size + actual.size);
}

function scoreNumeric(prediction: string, truth: number, sigma: number): number | null {
  const value = Number(prediction);
  if (!Number.isFinite(value) || !Number.isFinite(sigma) || sigma <= 0) return null;
  return Math.max(0, 1 - ((value - truth) / sigma) ** 2);
}

function kindFor(question: FutureXResolvedQuestion): FutureXTaskKind {
  return question.task_type ?? routeFutureXQuestion(question).kind;
}

export function scoreFutureX(
  resolvedInput: unknown[],
  submissionInput: unknown[],
  profile: FutureXNumericProfile = { id: "github-5pct-truth", kind: "truth_relative", ratio: 0.05, zeroSigma: 0.01 }
): FutureXScoreReport {
  const resolved = resolvedInput.map((value) => FutureXResolvedQuestionSchema.parse(value));
  const submission = submissionInput.map((value) => FutureXSubmissionRowSchema.parse(value));
  const predictionById = new Map(submission.map((row) => [row.id, row.prediction]));
  const warnings: string[] = [];
  const questions = resolved.map((question) => {
    const prediction = predictionById.get(question.id);
    if (prediction === undefined) return { id: question.id, level: question.level, score: 0, method: "missing" };
    const kind = kindFor(question);
    const goldText = Array.isArray(question.ground_truth) ? question.ground_truth.join(", ") : String(question.ground_truth);
    if (kind === "single_choice") {
      // We submit the route KEY (adapter.ts maps choices to choice.key), which
      // is what the prompts ask for ("\boxed{A}"), while ground_truth may be
      // recorded as the option TEXT. Comparing only against the text made the
      // local scorer report 0 for correct answers, so offline tuning was
      // optimizing against a lie. Accept either surface form of the gold option.
      const route = routeFutureXQuestion(question);
      const goldChoice = route.choices.find(
        (choice) => normalized(choice.key) === normalized(goldText) || normalized(choice.text) === normalized(goldText)
      );
      const acceptable = goldChoice ? [goldChoice.key, goldChoice.text] : [goldText];
      const hit = acceptable.some((candidate) => normalized(candidate) === normalized(prediction));
      return { id: question.id, level: question.level, score: hit ? 1 : 0, method: "exact" };
    }
    if (kind === "multi_choice") {
      return { id: question.id, level: question.level, score: f1(labels(question.ground_truth as string | string[]), labels(prediction)), method: "set-f1" };
    }
    if (kind === "ranking") {
      const gold = labels(question.ground_truth as string | string[]);
      const predicted = labels(prediction);
      if (new Set(predicted).size !== predicted.length) {
        warnings.push(`Duplicate ranking entity for ${question.id}; local score forced to 0.`);
        return { id: question.id, level: question.level, score: 0, method: "ranking-invalid-duplicate" };
      }
      const exact = gold.length === predicted.length && gold.every((item, index) => item === predicted[index]);
      const goldSet = new Set(gold);
      const overlap = [...new Set(predicted)].filter((item) => goldSet.has(item)).length;
      warnings.push(`Ranking/entity score for ${question.id} is approximate without the pinned production semantic judge.`);
      return { id: question.id, level: question.level, score: exact ? 1 : gold.length ? 0.8 * overlap / gold.length : 0, method: "ranking-overlap" };
    }
    if (kind === "numeric") {
      const truth = Number(question.ground_truth);
      const sigma = profile.kind === "provided_sigma"
        ? question.numeric_sigma
        : truth === 0 ? profile.zeroSigma : Math.abs(truth) * profile.ratio;
      const score = sigma === undefined ? null : scoreNumeric(prediction, truth, sigma);
      if (score === null) warnings.push(`Numeric score unavailable for ${question.id}.`);
      return { id: question.id, level: question.level, score, method: profile.id };
    }
    const score = normalized(prediction) === normalized(goldText) ? 1 : null;
    if (score === null) warnings.push(`Semantic judge required for ${question.id}; exact local match failed.`);
    return { id: question.id, level: question.level, score, method: "exact-or-judge-required" };
  });
  const perLevel: FutureXScoreReport["perLevel"] = {};
  for (const level of [1, 2, 3, 4] as const) {
    const rows = questions.filter((question) => question.level === level);
    if (rows.length === 0) continue;
    const scored = rows.filter((question) => question.score !== null);
    perLevel[level] = {
      mean: scored.length === rows.length
        ? scored.reduce((sum, question) => sum + (question.score ?? 0), 0) / rows.length
        : null,
      scored: scored.length,
      total: rows.length
    };
  }
  const weights: Record<FutureXLevel, number> = { 1: 0.1, 2: 0.2, 3: 0.3, 4: 0.4 };
  const allLevels = [1, 2, 3, 4] as const;
  const complete = allLevels.every((level) => perLevel[level]?.mean !== null && perLevel[level]?.mean !== undefined);
  const overall = complete
    ? allLevels.reduce((sum, level) => sum + (perLevel[level]?.mean ?? 0) * weights[level], 0)
    : null;
  return {
    profileId: profile.id,
    compatibility: warnings.length ? "approximate" : "deterministic-subset",
    overall,
    perLevel,
    questions,
    warnings
  };
}
