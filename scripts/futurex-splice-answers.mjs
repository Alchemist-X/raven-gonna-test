#!/usr/bin/env node
// Splice the answers from a closed-question no-web artifact
// (futurex-closed-no-web.mjs) over the fallback rows of a validated
// submission, producing a NEW submission file plus a manifest that records
// every replaced row. The original submission is left untouched, so the
// provenance of each row stays explicit: which came from the live run, which
// from the no-web path, and what the fallback would have been.
//
// Only rows the live run answered by fallback are eligible; a researched row is
// never overwritten. The merged reasoning trace carries the no-web trials for
// the replaced rows so the archive explains every submitted value.
//
// Usage:
//   node scripts/futurex-splice-answers.mjs --round-dir <dir with questions.json+routes.json> \
//     --submission <run>/submission.jsonl --closed <run>/closed-no-web.json \
//     --output <run>/submission-final.jsonl [--deadline <ISO>]

import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
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
const closedPath = required("closed");
const output = required("output");
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
const closed = readJson(closedPath);
if (closed.schemaVersion !== "raven-gonna-test.futurex-closed-no-web.v1") throw new Error("Unsupported closed-question artifact.");
if (closed.revision.toLowerCase() !== routeFile.revision.toLowerCase() || closed.revision.toLowerCase() !== String(manifest.revision).toLowerCase()) {
  throw new Error("Revision mismatch between routes, submission manifest and closed-question artifact.");
}

const reasoningById = new Map(reasoning.map((record) => [record.id, record]));
const closedRowById = new Map(closed.submission.map((row) => [row.id, row]));
const closedResultById = new Map(closed.results.map((result) => [result.taskId.split(":").pop(), result]));

const replaced = [];
const skipped = [];
const merged = submission.map((row) => {
  const candidate = closedRowById.get(row.id);
  if (!candidate) return row;
  const record = reasoningById.get(row.id);
  const closedResult = closedResultById.get(row.id);
  if (!record || !record.fallbackUsed) {
    skipped.push({ id: row.id, reason: "live run answered this row with research; not overwritten" });
    return row;
  }
  if (!closedResult || closedResult.fallbackUsed || closedResult.trials.length === 0) {
    skipped.push({ id: row.id, reason: "no-web path itself fell back; fallback row kept" });
    return row;
  }
  replaced.push({ id: row.id, before: row.prediction, after: candidate.prediction, noWebTrials: closedResult.trials.length });
  return { id: row.id, prediction: candidate.prediction };
});

const report = bench.validateFutureXSubmission(questions, merged, {
  routeOverrides: routeFile.routes,
  requireComplete: true,
  ...(deadline ? { deadlineUtc: deadline } : {})
});
if (!report.valid) throw new Error(report.errors.join("\n"));

writeFileSync(output, `${merged.map((row) => JSON.stringify(row)).join("\n")}\n`);

// Merged reasoning: the replaced rows carry the no-web trials, and keep the
// live run's fallback record beside them so the substitution stays visible.
const mergedReasoning = reasoning.map((record) => {
  const entry = replaced.find((item) => item.id === record.id);
  if (!entry) return record;
  const closedResult = closedResultById.get(record.id);
  return {
    ...record,
    submittedPrediction: entry.after,
    answer: closedResult.answer,
    fallbackUsed: false,
    source: "closed-no-web",
    evidencePolicy: closed.evidencePolicy,
    supersededFallback: { prediction: entry.before, answer: record.answer, warnings: record.warnings },
    warnings: closedResult.warnings,
    derivation: closedResult.derivation ?? null,
    researchedTrials: 0,
    trials: closedResult.trials.map((trial) => ({
      trial: trial.trial,
      role: trial.role ?? null,
      answer: trial.answer,
      citations: trial.citations,
      searchQueries: [],
      sourceUrls: [],
      thinking: trial.thinking ?? null,
      rawResponse: trial.rawResponse,
      latencyMs: trial.latencyMs,
      usage: trial.usage ?? null
    }))
  };
});
const mergedReasoningPath = `${output.replace(/\.jsonl?$/i, "")}.reasoning.jsonl`;
writeFileSync(mergedReasoningPath, `${mergedReasoning.map((record) => JSON.stringify(record)).join("\n")}\n`);

const outManifest = {
  ...manifest,
  schemaVersion: "raven-gonna-test.artifact-manifest.v1",
  createdAtUtc: new Date().toISOString(),
  output: path.basename(output),
  sha256: sha256(output),
  reasoning: path.basename(mergedReasoningPath),
  derivedFrom: { submission: path.basename(submissionPath), sha256: sha256(submissionPath), manifest: path.basename(manifestPath) },
  closedNoWeb: {
    artifact: path.basename(closedPath),
    sha256: sha256(closedPath),
    evidencePolicy: closed.evidencePolicy,
    model: closed.model,
    trials: closed.trials,
    asOfUtc: closed.asOfUtc
  },
  splicedRows: replaced,
  spliceSkipped: skipped,
  fallbackAnswers: Math.max(0, Number(manifest.fallbackAnswers ?? 0) - replaced.length),
  validation: report
};
writeFileSync(`${output}.manifest.json`, `${JSON.stringify(outManifest, null, 2)}\n`);

console.error(`[OK] spliced submission written: ${output} (sha256 ${outManifest.sha256})`);
console.error(`[OK] merged reasoning written: ${mergedReasoningPath}`);
for (const item of replaced) console.error(`[INFO]   replaced ${item.id}: ${item.before} -> ${item.after} (${item.noWebTrials} no-web trials)`);
for (const item of skipped) console.error(`[WARN]   kept ${item.id}: ${item.reason}`);
