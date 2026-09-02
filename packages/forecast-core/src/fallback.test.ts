import { describe, expect, it } from "vitest";
import { ForecastAnswerSchema, ForecastTaskSchema, type ForecastTask } from "./contracts.js";
import { defaultAnswerForTask, isDegenerateAnswer } from "./fallback.js";

const BASE = {
  taskId: "task-1",
  origin: { benchmark: "futurex", roundId: "round-1", externalId: "q-1" },
  prompt: "Will the launch slip past Q4?",
  asOfUtc: "2026-08-01T00:00:00.000Z",
  resolution: { criteria: "official announcement" }
};

function buildTask(overrides: Record<string, unknown>): ForecastTask {
  return ForecastTaskSchema.parse({ ...BASE, ...overrides });
}

const EVERY_KIND: ForecastTask[] = [
  buildTask({ kind: "binary_probability" }),
  buildTask({ kind: "categorical", choices: ["A", "B", "C"] }),
  buildTask({ kind: "multi_label", choices: ["A", "B", "C"] }),
  buildTask({ kind: "ranking", candidates: ["A", "B", "C"], rankCount: 2 }),
  buildTask({ kind: "numeric" }),
  buildTask({ kind: "free_response" })
];

describe("defaultAnswerForTask", () => {
  it("returns a schema-valid answer of the matching kind for every task kind", () => {
    const expected: Record<ForecastTask["kind"], string> = {
      binary_probability: "binary",
      categorical: "categorical",
      multi_label: "multi_label",
      ranking: "ranking",
      numeric: "numeric",
      free_response: "free_response"
    };
    for (const task of EVERY_KIND) {
      const answer = defaultAnswerForTask(task);
      expect(() => ForecastAnswerSchema.parse(answer)).not.toThrow();
      expect(answer.kind).toBe(expected[task.kind]);
    }
  });

  it("is deterministic: the same task twice yields identical output", () => {
    for (const task of EVERY_KIND) {
      expect(defaultAnswerForTask(task)).toEqual(defaultAnswerForTask(task));
    }
    // Distinct task objects with identical content must also agree, so an
    // artifact replay reproduces the submitted row byte for byte.
    expect(defaultAnswerForTask(buildTask({ kind: "categorical", choices: ["Yes", "No"] }))).toEqual(
      defaultAnswerForTask(buildTask({ kind: "categorical", choices: ["Yes", "No"] }))
    );
  });

  it("prices a binary task at the coin flip", () => {
    const answer = defaultAnswerForTask(buildTask({ kind: "binary_probability" }));
    expect(answer).toEqual({ kind: "binary", pYes: 0.5 });
  });

  it("ignores a supplied prior, because a failed run never read it", () => {
    const answer = defaultAnswerForTask(buildTask({ kind: "binary_probability", priorProbability: 0.9 }));
    expect(answer).toEqual({ kind: "binary", pYes: 0.5 });
  });
});

describe("defaultAnswerForTask categorical", () => {
  it("spreads probability uniformly over the choices", () => {
    const answer = defaultAnswerForTask(buildTask({ kind: "categorical", choices: ["A", "B", "C", "D"] }));
    if (answer.kind !== "categorical") throw new Error("expected a categorical answer");
    expect(Object.values(answer.probabilities)).toEqual([0.25, 0.25, 0.25, 0.25]);
    expect(Object.keys(answer.probabilities)).toEqual(["A", "B", "C", "D"]);
  });

  it("emits the negative option when the choice set is a yes/no pair", () => {
    const yesFirst = defaultAnswerForTask(buildTask({ kind: "categorical", choices: ["Yes", "No"] }));
    const noFirst = defaultAnswerForTask(buildTask({ kind: "categorical", choices: ["No", "Yes"] }));
    if (yesFirst.kind !== "categorical" || noFirst.kind !== "categorical") throw new Error("expected categorical answers");
    expect(yesFirst.choice).toBe("No");
    expect(noFirst.choice).toBe("No");
  });

  it("falls back to the first choice when no option is a negation", () => {
    const answer = defaultAnswerForTask(buildTask({ kind: "categorical", choices: ["A", "B"] }));
    if (answer.kind !== "categorical") throw new Error("expected a categorical answer");
    expect(answer.choice).toBe("A");
  });

  it("matches the negative option case- and space-insensitively", () => {
    const answer = defaultAnswerForTask(buildTask({ kind: "categorical", choices: ["It happens", " NONE "] }));
    if (answer.kind !== "categorical") throw new Error("expected a categorical answer");
    expect(answer.choice).toBe(" NONE ");
  });
});

