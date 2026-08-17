/**
 * Expected-F1 subset selection for set-valued answers.
 *
 * The benchmark scores a set answer S against a gold set G with
 * f1 = 2|S ∩ G| / (|G| + |S|), and treats two empty sets as a perfect 1.
 * A fixed 0.5 inclusion threshold maximises per-item accuracy, not F1: because the
 * denominator grows with |G|, a candidate well below 0.5 can still raise expected F1
 * when the gold set is large, so the threshold rule leaves score on the table.
 *
 * Model: candidate i belongs to G independently with probability p_i, and N = Σ_i B_i
 * is the gold size. For a chosen set S of size k,
 *
 *   E[F1(S)] = E[ 2 Σ_{i∈S} B_i / (N + k) ] = 2 Σ_{i∈S} p_i · E[ 1 / (N₋ᵢ + 1 + k) ]
 *
 * where N₋ᵢ excludes candidate i. Two consequences drive this module:
 *
 * 1. Prefix optimality. If p_i > p_j then N₋ᵢ stochastically dominates N₋ⱼ (they differ
 *    only in which of B_j, B_i they contain), so the per-item weight above is larger for i
 *    on both factors. The best set of size k is therefore always the k highest
 *    probabilities, and scanning the n+1 prefixes covers the global optimum.
 *
 * 2. Exact evaluation. Split the universe at the prefix boundary: X = |S ∩ G| and
 *    Z = |G \ S| are independent Poisson-binomials, and |G| = X + Z, so
 *
 *      E[F1(S)] = Σ_x Σ_z P(X=x) P(Z=z) · 2x / (x + z + k)
 *
 *    That double sum is EXACT — no approximation — with both pmfs built by an O(n²)
 *    Bernoulli convolution. Cost is O(n³) overall, so past `exactCandidateLimit` this
 *    module falls back to the plug-in 2·Σ_{i<k} p_i / (Σ_i p_i + k), which substitutes
 *    expected counts into the ratio, plus an explicit P(gold empty) term at k = 0.
 *    It is a ratio of expectations rather than the expectation of a ratio, and that
 *    error does NOT reliably shrink with n — on many low-probability candidates it
 *    stays large. It is always reported in `method` rather than passed off as exact,
 *    and its `expectedF1` can overstate the true expectation, so treat that number as
 *    a ranking signal rather than a calibrated estimate.
 */

export interface CandidateProbability {
  key: string;
  probability: number;
}

export type F1DecisionMethod = "exact-expected-f1" | "plugin-expected-counts";

export interface F1DecisionOptions {
  minimumSelections?: number;
  maximumSelections?: number;
  /** Candidate count above which the exact O(n³) scan is replaced by the plug-in approximation. */
  exactCandidateLimit?: number;
}

export interface F1Decision {
  /** Chosen keys, ordered by descending probability then ascending key. */
  selected: string[];
  /** Expected F1 of `selected` under the method named below. */
  expectedF1: number;
  /** How many prefix sizes were evaluated, after the selection bounds were applied. */
  consideredSizes: number;
  method: F1DecisionMethod;
}

const DEFAULT_EXACT_CANDIDATE_LIMIT = 192;

function compareCandidates(a: CandidateProbability, b: CandidateProbability): number {
  if (b.probability !== a.probability) return b.probability - a.probability;
  // Code-unit order rather than locale collation, so the same input decides the same way everywhere.
  return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
}

function orderCandidates(candidates: readonly CandidateProbability[]): CandidateProbability[] {
  const seen = new Set<string>();
  for (const candidate of candidates) {
    const { key, probability } = candidate;
    if (!Number.isFinite(probability) || probability < 0 || probability > 1) {
      throw new RangeError(`Inclusion probability for ${key} must lie in [0,1]; received ${String(probability)}`);
    }
    // Duplicates would inflate k while the scorer de-duplicates, breaking the F1 model.
    if (seen.has(key)) throw new Error(`Duplicate candidate key: ${key}`);
    seen.add(key);
  }
  return [...candidates].sort(compareCandidates);
}

function requireSelectionCount(value: number, label: string): number {
  if (!Number.isInteger(value) || value < 0) {
    throw new RangeError(`${label} must be a non-negative integer; received ${String(value)}`);
  }
  return value;
}

function addBernoulli(pmf: readonly number[], probability: number): number[] {
  const next = new Array<number>(pmf.length + 1).fill(0);
  for (let count = 0; count < pmf.length; count += 1) {
    const mass = pmf[count] ?? 0;
    next[count] = (next[count] ?? 0) + mass * (1 - probability);
    next[count + 1] = (next[count + 1] ?? 0) + mass * probability;
  }
  return next;
}

