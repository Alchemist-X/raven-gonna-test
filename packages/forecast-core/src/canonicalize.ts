// Entity canonicalization and cross-trial clustering for open_text answers.
//
// The scoring rule that motivates this: open_text is graded locally by exact
// string match after trim + lowercase + whitespace collapse (see normalized()
// in the FutureX scorer). Everything that survives that fold is load-bearing —
// a trailing period, a leading "The", a stray quote, or "Pérez" vs "Perez"
// each turn a correct answer into a zero.
//
// Two jobs, deliberately split:
//   canonicalizeEntity — what we EMIT. Lossless with respect to the printed
//     name: casing and diacritics are preserved, only decoration is removed.
//   clusterAnswers — how we VOTE. Aggressively folds articles, diacritics and
//     punctuation, because those never distinguish two real entities.
//
// The asymmetry is the point: fold for matching, preserve for output.

export interface CanonicalizeOptions {
  /**
   * Remove a leading "the"/"a"/"an". Defaults to FALSE: the article is part of
   * the printed name for The Hague, The Beatles, The New York Times, so
   * stripping it unconditionally loses exact match as often as it wins one.
   * Article insensitivity is what the *comparison* needs, and entityFoldKey
   * applies it there unconditionally — the flag exists for callers that already
   * know the gold form omits the article.
   */
  stripLeadingArticle?: boolean;
}

export interface AnswerCluster {
  representative: string;
  members: string[];
  size: number;
}

/**
 * Minimum normalized edit similarity for two entity strings to be treated as
 * one. Calibrated against the tightest confusable pair we know: Colombia vs
 * Columbia is one edit in eight characters (0.875) and they are different
 * entities, so the bar sits just above it. Genuine one-character slips in names
 * of nine characters or more (Barak/Barack Obama = 0.917) still clear it. A
 * lower bar would merge Colombia into Columbia; a false merge is worse than a
 * missed one, because it hands the vote to a form that scores zero.
 */
export const ENTITY_SIMILARITY_THRESHOLD = 0.88;

