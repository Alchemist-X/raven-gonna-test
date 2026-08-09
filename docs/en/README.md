# raven-gonna-test

`raven-gonna-test` is a standalone, non-trading forecasting benchmark toolkit. It separates a general forecasting core from the wire contracts of three live evaluation systems:

- [FutureX](https://futurex.live/): multi-type point predictions exported as strict `{id,prediction}` JSONL.
- [ForecastBench](https://www.forecastbench.org/): batch market and dataset probabilities exported as GCS-ready JSON.
- [Prophet Arena](https://www.prophetarena.co/): a persistent raw forecasting endpoint that uses Kalshi quotes as priors and applies bounded residual updates.

The repository never sends email, uploads to GCS, performs onboarding, connects a wallet, or places an order. Commands only fetch, generate, validate, or score artifacts offline.

## Implemented

As of 2026-08-09, the first runnable version includes:

- binary, categorical, multi-label, ranking, numeric, and free-response tasks;
- an OpenAI-compatible Predictor client with Foresight v4 `answer_type`, `research`, and `reasoning_effort` support;
- independent trials, logit pooling, prior shrinkage, probability constraints, and Platt calibration;
- explicit information policies and evidence cutoffs;
- true pinned-revision FutureX Parquet ingestion through `/resolve/<SHA>/...`, source hashing, routing, JSONL export/validation, and a versioned local scorer;
- ForecastBench dynamic-horizon expansion, source safety baselines, 100% coverage validation, and raw Brier scoring;
- Prophet Arena current/legacy schemas, two-sided-ask midpoint priors, bounded residuals, geometry projection, and a Bearer-authenticated HTTP service;
- resumable validated checkpoints, no-clobber outputs, explicit paid-call opt-in, hashes, a process-wide concurrency gate, boundary checks, and offline fixtures.

A full paid round has not been run with a real Predictor key, and nothing has been submitted externally.

## Quick start

Node.js 20+ and pnpm 10 are required.

```bash
pnpm install
cp .env.example .env
pnpm verify
pnpm doctor
```

For live model calls, set secrets in the local or hosted environment:

```bash
export PREDICTOR_API_KEY="..."
export PREDICTOR_MODEL="foresight-v4"
export PREDICTOR_BASE_URL="https://api.lightningrod.ai/v1/openai"
```

Never place keys in submissions, manifests, command output, or Git.

## Commands

```bash
# FutureX
pnpm cli futurex discover
pnpm cli futurex fetch --revision <40-char-sha> --output <questions.json>
pnpm cli futurex route --input <questions.json> --revision <40-char-sha> \
  --output <routes.json>
pnpm cli futurex run --input <questions.json> --routes <routes.json> \
  --revision <sha> --round <id> --as-of <ISO> --deadline <ISO> \
  --output <submission.jsonl> --allow-paid
pnpm cli futurex validate --input <questions.json> --submission <submission.jsonl>

# ForecastBench
pnpm cli forecastbench fetch --question-set YYYY-MM-DD-llm.json --output <questions.json>
pnpm cli forecastbench run --input <questions.json> \
  --output <YYYY-MM-DD.organization.N.json> \
  --organization <name> --model-name <name> --model-organization <name> --baseline-only
pnpm cli forecastbench validate --input <questions.json> \
  --submission <YYYY-MM-DD.organization.N.json>

# Prophet Arena
pnpm cli prophet predict --input <request.json> --output <response.json> --baseline-only
export PROPHET_BEARER_TOKEN="<32+ byte random token>"
pnpm prophet:serve
```

Remove `--baseline-only` to call the configured Predictor. The CLI still does not perform an external submission.

Paid model calls additionally require `--allow-paid`. Existing outputs are not overwritten unless `--force` is explicit. The Prophet service binds to `127.0.0.1` by default; a non-loopback bind requires a 32+ byte Bearer token, and startup without a Predictor key requires explicit `PROPHET_ALLOW_BASELINE_ONLY=1`. Production onboarding still requires HTTPS and a compatibility test.

## Architecture

```text
apps/benchmark-cli
apps/prophet-arena-api
        ↓
packages/benchmarks  packages/runtime  packages/eval
        ↓                  ↓                ↓
                packages/forecast-core
```

- `forecast-core` has no env, filesystem, or network access.
- `runtime` implements model HTTP, concurrency, and artifacts.
- `benchmarks` owns external contracts, routing, fallbacks, export, and validation.
- `eval` owns Brier, ECE, Edge over Market, Platt calibration, and chronological splits.

See [Architecture](architecture.md), [Benchmark playbook](benchmark-playbook.md), and the [next-session handoff](agent-handoff.md). The full milestone plan is in the [development plan](../../Plan/2026-08-09-raven-gonna-test-development-plan.en.md).

## Verification

```bash
pnpm lint:boundaries
pnpm typecheck
pnpm test
pnpm verify
```

## Known limits

- FutureX production judging and numeric sigma are not fully public; the local scorer labels approximations and unavailable cases.
- ForecastBench local scoring is raw Brier, not the official difficulty-adjusted leaderboard score.
- Dataset safety priors are recoverable fallbacks, not final DBnomics/FRED specialist models.
- Prophet events default to independent market geometry; exclusive or threshold projections must be explicit.
- No real full-round model-cost, latency, or leaderboard evidence exists yet, so this version makes no champion-level claim.
- Structured `EvidenceRecord` values are validated, but provider research currently exposes citation URLs rather than frozen historical evidence. Live research is therefore blocked for backtests.