function expectedF1OfSplit(hitsPmf: readonly number[], missesPmf: readonly number[], size: number): number {
  let expectation = 0;
  for (let hits = 0; hits < hitsPmf.length; hits += 1) {
    const hitMass = hitsPmf[hits] ?? 0;
    if (hitMass === 0) continue;
    for (let misses = 0; misses < missesPmf.length; misses += 1) {
      const missMass = missesPmf[misses] ?? 0;
      if (missMass === 0) continue;
      const denominator = hits + misses + size;
      // An empty prediction against an empty gold set scores 1 in the scorer, not 0/0.
      expectation += hitMass * missMass * (denominator === 0 ? 1 : (2 * hits) / denominator);
    }
  }
  return expectation;
}

function exactPrefixScores(probabilities: readonly number[], lowest: number, highest: number): number[] {
  const total = probabilities.length;
  // suffixByLength[j] is the Poisson-binomial pmf of the last j candidates, i.e. the unselected tail.
  const suffixByLength: number[][] = [[1]];
  for (let index = total - 1; index >= 0; index -= 1) {
    const previous = suffixByLength[suffixByLength.length - 1] ?? [1];
    suffixByLength.push(addBernoulli(previous, probabilities[index] ?? 0));
  }
  const scores: number[] = [];
  let prefixPmf: number[] = [1];
  for (let size = 0; size <= highest; size += 1) {
    if (size > 0) prefixPmf = addBernoulli(prefixPmf, probabilities[size - 1] ?? 0);
    if (size >= lowest) scores.push(expectedF1OfSplit(prefixPmf, suffixByLength[total - size] ?? [1], size));
  }
  return scores;
}

function pluginPrefixScores(probabilities: readonly number[], lowest: number, highest: number): number[] {
  const expectedGoldSize = probabilities.reduce((sum, probability) => sum + probability, 0);
  // The scorer treats both-sets-empty as a perfect 1, so the empty prediction is
  // worth P(gold is empty) — not 0. The plug-in ratio has no term for that mass,
  // so without this the empty set scores 0 whenever any probability is positive
  // and can never be chosen, which is catastrophic when the candidates are all
  // unlikely (every p = 0.001 over many candidates: true E[F1] of the empty set
  // is 0.82, while selecting everything scores 0.002).
  const probabilityGoldEmpty = probabilities.reduce((product, probability) => product * (1 - probability), 1);
  const scores: number[] = [];
  let expectedHits = 0;
  for (let size = 0; size <= highest; size += 1) {
    if (size > 0) expectedHits += probabilities[size - 1] ?? 0;
    if (size < lowest) continue;
    if (size === 0) {
      scores.push(probabilityGoldEmpty);
      continue;
    }
    const denominator = expectedGoldSize + size;
    scores.push(denominator === 0 ? 1 : (2 * expectedHits) / denominator);
  }
  return scores;
}

/**
 * Picks the subset of `candidates` that maximises expected F1 against an unknown gold set.
 *
 * Ties are resolved deterministically: candidates sort by descending probability then
 * ascending key, and when two prefix sizes score equally the smaller one wins, so the
 * decision never pads a set with candidates that do not improve the expectation.
 */
export function chooseF1Subset(
  candidates: readonly CandidateProbability[],
  options: F1DecisionOptions = {}
): F1Decision {
  const ordered = orderCandidates(candidates);
  const total = ordered.length;
  const minimum = requireSelectionCount(options.minimumSelections ?? 0, "minimumSelections");
  const maximum = requireSelectionCount(options.maximumSelections ?? total, "maximumSelections");
  if (maximum < minimum) {
    throw new RangeError(`maximumSelections (${maximum}) is below minimumSelections (${minimum}).`);
  }
  const lowest = Math.min(minimum, total);
  const highest = Math.min(maximum, total);
  const probabilities = ordered.map((candidate) => candidate.probability);
  const method: F1DecisionMethod =
    total <= (options.exactCandidateLimit ?? DEFAULT_EXACT_CANDIDATE_LIMIT)
      ? "exact-expected-f1"
      : "plugin-expected-counts";
  const scores = method === "exact-expected-f1"
    ? exactPrefixScores(probabilities, lowest, highest)
    : pluginPrefixScores(probabilities, lowest, highest);

  let best = 0;
  for (let index = 1; index < scores.length; index += 1) {
    if ((scores[index] ?? 0) > (scores[best] ?? 0)) best = index;
  }
  return {
    selected: ordered.slice(0, lowest + best).map((candidate) => candidate.key),
    expectedF1: scores[best] ?? 0,
    consideredSizes: scores.length,
    method
  };
}
