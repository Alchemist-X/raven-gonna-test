# Next Development Handoff

Last updated: 2026-08-09 17:25 SGT

## Working state

- Repository: `/Users/Aincrad/dev-proj/raven-gonna-test`, an independent Git repository whose `main` branch has no commit yet.
- Local verification: `pnpm verify` passes boundary checks, TypeScript, and all 29 tests.
- FutureX read-only smoke: the pinned current revision fetched 84 tasks; routing produced 47 single, 1 multi, 18 numeric, 8 ranking, and 10 open tasks. The route artifact still requires human review before a paid run.
- ForecastBench read-only smoke: the official 500 questions expanded to 2,248 forecast rows. The baseline candidate covers market 250/250 and dataset 1,998/1,998.
- Prophet Arena: current and legacy local requests and baseline responses pass; no public HTTPS deployment exists.
- No paid Predictor call, email, GCS upload, onboarding, or external submission has occurred.

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

1. Confirm whether Predictor means `foresight-v4`; otherwise record the exact model ID, base URL, and response contract.
2. Confirm the per-round budget, stable organization/model names, and Prophet hosting target.
3. Run the first historical full-round replay with explicit `--allow-paid`. Record cost, P50/P95 latency, parse/fallback rate, coverage, and local score without using known answers or present-day pages.
4. Add round-SHA-bound FutureX route overrides for replay failures and freeze stable cases as fixtures.
5. Complete the benchmark-specific human admission steps below before creating a live candidate.

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
5. Three to five structured independent trials that record evidence for, counterevidence, open questions, and disagreement.
6. Prophet residual registry, evidence gate, shadow evaluation, and category/time-to-close calibration.
7. Adaptive compute after a complete baseline, allocated by expected score marginal value times uncertainty.

These capabilities are not implemented. The current version can produce complete, legal artifacts, but it has no champion-level score evidence.

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
