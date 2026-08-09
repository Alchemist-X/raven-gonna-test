import { brierScore } from "@raven-gonna-test/forecast-core";

export interface BinaryObservation {
  probability: number;
  outcome: 0 | 1;
  weight?: number;
}

export function weightedBrier(observations: readonly BinaryObservation[]): number | null {
  if (observations.length === 0) return null;
  let weighted = 0;
  let total = 0;
  for (const observation of observations) {
    const weight = observation.weight ?? 1;
    if (!Number.isFinite(weight) || weight < 0) throw new Error(`Invalid observation weight: ${weight}`);
    weighted += brierScore(observation.probability, observation.outcome) * weight;
    total += weight;
  }
  return total > 0 ? weighted / total : null;
}

export function expectedCalibrationError(
  observations: readonly BinaryObservation[],
  binCount = 10
): number | null {
  if (observations.length === 0) return null;
  if (!Number.isInteger(binCount) || binCount < 1) throw new Error("binCount must be a positive integer.");
  const bins = Array.from({ length: binCount }, () => ({ probability: 0, outcome: 0, weight: 0 }));
  let totalWeight = 0;
  for (const observation of observations) {
    const weight = observation.weight ?? 1;
    const index = Math.min(binCount - 1, Math.floor(observation.probability * binCount));
    const bin = bins[index];
    if (!bin) continue;
    bin.probability += observation.probability * weight;
    bin.outcome += observation.outcome * weight;
    bin.weight += weight;
    totalWeight += weight;
  }
  if (totalWeight <= 0) return null;
  return bins.reduce((sum, bin) => {
    if (bin.weight === 0) return sum;
    return sum + (bin.weight / totalWeight) * Math.abs(bin.probability / bin.weight - bin.outcome / bin.weight);
  }, 0);
}

export interface ProphetScoredObservation extends BinaryObservation {
  yesAsk: number;
  noAsk: number;
}

export function prophetMarketBrier(observation: ProphetScoredObservation): number {
  const complement = 1 - observation.outcome;
  return ((observation.yesAsk - observation.outcome) ** 2 + (observation.noAsk - complement) ** 2) / 2;
}

export function prophetEdgeOverMarket(observations: readonly ProphetScoredObservation[]): {
  predictorBrier: number | null;
  marketBrier: number | null;
  edge: number | null;
  ece: number | null;
} {
  const predictorBrier = weightedBrier(observations);
  if (observations.length === 0) return { predictorBrier: null, marketBrier: null, edge: null, ece: null };
  let marketWeighted = 0;
  let total = 0;
  for (const observation of observations) {
    const weight = observation.weight ?? 1;
    marketWeighted += prophetMarketBrier(observation) * weight;
    total += weight;
  }
  const marketBrier = total > 0 ? marketWeighted / total : null;
  return {
    predictorBrier,
    marketBrier,
    edge: predictorBrier !== null && marketBrier !== null ? marketBrier - predictorBrier : null,
    ece: expectedCalibrationError(observations)
  };
}

