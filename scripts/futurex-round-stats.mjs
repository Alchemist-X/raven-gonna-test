#!/usr/bin/env node
// Summarise a FutureX run from its artifacts: per-level trial counts and
// research depth, zero-research and fallback questions, token and cost totals.
// The numbers the round README reports come from here rather than by hand.
//
// Reads only artifacts, imports no workspace package.
// Usage: node scripts/futurex-round-stats.mjs <round-dir> <submission.jsonl>

import { readFileSync } from "node:fs";
import path from "node:path";

const [roundDir, submissionPath] = process.argv.slice(2);
if (!roundDir || !submissionPath) {
  console.error("usage: node scripts/futurex-round-stats.mjs <round-dir> <submission.jsonl>");
  process.exit(1);
}
const readJson = (file) => JSON.parse(readFileSync(file, "utf8"));
const readJsonl = (file) => readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));

const questions = new Map(readJson(path.join(roundDir, "questions.json")).map((q) => [q.id, q]));
const routes = readJson(path.join(roundDir, "routes.json")).routes;
const submission = readJsonl(submissionPath);
const reasoning = new Map(readJsonl(`${submissionPath.replace(/\.jsonl?$/i, "")}.reasoning.jsonl`).map((r) => [r.id, r]));

const byLevel = {};
const byKind = {};
const zeroResearch = [];
const fallbacks = [];
const noWeb = [];
let trials = 0;
let searches = 0;
let urls = 0;
const usage = {};
for (const row of submission) {
  const q = questions.get(row.id);
  const rec = reasoning.get(row.id);
  const kind = routes[row.id]?.kind ?? "unknown";
  byKind[kind] = (byKind[kind] ?? 0) + 1;
  const level = (byLevel[q.level] ??= { questions: 0, trials: 0, searches: 0, urls: 0, researched: 0 });
  level.questions += 1;
  if (!rec) continue;
  if (rec.fallbackUsed) fallbacks.push(row.id);
  if (typeof rec.source === "string" && rec.source.startsWith("closed-")) noWeb.push(row.id);
  const recTrials = rec.trials ?? [];
  level.trials += recTrials.length;
  trials += recTrials.length;
  let qSearches = 0;
  let qUrls = 0;
  for (const t of recTrials) {
    const s = (t.searchQueries ?? t.citations.filter((c) => c.startsWith("search://"))).length;
    const u = (t.sourceUrls ?? t.citations.filter((c) => /^https?:/i.test(c))).length;
    qSearches += s;
    qUrls += u;
    for (const [key, value] of Object.entries(t.usage ?? {})) {
      if (typeof value === "number" && Number.isFinite(value)) usage[key] = (usage[key] ?? 0) + value;
    }
  }
  searches += qSearches;
  urls += qUrls;
  level.searches += qSearches;
  level.urls += qUrls;
  if (recTrials.length > 0 && qUrls > 0) level.researched += 1;
  if (recTrials.length > 0 && qUrls === 0 && !(typeof rec.source === "string" && rec.source.startsWith("closed-"))) zeroResearch.push(row.id);
}
for (const level of Object.values(byLevel)) {
  level.meanSearchesPerTrial = level.trials ? Number((level.searches / level.trials).toFixed(1)) : 0;
  level.meanUrlsPerTrial = level.trials ? Number((level.urls / level.trials).toFixed(1)) : 0;
}
const titled = (ids) => ids.map((id) => ({ id, level: questions.get(id)?.level, title: questions.get(id)?.en_title, prediction: submission.find((r) => r.id === id)?.prediction }));
console.log(JSON.stringify({
  rows: submission.length,
  byKind,
  byLevel,
  trials,
  searches,
  sourceUrls: urls,
  fallbackAnswers: titled(fallbacks),
  zeroResearchAnswers: titled(zeroResearch),
  closedQuestionAnswers: titled(noWeb),
  usageTotals: {
    input_tokens: usage.input_tokens ?? 0,
    cache_creation_input_tokens: usage.cache_creation_input_tokens ?? 0,
    cache_read_input_tokens: usage.cache_read_input_tokens ?? 0,
    output_tokens: usage.output_tokens ?? 0,
    total_cost_usd: Number((usage.total_cost_usd ?? 0).toFixed(2)),
    num_turns: usage.num_turns ?? 0
  }
}, null, 2));
