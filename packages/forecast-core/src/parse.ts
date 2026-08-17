// Tolerant extraction of a model's structured answer from free-form output.
//
// The scoring rule that motivates this: a missing answer scores 0 and a wrong
// answer is not penalised, so a trial that throws is strictly worse than a
// trial that yields a rough guess. The previous inline extractor took the slice
// between the first "{" and the last "}" and called JSON.parse on it unguarded,
// so any prose containing a stray brace threw and deleted the trial. Enough
// deleted trials and the task produces no submission row at all.
//
// Order of attempts, most to least trustworthy:
//   1. an explicit <answer>...</answer> block
//   2. a fenced ```json code block
//   3. the first BALANCED JSON value anywhere in the text
//   4. the raw trimmed text (a bare scalar or entity name)
// Callers then apply per-kind salvage for what is still unparseable.

const ANSWER_TAG = /<answer>([\s\S]*?)<\/answer>/i;
const FENCED = /```(?:json|JSON)?\s*([\s\S]*?)```/;

export function extractAnswerBlock(content: string): string {
  const tagged = content.match(ANSWER_TAG)?.[1];
  if (tagged?.trim()) return tagged.trim();
  const fenced = content.match(FENCED)?.[1];
  if (fenced?.trim()) return fenced.trim();
  return content.trim();
}

/**
 * Find the first balanced JSON object or array, tracking string and escape
 * state so braces inside string literals do not end the scan. Returns the
 * parsed value, or null when nothing balanced parses — never throws.
 */
export function scanBalancedJson(text: string): unknown | null {
  for (let index = 0; index < text.length; index++) {
    const opener = text[index];
    if (opener !== "{" && opener !== "[") continue;
    const closer = opener === "{" ? "}" : "]";
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let cursor = index; cursor < text.length; cursor++) {
      const character = text[cursor];
      if (inString) {
        if (escaped) escaped = false;
        else if (character === "\\") escaped = true;
        else if (character === '"') inString = false;
        continue;
      }
      if (character === '"') inString = true;
      else if (character === opener) depth++;
      else if (character === closer) {
        depth--;
        if (depth === 0) {
          try {
            return JSON.parse(text.slice(index, cursor + 1));
          } catch {
            break; // Not valid JSON; resume scanning after this opener.
          }
        }
      }
    }
  }
  return null;
}

/** Never throws. Returns the raw trimmed string when no JSON is recoverable. */
export function extractJsonLenient(content: string): unknown {
  const block = extractAnswerBlock(content);
  const scanned = scanBalancedJson(block);
  if (scanned !== null) return scanned;
  // The answer block may be prose while a JSON object sits elsewhere.
  const whole = scanBalancedJson(content);
  return whole !== null ? whole : block;
}

const PERCENT_NUMBER = /(-?\d+(?:\.\d+)?)\s*%/;
const PLAIN_NUMBER = /-?\d+(?:\.\d+)?/;

/**
 * Last-resort probability recovery from prose, e.g. "roughly 85% likely" or
 * "probability: 0.85". Percentages convert; bare values in [0,1] pass through.
 * Returns null rather than guessing when nothing looks like a probability.
 */
export function salvageProbability(text: string): number | null {
  const labelled = text.match(/probability[^0-9-]{0,20}(-?\d+(?:\.\d+)?)\s*(%?)/i);
  if (labelled) {
    const value = Number(labelled[1]);
    const scaled = labelled[2] === "%" ? value / 100 : value;
    if (Number.isFinite(scaled) && scaled >= 0 && scaled <= 1) return scaled;
  }
  const percent = text.match(PERCENT_NUMBER);
  if (percent) {
    const value = Number(percent[1]) / 100;
    if (Number.isFinite(value) && value >= 0 && value <= 1) return value;
  }
  const plain = text.match(PLAIN_NUMBER);
  if (plain) {
    const value = Number(plain[0]);
    if (Number.isFinite(value) && value >= 0 && value <= 1) return value;
  }
  return null;
}

/**
 * Recover a numeric quantity from prose. Unlike salvageProbability this keeps
 * the natural scale: a percentage stays as its point value, because FutureX
 * gold for "what exact CPI rate" is 2.7, not 0.027.
 */
export function salvageNumber(text: string): number | null {
  const cleaned = text.replace(/(\d),(\d{3})/g, "$1$2");
  const match = cleaned.match(PLAIN_NUMBER);
  if (!match) return null;
  const value = Number(match[0]);
  return Number.isFinite(value) ? value : null;
}

/**
 * Recover a choice from prose by looking for an explicit key mention, then any
 * whole-word occurrence of a choice label. Case-insensitive; returns the
 * caller's original casing.
 */
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Last whole-word occurrence, or -1. Substring matching would find the choice
 *  "No" inside "nothing", "cannot" and "know". */
function lastWholeWordIndex(haystack: string, needle: string): number {
  const pattern = new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegExp(needle)}(?![\\p{L}\\p{N}])`, "giu");
  let last = -1;
  for (const match of haystack.matchAll(pattern)) last = match.index ?? last;
  return last;
}

export function salvageChoice(text: string, choices: readonly string[]): string | null {
  const boxed = text.match(/\\boxed\{([^}]*)\}/)?.[1]?.trim().toLowerCase();
  if (boxed) {
    const exact = choices.find((choice) => choice.toLowerCase() === boxed);
    if (exact) return exact;
  }
  // Prefer the choice mentioned last: prose usually states the conclusion at
  // the end, after weighing the alternatives.
  let best: { choice: string; at: number } | null = null;
  for (const choice of choices) {
    const at = lastWholeWordIndex(text, choice);
    if (at < 0) continue;
    if (!best || at > best.at) best = { choice, at };
  }
  return best?.choice ?? null;
}
