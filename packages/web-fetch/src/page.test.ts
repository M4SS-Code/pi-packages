import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { paginate } from "./page";

function numberedLines(count: number, width = 0): string {
  return Array.from({ length: count }, (_, i) =>
    `line ${i + 1}`.padEnd(width, "."),
  ).join("\n");
}

/** Follow nextOffset from the first page and collect every page. */
function readAllPages(output: string) {
  const pages = [];
  let offset: number | undefined = 1;
  while (offset !== undefined) {
    const page = paginate(output, offset);
    pages.push(page);
    assert.ok(pages.length < 1000, "paging did not terminate");
    offset = page.nextOffset;
  }
  return pages;
}

/** Every line shown across `pages`, in order. */
function pagedLines(pages: ReturnType<typeof readAllPages>): string[] {
  return pages.flatMap((page) => page.content.split("\n"));
}

describe("paginate", () => {
  it("returns short output whole, with no next page", () => {
    const page = paginate("a\nb\nc");
    assert.equal(page.content, "a\nb\nc");
    assert.equal(page.startLine, 1);
    assert.equal(page.endLine, 3);
    assert.equal(page.totalLines, 3);
    assert.equal(page.truncated, false);
    assert.equal(page.nextOffset, undefined);
  });

  it("points a line-limited page at the next line", () => {
    const output = numberedLines(3000);
    const first = paginate(output);
    assert.equal(first.truncated, true);
    assert.equal(first.truncatedBy, "lines");
    assert.equal(first.endLine, 2000);
    assert.equal(first.nextOffset, 2001);

    const second = paginate(output, first.nextOffset);
    assert.equal(second.startLine, 2001);
    assert.equal(second.endLine, 3000);
    assert.equal(second.truncated, false);
    assert.equal(second.nextOffset, undefined);
    assert.match(second.content, /^line 2001$/m);
  });

  it("covers every line exactly once when paging by bytes", () => {
    const output = numberedLines(1500, 200);
    const pages = readAllPages(output);
    assert.ok(pages.length > 1);
    assert.equal(pages[0]?.truncatedBy, "bytes");
    assert.equal(pages.map((page) => page.content).join("\n"), output);
  });

  it("splits a line longer than the byte limit instead of skipping it", () => {
    const huge = "x".repeat(60 * 1024);
    const pages = readAllPages(["before", huge, "after"].join("\n"));
    const lines = pagedLines(pages);

    assert.ok(pages.every((page) => page.content !== ""));
    assert.equal(lines[0], "before");
    assert.equal(lines.at(-1), "after");
    assert.equal(lines.slice(1, -1).join(""), huge);
  });

  it("reads a final over-long line to its end", () => {
    const huge = "x".repeat(60 * 1024);
    const pages = readAllPages(["only", huge].join("\n"));
    const last = pages.at(-1);

    assert.equal(last?.truncated, false);
    assert.equal(last?.endLine, last?.totalLines);
    assert.equal(pagedLines(pages).slice(1).join(""), huge);
  });

  it("keeps multi-byte characters whole when splitting a long line", () => {
    // "€" is 3 bytes and the piece size is not a multiple of 3, so every
    // cut would otherwise land inside a character.
    const huge = "€".repeat(20 * 1024);
    assert.equal(pagedLines(readAllPages(huge)).join(""), huge);
  });

  it("breaks a long line after whitespace when it can", () => {
    const huge = "word ".repeat(12 * 1024 + 1);
    const lines = pagedLines(readAllPages(huge));

    assert.ok(lines.length > 1);
    assert.ok(lines.every((line) => line.endsWith("word ")));
    assert.equal(lines.join(""), huge);
  });

  it("does not count a trailing newline as a line", () => {
    const page = paginate("a\nb\n");
    assert.equal(page.content, "a\nb");
    assert.equal(page.endLine, 2);
    assert.equal(page.totalLines, 2);
  });

  it("clamps out-of-range offsets", () => {
    assert.equal(paginate("a\nb", 0).startLine, 1);
    const pastEnd = paginate("a\nb", 99);
    assert.equal(pastEnd.startLine, 2);
    assert.equal(pastEnd.content, "b");
  });
});
