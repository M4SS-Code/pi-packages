/**
 * Cache layer for llms.txt content.
 *
 * File-based cache at <agentDir>/llms-txt-cache/<domain>.json.
 * TTL: 24h for successful fetches, 7d for misses (404/410 or HTML pages).
 *
 * Each entry: { content: string, status: number, fetchedAt: number }
 */

import { existsSync, readFileSync, readdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { atomicFileWrite } from "./utils";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CacheEntry {
  content: string;
  status: number;
  fetchedAt: number;
  /** True when the server answered but did not serve llms.txt (e.g. an HTML page). */
  miss?: boolean;
  /** True when `content` was cut at the download byte cap (the file is longer). */
  truncated?: boolean;
}

interface CacheResult extends CacheEntry {
  hit: boolean;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const CACHE_DIR_NAME = "llms-txt-cache";
const HIT_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
const MISS_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

/**
 * HTTP statuses that mean "this domain does not publish llms.txt":
 * 404 Not Found and 410 Gone (a deliberate, permanent removal — an even
 * stronger absence signal). Deliberately narrow: other 4xx like 403 are
 * usually bot-blocking, not absence, and must not be cached as misses.
 */
export function isMissStatus(status: number): boolean {
  return status === 404 || status === 410;
}

// ---------------------------------------------------------------------------
// Domain extraction
// ---------------------------------------------------------------------------

const DOMAIN_LABEL_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/** Rejects IPs, IPv6 literals, localhost, and single-label names. */
function isValidDomain(s: string): boolean {
  const labels = s.split(".");
  const tld = labels.at(-1);
  return (
    s.length <= 253 &&
    !s.includes(":") &&
    s !== "localhost" &&
    !s.endsWith(".localhost") &&
    labels.length >= 2 &&
    tld !== undefined &&
    /[a-z]/.test(tld) &&
    labels.every((label) => DOMAIN_LABEL_RE.test(label))
  );
}

/**
 * Extract and validate a domain from a URL or bare domain string.
 *
 * Bare domains are parsed through the URL parser too, so both forms get the
 * same handling: IDN is punycoded, paths are stripped, and an explicit port
 * is rejected (llms.txt is always fetched from https://<domain>/llms.txt).
 *
 * Only public domain names are accepted — IP addresses, IPv6 literals,
 * localhost, and single-label names are rejected to prevent SSRF.
 *
 * @throws Error if the input does not resolve to a valid domain.
 */
export function extractDomain(input: string): string {
  const trimmed = input.trim();
  const withScheme = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(trimmed)
    ? trimmed
    : `https://${trimmed}`;
  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    throw new Error(`Invalid domain or URL: "${input}"`);
  }
  if (url.port !== "") {
    throw new Error(
      `Ports are not supported: "${input}" — llms.txt is always fetched from https://<domain>/llms.txt`,
    );
  }
  return validateDomain(url.hostname.toLowerCase());
}

function validateDomain(domain: string): string {
  if (!isValidDomain(domain)) {
    throw new Error(
      `Invalid domain: "${domain}". Only public domain names are allowed (not IP addresses or localhost).`,
    );
  }
  return domain;
}

// ---------------------------------------------------------------------------
// Cache paths
// ---------------------------------------------------------------------------

export function cacheDir(): string {
  return join(getAgentDir(), CACHE_DIR_NAME);
}

export function cacheKey(domain: string): string {
  return join(cacheDir(), `${domain}.json`);
}

// ---------------------------------------------------------------------------
// Cache read
// ---------------------------------------------------------------------------

export function readCache(domain: string): CacheResult | null {
  const path = cacheKey(domain);
  if (!existsSync(path)) return null;

  try {
    const entry = JSON.parse(readFileSync(path, "utf8")) as CacheEntry;
    const isMiss = isMissStatus(entry.status) || entry.miss === true;
    const ttl = isMiss ? MISS_TTL_MS : HIT_TTL_MS;
    if (Date.now() - entry.fetchedAt >= ttl) {
      // Expired — delete stale cache file
      unlinkSync(path);
      return null;
    }
    return { ...entry, hit: true };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Cache write
// ---------------------------------------------------------------------------

/** Write a cache entry atomically. */
export function writeCache(domain: string, entry: CacheEntry): void {
  atomicFileWrite(cacheKey(domain), JSON.stringify(entry, null, 2) + "\n");
}

// ---------------------------------------------------------------------------
// Cache clear
// ---------------------------------------------------------------------------

export function clearCache(): { cleared: number } {
  const dir = cacheDir();
  if (!existsSync(dir)) return { cleared: 0 };

  try {
    const files = readdirSync(dir).filter((f: string) => f.endsWith(".json"));
    let count = 0;
    for (const file of files) {
      try {
        unlinkSync(join(dir, file));
        count++;
      } catch {
        /* ignore */
      }
    }
    return { cleared: count };
  } catch {
    return { cleared: 0 };
  }
}

// ---------------------------------------------------------------------------
// Cache list
// ---------------------------------------------------------------------------

export interface CacheListEntry {
  domain: string;
  status: number;
  ageHours: number;
  miss: boolean;
}

export function listCache(): CacheListEntry[] {
  const dir = cacheDir();
  if (!existsSync(dir)) return [];

  try {
    const files = readdirSync(dir).filter((f: string) => f.endsWith(".json"));
    const results: CacheListEntry[] = [];
    const now = Date.now();
    for (const file of files) {
      try {
        const entry = JSON.parse(
          readFileSync(join(dir, file), "utf8"),
        ) as CacheEntry;
        const domain = file.slice(0, -".json".length);
        results.push({
          domain,
          status: entry.status,
          ageHours: Math.round((now - entry.fetchedAt) / (60 * 60 * 1000)),
          miss: entry.miss === true,
        });
      } catch {
        /* skip corrupt entries */
      }
    }
    return results.sort((a, b) => b.ageHours - a.ageHours);
  } catch {
    return [];
  }
}
