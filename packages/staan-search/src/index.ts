/**
 * @m4ss/pi-staan-search
 *
 * Registers a `staan_search` tool powered by the Staan.ai Web Search for AI API.
 * Supports web and news endpoints with semantic enrichment and dork-style
 * domain filtering (site:domain, -domain.tld).
 * Requires STAAN_API_KEY environment variable.
 */

import { mkdtemp, writeFile } from "node:fs/promises";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { truncateHead } from "@earendil-works/pi-coding-agent";
import type { Static } from "typebox";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  DEFAULT_FETCH_TIMEOUT_MS,
  type StaanRequest,
  SUPPORTED_MARKETS,
  searchStaan,
} from "./staan-client";
import { extractDorks, sanitizeQuery, normalizeOffset } from "./query-parser";
import { compactText } from "./utils";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface SearchDetails {
  query: string;
  market?: string;
  resultCount: number;
  endpoint: "web" | "news";
  offset?: number;
  searchId?: string;
  alteredQuery?: string;
  timeoutMs: number;
  outputTruncated: boolean;
  outputLines: number;
  truncatedBy?: string;
  resultsPath?: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// One temp directory per session; files inside are keyed by tool call id so
// repeated searches don't leave a trail of single-use mkdtemp directories.
let sessionTmpDir: Promise<string> | undefined;

function getSessionTmpDir(): Promise<string> {
  sessionTmpDir ??= mkdtemp(join(tmpdir(), "staan-search-"));
  return sessionTmpDir;
}

function safeFileId(toolCallId: string): string {
  return toolCallId.replace(/[^\w.-]/g, "_");
}

// Semantic enrichment for web results. Fixed rather than exposed as
// parameters: models rarely tune these well, and every optional knob is one
// more thing a smaller model can fill in wrongly.
const ENRICHMENT_MIN_SCORE = 0.2;
const ENRICHMENT_MAX_SNIPPETS = 5;

// ---------------------------------------------------------------------------
// Tool parameters — StringEnum per pi docs for Google API compatibility
// ---------------------------------------------------------------------------

const SearchParams = Type.Object({
  query: Type.String({ description: "Search query" }),
  market: Type.Optional(
    StringEnum(SUPPORTED_MARKETS, {
      description:
        "Language/region of the results. Default: fr-fr (French results). Match the query's language, e.g. en-us for English queries.",
    }),
  ),
  type: Type.Optional(
    StringEnum(["web", "news"] as const, {
      description: "Search type. Default: web",
    }),
  ),
  offset: Type.Optional(
    Type.Number({
      description: "Pagination offset (0, 10, 20, or 30)",
    }),
  ),
});

type SearchParamsType = Static<typeof SearchParams>;

// ---------------------------------------------------------------------------
// Extension entry — tool registration
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "staan_search",
    label: "Staan Search for AI",
    description:
      "Search the web. Returns ranked results with semantic snippets. " +
      "For known URLs, use web_fetch directly. Cite the result URLs you rely on.",
    promptSnippet: "European Search for AI with semantic enrichment",
    promptGuidelines: [
      "Prefer official docs, registries, and primary sources. Narrow results with site:domain or -domain in the query.",
      "Treat snippets as pointers, not proof: verify claims against the enriched chunks or a web_fetch before relying on them.",
      "Use search to discover unknowns or disambiguate colliding names (e.g. bare package names).",
    ],

    parameters: SearchParams,

    // ---------------------------------------------------------------------------
    // Execute
    // ---------------------------------------------------------------------------

    execute: async (toolCallId, params, signal, _onUpdate, _ctx) => {
      const { query, market = "fr-fr", type = "web", offset } = params;

      const apiKey = process.env.STAAN_API_KEY;
      if (!apiKey) {
        throw new Error("STAAN_API_KEY is not set.");
      }

      const hygieneNotes: string[] = [];

      const dorks = extractDorks(query);
      // A dork-only query strips down to nothing — say so instead of letting
      // sanitizeQuery claim the (non-empty) query was empty.
      if (
        !dorks.query.trim() &&
        (dorks.includeDomains.length > 0 || dorks.excludeDomains.length > 0)
      ) {
        throw new Error(
          "Query contained only site:/-domain filters — add search terms alongside the filters.",
        );
      }
      const q = sanitizeQuery(dorks.query, hygieneNotes);

      let useInclude: string[] | undefined = dorks.includeDomains.length
        ? dorks.includeDomains
        : undefined;
      let useExclude: string[] | undefined = dorks.excludeDomains.length
        ? dorks.excludeDomains
        : undefined;
      if (useInclude && useExclude) {
        useExclude = undefined;
        hygieneNotes.push(
          "Both include and exclude domains in query; using include only",
        );
      }

      const snappedOffset = normalizeOffset(offset, hygieneNotes);

      const endpoint = type === "news" ? "news" : "web";

      // -- Build request --
      const request: StaanRequest = { q, market };
      if (snappedOffset !== undefined) request.offset = snappedOffset;
      // Search for AI enrichment is only available for web search
      if (endpoint === "web") {
        request.extra_snippets = true;
        request.min_score = ENRICHMENT_MIN_SCORE;
        request.max_snippets = ENRICHMENT_MAX_SNIPPETS;
      }
      if (useInclude) request.include_domains = useInclude;
      if (useExclude) request.exclude_domains = useExclude;

      const data = await searchStaan({
        endpoint,
        request,
        apiKey,
        signal,
      });
      const results =
        (endpoint === "news" ? data.news?.results : data.web?.results) ?? [];

      // -- Format results --
      const lines: string[] = [];
      for (const [i, r] of results.entries()) {
        lines.push(`${i + 1}. ${r.title}`);
        lines.push(`   ${r.url}`);
        if (r.snippet) lines.push(`   ${r.snippet}`);
        if (r.extra_snippets?.length) {
          lines.push(`   Enriched snippets (${r.extra_snippets.length}):`);
          for (const snippet of r.extra_snippets) {
            const score = Number.isFinite(snippet.score)
              ? ` [${snippet.score.toFixed(2)}]`
              : "";
            lines.push(`   -${score} ${snippet.chunk}`);
          }
        }
        if (r.published_date) lines.push(`   Published: ${r.published_date}`);
        lines.push("");
      }

      let content = lines.join("\n").trim();
      if (!content) {
        content = `No results returned for ${JSON.stringify(q)}.`;
      }

      if (hygieneNotes.length) {
        content += `\n\nNotes:\n- ${hygieneNotes.join("\n- ")}`;
      }

      const headerLines = [`Query: ${query}`, `Results: ${results.length}`];
      if (request.offset !== undefined)
        headerLines.push(`Offset: ${request.offset}`);
      if (data.query?.altered_query)
        headerLines.push(`Altered query: ${data.query.altered_query}`);
      content = `${headerLines.join("\n")}\n\n${content}`;

      // -- Truncate and persist --
      const truncation = truncateHead(content);
      let note = `\n\n---\nOutput lines: ${content.split("\n").length}. Displayed lines: ${truncation.outputLines}. Truncated: ${truncation.truncated ? "yes" : "no"}.`;
      let resultsPath: string | undefined;
      if (truncation.truncated) {
        resultsPath = join(
          await getSessionTmpDir(),
          `results-${safeFileId(toolCallId)}.txt`,
        );
        await writeFile(resultsPath, content, "utf8");
        note += ` Full output: ${resultsPath}`;
      }

      const details: SearchDetails = {
        query: q,
        market,
        endpoint,
        offset: request.offset,
        resultCount: results.length,
        searchId: data.search_id,
        alteredQuery: data.query?.altered_query,
        timeoutMs: DEFAULT_FETCH_TIMEOUT_MS,
        outputTruncated: truncation.truncated,
        outputLines: content.split("\n").length,
        truncatedBy: truncation.truncatedBy ?? undefined,
        resultsPath,
      };

      return {
        content: [{ type: "text", text: `${truncation.content}${note}` }],
        details,
      };
    },

    // ---------------------------------------------------------------------------
    // Render
    // ---------------------------------------------------------------------------

    renderCall(args: SearchParamsType, _theme, _context) {
      const marketLabel = ` [${args.market ?? "fr-fr"}]`;
      const typeLabel =
        args.type && args.type !== "web" ? ` (${args.type})` : "";
      const text = `staan_search: "${args.query}"${marketLabel}${typeLabel}`;
      return new Text(text, 0, 0);
    },

    renderResult(result, { expanded }, _theme, _context) {
      const content = result.content?.[0];
      if (!content || content.type !== "text") {
        return new Text("", 0, 0);
      }
      return new Text(
        expanded ? content.text : compactText(content.text),
        0,
        0,
      );
    },
  });
}
