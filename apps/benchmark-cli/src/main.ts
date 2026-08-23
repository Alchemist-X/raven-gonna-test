#!/usr/bin/env node
import { access } from "node:fs/promises";
import path from "node:path";
import {
  ForecastEngine,
  ForecastResultSchema,
  defaultAnswerForTask,
  type ForecastAnswer,
  type ForecastResult,
  type ForecastTask
} from "@raven-gonna-test/forecast-core";
import {
  analyzeFutureXQuestions,
  buildForecastBenchForecastSet,
  buildFutureXSubmission,
  buildProphetLegacyResponse,
  buildProphetCurrentResponse,
  discoverFutureXRevision,
  expandForecastBenchQuestionSet,
  ForecastBenchMarketSnapshotSchema,
  ForecastBenchForecastSetSchema,
  ForecastBenchQuestionSetSchema,
  fetchForecastBenchQuestionSet,
  fetchFutureXOnlinePinned,
  futureXEndTimeUtc,
  futureXQuestionsToTasks,
  FutureXQuestionsSchema,
  FutureXRouteOverrideFileSchema,
  normalizeProphetRequest,
  policyForForecastBenchTask,
  policyForFutureXTask,
  policyForProphetTask,
  prophetEventToTasks,
  prophetFallbackAnswer,
  routeFutureXQuestion,
  scoreForecastBenchRaw,
  scoreFutureX,
  selectFutureXQuestions,
  sourceBaseline,
  validateForecastBenchCoverage,
  validateForecastBenchLiveQuestionSet,
  validateFutureXSubmission,
  validateFutureXResearchSnapshot,
  validateProphetCurrentResponse,
  validateProphetLegacyResponse
} from "@raven-gonna-test/benchmarks";
import {
  ClaudeCliPredictor,
  CodexCliPredictor,
  ConcurrencyLimitedModel,
  OpenAICompatiblePredictor,
  loadPredictorConfig,
  readJson,
  readJsonLines,
  runForecastBatch,
  sha256File,
  writeJsonAtomic,
  writeJsonLinesAtomic
} from "@raven-gonna-test/runtime";

interface Args {
  positional: string[];
  flags: Map<string, string | true>;
}

function parseArgs(argv: string[]): Args {
  const positional: string[] = [];
  const flags = new Map<string, string | true>();
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index]!;
    if (!value.startsWith("--")) {
      positional.push(value);
      continue;
    }
    const equals = value.indexOf("=");
    if (equals > 2) {
      flags.set(value.slice(2, equals), value.slice(equals + 1));
      continue;
    }
    const name = value.slice(2);
    const next = argv[index + 1];
    if (next && !next.startsWith("--")) {
      flags.set(name, next);
      index += 1;
    } else {
      flags.set(name, true);
    }
  }
  return { positional, flags };
}

function flag(args: Args, name: string): string | undefined {
  const value = args.flags.get(name);
  return typeof value === "string" ? value : undefined;
}

function required(args: Args, name: string): string {
  const value = flag(args, name);
  if (!value) throw new Error(`--${name} is required.`);
  return value;
}

function numberFlag(args: Args, name: string, fallback: number): number {
  const value = flag(args, name);
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`--${name} must be a finite number.`);
  return parsed;
}

