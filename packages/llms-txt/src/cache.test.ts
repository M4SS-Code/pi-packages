import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// Redirect the agent dir before any cache call — getAgentDir reads the
// environment at call time.
process.env.PI_CODING_AGENT_DIR = mkdtempSync(join(tmpdir(), "llms-txt-test-"));

const {
  cacheKey,
  extractDomain,
  isMissStatus,
  listCache,
  readCache,
  writeCache,
} = await import("./cache");

describe("extractDomain", () => {
  it("accepts bare domains", () => {
    assert.equal(extractDomain("docs.github.com"), "docs.github.com");
  });

  it("accepts URLs and strips the path", () => {
    assert.equal(
      extractDomain("https://docs.github.com/en/rest"),
      "docs.github.com",
    );
  });

  it("lowercases", () => {
    assert.equal(extractDomain("VUEJS.ORG"), "vuejs.org");
  });

  it("strips paths from bare input", () => {
    assert.equal(extractDomain("example.com/some/path"), "example.com");
  });

  it("punycodes IDN in both forms", () => {
    assert.equal(extractDomain("müller.de"), "xn--mller-kva.de");
    assert.equal(extractDomain("https://müller.de/"), "xn--mller-kva.de");
  });

  it("accepts punycoded IDN TLDs", () => {
    assert.equal(extractDomain("пример.рф"), "xn--e1afmkfd.xn--p1ai");
    assert.equal(
      extractDomain("https://пример.рф/docs"),
      "xn--e1afmkfd.xn--p1ai",
    );
  });

  it("rejects explicit ports in both forms", () => {
    assert.throws(
      () => extractDomain("example.com:8080"),
      /Ports are not supported/,
    );
    assert.throws(
      () => extractDomain("https://example.com:8080/"),
      /Ports are not supported/,
    );
  });

  it("accepts the scheme-default port", () => {
    assert.equal(extractDomain("https://example.com:443/"), "example.com");
  });

  it("rejects localhost, IPs, and single-label names", () => {
    for (const input of [
      "localhost",
      "127.0.0.1",
      "[::1]",
      "https://[::1]/",
      "intranet",
    ]) {
      assert.throws(() => extractDomain(input), input);
    }
  });

  it("rejects garbage", () => {
    assert.throws(() => extractDomain("not a domain"));
    assert.throws(() => extractDomain("example..com"));
    assert.throws(() => extractDomain("-leading.example.com"));
  });
});

describe("isMissStatus", () => {
  it("treats 404 and 410 as misses, nothing else", () => {
    assert.ok(isMissStatus(404));
    assert.ok(isMissStatus(410));
    for (const status of [200, 301, 403, 429, 500]) {
      assert.ok(!isMissStatus(status));
    }
  });
});

describe("cache round-trip", () => {
  const HOUR = 60 * 60 * 1000;

  it("returns fresh hits", () => {
    writeCache("fresh.example", {
      content: "# docs",
      status: 200,
      fetchedAt: Date.now(),
    });
    const hit = readCache("fresh.example");
    assert.equal(hit?.content, "# docs");
    assert.equal(hit?.hit, true);
  });

  it("preserves the truncated flag", () => {
    writeCache("cut.example", {
      content: "# partial",
      status: 200,
      fetchedAt: Date.now(),
      truncated: true,
    });
    assert.equal(readCache("cut.example")?.truncated, true);
  });

  it("expires hits after 24h and deletes the file", () => {
    writeCache("stale.example", {
      content: "# old",
      status: 200,
      fetchedAt: Date.now() - 25 * HOUR,
    });
    assert.equal(readCache("stale.example"), null);
    assert.ok(!existsSync(cacheKey("stale.example")));
  });

  it("keeps misses for 7 days", () => {
    writeCache("missing.example", {
      content: "HTTP 404",
      status: 404,
      fetchedAt: Date.now() - 6 * 24 * HOUR,
    });
    assert.equal(readCache("missing.example")?.status, 404);

    writeCache("long-missing.example", {
      content: "HTTP 404",
      status: 404,
      fetchedAt: Date.now() - 8 * 24 * HOUR,
    });
    assert.equal(readCache("long-missing.example"), null);
  });

  it("treats html-page misses like status misses", () => {
    writeCache("spa.example", {
      content: "HTTP 200 — html page",
      status: 200,
      fetchedAt: Date.now() - 3 * 24 * HOUR,
      miss: true,
    });
    // 3 days old: expired as a hit (24h) but valid as a miss (7d)
    assert.equal(readCache("spa.example")?.miss, true);
  });

  it("lists domains containing .json without stripping the earlier label", () => {
    writeCache("foo.json.com", {
      content: "# docs",
      status: 200,
      fetchedAt: Date.now(),
    });
    assert.ok(listCache().some((entry) => entry.domain === "foo.json.com"));
  });
});
