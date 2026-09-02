#!/usr/bin/env node
// Re-derive the submitted answers of selected task kinds from the trials the
// reasoning trace already preserves, using the CURRENT aggregation code, and
// write a new submission (plus manifest and reasoning) that records every row
// that changed.
//
// Legitimate for the same reason the derivation backfill is: aggregation is a
// deterministic pure function of the trial answers, so replaying it neither
// re-researches nor invents anything — it applies a corrected decision rule to
// evidence gathered before the cutoff. The prior derivation is kept beside the
// new one, so an outside reader can see exactly what changed and why.
//
// Usage:
//   node scripts/futurex-reaggregate.mjs --round-dir <dir> --submission <in.jsonl> \
//     --output <out.jsonl> --kinds ranking[,numeric,...] --reason "<why>" [--deadline <ISO>]

import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const core = await import(path.join(root, "packages/forecast-core/dist/index.js"));
const bench = await import(path.join(root, "packages/benchmarks/dist/index.js"));

const flags = new Map();
const argv = process.argv.slice(2);
for (let index = 0; index < argv.length; index += 1) {
  const value = argv[index];
  if (!value.startsWith("--")) continue;
  const next = argv[index + 1];
  if (next && !next.startsWith("--")) {
    flags.set(value.slice(2), next);
    index += 1;
  } else {
    flags.set(value.slice(2), true);
  }
}
const required = (name) => {
  const value = flags.get(name);
  if (typeof value !== "string" || !value) throw new Error(`--${name} is required.`);
  return value;
};

const roundDir = required("round-dir");
const submissionPath = required("submission");
const output = required("output");
const kinds = new Set(required("kinds").split(",").map((value) => value.trim()).filter(Boolean));
const reason = required("reason");
const deadline = typeof flags.get("deadline") === "string" ? flags.get("deadline") : undefined;
if (path.resolve(output) === path.resolve(submissionPath)) throw new Error("--output must differ from --submission.");
if (existsSync(output) && flags.get("force") !== true) throw new Error(`${output} already exists; pass --force to overwrite.`);

const readJson = (file) => JSON.parse(readFileSync(file, "utf8"));
const readJsonl = (file) => readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
const sha256 = (file) => createHash("sha256").update(readFileSync(file)).digest("hex");

const questions = bench.FutureXQuestionsSchema.parse(readJson(path.join(roundDir, "questions.json")));
const routeFile = bench.FutureXRouteOverrideFileSchema.parse(readJson(path.join(roundDir, "routes.json")));
const submission = readJsonl(submissionPath);
const manifestPath = `${submissionPath}.manifest.json`;
const manifest = readJson(manifestPath);
const reasoningPath = `${submissionPath.replace(/\.jsonl?$/i, "")}.reasoning.jsonl`;
const reasoning = readJsonl(reasoningPath);
if (String(manifest.revision).toLowerCase() !== routeFile.revision.toLowerCase()) throw new Error("Revision mismatch between routes and submission manifest.");

const { tasks } = bench.futureXQuestionsToTasks(questions, {
  revision: manifest.revision,
  roundId: manifest.roundId,
  asOfUtc: manifest.evidenceCutoff,
  routeOverrides: routeFile.routes
});
const taskById = new Map(tasks.map((task) => [task.origin.externalId, task]));
const resultById = new Map();
for (const result of results(reasoning)) resultById.set(result.id, result);

function* results(records) {
  for (const record of records) yield record;
}

const changed = [];
const unchanged = [];
const rowById = new Map(submission.map((row) => [row.id, row]));
const reasoningById = new Map(reasoning.map((record) => [record.id, record]));

for (const record of reasoning) {
  const task = taskById.get(record.id);
  if (!task || !kinds.has(task.kind)) continue;
  if (!record.trials?.length || record.fallbackUsed) continue;
  const trials = record.trials.map((trial) => ({
    trial: trial.trial,
    answer: trial.answer,
    citations: trial.citations ?? [],
    rawResponse: trial.rawResponse ?? "",
    latencyMs: trial.latencyMs ?? 0
  }));
  const derivation = [];
  const diagnostics = [];
  const answer = core.aggregateTrialPredictions(task, trials, { derivation, diagnostics });
  const pseudoResult = { taskId: task.taskId, answer };
  const prediction = bench.futureXPredictionFromResult(pseudoResult);
  const before = rowById.get(record.id)?.prediction;
  if (before === prediction) {
    unchanged.push(record.id);
    continue;
  }
  changed.push({ id: record.id, kind: task.kind, before, after: prediction, method: derivation[0]?.method ?? null });
  rowById.set(record.id, { id: record.id, prediction });
  reasoningById.set(record.id, {
    ...record,
    submittedPrediction: prediction,
    answer,
    warnings: [...(record.warnings ?? []), ...diagnostics],
    derivation,
    previousDerivation: { submittedPrediction: before, answer: record.answer, derivation: record.derivation ?? null, reason }
  });
}

const merged = submission.map((row) => rowById.get(row.id));
const report = bench.validateFutureXSubmission(questions, merged, {
  routeOverrides: routeFile.routes,
  requireComplete: true,
  ...(deadline ? { deadlineUtc: deadline } : {})
});
if (!report.valid) throw new Error(report.errors.join("\n"));

writeFileSync(output, `${merged.map((row) => JSON.stringify(row)).join("\n")}\n`);
const mergedReasoningPath = `${output.replace(/\.jsonl?$/i, "")}.reasoning.jsonl`;
writeFileSync(mergedReasoningPath, `${reasoning.map((record) => JSON.stringify(reasoningById.get(record.id))).join("\n")}\n`);
writeFileSync(`${output}.manifest.json`, `${JSON.stringify({
  ...manifest,
  createdAtUtc: new Date().toISOString(),
  output: path.basename(output),
  sha256: sha256(output),
  reasoning: path.basename(mergedReasoningPath),
  derivedFrom: { submission: path.basename(submissionPath), sha256: sha256(submissionPath), manifest: path.basename(manifestPath) },
  reaggregated: { kinds: [...kinds], reason, codeSha: process.env.RAVEN_CODE_SHA ?? null, changed, unchangedCount: unchanged.length },
  validation: report
}, null, 2)}\n`);

console.error(`[OK] re-aggregated submission written: ${output} (sha256 ${sha256(output)})`);
console.error(`[INFO] ${changed.length} row(s) changed, ${unchanged.length} unchanged among kinds ${[...kinds].join(",")}`);
for (const item of changed) console.error(`[INFO]   ${item.id} (${item.kind}, ${item.method}):\n         ${item.before}\n      -> ${item.after}`);
