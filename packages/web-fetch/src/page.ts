/**
 * Line-based paging for web_fetch output.
 *
 * Long pages are cut to pi's default output limits. Instead of pointing the
 * model at a temp file it may not be able to read (the searcher subagent has
 * no `read` tool), each truncated result says which `offset` returns the next
 * page, so the caller can continue with web_fetch alone.
 *
 * A line longer than the byte limit (minified HTML, unparseable JSON) could
 * never fit in a page, so it is cut into pieces that each count as a line.
 * Line numbers therefore refer to the paged output, not to the source text.
 */

import {
  DEFAULT_MAX_BYTES,
  truncateHead,
} from "@earendil-works/pi-coding-agent";

/**
 * Size of the pieces an over-long line is cut into: small enough that several
 * share a page instead of each taking a page of its own.
 */
const LONG_LINE_PIECE_BYTES = 4 * 1024;

export interface Page {
  /** The lines shown, after truncation. */
  content: string;
  /** 1-based number of the first line shown. */
  startLine: number;
  /** 1-based number of the last line shown (startLine - 1 for empty output). */
  endLine: number;
  /** Number of lines in the whole output. */
  totalLines: number;
  /** Whether lines after endLine were left out. */
  truncated: boolean;
  /** Which limit cut the page, if any. */
  truncatedBy: "lines" | "bytes" | null;
  /** Offset that returns the next page, or undefined on the last page. */
  nextOffset: number | undefined;
}

/**
 * Cut a line into pieces of at most `maxBytes` UTF-8 bytes. A cut never lands
 * inside a character, and falls after whitespace when the second half of the
 * piece has any, so words and URLs mostly stay whole.
 */
function splitLongLine(line: string, maxBytes: number): string[] {
  const bytes = Buffer.from(line, "utf8");
  const pieces: string[] = [];
  let start = 0;
  while (start < bytes.length) {
    let end = Math.min(start + maxBytes, bytes.length);
    if (end < bytes.length) {
      // Step back off continuation bytes to the start of a character
      while ((bytes[end]! & 0xc0) === 0x80) end--;
      const earliest = start + Math.floor(maxBytes / 2);
      for (let i = end - 1; i >= earliest; i--) {
        if (bytes[i] === 0x20 || bytes[i] === 0x09) {
          end = i + 1;
          break;
        }
      }
    }
    pieces.push(bytes.toString("utf8", start, end));
    start = end;
  }
  return pieces;
}

/**
 * The lines paging counts: over-long lines are replaced by their pieces, and
 * trailing empty lines are dropped so a final newline adds no phantom line.
 */
function pageLines(output: string): string[] {
  const lines: string[] = [];
  for (const line of output.split("\n")) {
    if (Buffer.byteLength(line, "utf8") <= DEFAULT_MAX_BYTES) {
      lines.push(line);
      continue;
    }
    for (const piece of splitLongLine(line, LONG_LINE_PIECE_BYTES)) {
      lines.push(piece);
    }
  }
  while (lines.at(-1) === "") lines.pop();
  return lines;
}

/** Return the page of `output` that starts at the 1-based line `offset`. */
export function paginate(output: string, offset = 1): Page {
  const lines = pageLines(output);
  const totalLines = lines.length;
  const start = Math.min(
    Math.max(1, Math.floor(offset)),
    Math.max(totalLines, 1),
  );

  // Every line fits in a page, so a truncated page always shows at least one
  // line and leaves at least one to continue from.
  const truncation = truncateHead(lines.slice(start - 1).join("\n"));
  const endLine = start + truncation.outputLines - 1;

  return {
    content: truncation.content,
    startLine: start,
    endLine,
    totalLines,
    truncated: truncation.truncated,
    truncatedBy: truncation.truncatedBy,
    nextOffset: truncation.truncated ? endLine + 1 : undefined,
  };
}