function enabled(args: Args, name: string): boolean {
  return args.flags.get(name) === true;
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function preflightOutput(
  args: Args,
  output: string,
  inputs: readonly string[] = [],
  sidecars: readonly string[] = [`${output}.manifest.json`]
): Promise<void> {
  const target = path.resolve(output);
  const conflicts = inputs.map((input) => path.resolve(input)).filter((input) => input === target);
  if (conflicts.length > 0) throw new Error(`Output path must not equal an input path: ${output}`);
  if (!enabled(args, "force")) {
    for (const candidate of [output, ...sidecars]) {
      if (await fileExists(candidate)) throw new Error(`${candidate} already exists; choose a new path or pass --force explicitly.`);
    }
  }
}

function requirePaidOptIn(args: Args, estimatedCalls: number): void {
  if (!enabled(args, "allow-paid")) {
    throw new Error(`This run may make about ${estimatedCalls} paid model calls. Re-run with --allow-paid after reviewing the estimate.`);
  }
  info(`paid-call estimate: ${estimatedCalls}; explicit --allow-paid present`);
}

function safeProviderUrl(value: string): string {
  try {
    const url = new URL(value);
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    return url.toString().replace(/\/$/, "");
  } catch {
    return "<invalid>";
  }
}

function assertForecastBenchFilename(
  output: string,
  dueDate: string,
  organization: string,
  submissionNumber: number
): void {
  if (!Number.isInteger(submissionNumber) || submissionNumber < 1 || submissionNumber > 3) {
    throw new Error("ForecastBench submission number must be 1, 2, or 3.");
  }
  const expected = `${dueDate}.${organization}.${submissionNumber}.json`;
  if (path.basename(output) !== expected) {
    throw new Error(`ForecastBench upload filename must be ${expected}; got ${path.basename(output)}.`);
  }
}

async function loadRows(filePath: string): Promise<unknown[]> {
  return filePath.endsWith(".jsonl") ? readJsonLines(filePath) : readJson<unknown[]>(filePath);
}

function info(message: string): void {
  process.stderr.write(`[INFO] ${message}\n`);
}

function ok(message: string): void {
  process.stderr.write(`[OK] ${message}\n`);
}

function warn(message: string): void {
  process.stderr.write(`[WARN] ${message}\n`);
}

function showHelp(): void {
  process.stdout.write(`raven-gonna-test benchmark CLI

Commands:
  doctor
  futurex discover
  futurex fetch --revision <sha> --output questions.json
  futurex route --input questions.json --revision <sha> --output routes.json
  futurex inspect --input questions.json [--routes routes.json] [--as-of <ISO>]
  futurex research-validate --input questions.json --routes routes.json --snapshot snapshot.json --revision <sha>
  futurex pilot --input questions.json --routes routes.json --revision <sha> --round <id> --as-of <ISO> --ids <id,id,...> --output pilot.json --allow-paid
  futurex run --input questions.json --routes routes.json --revision <sha> --round <id> --as-of <ISO> --deadline <ISO> --output submission.jsonl --allow-paid
  futurex validate --input questions.json --submission submission.jsonl [--routes routes.json] [--deadline <ISO>]
  futurex score --gold resolved.json[l] --submission submission.jsonl [--profile github|paper]
  forecastbench fetch --question-set YYYY-MM-DD-llm.json --output questions.json
  forecastbench run --input questions.json --output submission.json --organization <name> --model-name <name> --model-organization <name> [--baseline-only | --allow-paid]
  forecastbench validate --input questions.json --submission submission.json
  forecastbench score --input questions.json --submission submission.json --resolutions resolutions.json[l]
  prophet predict --input request.json --output response.json [--baseline-only | --allow-paid] [--residual-cap 0.05]

No command uploads, emails, trades, or submits externally.
`);
}

function createPort(config: ReturnType<typeof loadPredictorConfig>) {
  if (config.provider === "claude-cli") {
    return new ClaudeCliPredictor({
      model: config.model,
      timeoutMs: config.timeoutMs,
      ...(config.claudeEffort ? { effort: config.claudeEffort } : {}),
      ...(config.maxRetries !== undefined ? { maxRetries: config.maxRetries } : {}),
      ...(config.retryBaseMs !== undefined ? { retryBaseMs: config.retryBaseMs } : {})
    });
  }
  if (config.provider === "codex-cli") {
    return new CodexCliPredictor({
      model: config.model,
      timeoutMs: config.timeoutMs,
      ...(config.codexEffort ? { effort: config.codexEffort } : {}),
      ...(config.maxRetries !== undefined ? { maxRetries: config.maxRetries } : {}),
      ...(config.retryBaseMs !== undefined ? { retryBaseMs: config.retryBaseMs } : {})
    });
  }
  return new OpenAICompatiblePredictor(config);
}

function createEngine() {
  const config = loadPredictorConfig();
  // Cap real in-flight calls. Without this the fan-out is concurrency x trials,
  // which is why ConcurrencyLimitedModel exists; it was simply never applied on
  // this path.
  const port = new ConcurrencyLimitedModel(createPort(config), config.concurrency);
  return { config, engine: new ForecastEngine(port) };
}

function baselineResult(task: ForecastTask, answer: ForecastAnswer, model: string, warning: string): ForecastResult {
  return {
    schemaVersion: "raven-gonna-test.forecast-result.v1",
    taskId: task.taskId,
    answer,
    trials: [],
    model,
    strategyId: "deterministic-baseline-v1",
    policyId: "baseline",
    generatedAtUtc: new Date().toISOString(),
    fallbackUsed: true,
    warnings: [warning]
  };
}

async function writeManifest(output: string, value: Record<string, unknown>): Promise<void> {
  await writeJsonAtomic(`${output}.manifest.json`, {
    schemaVersion: "raven-gonna-test.artifact-manifest.v1",
    createdAtUtc: new Date().toISOString(),
    output: path.basename(output),
    sha256: await sha256File(output),
    ...value
  });
}

/**
 * Persist the reasoning behind each submitted answer as a first-class artifact.
 *
 * The submission itself is only `{id, prediction}`, and the full ForecastResult
 * previously survived solely inside the resume checkpoint — a file that exists
 * to restart a crashed run, gets overwritten, and is keyed by run identity. So
 * once a round resolved there was no supported way to ask "why did we answer
 * that". This writes the trials, their per-trial roles, reasoning and citations
 * next to the submission so a miss is diagnosable after the fact.
 */
async function writeReasoningArtifact(
  output: string,
  tasks: readonly ForecastTask[],
  results: readonly ForecastResult[],
  submission: readonly { id: string; prediction: string }[]
): Promise<string> {
  const taskById = new Map(tasks.map((task) => [task.taskId, task]));
  const predictionByExternalId = new Map(submission.map((row) => [row.id, row.prediction]));
  const records = results.map((result) => {
    const task = taskById.get(result.taskId);
    const externalId = task?.origin.externalId ?? result.taskId;
    return {
      id: externalId,
      taskId: result.taskId,
      kind: task?.kind ?? "unknown",
      level: (task?.metadata as { level?: unknown } | undefined)?.level ?? null,
      submittedPrediction: predictionByExternalId.get(externalId) ?? null,
      answer: result.answer,
      fallbackUsed: result.fallbackUsed,
      warnings: result.warnings,
      // The decisive step: how N trial answers became the one submitted value.
      derivation: result.derivation ?? null,
      // A forecast made with no retrieved source is a recall of training data,
      // not research. On a future-prediction benchmark that is guessing, and it
      // is invisible in the answer itself — so surface it per question.
      researchedTrials: result.trials.filter((trial) => trial.citations.length > 0).length,
      trials: result.trials.map((trial) => ({
        trial: trial.trial,
        role: trial.role ?? null,
        answer: trial.answer,
        citations: trial.citations,
        thinking: trial.thinking ?? null,
        rawResponse: trial.rawResponse,
        latencyMs: trial.latencyMs,
        usage: trial.usage ?? null
      }))
    };
  });
  const reasoningPath = `${output.replace(/\.jsonl?$/i, "")}.reasoning.jsonl`;
  await writeJsonLinesAtomic(reasoningPath, records);
  return reasoningPath;
}

/**
 * Spend proportional to what a question is worth.
 *
 * FutureX weights each level's MEAN, so a question's marginal contribution is
 * weight/count: 0.1/20 = 0.005 at L1 but 0.4/22 = 0.0182 at L4 — 3.6x. Uniform
 * trials across all 80 therefore buys the least valuable questions the same
 * effort as the most valuable. Trials are the lever with the most direct effect
 * on answer quality, so they scale with level; effort follows for the top two.
 */
function futureXLevelOptions(
  task: ForecastTask,
  config: ReturnType<typeof loadPredictorConfig>
): Parameters<ForecastEngine["forecast"]>[2] {
  const level = Number((task.metadata as { level?: unknown } | undefined)?.level ?? 1);
  const trialsByLevel: Record<number, number> = { 1: 1, 2: 2, 3: 3, 4: 4 };
  // Never spend MORE than the operator configured; the env value is the ceiling.
  const trials = Math.max(1, Math.min(config.trials, trialsByLevel[level] ?? config.trials));
  return {
    trials,
    concurrency: Math.min(trials, 3),
    timeoutMs: config.timeoutMs,
    // Effort does NOT scale down with level, even though that looks like the
    // obvious saving. Measured over a full 80-question round: at low effort
    // 20/20 trials performed ZERO web searches, at medium 10/34, at high 1/60.
    // Low effort does not make the model think less about the question — it
    // makes it skip research and answer from training data, which on a
    // future-prediction benchmark is guessing. It produced a confident,
    // directionally wrong answer on a question the issuer had already guided
    // publicly (ADI Q3 EPS: answered "No" from a stale $1.60-$2.30 memory
    // against live guidance of $3.30 +- $0.15). Trials remain the cost lever.
    reasoningEffort: "high",
    researchSources: config.researchSources
  };
}

async function loadFutureXRouteOverrides(args: Args, expectedRevision?: string) {
  const filePath = flag(args, "routes");
  if (!filePath) return undefined;
  const parsed = FutureXRouteOverrideFileSchema.parse(await readJson(filePath));
  if (expectedRevision && parsed.revision.toLowerCase() !== expectedRevision.toLowerCase()) {
    throw new Error(`FutureX route file is bound to ${parsed.revision}, not ${expectedRevision}.`);
  }
  return parsed;
}

function futureXIds(args: Args): string[] {
  const raw = required(args, "ids");
  const ids = raw.split(",").map((value) => value.trim()).filter(Boolean);
  if (ids.length === 0) throw new Error("--ids must contain at least one FutureX id.");
  if (new Set(ids).size !== ids.length) throw new Error("--ids contains duplicate FutureX ids.");
  return ids;
}

function assertFutureXRoutesReviewed(
  questionIds: readonly string[],
  routes: Awaited<ReturnType<typeof loadFutureXRouteOverrides>>
): void {
  if (!routes) throw new Error("A revision-bound --routes file is required.");
  const problems: string[] = [];
  for (const id of questionIds) {
    const route = routes.routes[id];
    if (!route) {
      problems.push(`${id}: missing route`);
      continue;
    }
    if (route.review?.status !== "approved" && route.review?.status !== "edited") {
      problems.push(`${id}: route review is ${route.review?.status ?? "missing"}`);
    } else if (!route.review.reviewedAtUtc) {
      problems.push(`${id}: approved route has no reviewedAtUtc`);
    }
  }
  if (problems.length > 0) {
    throw new Error(`FutureX requires explicit route review before model calls:\n${problems.join("\n")}`);
  }
}

/**
 * Split the round at the evidence cutoff instead of rejecting it wholesale.
 *
 * The no-leakage guarantee is per question: researching a question whose
 * end_time has passed could see the outcome. Failing the ENTIRE round for that
 * means one closed question costs 80 zeros rather than one — and the round's
 * earliest question closes well before the submission deadline, so the
 * all-or-nothing gate makes the run impossible precisely when it still has most
 * of its value. Closed questions are excluded from live research and reported;
 * the caller answers them from the fallback path rather than skipping the row.
 */
function partitionFutureXByWindow(
  questions: readonly { id: string; end_time: string }[],
  asOfUtc: string
): { open: string[]; closed: string[] } {
  const asOf = new Date(asOfUtc).getTime();
  if (!Number.isFinite(asOf)) throw new Error("FutureX --as-of must be a valid timestamp.");
  const open: string[] = [];
  const closed: string[] = [];
  for (const question of questions) {
    const endUtc = futureXEndTimeUtc(question.end_time);
    if (!endUtc || asOf >= new Date(endUtc).getTime()) closed.push(question.id);
    else open.push(question.id);
  }
  return { open, closed };
}

async function loadForecastBenchMarketSnapshot(args: Args, questionSet: string, asOfUtc: string) {
  const filePath = flag(args, "market-snapshot");
  if (!filePath) return undefined;
  const snapshot = ForecastBenchMarketSnapshotSchema.parse(await readJson(filePath));
  if (snapshot.questionSet !== questionSet) throw new Error("ForecastBench market snapshot targets a different question set.");
  const cutoff = new Date(asOfUtc).getTime();
  if (new Date(snapshot.capturedAtUtc).getTime() > cutoff) throw new Error("Market snapshot was captured after the evidence cutoff.");
  const priors = new Map<string, number>();
  for (const quote of snapshot.quotes) {
    if (new Date(quote.observedAtUtc).getTime() > cutoff) throw new Error(`Market quote ${quote.source}/${quote.id} is after the cutoff.`);
    const key = JSON.stringify([quote.source, quote.id]);
    if (priors.has(key)) throw new Error(`Duplicate market snapshot quote: ${key}`);
    priors.set(key, quote.probability);
  }
  return { filePath, snapshot, priors };
}

async function loadResumeResults(
  args: Args,
  checkpointPath: string,
  tasks: readonly ForecastTask[],
  identity: Record<string, string | number | boolean>
): Promise<Map<string, ForecastResult> | undefined> {
  if (!enabled(args, "resume")) return undefined;
  const checkpoint = await readJson<{
    schemaVersion?: string;
    identity?: Record<string, string | number | boolean>;
    results?: unknown[];
  }>(checkpointPath);
  if (checkpoint.schemaVersion !== "raven-gonna-test.checkpoint.v1") throw new Error("Unsupported checkpoint schema.");
  if (JSON.stringify(checkpoint.identity ?? {}) !== JSON.stringify(identity)) {
    throw new Error("Checkpoint identity does not match this round/model/cutoff configuration.");
  }
  const allowed = new Set(tasks.map((task) => task.taskId));
  const results = new Map<string, ForecastResult>();
  for (const raw of checkpoint.results ?? []) {
    const result = ForecastResultSchema.parse(raw);
    if (!allowed.has(result.taskId)) throw new Error(`Checkpoint contains a task from another run: ${result.taskId}`);
    if (results.has(result.taskId)) throw new Error(`Checkpoint contains duplicate result: ${result.taskId}`);
    results.set(result.taskId, result);
  }
  info(`resume checkpoint accepted: ${results.size}/${tasks.length} tasks`);
  return results;
}

async function commandDoctor(): Promise<void> {
  const provider = process.env.PREDICTOR_PROVIDER ?? "openai-compatible";
  const subscriptionCli = provider === "claude-cli" || provider === "codex-cli";
  // A CLI provider is ready when the CLI itself is authenticated, which this
  // process cannot see; reporting an API-key check for it would be misleading.
  const providerReady = provider === "claude-cli"
    ? "check `claude auth status`"
    : provider === "codex-cli"
      ? "check `codex login status`"
      : Boolean(process.env.PREDICTOR_API_KEY?.trim());
  process.stdout.write(`${JSON.stringify({
    repository: "raven-gonna-test",
    node: process.version,
    executionMode: "inspect",
    predictor: {
      provider,
      ready: providerReady,
      model:
        process.env.PREDICTOR_MODEL ??
        (provider === "claude-cli" ? "claude-sonnet-5" : provider === "codex-cli" ? "gpt-5.6-sol" : "foresight-v4"),
      ...(subscriptionCli
        ? {}
        : { baseUrl: safeProviderUrl(process.env.PREDICTOR_BASE_URL ?? "https://api.lightningrod.ai/v1/openai") })
    },
    externalSubmission: "disabled-by-design",
    trading: "not-present"
  }, null, 2)}\n`);
}

async function commandFutureX(action: string | undefined, args: Args): Promise<void> {
  if (action === "discover") {
    info("execution mode: inspect; decision source: official Hugging Face metadata");
    process.stdout.write(`${JSON.stringify(await discoverFutureXRevision(), null, 2)}\n`);
    return;
  }
  if (action === "fetch") {
    info("execution mode: inspect; decision source: pinned FutureX revision");
    const revision = required(args, "revision");
    const output = required(args, "output");
    await preflightOutput(args, output);
    const { questions, provenance } = await fetchFutureXOnlinePinned({ revision });
    await writeJsonAtomic(output, questions);
    await writeManifest(output, { benchmark: "futurex", revision, records: questions.length, provenance });
    ok(`FutureX questions written: ${output}`);
    return;
  }
  if (action === "route") {
    info("execution mode: inspect; decision source: prompt parser plus required human review");
    const input = required(args, "input");
    const revision = required(args, "revision");
    const output = required(args, "output");
    if (!/^[0-9a-f]{40}$/i.test(revision)) throw new Error("--revision must be a full 40-character SHA.");
    await preflightOutput(args, output, [input]);
    const questions = FutureXQuestionsSchema.parse(await loadRows(input));
    const routes = Object.fromEntries(questions.map((question) => {
      const route = routeFutureXQuestion(question);
      return [question.id, {
        kind: route.kind,
        ...(route.choices.length > 0 ? { choices: route.choices } : {}),
        ...(route.rankCount ? { rankCount: route.rankCount } : {}),
        inference: { kind: route.kind, confidence: route.confidence, reasons: route.reasons },
        review: { status: "pending" as const }
      }];
    }));
    const artifact = FutureXRouteOverrideFileSchema.parse({
      schemaVersion: "raven-gonna-test.futurex-routes.v1",
      revision,
      routes
    });
    await writeJsonAtomic(output, artifact);
    await writeManifest(output, { benchmark: "futurex", revision, records: questions.length, kind: "route-review" });
    ok(`FutureX revision-bound route review written: ${output}`);
    return;
  }
  if (action === "route-review") {
    // The pending-route gate is a real protection — a misrouted question is
    // scored against a format we never produced — but it is enforced per route
    // with no way to record the review, so every run is blocked by 80 pending
    // entries. This records the human decision, and surfaces the routes that
    // actually deserve attention rather than treating all 80 alike.
    info("execution mode: inspect; decision source: human review recorded against a pinned revision");
    const routePath = required(args, "routes");
    const input = required(args, "input");
    const routeFile = await loadFutureXRouteOverrides(args);
    if (!routeFile) throw new Error("--routes is required.");
    const questions = FutureXQuestionsSchema.parse(await loadRows(input));
    const questionById = new Map(questions.map((question) => [question.id, question]));
    const only = flag(args, "ids")?.split(",").map((value) => value.trim()).filter(Boolean);
    const status = flag(args, "status") ?? "approved";
    if (status !== "approved" && status !== "edited") throw new Error("--status must be approved or edited.");

    const lowConfidence = Number(flag(args, "min-confidence") ?? 0.8);
    const rows = Object.entries(routeFile.routes).map(([id, route]) => {
      const question = questionById.get(id);
      const inferred = question ? routeFutureXQuestion(question) : undefined;
      // Flag anything the detector was unsure about, or where the stored route
      // has drifted from what the current detector infers — the scorer falls
      // back to the live detector, so drift means we would optimize one kind
      // while the grader parses another.
      const drifted = inferred !== undefined && inferred.kind !== route.kind;
      const unsure = (route.inference?.confidence ?? 1) < lowConfidence;
      return { id, kind: route.kind, inferredKind: inferred?.kind, drifted, unsure, status: route.review?.status ?? "pending" };
    });
    const needsEyes = rows.filter((row) => row.drifted || row.unsure);
    if (enabled(args, "list")) {
      process.stdout.write(`${JSON.stringify({ total: rows.length, needsAttention: needsEyes, rows }, null, 2)}\n`);
      return;
    }

    const targets = only ?? rows.map((row) => row.id);
    const reviewedAtUtc = new Date().toISOString();
    const updated = Object.fromEntries(
      Object.entries(routeFile.routes).map(([id, route]) => [
        id,
        targets.includes(id) ? { ...route, review: { status, reviewedAtUtc } } : route
      ])
    );
    const reviewed = FutureXRouteOverrideFileSchema.parse({ ...routeFile, routes: updated });
    await writeJsonAtomic(routePath, reviewed);
    ok(`FutureX routes marked ${status}: ${targets.length}/${rows.length} (reviewedAtUtc=${reviewedAtUtc})`);
    if (needsEyes.length > 0) {
      warn(
        `${needsEyes.length} route(s) were low-confidence or drifted from the current detector and deserve a second look: ` +
          needsEyes.map((row) => `${row.id} (${row.kind}${row.drifted ? ` != inferred ${row.inferredKind}` : ""})`).join(", ")
      );
    }
    return;
  }
  if (action === "inspect") {
    info("execution mode: inspect; decision source: pinned questions plus route detector");
    const questions = FutureXQuestionsSchema.parse(await loadRows(required(args, "input")));
    const routeFile = await loadFutureXRouteOverrides(args);
    const report = analyzeFutureXQuestions(questions, {
      ...(routeFile ? { routeOverrides: routeFile.routes } : {}),
      ...(flag(args, "as-of") ? { asOfUtc: flag(args, "as-of")! } : {})
    });
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return;
  }
  if (action === "research-validate") {
    info("execution mode: inspect; decision source: research-only snapshot contract");
    const revision = required(args, "revision");
    const questions = FutureXQuestionsSchema.parse(await loadRows(required(args, "input")));
    const routeFile = await loadFutureXRouteOverrides(args, revision);
    const snapshot = await readJson(required(args, "snapshot"));
    const report = validateFutureXResearchSnapshot(questions, snapshot, {
      expectedRevision: revision,
      ...(routeFile ? { routeOverrides: routeFile.routes } : {})
    });
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    if (!report.valid) process.exitCode = 6;
    return;
  }
  if (action === "validate") {
    info("execution mode: inspect; decision source: FutureX submission contract");
    const questions = await loadRows(required(args, "input"));
    const submission = await loadRows(required(args, "submission"));
    const deadline = flag(args, "deadline");
    const routeFile = await loadFutureXRouteOverrides(args);
    const options = {
      ...(deadline ? { deadlineUtc: deadline } : {}),
      ...(routeFile ? { routeOverrides: routeFile.routes } : {})
    };
    const report = validateFutureXSubmission(questions, submission, options);
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    if (!report.valid) process.exitCode = 6;
    return;
  }
  if (action === "score") {
    info("execution mode: inspect; decision source: pinned local scorer profile");
    const gold = await loadRows(required(args, "gold"));
    const submission = await loadRows(required(args, "submission"));
    const profile = flag(args, "profile") === "paper"
      ? { id: "paper-7d-sigma" as const, kind: "provided_sigma" as const }
      : { id: "github-5pct-truth" as const, kind: "truth_relative" as const, ratio: 0.05 as const, zeroSigma: 0.01 as const };
    process.stdout.write(`${JSON.stringify(scoreFutureX(gold, submission, profile), null, 2)}\n`);
    return;
  }
  if (action === "run") {
    info("execution mode: benchmark-run; decision source: user command; external submission disabled");
    const input = required(args, "input");
    const output = required(args, "output");
    const revision = required(args, "revision");
    const roundId = required(args, "round");
    const asOfUtc = required(args, "as-of");
    const deadlineUtc = required(args, "deadline");
    const mode = flag(args, "mode") ?? "submission-candidate";
    if (mode === "backtest") {
      throw new Error("Live Predictor research is disabled for FutureX backtests; use frozen evidence replay instead.");
    }
    const asOf = new Date(asOfUtc).getTime();
    const deadline = new Date(deadlineUtc).getTime();
    if (!Number.isFinite(asOf) || !Number.isFinite(deadline) || asOf >= deadline) {
      throw new Error("FutureX requires valid timestamps with --as-of earlier than --deadline.");
    }
    if (asOf > Date.now() + 60_000) throw new Error("FutureX --as-of cannot be in the future.");
    if (Date.now() >= deadline) {
      throw new Error("FutureX deadline has passed. Live-research replay is blocked; use a frozen-evidence backtest pipeline.");
    }
    const routeFile = await loadFutureXRouteOverrides(args, revision);
    if (!routeFile) throw new Error("FutureX paid runs require a human-reviewed, revision-bound --routes file.");
    const checkpointPath = `${output}.checkpoint.json`;
    await preflightOutput(
      args,
      output,
      [input, required(args, "routes")],
      [`${output}.manifest.json`, ...(enabled(args, "resume") ? [] : [checkpointPath])]
    );
    const questions = FutureXQuestionsSchema.parse(await loadRows(input));
    const window = partitionFutureXByWindow(questions, asOfUtc);
    if (window.closed.length > 0) {
      warn(
        `${window.closed.length} question(s) already at/after end_time; excluded from live research and answered from the ` +
          `fallback path so the round still submits: ${window.closed.join(", ")}`
      );
    }
    if (window.open.length === 0) throw new Error("Every FutureX question is past its end_time; nothing to research.");
    assertFutureXRoutesReviewed(questions.map((question) => question.id), routeFile);
    const { tasks } = futureXQuestionsToTasks(questions, {
      revision,
      roundId,
      asOfUtc,
      deadlineUtc,
      routeOverrides: routeFile.routes
    });
    const { config, engine } = createEngine();
    requirePaidOptIn(args, tasks.length * config.trials);
    const checkpointIdentity = {
      benchmark: "futurex",
      revision,
      roundId,
      asOfUtc,
      deadlineUtc,
      model: config.model,
      trials: config.trials,
      // A checkpoint entry is keyed by taskId, which does not encode the route
      // kind. Re-routing a question and resuming would therefore hand back a
      // cached answer of the WRONG kind — a free-text sentence for a question
      // that is now numeric. Binding the routes file makes that impossible.
      routesSha256: await sha256File(required(args, "routes"))
    };
    const resumeResults = await loadResumeResults(args, checkpointPath, tasks, checkpointIdentity);
    const results = await runForecastBatch(tasks, engine, policyForFutureXTask, {
      concurrency: config.concurrency,
      checkpointPath,
      checkpointIdentity,
      ...(resumeResults ? { resumeResults } : {}),
      // R1: a missing answer scores 0 and a wrong one is not penalised, so
      // never abstain. Without this one pathological question yields no
      // submission row at all, because buildFutureXSubmission throws on a gap.
      fallbackFor: (task) => defaultAnswerForTask(task),
      forecastOptions: {
        trials: config.trials,
        concurrency: Math.min(config.trials, 3),
        timeoutMs: config.timeoutMs,
        reasoningEffort: config.reasoningEffort,
        researchSources: config.researchSources
      },
      // R2: per-question marginal weight is 0.005 at L1 and 0.0182 at L4, a
      // 3.6x spread that uniform spend ignores. metadata.level was already
      // written by the adapter and read by nothing.
      forecastOptionsFor: (task) => futureXLevelOptions(task, config),
      onProgress: (completed, total, task) => info(`FutureX ${completed}/${total}: ${task.origin.externalId}`)
    });
    const submission = buildFutureXSubmission(questions, results);
    const report = validateFutureXSubmission(questions, submission, {
      deadlineUtc,
      routeOverrides: routeFile.routes,
      requireComplete: true
    });
    if (!report.valid) throw new Error(report.errors.join("\n"));
    await writeJsonLinesAtomic(output, submission);
    const reasoningPath = await writeReasoningArtifact(output, tasks, results, submission);
    const unresearched = results.filter((result) => result.trials.every((trial) => trial.citations.length === 0));
    if (unresearched.length > 0) {
      warn(
        `${unresearched.length}/${results.length} question(s) were answered with ZERO retrieved sources — that is ` +
          `recall of training data, not forecasting. Review before submitting: ` +
          unresearched.slice(0, 10).map((result) => result.taskId.split(":").pop()).join(", ") +
          (unresearched.length > 10 ? ", …" : "")
      );
    }
    await writeManifest(output, {
      benchmark: "futurex",
      revision,
      roundId,
      model: config.model,
      provider: config.provider,
      // Enough harness identity to tell whether two runs are comparable:
      // trials is the per-question ceiling, effortOverride the provider-level
      // escalation past the engine's own reasoningEffort.
      trials: config.trials,
      effortOverride: config.claudeEffort ?? config.codexEffort ?? null,
      records: submission.length,
      mode,
      evidenceCutoff: asOfUtc,
      routeFile: path.basename(required(args, "routes")),
      reasoning: path.basename(reasoningPath),
      fallbackAnswers: results.filter((result) => result.fallbackUsed).length,
      validation: report
    });
    ok(`FutureX validated artifact written: ${output}`);
    ok(`FutureX reasoning trace written: ${reasoningPath}`);
    return;
  }
  if (action === "pilot") {
    info("execution mode: research-pilot; decision source: explicit id selection; submission eligibility: false");
    const input = required(args, "input");
    const output = required(args, "output");
    const revision = required(args, "revision");
    const roundId = required(args, "round");
    const asOfUtc = required(args, "as-of");
    const ids = futureXIds(args);
    const asOf = new Date(asOfUtc).getTime();
    if (!Number.isFinite(asOf) || asOf > Date.now() + 60_000) throw new Error("FutureX pilot --as-of must be valid and not in the future.");
    const routePath = required(args, "routes");
    const routeFile = await loadFutureXRouteOverrides(args, revision);
    const allQuestions = FutureXQuestionsSchema.parse(await loadRows(input));
    const questions = selectFutureXQuestions(allQuestions, ids);
    // A pilot targets explicitly named ids, so a closed one is an operator
    // mistake worth stopping on rather than silently degrading.
    const pilotWindow = partitionFutureXByWindow(questions, asOfUtc);
    if (pilotWindow.closed.length > 0) {
      throw new Error(`FutureX pilot cannot research tasks at/after end_time: ${pilotWindow.closed.join(", ")}`);
    }
    assertFutureXRoutesReviewed(ids, routeFile);
    const checkpointPath = `${output}.checkpoint.json`;
    await preflightOutput(args, output, [input, routePath], [`${output}.manifest.json`, checkpointPath]);
    const inputSha256 = await sha256File(input);
    const routesSha256 = await sha256File(routePath);
    const { tasks } = futureXQuestionsToTasks(questions, {
      revision,
      roundId,
      asOfUtc,
      routeOverrides: routeFile!.routes
    });
    const { config, engine } = createEngine();
    requirePaidOptIn(args, tasks.length * config.trials);
    const checkpointIdentity = {
      benchmark: "futurex-pilot",
      revision,
      roundId,
      asOfUtc,
      inputSha256,
      routesSha256,
      selection: ids.join(","),
      model: config.model,
      trials: config.trials,
      reasoningEffort: config.reasoningEffort,
      researchSources: config.researchSources.join(",")
    };
    const results = await runForecastBatch(tasks, engine, policyForFutureXTask, {
      concurrency: config.concurrency,
      checkpointPath,
      checkpointEvery: 1,
      checkpointIdentity,
      forecastOptions: {
        trials: config.trials,
        concurrency: Math.min(config.trials, 3),
        timeoutMs: config.timeoutMs,
        reasoningEffort: config.reasoningEffort,
        researchSources: config.researchSources,
        probabilityFloor: 0.01
      },
      onProgress: (completed, total, task, result) =>
        info(`FutureX pilot ${completed}/${total}: ${task.origin.externalId}${result.fallbackUsed ? " [fallback]" : ""}`)
    });
    const artifact = {
      schemaVersion: "raven-gonna-test.futurex-pilot.v1",
      status: "research_only",
      submissionEligible: false,
      evidenceCutoffVerified: false,
      revision,
      roundId,
      asOfUtc,
      generatedAtUtc: new Date().toISOString(),
      totalQuestionCount: allQuestions.length,
      selectedIds: ids,
      results
    };
    await writeJsonAtomic(output, artifact);
    await writeManifest(output, {
      benchmark: "futurex",
      mode: "research-pilot",
      submissionEligible: false,
      evidenceCutoffVerified: false,
      revision,
      roundId,
      model: config.model,
      records: results.length,
      inputSha256,
      routesSha256,
      selectedIds: ids,
      checkpoint: path.basename(checkpointPath)
    });
    ok(`FutureX research-only pilot written: ${output}`);
    return;
  }
  throw new Error(`Unknown FutureX action: ${action ?? "(missing)"}`);
}

async function commandForecastBench(action: string | undefined, args: Args): Promise<void> {
  if (action === "fetch") {
    info("execution mode: inspect; decision source: official dated ForecastBench question set");
    const name = required(args, "question-set");
    const output = required(args, "output");
    await preflightOutput(args, output);
    const set = await fetchForecastBenchQuestionSet(name);
    await writeJsonAtomic(output, set);
    await writeManifest(output, { benchmark: "forecastbench", questionSet: name, questions: set.questions.length });
    ok(`ForecastBench questions written: ${output}`);
    return;
  }
  if (action === "validate") {
    info("execution mode: inspect; decision source: ForecastBench submission contract");
    const questionSet = ForecastBenchQuestionSetSchema.parse(await readJson(required(args, "input")));
    const submissionPath = required(args, "submission");
    const submission = ForecastBenchForecastSetSchema.parse(await readJson(submissionPath));
    const report = validateForecastBenchCoverage(questionSet, submission);
    if ((flag(args, "mode") ?? "submission-candidate") !== "backtest") {
      const profile = validateForecastBenchLiveQuestionSet(questionSet);
      if (!profile.valid) report.errors.push(...profile.errors);
      try {
        assertForecastBenchFilename(
          submissionPath,
          questionSet.forecast_due_date,
          submission.organization,
          numberFlag(args, "submission-number", 1)
        );
      } catch (error) {
        report.errors.push(error instanceof Error ? error.message : String(error));
      }
      report.valid = report.errors.length === 0;
    }
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    if (!report.valid) process.exitCode = 6;
    return;
  }
  if (action === "score") {
    info("execution mode: inspect; decision source: raw local Brier (not official difficulty-adjusted)");
    const questionSet = await readJson(required(args, "input"));
    const submission = await readJson(required(args, "submission"));
    const resolutionPath = required(args, "resolutions");
    const resolutions = resolutionPath.endsWith(".jsonl")
      ? await readJsonLines(resolutionPath)
      : await readJson(resolutionPath);
    process.stdout.write(`${JSON.stringify(scoreForecastBenchRaw(questionSet, submission, resolutions), null, 2)}\n`);
    return;
  }
  if (action === "run") {
    info("execution mode: benchmark-run; decision source: user command; GCS upload disabled");
    const input = required(args, "input");
    const output = required(args, "output");
    const organization = required(args, "organization");
    const modelOrganization = required(args, "model-organization");
    const requestedModelName = flag(args, "model-name") ?? process.env.PREDICTOR_MODEL ?? "foresight-v4";
    const mode = flag(args, "mode") ?? "submission-candidate";
    const submissionNumber = numberFlag(args, "submission-number", 1);
    const maximumFallbackRate = numberFlag(args, "max-fallback-rate", 0.02);
    if (maximumFallbackRate < 0 || maximumFallbackRate > 1) throw new Error("--max-fallback-rate must be in [0,1].");
    const questionSet = ForecastBenchQuestionSetSchema.parse(await readJson(input));
    if (mode !== "backtest") {
      const profile = validateForecastBenchLiveQuestionSet(questionSet);
      if (!profile.valid) throw new Error(profile.errors.join("\n"));
      assertForecastBenchFilename(output, questionSet.forecast_due_date, organization, submissionNumber);
    }
    const opening = new Date(`${questionSet.forecast_due_date}T00:00:00.000Z`).getTime();
    const deadline = new Date(`${questionSet.forecast_due_date}T23:59:59.000Z`).getTime();
    const asOfUtc = flag(args, "as-of") ?? (mode === "backtest"
      ? new Date(opening).toISOString()
      : new Date().toISOString());
    const asOf = new Date(asOfUtc).getTime();
    if (!Number.isFinite(asOf)) throw new Error("--as-of must be a valid ISO timestamp.");
    if (mode !== "backtest" && asOf > Date.now() + 60_000) throw new Error("ForecastBench --as-of cannot be in the future.");
    if (mode !== "backtest" && (asOf < opening || asOf >= deadline || Date.now() >= deadline)) {
      throw new Error(`ForecastBench submission runs require ${new Date(opening).toISOString()} <= as-of < ${new Date(deadline).toISOString()} and an open deadline.`);
    }
    if (mode === "backtest" && !args.flags.has("baseline-only")) {
      throw new Error("Live Predictor research is disabled for ForecastBench backtests; use --baseline-only or frozen evidence replay.");
    }
    const marketSnapshot = await loadForecastBenchMarketSnapshot(args, questionSet.question_set, asOfUtc);
    const checkpointPath = `${output}.checkpoint.json`;
    await preflightOutput(
      args,
      output,
      [input, ...(marketSnapshot ? [marketSnapshot.filePath] : [])],
      [`${output}.manifest.json`, ...(enabled(args, "resume") ? [] : [checkpointPath])]
    );
    const expanded = expandForecastBenchQuestionSet(questionSet, {
      asOfUtc,
      ...(marketSnapshot ? { marketPriorByQuestion: marketSnapshot.priors } : {})
    });
    let results: ForecastResult[];
    let modelName = requestedModelName;
    if (args.flags.has("baseline-only")) {
      modelName = "source-safety-baseline-v1";
      results = expanded.map((item) => {
        const baseline = sourceBaseline(item, marketSnapshot?.priors);
        return baselineResult(item.task, { kind: "binary", pYes: baseline.probability }, modelName, baseline.reason);
      });
    } else {
      const { config, engine } = createEngine();
      modelName = flag(args, "model-name") ?? config.model;
      requirePaidOptIn(args, expanded.length * config.trials);
      const checkpointIdentity = {
        benchmark: "forecastbench",
        questionSet: questionSet.question_set,
        asOfUtc,
        model: config.model,
        trials: config.trials
      };
      const resumeResults = await loadResumeResults(
        args,
        checkpointPath,
        expanded.map((item) => item.task),
        checkpointIdentity
      );
      const byTask = new Map(expanded.map((item) => [item.task.taskId, item]));
      results = await runForecastBatch(expanded.map((item) => item.task), engine, policyForForecastBenchTask, {
        concurrency: config.concurrency,
        checkpointPath,
        checkpointIdentity,
        ...(resumeResults ? { resumeResults } : {}),
        fallbackFor: (task) => {
          const item = byTask.get(task.taskId);
          return item ? { kind: "binary", pYes: sourceBaseline(item, marketSnapshot?.priors).probability } : undefined;
        },
        forecastOptions: {
          trials: config.trials,
          concurrency: Math.min(config.trials, 3),
          timeoutMs: config.timeoutMs,
          reasoningEffort: config.reasoningEffort,
          researchSources: config.researchSources,
          priorWeight: numberFlag(args, "prior-weight", 0.6),
          probabilityFloor: 0.01
        },
        onProgress: (completed, total, task, result) =>
          info(`ForecastBench ${completed}/${total}: ${task.origin.source}/${task.origin.externalId}${result.fallbackUsed ? " [fallback]" : ""}`)
      });
    }
    const forecastSet = buildForecastBenchForecastSet(questionSet, {
      organization,
      model: modelName,
      modelOrganization
    }, results);
    const report = validateForecastBenchCoverage(questionSet, forecastSet);
    if (!report.valid) throw new Error(report.errors.join("\n"));
    const fallbackIds = results.filter((result) => result.fallbackUsed).map((result) => result.taskId);
    const fallbackRate = results.length ? fallbackIds.length / results.length : 0;
    if (!args.flags.has("baseline-only") && fallbackRate > maximumFallbackRate) {
      throw new Error(`Fallback rate ${fallbackRate.toFixed(4)} exceeds maximum ${maximumFallbackRate.toFixed(4)}.`);
    }
    await writeJsonAtomic(output, forecastSet);
    await writeManifest(output, {
      benchmark: "forecastbench",
      questionSet: forecastSet.question_set,
      model: modelName,
      rows: forecastSet.forecasts.length,
      mode,
      evidenceCutoff: asOfUtc,
      questionSetSha256: await sha256File(input),
      marketSnapshot: marketSnapshot ? {
        file: path.basename(marketSnapshot.filePath),
        sha256: await sha256File(marketSnapshot.filePath),
        capturedAtUtc: marketSnapshot.snapshot.capturedAtUtc,
        quotes: marketSnapshot.snapshot.quotes.length
      } : null,
      fallback: { count: fallbackIds.length, rate: fallbackRate, taskIds: fallbackIds },
      validation: report
    });
    ok(`ForecastBench validated artifact written: ${output}`);
    return;
  }
  throw new Error(`Unknown ForecastBench action: ${action ?? "(missing)"}`);
}

async function commandProphet(action: string | undefined, args: Args): Promise<void> {
  if (action !== "predict") throw new Error(`Unknown Prophet action: ${action ?? "(missing)"}`);
  info("execution mode: benchmark-run; decision source: supplied Prophet event; no trading");
  const input = required(args, "input");
  const output = required(args, "output");
  const checkpointPath = `${output}.checkpoint.json`;
  await preflightOutput(
    args,
    output,
    [input],
    [`${output}.manifest.json`, ...(enabled(args, "resume") ? [] : [checkpointPath])]
  );
  const residualCap = numberFlag(args, "residual-cap", 0.05);
  if (residualCap < 0 || residualCap > 1) throw new Error("--residual-cap must be in [0,1].");
  const event = normalizeProphetRequest(await readJson(input), "auto");
  const asOfUtc = flag(args, "as-of") ?? new Date().toISOString();
  const asOf = new Date(asOfUtc).getTime();
  if (!Number.isFinite(asOf)) throw new Error("--as-of must be a valid ISO timestamp.");
  if (asOf > Date.now() + 60_000) throw new Error("Prophet --as-of cannot be in the future.");
  if (event.closeTime && asOf >= new Date(event.closeTime).getTime()) throw new Error("Prophet event is already closed at the requested as-of time.");
  const tasks = prophetEventToTasks(event, asOfUtc);
  let results: ForecastResult[] = [];
  if (!args.flags.has("baseline-only")) {
    const { config, engine } = createEngine();
    requirePaidOptIn(args, tasks.length * config.trials);
    const checkpointIdentity = {
      benchmark: "prophet-arena",
      eventId: event.eventId,
      asOfUtc,
      model: config.model,
      trials: config.trials
    };
    const resumeResults = await loadResumeResults(args, checkpointPath, tasks, checkpointIdentity);
    results = await runForecastBatch(tasks, engine, policyForProphetTask, {
      concurrency: config.concurrency,
      checkpointPath,
      checkpointIdentity,
      ...(resumeResults ? { resumeResults } : {}),
      fallbackFor: prophetFallbackAnswer,
      forecastOptions: {
        trials: config.trials,
        concurrency: Math.min(config.trials, 3),
        timeoutMs: config.timeoutMs,
        reasoningEffort: config.reasoningEffort,
        researchSources: config.researchSources,
        priorWeight: numberFlag(args, "prior-weight", 0.7),
        probabilityFloor: 0.001
      },
      onProgress: (completed, total, task, result) =>
        info(`Prophet ${completed}/${total}: ${task.metadata.outcome as string}${result.fallbackUsed ? " [fallback]" : ""}`)
    });
  }
  const response = event.wireVersion === "legacy"
    ? buildProphetLegacyResponse(event, results, { residualCap })
    : buildProphetCurrentResponse(event, results, { residualCap });
  const report = event.wireVersion === "legacy"
    ? validateProphetLegacyResponse(event, response)
    : validateProphetCurrentResponse(event, response);
  if (!report.valid) throw new Error(report.errors.join("\n"));
  await writeJsonAtomic(output, response);
  await writeManifest(output, {
    benchmark: "prophet-arena",
    eventId: event.eventId,
    wireVersion: event.wireVersion,
    evidenceCutoff: asOfUtc,
    mode: args.flags.has("baseline-only") ? "market-prior-baseline" : "predictor-bounded-residual",
    fallback: {
      count: results.filter((result) => result.fallbackUsed).length,
      taskIds: results.filter((result) => result.fallbackUsed).map((result) => result.taskId)
    },
    validation: report
  });
  ok(`Prophet response written: ${output}`);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const [command, action] = args.positional;
  if (!command || command === "help" || args.flags.has("help")) {
    showHelp();
    return;
  }
  if (command === "doctor") return commandDoctor();
  if (command === "futurex") return commandFutureX(action, args);
  if (command === "forecastbench") return commandForecastBench(action, args);
  if (command === "prophet") return commandProphet(action, args);
  throw new Error(`Unknown command: ${command}`);
}

main().catch((error) => {
  process.stderr.write(`[ERR] ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  // An AggregateError's message says only that every trial failed; the causes
  // live in .errors, and swallowing them makes the failure undiagnosable from
  // the log — which is the only thing a detached batch run leaves behind.
  if (error instanceof AggregateError) {
    for (const cause of error.errors) {
      process.stderr.write(`[ERR]   cause: ${cause instanceof Error ? cause.message : String(cause)}\n`);
    }
  }
  process.exitCode = 1;
});
