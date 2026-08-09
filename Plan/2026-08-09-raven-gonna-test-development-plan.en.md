# raven-gonna-test Development Plan

## Goal

- Build a forecasting benchmark system fully isolated from the `predict-raven` trading repository.
- Use one Predictor core across FutureX, ForecastBench, and Prophet Arena.
- Establish valid, complete, recoverable, backtestable outputs before leaderboard optimization.

## Outcome

The base version fetches official task sets, runs models or declared fallbacks, exports all three protocols, validates strictly, scores offline, and hosts a Prophet raw endpoint.

It does not submit, email, upload to GCS, onboard, or execute funds/trades. External accounts, paid rounds, and public deployment require human authorization.

## Implementation

### P0: completed

- [x] Independent Git and pnpm/TypeScript/Vitest workspace.
- [x] Six task types plus result/evidence/policy contracts.
- [x] OpenAI-compatible Foresight v4 client.
- [x] Independent trials, logit aggregation, prior shrinkage, and Platt calibration.
- [x] Baseline-first execution, timeouts, aborts, concurrency, checkpoints, and hash manifests.
- [x] FutureX fetch/route/run/export/validate/score.
- [x] FutureX inventory, explicit route-review gate, ID-selected pilot, research-snapshot validator, and per-task end-time gate.
- [x] ForecastBench fetch/expand/run/export/coverage/raw score/source baselines.
- [x] Prophet current/legacy normalization, market prior, bounded residual, geometry, and HTTP service.
- [x] Trading-dependency and core-boundary gates.
- [x] Bilingual docs, fixtures, unit/integration tests, and CLI smoke tests.

### P0.5: before a first official round

1. Confirm the exact Predictor/model ID, key, budget, and rate-limit policy.
2. Complete FutureX and ForecastBench registration/rule confirmation.
3. Freeze organization/model naming.
4. Deploy the Prophet HTTPS endpoint and pass real compatibility/load/timeout tests.
5. Run a recent historical full round and measure cost, latency, fallback rate, coverage, and local score.
6. Create round-SHA-bound FutureX routing overrides.

Gate: every benchmark has a 100%-valid local artifact; the Prophet public endpoint runs for 24 hours without 5xx; no post-cutoff evidence appears.

### P1: score optimization

1. ForecastBench specialists: DBnomics seasonal KNN/weather blend, FRED regimes, YFinance random walk, and retrained ACLED/Wikipedia priors.
2. Read-only allowlisted market-price connectors with snapshot/as-of receipts and no trading methods.
3. Three to five structured-belief trials with evidence for/against, open questions, and disagreement.
4. Rolling source/subtype/horizon calibration.
5. FutureX domain specialists, expected-F1 multi-label thresholds, and numeric nowcasts.
6. Prophet residual registry by category/subtype/time-to-close/price bin, evidence gates, and shadow deployment.
7. Adaptive compute after a complete baseline pass.

Gate: chronological backtests materially beat safety baselines; fallback is below 2%; calibration uses only prior rounds.

### P2: operations and reproducibility

1. Signed calibration/model/strategy registry.
2. Full replay and segmented ECE/Brier/Edge reporting.
3. Provider queues, retry, cost budgets, and kill switches.
4. Prophet container, TLS, metrics, alerts, canary, and rolling updates.
5. Submission receipt/hash tracking and preflight reports.
6. Resolution ingestion, postmortems, and parameter-upgrade gates.

Gate: artifacts reproduce from manifests; service failures return market priors; external submission still requires explicit confirmation.

## User Decisions

- Exact Predictor model ID. Recommended default: `foresight-v4` if no alternative is intended.
- Stable organization/model naming. Recommended default: product name `raven-gonna-test`, with base model recorded in manifests.
- Prophet hosting. Recommended default: a long-running container/VM rather than short-timeout serverless.
- Per-round model/research budget. Recommended default: approve only after a historical full-round measurement.

## Risks and Assumptions

- FutureX production judging, numeric sigma, and replacement rules still drift.
- ForecastBench dates require email confirmation and official adjusted scoring needs additional data.
- Prophet current wire, legacy rules, and Top-K normalization conflict.
- Safety baselines preserve coverage but are not champion models.
- Without a real key, Foresight full-round cost, latency, and parse success remain unverified.

## Execution Gate

- The base implementation is complete and locally verified.
- External registration, paid full rounds, and public deployment require credentials, budget, or explicit authorization.
- Local P1/P2 work can continue, but external submission, public deployment, and costly batches require renewed confirmation.
