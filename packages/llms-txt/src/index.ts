/**
 * @m4ss/pi-llms-txt
 *
 * Registers a `llms_txt` tool that fetches and caches llms.txt from any domain.
 *
 * llms.txt is a curated, LLM-friendly map of a site's most important content.
 * Fetching it first saves tokens and avoids crawling noisy HTML pages.
 *
 * Powered by a file-based cache: 24h TTL for hits, 7d for misses (404/410 or HTML pages).
 */

import { Text } from "@earendil-works/pi-tui";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  DEFAULT_MAX_LINES,
  formatSize,
  keyHint,
  truncateHead,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
  type CacheEntry,
  extractDomain,
  isMissStatus,
  readCache,
  writeCache,
  clearCache,
  listCache,
  cacheDir,
  cacheKey,
} from "./cache";
import {
  USER_AGENT,
  DEFAULT_FETCH_TIMEOUT_MS,
  MAX_CONTENT_BYTES,
  looksLikeHtml,
  readBodyBounded,
  timeoutSignal,
} from "./utils";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface LlmsTxtDetails {
  hit: boolean;
  status: number;
  /** The displayed content was cut by the line/byte display limits. */
  truncated: boolean;
  /** The domain responded but does not serve llms.txt (404/410 or an HTML page). */
  miss: boolean;
  /** The content was cut at the download byte cap (and cached that way). */
  downloadTruncated: boolean;
}

// ---------------------------------------------------------------------------
// Presentation
// ---------------------------------------------------------------------------

/**
 * Truncate content for display and append notes after truncation so they can
 * never be cut off: a pointer to the cached file when the display limits cut
 * the output, and an incompleteness note when the download cap was hit.
 */
function presentContent(
  content: string,
  downloadTruncated: boolean,
  cachePath: string,
): { text: string; displayTruncated: boolean } {
  const truncation = truncateHead(content);
  const notes: string[] = [];
  if (truncation.truncated) {
    notes.push(
      `[Output truncated: showing ${truncation.outputLines} of ${truncation.totalLines} lines; full content cached at ${cachePath}]`,
    );
  }
  if (downloadTruncated) {
    notes.push(
      `[Note: llms.txt exceeds the ${formatSize(MAX_CONTENT_BYTES)} download cap; content is incomplete.]`,
    );
  }
  const text = notes.length
    ? `${truncation.content}\n\n${notes.join("\n")}`
    : truncation.content;
  return { text, displayTruncated: truncation.truncated };
}

// ---------------------------------------------------------------------------
// Tool parameters
// ---------------------------------------------------------------------------

const LlmsTxtParams = Type.Object({
  domain: Type.String({
    description: "Domain to query (e.g. 'docs.github.com', 'vuejs.org')",
  }),
  forceRefresh: Type.Optional(
    Type.Boolean({
      description: "Bypass cache and re-fetch. Default: false",
    }),
  ),
});

