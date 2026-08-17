// FutureX scores a numeric answer with max(0, 1 - ((x - truth) / sigma)^2) where sigma is a fixed
// fraction of |truth|. That objective has bounded support: it is exactly 0 once |x - truth| >= sigma.
// A central-tendency estimator therefore maximises nothing in particular - on a bimodal trial set the
// mean can land in a dead zone that scores 0 while either mode would score above 0.5. The maximiser of
// the expected score is mode-seeking, so this module searches for it directly instead of averaging.

export interface NumericScoreProfile {
  relativeSigma: number;
  zeroSigma: number;
}

export interface NumericQuantiles {
  p10?: number;
  p50?: number;
  p90?: number;
}

export interface NumericDecisionOptions {
  profile?: NumericScoreProfile;
  extraSamples?: readonly number[];
  quantiles?: NumericQuantiles;
  quantileWeight?: number;
  kernelWidth?: number;
  minimum?: number;
  maximum?: number;
  gridResolution?: number;
  maximumGridPoints?: number;
}

export type NumericDecisionMethod = "single-atom" | "expected-score-grid" | "bounds-collapsed";

export interface NumericDecision {
  value: number;
  expectedScore: number;
  gridPoints: number;
  method: NumericDecisionMethod;
}

interface Atom {
  value: number;
  weight: number;
}

interface Candidate {
  value: number;
  score: number;
}

export const futureXNumericProfile: NumericScoreProfile = { relativeSigma: 0.05, zeroSigma: 0.01 };

// Pearson-Tukey weights turn an elicited p10/p50/p90 triple into a three-point discretisation whose
// first two moments match the underlying distribution; they are the standard choice for exactly this.
const quantileNodeWeights = { p10: 0.185, p50: 0.63, p90: 0.185 } as const;

function gaussianNodes(offsets: readonly number[]): ReadonlyArray<{ offset: number; weight: number }> {
  const raw = offsets.map((offset) => ({ offset, weight: Math.exp(-(offset ** 2) / 2) }));
  const total = raw.reduce((sum, node) => sum + node.weight, 0);
  return raw.map((node) => ({ offset: node.offset, weight: node.weight / total }));
}

// Five nodes span +-2 kernel widths, which carries 95% of a Gaussian's mass. Adding nodes shifts the
// maximiser by less than one grid step, so the extra evaluations buy nothing.
const kernelNodes = gaussianNodes([-2, -1, 0, 1, 2]);

function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[middle] ?? 0;
  return ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2;
}

function totalWeight(atoms: readonly Atom[]): number {
  return atoms.reduce((sum, atom) => sum + atom.weight, 0);
}

function weightedMedian(atoms: readonly Atom[]): number {
  const sorted = [...atoms].sort((a, b) => a.value - b.value);
  const half = totalWeight(sorted) / 2;
  let cumulative = 0;
  for (const atom of sorted) {
    cumulative += atom.weight;
    if (cumulative >= half) return atom.value;
  }
  return sorted[sorted.length - 1]?.value ?? 0;
}

function resolveProfile(options: NumericDecisionOptions): NumericScoreProfile {
  const profile = options.profile ?? futureXNumericProfile;
  if (!Number.isFinite(profile.relativeSigma) || profile.relativeSigma <= 0) {
    throw new RangeError(`profile.relativeSigma must be a positive finite number; received ${String(profile.relativeSigma)}`);
  }
  if (!Number.isFinite(profile.zeroSigma) || profile.zeroSigma <= 0) {
    throw new RangeError(`profile.zeroSigma must be a positive finite number; received ${String(profile.zeroSigma)}`);
  }
  return profile;
}

export function numericSigmaFor(truth: number, profile: NumericScoreProfile = futureXNumericProfile): number {
  if (!Number.isFinite(truth)) throw new TypeError(`Candidate truth must be finite; received ${String(truth)}`);
  const sigma = truth === 0 ? profile.zeroSigma : Math.abs(truth) * profile.relativeSigma;
  // A denormal truth can drive the relative sigma to 0; the absolute floor keeps the score defined.
  return sigma > 0 ? sigma : profile.zeroSigma;
}

export function numericScore(
  value: number,
  truth: number,
  profile: NumericScoreProfile = futureXNumericProfile
): number {
  const sigma = numericSigmaFor(truth, profile);
  return Math.max(0, 1 - ((value - truth) / sigma) ** 2);
}

function mixtureScore(value: number, atoms: readonly Atom[], profile: NumericScoreProfile): number {
  const total = totalWeight(atoms);
  if (!(total > 0)) throw new Error("The empirical distribution has no positive weight.");
  const weighted = atoms.reduce((sum, atom) => sum + atom.weight * numericScore(value, atom.value, profile), 0);
  return weighted / total;
}

