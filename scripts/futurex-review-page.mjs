#!/usr/bin/env node
// Build a reviewable HTML page from a FutureX submission plus its reasoning
// trace. The submission alone is 80 opaque strings; what a reviewer needs is
// which of them to distrust, ordered by how much score rides on each.
//
// Reads only artifacts, imports no workspace package, so it runs before or
// after a build and cannot perturb a run.
//
// Usage: node scripts/futurex-review-page.mjs <round-dir> <submission.jsonl> [out.html]

import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const [roundDir, submissionPath, outPath] = process.argv.slice(2);
if (!roundDir || !submissionPath) {
  console.error("usage: node scripts/futurex-review-page.mjs <round-dir> <submission.jsonl> [out.html]");
  process.exit(1);
}

const readJson = (file) => JSON.parse(readFileSync(file, "utf8"));
const readJsonl = (file) => readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));

const questions = new Map(readJson(path.join(roundDir, "questions.json")).map((q) => [q.id, q]));
const routes = readJson(path.join(roundDir, "routes.json")).routes;
const submission = readJsonl(submissionPath);
const reasoning = new Map(readJsonl(submissionPath.replace(/\.jsonl?$/i, "") + ".reasoning.jsonl").map((r) => [r.id, r]));
const manifest = readJson(`${submissionPath}.manifest.json`);

// FutureX weights each LEVEL's mean, so one question is worth weight/count.
const LEVEL_WEIGHT = { 1: 0.1, 2: 0.2, 3: 0.3, 4: 0.4 };
const levelCounts = {};
for (const q of questions.values()) levelCounts[q.level] = (levelCounts[q.level] ?? 0) + 1;
const perQuestionWeight = (level) => LEVEL_WEIGHT[level] / levelCounts[level];

const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/**
 * Why a row deserves a human look. Deliberately conservative: every flag is a
 * fact about the artifact, never a guess about correctness.
 */
function flagsFor(row, rec, question) {
  const flags = [];
  if (!rec) return [{ kind: "flag", label: "no reasoning recorded" }];
  const cites = rec.trials.reduce((n, t) => n + t.citations.length, 0);
  if (rec.fallbackUsed || rec.trials.length === 0) flags.push({ kind: "flag", label: "fallback answer" });
  if (rec.trials.length > 0 && cites === 0) flags.push({ kind: "flag", label: "answered without sources" });
  else if (cites < 15) flags.push({ kind: "watch", label: `thin evidence (${cites} sources)` });

  const values = rec.trials.map((t) => t.answer?.value).filter((v) => typeof v === "number");
  if (rec.kind === "numeric" && values.length > 1) {
    const lo = Math.min(...values);
    const hi = Math.max(...values);
    const mid = (Math.abs(lo) + Math.abs(hi)) / 2 || 1;
    const spread = (hi - lo) / mid;
    // Scored tolerance is 5% of the truth, so trials spread wider than that
    // disagree by more than the grader forgives.
    if (spread > 0.1) flags.push({ kind: "watch", label: `trials span ${(spread * 100).toFixed(0)}% (tolerance is 5%)` });
    const magnitudes = new Set(values.map((v) => Math.round(Math.log10(Math.abs(v) || 1))));
    if (magnitudes.size > 1) flags.push({ kind: "flag", label: "trials disagree on unit scale" });
  }
  if (rec.kind !== "numeric" && rec.trials.length > 1) {
    const picks = new Set(rec.trials.map((t) => t.answer?.choice ?? t.answer?.value));
    if (picks.size > 1) flags.push({ kind: "watch", label: `trials split ${[...picks].join(" / ").slice(0, 40)}` });
  }
  if (rec.warnings?.length) flags.push({ kind: "flag", label: rec.warnings[0].slice(0, 80) });
  return flags;
}

