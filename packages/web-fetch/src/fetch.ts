/**
 * Standalone web-fetch utilities — HTML→Markdown conversion, URL parsing,
 * content-type detection, and the core fetch pipeline.
 */

import { formatSize } from "@earendil-works/pi-coding-agent";
import TurndownService from "turndown";
import { JSDOM } from "jsdom";
import { timeoutSignal } from "./utils";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const MAX_RESPONSE_BYTES = 5 * 1024 * 1024;
export const DEFAULT_FETCH_TIMEOUT_MS = 10_000;

/** Max bytes of an error response body to read for diagnostics. */
const MAX_ERROR_BODY_BYTES = 16 * 1024;

/** Max redirect hops followed manually so every hop can be re-validated. */
const MAX_REDIRECT_HOPS = 5;

// ---------------------------------------------------------------------------
// URL parsing
// ---------------------------------------------------------------------------

export function parseHttpUrl(url: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("Invalid URL.");
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("Only http:// and https:// URLs are supported.");
  }

  if (parsed.username !== "" || parsed.password !== "") {
    throw new Error("URLs with embedded credentials are not supported.");
  }

  return parsed;
}

// ---------------------------------------------------------------------------
// Private-network guard
// ---------------------------------------------------------------------------

function isPrivateIpv4(host: string): boolean {
  const [a, b] = host.split(".").map(Number);
  if (a === undefined || b === undefined) return false;
  return (
    a === 0 || // "this network"
    a === 10 || // RFC 1918
    a === 127 || // loopback
    (a === 100 && b >= 64 && b <= 127) || // CGNAT (RFC 6598)
    (a === 169 && b === 254) || // link-local / cloud metadata
    (a === 172 && b >= 16 && b <= 31) || // RFC 1918
    (a === 192 && b === 168) || // RFC 1918
    a >= 224 // multicast, reserved, broadcast
  );
}

function isPrivateIpv6(ip: string): boolean {
  const host = ip.toLowerCase();
  if (host === "::" || host === "::1") return true; // unspecified, loopback
  if (/^fe[89ab]/.test(host)) return true; // link-local fe80::/10
  if (/^f[cd]/.test(host)) return true; // ULA fc00::/7
  // IPv4-mapped addresses: "::ffff:1.2.3.4" or the hex form "::ffff:102:304"
  const mapped = /^::ffff:(.+)$/.exec(host)?.[1];
  if (mapped !== undefined) {
    if (mapped.includes(".")) return isPrivateIpv4(mapped);
    const [hiRaw, loRaw] = mapped.split(":");
    if (hiRaw !== undefined && loRaw !== undefined) {
      const hi = parseInt(hiRaw, 16);
      const lo = parseInt(loRaw, 16);
      if (Number.isFinite(hi) && Number.isFinite(lo)) {
        return isPrivateIpv4(`${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`);
      }
    }
    return true; // unparseable mapped form — refuse
  }
  return false;
}

/**
 * Refuse URLs that point at private or local infrastructure. Applied to the
 * initial URL and to every redirect hop, this blocks the obvious SSRF
 * targets (loopback, RFC 1918, link-local/cloud-metadata, CGNAT, ULA,
 * localhost and other non-public hostnames). It does not defend against DNS
 * rebinding — a hostile public hostname resolving to a private address —
 * which would require a pinned resolver.
 *
 * WHATWG URL normalizes every numeric host form (hex, octal, decimal) to a
 * dotted quad, so checking `url.hostname` covers e.g. http://0x7f000001/.
 */
export function assertPublicTarget(url: URL): void {
  const host = url.hostname.toLowerCase();
  if (host.startsWith("[") && host.endsWith("]")) {
    if (isPrivateIpv6(host.slice(1, -1))) {
      throw new Error(`Refusing to fetch private/local address: ${host}`);
    }
    return;
  }
  if (/^\d+(\.\d+){3}$/.test(host)) {
    if (isPrivateIpv4(host)) {
      throw new Error(`Refusing to fetch private/local address: ${host}`);
    }
    return;
  }
  if (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.endsWith(".local") ||
    !host.includes(".")
  ) {
    throw new Error(
      `Refusing to fetch local hostname "${host}" — only public hostnames are fetched`,
    );
  }
}