function quantileAtoms(quantiles: NumericQuantiles | undefined, blockWeight: number): Atom[] {
  if (quantiles === undefined || blockWeight <= 0) return [];
  const present = (["p10", "p50", "p90"] as const)
    .flatMap((key) => {
      const value = quantiles[key];
      if (value === undefined) return [];
      if (!Number.isFinite(value)) throw new TypeError(`Quantile ${key} must be finite; received ${String(value)}`);
      return [{ value, weight: quantileNodeWeights[key] }];
    });
  const declared = totalWeight(present);
  if (declared <= 0) return [];
  return present.map((atom) => ({ value: atom.value, weight: (atom.weight / declared) * blockWeight }));
}

function nearestNeighbourSpacing(values: readonly number[]): number {
  if (values.length < 2) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const gaps = sorted.map((value, index) => {
    const left = index > 0 ? value - (sorted[index - 1] ?? value) : Number.POSITIVE_INFINITY;
    const right = index + 1 < sorted.length ? (sorted[index + 1] ?? value) - value : Number.POSITIVE_INFINITY;
    return Math.min(left, right);
  });
  return median(gaps);
}

function kernelWidthFor(
  atoms: readonly Atom[],
  profile: NumericScoreProfile,
  options: NumericDecisionOptions
): number {
  const configured = options.kernelWidth;
  if (configured !== undefined) {
    if (!Number.isFinite(configured) || configured < 0) {
      throw new RangeError(`kernelWidth must be a non-negative finite number; received ${String(configured)}`);
    }
    return configured;
  }
  // Median nearest-neighbour spacing is a k=1 nearest-neighbour bandwidth: it shrinks as trials
  // accumulate and it reads the spacing *inside* a cluster, unlike Silverman's rule, which keys off
  // the global spread and would smooth a bimodal ensemble into a single blob - the exact failure this
  // module exists to avoid. The cap stops the kernel from blurring wider than the parabola it is
  // scored against, which would erase the structure the objective rewards.
  const spacing = nearestNeighbourSpacing(atoms.map((atom) => atom.value));
  const tolerance = median(atoms.map((atom) => numericSigmaFor(atom.value, profile)));
  return Math.min(spacing, tolerance / 2);
}

function smear(atoms: readonly Atom[], width: number): Atom[] {
  if (width <= 0) return [...atoms];
  return atoms.flatMap((atom) =>
    kernelNodes.map((node) => ({
      value: atom.value + node.offset * width,
      weight: atom.weight * node.weight
    }))
  );
}

function observedValues(samples: readonly number[], options: NumericDecisionOptions): number[] {
  const values = [...samples, ...(options.extraSamples ?? [])];
  if (values.length === 0) throw new Error("chooseNumericPoint requires at least one numeric sample.");
  for (const value of values) {
    if (!Number.isFinite(value)) throw new TypeError(`Numeric samples must be finite; received ${String(value)}`);
  }
  return values;
}

function buildAtoms(
  samples: readonly number[],
  options: NumericDecisionOptions,
  profile: NumericScoreProfile
): Atom[] {
  const values = observedValues(samples, options);
  const weight = options.quantileWeight ?? 1;
  if (!Number.isFinite(weight) || weight < 0) {
    throw new RangeError(`quantileWeight must be a non-negative finite number; received ${String(weight)}`);
  }
  // An elicited quantile triple is a full distributional statement, so at weight 1 it carries the same
  // mass as the whole trial ensemble - parity, not dominance, because it comes from the same model.
  const combined = [
    ...values.map((value) => ({ value, weight: 1 })),
    ...quantileAtoms(options.quantiles, values.length * weight)
  ];
  return smear(combined, kernelWidthFor(combined, profile, options));
}

export function expectedNumericScore(
  value: number,
  samples: readonly number[],
  options: NumericDecisionOptions = {}
): number {
  const profile = resolveProfile(options);
  return mixtureScore(value, buildAtoms(samples, options, profile), profile);
}

function resolveBounds(options: NumericDecisionOptions): { minimum: number; maximum: number } {
  const minimum = options.minimum ?? Number.NEGATIVE_INFINITY;
  const maximum = options.maximum ?? Number.POSITIVE_INFINITY;
  if (Number.isNaN(minimum) || Number.isNaN(maximum) || minimum > maximum) {
    throw new RangeError(`Invalid numeric bounds: minimum ${String(minimum)} exceeds maximum ${String(maximum)}`);
  }
  return { minimum, maximum };
}

function clamp(value: number, bounds: { minimum: number; maximum: number }): number {
  return Math.min(bounds.maximum, Math.max(bounds.minimum, value));
}

function isBetter(candidate: Candidate, incumbent: Candidate, pivot: number): boolean {
  if (candidate.score !== incumbent.score) return candidate.score > incumbent.score;
  const drift = Math.abs(candidate.value - pivot) - Math.abs(incumbent.value - pivot);
  if (drift !== 0) return drift < 0;
  return candidate.value < incumbent.value;
}

