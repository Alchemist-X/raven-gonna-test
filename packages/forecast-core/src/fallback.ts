// Per-kind default answers for tasks whose model trials all failed.
//
// The scoring rule this exists for (FutureX): a missing submission row scores 0,
// and a wrong row is scored on the same 0..1 scale with no penalty below zero.
// So abstaining is weakly dominated by guessing — there is no state of the world
// in which throwing beats shipping an uninformative row. Today the engine throws
// an AggregateError when every trial fails unless the caller supplies
// options.fallback, which turns one flaky provider call into a permanent zero.
//
// One caveat about the LOCAL scorer, which is a measuring instrument and not the
// benchmark: for open_text it returns null on a non-exact match, meaning "a
// production semantic judge is required, and this copy does not have one". Under
// the old code a single null collapsed the whole local report. That is a
// limitation of our offline estimate — it is NOT the benchmark awarding null,
// and it is not a reason to abstain. Optimising for a nicer local report at the
// cost of real score would be optimising the instrument. scoreFutureX now
// reports bounds instead of collapsing.
//
// Every value here is derived from the task alone: no clock, no randomness, so
// a replayed run reproduces the same submission. The answers are deliberately
// uninformative, which is why isDegenerateAnswer exists — a fallback row ships,
// but it must be labelled as a fallback in artifacts rather than counted as a
// forecast the system actually made.

import type { ForecastAnswer, ForecastTask } from "./contracts.js";

// Compared against normalised choice text: FutureX single-choice tasks are
// frequently a Yes/No pair, and "does the specific thing happen by the
// deadline" resolves No more often than Yes across such question sets.
const NEGATIVE_CHOICES = new Set(["no", "none", "neither", "false", "negative"]);

// Strings that a downstream judge would read as "no answer given".
const NON_ANSWERS = new Set(["", "unknown", "n/a", "na", "no answer", "not applicable"]);

const UNKNOWN_FREE_RESPONSE = "unknown";

// Scores/probabilities are floats produced by division, so exact equality is
// the wrong test for "all the same".
const EQUALITY_EPSILON = 1e-12;

function normalized(value: string): string {
  return value.trim().toLocaleLowerCase().replace(/\s+/g, " ");
}

function allEqual(values: readonly number[]): boolean {
  const first = values[0];
  if (first === undefined) return false;
  return values.every((value) => Math.abs(value - first) <= EQUALITY_EPSILON);
}

function constantOver(labels: readonly string[], value: number): Record<string, number> {
  return Object.fromEntries(labels.map((label) => [label, value]));
}

/**
 * The point minimising worst-case RELATIVE error over [minimum, maximum].
 * Falls back to the arithmetic midpoint when the interval spans or touches zero,
 * where relative error is undefined at the crossing.
 */
function harmonicMidpoint(minimum: number, maximum: number): number {
  const arithmetic = (minimum + maximum) / 2;
  if (minimum <= 0 || maximum <= 0) return arithmetic;
  const harmonic = (2 * minimum * maximum) / (minimum + maximum);
  return Number.isFinite(harmonic) ? harmonic : arithmetic;
}

