# raven-gonna-test

`raven-gonna-test` is a standalone, non-trading forecasting benchmark toolkit. It separates a general forecasting core from the wire contracts of three live evaluation systems:

- [FutureX](https://futurex.live/): multi-type point predictions exported as strict `{id,prediction}` JSONL.
- [ForecastBench](https://www.forecastbench.org/): batch market and dataset probabilities exported as GCS-ready JSON.
- [Prophet Arena](https://www.prophetarena.co/): a persistent raw forecasting endpoint that uses Kalshi quotes as priors and applies bounded residual updates.

The repository never sends email, uploads to GCS, performs onboarding, connects a wallet, or places an order. Commands only fetch, generate, validate, or score artifacts offline.

## Implemented

As of 2026-08-09, the first runnable version includes:

- binary, categorical, multi-label, ranking, numeric, and free-response tasks;
- a legacy OpenAI-compatible client and six answer parsers, retained only as migration scaffolding and prohibited for official candidates;
- independent trials, logit pooling, prior shrinkage, probability constraints, and Platt calibration;
- explicit information policies and evidence cutoffs;
- true pinned-revision FutureX Parquet ingestion through `/resolve/<SHA>/...`, source hashing, routing, JSONL export/validation, and a versioned local scorer;
- FutureX inventory, explicit route-review state, a research-snapshot validator, and an ID-selected research-only pilot that never emits an official attachment;
- ForecastBench dynamic-horizon expansion, source safety baselines, 100% coverage validation, and raw Brier scoring;
- Prophet Arena current/legacy schemas, two-sided-ask midpoint priors, bounded residuals, geometry projection, and a Bearer-authenticated HTTP service;
- resumable validated checkpoints, no-clobber outputs, explicit paid-call opt-in, hashes, a process-wide concurrency gate, boundary checks, and offline fixtures.

The selected official forecasting system is the self-developed **Raven Forecasting Engine**. This repository does not yet integrate `predict-raven`: Raven v1 is binary-only, and its asynchronous `/v1/forecasts` contract is incompatible with this repository's legacy chat client. Until the Raven adapter lands, every `--allow-paid` path, Prophet live onboarding, and official candidate is blocked. Fetch, route, baseline, validate, and score remain usable. No paid Raven benchmark run or external submission has occurred.

## Quick start

Node.js 20+ and pnpm 10 are required.

```bash
pnpm install
cp .env.example .env
pnpm verify
pnpm doctor
```

Besides the HTTP `openai-compatible` provider, two subscription CLI providers exist and need no `PREDICTOR_API_KEY`: `claude-cli` (Claude Code subscription; optional `PREDICTOR_CLAUDE_EFFORT=low|medium|high|xhigh|max`) and `codex-cli` (OpenAI Codex CLI on a ChatGPT subscription; optional `PREDICTOR_CODEX_EFFORT=low|medium|high|xhigh|max|ultra`). The codex-cli port runs every call in a fresh `CODEX_HOME` (auth symlink only, so no AGENTS.md/config/plugins/memories reach the context), refuses no-web tasks outright because this Codex build's web search cannot be disabled, records `search://<query>` markers instead of fetched URLs (the event stream exposes queries only — not comparable with claude-cli citations), and constrains the final reply with `--output-schema` (a harness advantage, not a model one; label it in comparisons). Details in the header of `packages/runtime/src/codex-cli.ts`.

Read the [Raven-only three-benchmark runbook](three-benchmark-runbook.md) before any live work. Do not change a legacy model string or base URL and claim that Raven is integrated. A real integration requires an asynchronous Raven adapter, six typed outputs, cutoff policy, joint horizons/outcomes, and complete usage accounting. Internal-provider keys belong only in the Raven server's secret manager, never in submissions, manifests, command output, or Git.

## Commands

```bash
# FutureX
pnpm cli futurex discover
pnpm cli futurex fetch --revision <40-char-sha> --output <questions.json>
pnpm cli futurex route --input <questions.json> --revision <40-char-sha> \
  --output <routes.json>
pnpm cli futurex inspect --input <questions.json> --routes <routes.json> --as-of <ISO>
pnpm cli futurex pilot --input <questions.json> --routes <routes.json> \
  --revision <sha> --round <id> --as-of <ISO> --ids <id-1,id-2> \
  --output <pilot.json> --allow-paid
pnpm cli futurex research-validate --input <questions.json> --routes <routes.json> \
  --snapshot <research-snapshot.json> --revision <sha>
pnpm cli futurex run --input <questions.json> --routes <routes.json> \
  --revision <sha> --round <id> --as-of <ISO> --deadline <ISO> \
  --output <submission.jsonl> --allow-paid
pnpm cli futurex validate --input <questions.json> --submission <submission.jsonl>

# ForecastBench
pnpm cli forecastbench fetch --question-set YYYY-MM-DD-llm.json --output <questions.json>
pnpm cli forecastbench run --input <questions.json> \
  --output <YYYY-MM-DD.organization.N.json> \
  --organization <name> --model-name <name> --model-organization <name> \
  --mode backtest --baseline-only
pnpm cli forecastbench validate --input <questions.json> \
  --submission <YYYY-MM-DD.organization.N.json> --mode backtest

# Prophet Arena
pnpm cli prophet predict --input <request.json> --output <response.json> --baseline-only
export PROPHET_BEARER_TOKEN="<32+ byte random token>"
pnpm prophet:serve
```

The ForecastBench commands above are an out-of-window plumbing test. Inside the official UTC window, `--mode backtest` may be removed. Do not remove `--baseline-only` for a paid full round until the Raven adapter, base-question horizon batching, and subset pilot are complete. The CLI still does not perform an external submission.

Generated FutureX routes start as `pending`; review each item before changing it to `approved` or `edited` with `reviewedAtUtc`. Paid pilot and official-candidate runs fail before model calls when selected routes remain pending. Pilot and research-snapshot artifacts always carry `submissionEligible=false` and reject live research at or after a task's `end_time`.

Paid commands additionally require `--allow-paid`, but that flag does not make the current path Raven. Existing outputs are not overwritten unless `--force` is explicit. The Prophet service binds to `127.0.0.1` by default; a non-loopback bind requires a 32+ byte Bearer token, and pure local baseline mode requires explicit `PROPHET_ALLOW_BASELINE_ONLY=1`. The current paid server still points to the legacy client, so production onboarding remains blocked until a Raven event-level adapter, HTTPS, and compatibility testing are complete.

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

See [Architecture](architecture.md), [Benchmark playbook](benchmark-playbook.md), the [end-to-end three-benchmark runbook](three-benchmark-runbook.md), and the [next-session handoff](agent-handoff.md). The full milestone plan is in the [development plan](../../Plan/2026-08-09-raven-gonna-test-development-plan.en.md).

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
