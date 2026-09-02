# DSH-style forecasting engine restructuring plan

Date: 2026-08-22　　Status: **plan only, not implemented**　　Chinese original: [`2026-08-22-dsh-style-harness-plan.md`](2026-08-22-dsh-style-harness-plan.md)

## 1. What DSH is (research findings)

**DeepSeek Harness (dsh)**: an agent framework open-sourced by deepseek-ai on 2026-08-13, v0.1 developer preview. Node ≥22.19 / pnpm monorepo (same stack as this repo). Core: a vendored **Cordis** plugin kernel (mount/unmount/dependency-tracking only, "no privileged core"); **everything is a plugin** — models, tools, skills, sessions, sandboxes, storage, and **the agent loop itself** are swappable; an append-only session log supports resume/fork/replay; four runtime modes (Standard/Code/Minimal/Creator). "Self-evolution" concretely means safe runtime hot-swap of plugins (dependency tracking + undo stacks + transactional rollback), which lets an agent rewrite its own runtime.

**Source trust map (a research surprise)**:

| Channel | Verdict |
| --- | --- |
| `github.com/deepseek-ai/deepseek-harness` + in-repo docs | **the only authoritative contract** |
| npm `@deepseek-ai/dsh` (scoped) | official distribution |
| npm `deepseek-harness` (unscoped, 0.0.1, personal account) | **name-squat placeholder; never install** |
| deepseekharness.io | self-declares "unofficial, not affiliated"; decent content, not a contract |
| deepseek-code.com / deepseekdocs.com etc. | SEO lookalikes; not evidence |

**Maturity alarms**: 10 days old, all 11 versions are rc (latest 0.1.1-rc.2), official warning "THERE WILL BE COMPATIBILITY-BREAKING CHANGES"; no `--json` output flag; session storage location "not pinned down" by docs; 2,117 unsigned community plugins with no permission manifests; `dsh plugin add` executes arbitrary packages verbatim.

## 2. Overall verdict: adopt the composition grammar, reject the runtime machinery

dsh's distinctive machinery (Cordis, fibers, effect inverses, transactional HMR, the "spatiotemporal composability" formalism) all serves one premise: **safely replacing code inside a long-lived process**. Our engine is a **short-lived batch process** — our "hot-swap" is edit-config-and-restart, and the OS process boundary is already a perfect undo stack (the Cordis paper itself concedes inverse correctness is "an obligation on the component author rather than a property the runtime verifies"). For a benchmark engine, changing the harness mid-run is a reproducibility bug, not a feature.

But three dsh ideas are worth stealing, and each hits a known pain point of ours:

1. **Capability seams** (interface / provider / consumer) → today adding a provider means enum + createPort branch + scattered env;
2. **Declarative config assembling the whole harness** → today knobs live across PREDICTOR_* env vars and per-command code;
3. **"model-visible means logged" + a dumpable resolved composition** → today harness identity is half in manifests, half implicit — exactly the fingerprint the matrix has been missing.

## 3. Seven-seam map (current → interface → default provider id)

| Seam | Today | Interface | Default id |
| --- | --- | --- | --- |
| model | `ModelPort` (already a seam; the three predictor classes stay as-is) | as-is + provider wrapper | `openai-compatible` / `claude-cli` / `codex-cli` |
| model middleware | hand-wired `ConcurrencyLimitedModel` | composition-time decorator | `concurrency-limit` |
| prompt | `prompt.ts` buildPrompts + persona suffix inlined in engine | `PromptStrategy.build(task, policy, trial)` | `prompt-v1` |
| parser | `parseModelAnswer` + salvage paths | `AnswerParser.parse(task, response)` | `lenient-salvage-v1` |
| trials (**the dsh "loop is a plugin" analog, composition-time only**) | hardcoded fan-out in `ForecastEngine.forecast` (engine.ts:235-269) | `TrialRunner` | `independent-personas-v1` |
| aggregator | `aggregateTrialPredictions` + hardwired numeric/set decisions | `Aggregator` + `DecisionModule` | `logit-pool-v1` etc. |
| benchmark | three adapters (contract.ts is already the embryo) | `BenchmarkAdapter` registry | `futurex` / `forecastbench` / `prophet-arena` |

**Deliberately NOT seams** (stays hand-written): zod contracts; all math; **InformationPolicy** (always per-task validated data, never a swappable component, never settable from a profile); artifacts/batch/checkpoint; the `requirePaidOptIn` / routes-review gates (code + CLI flags only; profile zod `.strict()` guarantees they cannot be expressed).

## 4. Profiles and harness identity

