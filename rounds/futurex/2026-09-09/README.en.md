# FutureX 2026-09-09: question configuration

[中文](README.md). Mode: `configuration-only`. This directory prepares questions and routes; it contains no generated or submitted forecasts.

The 80 questions are pinned to official revision `30c9fba49e4b37b12db857714a0b6884d80c6cfa`. Public question text is in [questions.json](questions.json), with download provenance and hashes in [questions.json.manifest.json](questions.json.manifest.json). At the user's request, Codex reviewed task kinds, answer cardinality and units in [routes.json](routes.json). Review time, policy, hashes and 16 route corrections are in [preparation.json](preparation.json). These are configuration-review records, not evidence of a human sending a submission.

The final inventory is 40 single-choice, 21 numeric, 14 ranking, 3 scalar text and 2 unordered identifier-set tasks. All 21 numeric tasks have `targetField / definition / unit / scale`. Definitions use the pinned prompt's units or explicit count semantics, without retrieving this round's resolved outcomes. GBP/CAD/USD/JPY, barrels and time permit declared multiplicative conversions; Celsius accepts only Celsius.

Corrections include: EIA asks for the weekly stock **change** in million barrels; fiscal balance preserves receipts-minus-outlays sign; Japan M3 asks for an average outstanding level; year-on-year changes, proportions, counts and combined scores have separate definitions. First-through sports rankings retain their cardinality, the YouTube retention-count question retains options A–E, and song names and flare classes remain text. CVE/NCT outputs are exact identifier sets with digit-preserving validation, deduplication, sorting and whole-set voting. Empty sets serialize as `[]`; this specifies local formatting, not a verified claim about the organizer's empty-set scoring.

The full-round regression uses a synthetic model to pass 80/80 questions through real parsing, aggregation and the strict validator. Synthetic values stay in test memory and are never written as candidates. Real forecasts still require an independent run, actual evidence and complete validation. Some questions had already closed when configuration was prepared; preserve per-task `asOfUtc`, InformationPolicy and existing closed-question rules. Results retrieved now cannot be represented as earlier forecasts.

```bash
pnpm cli futurex inspect --input rounds/futurex/2026-09-09/questions.json --routes rounds/futurex/2026-09-09/routes.json --as-of 2026-09-09T00:00:00Z
pnpm verify
```

See the [numeric contract guide](../../../docs/en/futurex-numeric-contract.md). The example `as-of` is for configuration inspection; real runs must use their actual evidence cutoff.
