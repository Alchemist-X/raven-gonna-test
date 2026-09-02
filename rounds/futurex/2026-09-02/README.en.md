# FutureX 2026-09-02 · submission candidate

Last updated: 2026-09-02 21:00 (UTC+8). Chinese original: [`README.md`](README.md).

> **Not yet submitted.** FutureX has no submission API; it only accepts email to
> `FutureX-ai@outlook.com`, and nothing in this repository can send anything. This
> directory holds the candidate awaiting a human decision; the email body is in
> [`email-opus.txt`](email-opus.txt).

## What this is

This round was run **locally (macOS dev machine)** with `claude-opus-5` over all 75
questions, on the same harness as the 2026-08-26 formal server run (`claude-cli`
provider, context isolation, level-scaled trials) plus this round's four fixes
(see "Harness changes" below).

| Item | Value |
| --- | --- |
| Model | `claude-opus-5` (provider `claude-cli`, Claude Max subscription) |
| Research effort | high (trial ceiling 4, allocated 1/2/3/4 by level) |
| Evidence cutoff (as-of) | `2026-09-02T08:26:26Z` |
| Submission deadline | 2026-09-02 24:00 (UTC+8) = `2026-09-02T16:00:00Z` |
| Dataset revision | `c8fcda646d7186ffcdff745b10862a116f9df36e` (75 questions: L1 20 / L2 20 / L3 20 / L4 15) |
| Attachment sha256 | `cf85bca15d74dd580933ad99b11d1b683d54867428bb6adf499e932dcac2ef36` |
| Validation | `valid: true`, coverage 1.0, 0 errors, 0 warnings |
| Fallback answers | 0 (the 4 questions already closed at the cutoff were answered with retrieval withheld, see below) |
| Task mix | single_choice 40 / numeric 19 / ranking 12 / open_text 4 |
| Code | first pass `797056c`, resume `866c0a5`, re-derivation `d2b86a1` (see manifest `codeSha` chain) |

## Research depth

| Level | Questions | Trials | Mean searches / trial | Mean source URLs / trial |
| --- | --- | --- | --- | --- |
| L1 | 20 | 24 | 5.6 | 33.3 |
| L2 | 20 | 42 | 5.0 | 30.8 |
| L3 | 20 | 59 | 7.2 | 37.7 |
| L4 | 15 | 56 | 11.1 | 73.3 |

181 trials, 1,391 searches, 8,426 source URLs in total; about $166 at API list price
(actually spent on the subscription). Zero-research questions: **2** (the two MLB
single-game total-runs questions, where the model judged the outcome unknowable and
answered 9 / 8 from base rates, unanimously across trials).

## Special handling this round (all recorded)

1. **Four questions were already past end_time when the run started** (South Korea
   August CPI, the Lords regret amendment, the RBNZ OCR, Australia Q2 GDP). The live
   run does not research those and falls back to a deterministic answer (uniform,
   option A). They were then answered by
   [`scripts/futurex-closed-no-web.mjs`](../../../scripts/futurex-closed-no-web.mjs)
   with **no retrieval tools at all** (3 trials; any tool call fails the whole step)
   and spliced back by `futurex-splice-answers.mjs`: A→B, A→B, A→A, A→C. The raw
   trials and before/after values are in the manifest's `splicedRows` and in
   `submission-opus.closed-no-web.json`.
2. **Ten routes overridden by hand.** The merged detector routed "who wins Vuelta
   stage 11/12", "Dragon Award best digital game" and "YouTube global weekly #1
   music video" as numeric, and the F1 podium / F2 and F3 sprint top five / European
   Masters top five / WTT semifinalists / five Scottish NHS boards as numeric too (no
   "top N" wording). Each was set to open_text / ranking with `review.status=edited`
   and notes in `routes.json`; the other 65 were approved. Four independent audit
   agents plus two refuters reviewed all 75 routes
   ([`route-audit-summary.txt`](route-audit-summary.txt)); the only objection was the
   sign convention of the BEA trade deficit, a forecasting rather than routing matter.
3. **The first pass lost 13 trials near its end** to a transient `403 Request not
   allowed` burst and 900 s timeouts (12 concurrent CLIs). The four questions that
   lost more than half their trials (Japan household spending 0/3, Japan current
   account 1/3, Box Office Mojo weekend top five 1/4, YouTube US weekly top five
   2/4) were removed from the checkpoint with `futurex-checkpoint-drop.mjs` and
   forecast again on `--resume`; the backup is
   `submission.jsonl.checkpoint.first-pass.json`. Three other questions kept 2/3–3/4
   of their trials.
