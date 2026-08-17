import { describe, expect, it } from "vitest";
import {
  chooseNumericPoint,
  expectedNumericScore,
  futureXNumericProfile,
  numericScore,
  type NumericDecisionOptions
} from "./numeric-decision.js";

const raw: NumericDecisionOptions = { kernelWidth: 0 };

function arithmeticMean(values: readonly number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function trimmedMean(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const trim = sorted.length >= 5 ? Math.floor(sorted.length * 0.2) : 0;
  const kept = sorted.slice(trim, sorted.length - trim || sorted.length);
  return kept.reduce((sum, value) => sum + value, 0) / kept.length;
}

function pseudoRandom(seed: number): () => number {
  let state = (seed * 2654435761) >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

function generateSamples(next: () => number): number[] {
  const count = 2 + Math.floor(next() * 6);
  const centre = (next() - 0.5) * 2000;
  const spread = Math.abs(centre) * (0.01 + next() * 0.4) + next();
  const modeGap = next() < 0.5 ? spread * 8 : 0;
  return Array.from({ length: count }, (_, index) =>
    centre + (next() - 0.5) * spread + (index % 2 === 0 ? 0 : modeGap)
  );
}

describe("numericScore", () => {
  it("reproduces the FutureX github-5pct-truth parabola", () => {
    expect(numericScore(100, 100)).toBe(1);
    expect(numericScore(102.5, 100)).toBeCloseTo(0.75, 12);
    expect(numericScore(105, 100)).toBe(0);
    expect(numericScore(1000, 100)).toBe(0);
    expect(numericScore(-100, -100)).toBe(1);
    expect(numericScore(-105, -100)).toBe(0);
  });

  it("falls back to the absolute sigma when the truth is exactly zero", () => {
    expect(futureXNumericProfile).toEqual({ relativeSigma: 0.05, zeroSigma: 0.01 });
    expect(numericScore(0.005, 0)).toBeCloseTo(0.75, 12);
    expect(numericScore(0.01, 0)).toBe(0);
  });
});

describe("chooseNumericPoint edge cases", () => {
  it("rejects an empty sample set with an actionable message", () => {
    expect(() => chooseNumericPoint([])).toThrow(/at least one numeric sample/);
  });

  it("rejects non-finite samples", () => {
    expect(() => chooseNumericPoint([1, Number.NaN])).toThrow(/finite/);
    expect(() => chooseNumericPoint([1, Number.POSITIVE_INFINITY])).toThrow(/finite/);
  });

  it("returns the only sample without searching", () => {
    expect(chooseNumericPoint([42])).toEqual({
      value: 42,
      expectedScore: 1,
      gridPoints: 1,
      method: "single-atom"
    });
  });

  it("collapses identical samples to their common value", () => {
    expect(chooseNumericPoint([7, 7, 7])).toMatchObject({ value: 7, expectedScore: 1, method: "single-atom" });
  });

  it("handles samples containing zero without dividing by a zero sigma", () => {
    const decision = chooseNumericPoint([0, 0, 1]);
    expect(decision.value).toBeCloseTo(0, 6);
    expect(decision.expectedScore).toBeCloseTo(2 / 3, 3);
  });

  it("handles negative samples symmetrically", () => {
    const decision = chooseNumericPoint([-100, -102, -98]);
    expect(decision.value).toBeCloseTo(-100, 0);
    expect(decision.expectedScore).toBeGreaterThan(0.5);
  });

  it("prefers a non-zero atom in the truth-near-zero regime", () => {
    // sigma is 0.01 at truth 0 but only 5e-6 at truth 1e-4, so a point sitting on either outer atom
    // still collects almost all of the zero atom's mass while a point at 0 collects nothing else.
    const samples = [-0.0001, 0, 0.0001];
    const decision = chooseNumericPoint(samples);
    expect(Math.abs(decision.value)).toBeCloseTo(0.0001, 5);
    expect(decision.expectedScore).toBeGreaterThan(expectedNumericScore(0, samples));
  });
});

describe("chooseNumericPoint against the FutureX objective", () => {
  it("stays at the centre of a tight unimodal ensemble", () => {
    const samples = [100, 102, 104];
    const decision = chooseNumericPoint(samples);
    // Tolerance is 5% of sigma (sigma is ~5.1 here). The optimum is the precision-weighted centre,
    // which differs from the arithmetic mean only because sigma grows with the candidate truth.
    expect(decision.value).toBeCloseTo(arithmeticMean(samples), 0);
    expect(Math.abs(decision.value - arithmeticMean(samples))).toBeLessThan(0.05 * 5.1);
    expect(decision.method).toBe("expected-score-grid");
    expect(decision.gridPoints).toBeGreaterThan(1);
  });

  it("sits on a mode of a bimodal ensemble and beats the arithmetic mean outright", () => {
    const samples = [99, 100, 101, 199, 200, 201];
    const mean = arithmeticMean(samples);
    const decision = chooseNumericPoint(samples);

    // Both incumbent estimators land in the dead zone at ~150, where every term of the mixture is
    // clamped to zero. This inequality is the entire justification for the module.
    expect(expectedNumericScore(mean, samples, raw)).toBe(0);
    expect(expectedNumericScore(trimmedMean(samples), samples, raw)).toBe(0);
    expect(expectedNumericScore(decision.value, samples, raw)).toBeGreaterThan(
      expectedNumericScore(mean, samples, raw)
    );
    expect(expectedNumericScore(decision.value, samples, raw)).toBeGreaterThan(0.45);

    // Of the two modes it takes the upper one: sigma is 10 at truth 200 but only 5 at truth 100, so
    // the same +-1 trial scatter costs less there.
    expect(decision.value).toBeCloseTo(200, 0);
    expect(decision.value).toBeGreaterThan(190);
  });

  it("beats the trimmed mean the incumbent aggregator uses", () => {
    const samples = [10, 10.2, 10.4, 30, 30.1, 30.3, 30.5];
    const decision = chooseNumericPoint(samples);
    expect(expectedNumericScore(decision.value, samples, raw)).toBeGreaterThan(
      expectedNumericScore(trimmedMean(samples), samples, raw)
    );
  });

  it("never scores below the arithmetic or trimmed mean it replaces", () => {
    let strictWins = 0;
    for (let seed = 1; seed <= 120; seed += 1) {
      const samples = generateSamples(pseudoRandom(seed));
      for (const options of [{}, raw]) {
        const decision = chooseNumericPoint(samples, options);
        const mean = expectedNumericScore(arithmeticMean(samples), samples, options);
        expect(decision.expectedScore + 1e-12).toBeGreaterThanOrEqual(mean);
        expect(decision.expectedScore + 1e-12).toBeGreaterThanOrEqual(
          expectedNumericScore(trimmedMean(samples), samples, options)
        );
        if (decision.expectedScore > mean + 1e-9) strictWins += 1;
      }
    }
    // Guards against an implementation that satisfies the inequality by just returning the mean.
    expect(strictWins).toBeGreaterThan(200);
  });

  it("reports the expected score of the value it returns", () => {
    const samples = [4, 4.4, 9, 9.2];
    const decision = chooseNumericPoint(samples);
    expect(decision.expectedScore).toBeCloseTo(expectedNumericScore(decision.value, samples), 12);
  });
});

describe("chooseNumericPoint controls", () => {
  it("is stable when the grid resolution is quadrupled", () => {
    const samples = [100, 102, 104, 130];
    const coarse = chooseNumericPoint(samples, { gridResolution: 64 });
    const fine = chooseNumericPoint(samples, { gridResolution: 256 });
    // A step of sigma/64 bounds the discretisation loss at (1/64)^2; the located optimum must not
    // move by more than a hundredth of sigma when the step shrinks.
    expect(Math.abs(coarse.value - fine.value)).toBeLessThan(0.01 * 5);
    expect(Math.abs(coarse.expectedScore - fine.expectedScore)).toBeLessThan(1e-4);
  });

  it("smears atoms so three trials behave like a distribution", () => {
    const samples = [100, 140, 180];
    const spiky = chooseNumericPoint(samples, { kernelWidth: 0 });
    const smeared = chooseNumericPoint(samples, { kernelWidth: 12 });
    expect(spiky.expectedScore).toBeCloseTo(1 / 3, 6);
    expect(smeared.expectedScore).toBeLessThan(spiky.expectedScore);
    expect(smeared.value).toBeGreaterThan(100);
  });

  it("rejects a negative kernel width", () => {
    expect(() => chooseNumericPoint([1, 2], { kernelWidth: -1 })).toThrow(/kernelWidth/);
  });

  it("folds elicited quantiles into the empirical distribution", () => {
    const decision = chooseNumericPoint([100], {
      quantiles: { p10: 190, p50: 200, p90: 210 },
      quantileWeight: 3
    });
    expect(decision.value).toBeGreaterThan(190);
    expect(decision.value).toBeLessThan(210);
  });

  it("ignores a quantile block with zero weight", () => {
    const decision = chooseNumericPoint([100, 101], {
      quantiles: { p10: 190, p50: 200, p90: 210 },
      quantileWeight: 0
    });
    expect(decision.value).toBeLessThan(110);
  });

  it("accepts extra samples alongside the trial values", () => {
    const decision = chooseNumericPoint([100], { extraSamples: [200, 201, 199] });
    expect(decision.value).toBeCloseTo(200, 0);
  });

  it("clamps the answer to the declared bounds", () => {
    expect(chooseNumericPoint([100, 102, 104], { maximum: 101 }).value).toBeLessThanOrEqual(101);
    expect(chooseNumericPoint([100, 102, 104], { minimum: 103 }).value).toBeGreaterThanOrEqual(103);
  });

  it("collapses to the nearest bound when the bounds exclude every scoring atom", () => {
    const decision = chooseNumericPoint([100, 102, 104], { minimum: 200 });
    expect(decision).toMatchObject({ value: 200, expectedScore: 0, method: "bounds-collapsed" });
  });

  it("rejects contradictory bounds and profiles", () => {
    expect(() => chooseNumericPoint([1, 2], { minimum: 5, maximum: 1 })).toThrow(/minimum/);
    expect(() => chooseNumericPoint([1, 2], { profile: { relativeSigma: 0, zeroSigma: 0.01 } })).toThrow(/relativeSigma/);
    expect(() => chooseNumericPoint([1, 2], { gridResolution: 0 })).toThrow(/gridResolution/);
    expect(() => chooseNumericPoint([1, 2], { maximumGridPoints: 2 })).toThrow(/maximumGridPoints/);
  });

  it("honours an alternative scoring profile", () => {
    const samples = [100, 130];
    const tight = chooseNumericPoint(samples, { profile: { relativeSigma: 0.05, zeroSigma: 0.01 }, kernelWidth: 0 });
    const loose = chooseNumericPoint(samples, { profile: { relativeSigma: 0.5, zeroSigma: 0.01 }, kernelWidth: 0 });
    expect(tight.expectedScore).toBeCloseTo(0.5, 6);
    expect(loose.expectedScore).toBeGreaterThan(0.9);
  });
});
