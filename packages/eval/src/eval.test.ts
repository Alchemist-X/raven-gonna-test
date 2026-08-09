import { describe, expect, it } from "vitest";
import { applyPlatt, fitPlatt, prophetEdgeOverMarket, weightedBrier } from "./index.js";

describe("evaluation metrics", () => {
  it("computes Brier and Prophet edge over matched market", () => {
    expect(weightedBrier([{ probability: 0.8, outcome: 1 }])).toBeCloseTo(0.04);
    const score = prophetEdgeOverMarket([{
      probability: 0.8,
      outcome: 1,
      yesAsk: 0.7,
      noAsk: 0.35
    }]);
    expect(score.predictorBrier).toBeCloseTo(0.04);
    expect(score.marketBrier).toBeCloseTo((0.09 + 0.1225) / 2);
    expect(score.edge).toBeGreaterThan(0);
  });
});

describe("Platt calibration", () => {
  it("fits a finite calibration model", () => {
    const model = fitPlatt([
      { probability: 0.1, outcome: 0 },
      { probability: 0.2, outcome: 0 },
      { probability: 0.8, outcome: 1 },
      { probability: 0.9, outcome: 1 }
    ], { iterations: 200 });
    expect(Number.isFinite(model.slope)).toBe(true);
    expect(applyPlatt(0.8, model)).toBeGreaterThan(0.5);
  });
});
