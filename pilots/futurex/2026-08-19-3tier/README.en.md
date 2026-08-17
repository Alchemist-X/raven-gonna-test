# FutureX 2026-08-19 · Raven three-tier pilot

Last updated: 2026-08-17

> ⚠️ **This is not a submission for the round.** `manifest.json` hard-codes
> `submissionEligible: false`. The files use the official `{id, prediction}`
> JSONL shape but **do not meet the submission bar** — see "Why this cannot be
> submitted" below.

Chinese original: [`README.md`](README.md). Chinese is authoritative.

## What this is

The `predict-raven` FutureX adapter run over the same questions at **three
model tiers**, to measure what the tier difference actually buys.

| Tier | Model | Effort | Max evidence rounds |
| --- | --- | --- | --- |
| Urd / low | `claude-haiku-4-5-20251001` | low | 1 |
| Verdandi / medium | `claude-sonnet-5` | medium | 2 |
| Skuld / high | `claude-opus-5` | high | 3 |

12 binary questions × 3 tiers = 36 jobs. All completed, zero failures.

## Headline finding

**The tiers disagreed on only 1 of 12 questions — and that one is a serious
low-tier failure.**

Question: *Will Armand Duplantis clear 6.20m at the 2026 Athletissima men's
pole vault?*

| Tier | P(Yes) | Answer | Sources |
| --- | --- | --- | --- |
| Urd | 94.3% | A = Yes | 4 |
| Verdandi | 2.7% | B = No | 7 |
| Skuld | 2.0% | B = No | 16 |

A 92.3pp spread. 6.20m is world-record territory, so the high tiers' ~2% is
the defensible read; Urd ran one round, found four sources, and returned 94% —
directionally wrong. **The value of the tier is not a few points of accuracy;
it is avoiding one badly wrong call.**

Other observations:

- Source count rises monotonically with tier (Urd 3–6 / Verdandi 5–9 / Skuld 8–20).
- Skuld pinned 0.99 on 5 questions — a saturation tendency worth watching.
- Nominal cost: Urd $8.37 / Verdandi $38.21 / Skuld $53.94 (the CLI's
  API-equivalent accounting; the run drew on a Max subscription).
- Wall clock: Urd 56.6 min / Verdandi 56.0 min / Skuld 136.8 min (tiers run in parallel).

## Why this cannot be submitted

1. **Coverage is 12/80.** Only 12 of the round's 80 questions are binary
   (6 direct `\boxed{Yes}/\boxed{No}` + 6 two-option `\boxed{A}/\boxed{B}`).
   The other 68 are numeric / single_choice / open_text / ranking, which the
   binary engine cannot serve; they are blocked by `executableByRaven: false`.
2. **It bypassed the `futurex run` protocol.** These artifacts come from the
   `predict-raven` adapter, not this repo's submission pipeline.
3. **Routes are unreviewed.** All 80 `routes.json` entries were still
   `review.status: pending` at generation time, and the README requires a real
   run to block on pending routes before calling any model.

All three gaps must close before any of this becomes a submission candidate.

## Files

| File | Contents |
| --- | --- |
| `submission-{urd,verdandi,skuld}.jsonl` | Per-tier answers, official `{id, prediction}` shape, 12 lines each |
| `manifest.json` | Provenance, coverage, eligibility, both repos' HEAD SHAs |
| `three-tier-report.pdf` | Full report: adaptation method, 80-task classification, the 12×3 grid, per-tier cost |

## Reproducing

Every forecast was made before its question's `end_time`, with evidence frozen
at `as-of = 2026-08-17T19:14:57+08:00`.

```bash
# In predict-raven (branch codex/futurex-raven-adapter):
npx tsx scripts/forecast/futurex.ts \
  --questions <raven-gonna-test>/runtime-artifacts/futurex/2026-08-19/questions.json \
  --revision 2841bff13f6d2f679298ce7007e91ae585f4ade1 \
  --as-of 2026-08-17T19:14:57+08:00 \
  --binary-all --profile <urd|verdandi|skuld> --run-id futurex-20260817T191457 \
  --artifact-root runtime-artifacts/futurex-adapter --allow-paid
```

Per-job state and reasoning reports stay in predict-raven under
`runtime-artifacts/futurex-adapter/futurex-20260817T191457/<tier>/<task-id>/`
(not committed).
