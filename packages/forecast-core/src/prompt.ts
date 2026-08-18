import type { ForecastTask, InformationPolicy } from "./contracts.js";

export function answerTypeForTask(
  task: ForecastTask
): "binary" | "continuous" | "multiple_choice" | "free_response" | "auto" {
  if (task.kind === "binary_probability") return "binary";
  if (task.kind === "numeric") return "continuous";
  if (task.kind === "categorical") return "multiple_choice";
  if (task.kind === "multi_label") return "free_response";
  return "free_response";
}

/**
 * The literal shape each kind must emit. Stating this is not cosmetic: the
 * parser looks for an <answer> block containing JSON, but nothing used to ask
 * the model for one. A model that reasons in prose and never emits the block
 * fails to parse, and a failed parse deletes the trial entirely.
 */
function answerShape(task: ForecastTask): string {
  switch (task.kind) {
    case "binary_probability":
      return '{"probability": 0.62}';
    case "categorical":
      return `{"probabilities": {${task.choices.map((choice) => `"${choice}": 0.5`).join(", ")}}}`;
    case "multi_label":
      return '{"probabilities": {"A": 0.7, "B": 0.2}, "selected": ["A"]}';
    case "ranking":
      return '{"ranking": ["first", "second"]}';
    case "numeric":
      return '{"value": 123.45}';
    case "free_response":
      return '{"answer": "Official Entity Name"}';
  }
}

function taskContract(task: ForecastTask): string {
  switch (task.kind) {
    case "binary_probability":
      return "Return the calibrated probability of YES as a number from 0 to 1.";
    case "categorical":
      return `Return probabilities for exactly these choices, summing to one: ${task.choices.join(", ")}.`;
    case "multi_label":
      return `Estimate each option independently. Return JSON exactly like {"probabilities":{"A":0.7},"selected":["A"]}; do not force the probabilities to sum to one. Options: ${task.choices.join(", ")}.`;
    case "ranking":
      return task.candidates.length > 0
        ? `Return exactly ${task.rankCount} candidates in predicted order. Candidates: ${task.candidates.join(", ")}.`
        : `Return exactly ${task.rankCount} canonical entity names in predicted order as a JSON array.`;
    case "numeric":
      if (task.integerValued) {
        return `Return a whole number — this quantity is a count and cannot be fractional${task.unit ? ` (field: \`${task.unit}\`)` : ""}. Bare integer only: no units, commas, decimals, or ranges.`;
      }
      return task.unit
        ? `Return the value for the published field \`${task.unit}\`, in exactly that field's units and scale — read the field name carefully (for example _usd_millions means millions, _percent means percentage points such as 2.7, not 0.027). Bare number only: no units, commas, or ranges.`
        : "Return a single numeric value, not a prose-only answer. Bare number only: no units, commas, or ranges.";
    case "free_response":
      // Graded by exact string match, so a sentence, a gloss or a hedge all
      // score 0 — and an "unknown" scores the same as a wrong guess, which
      // makes hedging pure downside.
      return (
        "Return ONLY the official entity name or value — no sentence, no explanation, no parenthetical, " +
        "no units or qualifiers. It is graded by exact string match. If the outcome is not yet announced, " +
        "still commit to your single most likely answer; refusing or writing \"not yet confirmed\" scores zero, " +
        "exactly as a wrong guess would, so there is nothing to gain by hedging."
      );
  }
}

export function buildPrompts(task: ForecastTask, policy: InformationPolicy): { systemPrompt: string; userPrompt: string } {
  const marketInstruction =
    policy.predictionMarket === "deny"
      ? "Do not use prediction-market prices or crowd probabilities."
      : policy.predictionMarket === "resolution_metadata_only"
        ? "Prediction-market pages may only define structure or resolution rules; ignore prices."
        : policy.predictionMarket === "anchor"
          ? "Treat the supplied/current prediction-market probability as a strong prior, and move only for incremental evidence."
          : "Prediction-market information may be observed but is not automatically authoritative.";
  const webInstruction = policy.web === "allow" ? "Current research is allowed." : "Do not use live web research.";
  const systemPrompt = [
    "You are a calibrated forecaster. Optimize truthful out-of-sample accuracy, not persuasion.",
    `Evidence cutoff: ${policy.asOfUtc}. Never use information first available after this timestamp.`,
    marketInstruction,
    webInstruction,
    "Read the exact resolution criteria before forecasting. Distinguish base rates from case-specific evidence.",
    "Avoid extreme confidence without direct, authoritative, time-valid evidence."
  ].join("\n");
  const userPrompt = [
    `Question:\n${task.prompt}`,
    `Resolution criteria:\n${task.resolution.criteria || "Use the question's explicit criteria."}`,
    task.resolution.dateUtc ? `Resolution date: ${task.resolution.dateUtc}` : "",
    taskContract(task),
    // Research freely above, but the final line must be machine-readable.
    `Reason first if useful, then END your reply with the answer wrapped in <answer> tags, containing only JSON:\n<answer>${answerShape(task)}</answer>`
  ]
    .filter(Boolean)
    .join("\n\n");
  return { systemPrompt, userPrompt };
}
