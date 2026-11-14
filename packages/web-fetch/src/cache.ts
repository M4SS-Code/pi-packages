/**
 * In-memory cache of recent web_fetch results.
 *
 * Paging through a long page with `offset` would otherwise download and
 * convert it again for every part. The cache is small and lives only in
 * memory: it only has to outlast the other fetches a model makes while
 * reading a document to the end.
 */

import type { FetchUrlResult } from "./fetch";

/** How many documents are kept before the least recently used is dropped. */
export const RECENT_FETCH_LIMIT = 16;

export interface RecentFetch {
  result: FetchUrlResult;
  /** Where the full output was written, once a truncated page needed it. */
  fullPath?: string;
}

export function createRecentFetches(limit = RECENT_FETCH_LIMIT) {
  // Map iterates in insertion order, so the first key is the least recently
  // used as long as every use re-inserts its entry.
  const entries = new Map<string, RecentFetch>();

  /**
   * The fetch that the part starting at line `offset` is cut from. A later
   * part (offset > 1) of a remembered document comes from memory; a first
   * part, or a part of a document that is not remembered, is fetched with
   * `fetchFresh`. Either way the document becomes the most recently used.
   */
  async function load(
    url: string,
    format: string,
    offset: number,
    fetchFresh: () => Promise<FetchUrlResult>,
  ): Promise<RecentFetch> {
    // The same URL gives different output in each format
    const key = `${format} ${url}`;
    let recent = offset > 1 ? entries.get(key) : undefined;
    recent ??= { result: await fetchFresh() };

    entries.delete(key);
    entries.set(key, recent);
    while (entries.size > limit) {
      const oldest = entries.keys().next().value;
      if (oldest === undefined) break;
      entries.delete(oldest);
    }
    return recent;
  }

  return { load };
}