- New package `packages/harness`, pure/impure split: `registry.ts` + `builtin.ts` pure (linter-checkable); only `profile.ts` touches env/fs;
- `profiles/*.json` (JSON, no YAML; reuse the matrix-proven `$NAME` secret-reference convention; loader rejects literal secrets); single `extends` + CLI `--set`; **no dsh-style four-layer patch stacks**;
- Transition: existing PREDICTOR_* env translates into an env-compat layer that **overrides** profiles, so every existing invocation stays byte-identical;
- `doctor --dump-config`: prints the resolved composition with per-key provenance (analog of dsh `--dump-config`);
- Every manifest gains a harness block: `{ profile, resolved ($NAME refs preserved), compositionHash (sha256 over canonical JSON via canonicalize.ts), providerVersions }` — matrix comparison rows key on compositionHash from then on.

## 5. Migration order (each step keeps `pnpm verify` green; schema freezes before the next paid round)

1. Core seam extraction, zero behavior change: interfaces into contracts.ts; engine constructor takes optional overrides defaulting to current code; trial fan-out moves into the default TrialRunner as pure code motion — core.test.ts passes **unmodified**;
2. `packages/harness` (registry+builtin+tests), extending check-boundaries.mjs **in the same commit** (core must not import harness; harness registry/builtin must not touch env/fs);
3. Runtime catalog: three predictors + concurrency middleware registered; predictor classes and tests untouched;
4. Profile loader (extends / `--set` / `$NAME` / env-compat reusing config.ts validation);
5. CLI switchover: composeEngine(profile) replaces createPort/createEngine; add `--profile/--set/--dump-config`;
6. Manifest harness block;
7. Benchmarks catalog + decision modules resolved by id; matrix slots accept `{name, profile, patch}`;
8. Cleanup: deprecate the raw PREDICTOR_* path; only then the first real payoff demo (a second TrialRunner or Aggregator).

**Payoff**: the matrix grows from harness × model to **strategy × aggregator × harness × model**, every row fingerprinted by compositionHash.

## 6. Independent track: dsh-cli as a third CLI harness (probe-first)

Motivation: give the DeepSeek slot real research (today: zero-research bare completions). Verdict: **feasible with caveats** — 10-day-old rc, no `--json`, undocumented session-storage contract.

1. Exact-pin `@deepseek-ai/dsh@<rc>` as a devDependency; spawn `node_modules/.bin/dsh` (**never npx**; zero community plugins);
2. First write `scripts/probe-dsh.mjs`, kept in-repo as the regression probe: `--profile headless` stdout contract; session JSONL shape under a scratch `DSH_HOME`; whether web-search events carry URLs or only queries; whether `--patch` can unmount web tools (deny-web enforcement); token-usage shape;
3. Only after the probe passes, write `DshCliPredictor` (mirroring codex-cli: per-call scratch home, bounded retry, research=false fails closed initially, and a missing/unparseable session log **fails the call** rather than silently returning zero citations);
4. Billing differs from the other CLIs: spends **DEEPSEEK_API_KEY** (API-billed like openai-compatible) while researching like claude-cli — document this;
5. Matrix gains a `ds-v4-dsh` slot run side-by-side with the bare-completions `dsflash` control; paid-round admission only after human review; keep dsflash as the deny-web-route fallback;
6. Every version bump = re-probe (the codex 0.144→0.149 lesson).

## 7. Risk table (condensed)

| Risk | Mitigation |
| --- | --- |
| 3 providers / 2 strategies don't justify a "plugin platform" | cap at 7 seams; plain const objects; refuse to seam anything with one forever-provider |
| String ids erode type safety | zod-validate id ∈ registry keys; fail closed before any paid call |
| Dual config sources mid-migration | single precedence (env-compat overrides profile) + per-key provenance in doctor; hard cutover per command |
| Safety gates drifting into config | `.strict()` schemas; allow-paid / routes / policy never in profiles |
| Non-canonical compositionHash fragments the comparison table | reuse canonicalize.ts; pin default composition to `independent-trials-logit-v1` for historical comparability |
| Trial-loop extraction touches abort/timeout semantics | pure code motion validated by untouched core.test.ts first |
| Borrowed vocabulary invites borrowed machinery | this doc + AGENTS.md record: **zero dsh/Cordis code or deps in-repo**; dynamic loading out of scope |

## 8. Explicit do-not-adopt list

Cordis runtime / hot-swap & HMR / self-evolution (cordis_define, Creator mode — directly contradicts human-reviewed-routes gating of paid runs) / community plugin surface & `dsh plugin add` / Web UI & unauthenticated local RPC / event-hook bus / a new session-event-log subsystem (extend manifests instead) / four-layer patch stacking / YAML / dsh's web-search seam design (undisableable, undocumented backend — our fail-closed InformationPolicy is strictly better; **do not touch it**).
