import { describe, expect, it } from "vitest";
import { chooseF1Subset, type CandidateProbability } from "./set-decision.js";

/** Copy of f1() in packages/benchmarks/src/futurex/scorer.ts, including the both-empty-scores-1 convention. */
function f1(gold: readonly string[], predicted: readonly string[]): number {
  const expected = new Set(gold);
  const actual = new Set(predicted);
  const overlap = [...actual].filter((item) => expected.has(item)).length;
  if (expected.size + actual.size === 0) return 1;
  return (2 * overlap) / (expected.size + actual.size);
}

/**
 * Ground truth for every assertion below: enumerate all 2^n gold realizations under the
 * independence model and average the real f1(). Exponential, so tests stay under ~10 candidates.
 */
function enumerateExpectedF1(
  candidates: readonly CandidateProbability[],
  selected: readonly string[]
): number {
  const size = candidates.length;
  let expectation = 0;
  for (let mask = 0; mask < 1 << size; mask += 1) {
    let weight = 1;
    const gold: string[] = [];
    for (let index = 0; index < size; index += 1) {
      const candidate = candidates[index];
      if (!candidate) continue;
      if (mask & (1 << index)) {
        weight *= candidate.probability;
        gold.push(candidate.key);
      } else {
        weight *= 1 - candidate.probability;
      }
    }
    if (weight === 0) continue;
    expectation += weight * f1(gold, selected);
  }
  return expectation;
}

function bestSubsetByEnumeration(candidates: readonly CandidateProbability[]): {
  keys: string[];
  expectedF1: number;
} {
  const size = candidates.length;
  let best = { keys: [] as string[], expectedF1: -1 };
  for (let mask = 0; mask < 1 << size; mask += 1) {
    const keys = candidates.filter((_, index) => (mask & (1 << index)) !== 0).map((candidate) => candidate.key);
    const expectedF1 = enumerateExpectedF1(candidates, keys);
    if (expectedF1 > best.expectedF1) best = { keys, expectedF1 };
  }
  return best;
}

function fixedThresholdSelection(candidates: readonly CandidateProbability[], threshold = 0.5): string[] {
  return candidates.filter((candidate) => candidate.probability >= threshold).map((candidate) => candidate.key);
}

function toCandidates(probabilities: readonly number[]): CandidateProbability[] {
  return probabilities.map((probability, index) => ({ key: String.fromCharCode(97 + index), probability }));
}

/** Deterministic LCG so the property sweep is reproducible across runs and machines. */
function pseudoRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

describe("chooseF1Subset expectation", () => {
  it("matches brute-force enumeration of the real f1 for every prefix size", () => {
    const candidates = toCandidates([0.82, 0.61, 0.5, 0.33, 0.12]);
    for (let size = 0; size <= candidates.length; size += 1) {
      const decision = chooseF1Subset(candidates, { minimumSelections: size, maximumSelections: size });
      expect(decision.selected).toHaveLength(size);
      expect(decision.expectedF1).toBeCloseTo(enumerateExpectedF1(candidates, decision.selected), 12);
    }
  });

  it("reports the exact method and the number of prefix sizes it scanned", () => {
    const decision = chooseF1Subset(toCandidates([0.9, 0.4, 0.2]));
    expect(decision.method).toBe("exact-expected-f1");
    expect(decision.consideredSizes).toBe(4);
  });

  it("returns selections ordered by descending probability", () => {
    const decision = chooseF1Subset([
      { key: "low", probability: 0.55 },
      { key: "high", probability: 0.95 },
      { key: "mid", probability: 0.7 }
    ]);
    expect(decision.selected).toEqual(["high", "mid", "low"]);
  });
});

