/**
 * Query parsing and sanitization for staan_search.
 *
 * Parses dork-style domain filters (site:domain, -domain.tld),
 * sanitizes the cleaned query, and normalizes pagination offsets.
 *
 * Pure functions — no framework or API dependencies.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface DorkResult {
  query: string;
  includeDomains: string[];
  excludeDomains: string[];
}

// ---------------------------------------------------------------------------
// Dork extraction
// ---------------------------------------------------------------------------

/**
 * Extract dork-style domain filters from a search query.
 *
 * Supports:
 *   - `site:domain`   — restrict to a single domain
 *   - `-site:domain`  — exclude a domain (parsed before bare `-domain`)
 *   - `-domain.tld`   — bare domain exclusion
 *
 * Returns the cleaned query with dorks stripped, plus the parsed domain lists.
 */
export function extractDorks(query: string): DorkResult {
  const includeDomains: string[] = [];
  const excludeDomains: string[] = [];

  // Domain label: alphanumeric (Unicode \p{L} / \p{N}) with optional hyphens
  const labelRe = "[\\p{L}\\p{N}](?:[\\p{L}\\p{N}-]{0,61}[\\p{L}\\p{N}])?";
  // One or more dot-separated labels followed by a TLD of 2+ letters,
  // so multi-label domains (docs.github.com) are captured whole.
  const domainRe = `(?:${labelRe}\\.)+[\\p{L}]{2,}`;

  // Extraction and removal happen in one replace() per dork form so the
  // two can never disagree about what matched.

  // 1. -site:domain (before bare -domain to avoid double-match)
  let cleaned = query.replace(
    new RegExp(`(?:^|\\s)-site:(${domainRe})`, "giu"),
    (_match, domain: string) => {
      excludeDomains.push(domain.toLowerCase());
      return " ";
    },
  );

  // 2. site:domain (positive)
  cleaned = cleaned.replace(
    new RegExp(`(?<!-)\\bsite:(${domainRe})`, "giu"),
    (_match, domain: string) => {
      includeDomains.push(domain.toLowerCase());
      return " ";
    },
  );

  // 3. -domain.tld (bare exclusion); the lookahead stops the match from
  // ending inside a longer domain while still allowing sentence punctuation.
  cleaned = cleaned.replace(
    new RegExp(`(?:^|\\s)-(${domainRe})(?!\\.?[\\p{L}\\p{N}])`, "giu"),
    (_match, domain: string) => {
      excludeDomains.push(domain.toLowerCase());
      return " ";
    },
  );

  cleaned = cleaned.replace(/\s{2,}/g, " ").trim();

  return {
    query: cleaned,
    includeDomains: Array.from(new Set(includeDomains)),
    excludeDomains: Array.from(new Set(excludeDomains)),
  };
}

// ---------------------------------------------------------------------------
// Query sanitization
// ---------------------------------------------------------------------------

/**
 * Sanitize a search query: trim, enforce non-empty, truncate to API limit.
 * Appends notes to the provided array when the query is modified.
 */
export function sanitizeQuery(query: string, notes: string[]): string {
  let s = (query ?? "").toString().trim();
  if (!s) {
    throw new Error("Search query cannot be empty.");
  }
  if (s.length > 400) {
    s = s.slice(0, 400);
    notes.push("Query truncated to 400 characters (API limit)");
  }
  return s;
}

// ---------------------------------------------------------------------------
// Offset normalization
// ---------------------------------------------------------------------------

/**
 * Normalize a pagination offset to the allowed values [0, 10, 20, 30].
 * Rounds to the nearest 10 and clamps. Returns undefined for invalid input.
 * Appends a note when the offset is coerced.
 */
export function normalizeOffset(
  offset: number | undefined,
  notes: string[],
): number | undefined {
  if (offset === undefined || Number.isNaN(offset)) return undefined;
  const snapped = Math.min(30, Math.max(0, Math.round(offset / 10) * 10));
  if (snapped !== offset)
    notes.push(`Offset coerced to ${snapped} (allowed: 0,10,20,30)`);
  return snapped;
}

// ---------------------------------------------------------------------------
// Utility
// ---------------------------------------------------------------------------

/** Clamp a number to [min, max]. */
export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
