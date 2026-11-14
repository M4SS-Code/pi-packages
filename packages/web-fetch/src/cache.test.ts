import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { RECENT_FETCH_LIMIT, createRecentFetches } from "./cache";
import type { FetchUrlResult } from "./fetch";

const URL_A = "https://example.com/a";
const URL_B = "https://example.com/b";
const URL_C = "https://example.com/c";

function fakeResult(output: string): FetchUrlResult {
  return {
    requestedUrl: URL_A,
    finalUrl: URL_A,
    redirectChain: [],
    status: 200,
    contentType: "text/plain",
    format: "markdown",
    timeoutMs: 10_000,
    inputTruncated: false,
    metadataNotes: [],
    output,
  };
}

/** A fetcher that counts its calls and returns a new result on each one. */
function countingFetcher() {
  let calls = 0;
  return {
    fetchFresh: async () => fakeResult(`download ${++calls}`),
    get calls() {
      return calls;
    },
  };
}

describe("createRecentFetches", () => {
  it("fetches a first part even when the document is remembered", async () => {
    const recentFetches = createRecentFetches();
    const fetcher = countingFetcher();

    await recentFetches.load(URL_A, "markdown", 1, fetcher.fetchFresh);
    const again = await recentFetches.load(
      URL_A,
      "markdown",
      1,
      fetcher.fetchFresh,
    );
    assert.equal(fetcher.calls, 2);
    assert.equal(again.result.output, "download 2");

    // Later parts follow the newest download
    const later = await recentFetches.load(
      URL_A,
      "markdown",
      2001,
      fetcher.fetchFresh,
    );
    assert.equal(fetcher.calls, 2);
    assert.equal(later, again);
  });

  it("serves a later part from memory", async () => {
    const recentFetches = createRecentFetches();
    const fetcher = countingFetcher();

    const first = await recentFetches.load(
      URL_A,
      "markdown",
      1,
      fetcher.fetchFresh,
    );
    first.fullPath = "/tmp/page.md";
    const later = await recentFetches.load(
      URL_A,
      "markdown",
      2001,
      fetcher.fetchFresh,
    );

    assert.equal(fetcher.calls, 1);
    assert.equal(later.result, first.result);
    // The same entry, so the full-output file is written once per document
    assert.equal(later.fullPath, "/tmp/page.md");
  });

  it("fetches a later part of a document it does not remember", async () => {
    const recentFetches = createRecentFetches();
    const fetcher = countingFetcher();

    await recentFetches.load(URL_A, "markdown", 2001, fetcher.fetchFresh);
    assert.equal(fetcher.calls, 1);

    await recentFetches.load(URL_A, "markdown", 4001, fetcher.fetchFresh);
    assert.equal(fetcher.calls, 1);
  });

  it("keeps the formats of one URL apart", async () => {
    const recentFetches = createRecentFetches();
    const fetcher = countingFetcher();

    await recentFetches.load(URL_A, "markdown", 1, fetcher.fetchFresh);
    const html = await recentFetches.load(
      URL_A,
      "html",
      2001,
      fetcher.fetchFresh,
    );
    assert.equal(fetcher.calls, 2);
    assert.equal(html.result.output, "download 2");

    const markdown = await recentFetches.load(
      URL_A,
      "markdown",
      2001,
      fetcher.fetchFresh,
    );
    assert.equal(fetcher.calls, 2);
    assert.equal(markdown.result.output, "download 1");
  });

  it("drops the least recently used document past the limit", async () => {
    const recentFetches = createRecentFetches();
    const fetcher = countingFetcher();
    const url = (i: number) => `https://example.com/${i}`;

    for (let i = 0; i <= RECENT_FETCH_LIMIT; i++) {
      await recentFetches.load(url(i), "markdown", 1, fetcher.fetchFresh);
    }
    assert.equal(fetcher.calls, RECENT_FETCH_LIMIT + 1);

    // Everything but the first document is still there
    for (let i = 1; i <= RECENT_FETCH_LIMIT; i++) {
      await recentFetches.load(url(i), "markdown", 2001, fetcher.fetchFresh);
    }
    assert.equal(fetcher.calls, RECENT_FETCH_LIMIT + 1);

    await recentFetches.load(url(0), "markdown", 2001, fetcher.fetchFresh);
    assert.equal(fetcher.calls, RECENT_FETCH_LIMIT + 2);
  });

  it("counts reading a later part as a use", async () => {
    const recentFetches = createRecentFetches(2);
    const fetcher = countingFetcher();

    await recentFetches.load(URL_A, "markdown", 1, fetcher.fetchFresh);
    await recentFetches.load(URL_B, "markdown", 1, fetcher.fetchFresh);
    // A is now the more recent of the two, so C pushes B out
    await recentFetches.load(URL_A, "markdown", 2001, fetcher.fetchFresh);
    await recentFetches.load(URL_C, "markdown", 1, fetcher.fetchFresh);
    assert.equal(fetcher.calls, 3);

    await recentFetches.load(URL_A, "markdown", 4001, fetcher.fetchFresh);
    assert.equal(fetcher.calls, 3);

    await recentFetches.load(URL_B, "markdown", 2001, fetcher.fetchFresh);
    assert.equal(fetcher.calls, 4);
  });

  it("passes a failed fetch on and remembers nothing for it", async () => {
    const recentFetches = createRecentFetches();
    const fetcher = countingFetcher();

    await assert.rejects(
      recentFetches.load(URL_A, "markdown", 1, async () => {
        throw new Error("HTTP 500");
      }),
      /HTTP 500/,
    );

    await recentFetches.load(URL_A, "markdown", 2001, fetcher.fetchFresh);
    assert.equal(fetcher.calls, 1);
  });
});
