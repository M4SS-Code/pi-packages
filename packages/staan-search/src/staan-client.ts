/**
 * Staan.ai API client — types, request builder, and fetch wrapper.
 *
 * Handles HTTP communication with the Staan API. Pure I/O — no tool schema
 * or query parsing logic lives here.
 */

import { USER_AGENT, readBodyBounded, timeoutSignal } from "./utils";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const DEFAULT_FETCH_TIMEOUT_MS = 10_000;

/** Max bytes of an error response body to read for diagnostics. */
const MAX_ERROR_BODY_BYTES = 16 * 1024;

/**
 * Max bytes of a success response body. full_content requests carry whole
 * page bodies, so the ceiling is generous — but a hostile or broken server
 * must never be buffered without bound.
 */
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;

export const SUPPORTED_MARKETS = [
  "fr-fr",
  "de-de",
  "en-us",
  "en-gb",
  "en-fr",
  "en-ca",
  "en-au",
  "en-in",
  "en-ie",
  "en-nz",
  "en-za",
  "en-sg",
] as const;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type Market = (typeof SUPPORTED_MARKETS)[number];
export type SearchEndpoint = "web" | "news";

/** Request payload sent to the Staan API. */
export interface StaanRequest {
  q: string;
  market: Market;
  offset?: number;
  include_domains?: string[];
  exclude_domains?: string[];
  extra_snippets?: boolean;
  min_score?: number;
  max_snippets?: number;
  full_content?: "markdown" | "html";
}

/** A single search result from the Staan API. */
export interface StaanResult {
  title: string;
  url: string;
  snippet: string;
  display_url?: string;
  hostname?: string;
  favicon_url?: string;
  extra_snippets?: Array<{ chunk: string; score: number }>;
  published_date?: string;
}

/** Full API response envelope. */
export interface StaanResponse {
  search_id: string;
  query: {
    q: string;
    altered_query?: string;
    market: string;
    count: number;
    offset: number;
  };
  web?: { results: StaanResult[] };
  news?: { results: StaanResult[] };
}

// ---------------------------------------------------------------------------
// Search function
// ---------------------------------------------------------------------------

export interface SearchStaanOptions {
  endpoint: SearchEndpoint;
  request: StaanRequest;
  apiKey: string;
  signal?: AbortSignal;
}

/**
 * Fetch search results from the Staan API.
 *
 * Handles timeout, abort signal forwarding, and error classification. The
 * timeout is fixed: the tool always talks to the same API, so there is no
 * per-call knowledge that could justify a different value.
 */
export async function searchStaan({
  endpoint,
  request,
  apiKey,
  signal,
}: SearchStaanOptions): Promise<StaanResponse> {
  // The whole exchange — including body reads — stays inside the timeout
  // scope: a server that sends headers and then stalls the body would
  // otherwise hang with no timeout and no way to abort.
  const timeout = timeoutSignal(signal, DEFAULT_FETCH_TIMEOUT_MS);
  try {
    let response: Response;
    try {
      response = await fetch(`https://api.staan.ai/v2/search/${endpoint}`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
          "User-Agent": USER_AGENT,
        },
        body: JSON.stringify(request),
        signal: timeout.signal,
      });
    } catch (e: unknown) {
      const msg =
        e instanceof Error ? e.message : typeof e === "string" ? e : String(e);
      throw new Error(
        `Staan ${endpoint} search fetch failed (market=${request.market}): ${msg}`,
      );
    }

    if (!response.ok) {
      const errText = await readBodyBounded(response, MAX_ERROR_BODY_BYTES)
        .then((body) => (body.truncated ? `${body.text}…` : body.text))
        .catch(() => "");
      let hint = "";
      if (
        response.status === 400 &&
        errText.includes("domain filters are not supported")
      ) {
        hint =
          '\nHint: fallback routing rejected domain filters. Prefer market="fr-fr" or retry without site:/-domain dorks.';
      }
      throw new Error(
        `Staan API error (${response.status}) for market=${request.market}, endpoint=${endpoint}: ${errText}${hint}`,
      );
    }

    const body = await readBodyBounded(response, MAX_RESPONSE_BYTES);
    if (body.truncated) {
      throw new Error(
        `Staan ${endpoint} response exceeded ${MAX_RESPONSE_BYTES} bytes — refusing to parse a truncated body`,
      );
    }
    try {
      return JSON.parse(body.text) as StaanResponse;
    } catch {
      throw new Error(
        `Staan ${endpoint} search returned invalid JSON (market=${request.market})`,
      );
    }
  } catch (e: unknown) {
    if (timeout.timedOut) {
      throw new Error(
        `Staan ${endpoint} search timed out after ${DEFAULT_FETCH_TIMEOUT_MS}ms (market=${request.market})`,
      );
    }
    throw e;
  } finally {
    timeout.cleanup();
  }
}