// ---------------------------------------------------------------------------
// Body reader
// ---------------------------------------------------------------------------

export function charsetFromContentType(
  contentType: string,
): string | undefined {
  const match = /charset=["']?([^"';\s]+)/i.exec(contentType);
  return match?.[1];
}

/**
 * Legacy pages often declare their charset only in a <meta> tag. Browsers
 * sniff the first bytes for it when the header has no charset; do the same.
 */
function sniffMetaCharset(bytes: Uint8Array): string | undefined {
  const head = new TextDecoder("latin1").decode(bytes.subarray(0, 1024));
  return /<meta[^>]+charset\s*=\s*["']?([\w-]+)/i.exec(head)?.[1];
}

/** Decode with the declared charset, a sniffed <meta charset>, or UTF-8. */
function decodeBody(bytes: Uint8Array, response: Response): string {
  const contentType = response.headers.get("content-type") ?? "";
  let label = charsetFromContentType(contentType);
  if (label === undefined) {
    const { isHtml, isXml } = classifyContentType(contentType);
    if (isHtml || isXml) label = sniffMetaCharset(bytes);
  }
  if (label !== undefined) {
    try {
      return new TextDecoder(label).decode(bytes);
    } catch {
      /* unknown label — fall back to UTF-8 */
    }
  }
  return new TextDecoder().decode(bytes);
}

export async function readTextWithLimit(
  response: Response,
  maxBytes: number = MAX_RESPONSE_BYTES,
): Promise<{ text: string; inputTruncated: boolean }> {
  if (!response.body) {
    throw new Error("Response body is not readable.");
  }

  // Bytes are buffered (bounded by maxBytes) and decoded in one pass at the
  // end, because the charset may only be known after sniffing the body.
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytesRead = 0;
  let inputTruncated = false;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    const remaining = maxBytes - bytesRead;
    if (value.byteLength > remaining) {
      if (remaining > 0) {
        chunks.push(value.subarray(0, remaining));
        bytesRead = maxBytes;
      }
      inputTruncated = true;
      await reader.cancel();
      break;
    }

    chunks.push(value);
    bytesRead += value.byteLength;
  }

  const bytes = new Uint8Array(bytesRead);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { text: decodeBody(bytes, response), inputTruncated };
}

// ---------------------------------------------------------------------------
// Markdown helpers
// ---------------------------------------------------------------------------

export function maxBacktickRun(text: string): number {
  // A loop, not Math.max(...spread) — a pathological page with hundreds of
  // thousands of backtick runs would blow the argument limit.
  let max = 0;
  for (const match of text.matchAll(/`+/g)) {
    if (match[0].length > max) max = match[0].length;
  }
  return max;
}

export function fencedCodeBlock(text: string, language = ""): string {
  const fence = "`".repeat(Math.max(3, maxBacktickRun(text) + 1));
  return `\n\n${fence}${language}\n${text}\n${fence}\n\n`;
}

export function inlineCodeSpan(text: string): string {
  const fence = "`".repeat(Math.max(1, maxBacktickRun(text) + 1));
  const padding = text.startsWith("`") || text.endsWith("`") ? " " : "";
  return `${fence}${padding}${text}${padding}${fence}`;
}

// ---------------------------------------------------------------------------
// DOM manipulation
// ---------------------------------------------------------------------------

/**
 * Prepare HTML for Markdown conversion: strip non-content elements
 * (script/style/noscript/template) and rewrite relative link/image URLs
 * to absolute ones against the final response URL.
 *
 * Returns the live Document so the Markdown converter can walk it directly —
 * serializing back to a string would force a second full parse.
 */
export function preprocessHtml(html: string, baseUrl: string): Document {
  const dom = new JSDOM(html);
  const doc = dom.window.document;
  // A <base href> overrides the response URL for relative resolution
  let base = new URL(baseUrl);
  const baseHref = doc.querySelector("base[href]")?.getAttribute("href");
  if (baseHref) {
    try {
      base = new URL(baseHref, baseUrl);
    } catch {
      /* invalid base href — keep the response URL */
    }
  }
  const isAbs = (u: string) =>
    /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(u) || u.startsWith("#");
  const toAbs = (u: string) => (isAbs(u) ? u : new URL(u, base).toString());

  // Strip non-content elements before href rewriting
  doc
    .querySelectorAll("script, style, noscript, template")
    .forEach((node) => node.remove());

  doc.querySelectorAll<HTMLAnchorElement>("a[href]").forEach((a) => {
    const href = a.getAttribute("href");
    if (!href) return;
    try {
      a.setAttribute("href", toAbs(href));
    } catch {}
  });

  doc.querySelectorAll<HTMLImageElement>("img[src]").forEach((img) => {
    const src = img.getAttribute("src");
    if (src) {
      try {
        img.setAttribute("src", toAbs(src));
      } catch {}
    }
    const srcset = img.getAttribute("srcset");
    if (srcset) {
      const parts = srcset
        .split(",")
        .map((p) => p.trim())
        .filter(Boolean);
      const rewritten = parts
        .map((p) => {
          const m = p.match(/^(\S+)(\s+.+)?$/);
          if (!m || m[1] === undefined) return p;
          const url = m[1];
          const desc = m[2] ?? "";
          try {
            return `${toAbs(url)}${desc}`;
          } catch {
            return p;
          }
        })
        .join(", ");
      img.setAttribute("srcset", rewritten);
    }
  });

  return doc;
}

// ---------------------------------------------------------------------------
// HTML → Markdown
// ---------------------------------------------------------------------------

// The service is stateless across conversions — build it once, not per fetch.
let turndownService: TurndownService | undefined;

function getTurndownService(): TurndownService {
  if (!turndownService) {
    turndownService = new TurndownService({
      headingStyle: "atx",
      hr: "---",
      codeBlockStyle: "fenced",
    });

    turndownService.addRule("preservePre", {
      filter: (node) => node.nodeName === "PRE",
      replacement: (_content, node) => {
        const el = node as HTMLElement;
        // Highlighters put language-* / lang-* on the <pre> or its <code>
        const classes = `${el.getAttribute("class") ?? ""} ${el.querySelector("code")?.getAttribute("class") ?? ""}`;
        const language =
          /(?:language|lang)-([\w+#-]+)/.exec(classes)?.[1] ?? "";
        return fencedCodeBlock(el.textContent ?? "", language);
      },
    });

    turndownService.addRule("preserveCodeInline", {
      filter: (node) =>
        node.nodeName === "CODE" && node.parentNode?.nodeName !== "PRE",
      replacement: (_content, node) => {
        const text = (node as HTMLElement).textContent ?? "";
        return inlineCodeSpan(text);
      },
    });
  }
  return turndownService;
}

export function htmlToMarkdown(input: string | Document): string {
  return getTurndownService().turndown(input);
}

// ---------------------------------------------------------------------------
// Content-type classification
// ---------------------------------------------------------------------------

export interface ContentTypeInfo {
  isHtml: boolean;
  isText: boolean;
  isJson: boolean;
  isXml: boolean;
}

export function classifyContentType(contentType: string): ContentTypeInfo {
  const normalized = contentType.toLowerCase();
  return {
    isHtml: normalized.includes("text/html"),
    isText: normalized.startsWith("text/"),
    isJson:
      normalized.includes("application/json") || normalized.includes("+json"),
    isXml:
      normalized.includes("application/xml") || normalized.includes("+xml"),
  };
}

// ---------------------------------------------------------------------------
// Meta refresh detection
// ---------------------------------------------------------------------------

/**
 * Extract the target of an instant `<meta http-equiv="refresh">` redirect —
 * the form static site generators emit in place of HTTP 3xx, which static
 * hosting cannot send. Only a zero delay counts as a redirect: a delayed
 * refresh usually sits on a page with real content meant to be read first.
 *
 * Returns the raw (possibly relative) URL, or undefined when there is none.
 */
export function metaRefreshTarget(html: string): string | undefined {
  // Commented-out markup and tags quoted inside scripts would otherwise
  // match — a browser would not act on either.
  const scannable = html
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<script[\s\S]*?<\/script\s*>/gi, "");
  for (const [tag] of scannable.matchAll(/<meta\b[^>]*>/gi)) {
    if (!/http-equiv\s*=\s*["']?refresh["'\s/>]/i.test(tag)) continue;
    const content = /content\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/i.exec(
      tag,
    );
    const value = content?.[1] ?? content?.[2] ?? content?.[3];
    if (value === undefined) continue;
    // Value shape: "0; url=/new" — the separator may be ";" or "," and the
    // "url=" prefix and quotes around the URL are optional
    const match =
      /^\s*(\d+(?:\.\d+)?)\s*[;,]\s*(?:url\s*=\s*)?["']?([^"']+?)["']?\s*$/i.exec(
        value,
      );
    if (!match || Number(match[1]) !== 0) continue;
    const target = match[2]?.trim();
    if (target) return target;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Fetch types
// ---------------------------------------------------------------------------

export interface FetchUrlParams {
  url: string;
  format?: "markdown" | "html";
  timeoutMs?: number;
  signal?: AbortSignal;
  userAgent: string;
}

export interface RedirectHop {
  /** How the previous URL redirected here: "HTTP <status>" or "meta refresh". */
  via: string;
  url: string;
}

export interface FetchUrlResult {
  requestedUrl: string;
  finalUrl: string;
  redirectChain: RedirectHop[];
  status: number;
  contentType: string;
  format: "json" | "markdown" | "html";
  timeoutMs: number;
  inputTruncated: boolean;
  metadataNotes: string[];
  output: string;
}

// ---------------------------------------------------------------------------
// Fetch pipeline
// ---------------------------------------------------------------------------

export async function fetchUrl(
  params: FetchUrlParams,
): Promise<FetchUrlResult> {
  const { url, format = "markdown", timeoutMs, signal, userAgent } = params;

  const parsedUrl = parseHttpUrl(url);
  const requestedTimeoutMs =
    typeof timeoutMs === "number" && Number.isFinite(timeoutMs)
      ? timeoutMs
      : DEFAULT_FETCH_TIMEOUT_MS;
  const effectiveTimeoutMs = Math.round(
    Math.min(60_000, Math.max(1_000, requestedTimeoutMs)),
  );
  const metadataNotes: string[] = [];
  if (effectiveTimeoutMs !== requestedTimeoutMs) {
    metadataNotes.push(`timeoutMs clamped to ${effectiveTimeoutMs}ms`);
  }
  const redirectChain: RedirectHop[] = [];

  // The whole exchange — status check, error bodies, and the content read —
  // stays inside the timeout scope: a server that sends headers and then
  // stalls the body would otherwise hang with no timeout, and the user's
  // abort signal would already be disconnected.
  let response: Response;
  let raw: string;
  let inputTruncated: boolean;
  let contentType = "";
  const timeout = timeoutSignal(signal, effectiveTimeoutMs);
  try {
    // Redirects are followed manually so every hop — not just the first
    // URL — goes through the private-network guard. HTTP 3xx hops and
    // meta-refresh hops count against the same cap.
    let currentUrl = parsedUrl;
    let hops = 0;
    const countHop = (via: string, next: URL) => {
      hops += 1;
      if (hops > MAX_REDIRECT_HOPS) {
        throw new Error(
          `Too many redirects (>${MAX_REDIRECT_HOPS}) fetching ${parsedUrl.toString()}`,
        );
      }
      redirectChain.push({ via, url: next.toString() });
    };
    while (true) {
      assertPublicTarget(currentUrl);
      try {
        response = await fetch(currentUrl, {
          redirect: "manual",
          signal: timeout.signal,
          headers: {
            "User-Agent": userAgent,
            Accept:
              "text/html,application/xhtml+xml,text/plain,application/json,application/*+json,application/xml,application/*+xml;q=0.9,*/*;q=0.1",
          },
        });
      } catch (e: unknown) {
        const msg =
          e instanceof Error
            ? e.message
            : typeof e === "string"
              ? e
              : String(e);
        throw new Error(`Fetch error for ${currentUrl.toString()}: ${msg}`);
      }

      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get("location");
        // A 3xx without a location falls through to the !ok error below
        if (location) {
          await response.body?.cancel().catch(() => {});
          let nextUrl: URL;
          try {
            nextUrl = new URL(location, currentUrl);
          } catch {
            throw new Error(
              `Invalid redirect location ${JSON.stringify(location)} from ${currentUrl.toString()}`,
            );
          }
          // Re-checks the scheme and credential rules on every hop
          const next = parseHttpUrl(nextUrl.toString());
          countHop(`HTTP ${response.status}`, next);
          currentUrl = next;
          continue;
        }
      }

      if (!response.ok) {
        const body = await readTextWithLimit(response, MAX_ERROR_BODY_BYTES)
          .then((result) => result.text)
          .catch(() => "");
        throw new Error(
          `HTTP ${response.status} for ${response.url}\n${body.slice(0, 500)}`,
        );
      }

      contentType = response.headers.get("content-type") ?? "";
      const { isHtml, isText, isJson, isXml } =
        classifyContentType(contentType);
      // A missing content-type header is treated as plain text (common on raw
      // file endpoints); only a present-but-unsupported type is rejected.
      if (contentType !== "" && !isHtml && !isText && !isJson && !isXml) {
        await response.body?.cancel().catch(() => {});
        throw new Error(`Unsupported content-type: ${contentType}`);
      }

      ({ text: raw, inputTruncated } = await readTextWithLimit(response));

      if (isHtml) {
        const target = metaRefreshTarget(raw);
        if (target !== undefined) {
          let next: URL | undefined;
          try {
            next = parseHttpUrl(new URL(target, currentUrl).toString());
          } catch {
            /* malformed or non-http target — keep the stub page as-is */
          }
          if (next !== undefined && next.toString() !== currentUrl.toString()) {
            countHop("meta refresh", next);
            currentUrl = next;
            continue;
          }
        }
      }

      break;
    }
  } catch (e: unknown) {
    if (timeout.timedOut) {
      throw new Error(
        `Fetch timed out after ${effectiveTimeoutMs}ms for ${parsedUrl.toString()}`,
      );
    }
    throw e;
  } finally {
    timeout.cleanup();
  }

  const status = response.status;
  const { isHtml, isJson } = classifyContentType(contentType);

  let output = raw;
  // Output format widens from the user's requested format to include "json":
  // when the server returns a JSON content-type, the tool auto-detects and
  // pretty-prints the JSON, overriding the user's requested format.
  let resolvedFormat: "json" | "markdown" | "html" = format;

  if (isJson) {
    resolvedFormat = "json";
    try {
      output = `${JSON.stringify(JSON.parse(raw), null, 2)}\n`;
    } catch {
      metadataNotes.push(
        "JSON content-type returned invalid JSON; showing raw text",
      );
    }
  } else if (isHtml && format === "markdown") {
    output = htmlToMarkdown(preprocessHtml(raw, response.url));
  }

  const headerLines = [`Requested URL: ${parsedUrl.toString()}`];
  for (const hop of redirectChain) {
    headerLines.push(`Redirected (${hop.via}) to: ${hop.url}`);
  }
  headerLines.push(
    `Final URL: ${response.url}`,
    `Status: ${status}`,
    `Content-Type: ${contentType || "(unknown)"}`,
  );
  if (inputTruncated) {
    headerLines.push(
      `Input truncated before conversion at ${formatSize(MAX_RESPONSE_BYTES)}`,
    );
  }
  if (metadataNotes.length) {
    headerLines.push(`Notes: ${metadataNotes.join("; ")}`);
  }
  output = `${headerLines.join("\n")}\n\n${output}`;

  return {
    requestedUrl: parsedUrl.toString(),
    finalUrl: response.url,
    redirectChain,
    status,
    contentType,
    format: resolvedFormat,
    timeoutMs: effectiveTimeoutMs,
    inputTruncated,
    metadataNotes,
    output,
  };
}
