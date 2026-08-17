import type { ForecastAnswer, ForecastTask, TrialPrediction } from "./contracts.js";
import { canonicalizeEntity, clusterAnswers } from "./canonicalize.js";
import { chooseNumericPoint } from "./numeric-decision.js";
import { chooseF1Subset } from "./set-decision.js";
import { blendLogOdds, clampProbability, logitPool, normalizeProbabilities } from "./probability.js";

export interface AggregationOptions {
  priorProbability?: number;
  priorWeight?: number;
  multiLabelThreshold?: number;
  probabilityFloor?: number;
}

function compatibleAnswers(task: ForecastTask, trials: readonly TrialPrediction[]): ForecastAnswer[] {
  const expected: ForecastAnswer["kind"] =
    task.kind === "binary_probability"
      ? "binary"
      : task.kind === "categorical"
        ? "categorical"
        : task.kind === "multi_label"
          ? "multi_label"
          : task.kind === "ranking"
            ? "ranking"
            : task.kind === "numeric"
              ? "numeric"
              : "free_response";
  return trials.map((trial) => trial.answer).filter((answer) => answer.kind === expected);
}

export function aggregateTrialPredictions(
  task: ForecastTask,
  trials: readonly TrialPrediction[],
  options: AggregationOptions = {}
): ForecastAnswer {
  const answers = compatibleAnswers(task, trials);
  if (answers.length === 0) throw new Error(`No compatible trial answers for ${task.taskId}.`);

  switch (task.kind) {
    case "binary_probability": {
      const probabilities = answers.flatMap((answer) => (answer.kind === "binary" ? [answer.pYes] : []));
      const pooled = logitPool(probabilities);
      const prior = options.priorProbability ?? task.priorProbability;
      const priorWeight = options.priorWeight ?? 0;
      const blended = prior === undefined ? pooled : blendLogOdds(pooled, prior, priorWeight);
      const floor = options.probabilityFloor ?? 0.01;
      return { kind: "binary", pYes: clampProbability(blended, floor, 1 - floor) };
    }
    case "categorical": {
      const totals = Object.fromEntries(task.choices.map((choice) => [choice, 0]));
      for (const answer of answers) {
        if (answer.kind !== "categorical") continue;
        const normalized = normalizeProbabilities(answer.probabilities, task.choices);
        for (const choice of task.choices) totals[choice] = (totals[choice] ?? 0) + (normalized[choice] ?? 0);
      }
      const probabilities = normalizeProbabilities(totals, task.choices);
      const choice = task.choices.reduce((best, candidate) =>
        (probabilities[candidate] ?? 0) > (probabilities[best] ?? 0) ? candidate : best
      );
      return { kind: "categorical", choice, probabilities };
    }
    case "multi_label": {
      const totals = Object.fromEntries(task.choices.map((choice) => [choice, 0]));
      for (const answer of answers) {
        if (answer.kind !== "multi_label") continue;
        for (const choice of task.choices) {
          totals[choice] = (totals[choice] ?? 0) + (answer.probabilities[choice] ?? Number(answer.selected.includes(choice)));
        }
      }
      const probabilities = Object.fromEntries(
        task.choices.map((choice) => [choice, (totals[choice] ?? 0) / answers.length])
      );
      // A fixed 0.5 cut is provably suboptimal for F1: when the gold set is
      // large, including a candidate below 0.5 can still raise expected F1.
      // Choose the prefix size that maximizes it instead.
      const decision = chooseF1Subset(
        task.choices.map((choice) => ({ key: choice, probability: probabilities[choice] ?? 0 })),
        {
          minimumSelections: task.minimumSelections,
          ...(task.maximumSelections !== undefined ? { maximumSelections: task.maximumSelections } : {})
        }
      );
      const selected = [...decision.selected].sort((a, b) => task.choices.indexOf(a) - task.choices.indexOf(b));
      return { kind: "multi_label", selected, probabilities };
    }
    case "ranking": {
      const candidates = task.candidates.length > 0
        ? [...task.candidates]
        : [...new Set(answers.flatMap((answer) => answer.kind === "ranking" ? answer.order : []))];
      if (candidates.length === 0) throw new Error("No ranking candidates were returned.");
      const candidateOrder = new Map(candidates.map((candidate, index) => [candidate, index]));
      const scores = Object.fromEntries(candidates.map((candidate) => [candidate, 0]));
      for (const answer of answers) {
        if (answer.kind !== "ranking") continue;
        answer.order.forEach((candidate, index) => {
          if (candidate in scores) scores[candidate] = (scores[candidate] ?? 0) + candidates.length - index;
        });
      }
      const order = candidates
        .sort((a, b) => (scores[b] ?? 0) - (scores[a] ?? 0) || (candidateOrder.get(a) ?? 0) - (candidateOrder.get(b) ?? 0))
        .slice(0, Math.min(task.rankCount, candidates.length));
      return { kind: "ranking", order, scores };
    }
    case "numeric": {
      const values = answers
        .flatMap((answer) => (answer.kind === "numeric" ? [answer.value] : []))
        .filter(Number.isFinite);
      if (values.length === 0) throw new Error("No finite numeric predictions.");
      // A trimmed mean is a central-tendency estimator, and the grader's score
      // is not maximized there. max(0, 1-((x-t)/sigma)^2) has bounded support,
      // so on a split trial set the mean can land in a dead zone scoring 0
      // while either cluster would score well. Pick the point that maximizes
      // expected score over the trials instead.
      const decision = chooseNumericPoint(values, {
        ...(task.minimum !== undefined ? { minimum: task.minimum } : {}),
        ...(task.maximum !== undefined ? { maximum: task.maximum } : {})
      });
      const numericAnswer: ForecastAnswer = { kind: "numeric", value: decision.value };
      if (task.unit !== undefined) numericAnswer.unit = task.unit;
      return numericAnswer;
    }
    case "free_response": {
      const raw = answers.flatMap((answer) => (answer.kind === "free_response" ? [answer.value] : []));
      if (raw.length === 0) throw new Error("No free-response prediction.");
      // The old vote keyed on lowercase+trim, so "Real Madrid." and "Real
      // Madrid" were rivals rather than the same answer, and ties broke
      // ALPHABETICALLY rather than by support. Cluster equivalent spellings
      // first, then take the largest cluster's canonical representative.
      const clusters = clusterAnswers(raw);
      const winner = clusters[0];
      if (!winner) throw new Error("No free-response prediction.");
      return { kind: "free_response", value: winner.representative };
    }
  }
}
