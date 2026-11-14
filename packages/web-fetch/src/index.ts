/**
 * @m4ss/pi-web-fetch
 *
 * Pi extension that registers a `web_fetch` tool to fetch web pages and return
 * Markdown (default) or raw HTML.
 */

import { mkdtemp, writeFile } from "node:fs/promises";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRecentFetches } from "./cache";
import { fetchUrl, type FetchUrlParams, type FetchUrlResult } from "./fetch";
import { paginate } from "./page";
import { USER_AGENT, compactText } from "./utils";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// One temp directory per session; files inside are keyed by tool call id so
// repeated fetches don't leave a trail of single-use mkdtemp directories.
let sessionTmpDir: Promise<string> | undefined;

function getSessionTmpDir(): Promise<string> {
  sessionTmpDir ??= mkdtemp(join(tmpdir(), "web-fetch-"));
  return sessionTmpDir;
}

function safeFileId(toolCallId: string): string {
  return toolCallId.replace(/[^\w.-]/g, "_");
}

/** Write the whole output to the session temp dir and return its path. */
async function writeFullOutput(
  toolCallId: string,
  result: FetchUrlResult,
): Promise<string> {
  const extension =
    result.format === "json"
      ? "json"
      : result.format === "html"
        ? "html"
        : "md";
  const path = join(
    await getSessionTmpDir(),
    `page-${safeFileId(toolCallId)}.${extension}`,
  );
  await writeFile(path, result.output, "utf8");
  return path;
}

// Lets a later part of a long page be read without downloading it again.
const recentFetches = createRecentFetches();

// ---------------------------------------------------------------------------
// Tool parameters
// ---------------------------------------------------------------------------

const WebFetchParams = Type.Object({
  url: Type.String({ description: "HTTP/HTTPS URL to fetch" }),
  format: Type.Optional(
    StringEnum(["markdown", "html"] as const, {
      description: "Output format. Default: markdown",
    }),
  ),
  timeoutMs: Type.Optional(
    Type.Number({
      description: "Fetch timeout in ms. Default: 10000",
    }),
  ),
  offset: Type.Optional(
    Type.Integer({
      minimum: 1,
      description:
        "1-based line to start from. Use the offset a truncated result gives to read the next part. Default: 1",
    }),
  ),
});

// ---------------------------------------------------------------------------
// Extension entry
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "web_fetch",
    label: "Web Fetch",
    description:
      "Fetch a URL and return its content as Markdown (default) or HTML. " +
      "To discover URLs, use staan_search first.",
    promptSnippet: "Fetch and convert a web page to Markdown",
    promptGuidelines: [
      "Prefer the most specific raw endpoint for known targets: GitHub uses raw.githubusercontent.com (file contents) and the GitHub API (repo metadata); packages use their registry (npm, PyPI, crates.io, GitHub API).",
      "Keep format=markdown by default; use format=html only when you need raw markup or the presentation matters.",
    ],
    parameters: WebFetchParams,

    // Execute
    async execute(toolCallId, params, signal) {
      const { url, format = "markdown", timeoutMs, offset = 1 } = params;

      const fetchParams: FetchUrlParams = {
        url,
        format,
        timeoutMs,
        signal,
        userAgent: USER_AGENT,
      };
      // A later page of a document fetched moments ago comes from memory;
      // a first page is always fetched fresh.
      const recent = await recentFetches.load(url, format, offset, () =>
        fetchUrl(fetchParams),
      );
      const { result } = recent;

      const page = paginate(result.output, offset);
      let fullPath: string | undefined;
      let note = `\n\n---\nLines ${page.startLine}-${page.endLine} of ${page.totalLines}. Truncated: ${page.truncated ? "yes" : "no"}.`;
      if (page.nextOffset !== undefined) {
        note += ` Next part: web_fetch with offset=${page.nextOffset}.`;
      }
      if (page.truncated) {
        // The file holds the whole document, so one write serves every part.
        recent.fullPath ??= await writeFullOutput(toolCallId, result);
        fullPath = recent.fullPath;
        note += ` Full output: ${fullPath}`;
      }

      return {
        content: [{ type: "text", text: `${page.content}${note}` }],
        details: {
          requestedUrl: result.requestedUrl,
          url: result.finalUrl,
          redirectChain: result.redirectChain,
          status: result.status,
          contentType: result.contentType,
          format: result.format,
          timeoutMs: result.timeoutMs,
          inputTruncated: result.inputTruncated,
          outputTruncated: page.truncated,
          outputLines: page.totalLines,
          startLine: page.startLine,
          displayedLines: Math.max(page.endLine - page.startLine + 1, 0),
          nextOffset: page.nextOffset,
          truncatedBy: page.truncatedBy ?? undefined,
          fullPath,
        },
      };
    },

    // Render
    renderCall(args) {
      let text = `web_fetch: ${args.url}`;
      if (args.format) text += ` (${args.format})`;
      if (args.offset !== undefined && args.offset > 1) {
        text += ` from line ${args.offset}`;
      }
      return new Text(text, 0, 0);
    },

    // Render result
    renderResult(result, { expanded }) {
      const content = result.content?.[0];
      if (!content || content.type !== "text") return new Text("", 0, 0);
      return new Text(
        expanded ? content.text : compactText(content.text),
        0,
        0,
      );
    },
  });
}
