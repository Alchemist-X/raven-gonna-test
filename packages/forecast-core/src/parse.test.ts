import { describe, expect, it } from "vitest";
import {
  extractAnswerBlock,
  extractJsonLenient,
  salvageChoice,
  salvageNumber,
  salvageProbability,
  scanBalancedJson
} from "./parse.js";

describe("extractAnswerBlock", () => {
  it("prefers the answer tag, then a fenced block, then the raw text", () => {
    expect(extractAnswerBlock('prose <answer>{"a":1}</answer> more')).toBe('{"a":1}');
    expect(extractAnswerBlock('prose\n```json\n{"a":1}\n```\n')).toBe('{"a":1}');
    expect(extractAnswerBlock("  just text  ")).toBe("just text");
    // An empty tag must not win over a usable fenced block.
    expect(extractAnswerBlock('<answer>  </answer>\n```json\n{"a":2}\n```')).toBe('{"a":2}');
  });
});

describe("scanBalancedJson", () => {
  it("finds the first balanced value embedded in prose", () => {
    expect(scanBalancedJson('Analysis follows. {"probability": 0.62} Done.')).toEqual({ probability: 0.62 });
    expect(scanBalancedJson("Ranking: [\"a\", \"b\"] end")).toEqual(["a", "b"]);
  });

  it("ignores braces inside string literals rather than closing early", () => {
    expect(scanBalancedJson('{"note": "a } brace", "value": 3}')).toEqual({ note: "a } brace", value: 3 });
    expect(scanBalancedJson('{"escaped": "quote \\" and } here", "v": 1}')).toEqual({
      escaped: 'quote " and } here',
      v: 1
    });
  });

  it("returns null instead of throwing on unparseable text", () => {
    // The old extractor sliced first "{" to last "}" and called JSON.parse
    // unguarded, so this threw and deleted the trial.
    expect(scanBalancedJson("costs {rose} then {fell} sharply")).toBeNull();
    expect(scanBalancedJson("no structure at all")).toBeNull();
  });

  it("skips a malformed opener and keeps scanning for a valid one", () => {
    expect(scanBalancedJson('{not json} then {"real": true}')).toEqual({ real: true });
  });
});

describe("extractJsonLenient", () => {
  it("never throws, falling back to the trimmed text", () => {
    expect(extractJsonLenient("Probably yes, around 85%.")).toBe("Probably yes, around 85%.");
  });

  it("finds JSON outside the answer block when the block is prose", () => {
    expect(extractJsonLenient('<answer>see above</answer> {"value": 7}')).toEqual({ value: 7 });
  });

  it("reproduces the real failure: markdown research ending in an answer tag", () => {
    const reply = [
      "## Analysis",
      "Guidance is **$3.30 ± $0.15** (range $3.15 to $3.45), so the threshold {of $3.00} is cleared.",
      '<answer>{"probabilities": {"Yes": 0.92, "No": 0.08}}</answer>'
    ].join("\n\n");
    expect(extractJsonLenient(reply)).toEqual({ probabilities: { Yes: 0.92, No: 0.08 } });
  });
});

describe("salvage helpers", () => {
  it("recovers a probability from prose and rejects out-of-range figures", () => {
    expect(salvageProbability("I put the probability at 85%.")).toBeCloseTo(0.85, 10);
    expect(salvageProbability("probability: 0.42")).toBeCloseTo(0.42, 10);
    expect(salvageProbability("roughly 7% likely")).toBeCloseTo(0.07, 10);
    expect(salvageProbability("no numbers here")).toBeNull();
    // 250% is not a probability; refuse rather than invent one.
    expect(salvageProbability("revenue grew 250%")).toBeNull();
  });

  it("keeps a numeric answer at its natural scale, unlike a probability", () => {
    // The scoring gold for "what exact CPI rate" is 2.7, not 0.027 — the
    // percent-to-fraction conversion that suits probabilities destroys this.
    expect(salvageNumber("CPI came in at 2.7%")).toBeCloseTo(2.7, 10);
    expect(salvageNumber("receipts of 1,234.5 million")).toBeCloseTo(1234.5, 10);
    expect(salvageNumber("a balance of -512.25")).toBeCloseTo(-512.25, 10);
    expect(salvageNumber("no figure")).toBeNull();
  });

  it("reads a stated choice out of prose, preferring the concluding mention", () => {
    expect(salvageChoice("Yes seemed likely early, but the answer is No.", ["Yes", "No"])).toBe("No");
    expect(salvageChoice("Final: \\boxed{A}", ["A", "B"])).toBe("A");
    expect(salvageChoice("no signal at all", ["Yes", "Maybe"])).toBeNull();
  });

  it("matches whole words only, so 'No' is not found inside 'nothing' or 'cannot'", () => {
    expect(salvageChoice("nothing relevant", ["Yes", "No"])).toBeNull();
    expect(salvageChoice("we cannot know for certain", ["Yes", "No"])).toBeNull();
    expect(salvageChoice("Nothing conclusive, so: No.", ["Yes", "No"])).toBe("No");
  });

  it("handles multi-word and regex-special choice labels", () => {
    expect(salvageChoice("the winner is Real Madrid", ["Real Madrid", "Barcelona"])).toBe("Real Madrid");
    expect(salvageChoice("settles at 3.00% (unchanged)", ["3.00%", "not 3.00%"])).toBe("3.00%");
  });
});