4. **Two ranking rows re-derived after an aggregation fix.** Borda treated the two
   capitalisations of `Somna med Humlan Djojj` as two entities, so the Swedish albums
   answer listed one title twice (scored 0 by the grader). Aggregation now folds case
   and prefers the exact order a strict plurality of trials agree on;
   `futurex-reaggregate.mjs` replayed it over the existing trials (no new research):
   one row each on the albums and singles charts, recorded in the manifest under
   `reaggregated.changed`.

## Harness changes this round (all committed; `pnpm verify` passes 213 tests)

- The prompt sentence "Report the value in X." becomes the task unit and the prompt
  spells out the implied scale (`USD billion`, `JPY 100 million`, …); count units
  (patients/kits/reports…) and "total runs" force whole-number answers.
- Ranking serialisation drops commas inside an entity (the official extractor splits
  on commas and does not parse CSV quoting).
- The open-text prose check needs a digit after a colon (`Hollow Knight: Silksong`
  was rejected and blocked the whole submission).
- `403 Request not allowed` joins the bounded retry.
- New scripts: `futurex-closed-no-web.mjs`, `futurex-splice-answers.mjs`,
  `futurex-checkpoint-drop.mjs`, `futurex-reaggregate.mjs`, `futurex-round-stats.mjs`.

## Files

| File | Purpose |
| --- | --- |
| `submission-opus.jsonl` | Official `{id, prediction}` format, 75 rows — the attachment |
| `email-opus.txt` | Email body with recipients, CC, subject and hash filled in |
| `submission-opus.jsonl.manifest.json` | Provenance chain: raw run → no-web splice → ranking re-derivation; sha256, validation |
| `submission-opus.reasoning.jsonl` | Per trial: persona, search queries, source URLs, raw reply, tokens; derivation per question |
| `submission-opus.review.html` | Browser review page ordered by score weight with flagged rows |
| `submission-opus.stats.json` / `.audit.json` | Research depth per level, zero-research questions, usage totals |
| `submission-opus.closed-no-web.json` | The no-web answers for the 4 closed questions |
| `submission-opus.run-metadata.json` | Launch parameters (model, concurrency, effort, as-of, code SHA, host) |
| `routes.json` (+manifest) | This round's routes, 75/75 reviewed (10 edited, 65 approved) |
| `questions.json.manifest.json` | Dataset file hashes (parquet sha256 `fd378ac6…`) |
| `route-audit-summary.txt` | Route audit verdicts |

## Reproduce

See the command block in [`README.md`](README.md); it is identical.

## Human judgement log

1. **Trade deficit sign (`baf399b4`)**: the prompt asks for the "deficit" in USD
   billion, so the positive BEA headline magnitude is submitted. No code-level clamp;
   if the official truth is recorded negative the question scores 0.
2. **Two MLB total-runs questions with zero research**: the base-rate answers (9, 8)
   were accepted; a single game's total has little retrievable edge.
3. **The fable-5 second candidate**: see the next section. The two models agree on 55/75
   questions (numeric within the 5% tolerance) and differ on 20 (weight 0.375); the
   disagreement sits in the L4 rankings (10 of 12 differ in at least one position) and
   in sports/chart questions, while the macro releases mostly agree.

## Second candidate: claude-fable-5

Launched after opus finished (as-of `2026-09-02T09:23:20Z`, concurrency 8). From
question 29 every trial failed because the subscription session limit was exhausted
("session limit · resets 8:50pm"); after the 20:52 (UTC+8) reset it was resumed with
`--resume --retry-fallbacks` and finished at `2026-09-02T13:35:11Z`. **The research
window is therefore 09:23Z–13:35Z**, but every question's retrieval is hard-stopped one
minute before that question's own end time (the batch's per-task cutoff), so no
question was researched after it resolved; the email body states this window.

| Item | Value |
| --- | --- |
| Attachment | `submission-fable.jsonl`, sha256 `25519f9639ff5b997f7142e025e5cdf3521ba438d5321bf7b95658a8c02f9e9d` |
| Validation | valid, 75/75, 0 fallback, 0 zero-research (the 4 closed questions answered with retrieval withheld: B/B/A/C, same as opus) |
| Trials | 184 (L1 24 / L2 42 / L3 59 / L4 59), 1,038 searches, 6,466 source URLs; 2 trials lost to the session limit |
| Ranking re-derivation | 4 rows changed (two Swedish chart answers carried a case-variant duplicate, now gone) |
| Email body | `email-fable.txt` |
| Other files | `submission-fable.{jsonl.manifest.json,reasoning.jsonl,review.html,stats.json,audit.json,closed-no-web.json,run-metadata.json}` |