const rows = submission.map((row) => {
  const question = questions.get(row.id);
  const rec = reasoning.get(row.id);
  const flags = flagsFor(row, rec, question);
  return {
    id: row.id,
    prediction: row.prediction,
    title: question.en_title,
    level: question.level,
    weight: perQuestionWeight(question.level),
    kind: routes[row.id]?.kind ?? rec?.kind ?? "unknown",
    endTime: question.end_time,
    trials: rec?.trials.length ?? 0,
    sources: rec ? rec.trials.reduce((n, t) => n + t.citations.length, 0) : 0,
    trialValues: rec ? rec.trials.map((t) => t.answer?.value ?? t.answer?.choice ?? t.answer?.selected?.join(", ")) : [],
    flags,
    severity: flags.some((f) => f.kind === "flag") ? 2 : flags.some((f) => f.kind === "watch") ? 1 : 0
  };
});

const totals = {
  rows: rows.length,
  flagged: rows.filter((r) => r.severity === 2).length,
  watch: rows.filter((r) => r.severity === 1).length,
  clean: rows.filter((r) => r.severity === 0).length,
  atRisk: rows.filter((r) => r.severity > 0).reduce((w, r) => w + r.weight, 0),
  sources: rows.reduce((n, r) => n + r.sources, 0)
};

const byWeight = [...rows].sort((a, b) => b.severity - a.severity || b.weight - a.weight);

const row = (r) => `
<article class="row sev-${r.severity}" data-sev="${r.severity}" data-level="${r.level}">
  <div class="row-head">
    <span class="chip lvl">L${r.level}</span>
    <span class="chip kind">${esc(r.kind)}</span>
    <span class="weight">${(r.weight * 100).toFixed(2)}<span class="unit">% of score</span></span>
  </div>
  <h3>${esc(r.title)}</h3>
  <p class="answer"><span class="answer-label">Submitted</span><code>${esc(r.prediction)}</code></p>
  <dl class="meta">
    <div><dt>Trials</dt><dd>${r.trials}</dd></div>
    <div><dt>Sources</dt><dd>${r.sources}</dd></div>
    <div><dt>Closes</dt><dd>${esc(r.endTime.slice(0, 16).replace("T", " "))}</dd></div>
  </dl>
  ${r.trialValues.length > 1 ? `<p class="trials"><span class="answer-label">Each trial said</span>${r.trialValues.map((v) => `<code>${esc(String(v).slice(0, 22))}</code>`).join("")}</p>` : ""}
  ${r.flags.length ? `<ul class="flags">${r.flags.map((f) => `<li class="${f.kind}">${esc(f.label)}</li>`).join("")}</ul>` : `<p class="allclear">Nothing flagged</p>`}
</article>`;

