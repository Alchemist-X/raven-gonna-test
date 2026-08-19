#!/usr/bin/env node
// Reconstruct the aggregation derivation for a reasoning trace produced before
// the engine recorded it.
//
// Legitimate because aggregation is a deterministic pure function of the trial
// answers, which the trace already preserves: replaying it reproduces the
// decision exactly rather than inventing one. Every entry is stamped
// `source: "reconstructed"` so it is never mistaken for a contemporaneous
// record — if a replay ever disagreed with the submitted answer, that
// discrepancy is itself the finding, and the script reports it instead of
// quietly overwriting.
//
// Usage: node scripts/futurex-backfill-derivation.mjs <round-dir> <submission.jsonl>

import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { aggregateTrialPredictions } from "../packages/forecast-core/dist/aggregation.js";
import { futureXQuestionsToTasks } from "../packages/benchmarks/dist/futurex/adapter.js";

const [roundDir, submissionPath] = process.argv.slice(2);
if (!roundDir || !submissionPath) {
  console.error("usage: node scripts/futurex-backfill-derivation.mjs <round-dir> <submission.jsonl>");
  process.exit(1);
}

const reasoningPath = submissionPath.replace(/\.jsonl?$/i, "") + ".reasoning.jsonl";
const manifest = JSON.parse(readFileSync(`${submissionPath}.manifest.json`, "utf8"));
const questions = JSON.parse(readFileSync(path.join(roundDir, "questions.json"), "utf8"));
const routes = JSON.parse(readFileSync(path.join(roundDir, "routes.json"), "utf8")).routes;
const records = readFileSync(reasoningPath, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));

const { tasks } = futureXQuestionsToTasks(questions, {
  revision: manifest.revision,
  roundId: manifest.roundId,
  asOfUtc: manifest.evidenceCutoff,
  routeOverrides: routes
});
const taskByExternalId = new Map(tasks.map((task) => [task.origin.externalId, task]));

let filled = 0;
let skipped = 0;
const mismatches = [];

for (const record of records) {
  if (record.derivation) continue;
  const task = taskByExternalId.get(record.id);
  if (!task || !record.trials?.length) { skipped += 1; continue; }
  const trials = record.trials.map((trial) => ({
    trial: trial.trial,
    answer: trial.answer,
    citations: trial.citations ?? [],
    rawResponse: trial.rawResponse ?? "",
    latencyMs: trial.latencyMs ?? 0
  }));
  const derivation = [];
  let replayed;
  try {
    replayed = aggregateTrialPredictions(task, trials, { derivation });
  } catch (error) {
    mismatches.push({ id: record.id, reason: `replay threw: ${error.message}` });
    skipped += 1;
    continue;
  }
  // The replay must land on the answer that was actually submitted; if it does
  // not, the record is not explained by this rule and saying so is the point.
  const before = JSON.stringify(record.answer);
  const after = JSON.stringify(replayed);
  if (before !== after) mismatches.push({ id: record.id, submitted: before, replayed: after });
  record.derivation = derivation.map((entry) => ({ ...entry, source: "reconstructed" }));
  filled += 1;
}

writeFileSync(reasoningPath, records.map((r) => JSON.stringify(r)).join("\n") + "\n", "utf8");
console.log(`[OK] derivation reconstructed for ${filled} question(s); ${skipped} skipped (no trials)`);
if (mismatches.length > 0) {
  console.log(`[WARN] ${mismatches.length} replay(s) did not reproduce the submitted answer:`);
  for (const m of mismatches.slice(0, 8)) console.log("   ", JSON.stringify(m).slice(0, 160));
} else {
  console.log("[OK] every replay reproduced the submitted answer exactly");
}