function bestOf(
  values: readonly number[],
  atoms: readonly Atom[],
  profile: NumericScoreProfile,
  pivot: number,
  incumbent?: Candidate
): Candidate {
  let best = incumbent;
  for (const value of values) {
    const candidate: Candidate = { value, score: mixtureScore(value, atoms, profile) };
    if (best === undefined || isBetter(candidate, best, pivot)) best = candidate;
  }
  if (best === undefined) throw new Error("Expected-score search produced no candidates.");
  return best;
}

function gridValues(low: number, high: number, points: number): number[] {
  if (!(high > low) || points < 2) return [low];
  const step = (high - low) / (points - 1);
  return Array.from({ length: points }, (_, index) => (index === points - 1 ? high : low + index * step));
}

function trimmedMean(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const trim = sorted.length >= 5 ? Math.floor(sorted.length * 0.2) : 0;
  const kept = sorted.slice(trim, sorted.length - trim || sorted.length);
  return kept.reduce((sum, value) => sum + value, 0) / kept.length;
}

// Seeding the search with every estimator it could replace - and with the atoms themselves - makes the
// result provably no worse than the incumbent trimmed mean, and guarantees each atom's own peak is
// evaluated even when the grid budget forces a step wider than the narrowest parabola.
function seedValues(values: readonly number[], options: NumericDecisionOptions): number[] {
  const quantiles = options.quantiles ?? {};
  return [
    ...values,
    ...(["p10", "p50", "p90"] as const).flatMap((key) => {
      const value = quantiles[key];
      return value === undefined ? [] : [value];
    }),
    values.reduce((sum, value) => sum + value, 0) / values.length,
    median(values),
    trimmedMean(values)
  ];
}

export function chooseNumericPoint(
  samples: readonly number[],
  options: NumericDecisionOptions = {}
): NumericDecision {
  const profile = resolveProfile(options);
  const bounds = resolveBounds(options);
  const atoms = buildAtoms(samples, options, profile);
  const pivot = weightedMedian(atoms);

  if (new Set(atoms.map((atom) => atom.value)).size === 1) {
    const value = clamp(pivot, bounds);
    return { value, expectedScore: mixtureScore(value, atoms, profile), gridPoints: 1, method: "single-atom" };
  }

  // Outside [min(t - sigma_t), max(t + sigma_t)] every term of the mixture is clamped to zero, so the
  // maximiser provably lies inside this bracket and no arbitrary margin is required.
  const reach = atoms.map((atom) => ({ low: atom.value - numericSigmaFor(atom.value, profile), high: atom.value + numericSigmaFor(atom.value, profile) }));
  const low = Math.max(bounds.minimum, reach.reduce((least, span) => Math.min(least, span.low), Number.POSITIVE_INFINITY));
  const high = Math.min(bounds.maximum, reach.reduce((most, span) => Math.max(most, span.high), Number.NEGATIVE_INFINITY));
  if (low > high) {
    const value = clamp(pivot, bounds);
    return { value, expectedScore: mixtureScore(value, atoms, profile), gridPoints: 1, method: "bounds-collapsed" };
  }

  const resolution = options.gridResolution ?? 64;
  if (!Number.isFinite(resolution) || resolution < 1) {
    throw new RangeError(`gridResolution must be at least 1; received ${String(resolution)}`);
  }
  // The cap applies per pass, not to the total, so a tight budget costs coverage but never costs the
  // refinement precision that makes the returned value stable.
  const maximumGridPoints = options.maximumGridPoints ?? 4097;
  if (!Number.isFinite(maximumGridPoints) || maximumGridPoints < 3) {
    throw new RangeError(`maximumGridPoints must be at least 3; received ${String(maximumGridPoints)}`);
  }

  // The score is a parabola of half-width sigma, so a step of sigma/resolution bounds the
  // discretisation loss at (1/resolution)^2 - 2.4e-4 of a score unit at the default 64, two orders of
  // magnitude below any difference worth logging. One refinement pass over +-one coarse step then
  // buys another factor of `resolution` without paying for a globally finer grid.
  const narrowest = atoms.reduce((least, atom) => Math.min(least, numericSigmaFor(atom.value, profile)), Number.POSITIVE_INFINITY);
  const span = high - low;
  const coarsePoints = Math.min(maximumGridPoints, Math.max(33, Math.ceil((span * resolution) / narrowest) + 1));
  const coarseStep = span / Math.max(1, coarsePoints - 1);
  const seeds = seedValues(observedValues(samples, options), options).map((value) => clamp(value, { minimum: low, maximum: high }));

  const coarse = bestOf([...gridValues(low, high, coarsePoints), ...seeds], atoms, profile, pivot);
  const refinePoints = Math.min(maximumGridPoints, Math.max(3, Math.round(resolution) * 2 + 1));
  const refined = bestOf(
    gridValues(Math.max(low, coarse.value - coarseStep), Math.min(high, coarse.value + coarseStep), refinePoints),
    atoms,
    profile,
    pivot,
    coarse
  );

  return {
    value: refined.value,
    expectedScore: refined.score,
    gridPoints: coarsePoints + seeds.length + refinePoints,
    method: "expected-score-grid"
  };
}