describe("defaultAnswerForTask multi_label", () => {
  it("selects every choice, because set-F1 rises with coverage when nothing is known", () => {
    const answer = defaultAnswerForTask(buildTask({ kind: "multi_label", choices: ["A", "B", "C"] }));
    if (answer.kind !== "multi_label") throw new Error("expected a multi_label answer");
    expect(answer.selected).toEqual(["A", "B", "C"]);
    expect(Object.values(answer.probabilities)).toEqual([0.5, 0.5, 0.5]);
  });

  it("never exceeds maximumSelections", () => {
    const answer = defaultAnswerForTask(
      buildTask({ kind: "multi_label", choices: ["A", "B", "C", "D"], maximumSelections: 2 })
    );
    if (answer.kind !== "multi_label") throw new Error("expected a multi_label answer");
    expect(answer.selected).toEqual(["A", "B"]);
  });

  it("honours minimumSelections, including a zero minimum", () => {
    const floored = defaultAnswerForTask(
      buildTask({ kind: "multi_label", choices: ["A", "B", "C"], minimumSelections: 2, maximumSelections: 2 })
    );
    if (floored.kind !== "multi_label") throw new Error("expected a multi_label answer");
    expect(floored.selected).toHaveLength(2);

    const zeroMinimum = defaultAnswerForTask(
      buildTask({ kind: "multi_label", choices: ["A", "B"], minimumSelections: 0 })
    );
    if (zeroMinimum.kind !== "multi_label") throw new Error("expected a multi_label answer");
    // A zero floor is a licence to abstain, and R1 says never abstain.
    expect(zeroMinimum.selected).toEqual(["A", "B"]);
  });

  it("selects distinct labels drawn from the task choices", () => {
    const task = buildTask({ kind: "multi_label", choices: ["A", "B", "C"], maximumSelections: 2 });
    const answer = defaultAnswerForTask(task);
    if (answer.kind !== "multi_label" || task.kind !== "multi_label") throw new Error("expected a multi_label pair");
    expect(new Set(answer.selected).size).toBe(answer.selected.length);
    expect(answer.selected.every((label) => task.choices.includes(label))).toBe(true);
  });
});

describe("defaultAnswerForTask ranking", () => {
  it("keeps the given candidate order and truncates to rankCount", () => {
    const answer = defaultAnswerForTask(
      buildTask({ kind: "ranking", candidates: ["A", "B", "C", "D"], rankCount: 3 })
    );
    if (answer.kind !== "ranking") throw new Error("expected a ranking answer");
    expect(answer.order).toEqual(["A", "B", "C"]);
  });

  it("emits stable sentinels when an open ranking still requires an exact count", () => {
    const answer = defaultAnswerForTask(buildTask({ kind: "ranking", candidates: [], rankCount: 3 }));
    if (answer.kind !== "ranking") throw new Error("expected a ranking answer");
    expect(answer.order).toEqual(["unknown_1", "unknown_2", "unknown_3"]);
    expect(() => ForecastAnswerSchema.parse(answer)).not.toThrow();
    expect(isDegenerateAnswer(answer)).toBe(true);
  });

  it("scores every ranked candidate equally so the row is detectably uninformative", () => {
    const answer = defaultAnswerForTask(buildTask({ kind: "ranking", candidates: ["A", "B", "C"], rankCount: 2 }));
    if (answer.kind !== "ranking") throw new Error("expected a ranking answer");
    expect(new Set(Object.values(answer.scores ?? {})).size).toBe(1);
  });
});

