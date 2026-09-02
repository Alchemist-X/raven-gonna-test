#!/usr/bin/env node
// Run one FutureX research pilot per (harness x model) slot, a bounded number
// of slots at a time, then aggregate the per-question answers into a single
// comparison artifact. This is the piece the 2026-08-19 round lacked: the
// cross-model agreement numbers in SUBMISSIONS.json were counted by hand.
//
// Reads only artifacts and spawns the existing CLI; imports no workspace
// package, so it cannot drift from the submission pipeline it drives.
//
// Usage: node scripts/futurex-matrix.mjs <matrix-config.json>
//
// Config shape:
// {
//   "round": "2026-08-19",
//   "revision": "<40-char sha>",
//   "asOfUtc": "auto" | "<ISO>",            // "auto" = launch time, shared by every slot
//   "questions": "path/questions.json",
//   "routes": "path/routes.json",
//   "ids": ["Q1", "Q2"],
//   "outputDir": "runtime-artifacts/futurex/<round>/matrix-<stamp>",
//   "maxParallelSlots": 3,
//   "slots": [
//     { "name": "sonnet5", "env": { "PREDICTOR_PROVIDER": "claude-cli", "PREDICTOR_MODEL": "claude-sonnet-5" } },
//     { "name": "gpt56sol", "env": { "PREDICTOR_PROVIDER": "codex-cli", "PREDICTOR_MODEL": "gpt-5.6-sol" } }
//   ]
// }
//
// An env value written as "$NAME" resolves from the launcher's environment at
// spawn time, so secrets can flow from a sourced env file without ever being
// written into a config or a log.

import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const configPath = process.argv[2];
if (!configPath) {
  console.error("usage: node scripts/futurex-matrix.mjs <matrix-config.json>");
  process.exit(1);
}

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cliEntry = path.join(repoRoot, "apps/benchmark-cli/dist/main.js");
const config = JSON.parse(readFileSync(configPath, "utf8"));

for (const key of ["round", "revision", "questions", "routes", "ids", "outputDir", "slots"]) {
  if (!config[key] || (Array.isArray(config[key]) && config[key].length === 0)) {
    console.error(`matrix config is missing ${key}`);
    process.exit(1);
  }
}
const asOfUtc = !config.asOfUtc || config.asOfUtc === "auto" ? new Date().toISOString() : config.asOfUtc;
const outputDir = path.resolve(config.outputDir);
mkdirSync(outputDir, { recursive: true });

function resolveEnv(slot) {
  const merged = { ...process.env };
  for (const [key, value] of Object.entries(slot.env ?? {})) {
    if (typeof value === "string" && value.startsWith("$")) {
      const source = process.env[value.slice(1)];
      if (source === undefined) throw new Error(`slot ${slot.name}: ${value} is not set in the launcher environment`);
      merged[key] = source;
    } else {
      merged[key] = String(value);
    }
  }
  return merged;
}

function runSlot(slot) {
  const output = path.join(outputDir, `${slot.name}.pilot.json`);
  const logPath = path.join(outputDir, `${slot.name}.log`);
  const args = [
    cliEntry,
    "futurex",
    "pilot",
    "--input", path.resolve(config.questions),
    "--routes", path.resolve(config.routes),
    "--revision", config.revision,
    "--round", config.round,
    "--as-of", asOfUtc,
    "--ids", config.ids.join(","),
    "--output", output,
    "--allow-paid"
  ];
  const startedAt = Date.now();
  return new Promise((resolve) => {
    let env;
    try {
      env = resolveEnv(slot);
    } catch (error) {
      resolve({ slot: slot.name, exitCode: -1, seconds: 0, error: error.message, output, logPath });
      return;
    }
    const child = spawn(process.execPath, args, { env, cwd: repoRoot });
    const log = [];
    child.stdout.on("data", (chunk) => log.push(chunk));
    child.stderr.on("data", (chunk) => log.push(chunk));
    child.on("close", (code) => {
      writeFileSync(logPath, Buffer.concat(log.map((chunk) => Buffer.from(chunk))));
      const seconds = Math.round((Date.now() - startedAt) / 1000);
      console.log(`[matrix] ${slot.name}: exit ${code} after ${seconds}s`);
      resolve({ slot: slot.name, exitCode: code, seconds, output, logPath });
    });
  });
}

async function runAll() {
  console.log(`[matrix] ${config.slots.length} slots, ${config.ids.length} questions each, as-of ${asOfUtc}`);
  console.log(`[matrix] output: ${outputDir}`);
  const queue = [...config.slots];
  const running = new Set();
  const results = [];
  const limit = Math.max(1, config.maxParallelSlots ?? 3);
  async function next() {
    const slot = queue.shift();
    if (!slot) return;
    console.log(`[matrix] start ${slot.name}`);
    const promise = runSlot(slot).then((result) => {
      results.push(result);
      running.delete(promise);
    });
    running.add(promise);
    if (running.size >= limit) await Promise.race(running);
    await next();
  }
  await next();
  await Promise.all(running);
  return results;
}

