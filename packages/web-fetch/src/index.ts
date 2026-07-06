/**
 * @m4ss/pi-web-fetch
 *
 * Pi extension that registers a `web_fetch` tool to fetch web pages and return
 * Markdown (default) or raw HTML.
 */

import { mkdtemp, writeFile } from "node:fs/promises";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { truncateHead } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fetchUrl, type FetchUrlParams, type FetchUrlResult } from "./fetch";
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
      "Prefer raw/API endpoints over rendered HTML. To discover URLs, use staan_search first.",
    promptSnippet: "Fetch and convert a web page to Markdown",
    promptGuidelines: [
      "Use web_fetch to retrieve any HTTP/HTTPS URL, whether the user gave it, you already know it, or staan_search returned it, and cite the fetched URL in your answer.",
      "Prefer official structured APIs, raw file URLs, or export endpoints over rendered HTML when they carry the same content; for GitHub use raw.githubusercontent.com (file contents) and the GitHub API (repo metadata).",
      "When you know a package or repo name, fetch its registry/API endpoint directly (crates.io, npm, PyPI, GitHub API), choosing the most specific resource to avoid pulling unneeded data.",
      "Fetch rendered HTML only when presentation matters or no structured/raw endpoint exists; keep the default format=markdown and use html only when you need raw markup.",
    ],
    parameters: WebFetchParams,

    // Execute
    async execute(toolCallId, params, signal) {
      const { url, format = "markdown", timeoutMs } = params;

      const fetchParams: FetchUrlParams = {
        url,
        format,
        timeoutMs,
        signal,
        userAgent: USER_AGENT,
      };
      const result: FetchUrlResult = await fetchUrl(fetchParams);

      const outputLines = result.output.split("\n").length;
      const truncation = truncateHead(result.output);
      let fullPath: string | undefined;
      let note = `\n\n---\nOutput lines: ${outputLines}. Displayed lines: ${truncation.outputLines}. Truncated: ${truncation.truncated ? "yes" : "no"}.`;
      if (truncation.truncated) {
        const extension =
          result.format === "json"
            ? "json"
            : result.format === "html"
              ? "html"
              : "md";
        fullPath = join(
          await getSessionTmpDir(),
          `page-${safeFileId(toolCallId)}.${extension}`,
        );
        await writeFile(fullPath, result.output, "utf8");
        note += ` Full output: ${fullPath}`;
      }

      return {
        content: [{ type: "text", text: `${truncation.content}${note}` }],
        details: {
          requestedUrl: result.requestedUrl,
          url: result.finalUrl,
          redirectChain: result.redirectChain,
          status: result.status,
          contentType: result.contentType,
          format: result.format,
          timeoutMs: result.timeoutMs,
          inputTruncated: result.inputTruncated,
          outputTruncated: truncation.truncated,
          outputLines,
          displayedLines: truncation.outputLines,
          truncatedBy: truncation.truncatedBy ?? undefined,
          fullPath,
        },
      };
    },

    // Render
    renderCall(args) {
      const text =
        `web_fetch: ${args.url} ${args.format ? `(${args.format})` : ""}`.trim();
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
