export function clampProbability(value: number, minimum = 0.01, maximum = 0.99): number {
  if (!Number.isFinite(value)) throw new TypeError(`Probability must be finite; received ${String(value)}`);
  if (minimum < 0 || maximum > 1 || minimum >= maximum) {
    throw new RangeError(`Invalid probability bounds: [${minimum}, ${maximum}]`);
  }
  return Math.min(maximum, Math.max(minimum, value));
}

export function logit(probability: number): number {
  const p = clampProbability(probability, Number.EPSILON, 1 - Number.EPSILON);
  return Math.log(p / (1 - p));
}

export function logistic(value: number): number {
  if (!Number.isFinite(value)) throw new TypeError(`Log-odds must be finite; received ${String(value)}`);
  if (value >= 0) {
    const exp = Math.exp(-value);
    return 1 / (1 + exp);
  }
  const exp = Math.exp(value);
  return exp / (1 + exp);
}

export function normalizeProbabilities(
  probabilities: Record<string, number>,
  labels?: readonly string[]
): Record<string, number> {
  const keys = labels ? [...labels] : Object.keys(probabilities);
  if (keys.length === 0) throw new Error("Cannot normalize an empty probability vector.");
  const values = keys.map((key) => {
    const value = probabilities[key] ?? 0;
    if (!Number.isFinite(value) || value < 0) throw new TypeError(`Invalid probability for ${key}: ${String(value)}`);
    return value;
  });
  const total = values.reduce((sum, value) => sum + value, 0);
  if (total <= 0) {
    const uniform = 1 / keys.length;
    return Object.fromEntries(keys.map((key) => [key, uniform]));
  }
  return Object.fromEntries(keys.map((key, index) => [key, (values[index] ?? 0) / total]));
}

export function logitPool(probabilities: readonly number[], weights?: readonly number[]): number {
  if (probabilities.length === 0) throw new Error("At least one probability is required.");
  if (weights && weights.length !== probabilities.length) throw new Error("Weights must match probabilities.");
  const actualWeights = weights ?? probabilities.map(() => 1);
  const totalWeight = actualWeights.reduce((sum, weight) => sum + weight, 0);
  if (!(totalWeight > 0)) throw new Error("At least one positive weight is required.");
  const pooled = probabilities.reduce(
    (sum, probability, index) => sum + logit(probability) * (actualWeights[index] ?? 0),
    0
  );
  return logistic(pooled / totalWeight);
}

export function blendLogOdds(value: number, prior: number, priorWeight: number): number {
  if (priorWeight < 0 || priorWeight > 1) throw new RangeError("priorWeight must be in [0,1].");
  return logistic(logit(value) * (1 - priorWeight) + logit(prior) * priorWeight);
}

export function brierScore(probability: number, outcome: 0 | 1): number {
  const p = clampProbability(probability, 0, 1);
  return (p - outcome) ** 2;
}