// ---------------------------------------------------------------------------
// Extension entry
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
  // ---------------------------------------------------------------------------
  // Tool registration
  // ---------------------------------------------------------------------------

  pi.registerTool({
    name: "llms_txt",
    label: "llms.txt",
    description:
      "Fetch a domain's llms.txt — a curated map of the site's documentation. " +
      "Use before deep-fetching docs sites. Skip for blogs, news, or single-page lookups.",
    promptSnippet:
      "Fetch and cache llms.txt from any domain for LLM-friendly documentation maps",
    promptGuidelines: [
      "Use llms_txt(domain) to fetch a domain's llms.txt — a curated map of its documentation — before deep-fetching individual pages.",
      "Skip llms_txt for blogs, news, or single-page lookups; use web_fetch directly.",
      "Use llms_txt forceRefresh sparingly — only when the cached map may be stale.",
    ],
    parameters: LlmsTxtParams,

    // Execute
    async execute(_id, params, signal) {
      const { domain, forceRefresh } = params;
      const extractedDomain = extractDomain(domain);
      const details: LlmsTxtDetails = {
        hit: false,
        status: 0,
        truncated: false,
        miss: false,
        downloadTruncated: false,
      };

      if (!forceRefresh) {
        const cached = readCache(extractedDomain);
        if (cached) {
          details.hit = true;
          details.status = cached.status;
          details.miss = isMissStatus(cached.status) || cached.miss === true;
          details.downloadTruncated = cached.truncated === true;
          const presented = presentContent(
            cached.content,
            details.downloadTruncated,
            cacheKey(extractedDomain),
          );
          details.truncated = presented.displayTruncated;
          return {
            content: [{ type: "text", text: presented.text }],
            details,
          };
        }
      }

      let content = "";
      let status = 0;
      let fetchOk = false;
      let miss = false;
      let downloadTruncated = false;
      // Infrastructure failures (network, timeout, unexpected HTTP status) are
      // thrown as tool errors; only content and genuine "no llms.txt" results
      // are returned — and cached — as output.
      let failure: string | undefined;
      let redirectDomain: string | undefined; // the other www/bare variant when we followed a redirect

      const timeout = timeoutSignal(signal, DEFAULT_FETCH_TIMEOUT_MS);
      try {
        // Attempt fetch — follow a single www.↔bare redirect if needed.
        let targetUrl = `https://${extractedDomain}/llms.txt`;
        let response = await fetch(targetUrl, {
          redirect: "manual",
          signal: timeout.signal,
          headers: {
            "User-Agent": USER_AGENT,
            Accept: "text/markdown, text/plain, */*",
          },
        });

        // Handle a single redirect hop that only adds or strips "www."
        if (
          response.status === 301 ||
          response.status === 302 ||
          response.status === 307 ||
          response.status === 308
        ) {
          const location = response.headers.get("location");
          if (location) {
            try {
              // Location may be relative (e.g. "/llms.txt") — resolve against
              // the request URL so we get a fully-qualified URL to validate.
              const loc = new URL(location, targetUrl);
              // Normalize: compute both the bare form (stripping www.) and the www form
              // so that redirects work regardless of whether the user supplied
              // `example.com` or `www.example.com` as the original domain.
              const bare = extractedDomain.replace(/^www\./, "");
              const www = `www.${bare}`;
              if (
                loc.protocol === "https:" &&
                (loc.hostname === bare || loc.hostname === www) &&
                loc.pathname === "/llms.txt"
              ) {
                // Follow the redirect — it's a safe www↔bare hop.
                // Remember the other domain variant so we can cache under both.
                redirectDomain = loc.hostname;
                targetUrl = loc.toString();
                response = await fetch(targetUrl, {
                  redirect: "manual",
                  signal: timeout.signal,
                  headers: {
                    "User-Agent": USER_AGENT,
                    Accept: "text/markdown, text/plain, */*",
                  },
                });
              }
            } catch {
              /* invalid location header — treat as no redirect */
            }
          }
          // If we didn't follow (or the second fetch is still a redirect),
          // fall through to the error branch below.
        }

        status = response.status;
        fetchOk = response.ok;
        if (fetchOk) {
          const contentType = (
            response.headers.get("content-type") ?? ""
          ).toLowerCase();
          const body = await readBodyBounded(response, MAX_CONTENT_BYTES);
          // SPA catch-all routes serve index.html with a 200 for any path —
          // treat that as "no llms.txt", never as documentation content.
          if (contentType.includes("text/html") || looksLikeHtml(body.text)) {
            miss = true;
            content = `HTTP ${status} — ${response.url} returned an HTML page instead of llms.txt; this domain does not publish llms.txt`;
          } else {
            content = body.text;
            downloadTruncated = body.truncated;
          }
        } else if (isMissStatus(status)) {
          content = `HTTP ${status} — ${response.url} does not provide llms.txt`;
        } else if (status >= 300 && status < 400) {
          failure = `HTTP ${status} for ${response.url} — redirect not followed (only www↔bare redirects to /llms.txt are)`;
        } else {
          failure = `HTTP ${status} fetching ${response.url} — could not retrieve llms.txt`;
        }
      } catch (e: unknown) {
        if (timeout.timedOut) {
          failure = `Fetch timed out after ${DEFAULT_FETCH_TIMEOUT_MS}ms for https://${extractedDomain}/llms.txt`;
        } else {
          const err = e as Error;
          failure = `Error fetching https://${extractedDomain}/llms.txt: ${err.message ?? String(err)}`;
        }
        status = 0;
      } finally {
        timeout.cleanup();
      }

      if (failure !== undefined) {
        throw new Error(failure);
      }

      // Cache successes and misses (404/410) to suppress repeated
      // missing-domain lookups. When we followed a www↔bare redirect, cache
      // under both domains so the other variant is a hit next time.
      if (fetchOk || isMissStatus(status)) {
        const entry: CacheEntry = { content, status, fetchedAt: Date.now() };
        if (miss) entry.miss = true;
        if (downloadTruncated) entry.truncated = true;
        writeCache(extractedDomain, entry);
        if (redirectDomain && redirectDomain !== extractedDomain) {
          writeCache(redirectDomain, entry);
        }
      }

      details.status = status;
      details.miss = isMissStatus(status) || miss;
      details.downloadTruncated = downloadTruncated;

      const presented = presentContent(
        content,
        downloadTruncated,
        cacheKey(extractedDomain),
      );
      details.truncated = presented.displayTruncated;

      return {
        content: [{ type: "text", text: presented.text }],
        details,
      };
    },

    // Render
    renderCall(args) {
      const text = args.forceRefresh
        ? `llms_txt: ${args.domain} (force refresh)`
        : `llms_txt: ${args.domain}`;
      return new Text(text, 0, 0);
    },

    // Render result
    renderResult(result, { expanded }) {
      const textPart = result.content?.[0];
      if (!textPart || textPart.type !== "text") return new Text("", 0, 0);

      const content = textPart.text;
      const details = result.details as LlmsTxtDetails;

      const lines = content.split("\n");
      let display = content;

      if (details.truncated && !expanded) {
        const shown = Math.min(lines.length, DEFAULT_MAX_LINES);
        display = `${lines.slice(0, shown).join("\n")}\n… ${lines.length - shown} more lines (use ${keyHint("app.tools.expand", "toggle")} or run /llmstxt for details)`;
      }

      const note =
        isMissStatus(details.status) || details.miss
          ? "Note: this domain does not publish llms.txt"
          : details.downloadTruncated
            ? "Note: llms.txt exceeds the download cap; content is incomplete"
            : undefined;
      return new Text(
        `${display}${note !== undefined ? "\n\n" + note : ""}`,
        0,
        0,
      );
    },
  });

  // ---------------------------------------------------------------------------
  // Commands
  // ---------------------------------------------------------------------------

  pi.registerCommand("llmstxt", {
    description: "Show llms.txt cache entries",
    handler: async (_args, ctx) => {
      const lines = [`Cache dir: ${cacheDir()}`];
      lines.push(`TTL: 24h (hits), 7d (misses)`);

      const entries = listCache();
      if (entries.length > 0) {
        lines.push("");
        lines.push(`Cached domains (${entries.length}):`);
        for (const e of entries) {
          const statusLabel = `${e.status}${e.miss ? " miss" : ""}`;
          lines.push(`  ${e.domain}  [${statusLabel}]  ${e.ageHours}h ago`);
        }
      }

      ctx.ui.notify(lines.join("\n"), "info");
    },
  });

  pi.registerCommand("llmstxt-clear", {
    description: "Flush all cached llms.txt files",
    handler: async (_args, ctx) => {
      const { cleared } = clearCache();
      ctx.ui.notify(
        `llmstxt cache flushed — ${cleared} ${cleared === 1 ? "entry" : "entries"} removed.`,
        "info",
      );
    },
  });
}