function answerSummary(answer) {
  if (!answer) return null;
  switch (answer.kind) {
    case "numeric": return answer.value;
    case "binary": return answer.pYes;
    case "categorical": return answer.choice;
    case "ranking": return answer.order.join(" > ");
    case "multi_label": return answer.selected.join(", ");
    case "free_response": return answer.value.length > 80 ? `${answer.value.slice(0, 77)}...` : answer.value;
    default: return JSON.stringify(answer);
  }
}

function aggregate(runResults) {
  const questions = new Map(JSON.parse(readFileSync(path.resolve(config.questions), "utf8")).map((q) => [q.id, q]));
  const routes = JSON.parse(readFileSync(path.resolve(config.routes), "utf8")).routes ?? {};
  const slotArtifacts = new Map();
  for (const result of runResults) {
    if (result.exitCode !== 0) continue;
    try {
      slotArtifacts.set(result.slot, JSON.parse(readFileSync(result.output, "utf8")));
    } catch {
      /* an unreadable artifact is reported through the exit table instead */
    }
  }

  const rows = config.ids.map((id) => {
    const question = questions.get(id);
    const perSlot = {};
    for (const [slotName, artifact] of slotArtifacts) {
      const entry = (artifact.results ?? []).find((candidate) => candidate.taskId.endsWith(`:${id}`));
      if (!entry) {
        perSlot[slotName] = null;
        continue;
      }
      const trials = entry.trials ?? [];
      const usageTokens = trials.reduce(
        (sum, trial) => sum + Number(trial.usage?.output_tokens ?? 0) + Number(trial.usage?.input_tokens ?? 0),
        0
      );
      perSlot[slotName] = {
        answer: answerSummary(entry.answer),
        fallbackUsed: entry.fallbackUsed,
        researchedTrials: trials.filter((trial) => (trial.citations ?? []).length > 0).length,
        trials: trials.length,
        citations: trials.reduce((sum, trial) => sum + (trial.citations ?? []).length, 0),
        meanLatencySeconds: trials.length
          ? Math.round(trials.reduce((sum, trial) => sum + trial.latencyMs, 0) / trials.length / 1000)
          : null,
        tokens: usageTokens || null
      };
    }
    const answers = Object.values(perSlot).filter(Boolean).map((slotRow) => JSON.stringify(slotRow.answer));
    return {
      id,
      kind: routes[id]?.kind ?? null,
      level: question?.level ?? null,
      title: question?.en_title ?? question?.prompt?.slice(0, 100) ?? id,
      distinctAnswers: new Set(answers).size,
      slots: perSlot
    };
  });

  return {
    schemaVersion: "raven-gonna-test.futurex-matrix.v1",
    generatedAtUtc: new Date().toISOString(),
    round: config.round,
    revision: config.revision,
    asOfUtc,
    ids: config.ids,
    runs: runResults.map(({ slot, exitCode, seconds, error }) => ({ slot, exitCode, seconds, ...(error ? { error } : {}) })),
    questions: rows
  };
}

function renderMarkdown(summary) {
  const slotNames = summary.runs.filter((run) => run.exitCode === 0).map((run) => run.slot);
  const lines = [
    `# FutureX matrix ${summary.round}`,
    "",
    `as-of ${summary.asOfUtc} | revision \`${summary.revision.slice(0, 12)}\``,
    "",
    "| slot | exit | wall time |",
    "| --- | --- | --- |",
    ...summary.runs.map((run) => `| ${run.slot} | ${run.exitCode}${run.error ? ` (${run.error})` : ""} | ${run.seconds}s |`),
    "",
    `| question | kind | level | ${slotNames.join(" | ")} | distinct |`,
    `| --- | --- | --- | ${slotNames.map(() => "---").join(" | ")} | --- |`
  ];
  for (const row of summary.questions) {
    const cells = slotNames.map((slot) => {
      const cell = row.slots[slot];
      if (!cell) return "—";
      const research = cell.researchedTrials < cell.trials ? ` ⚠${cell.researchedTrials}/${cell.trials}` : "";
      return `${String(cell.answer)}${cell.fallbackUsed ? " (fallback)" : ""}${research}`;
    });
    lines.push(
      `| ${row.title.replace(/\|/g, "\\|").slice(0, 60)} | ${row.kind ?? "?"} | L${row.level} | ${cells.join(" | ")} | ${row.distinctAnswers} |`
    );
  }
  lines.push("");
  return lines.join("\n");
}

const runResults = await runAll();
const summary = aggregate(runResults);
writeFileSync(path.join(outputDir, "matrix-summary.json"), `${JSON.stringify(summary, null, 2)}\n`);
writeFileSync(path.join(outputDir, "matrix-summary.md"), renderMarkdown(summary));
console.log(`[matrix] summary: ${path.join(outputDir, "matrix-summary.json")}`);
console.log(`[matrix] summary: ${path.join(outputDir, "matrix-summary.md")}`);
const failed = runResults.filter((result) => result.exitCode !== 0);
if (failed.length > 0) {
  console.error(`[matrix] ${failed.length} slot(s) failed: ${failed.map((result) => result.slot).join(", ")}`);
  process.exitCode = 1;
}
