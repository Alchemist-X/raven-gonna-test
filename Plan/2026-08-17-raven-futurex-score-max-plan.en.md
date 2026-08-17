# Raven-FutureX Adaptation · Score-Maximization Development Plan

> **Status: plan only, no development yet.** This is the development plan for a
> FutureX-specific adaptation of the Raven engine (hereafter **raven-futurex**).
> Execution requires user sign-off on budget and timeline.
> Chinese original: [`2026-08-17-raven-futurex-score-max-plan.md`](2026-08-17-raven-futurex-score-max-plan.md) — Chinese is authoritative.

Last updated: 2026-08-17

## 0. Background and goal

- Status quo: of the 80 questions in the 2026-08-19 round, the generic binary
  Raven serves 12 (see [`pilots/futurex/2026-08-19-3tier/`](../pilots/futurex/2026-08-19-3tier/)).
  **Theoretical score ceiling ≈ 0.13** — missing answers score 0, and the 12
  covered questions are almost all lowest-weight L1.
- Goal: build the raven-futurex layer — **answer every question, derive each
  answer from the scoring rule, allocate compute by level weight** — targeting
  **0.5–0.65** per round.
- Non-negotiables kept: as-of evidence freeze (no information after a
  question's end_time), traceable sources, and a manifest that records each
  question's method and any fallback honestly.

## 1. Ground truth: scoring rules → optimal decision rules

All rules from this repo's [`packages/benchmarks/src/futurex/scorer.ts`](../packages/benchmarks/src/futurex/scorer.ts):

| # | Scoring rule (line) | Optimal decision rule |
|---|---|---|
| R1 | Missing = 0, no penalty (L57) | **Answer everything.** Abstention is strictly dominated; replace fail-closed with fallback-plus-labeling |
| R2 | overall = 0.1·L1 + 0.2·L2 + 0.3·L3 + 0.4·L4 (L105) | Marginal value: L4 ≈ 3.6× L1 (0.4/22 vs 0.1/20). **Allocate compute by level, descending**; L3+L4 (43 questions) carry 70% of the score |
| R3 | single_choice exact match, no partial credit (L61) | Only argmax matters; calibration buys nothing — spend on ranking correctness |
| R4 | numeric: max(0, 1−((x−t)/σ)²), σ = 5%·\|t\| (L36-40) | **Grid-search the expected score** over the predictive distribution — not mean, not median. Analyst consensus is typically within 1–3%; the ±5% window is generous |
| R5 | multi_choice: set-F1 (L64) | Per-candidate inclusion probability → enumerate subsets for max expected F1 (small candidate sets — exhaustive is fine) |
| R6 | ranking: exact = 1, else 0.8 × overlap; duplicates = 0 (L69-77) | Secure the set first, then order by marginal win probability; dedupe before emitting |
| R7 | open_text: exact match locally, semantic judge in production (L88-90) | Candidate generation → binary-engine verification per candidate → emit canonical official spelling |
| R8 | kind = `task_type ?? routeFutureXQuestion` (L42-44) | **Classification authority = this repo's router / routes.json**; predict-raven's regex classifier is demoted to cross-check (they currently disagree on ~15 questions) |

## 2. Architecture decisions

- **Code lives in this repo, new package `packages/raven-futurex`.** The
  scorer, router, submission protocol and route-review gate are all here;
  predict-raven stays a generic binary engine, unpolluted by benchmark-specific
  score maximization.
- **Engine access: port predict-raven's minimal Claude CLI harness**
  (`claude --print --output-format stream-json` + source tracing + fail-closed
  validation, ~300 lines, source `predict-raven@codex/futurex-raven-adapter`).
  No workspace dependency; ported files carry a provenance header.
- **Three tiers kept** (Urd = haiku-4.5/low, Verdandi = sonnet-5/medium,
  Skuld = opus-5/high) but switched from all-tier comparison to
  **level-based allocation + escalation on disagreement** (§4).
- **routes.json is the sole classification source**; suspected misroutes go
  through human review to fix the route, never a code workaround.

## 3. Work breakdown

### P0 · Skeleton and gates (0.5 day)

- routes.json loader (revision match enforced; pending routes block a real run — review flow in P5)
- Answer-everything runner: question → per-kind solver dispatch → fallback
  chain on failure (cheap-tier retry → floor heuristic), `method` + fallback
  reason recorded per question
- Official JSONL output passing this repo's `futurex validate`
- Level-based budget allocator, question-level parallel scheduling
- **Acceptance: end-to-end on a synthetic set, 80/80 answered, validate passes, manifest complete**

### P1 · Numeric solver (20 questions, heavy L3/L4; 1 day)

- Research emits a **predictive distribution**: earnings = analyst consensus +
  guidance + historical beat/miss spread as Monte Carlo samples; macro/count =
  base rate + recent trend
- Decision: `score(x) = mean_j max(0, 1−((x−t_j)/(0.05·|t_j|))²)`, argmax on a
  grid; degrades to the mean for tight distributions, dodges the between-modes
  trap for bimodal ones
- Output precision matches the prompt contract (no units, no commas)
- **Acceptance: unit tests for tight / wide / bimodal / truth≈0 (zeroSigma); backtest on resolved questions beats the plain-mean strategy**

### P2 · Single-choice solver (37 questions incl. the 12 binaries; 1 day)

- One shared research pass → probability simplex over options (harness rejects
  non-normalized output), submit argmax
- L3/L4 with top-2 gap < 0.15: add a one-vs-rest pair as tiebreak
- The 12 binary questions reuse the existing binary path; only answer
  serialization aligns to route keys (`Yes`/`No` vs `A`/`B`)
- **Acceptance: replay of the 12 binaries matches the high-tier pilot conclusions; simplex validation rejects non-normalized output**

### P3 · Open-text solver (22 questions; 1 day)

- Candidate generation (independent retrieval) → binary engine asks "will the
  official answer be X" per candidate → argmax
- Canonicalization: official spelling (the scorer only lowercases and folds
  whitespace); candidates and rationale stored in the manifest for
  semantic-judge disputes
- **Acceptance: empty candidate set degrades to most-frequent retrieved entity, labeled; no explanatory prose in answers**

### P4 · Multi-choice + ranking (~4 questions; 0.5 day)

- multi_choice: inclusion probabilities → exhaustive subset max of expected F1
- ranking: order by marginal win probability (Plackett-Luce if candidate count
  grows), dedupe before emitting (duplicates score 0)
- **Acceptance: expected-F1 enumeration unit-tested (incl. empty/full-set edges); ranking output duplicate-free**

### P5 · Submission pipeline and route review (0.5 day + human time)

- Route-review tool: one-page checklist for all 80 routes (prompt + router
  verdict + our classifier cross-check, disagreements highlighted), bulk human
  approve writes `reviewedAtUtc` — **a protocol gate needing the user, est. 30–60 min**
- Real runs adopt this repo's `futurex run` semantics: pending-route block,
  deadline check, submission manifest
- Post-resolution backfill: run the local scorer, per-level results archived
  under `pilots/` (or promoted to an official record)
- **Acceptance: one full dry-run rehearsal (no model spend); live run passes validate + 3-question human spot check**

## 4. Compute budget and scheduling

Per-question cost from the 8/17 pilot (nominal API-equivalent; actual spend is
Max-subscription quota): Urd ≈ $0.70, Verdandi ≈ $3.2, Skuld ≈ $4.5;
open-text/multi-option scale 2–3× with candidate count.

| Level | Count | First tier | Escalation | Budget (nominal) |
|---|---|---|---|---|
| L1 | 20 | Urd | none | ~$15 |
| L2 | 17 | Verdandi | none | ~$55 |
| L3 | 21 | Verdandi | close top-2 or cross-tier disagreement → Skuld | ~$70–100 |
| L4 | 22 | Skuld | direct high tier | ~$100–150 |

**Per round: ~$240–320 nominal, 3–5 h wall clock (4 parallel workers).**
Escalation-on-disagreement is grounded in the pilot: its single cross-tier
split (Duplantis, 92.3pp spread) was precisely a low-tier directional failure —
disagreement is the most reliable escalation signal we have.

## 5. Risks

| Risk | Mitigation |
|---|---|
| Production semantic judge diverges from local exact match (open_text) | Canonical official spelling; manifest keeps candidates + rationale for dispute review |
| No findable consensus for odd numeric metrics | Degrade to base-rate distribution, widen the grid, label `method: base-rate` |
| Router misroutes (~15 disagreements with our classifier) | P5 checklist highlights them for human adjudication; fix the route, never bypass |
| High-tier 0.99 saturation (5 cases in the pilot) | argmax unaffected (R3); numeric/multi paths clamp probabilities at 0.98 before deciding |
| 8/19 window (earliest end_time 20:00 GMT+8) | §6; if development slips, ship P0+P1+P2 (57 questions ≈ 85% of the reachable pool), P3/P4 fall back to floor answers |
| Claude CLI credential failure (8/17 keychain-ACL incident) | Preflight fires a 1-token liveness call; abort with the fix command on failure |

## 6. Timeline (assuming start 8/18 morning)

- **8/18 AM**: P0; **8/18 PM**: P1 + P2 in parallel
- **8/18 evening**: P5 dry-run + route review (user: 30–60 min)
- **8/19 AM**: P3 + P4; **8/19 early PM**: live run, all locked before the earliest 20:00 end_time
- 8/20+: resolution backfill and retrospective

## 7. Decisions needed from the user

1. **Budget**: is ~$240–320 nominal per round (Max quota) acceptable
2. **Route review**: human approval of 80 routes (~30–60 min, tooling will compress it)
3. **Submission stance**: does the live-run output go through the manual email
   submission flow as this round's official candidate (FutureX has no
   submission API; the runbook prescribes the email body fields)
