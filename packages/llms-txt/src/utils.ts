/**
 * Shared utilities for @m4ss/pi-llms-txt.
 */

import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import packageJson from "../package.json";

const PACKAGE_URL = packageJson.repository.url.replace(/^git\+/, "");

/** User-Agent string built from package metadata. */
export const USER_AGENT = `${packageJson.name.replace(/^@/, "").replace(/\//g, "-")}/${packageJson.version} (+${PACKAGE_URL})`;

/** Default fetch timeout in milliseconds. */
export const DEFAULT_FETCH_TIMEOUT_MS = 10_000;

/** Max bytes of llms.txt content to download and keep. */
export const MAX_CONTENT_BYTES = 40 * 1024;

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
// HTML sniffing
// ---------------------------------------------------------------------------

/**
 * Detect HTML masquerading as llms.txt. SPAs commonly serve their index.html
 * for any unknown path (including /llms.txt) with a 200 status. Matches shells
 * that skip the doctype and open with a comment, <head>, <body>, or <meta>.
 */
export function looksLikeHtml(text: string): boolean {
  return /^(?:<!doctype\s|<!--|<html[\s>]|<head[\s>]|<body[\s>]|<meta[\s>])/i.test(
    text.slice(0, 1024).trimStart(),
  );
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

// ---------------------------------------------------------------------------
// Atomic file write
// ---------------------------------------------------------------------------

let tempCounter = 0;

/**
 * Atomically write a file by writing to a temp file then renaming.
 * `renameSync` is atomic on POSIX filesystems — a crash mid-write can only
 * leave a stale temp file, never a corrupt target. The temp name includes
 * pid + counter so concurrent writers never share a temp file.
 *
 * @param target  Final file path (directory is created recursively if needed).
 * @param content String content to write.
 */
export function atomicFileWrite(
  target: string,
  content: string,
  encoding: BufferEncoding = "utf8",
): void {
  mkdirSync(dirname(target), { recursive: true });
  const temp = `${target}.${process.pid}.${tempCounter++}.tmp`;
  writeFileSync(temp, content, encoding);
  renameSync(temp, target);
}
