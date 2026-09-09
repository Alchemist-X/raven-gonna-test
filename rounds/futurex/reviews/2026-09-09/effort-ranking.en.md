# Historical thinking effort and ranking sensitivity

[中文](effort-ranking.md). Date: 2026-09-09. Mode: `offline-sensitivity`; not a new forecast or submission attachment.

This week's configuration was completed and merged in `f7941fe`: 80 questions, 21 numeric target contracts and 16 route corrections. The end-to-end simulation covers 80/80, with 235 tests passing. Actual model forecasting and external submission are outside this configuration update.

## Was effort maximized?

| Main run | Model | Engine reasoningEffort | Provider override / configured tier |
| --- | --- | --- | --- |
| Aug 26 | Opus 5 | high | **max** |
| Aug 26 | GPT-5.6 SOL | high | **max** |
| Sep 2 | Opus 5 | high | **high**, no override |
| Sep 2 | Fable 5 | high | **high**, no override |
| Sep 2 | GPT-5.6 SOL | high | **xhigh** |

**Not every run used the highest tier.** The Aug 26 launcher recorded an Opus request for `ultra`, mapped to `max`, the highest tier accepted by that Claude adapter. SOL requested `max`, not `ultra`; the Codex adapter in run code `3fc2d4659ec2230abb6d4884faee9e2f147ee795` already accepted `ultra`, so SOL's `max` was not the absolute highest requestable adapter setting. Sep 2 used lower settings than Aug 26.

The manifest's engine `reasoningEffort: high` is insufficient: provider overrides take precedence. Visible thinking length does not establish the configured effort either. This audit verifies recorded configuration and argument forwarding, not the provider's internal reasoning budget. Five run-record extracts, paths and SHA-256 hashes are in the [input](effort-ranking-input.json).

## Ranking space with correct units and targets

The reference is the [official FutureX weekly leaderboard](https://futurex.live/), `2026 Sep. Week 1`, covering 74 scored questions submitted Aug 26. The leader has 65.93 and second place 65.39. These are **conditional retrospective scenarios**: hold other questions and competitors fixed, add local numeric score deltas to displayed official totals, and assume production uses the same 5% relative-error formula on the corrected questions.

| Scenario | SOL | Opus |
| --- | --- | --- |
| Original official result | 58.09, #16 | 53.80, #31 |
| Correct four clear unit errors per model, preserving original estimates | **65.35, #3** | **61.03, #5** |
| Unit corrections plus 0.5 credit on each of PCE and construction spending | 67.46, #1 | 63.14, #5 |
| Unit corrections plus full credit on both target-error questions | **69.56, #1** | **65.24, #4** |

Scenario ranks replace both of our models simultaneously. If only Opus changes and SOL retains its original result, Opus is #4 for units alone and #3 with both target cases receiving full credit.

Clear unit corrections: Opus EIA stocks ×1000, Northern Ireland prescription items ÷1000, Salesforce revenue ×1000, Marvell revenue ×1000; SOL Canadian food-service sales ×10⁶, prescription items ÷1000, Marvell revenue ×1000, NVIDIA Data Center revenue ÷1000. Local weighted gains are **7.2302 / 7.2607** points for Opus / SOL. Original predictions, multipliers, truths and individual scores are in the [calculation](effort-ranking-result.json). Historical attachments were not edited.

Target errors cannot be repaired by unit conversion. PCE required a monthly change of 0.2; Opus supplied an index level of 131.5275 and SOL a year-on-year rate of 3.6. Construction spending required a level of 2157.6, while the models returned monthly changes of −0.1/−0.2. Each L4 question contributes at most `100 × 0.4 / 19 = 2.1053` overall points, or 4.2105 for both. **Selecting the correct field does not imply predicting its value correctly.** The 0.5 and 1 cases are conditional scores, not rerun results, gain estimates or confidence intervals.

Under the same-scoring assumption, SOL after unit correction trails the current leader by 0.5793 points. Combined credit above approximately 0.2752/2 across the two target cases would surpass the leader, giving it potential to reach #1. Opus reaches only approximately 65.24 even with both target cases perfect, below the current top two.

**This cannot establish an actual reranking or predict next-round placement.** Local and official L3 baselines remain inconsistent: 43.55 versus 43.46 for Opus and 48.24 versus 42.60 for SOL. Organizer per-question receipts and hashes of the attachments actually received are unavailable; label versions or production judging may differ. The #3 units case and #1 perfect-target case are therefore hypothetical positions. Confirmation requires rescoring the same submission and labels with the organizer's metric. New retrieval behavior also needs prospective validation.

Reproduce without model calls, writing diagnostics only:

```bash
pnpm build
node scripts/futurex-counterfactual.mjs --output rounds/futurex/reviews/2026-09-09/effort-ranking-result.json
```
