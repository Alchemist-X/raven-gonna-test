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
      return `Return a predictive mean${task.unit ? ` in ${task.unit}` : ""}, not a prose-only answer.`;
    case "free_response":
      return "Return one concise canonical answer using the official entity name where possible.";
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
    taskContract(task)
  ]
    .filter(Boolean)
    .join("\n\n");
  return { systemPrompt, userPrompt };
}
