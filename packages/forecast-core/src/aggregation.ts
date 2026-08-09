import type { ForecastAnswer, ForecastTask, TrialPrediction } from "./contracts.js";
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
      const threshold = options.multiLabelThreshold ?? 0.5;
      let selected = task.choices.filter((choice) => (probabilities[choice] ?? 0) >= threshold);
      selected.sort((a, b) => (probabilities[b] ?? 0) - (probabilities[a] ?? 0));
      const min = task.minimumSelections;
      const max = task.maximumSelections ?? task.choices.length;
      if (selected.length < min) {
        selected = [...task.choices]
          .sort((a, b) => (probabilities[b] ?? 0) - (probabilities[a] ?? 0))
          .slice(0, min);
      }
      selected = selected.slice(0, max);
      selected.sort((a, b) => task.choices.indexOf(a) - task.choices.indexOf(b));
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
        .filter(Number.isFinite)
        .sort((a, b) => a - b);
      if (values.length === 0) throw new Error("No finite numeric predictions.");
      const trim = values.length >= 5 ? Math.floor(values.length * 0.2) : 0;
      const trimmed = values.slice(trim, values.length - trim || values.length);
      let value = trimmed.reduce((sum, candidate) => sum + candidate, 0) / trimmed.length;
      if (task.minimum !== undefined) value = Math.max(task.minimum, value);
      if (task.maximum !== undefined) value = Math.min(task.maximum, value);
      const numericAnswer: ForecastAnswer = { kind: "numeric", value };
      if (task.unit !== undefined) numericAnswer.unit = task.unit;
      return numericAnswer;
    }
    case "free_response": {
      const counts = new Map<string, { value: string; count: number }>();
      for (const answer of answers) {
        if (answer.kind !== "free_response") continue;
        const key = answer.value.trim().toLocaleLowerCase();
        const current = counts.get(key);
        counts.set(key, { value: answer.value.trim(), count: (current?.count ?? 0) + 1 });
      }
      const winner = [...counts.values()].sort((a, b) => b.count - a.count || a.value.localeCompare(b.value))[0];
      if (!winner) throw new Error("No free-response prediction.");
      return { kind: "free_response", value: winner.value };
    }
  }
}
