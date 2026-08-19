# Next Development Handoff

Last updated: 2026-08-09 23:24 SGT

## Working state

- Repository: `/Users/Aincrad/dev-proj/raven-gonna-test`, public GitHub repository `Alchemist-X/raven-gonna-test`; use `main` as the current entry point.
- The separate `codex/futurex-partial-research` worktree remains at `/Users/Aincrad/dev-proj/raven-gonna-test-futurex-partial`; do not perform shared checkout/reset operations across the two worktrees.
- Local verification: `pnpm verify` passes boundary checks, TypeScript, and all 31 tests.
- FutureX read-only smoke: the pinned current revision fetched 84 tasks; routing produced 47 single, 1 multi, 18 numeric, 8 ranking, and 10 open tasks. The route artifact still requires human review before a paid run.
- ForecastBench read-only smoke: the official 500 questions expanded to 2,248 forecast rows. The baseline candidate covers market 250/250 and dataset 1,998/1,998.
- Prophet Arena: current and legacy local requests and baseline responses pass; no public HTTPS deployment exists.
- The user selected the self-developed **Raven Forecasting Engine** as the only official prediction system for all three benchmarks; no third-party forecasting model will be used.
- The current paid path still uses the legacy OpenAI-compatible client. The Raven adapter is not implemented, so every `--allow-paid` path, Prophet live onboarding, and official candidate is blocked.
- No paid Raven benchmark path, email, GCS upload, onboarding, or external submission has occurred.
- Added detailed bilingual execution docs: `docs/three-benchmark-runbook.md` and `docs/en/three-benchmark-runbook.md`. They separate implemented commands, human actions, and planned capabilities, covering preflight, pilot, all three command flows, validation, submission, recovery, timing, and cost gates.
- This Raven-only documentation update remains uncommitted and unpushed in the worktree. Check `git status` first next time; do not discard or overwrite it.

Added in this iteration:

- `futurex inspect` reports task type, level, theoretical per-item weight, task-end status, and route-review status.
- Generated routes preserve confidence/reasons and start as `pending`; paid pilot and official runs block before model calls until reviewed.
- `futurex pilot --ids ...` runs an explicit subset, checkpoints every item, pins input/route hashes, and always writes `submissionEligible=false`.
- `futurex research-validate` checks partial manual/ensemble snapshots, evidence timestamps, and answer format without weakening full-submission coverage.
- Three obvious numeric misroutes were fixed. The semantic mix is now single=47, multi=1, numeric=21, ranking=8, open=7.
- A validated ten-task shadow snapshot exists at `runtime-artifacts/futurex/shadow-2026-08-09/research-snapshot.json`; it is explicitly ineligible for submission.

`runtime-artifacts/` is Git-ignored. Its files are reproducible smoke evidence rather than long-term source of truth.

## Start here next time

```bash
cd /Users/Aincrad/dev-proj/raven-gonna-test
git status --short --branch
pnpm install
pnpm verify
pnpm doctor
```

Then:

1. Pin a full `predict-raven` Git SHA and extract only the pure forecasting seam; never import real-money commands such as `forecast:live`.
2. Implement the asynchronous Raven REST adapter (POST start → GET poll), adding fixed resolution, task ID, as-of, per-job InformationPolicy, run/replicate namespace, exact provider/model, and complete usage.
3. Add six typed outputs, joint ForecastBench horizons, and joint Prophet outcomes; keep outer replicates at one initially.
4. Add Raven engine/adapter SHAs and readiness gates to `doctor`, checkpoints, and manifests; paid paths must never fall back to the legacy client.
5. Run a 3–10 task Raven pilot and separately record framing/evidence/summary calls, token/API/subscription/extra-API cost, P50/P95, parse/fallback, and cutoff violations.
6. Review every new-round route, change `pending` explicitly to `approved/edited` with `reviewedAtUtc`, and freeze stable corrections as fixtures.
7. Complete the benchmark-specific human admission steps below before creating a live candidate.

## Not done: human and external dependencies

### FutureX

- Wait for and confirm the next official dataset SHA, window, and earliest valid deadline.
- Ask about replacement, ensemble/human review, production judge, and numeric sigma rules.
- Review low-confidence routes for every new round. Send the final JSONL manually and retain receipt/hash evidence.

### ForecastBench

- Register a Google upload email, organization or anonymous option, website, and SVG logo.
- Obtain and test the GCS folder; confirm the next date and stable model name.
- Upload the exact `<forecast_due_date>.<organization>.<N>.json` filename manually and verify object timestamp/hash.
- Local scoring is raw Brier only; reproducing difficulty-adjusted scoring still requires official question fixed effects and market reference data.

### Prophet Arena

- Select a long-running container/VM and configure HTTPS, a 32+ byte Bearer token, and hosted secrets.
- Run public health/auth/load/timeout smoke tests, then pass onboarding compatibility.
- Confirm current/legacy wire, rationale, Top-K geometry, retry/concurrency, and public-listing rules.
- Pass a 24-hour stability check and remain online for at least ten days; shadow/canary before replacement.

## Not done: score optimization

In priority order:

1. Frozen historical-evidence adapter with content snapshots, fetch time, source hashes, and cutoff validation. Citation URLs alone do not prove freedom from future leakage.
2. ForecastBench source specialists: DBnomics seasonal KNN/weather blend, FRED regimes, YFinance random walk, and ACLED/Wikipedia historical priors.
3. Rolling or leave-one-round-out calibration by source, subtype, and horizon, with segmented Brier/ECE.
4. FutureX domain specialists, expected-F1 multi-label thresholds, and numeric nowcasts.
5. Keep Raven internal rounds separate from independent replicates; run three to five structured fresh replicates only on high-value tasks, recording evidence for, counterevidence, open questions, and disagreement.
6. Prophet residual registry, evidence gate, shadow evaluation, and category/time-to-close calibration.
7. Adaptive compute after a complete baseline, allocated by expected score marginal value times uncertainty.

These capabilities are not implemented. The current version can produce legal baselines and perform fetch/routing/validation/scoring, but it cannot produce an official Raven candidate. Do not claim a complete three-benchmark run before the adapter gate passes.

## Not done: stable operations

- Signed model/calibration/strategy registry.
- Full historical replay, round comparison, and ECE/Brier/Edge dashboard.
- Durable provider queue, cost budget/kill switch, and richer rate-limit telemetry.
- Prophet container, TLS, metrics, alerts, canary, and rolling updates.
- Submission receipt/hash tracking, preflight reports, resolution ingestion, and round postmortems.

## Hard boundaries

- No wallets, signing, orders, trading SDKs, or capital logic.
- No automatic email, GCS upload, or onboarding; external actions require explicit user authorization.
- Paid calls require explicit `--allow-paid` after budget confirmation.
- No post-cutoff evidence in live candidates; live research cannot be used for historical backtests.
- Deterministic fallback is allowed only when the manifest records it explicitly.

See the [development plan](../../Plan/2026-08-09-raven-gonna-test-development-plan.en.md) for milestone gates and pending user decisions.
