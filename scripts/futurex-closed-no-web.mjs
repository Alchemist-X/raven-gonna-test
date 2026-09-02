#!/usr/bin/env node
// Answer FutureX questions whose end_time has ALREADY passed at the evidence
// cutoff. Two modes:
//   --mode no-web   (default) no web access at all: training knowledge only.
//   --mode research the operator's explicit decision to look the PUBLISHED
//                   result up: normal retrieval, and the task is told that its
//                   event has resolved and to answer with the official value,
//                   forecasting only if nothing has been published yet.
//
// `futurex run` refuses to research such a question (the outcome may be
// public) and answers it from the deterministic fallback, i.e. a coin flip.
// A missing or wrong answer scores 0 either way, so a guess informed by the
// model's training knowledge — whose cutoff predates the event by months — is
// strictly better than a uniform pick and leaks nothing: the CLI is spawned
// with no retrieval tools at all (research=false withholds WebSearch/WebFetch),
// and the run fails closed if any trial shows a tool call or a URL anyway.
//
// Output is a standalone artifact; splicing it into a submission is a separate,
// recorded step (futurex-splice-answers.mjs) so the provenance of every row
// stays explicit.
//
// Usage:
//   PREDICTOR_PROVIDER=claude-cli PREDICTOR_MODEL=claude-opus-5 PREDICTOR_TRIALS=3 \
//   node scripts/futurex-closed-no-web.mjs --input q.json --routes r.json \
//     --revision <sha> --round <id> --as-of <ISO> --ids a,b,c --output out.json --allow-paid

import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const core = await import(path.join(root, "packages/forecast-core/dist/index.js"));
const bench = await import(path.join(root, "packages/benchmarks/dist/index.js"));
const runtime = await import(path.join(root, "packages/runtime/dist/index.js"));

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

const input = required("input");
const routesPath = required("routes");
const revision = required("revision");
const roundId = required("round");
const asOfUtc = required("as-of");
const ids = required("ids").split(",").map((value) => value.trim()).filter(Boolean);
const output = required("output");
const mode = typeof flags.get("mode") === "string" ? flags.get("mode") : "no-web";
if (mode !== "no-web" && mode !== "research") throw new Error("--mode must be no-web or research.");
if (!/^[0-9a-f]{40}$/i.test(revision)) throw new Error("--revision must be a full 40-character SHA.");
if (!Number.isFinite(new Date(asOfUtc).getTime())) throw new Error("--as-of must be a valid timestamp.");

const questions = bench.FutureXQuestionsSchema.parse(JSON.parse(readFileSync(input, "utf8")));
const routeFile = bench.FutureXRouteOverrideFileSchema.parse(JSON.parse(readFileSync(routesPath, "utf8")));
if (routeFile.revision.toLowerCase() !== revision.toLowerCase()) {
  throw new Error(`Route file is bound to ${routeFile.revision}, not ${revision}.`);
}
const selected = bench.selectFutureXQuestions(questions, ids);
const asOfMs = new Date(asOfUtc).getTime();
for (const question of selected) {
  const route = routeFile.routes[question.id];
  if (!route || (route.review?.status !== "approved" && route.review?.status !== "edited")) {
    throw new Error(`${question.id}: route is not reviewed.`);
  }
  // This path exists ONLY for questions the live run could not research. An
  // open question belongs in the live run, where it gets retrieval.
  const endUtc = bench.futureXEndTimeUtc(question.end_time);
  if (!endUtc || asOfMs < new Date(endUtc).getTime()) {
    throw new Error(`${question.id} is still open at ${asOfUtc} (ends ${question.end_time}); use the live run.`);
  }
}

const config = runtime.loadPredictorConfig();
if (config.provider !== "claude-cli") throw new Error("This script only supports PREDICTOR_PROVIDER=claude-cli.");
if (flags.get("allow-paid") !== true) {
  throw new Error(`About ${selected.length * config.trials} paid model calls; re-run with --allow-paid.`);
}