describe("defaultAnswerForTask numeric", () => {
  it("minimises worst-case RELATIVE error between bounds, since sigma scales with |truth|", () => {
    const answer = defaultAnswerForTask(buildTask({ kind: "numeric", minimum: 10, maximum: 30 }));
    if (answer.kind !== "numeric") throw new Error("expected a numeric answer");
    // Harmonic mean of [10,30] = 15, not the arithmetic midpoint 20.
    expect(answer.value).toBeCloseTo(15, 10);

    // Assert the property rather than the constant: no point in the interval
    // has a lower worst-case relative error than the one we return.
    const worstRelative = (guess: number): number =>
      Math.max(Math.abs(guess - 10) / 10, Math.abs(guess - 30) / 30);
    const ours = worstRelative(answer.value);
    for (let candidate = 10; candidate <= 30; candidate += 0.05) {
      expect(worstRelative(candidate)).toBeGreaterThanOrEqual(ours - 1e-9);
    }
    // The arithmetic midpoint is strictly worse, which is why this changed.
    expect(worstRelative(20)).toBeGreaterThan(ours);
  });

  it("falls back to the arithmetic midpoint when the interval touches zero", () => {
    // Relative error is undefined at the crossing, so the harmonic form does not apply.
    const answer = defaultAnswerForTask(buildTask({ kind: "numeric", minimum: -10, maximum: 30 }));
    expect(answer).toEqual({ kind: "numeric", value: 10 });
  });

  it("answers zero when unbounded", () => {
    const answer = defaultAnswerForTask(buildTask({ kind: "numeric" }));
    expect(answer).toEqual({ kind: "numeric", value: 0 });
  });

  it("clamps zero into a one-sided admissible range", () => {
    expect(defaultAnswerForTask(buildTask({ kind: "numeric", minimum: 5 }))).toEqual({ kind: "numeric", value: 5 });
    expect(defaultAnswerForTask(buildTask({ kind: "numeric", maximum: -4 }))).toEqual({ kind: "numeric", value: -4 });
    expect(defaultAnswerForTask(buildTask({ kind: "numeric", minimum: -8 }))).toEqual({ kind: "numeric", value: 0 });
  });

  it("carries the unit only when the task declares one", () => {
    const withUnit = defaultAnswerForTask(buildTask({ kind: "numeric", unit: "USD millions" }));
    expect(withUnit).toEqual({ kind: "numeric", value: 0, unit: "USD millions" });
    const withoutUnit = defaultAnswerForTask(buildTask({ kind: "numeric" }));
    // exactOptionalPropertyTypes: the key must be absent, not present-and-undefined.
    expect("unit" in withoutUnit).toBe(false);
  });
});

describe("defaultAnswerForTask free_response", () => {
  it("emits a non-empty placeholder, because the schema rejects an empty string", () => {
    const answer = defaultAnswerForTask(buildTask({ kind: "free_response" }));
    if (answer.kind !== "free_response") throw new Error("expected a free_response answer");
    expect(answer.value.length).toBeGreaterThan(0);
    expect(() => ForecastAnswerSchema.parse(answer)).not.toThrow();
    expect(isDegenerateAnswer(answer)).toBe(true);
  });
});

describe("isDegenerateAnswer", () => {
  it("flags every default answer except the numeric one", () => {
    const flags = EVERY_KIND.map((task) => [task.kind, isDegenerateAnswer(defaultAnswerForTask(task))] as const);
    expect(Object.fromEntries(flags)).toEqual({
      binary_probability: true,
      categorical: true,
      multi_label: true,
      ranking: true,
      numeric: false,
      free_response: true
    });
  });

  it("clears answers that carry information", () => {
    expect(isDegenerateAnswer({ kind: "binary", pYes: 0.82 })).toBe(false);
    expect(isDegenerateAnswer({ kind: "categorical", choice: "A", probabilities: { A: 0.7, B: 0.3 } })).toBe(false);
    expect(isDegenerateAnswer({ kind: "multi_label", selected: ["A"], probabilities: { A: 0.8, B: 0.1 } })).toBe(false);
    expect(isDegenerateAnswer({ kind: "ranking", order: ["A", "B"], scores: { A: 2, B: 1 } })).toBe(false);
    expect(isDegenerateAnswer({ kind: "numeric", value: 1234.5 })).toBe(false);
    expect(isDegenerateAnswer({ kind: "free_response", value: "Real Madrid" })).toBe(false);
  });

  it("does not flag a ranking that simply omits scores", () => {
    expect(isDegenerateAnswer({ kind: "ranking", order: ["A", "B"] })).toBe(false);
  });

  it("flags an empty multi_label selection as an abstention", () => {
    expect(isDegenerateAnswer({ kind: "multi_label", selected: [], probabilities: { A: 0.9, B: 0.2 } })).toBe(true);
  });

  it("flags the usual non-answer strings", () => {
    expect(isDegenerateAnswer({ kind: "free_response", value: "  Unknown " })).toBe(true);
    expect(isDegenerateAnswer({ kind: "free_response", value: "N/A" })).toBe(true);
  });
});