describe("chooseF1Subset versus the fixed 0.5 threshold", () => {
  it("beats the 0.5 rule on a set where the two disagree", () => {
    const candidates = toCandidates([0.8, 0.7, 0.45, 0.45, 0.4]);
    const threshold = fixedThresholdSelection(candidates);
    const decision = chooseF1Subset(candidates);

    expect(threshold).toEqual(["a", "b"]);
    expect(decision.selected).toEqual(["a", "b", "c", "d", "e"]);

    const thresholdExpectation = enumerateExpectedF1(candidates, threshold);
    const decisionExpectation = enumerateExpectedF1(candidates, decision.selected);
    expect(decisionExpectation).toBeGreaterThan(thresholdExpectation);
    expect(decision.expectedF1).toBeCloseTo(decisionExpectation, 12);

    // A concrete realization of the gold set, scored with the benchmark's own formula.
    const gold = ["a", "b", "c", "d"];
    expect(f1(gold, threshold)).toBeCloseTo(2 / 3, 12);
    expect(f1(gold, decision.selected)).toBeCloseTo(8 / 9, 12);
    expect(f1(gold, decision.selected)).toBeGreaterThan(f1(gold, threshold));
  });

  it("also disagrees when only two sub-threshold candidates trail a confident block", () => {
    const candidates = toCandidates([0.9, 0.9, 0.9, 0.9, 0.45, 0.45]);
    const threshold = fixedThresholdSelection(candidates);
    const decision = chooseF1Subset(candidates);

    expect(threshold).toHaveLength(4);
    expect(decision.selected).toHaveLength(6);
    expect(enumerateExpectedF1(candidates, decision.selected)).toBeGreaterThan(
      enumerateExpectedF1(candidates, threshold)
    );
  });

  it("agrees with the 0.5 threshold for a single candidate, which is where that rule is optimal", () => {
    expect(chooseF1Subset([{ key: "a", probability: 0.6 }]).selected).toEqual(["a"]);
    expect(chooseF1Subset([{ key: "a", probability: 0.4 }]).selected).toEqual([]);
    // Exactly 0.5 is a tie between k=0 and k=1; the documented rule prefers the smaller set.
    expect(chooseF1Subset([{ key: "a", probability: 0.5 }]).selected).toEqual([]);
  });
});

describe("chooseF1Subset prefix optimality", () => {
  it("finds the same optimum as an exhaustive search over all subsets, and that optimum is a top-k prefix", () => {
    const next = pseudoRandom(20260817);
    for (let trial = 0; trial < 24; trial += 1) {
      const candidates = toCandidates(Array.from({ length: 6 }, () => next()));
      const ordered = [...candidates].sort((a, b) => b.probability - a.probability);
      const best = bestSubsetByEnumeration(candidates);
      const decision = chooseF1Subset(candidates);

      expect(decision.expectedF1).toBeCloseTo(best.expectedF1, 12);
      const prefix = ordered.slice(0, best.keys.length).map((candidate) => candidate.key);
      expect([...best.keys].sort()).toEqual([...prefix].sort());
      expect(decision.selected).toEqual(prefix);
    }
  });
});

describe("chooseF1Subset bounds", () => {
  it("clamps the chosen size into minimumSelections and maximumSelections", () => {
    const candidates = toCandidates([0.9, 0.85, 0.8, 0.75]);
    expect(chooseF1Subset(candidates, { maximumSelections: 2 }).selected).toEqual(["a", "b"]);
    expect(chooseF1Subset(candidates, { minimumSelections: 4 }).selected).toHaveLength(4);

    const weak = toCandidates([0.02, 0.01]);
    expect(chooseF1Subset(weak).selected).toEqual([]);
    const forced = chooseF1Subset(weak, { minimumSelections: 1 });
    expect(forced.selected).toEqual(["a"]);
    expect(forced.consideredSizes).toBe(2);
  });

  it("clamps bounds that exceed the candidate count instead of inventing keys", () => {
    const decision = chooseF1Subset(toCandidates([0.9, 0.1]), { minimumSelections: 5, maximumSelections: 9 });
    expect(decision.selected).toEqual(["a", "b"]);
    expect(decision.consideredSizes).toBe(1);
  });

  it("rejects contradictory or non-integer bounds", () => {
    const candidates = toCandidates([0.9, 0.5]);
    expect(() => chooseF1Subset(candidates, { minimumSelections: 2, maximumSelections: 1 })).toThrow(/below/);
    expect(() => chooseF1Subset(candidates, { minimumSelections: -1 })).toThrow(/integer/);
    expect(() => chooseF1Subset(candidates, { maximumSelections: 1.5 })).toThrow(/integer/);
  });
});