const ZERO_WIDTH = /[\u200B-\u200D\u2060\uFEFF]/g;
const UNICODE_SPACE = /[\u00A0\u1680\u2000-\u200A\u202F\u205F\u3000]/g;
const SINGLE_QUOTE = /[‘’‚‛′]/g;
const DOUBLE_QUOTE = /[“”„‟″]/g;
const DASH = /[‐-―−]/g;
const LIST_MARKER = /^(?:[-•·]|\d{1,3}[.)])\s+/;
const STRAY_EDGE = /^[*_`~"'\s]+|[*_`~"'\s]+$/g;
const LEADING_ARTICLE = /^(?:the|an|a)\s+/i;
const TRAILING_PUNCTUATION = new Set([".", ",", ";", ":", "!", "?"]);

const WRAPPERS = new Map([
  ['"', '"'],
  ["'", "'"],
  ["(", ")"],
  ["[", "]"],
  ["{", "}"],
  ["<", ">"],
  ["«", "»"],
  ["‹", "›"]
]);

/** Words whose trailing period is part of the abbreviation, not the sentence. */
const ABBREVIATIONS = new Set([
  "inc", "ltd", "co", "corp", "plc", "llc", "gmbh", "jr", "sr", "st", "mt",
  "dr", "mr", "mrs", "ms", "prof", "gov", "sen", "rep", "no", "vs", "etc", "dept"
]);

/** Legal and organizational suffixes that add no identity of their own. */
const DESIGNATORS = new Set([
  "inc", "incorporated", "ltd", "limited", "llc", "plc", "co", "corp",
  "corporation", "company", "group", "holdings", "gmbh", "ag", "sa", "nv",
  "ab", "oyj", "spa", "fc", "cf", "sc", "afc", "cfc"
]);

/** Function words that carry no identity, so they must not fill a token slot. */
const STOPWORDS = new Set([
  "the", "a", "an", "of", "and", "for", "de", "del", "della", "di", "da",
  "du", "la", "le", "el", "los", "las", "van", "von", "der", "den", "bin"
]);

function stripEmphasis(value: string): string {
  return value
    .replace(/\*\*\*([\s\S]+?)\*\*\*/g, "$1")
    .replace(/\*\*([\s\S]+?)\*\*/g, "$1")
    .replace(/\*([^*]+)\*/g, "$1")
    .replace(/__([\s\S]+?)__/g, "$1")
    .replace(/`([^`]*)`/g, "$1");
}

function stripWrappers(value: string): string {
  const opener = value[0];
  const closer = value[value.length - 1];
  if (value.length < 2 || opener === undefined || closer === undefined) return value;
  return WRAPPERS.get(opener) === closer ? value.slice(1, -1) : value;
}

/**
 * "Real Madrid." is a sentence; "U.S." and "Apple Inc." are not. Keep the
 * period when the final word is a dotted initialism or a known abbreviation.
 */
function endsWithAbbreviation(value: string): boolean {
  const finalWord = value.split(/\s+/).pop() ?? "";
  if (/^(?:\p{L}\.)+$/u.test(finalWord)) return true;
  return ABBREVIATIONS.has(finalWord.replace(/\.+$/, "").toLocaleLowerCase());
}

function stripTrailingPunctuation(value: string): string {
  let result = value;
  while (result.length > 0) {
    const last = result[result.length - 1] ?? "";
    if (!TRAILING_PUNCTUATION.has(last)) break;
    if (last === "." && endsWithAbbreviation(result)) break;
    result = result.slice(0, -1).trimEnd();
  }
  return result;
}

/**
 * Normalize an entity string toward the form an official source would print.
 * Removes decoration only — casing and diacritics survive, because the grader
 * lowercases anyway and a person reads this string in the report.
 */
export function canonicalizeEntity(value: string, options: CanonicalizeOptions = {}): string {
  let result = value
    .normalize("NFC")
    .replace(ZERO_WIDTH, "")
    .replace(UNICODE_SPACE, " ")
    .replace(SINGLE_QUOTE, "'")
    .replace(DOUBLE_QUOTE, '"')
    .replace(DASH, "-");
  result = stripEmphasis(result).replace(/\s+/g, " ").trim();
  // Decoration nests ("**[Real Madrid]**"), so peel until the string settles.
  for (let pass = 0; pass < 8; pass++) {
    const before = result;
    result = stripTrailingPunctuation(stripWrappers(result.replace(LIST_MARKER, "")).replace(STRAY_EDGE, ""));
    if (result === before) break;
  }
  if (options.stripLeadingArticle === true) {
    const withoutArticle = result.replace(LEADING_ARTICLE, "");
    if (withoutArticle.length > 0) result = withoutArticle;
  }
  return result;
}

/**
 * The comparison key: everything the grader ignores, plus the differences that
 * never separate two real entities — articles, diacritics, punctuation, case.
 * Never emitted; only used to decide whether two answers are one answer.
 */
/**
 * Exactly the grader's own normalization: trim, lowercase, collapse whitespace —
 * and nothing else. Deliberately NOT entityFoldKey, which additionally strips
 * articles and punctuation to decide cluster MEMBERSHIP. Two spellings the
 * grader treats as one answer must share support; two it treats as different
 * answers must not, even when they belong in the same cluster. Mixing the two
 * keys makes "The Fed" and "Fed" pool their votes and then emits whichever
 * happened to be written most often, which is not the grader's mode.
 */
export function graderFoldKey(value: string): string {
  return value.trim().toLocaleLowerCase().replace(/\s+/g, " ");
}

export function entityFoldKey(value: string): string {
  return canonicalizeEntity(value, { stripLeadingArticle: true })
    .normalize("NFD")
    .replace(/\p{M}+/gu, "")
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let row = 0; row < a.length; row++) {
    const current = [row + 1];
    for (let column = 0; column < b.length; column++) {
      const substitution = (previous[column] ?? 0) + (a[row] === b[column] ? 0 : 1);
      current.push(Math.min(substitution, (current[column] ?? 0) + 1, (previous[column + 1] ?? 0) + 1));
    }
    previous = current;
  }
  return previous[b.length] ?? 0;
}

/** Normalized edit similarity in [0,1] over the fold keys. */
export function entitySimilarity(a: string, b: string): number {
  const left = entityFoldKey(a);
  const right = entityFoldKey(b);
  if (left.length === 0 || right.length === 0) return 0;
  const longest = Math.max(left.length, right.length);
  return 1 - editDistance(left, right) / longest;
}

function contentTokens(key: string): string[] {
  return key.split(" ").filter((token) => token.length > 0 && !STOPWORDS.has(token));
}

/**
 * A shorter name inside a longer one is the same entity only when the shorter
 * one is already specific. "Real Madrid" ⊂ "Real Madrid CF" is safe; a single
 * token is not — "Manchester" is City as easily as United. The exception is a
 * bare legal suffix, which adds no identity: Apple ≡ Apple Inc.
 */
function isQualifiedSubset(smaller: readonly string[], larger: readonly string[]): boolean {
  if (smaller.length === 0 || smaller.length >= larger.length) return false;
  if (!smaller.every((token) => larger.includes(token))) return false;
  if (smaller.length >= 2) return true;
  return larger.filter((token) => !smaller.includes(token)).every((token) => DESIGNATORS.has(token));
}

/** True when two answers name the same entity. Blank answers name nothing. */
export function sameEntity(a: string, b: string): boolean {
  const left = entityFoldKey(a);
  const right = entityFoldKey(b);
  if (left.length === 0 || right.length === 0) return false;
  if (left === right) return true;
  // "Space X" and "SpaceX" differ only in where the writer put the gap.
  if (left.replace(/ /g, "") === right.replace(/ /g, "")) return true;
  const leftTokens = contentTokens(left);
  const rightTokens = contentTokens(right);
  if (isQualifiedSubset(leftTokens, rightTokens) || isQualifiedSubset(rightTokens, leftTokens)) return true;
  return entitySimilarity(a, b) >= ENTITY_SIMILARITY_THRESHOLD;
}

interface Surface {
  readonly value: string;
  readonly indices: number[];
}

function combiningMarkCount(value: string): number {
  return (value.normalize("NFD").match(/\p{M}/gu) ?? []).length;
}

/** Mixed case reads as a printed name; all caps at least reads as an acronym. */
function casingRank(value: string): number {
  const hasUpper = /\p{Lu}/u.test(value);
  const hasLower = /\p{Ll}/u.test(value);
  if (hasUpper && hasLower) return 2;
  return hasUpper ? 1 : 0;
}

/**
 * Which spelling represents the cluster, in order:
 *   1. most trials wrote it — the mode is the best evidence of the printed form
 *   2. better casing — free to prefer, since the grader lowercases anyway
 *   3. more diacritics — accents get dropped by lossy pipelines, never invented
 *   4. first written — stable and deterministic, and unlike localeCompare it
 *      does not systematically hand ties to whatever starts nearest to "A"
 */
function preferSurface(a: Surface, b: Surface): Surface {
  if (a.indices.length !== b.indices.length) return a.indices.length > b.indices.length ? a : b;
  const casingA = casingRank(a.value);
  const casingB = casingRank(b.value);
  if (casingA !== casingB) return casingA > casingB ? a : b;
  const marksA = combiningMarkCount(a.value);
  const marksB = combiningMarkCount(b.value);
  if (marksA !== marksB) return marksA > marksB ? a : b;
  return (a.indices[0] ?? 0) <= (b.indices[0] ?? 0) ? a : b;
}

function collectSurfaces(answers: readonly string[]): Surface[] {
  const surfaces = new Map<string, Surface>();
  answers.forEach((answer, index) => {
    const value = canonicalizeEntity(answer);
    if (value.length === 0) return;
    const existing = surfaces.get(value);
    if (existing) existing.indices.push(index);
    else surfaces.set(value, { value, indices: [index] });
  });
  return [...surfaces.values()].sort(
    (a, b) => b.indices.length - a.indices.length || (a.indices[0] ?? 0) - (b.indices[0] ?? 0)
  );
}

/**
 * Group answers that name one entity so a vote counts them together. Clusters
 * are returned largest first; ties keep the earliest-written cluster in front.
 *
 * Membership is tested against the cluster SEED only, never against arbitrary
 * members: single-linkage would chain A~B and B~C into one cluster even when A
 * and C are rivals. Seeds are taken in order of support, so the best-attested
 * spelling anchors each group.
 */
export function clusterAnswers(answers: readonly string[]): AnswerCluster[] {
  const clusters: Surface[][] = [];
  for (const surface of collectSurfaces(answers)) {
    const home = clusters.find((members) => {
      const seed = members[0];
      return seed !== undefined && sameEntity(seed.value, surface.value);
    });
    if (home) home.push(surface);
    else clusters.push([surface]);
  }
  return clusters
    .map((members) => {
      const occurrences = members
        .flatMap((surface) => surface.indices.map((index) => ({ index, value: surface.value })))
        .sort((a, b) => a.index - b.index);
      // Count support the way the GRADER counts it. It folds case (and the rest
      // of entityFoldKey) before comparing, so "The Fed" / "the fed" / "THE FED"
      // are one answer to it. Counting case-preserving surfaces instead splits
      // that vote three ways and can hand the cluster to a spelling with
      // strictly less real support.
      const supportByFold = new Map<string, number>();
      for (const surface of members) {
        const key = graderFoldKey(surface.value);
        supportByFold.set(key, (supportByFold.get(key) ?? 0) + surface.indices.length);
      }
      const ranked = [...supportByFold.entries()].sort((a, b) => b[1] - a[1]);
      const [bestFold, bestSupport] = ranked[0] ?? ["", 0];
      // Only let the grader-class narrow the field when it STRICTLY wins. On a
      // tie every class is equally attested, so fall through to preferSurface,
      // whose own tie-breaks (casing, then accents) still apply — accents are
      // dropped by lossy pipelines and never invented, so the accented spelling
      // is the better guess at the printed form.
      const decisive = ranked.length > 1 && bestSupport > (ranked[1]?.[1] ?? 0);
      const winning = decisive ? members.filter((surface) => graderFoldKey(surface.value) === bestFold) : members;
      const representative = (winning.length > 0 ? winning : members).reduce(preferSurface);
      return {
        representative: representative.value,
        members: occurrences.map((occurrence) => occurrence.value),
        size: occurrences.length,
        firstIndex: occurrences[0]?.index ?? 0
      };
    })
    .sort((a, b) => b.size - a.size || a.firstIndex - b.firstIndex)
    .map(({ representative, members, size }) => ({ representative, members, size }));
}
