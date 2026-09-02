#!/usr/bin/env node
// Remove named questions from a run checkpoint so `futurex run --resume`
// forecasts them again from scratch.
//
// Why this exists: a checkpoint keeps a question once ANY trial succeeded, so a
// Level-4 question that lost three of its four trials to a provider burst is
// resumed as "done" on the strength of one trial. --retry-fallbacks only covers
// questions with no trial at all. Dropping the partial result is the honest
// alternative to topping it up, which would mix two runs' trials.
//
// The checkpoint is copied to <checkpoint>.before-drop-<n>.json first, and the
// drop is recorded inside the checkpoint under `drops` so the manifest chain
// stays auditable.
//
// Usage: node scripts/futurex-checkpoint-drop.mjs <checkpoint.json> <id,id,...> "<reason>"

import { copyFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";

const [checkpointPath, idList, reason] = process.argv.slice(2);
if (!checkpointPath || !idList || !reason) {
  console.error('usage: node scripts/futurex-checkpoint-drop.mjs <checkpoint.json> <id,id,...> "<reason>"');
  process.exit(1);
}
const ids = new Set(idList.split(",").map((value) => value.trim()).filter(Boolean));
const checkpoint = JSON.parse(readFileSync(checkpointPath, "utf8"));
if (checkpoint.schemaVersion !== "raven-gonna-test.checkpoint.v1") throw new Error("Unsupported checkpoint schema.");

let backupIndex = 1;
while (existsSync(`${checkpointPath}.before-drop-${backupIndex}.json`)) backupIndex += 1;
const backupPath = `${checkpointPath}.before-drop-${backupIndex}.json`;
copyFileSync(checkpointPath, backupPath);

const dropped = [];
const kept = [];
for (const result of checkpoint.results ?? []) {
  const id = String(result.taskId).split(":").pop();
  if (ids.has(id)) {
    dropped.push({ id, trials: result.trials.length, fallbackUsed: result.fallbackUsed, answer: result.answer, warnings: result.warnings });
  } else {
    kept.push(result);
  }
}
const missing = [...ids].filter((id) => !dropped.some((entry) => entry.id === id));
if (missing.length) throw new Error(`Not in checkpoint: ${missing.join(", ")}`);

checkpoint.results = kept;
checkpoint.completed = kept.length;
checkpoint.updatedAtUtc = new Date().toISOString();
checkpoint.drops = [...(checkpoint.drops ?? []), { atUtc: checkpoint.updatedAtUtc, reason, backup: backupPath.split("/").pop(), dropped }];
writeFileSync(checkpointPath, `${JSON.stringify(checkpoint, null, 2)}\n`);
console.error(`[OK] dropped ${dropped.length} result(s); ${kept.length}/${checkpoint.total} remain; backup ${backupPath}`);
for (const entry of dropped) console.error(`[INFO]   ${entry.id}: had ${entry.trials} trial(s)${entry.fallbackUsed ? " (fallback)" : ""}`);
