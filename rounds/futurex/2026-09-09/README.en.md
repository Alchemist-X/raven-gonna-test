# FutureX 2026-09-09 · submission candidate (claude-fable-5-1, max effort)

Last updated: 2026-09-09 23:55 (UTC+8). Chinese version: [`README.md`](README.md).

> **Sent by a human.** FutureX only accepts email to `FutureX-ai@outlook.com`; the body is in [`email-fable51.txt`](email-fable51.txt), the log in [`SUBMISSIONS.json`](SUBMISSIONS.json). This was a **50-minute time-boxed** run; the result is incomplete and every row's source is recorded below.

| Item | Value |
| --- | --- |
| Model | `claude-fable-5-1` (provider `claude-cli`, `--effort max`, Claude Max subscription) |
| Dataset | revision `30c9fba49e4b37b12db857714a0b6884d80c6cfa` (80 questions, 20 per level); routes reviewed by Codex, see below |
| Evidence as-of | `2026-09-09T15:03:16Z`; research window closed at `2026-09-09T15:45:58Z` |
| Deadline | 2026-09-09 24:00 (UTC+8) = `2026-09-09T16:00:00Z` |
| Attachment sha256 | `55c7b0a9df56f400af867fb2d01da428f03a438bf51475b4f881ff8a8ac607cd` |
| Validation | strict validator `valid: true`, coverage 1.0, 0 errors, 0 warnings |
| Answer sources | harness 29 / spliced 23 / deterministic fallback 28 |

## Answer sources by level

| Level | harness (fable 5.1 + web research) | spliced | fallback | kinds |
| --- | --- | --- | --- | --- |
| L1 | 14 | 6 | 0 | single_choice 20 |
| L2 | 7 | 13 | 0 | single_choice 20 |
| L3 | 5 | 2 | 13 | numeric 17 / open_text 3 |
| L4 | 3 | 2 | 15 | ranking 14 / numeric 4 / open_text 2 |

- **Harness, 29 questions**: 39 trials, 4,354 source URLs (21 questions with 1 trial, 6 with 2, 2 with 3). The 8 questions already past their end time were researched for their published results under `--closed-questions research`.
- **Spliced, 23 questions** (per-row record in [`submission-fable51.jsonl.splice-record.json`](submission-fable51.jsonl.splice-record.json) and [`submission-fable51.overrides.json`](submission-fable51.overrides.json)): 19 L1/L2 single-choice rows answered by two Fable 5.1 research agents (Claude Code sessions, 1–2 searches per question); the Spotify UK No. 1 taken from the current kworb chart ("Rein Me In" holding), the solar-flare class set to C-class from SWPC probabilities; the CVE/NCT identifier sets, unknowable ahead of time, set to the empty set `[]`.
- **Fallback, 28 questions**: 15 numeric and 13 ranking rows, all L3/L4 questions the harness never reached, filled by the deterministic fallback rule (expected score ≈ 0).

## Run history

1. **Huginn (raven-labs server) main run**, launched 15:03Z: 24-way concurrency, trial ceiling 3 (1/2/3/3 by level), 10-minute trial timeout. The server's Claude CLI 2.1.241 did not support Fable 5.1 (≥2.1.251 required); upgraded to 2.1.266. At ~15:09Z the shared OAuth token hit `You've hit your session limit · resets 12:50am (Asia/Shanghai)`; new trials failed instantly, in-flight ones finished: 26 valid questions ([`submission-fable51.huginn-checkpoint.json`](submission-fable51.huginn-checkpoint.json)).
2. **Local resume #1**, 15:13Z: Huginn's valid results carried as the checkpoint (identity.trials set to 1), 16-way on macOS. Five minutes in, 64 trials failed with `Failed to authenticate. API Error: 403 Request not allowed` (account-level throttling; 1s/2s retries too short). One new question.
3. **Local resumes #2/#3**, 15:26Z / 15:35Z: 8-way, 5–40s retry backoff, timeout 8→14 min. Nine new questions. The harness orders tasks by `end_time`, not level, so most L3/L4 sat at the back of the queue; 6 of 8 first-wave trials hit the 8-minute timeout; the last wave was restarted at 15:43Z after a session interrupt and did not finish before the cutoff.
4. **Assembly**, 15:46Z: three checkpoints merged (most trials wins per question), remaining fallback rows spliced as above, strict validator passed.

Full logs: [`submission-fable51.local-run.log`](submission-fable51.local-run.log); per-question trials/citations/sources: [`submission-fable51.reasoning.jsonl`](submission-fable51.reasoning.jsonl); manifest: [`submission-fable51.jsonl.manifest.json`](submission-fable51.jsonl.manifest.json) (code `f7941fe` on Huginn, `c62f147` locally — identical run code).

## Lessons for the next round

- One Claude Max token cannot carry a full max-effort round: the shared Huginn token capped out after ~50 max-effort trials; the local account throttled at 16-way and was only stable at 8-way. **Start at least 3 hours before the deadline, or split questions across independent accounts.**
- The harness processes tasks in `end_time` order; under a time limit, split the input by level first (as run4 did) or the high-weight L3/L4 questions run last.
- `futurex run` writes no submission when it aborts mid-way (the numeric-fallback assertion throws first); the ad-hoc `assemble-final.mjs` (merge checkpoints → build → validate) belongs in `scripts/`.

## Question configuration (Codex review, unchanged)

Questions are pinned to official revision `30c9fba49e4b37b12db857714a0b6884d80c6cfa` (80 questions). Raw prompts in [questions.json](questions.json), provenance in [questions.json.manifest.json](questions.json.manifest.json); kinds, cardinality and units reviewed in [routes.json](routes.json), with the 16 route corrections and hashes in [preparation.json](preparation.json): 40 single-choice, 21 numeric (each with `targetField / definition / unit / scale`), 14 ranking, 3 single-entity text and 2 unordered identifier sets. Numeric contract format: [docs](../../../docs/en/futurex-numeric-contract.md).
