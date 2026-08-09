# Benchmark Playbook

Verified on 2026-08-09 in Singapore. Re-check official sources before every round.

## FutureX

Sources: [site](https://futurex.live/), [online dataset](https://huggingface.co/datasets/futurex-ai/Futurex-Online), [public scorer](https://github.com/Futurex-ai/Futurex-Eval).

The currently published SHA, `b7457c4d4229458767c666be72435c3afe45b0fd`, covers August 5–11 but its August 5 submission deadline has passed. Wait for a new SHA and README.

After the deadline, this SHA is suitable only for explicitly labeled shadow/pilot work. Even unresolved tasks may now contain extra information unavailable on August 5, so pilot artifacts must remain `submissionEligible=false`.

Human actions still required:

1. Email `FutureX-ai@outlook.com` to confirm the next deadline, replacement policy, ensemble/human-review policy, and production numeric scorer.
2. Discover, then explicitly fetch the full revision.
3. Add SHA-bound overrides for low-confidence task routing.
4. Run Predictor, inspect checkpoints, and create JSONL.
5. Strictly validate and prepare the model/framework/organization/SHA/visibility email body.
6. Send manually and retain sent time, attachment hash, and receipt.

Operational schedule: full valid baseline by T−4h, volatile-item refresh until T−2h, freeze at T−75m, send at T−60m.

## ForecastBench

Sources: [submission wiki](https://github.com/forecastingresearch/forecastbench/wiki/How-to-submit-to-ForecastBench), [question sets](https://github.com/forecastingresearch/forecastbench-datasets/tree/main/datasets/question_sets), [methodology](https://www.forecastbench.org/assets/pdfs/forecastbench_updated_methodology.pdf).

The biweekly cadence implies an August 16 UTC round, or August 16 08:00 through August 17 07:59:59 in Singapore. Official email confirmation remains authoritative.

Human actions still required:

1. Email `forecastbench@forecastingresearch.org` with a Google upload email, organization or anonymous request, website, and square SVG logo.
2. Test the assigned GCS folder.
3. Confirm product-name versus `ensemble` model labeling.
4. Fetch only the dated set on round day.
5. Produce a 100% baseline before model/statistical upgrades.
6. Validate category coverage, horizons, range, keys, and the exact `<forecast_due_date>.<organization>.<N>.json` filename.
7. Upload manually, verify object timestamp/hash, and use email fallback before cutoff if needed.

Operational schedule: baseline by T−6h, valid file by T−4h, refresh until T−2h, upload at T−90m, verify at T−60m, email fallback by T−30m.

## Prophet Arena

The official name is [Prophet Arena](https://www.prophetarena.co/). Sources: [Onboarding](https://www.prophetarena.co/onboarding), [Agent rules](https://www.prophetarena.co/research/agent-leaderboard-rules), [scoring](https://www.prophetarena.co/research/how-scoring-works).

There is no weekly file deadline. You register a persistent HTTPS endpoint. Public eligibility documentation conflicts between ten active days and fifty resolved events.

Human actions still required:

1. Choose Agent/raw-endpoint track.
2. Select a long-request-capable HTTPS host.
3. Store a 32+ byte Bearer token and provider keys as hosted secrets.
4. Run public health/auth/load tests.
5. Pass the onboarding compatibility test and submit identity metadata.
6. Ask `contact@prophetarena.co` about timeouts/retries/concurrency, rationale, Top-K geometry, and listing eligibility.
7. Keep the endpoint available continuously and shadow-test before replacing an active version.

Answer requests promptly; intentionally consuming the 3,600-second limit does not create market edge.

## Cutoff principle

Later is useful only when new legal information improves the forecast. Always use: valid baseline, deep work, targeted late refresh, freeze, strict validation, and a transmission/receipt buffer. Post-cutoff evidence belongs only in clearly labeled backtests.
