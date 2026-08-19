# FutureX 2026-08-19 · submission candidate

Last updated: 2026-08-18.　Chinese original: [`README.md`](README.md) — Chinese is authoritative.

> **Not submitted.** FutureX has no submission API; it accepts email to
> `FutureX-ai@outlook.com` only, and no command in this repo can send anything.
> What is stored here is a candidate awaiting human sign-off.

## What this is

`claude-sonnet-5` answering all **80 questions** of the round on a fixed harness.

| | |
| --- | --- |
| Model | `claude-sonnet-5` (provider `claude-cli`, drawing on a Claude subscription) |
| Evidence frozen at | `2026-08-18T02:25:21Z` |
| Submission deadline | 2026-08-19 24:00 (UTC+8) |
| Dataset revision | `2841bff13f6d2f679298ce7007e91ae585f4ade1` |
| Submission sha256 | `a49eb546cb4f44761c2195104a2ce3d542d0f3b85d8ff64807a37bcc111e0245` |
| Validation | `valid: True`, coverage 1.0, 0 errors |
| Fallback answers | 0 |
| Kinds | numeric 32 / categorical 37 / free_response 11 |

## Research depth

Compute scales with level (trials 1/2/3/4) but **effort never drops below high**:
measured on this round, low effort made the model skip retrieval entirely.

| Level | Questions | Trials | Mean sources/trial |
| --- | --- | --- | --- |
| L1 | 20 | 20 | 36.0 |
| L2 | 17 | 34 | 29.1 |
| L3 | 21 | 62 | 48.5 |
| L4 | 22 | 86 | 57.1 |

Zero-research questions: **0**. Fallback answers: **0**.

## Files

| File | Contents |
| --- | --- |
| `submission-sonnet5.jsonl` | Official `{id, prediction}`, 80 rows — this is the file that would be attached |
| `submission-sonnet5.reasoning.jsonl` | Per trial: persona, thinking, citations, raw reply, token cost |
| `submission-sonnet5.review.html` | Browser review page, ordered by score weight with provenance flags |
| `submission-sonnet5.jsonl.manifest.json` | Provenance, sha256, validation report |
| `routes.json` | This round's task routing, 80/80 approved |

## Reproducing

```bash
PREDICTOR_PROVIDER=claude-cli PREDICTOR_MODEL=claude-sonnet-5 PREDICTOR_TRIALS=4 \
npx tsx apps/benchmark-cli/src/main.ts futurex run \
  --input runtime-artifacts/futurex/2026-08-19/questions.json \
  --routes runtime-artifacts/futurex/2026-08-19/routes.json \
  --revision 2841bff13f6d2f679298ce7007e91ae585f4ade1 --round 2026-08-19 \
  --as-of 2026-08-18T02:25:21Z --deadline 2026-08-19T16:00:00Z \
  --output <out>.jsonl --allow-paid

node scripts/futurex-review-page.mjs <round-dir> <out>.jsonl
```

## Judgement calls — record

1. **The HMRC unit — decided (2026-08-18, by the user).** Three of four trials
   answered in £ billions and one in £ millions — one estimate in two units,
   1000x apart. Aggregation had followed the majority (`97.58`, billions); the
   user overrode to **`97583` in millions**, because HMRC publishes that table
   in £ millions and the benchmark grades against the official figure. The
   override is recorded in the manifest's `manualOverrides` and the submission
   sha256 was refreshed.
2. **No cross-trial unit normalisation on the numeric path (known limitation,
   not fixed this round).** Questions whose prompt names a field
   (`revenue_usd_millions`) are unaffected; those naming none are exposed. No
   heuristic was added — guessing the unit wrong is worse than not guessing —
   so the review page's unit-scale flag routes these to a human.
