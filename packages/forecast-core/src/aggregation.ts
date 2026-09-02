import type { ForecastAnswer, ForecastTask, TrialPrediction } from "./contracts.js";
import { canonicalizeEntity, clusterAnswers } from "./canonicalize.js";
import { chooseNumericPoint } from "./numeric-decision.js";
import { chooseF1Subset } from "./set-decision.js";
import { blendLogOdds, clampProbability, logitPool, normalizeProbabilities } from "./probability.js";

/**
 * How an aggregate answer was reached, recorded so a resolved miss can be
 * traced past the trials to the decision itself. Without it the record shows
 * four trials saying [4025, 4020, 4004, 4025] and a submission of 4018.45,
 * with nothing explaining the jump — the aggregation step is exactly where a
 * defensible set of forecasts can still turn into an indefensible answer.
 */
export interface AggregationDerivation {
  /** The rule applied, e.g. "expected-score-grid", "logit-pool-argmax". */
  method: string;
  /** What the rule consumed, verbatim. */
  inputs: unknown;
  /** What it produced. */
  chosen: unknown;
  /** Rule-specific evidence: expected score, grid size, cluster membership. */
  detail: Record<string, unknown>;
}

export interface AggregationOptions {
  priorProbability?: number;
  priorWeight?: number;
  multiLabelThreshold?: number;
  probabilityFloor?: number;
  /**
   * Sink for conditions the aggregate answer alone cannot express — chiefly a
   * numeric decision whose declared bounds excluded every trial, where the
   * emitted value comes from the bounds rather than from any forecast. Silently
   * answering there hides a data problem behind a well-formed number.
   */
  diagnostics?: string[];
  /** Sink for the derivation record; the engine attaches it to the result. */
  derivation?: AggregationDerivation[];
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
      const finalP = clampProbability(blended, floor, 1 - floor);
      options.derivation?.push({
        method: prior === undefined ? "logit-pool" : "logit-pool-blended-prior",
        inputs: { trialProbabilities: probabilities },
        chosen: finalP,
        detail: { pooled, ...(prior !== undefined ? { prior, priorWeight } : {}), floor }
      });
      return { kind: "binary", pYes: finalP };
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
      const ranked = [...task.choices].sort((a, b) => (probabilities[b] ?? 0) - (probabilities[a] ?? 0));
      options.derivation?.push({
        method: "mean-simplex-argmax",
        inputs: {
          trialChoices: answers.map((answer) => (answer.kind === "categorical" ? answer.choice : null)),
          trialProbabilities: answers.map((answer) => (answer.kind === "categorical" ? answer.probabilities : null))
        },
        chosen: choice,
        detail: {
          pooledProbabilities: probabilities,
          // Exact match with no partial credit, so the only thing that decides
          // the score is whether the top choice is right — the margin over the
          // runner-up is how safe that call was.
          runnerUp: ranked[1] ?? null,
          margin: (probabilities[ranked[0] ?? ""] ?? 0) - (probabilities[ranked[1] ?? ""] ?? 0)
        }
      });
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
      options.derivation?.push({
        method: decision.method,
        inputs: { inclusionProbabilities: probabilities },
        chosen: selected,
        detail: {
          expectedF1: decision.expectedF1,
          consideredSizes: decision.consideredSizes,
          minimumSelections: task.minimumSelections,
          ...(task.maximumSelections !== undefined ? { maximumSelections: task.maximumSelections } : {})
        }
      });
      return { kind: "multi_label", selected, probabilities };
    }
    case "ranking": {
      // Entities are matched case- and whitespace-insensitively. "Somna med
      // Humlan Djojj" and "Somna Med Humlan Djojj" are one album; counting them
      // as two put the same title twice in a submitted list (2026-09-02), and
      // a duplicate entity scores 0 on the grader. The first spelling seen wins.
      const spelling = new Map<string, string>();
      const canonical = (value: string): string => {
        const key = value.trim().toLowerCase().replace(/\s+/g, " ");
        if (!spelling.has(key)) spelling.set(key, value.trim());
        return spelling.get(key)!;
      };
      for (const candidate of task.candidates) canonical(candidate);
      const trialOrders = answers.flatMap((answer) =>
        answer.kind === "ranking" ? [[...new Set(answer.order.map(canonical))]] : []
      );
      // Exact-order plurality before Borda. The grader gives full credit only
      // for a position-by-position match, so when a strict plurality of trials
      // agree on the whole order, that order is the best single guess; Borda
      // can rank first a title that no trial ranked first, because it rewards
      // consistent second places over a majority of firsts.
      const tally = new Map<string, { order: string[]; count: number }>();
      for (const order of trialOrders) {
        const key = order.join(" ");
        const entry = tally.get(key);
        if (entry) entry.count += 1;
        else tally.set(key, { order, count: 1 });
      }
      const ranked = [...tally.values()].sort((a, b) => b.count - a.count);
      const top = ranked[0];
      if (top && top.count >= 2 && (ranked[1]?.count ?? 0) < top.count && top.order.length === task.rankCount) {
        const scores = Object.fromEntries(top.order.map((candidate, index) => [candidate, top.order.length - index]));
        options.derivation?.push({
          method: "exact-order-plurality",
          inputs: { trialOrders },
          chosen: top.order,
          detail: { support: top.count, trials: trialOrders.length, runnerUpSupport: ranked[1]?.count ?? 0, rankCount: task.rankCount }
        });
        return { kind: "ranking", order: top.order, scores };
      }
      const candidates = task.candidates.length > 0
        ? [...new Set(task.candidates.map(canonical))]
        : [...new Set(trialOrders.flat())];
      if (candidates.length === 0) throw new Error("No ranking candidates were returned.");
      const candidateOrder = new Map(candidates.map((candidate, index) => [candidate, index]));
      const scores = Object.fromEntries(candidates.map((candidate) => [candidate, 0]));
      for (const order of trialOrders) {
        order.forEach((candidate, index) => {
          if (candidate in scores) scores[candidate] = (scores[candidate] ?? 0) + candidates.length - index;
        });
      }
      const order = candidates
        .sort((a, b) => (scores[b] ?? 0) - (scores[a] ?? 0) || (candidateOrder.get(a) ?? 0) - (candidateOrder.get(b) ?? 0))
        .slice(0, Math.min(task.rankCount, candidates.length));
      options.derivation?.push({
        method: "borda-count",
        inputs: { trialOrders },
        chosen: order,
        detail: { bordaScores: scores, rankCount: task.rankCount }
      });
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
        ...(task.maximum !== undefined ? { maximum: task.maximum } : {}),
        ...(task.integerValued ? { integerValued: true } : {})
      });
      if (decision.method === "bounds-collapsed") {
        options.diagnostics?.push(
          `numeric bounds [${task.minimum ?? "-inf"}, ${task.maximum ?? "+inf"}] excluded every trial ` +
            `(${values.join(", ")}); answer ${decision.value} comes from the bounds, not a forecast`
        );
      }
      options.derivation?.push({
        method: decision.method,
        inputs: { trialValues: values },
        chosen: decision.value,
        detail: {
          expectedScore: decision.expectedScore,
          gridPoints: decision.gridPoints,
          integerValued: task.integerValued === true,
          ...(task.unit !== undefined ? { unit: task.unit } : {}),
          ...(task.minimum !== undefined ? { minimum: task.minimum } : {}),
          ...(task.maximum !== undefined ? { maximum: task.maximum } : {})
        }
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
      options.derivation?.push({
        method: "fold-cluster-vote",
        inputs: { trialAnswers: raw },
        chosen: winner.representative,
        detail: {
          // Which spellings were treated as the same answer, and by how much
          // the winning group beat the next — a one-vote margin over a rival
          // entity is a very different result from a unanimous four.
          clusters: clusters.map((cluster) => ({ representative: cluster.representative, size: cluster.size, members: cluster.members })),
          winningSize: winner.size,
          runnerUpSize: clusters[1]?.size ?? 0
        }
      });
      return { kind: "free_response", value: winner.representative };
    }
  }
}
