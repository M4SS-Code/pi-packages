/**
 * @m4ss/pi-staan-search
 *
 * Registers a `staan_search` tool powered by the Staan.ai Web Search for AI API.
 * Supports web and news endpoints with semantic enrichment, full-content reranking,
 * and dork-style domain filtering (site:domain, -domain.tld).
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
import {
  extractDorks,
  sanitizeQuery,
  normalizeOffset,
  clamp,
} from "./query-parser";
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
  jsonPath?: string;
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

// ---------------------------------------------------------------------------
// Tool parameters — StringEnum per pi docs for Google API compatibility
// ---------------------------------------------------------------------------

const SearchParams = Type.Object({
  query: Type.String({ description: "Search query" }),
  market: Type.Optional(
    StringEnum(SUPPORTED_MARKETS, {
      description:
        "Language/region. Default: fr-fr. Use en-us for US-specific results.",
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
  extraSnippets: Type.Optional(
    Type.Boolean({
      description:
        "Enable semantic enrichment snippets. Default: true for web. Set false for plain search.",
    }),
  ),
  minScore: Type.Optional(
    Type.Number({
      description: "Minimum enrichment score (0–1). Default: 0.2",
    }),
  ),
  maxSnippets: Type.Optional(
    Type.Number({
      description: "Max extra snippets per result. Default: 5",
    }),
  ),
  fullContent: Type.Optional(
    StringEnum(["markdown", "html"] as const, {
      description:
        "Request full page body (markdown or html). Triggers reranking.",
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
      "For known URLs, use web_fetch directly.",
    promptSnippet: "European Search for AI with semantic enrichment",
    promptGuidelines: [
      "Use staan_search to research topics and find official docs or primary sources; cite the result URLs you rely on.",
      "Use site:domain or -domain in the query to narrow results to or from specific sites.",
      'Keep the default market="fr-fr" for the European route; use market="en-us" only for US-specific needs.',
      "Treat snippets as pointers, not proof: verify claims against the enriched chunks or a web_fetch of the page before relying on them.",
      "When you already know the URL or identifier, fetch it directly. Search to discover unknowns or disambiguate colliding names (e.g. bare package names).",
    ],

    parameters: SearchParams,

    // ---------------------------------------------------------------------------
    // Execute
    // ---------------------------------------------------------------------------

    execute: async (toolCallId, params, signal, _onUpdate, _ctx) => {
      const {
        query,
        market = "fr-fr",
        type = "web",
        offset,
        extraSnippets,
        minScore,
        maxSnippets,
        fullContent,
      } = params;

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
      const wantsFullContent =
        fullContent === "markdown" || fullContent === "html";
      const requestExtraSnippets =
        endpoint === "web" && extraSnippets !== false;
      const usesSearchForAi =
        requestExtraSnippets || (endpoint === "web" && wantsFullContent);

      if (endpoint === "news" && (extraSnippets || wantsFullContent)) {
        hygieneNotes.push(
          "Search for AI enrichment is only available for web search; ignoring enrichment options for news",
        );
      }

      let useMinScore = minScore;
      let useMaxSnippets = maxSnippets;
      if (usesSearchForAi) {
        if (useMinScore === undefined) useMinScore = 0.2;
        if (useMaxSnippets === undefined) useMaxSnippets = 5;
      }
      if (useMinScore !== undefined) {
        const clamped = clamp(useMinScore, 0, 1);
        if (clamped !== useMinScore)
          hygieneNotes.push(`minScore clamped to ${clamped} [0,1]`);
        useMinScore = clamped;
      }
      if (useMaxSnippets !== undefined) {
        const clamped = Math.round(clamp(useMaxSnippets, 1, 10));
        if (clamped !== useMaxSnippets)
          hygieneNotes.push(`maxSnippets clamped to ${clamped} [1,10]`);
        useMaxSnippets = clamped;
      }

      // -- Build request --
      const request: StaanRequest = { q, market };
      if (snappedOffset !== undefined) request.offset = snappedOffset;
      if (requestExtraSnippets) request.extra_snippets = true;
      if (usesSearchForAi && useMinScore !== undefined)
        request.min_score = useMinScore;
      if (usesSearchForAi && useMaxSnippets !== undefined)
        request.max_snippets = useMaxSnippets;
      if (endpoint === "web" && wantsFullContent)
        request.full_content = fullContent;
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

      // fullContent body is not inlined — API structure may change; raw body lives in the JSON dump

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
      let jsonPath: string | undefined;
      if (truncation.truncated) {
        resultsPath = join(
          await getSessionTmpDir(),
          `results-${safeFileId(toolCallId)}.txt`,
        );
        await writeFile(resultsPath, content, "utf8");
        note += ` Full output: ${resultsPath}`;
      }

      // Persist raw JSON only when it carries data the text output doesn't:
      // fullContent page bodies are never inlined, so the dump is their home.
      if (request.full_content !== undefined) {
        jsonPath = join(
          await getSessionTmpDir(),
          `response-${safeFileId(toolCallId)}.json`,
        );
        await writeFile(jsonPath, JSON.stringify(data, null, 2), "utf8");
        note += `\nFull JSON response saved to: ${jsonPath}`;
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
        jsonPath,
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
      const enrichLabel =
        (args.type ?? "web") === "web" && args.extraSnippets !== false
          ? " (enriched)"
          : "";
      const contentLabel = args.fullContent ? ` [${args.fullContent}]` : "";
      const text = `staan_search: "${args.query}"${marketLabel}${typeLabel}${enrichLabel}${contentLabel}`;
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
