import type { ForecastResult, ForecastTask } from "@raven-gonna-test/forecast-core";
import { futureXPolicy } from "@raven-gonna-test/forecast-core";
import type { ValidationReport } from "../contract.js";
import {
  FutureXQuestionSchema,
  FutureXQuestionsSchema,
  FutureXSubmissionRowSchema,
  type FutureXQuestion,
  type FutureXRoute,
  type FutureXRouteOverride,
  type FutureXSubmissionRow,
  type FutureXTaskKind
} from "./schema.js";

const CHOICE_LINE = /^\s*([A-Z])\.\s+(?:the outcome be\s+)?(.+?)\s*$/gim;
const NUMERIC_PATTERN = /\b(?:numeric prediction|how (?:many|much)|what (?:will|is|was)(?: be)? (?:the )?(?:closing )?(?:price|value|number|total|rate|percentage|percent|index|close|open|margin|duration)|average price|day(?:'s)? close|grain index|revenue|gross bookings?|gross merchandise volume|market capitalization|adjusted ebitda|sales|reserves?|inventor(?:y|ies)|storage|claims|gdp growth|pmi|box office gross|working gas|productivity growth|policy repo rate|elo rating|runs?|winning margin|rated good or excellent)\b|\b(?:usd|cny|dkk|nt\$)\s*(?:millions?|billions?)\b|\b(?:millions?|billions?|two decimal places|one decimal place|annualized quarter-over-quarter)\b/i;
const RANKING_PATTERN =
  /\b(?:rank|ranking|ranked|ordered|in order|top (?:\d+|one|two|three|four|five|six|seven|eight|nine|ten)|winners? of the (?:\d+|one|two|three|four|five|six|seven|eight|nine|ten))\b/i;
const MULTI_PATTERN = /\b(?:select all|choose all|all that apply|more than one)\b/i;
const STRONG_MULTI_PATTERN = /\bwhich\s+(?:[\w'-]+\s+){0,4}(?:cards|accounts|countries|states|teams|players|projects|movies|songs|works|events|companies|nominees|candidates)\s+will\b/i;
const STRONG_SINGLE_PATTERN = /\b(?:who will win|winner of|which (?:candidate|ticket|club|team|player|person) will (?:win|receive)|most votes|\bvs\.?\b)\b/i;
const BOXED_ALTERNATIVES_PATTERN = /\\boxed\{([^{}]+)\}\s*or\s*\\boxed\{([^{}]+)\}/i;
// The prompt often DECLARES its answer type outright ("Return only the exact
// published numeric value for x_percent", "MUST end with exactly one boxed
// numeric value"). That is authoritative, unlike NUMERIC_PATTERN's enumeration
// of domain nouns, which misses phrasings such as "what exact <rate> will X
// report" and leaves those questions routed as free text — where they are
// aggregated by exact-string vote and tie-broken alphabetically.
const NUMERIC_CONTRACT_PATTERN =
  /boxed numeric value|exact published numeric value|only the exact numeric|numeric prediction only/i;
// The 2026-08-26 wire format removed the target field/unit from many L3/L4
// prompts and replaced it with this generic settlement-contract sentence.
// It is numeric only after ranking language has had first refusal: the same
// sentence also appears on "top five" and "six winners" list questions.
const SOURCE_NATIVE_VALUE_PATTERN = /return exactly the source-native value required by the settlement contract/i;
// "what exact <measurement> will X report" asks for a quantity even when the
// prompt only supplies the generic \boxed{YOUR_PREDICTION} envelope, so the
// contract pattern above does not fire. Routed as free text these produce prose
// ("Composite CPI +2.1% year-on-year (Census…"), which the grader compares by
// exact string and scores 0. The noun list is what makes this safe: "what exact
// film/winner/team" stays an entity question.
// An entity name or a ` | `-separated list, never a sentence. Sentence-ending
// punctuation mid-string, a parenthetical gloss, or sheer length all mark an
// answer the grader will score 0 on an exact-string comparison.
const PROSE_PREDICTION = /[.!?]\s+\S|\s\(|\bapprox(?:imately)?\b|\byear-on-year\b|:\s/i;
// A refusal dressed as an answer. R1 says never abstain: a wrong guess and an
// "unknown" both score 0, so hedging forfeits the upside for nothing.
const HEDGED_PREDICTION =
  /\b(?:not yet|unknown|unclear|cannot|can't|unable|to be (?:announced|confirmed|determined)|tbd|n\/a|no (?:public|official) )/i;
// A count of discrete things: the truth is necessarily a whole number. Sigma is
// 5% of it, so on a small count a fractional answer falls outside the parabola
// completely — 2.22 against a truth of 2 scores 0 where 2 scores 1. Rates,
// revenues and percentages are excluded: those are genuinely continuous.
const COUNT_TITLE_PATTERN =
  /\bhow many\b|\b(?:total |exact )?number of\b|\bhow many .*\bwins?\b/i;
const NON_COUNT_PATTERN = /\b(?:rate|percentage|percent|inflation|revenue|price|index|balance|receipts|yield|change)\b/i;

export function isCountQuestion(title: string, unit?: string): boolean {
  if (unit && /_(?:count|items|patients|runs|wins|games)$/i.test(unit)) return true;
  return COUNT_TITLE_PATTERN.test(title) && !NON_COUNT_PATTERN.test(title);
}

const NUMERIC_TITLE_PATTERN =
  /\bwhat exact\b[^?]*\b(?:rate|change|receipts|revenue|balance|value|number|count|price|total|level|index|yield|ratio|percentage|amount)\b/i;

export interface FutureXAdapterOptions {
  revision: string;
  roundId: string;
  asOfUtc: string;
  deadlineUtc?: string;
  routeOverrides?: Record<string, FutureXRouteOverride>;
}

export function extractFutureXChoices(prompt: string): Array<{ key: string; text: string }> {
  const choices: Array<{ key: string; text: string }> = [];
  for (const match of prompt.matchAll(CHOICE_LINE)) {
    const key = match[1]?.trim();
    const text = match[2]?.trim().replace(/"$/, "");
    if (key && text && !choices.some((choice) => choice.key === key)) choices.push({ key, text });
  }
  return choices;
}

function rankingCount(text: string): number | undefined {
  const range = text.match(/ranked\s+from\s+(\d+)\s+to\s+(\d+)/i);
  if (range?.[1] && range[2]) {
    const start = Number(range[1]);
    const end = Number(range[2]);
    if (end >= start) return end - start + 1;
  }
  const token = text.match(/(?:top|rank)\s+(\d+|one|two|three|four|five|six|seven|eight|nine|ten)\b/i)?.[1]
    ?? text.match(/winners? of the (\d+|one|two|three|four|five|six|seven|eight|nine|ten)\b/i)?.[1];
  if (!token) return undefined;
  if (/^\d+$/.test(token)) return Number(token);
  return ({ one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 } as const)[
    token.toLowerCase() as "one" | "two" | "three" | "four" | "five" | "six" | "seven" | "eight" | "nine" | "ten"
  ];
}

function semanticPrompt(prompt: string): string {
  return prompt.split(/\bIMPORTANT:/i)[0] ?? prompt;
}

const NUMERIC_TARGET_FIELD = /numeric value for\s+([A-Za-z0-9_]+)/i;

/** The snake_case field FutureX will publish the answer under, when the prompt
 *  names one. It encodes both the quantity and its scale (usd_millions,
 *  yoy_percent), which is exactly what the model must be told. */
export function numericTargetField(prompt: string): string | undefined {
  return prompt.match(NUMERIC_TARGET_FIELD)?.[1];
}

export function routeFutureXQuestion(
  question: FutureXQuestion,
  override?: FutureXRouteOverride | FutureXTaskKind
): FutureXRoute {
  const extractedChoices = extractFutureXChoices(question.prompt);
  const semantic = `${question.en_title}\n${semanticPrompt(question.prompt)}`;
  if (override) {
    const value = typeof override === "string" ? { kind: override } : override;
    return {
      kind: value.kind,
      choices: value.choices ?? extractedChoices,
      ...(value.rankCount ? { rankCount: value.rankCount } : {}),
      confidence: 1,
      reasons: ["revision-bound override"]
    };
  }
  const boxedAlternatives = question.prompt.match(BOXED_ALTERNATIVES_PATTERN);
  if (boxedAlternatives?.[1] && boxedAlternatives[2]) {
    const left = boxedAlternatives[1].trim();
    const right = boxedAlternatives[2].trim();
    return {
      kind: "single_choice",
      choices: [{ key: left, text: left }, { key: right, text: right }],
      confidence: 1,
      reasons: ["explicit boxed alternative contract"]
    };
  }
  // Checked before the title heuristics: an explicit output contract beats any
  // inference drawn from how the question is phrased.
  if (NUMERIC_CONTRACT_PATTERN.test(question.prompt)) {
    return { kind: "numeric", choices: [], confidence: 0.97, reasons: ["explicit numeric output contract"] };
  }
  if (NUMERIC_TITLE_PATTERN.test(question.en_title)) {
    return { kind: "numeric", choices: [], confidence: 0.9, reasons: ["asks for an exact measured quantity"] };
  }
  if (RANKING_PATTERN.test(question.en_title) || RANKING_PATTERN.test(question.prompt)) {
    const count = rankingCount(semantic);
    // "ranking" is frequently a noun for the standings rather than an
    // instruction to order things — "which club will be FIRST in the final
    // championship ranking?" wants one entity. With neither a rank count nor a
    // candidate set there is nothing to order, so this is not a ranking task;
    // routing it as one previously threw and killed the whole run.
    if (count || extractedChoices.length > 0) {
      const route: FutureXRoute = {
        kind: "ranking",
        choices: extractedChoices,
        confidence: count ? 0.95 : 0.65,
        reasons: ["explicit ranking language"]
      };
      if (count) route.rankCount = count;
      return route;
    }
  }
  if (SOURCE_NATIVE_VALUE_PATTERN.test(question.prompt)) {
    return {
      kind: "numeric",
      choices: [],
      confidence: 0.9,
      reasons: ["generic source-native settlement value after ranking exclusion"]
    };
  }
  if (extractedChoices.length >= 2) {
    const multi = MULTI_PATTERN.test(semantic) || STRONG_MULTI_PATTERN.test(semantic);
    const single = STRONG_SINGLE_PATTERN.test(semantic);
    return {
      kind: multi ? "multi_choice" : "single_choice",
      choices: extractedChoices,
      confidence: multi || single ? 0.9 : 0.75,
      reasons: [multi ? "multi-answer semantics before instruction boilerplate" : single ? "single-winner semantics" : "enumerated choices; default singleton"]
    };
  }
  if (NUMERIC_PATTERN.test(question.en_title) || NUMERIC_PATTERN.test(question.prompt)) {
    return { kind: "numeric", choices: [], confidence: 0.9, reasons: ["numeric unit or measurement contract"] };
  }
  return { kind: "open_text", choices: [], confidence: 0.8, reasons: ["canonical entity/category/score response"] };
}

export function futureXEndTimeUtc(value: string): string | undefined {
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return `${value}T15:59:59.000Z`;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : undefined;
}

export function futureXQuestionsToTasks(
  input: unknown,
  options: FutureXAdapterOptions
): { tasks: ForecastTask[]; routes: Map<string, FutureXRoute> } {
  if (!/^[0-9a-f]{40}$/i.test(options.revision)) {
    throw new Error("FutureX revision must be a full 40-character commit SHA; main/latest is not accepted.");
  }
  const questions = FutureXQuestionsSchema.parse(input);
  const seen = new Set<string>();
  const routes = new Map<string, FutureXRoute>();
  const tasks = questions.map((question) => {
    if (seen.has(question.id)) throw new Error(`Duplicate FutureX id: ${question.id}`);
    seen.add(question.id);
    const route = routeFutureXQuestion(question, options.routeOverrides?.[question.id]);
    routes.set(question.id, route);
    const common = {
      taskId: `futurex:${options.revision}:${question.id}`,
      origin: {
        benchmark: "futurex" as const,
        roundId: options.roundId,
        externalId: question.id,
        source: "futurex-online"
      },
      prompt: question.prompt,
      asOfUtc: options.asOfUtc,
      resolution: {
        criteria: question.prompt,
        ...(futureXEndTimeUtc(question.end_time) ? { dateUtc: futureXEndTimeUtc(question.end_time) } : {})
      },
      metadata: { level: question.level, title: question.en_title, revision: options.revision, route },
      ...(options.deadlineUtc ? { deadlineUtc: options.deadlineUtc } : {})
    };
    switch (route.kind) {
      case "single_choice":
        return { ...common, kind: "categorical" as const, choices: route.choices.map((choice) => choice.key) };
      case "multi_choice":
        return {
          ...common,
          kind: "multi_label" as const,
          choices: route.choices.map((choice) => choice.key),
          minimumSelections: 1,
          maximumSelections: route.choices.length
        };
      case "ranking": {
        const candidates = route.choices.length > 0 ? route.choices.map((choice) => choice.key) : [];
        if (!route.rankCount) throw new Error(`FutureX ranking ${question.id} has no rankCount; add a revision-bound override.`);
        return {
          ...common,
          kind: "ranking" as const,
          candidates,
          rankCount: candidates.length > 0 ? Math.min(route.rankCount, candidates.length) : route.rankCount
        };
      }
      case "numeric": {
        // The prompt names the exact field it wants ("...numeric value for
        // revenue_usd_millions"), which carries the scale and unit. Passing it
        // through is the difference between the model answering in millions and
        // answering in billions — an error no downstream aggregation can repair.
        const targetField = numericTargetField(question.prompt);
        const integerValued = isCountQuestion(question.en_title, targetField);
        return {
          ...common,
          kind: "numeric" as const,
          ...(targetField ? { unit: targetField } : {}),
          ...(integerValued ? { integerValued: true } : {})
        };
      }
      case "open_text":
        return { ...common, kind: "free_response" as const };
    }
  });
  return { tasks, routes };
}

function decimal(value: number): string {
  if (!Number.isFinite(value)) throw new Error(`FutureX numeric answer must be finite: ${String(value)}`);
  return String(Number(value.toPrecision(15)));
}

export function futureXPredictionFromResult(result: ForecastResult): string {
  switch (result.answer.kind) {
    case "binary":
      return decimal(result.answer.pYes);
    case "categorical":
      return result.answer.choice;
    case "multi_label":
      return result.answer.selected.join(", ");
    case "ranking":
      return result.answer.order.join(", ");
    case "numeric":
      return decimal(result.answer.value);
    case "free_response":
      return result.answer.value.trim();
  }
}

export function buildFutureXSubmission(
  questionsInput: unknown,
  results: readonly ForecastResult[]
): FutureXSubmissionRow[] {
  const questions = FutureXQuestionsSchema.parse(questionsInput);
  const byExternalId = new Map<string, ForecastResult>();
  for (const result of results) {
    const match = result.taskId.match(/^futurex:[0-9a-f]{40}:(.+)$/i);
    const id = match?.[1];
    if (!id) throw new Error(`Cannot extract FutureX id from ${result.taskId}.`);
    if (byExternalId.has(id)) throw new Error(`Duplicate FutureX result for ${id}.`);
    byExternalId.set(id, result);
  }
  return questions.map((question) => {
    const result = byExternalId.get(question.id);
    if (!result) throw new Error(`Missing FutureX result for ${question.id}.`);
    return FutureXSubmissionRowSchema.parse({ id: question.id, prediction: futureXPredictionFromResult(result) });
  });
}

const DECIMAL_ONLY = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;

export function validateFutureXSubmission(
  questionsInput: unknown,
  submissionInput: unknown,
  options: { deadlineUtc?: string; now?: Date; routeOverrides?: Record<string, FutureXRouteOverride>; requireComplete?: boolean } = {}
): ValidationReport {
  const questions = FutureXQuestionsSchema.parse(questionsInput);
  const submissionRaw = Array.isArray(submissionInput) ? submissionInput : [];
  const errors: string[] = [];
  const warnings: string[] = [];
  const expected = new Map(questions.map((question) => [question.id, question]));
  const submitted = new Map<string, FutureXSubmissionRow>();
  for (const raw of submissionRaw) {
    const parsed = FutureXSubmissionRowSchema.safeParse(raw);
    if (!parsed.success) {
      errors.push(`Invalid submission row: ${parsed.error.issues.map((issue) => issue.message).join(", ")}`);
      continue;
    }
    if (!expected.has(parsed.data.id)) errors.push(`Unexpected FutureX id: ${parsed.data.id}`);
    if (submitted.has(parsed.data.id)) errors.push(`Duplicate FutureX id: ${parsed.data.id}`);
    submitted.set(parsed.data.id, parsed.data);
  }
  for (const question of questions) {
    const row = submitted.get(question.id);
    if (!row) {
      errors.push(`Missing FutureX id: ${question.id}`);
      continue;
    }
    const prediction = row.prediction.trim();
    if (!prediction && options.requireComplete !== false) errors.push(`Empty prediction for ${question.id}`);
    const route = routeFutureXQuestion(question, options.routeOverrides?.[question.id]);
    const labels = prediction.split(",").map((part) => part.trim()).filter(Boolean);
    const allowed = new Set(route.choices.map((choice) => choice.key));
    if (route.kind === "single_choice" && (labels.length !== 1 || !allowed.has(labels[0] ?? ""))) {
      errors.push(`Invalid single-choice prediction for ${question.id}: ${prediction}`);
    }
    if (route.kind === "multi_choice" && (labels.length === 0 || labels.some((label) => !allowed.has(label)))) {
      errors.push(`Invalid multi-choice prediction for ${question.id}: ${prediction}`);
    }
    if (route.kind === "multi_choice" && new Set(labels).size !== labels.length) {
      errors.push(`Duplicate multi-choice label for ${question.id}: ${prediction}`);
    }
    if (route.kind === "ranking") {
      const expectedCount = route.rankCount;
      if (!expectedCount) errors.push(`Ranking contract has no answer count for ${question.id}.`);
      if (labels.length !== expectedCount || new Set(labels).size !== labels.length) {
        errors.push(`Invalid ranking length/duplicates for ${question.id}: ${prediction}`);
      }
      if (allowed.size > 0 && labels.some((label) => !allowed.has(label))) {
        errors.push(`Unknown ranking label for ${question.id}: ${prediction}`);
      }
    }
    if (route.kind === "numeric" && (!DECIMAL_ONLY.test(prediction) || !Number.isFinite(Number(prediction)))) {
      errors.push(`Invalid numeric prediction for ${question.id}: ${prediction}`);
    }
    // open_text had no checks at all, so a prose sentence shipped unchallenged —
    // and the grader compares open text by exact string, meaning prose scores 0.
    // These are errors, not warnings: a sentence is never a right answer, and a
    // silent 0 on an L4 question is expensive.
    if (route.kind === "open_text") {
      if (PROSE_PREDICTION.test(prediction)) {
        errors.push(`Open-text prediction for ${question.id} reads as prose, not an answer: ${prediction.slice(0, 80)}`);
      }
      if (HEDGED_PREDICTION.test(prediction)) {
        errors.push(`Open-text prediction for ${question.id} hedges instead of answering: ${prediction.slice(0, 80)}`);
      }
    }
  }
  if (options.deadlineUtc) {
    const deadline = new Date(options.deadlineUtc).getTime();
    if (!Number.isFinite(deadline)) errors.push(`Invalid submission deadline: ${options.deadlineUtc}`);
    else if ((options.now ?? new Date()).getTime() >= deadline) errors.push(`Submission deadline has passed: ${options.deadlineUtc}`);
  }
  if (questions.some((question) => routeFutureXQuestion(question, options.routeOverrides?.[question.id]).confidence < 0.7)) {
    warnings.push("At least one FutureX route has low confidence; add a SHA-bound route override before submission.");
  }
  return {
    valid: errors.length === 0,
    errors,
    warnings,
    stats: {
      expected: questions.length,
      submitted: submitted.size,
      coverage: questions.length ? submitted.size / questions.length : 0
    }
  };
}

export interface FutureXFetchProvenance {
  revision: string;
  files: Array<{ path: string; gitOid: string; size: number; sha256: string }>;
  recordCount: number;
  recordsSha256: string;
}

export async function fetchFutureXOnlinePinned(options: {
  revision: string;
  dataset?: string;
  fetchFn?: typeof fetch;
}): Promise<{ questions: FutureXQuestion[]; provenance: FutureXFetchProvenance }> {
  if (!/^[0-9a-f]{40}$/i.test(options.revision)) throw new Error("FutureX fetch requires a full 40-character revision.");
  const fetchFn = options.fetchFn ?? fetch;
  const dataset = options.dataset ?? "futurex-ai/Futurex-Online";
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(dataset)) throw new Error("Invalid Hugging Face dataset identifier.");
  const revisionResponse = await fetchFn(`https://huggingface.co/api/datasets/${dataset}/revision/${options.revision}`);
  if (!revisionResponse.ok) throw new Error(`FutureX revision lookup failed: HTTP ${revisionResponse.status}`);
  const revisionPayload = await revisionResponse.json() as { sha?: string };
  if (revisionPayload.sha?.toLowerCase() !== options.revision.toLowerCase()) {
    throw new Error(`FutureX revision mismatch: requested ${options.revision}, resolved ${revisionPayload.sha ?? "unknown"}.`);
  }
  const treeResponse = await fetchFn(
    `https://huggingface.co/api/datasets/${dataset}/tree/${options.revision}?recursive=true&expand=false&limit=1000`
  );
  if (!treeResponse.ok) throw new Error(`FutureX revision tree failed: HTTP ${treeResponse.status}`);
  const tree = await treeResponse.json() as Array<{ type?: string; path?: string; oid?: string; size?: number }>;
  const parquetFiles = tree
    .filter((item) => item.type === "file" && item.path?.startsWith("data/") && item.path.endsWith(".parquet"))
    .sort((left, right) => String(left.path).localeCompare(String(right.path)));
  if (parquetFiles.length === 0) throw new Error("Pinned FutureX revision contains no data/*.parquet file.");
  const rows: FutureXQuestion[] = [];
  const files: FutureXFetchProvenance["files"] = [];
  for (const item of parquetFiles) {
    const filePath = item.path!;
    const encodedPath = filePath.split("/").map(encodeURIComponent).join("/");
    const response = await fetchFn(`https://huggingface.co/datasets/${dataset}/resolve/${options.revision}/${encodedPath}`);
    if (!response.ok) throw new Error(`FutureX pinned parquet fetch failed for ${filePath}: HTTP ${response.status}`);
    const buffer = await response.arrayBuffer();
    const parsedRows = await parquetReadObjects({ file: buffer });
    for (const row of parsedRows) rows.push(FutureXQuestionSchema.parse(row));
    files.push({
      path: filePath,
      gitOid: item.oid ?? "unknown",
      size: buffer.byteLength,
      sha256: createHash("sha256").update(new Uint8Array(buffer)).digest("hex")
    });
  }
  const questions = FutureXQuestionsSchema.parse(rows);
  const recordsSha256 = createHash("sha256").update(JSON.stringify(questions)).digest("hex");
  return {
    questions,
    provenance: { revision: options.revision, files, recordCount: questions.length, recordsSha256 }
  };
}

export async function fetchFutureXOnline(options: {
  revision: string;
  dataset?: string;
  fetchFn?: typeof fetch;
}): Promise<FutureXQuestion[]> {
  return (await fetchFutureXOnlinePinned(options)).questions;
}

export async function discoverFutureXRevision(fetchFn: typeof fetch = fetch): Promise<{
  sha: string;
  lastModified: string | null;
}> {
  const response = await fetchFn("https://huggingface.co/api/datasets/futurex-ai/Futurex-Online/revision/main");
  if (!response.ok) throw new Error(`FutureX discovery failed: HTTP ${response.status}`);
  const payload = await response.json() as { sha?: string; lastModified?: string };
  if (!payload.sha || !/^[0-9a-f]{40}$/i.test(payload.sha)) throw new Error("FutureX discovery returned no full revision SHA.");
  return { sha: payload.sha, lastModified: payload.lastModified ?? null };
}

export function policyForFutureXTask(task: ForecastTask) {
  return futureXPolicy(task.asOfUtc);
}
import { createHash } from "node:crypto";
import { parquetReadObjects } from "hyparquet";
