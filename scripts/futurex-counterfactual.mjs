import { readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { numericScore } from "../packages/forecast-core/dist/index.js";

const inputUrl = new URL("../rounds/futurex/reviews/2026-09-09/effort-ranking-input.json", import.meta.url);
const raw = await readFile(inputUrl);
const input = JSON.parse(raw);
if (Object.values(input.levelCounts).reduce((a, b) => a + b, 0) !== 74) throw new Error("Expected the frozen 74-question round.");
const profile = { relativeSigma: 0.05, zeroSigma: 0.01 };
const weight = (row) => 100 * input.levelWeights[row.level] / input.levelCounts[row.level];
const score = (row, prediction = Number(row.prediction)) => {
  if (row.groundTruth.length !== 1 || !Number.isFinite(Number(row.groundTruth[0])) || !Number.isFinite(prediction)) throw new Error(`Invalid numeric input: ${row.id}`);
  return numericScore(prediction, Number(row.groundTruth[0]), profile);
};
const rank = (value, other = []) => {
  // The input captures the verified top five, enough only for scores above fifth place.
  if (value <= input.leaders.at(-1).score) throw new Error("Need the full leaderboard for this score.");
  return 1 + [...input.leaders.map((row) => row.score), ...other].filter((x) => x > value).length;
};
const models = Object.fromEntries(Object.entries(input.models).map(([name, model]) => {
  if (model.unitCases.length !== 4 || model.targetCases.length !== 2) throw new Error("Expected four unit cases and two target cases per model.");
  const unitCases = model.unitCases.map((row) => {
    const converted = Number(row.prediction) * row.multiplier;
    return { ...row, converted, before: score(row), after: score(row, converted), weightedDelta: (score(row, converted) - score(row)) * weight(row) };
  });
  const unitDelta = unitCases.reduce((sum, row) => sum + row.weightedDelta, 0);
  const unitsOnly = model.officialScore + unitDelta;
  const scenarios = [0, 0.5, 1].map((targetScore) => {
    const targetDelta = model.targetCases.reduce((sum, row) => sum + (targetScore - score(row)) * weight(row), 0);
    const combinedScore = unitsOnly + targetDelta;
    return { assumedScoreOnEachTargetCase: targetScore, targetDelta, combinedScore, rankIfOnlyThisModelChanges: rank(combinedScore) };
  });
  return [name, { officialScore: model.officialScore, officialRank: model.officialRank, unitCases, unitDelta, unitsOnly, rankIfOnlyThisModelChanges: rank(unitsOnly), scenarios }];
}));
for (const [name, model] of Object.entries(models)) {
  const other = Object.entries(models).filter(([key]) => key !== name).map(([, value]) => value);
  model.rankIfBothModelsFixUnits = rank(model.unitsOnly, other.map((value) => value.unitsOnly));
  for (let i = 0; i < model.scenarios.length; i++) model.scenarios[i].rankIfBothModelsHaveSameTargetScore = rank(model.scenarios[i].combinedScore, other.map((value) => value.scenarios[i].combinedScore));
}
const output = {
  schemaVersion: "raven-gonna-test.counterfactual-output.v1", executionMode: input.executionMode,
  submissionEligible: false, asOfUtc: input.asOfUtc, informationPolicy: input.informationPolicy,
  inputSha256: createHash("sha256").update(raw).digest("hex"), caveat: input.caveat, models,
  solGapToObservedLeaderAfterUnits: input.leaders[0].score - models.gpt56sol.unitsOnly,
  solRequiredCombinedTargetScoreToTieLeader: (input.leaders[0].score - models.gpt56sol.unitsOnly) / (100 * 0.4 / 19)
};
const serialized = JSON.stringify(output, null, 2) + "\n";
const outputIndex = process.argv.indexOf("--output");
if (outputIndex !== -1) {
  const path = process.argv[outputIndex + 1];
  if (!path) throw new Error("--output needs a diagnostic JSON path.");
  await writeFile(path, serialized);
  process.stdout.write(`execution mode: offline-sensitivity; diagnostic artifact: ${path}\n`);
} else process.stdout.write(serialized);
