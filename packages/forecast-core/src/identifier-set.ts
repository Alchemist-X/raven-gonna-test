/** Exact identifiers must never pass through fuzzy entity matching. */
export function canonicalIdentifierSet(input: unknown, pattern?: string): string {
  if (!Array.isArray(input) || input.some((value) => typeof value !== "string")) {
    throw new Error("Identifier-set answer must be an array of strings.");
  }
  const matcher = pattern ? new RegExp(pattern) : /^[A-Za-z0-9_-]+$/;
  const values = input.map((value: string) => value.trim());
  if (values.some((value) => !value || !matcher.test(value))) throw new Error("Invalid identifier in set answer.");
  return values.length === 0 ? "[]" : [...new Set(values)].sort().join(", ");
}

export function normalizeIdentifierSet(value: string, pattern?: string): string {
  return canonicalIdentifierSet(value.trim() === "[]" ? [] : value.split(",").map((item) => item.trim()), pattern);
}
