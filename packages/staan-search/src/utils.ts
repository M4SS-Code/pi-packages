/**
 * Shared utilities for @m4ss/pi-staan-search.
 */

import { keyHint } from "@earendil-works/pi-coding-agent";

import packageJson from "../package.json";

const PACKAGE_URL = packageJson.repository.url.replace(/^git\+/, "");

/** User-Agent string built from package metadata.
 * Intentional duplicate of web-fetch/utils.ts — each package is installed
 * standalone via `pi install ./packages/<name>` and cannot depend on a shared
 * workspace package, so helpers are copied; keep the copies in sync by hand. */
export const USER_AGENT = `${packageJson.name.replace(/^@/, "").replace(/\//g, "-")}/${packageJson.version} (+${PACKAGE_URL})`;

// ---------------------------------------------------------------------------
// Text truncation
// ---------------------------------------------------------------------------

/**
 * Truncate text to a maximum number of lines, appending a hint for expansion.
 * Used in the `renderResult` to show a compact view before the user expands.
 */
export function compactText(text: string, maxLines = 12): string {
  const lines = text.split("\n");
  if (lines.length <= maxLines) return text;
  return `${lines.slice(0, maxLines).join("\n")}\n… ${lines.length - maxLines} more lines hidden (${keyHint("app.tools.expand", "toggle")})`;
}

// ---------------------------------------------------------------------------
// Bounded body reader
// ---------------------------------------------------------------------------

/**
 * Read a response body as text, stopping after `maxBytes` bytes so a huge or
 * hostile response can never be buffered whole. The stream is cancelled once
 * the limit is hit; decoding is streaming-safe across chunk boundaries.
 *
 * `truncated` is true only when bytes were actually discarded — a body of
 * exactly `maxBytes` is complete, not truncated.
 *
 * Intentional duplicate of llms-txt/utils.ts — each package is installed
 * standalone via `pi install ./packages/<name>` and cannot depend on a shared
 * workspace package, so helpers are copied; keep the copies in sync by hand.
 */
export async function readBodyBounded(
  response: Response,
  maxBytes: number,
): Promise<{ text: string; truncated: boolean }> {
  const reader = response.body?.getReader();
  if (!reader) {
    throw new Error("Response body is not readable.");
  }

  const decoder = new TextDecoder();
  let text = "";
  let bytesRead = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    const remaining = maxBytes - bytesRead;
    if (value.byteLength > remaining) {
      if (remaining > 0) {
        text += decoder.decode(value.subarray(0, remaining), { stream: true });
      }
      await reader.cancel().catch(() => {});
      return { text: text + decoder.decode(), truncated: true };
    }
    bytesRead += value.byteLength;
    text += decoder.decode(value, { stream: true });
  }
  return { text: text + decoder.decode(), truncated: false };
}

// ---------------------------------------------------------------------------
// Timeout helper
// ---------------------------------------------------------------------------

/**
 * Create an AbortSignal that fires after `timeoutMs` and also forwards
 * abort from a parent signal. Returns an object with cleanup.
 *
 * Intentional duplicate of web-fetch/utils.ts — each package is installed
 * standalone via `pi install ./packages/<name>` and cannot depend on a shared
 * workspace package, so helpers are copied; keep the copies in sync by hand.
 */
export function timeoutSignal(
  parentSignal: AbortSignal | undefined,
  timeoutMs: number,
): { signal: AbortSignal; readonly timedOut: boolean; cleanup(): void } {
  const controller = new AbortController();
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort(new Error(`Request timed out after ${timeoutMs}ms`));
  }, timeoutMs);
  const onAbort = () => controller.abort(parentSignal?.reason);
  // "abort" never fires on a signal that is already aborted — forward it now
  if (parentSignal?.aborted) {
    onAbort();
  } else {
    parentSignal?.addEventListener("abort", onAbort, { once: true });
  }
  return {
    signal: controller.signal,
    get timedOut() {
      return timedOut;
    },
    cleanup() {
      clearTimeout(timeout);
      parentSignal?.removeEventListener("abort", onAbort);
    },
  };
}