export function defaultAnswerForTask(task: ForecastTask): ForecastAnswer {
  switch (task.kind) {
    case "binary_probability":
      // 0.5 is the minimax choice against a scoring rule we do not control:
      // it caps Brier loss at 0.25 and, unlike 0 or 1, cannot be infinitely
      // penalised by a log score. task.priorProbability is deliberately not
      // used — the run that would have conditioned on it never happened, and
      // dressing a failure up as a prior-informed forecast is the dishonest
      // version of this function.
      return { kind: "binary", pYes: 0.5 };
    case "categorical": {
      // Uniform probabilities have no argmax, so the emitted choice is a free
      // tie-break: spend it on the base rate rather than on list position.
      const choice = task.choices.find((candidate) => NEGATIVE_CHOICES.has(normalized(candidate))) ?? task.choices[0];
      if (choice === undefined) throw new Error(`Categorical task ${task.taskId} has no choices to answer with.`);
      return { kind: "categorical", choice, probabilities: constantOver(task.choices, 1 / task.choices.length) };
    }
    case "multi_label": {
      // The scorer grades a label set by F1 = 2·overlap/(|gold| + k). Guessing
      // k of n labels at random gives E[F1] = (2g/n)·k/(k+g), which increases
      // monotonically in k, so with no information the best k is the largest
      // one allowed. Selecting everything also removes the risk of scoring 0
      // outright on a task whose gold set is large.
      const cap = Math.min(task.maximumSelections ?? task.choices.length, task.choices.length);
      const selected = task.choices.slice(0, Math.max(cap, task.minimumSelections));
      // Multi-label probabilities are per-label marginals, not a distribution,
      // so the uninformative value is 0.5 each rather than 1/n.
      return { kind: "multi_label", selected, probabilities: constantOver(task.choices, 0.5) };
    }
    case "ranking": {
      // With no evidence, every permutation has the same expected overlap
      // score, so the given candidate order is as good as any and is the only
      // one that is stable across replays. Open-candidate rankings still have a
      // strict output cardinality: an empty order makes the entire submission
      // invalid. Stable sentinel labels preserve completeness while remaining
      // unmistakably synthetic in the fallback-labelled audit artifact.
      const order = task.candidates.length > 0
        ? task.candidates.slice(0, task.rankCount)
        : Array.from({ length: task.rankCount }, (_, index) => `unknown_${index + 1}`);
      return { kind: "ranking", order, scores: constantOver(order, 0) };
    }
    case "numeric": {
      // FutureX scores numerics as max(0, 1 - ((v - truth)/sigma)^2) with sigma
      // proportional to |truth|, so only a near-exact answer scores at all. The
      // one exception is truth === 0, where sigma is an absolute floor and an
      // answer of 0 scores 1 — which makes 0 the only unbounded guess with any
      // expected value. With bounds, use the geometric-style midpoint: because
      // sigma is RELATIVE to |truth|, the point minimising worst-case relative
      // error over [min,max] is the harmonic mean, not the arithmetic one. On
      // [10,30] the arithmetic midpoint 20 is 100% off at truth=10 but the
      // harmonic mean 15 is at most 50% off at either end.
      const bounded = task.minimum !== undefined && task.maximum !== undefined;
      const midpoint = bounded
        ? harmonicMidpoint(task.minimum as number, task.maximum as number)
        : undefined;
      const value = midpoint ?? Math.min(
        task.maximum ?? Number.POSITIVE_INFINITY,
        Math.max(task.minimum ?? Number.NEGATIVE_INFINITY, 0)
      );
      return { kind: "numeric", value, ...(task.unit !== undefined ? { unit: task.unit } : {}) };
    }
    case "free_response":
      // An empty string would score what a missing row scores, and the answer
      // schema rejects it outright, so there is no "abstain" shape available
      // here. A placeholder costs nothing under R1 (a wrong open-text answer is
      // scored 0, never negative) and keeps the submission complete, which the
      // FutureX validator requires. Honesty is preserved by NON_ANSWERS: this
      // exact value reads back as degenerate.
      return { kind: "free_response", value: UNKNOWN_FREE_RESPONSE };
  }
}

/**
 * True when an answer carries no information about the outcome. Callers use it
 * to label a row as a fallback in artifacts instead of reporting it as a real
 * forecast. Numeric answers always read false: a midpoint or a zero is
 * indistinguishable from a genuine point estimate once it is in the payload, so
 * numeric provenance must come from ForecastResult.fallbackUsed instead.
 */
export function isDegenerateAnswer(answer: ForecastAnswer): boolean {
  switch (answer.kind) {
    case "binary":
      return answer.pYes === 0.5;
    case "categorical":
      return allEqual(Object.values(answer.probabilities));
    case "multi_label":
      return answer.selected.length === 0 || allEqual(Object.values(answer.probabilities));
    case "ranking":
      // An answer that ships no scores made a real ordering claim; one whose
      // scores are all equal ranked nothing above anything.
      return answer.order.length === 0 || allEqual(Object.values(answer.scores ?? {}));
    case "numeric":
      return false;
    case "free_response":
      return NON_ANSWERS.has(normalized(answer.value));
  }
}