describe("chooseF1Subset edge cases", () => {
  it("returns the empty set for no candidates, scoring 1 like the scorer does for two empty sets", () => {
    expect(chooseF1Subset([])).toEqual({
      selected: [],
      expectedF1: 1,
      consideredSizes: 1,
      method: "exact-expected-f1"
    });
  });

  it("selects nothing when every candidate is impossible", () => {
    const candidates = toCandidates([0, 0, 0]);
    const decision = chooseF1Subset(candidates);
    expect(decision.selected).toEqual([]);
    expect(decision.expectedF1).toBeCloseTo(1, 12);
    expect(chooseF1Subset(candidates, { minimumSelections: 2 }).expectedF1).toBeCloseTo(0, 12);
  });

  it("selects everything when every candidate is certain", () => {
    const decision = chooseF1Subset(toCandidates([1, 1, 1]));
    expect(decision.selected).toEqual(["a", "b", "c"]);
    expect(decision.expectedF1).toBeCloseTo(1, 12);
  });

  it("breaks probability ties by ascending key", () => {
    const decision = chooseF1Subset(
      [
        { key: "zebra", probability: 0.6 },
        { key: "apple", probability: 0.6 }
      ],
      { maximumSelections: 1 }
    );
    expect(decision.selected).toEqual(["apple"]);
  });

  it("is insensitive to input order", () => {
    const probabilities = [0.71, 0.44, 0.93, 0.12, 0.5];
    const forward = chooseF1Subset(toCandidates(probabilities));
    const reversed = chooseF1Subset([...toCandidates(probabilities)].reverse());
    expect(reversed.selected).toEqual(forward.selected);
    expect(reversed.expectedF1).toBeCloseTo(forward.expectedF1, 15);
  });

  it("rejects duplicate keys and out-of-range probabilities", () => {
    expect(() => chooseF1Subset([
      { key: "a", probability: 0.5 },
      { key: "a", probability: 0.4 }
    ])).toThrow(/Duplicate/);
    expect(() => chooseF1Subset([{ key: "a", probability: 1.2 }])).toThrow(/\[0,1\]/);
    expect(() => chooseF1Subset([{ key: "a", probability: Number.NaN }])).toThrow(/\[0,1\]/);
  });
});

describe("chooseF1Subset plug-in fallback", () => {
  it("switches to the documented plug-in above the exact limit and stays close to the exact answer", () => {
    const candidates = toCandidates([0.8, 0.7, 0.45, 0.45, 0.4]);
    const approximate = chooseF1Subset(candidates, { exactCandidateLimit: 4 });
    const exact = chooseF1Subset(candidates);

    expect(approximate.method).toBe("plugin-expected-counts");
    expect(exact.method).toBe("exact-expected-f1");
    expect(approximate.selected).toEqual(exact.selected);
    // Ratio of expectations, so the value differs from the exact expectation by design.
    expect(approximate.expectedF1).toBeGreaterThan(0);
    expect(Math.abs(approximate.expectedF1 - exact.expectedF1)).toBeLessThan(0.1);
  });

  it("keeps the plug-in defined when nothing can be selected", () => {
    const decision = chooseF1Subset(toCandidates([0, 0]), { exactCandidateLimit: 0 });
    expect(decision.method).toBe("plugin-expected-counts");
    expect(decision.selected).toEqual([]);
    expect(decision.expectedF1).toBe(1);
  });
});

describe("plug-in branch handles the empty-gold mass", () => {
  it("can select nothing when every candidate is unlikely", () => {
    // The scorer treats both-empty as a perfect 1, so the empty prediction is
    // worth P(gold empty). Without that term the empty set scored 0 and could
    // never win, however unlikely the candidates were.
    const candidates = Array.from({ length: 40 }, (_, index) => ({ key: `k${index}`, probability: 0.001 }));
    const decision = chooseF1Subset(candidates, { exactCandidateLimit: 0, minimumSelections: 0 });
    expect(decision.method).toBe("plugin-expected-counts");
    expect(decision.selected).toEqual([]);
    // P(all 40 absent) = 0.999^40 ~ 0.96, far above anything a non-empty set earns here.
    expect(decision.expectedF1).toBeGreaterThan(0.9);
  });

  it("still selects a confident candidate", () => {
    const decision = chooseF1Subset(
      [{ key: "a", probability: 0.95 }, { key: "b", probability: 0.02 }],
      { exactCandidateLimit: 0, minimumSelections: 0 }
    );
    expect(decision.selected).toEqual(["a"]);
  });
});