const html = `<title>FutureX Round Review</title>
<style>
:root{
  --ground:#fbfbfc; --panel:#ffffff; --edge:#dfe3ea;
  --ink:#131820; --muted:#59626f;
  --accent:#0d7490; --accent-soft:#e4f2f6;
  --ok:#15803d; --watch:#a1620a; --watch-soft:#fdf4e6;
  --flag:#b0201c; --flag-soft:#fdeceb;
  --shadow:0 1px 2px rgba(19,24,32,.05),0 8px 24px rgba(19,24,32,.05);
}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){
  --ground:#0e1218; --panel:#161c25; --edge:#28313d;
  --ink:#e8ecf2; --muted:#95a1b1;
  --accent:#4cc4e0; --accent-soft:#13323c;
  --ok:#5cc98a; --watch:#e0a84e; --watch-soft:#33280f;
  --flag:#f08a84; --flag-soft:#3a1a19;
  --shadow:0 1px 2px rgba(0,0,0,.4),0 8px 24px rgba(0,0,0,.35);
}}
:root[data-theme="dark"]{
  --ground:#0e1218; --panel:#161c25; --edge:#28313d;
  --ink:#e8ecf2; --muted:#95a1b1;
  --accent:#4cc4e0; --accent-soft:#13323c;
  --ok:#5cc98a; --watch:#e0a84e; --watch-soft:#33280f;
  --flag:#f08a84; --flag-soft:#3a1a19;
  --shadow:0 1px 2px rgba(0,0,0,.4),0 8px 24px rgba(0,0,0,.35);
}
*{box-sizing:border-box}
body{background:var(--ground);color:var(--ink);margin:0;
  font-family:ui-sans-serif,-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Helvetica Neue",sans-serif;
  font-size:17px;line-height:1.6;-webkit-font-smoothing:antialiased}
.wrap{max-width:1080px;margin:0 auto;padding:40px 24px 96px;display:flex;flex-direction:column;gap:36px}
header h1{font-size:clamp(30px,4vw,44px);line-height:1.1;letter-spacing:-.022em;margin:0;text-wrap:balance;font-weight:700}
.sub{color:var(--muted);margin:10px 0 0;font-size:17px;max-width:62ch}
.prov{display:flex;flex-wrap:wrap;gap:8px 20px;margin-top:18px;font-size:14px;color:var(--muted);
  font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
.prov b{color:var(--ink);font-weight:600}
.tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:14px}
.tile{background:var(--panel);border:1px solid var(--edge);border-radius:10px;padding:20px 22px;box-shadow:var(--shadow)}
.tile .n{font-size:38px;font-weight:700;letter-spacing:-.03em;font-variant-numeric:tabular-nums;line-height:1.05;
  font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
.tile .k{display:block;margin-top:8px;font-size:13px;letter-spacing:.07em;text-transform:uppercase;color:var(--muted);font-weight:600}
.tile.is-flag .n{color:var(--flag)} .tile.is-watch .n{color:var(--watch)} .tile.is-ok .n{color:var(--ok)}
.controls{display:flex;flex-wrap:wrap;gap:10px;align-items:center;position:sticky;top:0;z-index:5;
  background:var(--ground);padding:14px 0;border-bottom:1px solid var(--edge)}
button{font:inherit;font-size:15px;font-weight:600;cursor:pointer;border:1px solid var(--edge);background:var(--panel);
  color:var(--ink);border-radius:999px;padding:9px 18px}
button[aria-pressed="true"]{background:var(--accent);border-color:var(--accent);color:var(--ground)}
button:focus-visible{outline:3px solid var(--accent);outline-offset:2px}
.list{display:flex;flex-direction:column;gap:14px}
.row{background:var(--panel);border:1px solid var(--edge);border-left:5px solid var(--edge);
  border-radius:10px;padding:20px 22px;box-shadow:var(--shadow)}
.row.sev-2{border-left-color:var(--flag)} .row.sev-1{border-left-color:var(--watch)} .row.sev-0{border-left-color:var(--ok)}
.row[hidden]{display:none}
.row-head{display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:10px}
.chip{font-size:12.5px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;padding:4px 10px;border-radius:999px;
  background:var(--accent-soft);color:var(--accent)}
.chip.kind{background:transparent;border:1px solid var(--edge);color:var(--muted)}
.weight{margin-left:auto;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-variant-numeric:tabular-nums;
  font-weight:700;font-size:16px}
.weight .unit{font-weight:500;color:var(--muted);font-size:13px;margin-left:4px}
.row h3{margin:0 0 12px;font-size:19px;line-height:1.35;letter-spacing:-.01em;text-wrap:balance;font-weight:650}
.answer{margin:0 0 12px;display:flex;gap:10px;align-items:baseline;flex-wrap:wrap}
.answer-label{font-size:12.5px;letter-spacing:.07em;text-transform:uppercase;color:var(--muted);font-weight:700}
code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:15px;background:var(--accent-soft);
  color:var(--accent);padding:3px 9px;border-radius:5px;word-break:break-word}
.meta{display:flex;gap:26px;margin:0;flex-wrap:wrap}
.meta div{display:flex;gap:7px;align-items:baseline}
.meta dt{font-size:12.5px;letter-spacing:.06em;text-transform:uppercase;color:var(--muted);font-weight:700}
.meta dd{margin:0;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-variant-numeric:tabular-nums;font-weight:600}
.trials{margin:12px 0 0;display:flex;gap:8px;align-items:baseline;flex-wrap:wrap}
.trials code{background:transparent;border:1px solid var(--edge);color:var(--muted)}
.flags{list-style:none;margin:14px 0 0;padding:0;display:flex;flex-direction:column;gap:6px}
.flags li{font-size:15px;padding:8px 13px;border-radius:7px;font-weight:550}
.flags .flag{background:var(--flag-soft);color:var(--flag)}
.flags .watch{background:var(--watch-soft);color:var(--watch)}
.allclear{margin:14px 0 0;font-size:15px;color:var(--ok);font-weight:600}
footer{color:var(--muted);font-size:14.5px;border-top:1px solid var(--edge);padding-top:20px;max-width:70ch}
@media (prefers-reduced-motion:reduce){*{animation:none!important;transition:none!important}}
</style>

<div class="wrap">
<header>
  <h1>FutureX round ${esc(manifest.roundId)} — what to check before submitting</h1>
  <p class="sub">Every answer this round, ordered by how much score rides on it. Flags describe the artifact, never a guess at correctness: a question is marked because of how it was answered, not because the answer looks wrong.</p>
  <div class="prov">
    <span>model <b>${esc(manifest.model)}</b></span>
    <span>evidence frozen <b>${esc(manifest.evidenceCutoff)}</b></span>
    <span>dataset <b>${esc(manifest.revision.slice(0, 12))}</b></span>
    <span>sha256 <b>${esc(manifest.sha256.slice(0, 16))}</b></span>
  </div>
</header>

<section class="tiles">
  <div class="tile"><span class="n">${totals.rows}</span><span class="k">answers submitted</span></div>
  <div class="tile is-flag"><span class="n">${totals.flagged}</span><span class="k">need a decision</span></div>
  <div class="tile is-watch"><span class="n">${totals.watch}</span><span class="k">worth a look</span></div>
  <div class="tile is-ok"><span class="n">${totals.clean}</span><span class="k">nothing flagged</span></div>
  <div class="tile"><span class="n">${(totals.atRisk * 100).toFixed(1)}<span class="unit">%</span></span><span class="k">of score flagged</span></div>
  <div class="tile"><span class="n">${totals.sources.toLocaleString("en-US")}</span><span class="k">sources retrieved</span></div>
</section>

<div class="controls" role="group" aria-label="Filter answers">
  <button type="button" data-filter="all" aria-pressed="true">All ${totals.rows}</button>
  <button type="button" data-filter="2" aria-pressed="false">Need a decision ${totals.flagged}</button>
  <button type="button" data-filter="1" aria-pressed="false">Worth a look ${totals.watch}</button>
  <button type="button" data-filter="L4" aria-pressed="false">Level 4 only</button>
</div>

<main class="list">${byWeight.map(row).join("")}</main>

<footer>Generated from <code>${esc(path.basename(submissionPath))}</code> and its reasoning trace by <code>scripts/futurex-review-page.mjs</code>. Nothing here has been submitted — FutureX takes submissions by email only, and no command in this repo sends anything.</footer>
</div>

<script>
const buttons = [...document.querySelectorAll("[data-filter]")];
const rows = [...document.querySelectorAll(".row")];
buttons.forEach((button) => button.addEventListener("click", () => {
  buttons.forEach((other) => other.setAttribute("aria-pressed", String(other === button)));
  const filter = button.dataset.filter;
  rows.forEach((element) => {
    const show = filter === "all"
      ? true
      : filter === "L4"
        ? element.dataset.level === "4"
        : element.dataset.sev === filter;
    element.hidden = !show;
  });
}));
</script>`;

const out = outPath ?? submissionPath.replace(/\.jsonl?$/i, "") + ".review.html";
writeFileSync(out, html, "utf8");
console.log(`[OK] review page: ${out}`);
console.log(`[OK] ${totals.flagged} need a decision, ${totals.watch} worth a look, ${(totals.atRisk * 100).toFixed(1)}% of score flagged`);
