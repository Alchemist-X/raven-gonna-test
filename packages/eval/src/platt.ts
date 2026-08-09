import { clampProbability, logistic, logit } from "@raven-gonna-test/forecast-core";

export interface CalibrationObservation {
  probability: number;
  outcome: 0 | 1;
  weight?: number;
}

export interface PlattModel {
  schemaVersion: "raven-gonna-test.platt.v1";
  slope: number;
  intercept: number;
  sampleSize: number;
  regularization: number;
}

export function applyPlatt(probability: number, model: PlattModel): number {
  return clampProbability(logistic(model.slope * logit(probability) + model.intercept), 0.001, 0.999);
}

export function fitPlatt(
  observations: readonly CalibrationObservation[],
  options: { learningRate?: number; iterations?: number; regularization?: number } = {}
): PlattModel {
  if (observations.length < 2) throw new Error("At least two observations are required for Platt calibration.");
  const learningRate = options.learningRate ?? 0.05;
  const iterations = options.iterations ?? 2000;
  const regularization = options.regularization ?? 0.01;
  let slope = 1;
  let intercept = 0;
  for (let iteration = 0; iteration < iterations; iteration += 1) {
    let slopeGradient = regularization * (slope - 1);
    let interceptGradient = regularization * intercept;
    let totalWeight = regularization;
    for (const observation of observations) {
      const weight = observation.weight ?? 1;
      const x = logit(observation.probability);
      const predicted = logistic(slope * x + intercept);
      const error = predicted - observation.outcome;
      slopeGradient += weight * error * x;
      interceptGradient += weight * error;
      totalWeight += weight;
    }
    slope -= learningRate * slopeGradient / totalWeight;
    intercept -= learningRate * interceptGradient / totalWeight;
  }
  return {
    schemaVersion: "raven-gonna-test.platt.v1",
    slope,
    intercept,
    sampleSize: observations.length,
    regularization
  };
}

export function leaveLastRoundOut<T extends { round: string }>(rows: readonly T[]): Array<{ train: T[]; test: T[]; round: string }> {
  const rounds = [...new Set(rows.map((row) => row.round))].sort();
  return rounds.slice(1).map((round, index) => {
    const allowed = new Set(rounds.slice(0, index + 1));
    return {
      round,
      train: rows.filter((row) => allowed.has(row.round)),
      test: rows.filter((row) => row.round === round)
    };
  });
}

