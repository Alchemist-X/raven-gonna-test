# FutureX submission email format

Last updated: 2026-08-19.　Chinese original: [`../futurex-submission-email.md`](../futurex-submission-email.md) — Chinese is authoritative.

FutureX has **no submission API**; it accepts email only (per its HuggingFace
dataset page). No command in this repo can send anything either — `futurex run`
writes files, and sending is a human step. This is the template we actually
send, so nobody has to redesign it each round.

## Hard requirements (set by the organizers)

- **Attach the official JSONL only** — `{id, prediction}`, one line per question.
  Reasoning traces and manifests are never attached; supply them separately if
  the organizers ask to audit.
- Recipient `FutureX-ai@outlook.com`.
- Must arrive before that round's deadline (typically 24:00 UTC+8 on the round date).

## Body fields

The organizers do not prescribe a body; the list below is this repo's
convention (runbook D7). The principle: **let the organizers uniquely identify
who submitted, with which model, against which revision of the questions**, and
let them verify the attachment arrived intact.

| Field | Why |
| --- | --- |
| Entry name | The leaderboard name. `<org>/<model>`, e.g. `raven_labs/claude-opus-5` |
| Organization | Who submitted |
| Model | Full model name, and whether it used live research |
| Agent framework | This repo plus the **full commit SHA**, so the result is reproducible |
| Dataset revision | The 40-char question-set SHA, proving which revision was answered |
| Coverage | `answered/total` |
| Evidence cutoff | The `--as-of` freeze, asserting nothing later was used |
| Attachment SHA-256 | Detects a corrupted or substituted attachment |
| Visibility | Whether the entry may be listed publicly |

**Use the real model name in the entry, never an internal codename.** A
leaderboard row is read as "who ran which model"; a codename makes that
impossible for anyone outside these repos.

## Template

> **To:** FutureX-ai@outlook.com
> **CC:** issue.00.gui@gmail.com, millank0817@gmail.com, 1700012744@pku.edu.cn
> **Subject:** FutureX submission — round `<ROUND>` — `<ENTRY_NAME>`
> **Attachment:** `<submission>.jsonl`

```text
Hello FutureX team,

Please find attached our submission for the <ROUND> round.

- Entry name: <ENTRY_NAME>
- Organization: <ORG>
- Model: <MODEL> (<VENDOR>), with live web research
- Agent framework: raven-gonna-test, commit <FULL_COMMIT_SHA> (github.com/Alchemist-X/raven-gonna-test)
- Dataset revision: <DATASET_SHA_40>
- Coverage: <N>/<TOTAL> questions
- Evidence cutoff: all answers were produced with research frozen at <ISO8601>, before every question's end time
- Attachment SHA-256: <SHA256>
- Visibility: public — fine to list on the leaderboard

Per-question reasoning traces and provenance manifests are archived in the repository above and available on request.

Best regards,
<ORG>
```

## Worked example (round 2026-08-19)

Three submissions shared one harness, one prompt and one evidence cutoff, so
**the model was the only variable** — which is what makes the comparison a
model comparison rather than a scaffold comparison.

> **Subject:** FutureX submission — round 2026-08-19 — raven_labs/claude-opus-5
> **Attachment:** `submission-opus.jsonl`

```text
- Entry name: raven_labs/claude-opus-5
- Organization: raven_labs
- Model: claude-opus-5 (Anthropic), with live web research
- Agent framework: raven-gonna-test, commit 9cfa3e31aac7c9ed9b14d80884379837b760ae4a
- Dataset revision: 2841bff13f6d2f679298ce7007e91ae585f4ade1
- Coverage: 80/80 questions
- Evidence cutoff: 2026-08-18T02:25:21Z
- Attachment SHA-256: 4318d9c68cc8147d7ad986e419d4f93e16b5a5d315738c8b94cf41278937673a
- Visibility: public
```

The other two differ only in entry name, model, attachment and hash. Full
record: [`rounds/futurex/2026-08-19/SUBMISSIONS.json`](../../rounds/futurex/2026-08-19/SUBMISSIONS.json).

## Where the values come from

```bash
# Attachment hash — must be of the exact file you attach
shasum -a 256 rounds/futurex/<round>/submission-<model>.jsonl

# Agent framework commit
git rev-parse HEAD

# Dataset revision / evidence cutoff / coverage
python3 -c "import json;m=json.load(open('rounds/futurex/<round>/submission-<model>.jsonl.manifest.json'));print(m['revision'],m['evidenceCutoff'],m['records'])"
```

**Recompute the hash after any edit to the submission.** This round's HMRC
question took a manual unit correction and the hash changed with it; a hash that
does not match the attachment leaves the organizers unable to tell a transfer
problem from a different file.

## After sending (runbook D7)

Record in `rounds/futurex/<round>/SUBMISSIONS.json`: send time, recipients and
CCs, subject, attachment SHA-256, and each entry's known caveats (questions
answered without sources, any manual correction). **Record the caveats
honestly** — the leaderboard returns one number, and this file is the only
thing that can explain it.