const { tasks: plainTasks } = bench.futureXQuestionsToTasks(selected, {
  revision,
  roundId,
  asOfUtc,
  routeOverrides: routeFile.routes
});
const tasks = mode === "research" ? plainTasks.map((task) => bench.withClosedQuestionResearchHint(task)) : plainTasks;
const port = new runtime.ConcurrencyLimitedModel(
  new runtime.ClaudeCliPredictor({
    model: config.model,
    timeoutMs: config.timeoutMs,
    ...(config.claudeEffort ? { effort: config.claudeEffort } : {}),
    ...(config.maxRetries !== undefined ? { maxRetries: config.maxRetries } : {}),
    ...(config.retryBaseMs !== undefined ? { retryBaseMs: config.retryBaseMs } : {})
  }),
  config.concurrency
);
const engine = new core.ForecastEngine(port);
const POLICY_ID = mode === "research" ? "futurex-closed-research-published-v1" : "futurex-closed-no-web-v1";
const policyFor = (task) =>
  mode === "research"
    ? { ...core.futureXPolicy(task.asOfUtc), id: POLICY_ID }
    : { ...core.futureXPolicy(task.asOfUtc), id: POLICY_ID, web: "deny" };

console.error(`[INFO] execution mode: closed-question ${mode} forecast; ${tasks.length} task(s); model ${config.model}; trials ${config.trials}`);
const results = await runtime.runForecastBatch(tasks, engine, policyFor, {
  concurrency: config.concurrency,
  forecastOptions: {
    trials: config.trials,
    concurrency: Math.min(config.trials, 3),
    timeoutMs: config.timeoutMs,
    reasoningEffort: "high"
  },
  fallbackFor: (task) => core.defaultAnswerForTask(task),
  onProgress: (completed, total, task, result) =>
    console.error(`[INFO] closed ${mode} ${completed}/${total}: ${task.origin.externalId} trials=${result.trials.length}${result.fallbackUsed ? " [fallback]" : ""}`)
});

// Fail closed: a tool call of any kind (recorded as a search:// query or a
// fetched URL) means the no-web boundary did not hold, and the answer must
// not be used.
for (const result of results) {
  for (const trial of result.trials) {
    if (mode === "no-web" && trial.citations.length > 0) {
      throw new Error(`${result.taskId} trial ${trial.trial} touched a tool (${trial.citations.slice(0, 3).join(", ")}); no-web boundary violated.`);
    }
  }
}

const submission = bench.buildFutureXSubmission(selected, results);
const report = bench.validateFutureXSubmission(selected, submission, { routeOverrides: routeFile.routes, requireComplete: true });
if (!report.valid) throw new Error(report.errors.join("\n"));

const artifact = {
  schemaVersion: "raven-gonna-test.futurex-closed-question.v1",
  mode,
  evidencePolicy: POLICY_ID,
  description: mode === "research"
    ? "Questions already past end_time at the evidence cutoff, researched for the published result by operator decision."
    : "Questions already past end_time at the evidence cutoff, answered from training knowledge with retrieval tools withheld.",
  revision,
  roundId,
  asOfUtc,
  generatedAtUtc: new Date().toISOString(),
  model: config.model,
  provider: config.provider,
  trials: config.trials,
  codeSha: process.env.RAVEN_CODE_SHA ?? null,
  selectedIds: ids,
  submission,
  results
};
writeFileSync(output, `${JSON.stringify(artifact, null, 2)}\n`);
console.error(`[OK] closed-question ${mode} artifact written: ${output}`);
for (const row of submission) {
  const result = results.find((candidate) => candidate.taskId.endsWith(`:${row.id}`));
  console.error(`[INFO]   ${row.id} -> ${row.prediction}${result?.fallbackUsed ? " [fallback]" : ""}`);
}
