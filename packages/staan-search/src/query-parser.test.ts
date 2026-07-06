import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  clamp,
  extractDorks,
  normalizeOffset,
  sanitizeQuery,
} from "./query-parser";

describe("extractDorks", () => {
  it("extracts a site: include", () => {
    const result = extractDorks("rust async site:docs.rs");
    assert.deepEqual(result, {
      query: "rust async",
      includeDomains: ["docs.rs"],
      excludeDomains: [],
    });
  });

  it("extracts multi-label domains whole", () => {
    const result = extractDorks("api site:docs.github.com");
    assert.deepEqual(result.includeDomains, ["docs.github.com"]);
    assert.equal(result.query, "api");
  });

  it("extracts -site: excludes", () => {
    const result = extractDorks("-site:reddit.com rust");
    assert.deepEqual(result.excludeDomains, ["reddit.com"]);
    assert.equal(result.query, "rust");
  });

  it("extracts bare -domain excludes", () => {
    const result = extractDorks("prompt caching -reddit.com -medium.com");
    assert.deepEqual(result.excludeDomains, ["reddit.com", "medium.com"]);
    assert.equal(result.query, "prompt caching");
  });

  it("lowercases and dedupes domains", () => {
    const result = extractDorks("x site:Docs.RS site:docs.rs");
    assert.deepEqual(result.includeDomains, ["docs.rs"]);
  });

  it("keeps both lists when include and exclude are present", () => {
    const result = extractDorks("x site:a.com -b.com");
    assert.deepEqual(result.includeDomains, ["a.com"]);
    assert.deepEqual(result.excludeDomains, ["b.com"]);
  });

  it("ignores hyphenated words that are not domains", () => {
    const result = extractDorks("foo -bar baz");
    assert.deepEqual(result.excludeDomains, []);
    assert.equal(result.query, "foo -bar baz");
  });

  it("does not match a hyphen inside a word", () => {
    const result = extractDorks("5-10.com deals");
    assert.deepEqual(result.excludeDomains, []);
    assert.equal(result.query, "5-10.com deals");
  });

  it("does not treat mysite: as a site: dork", () => {
    const result = extractDorks("mysite:example.com");
    assert.deepEqual(result.includeDomains, []);
  });

  // Documents current behavior: any "-word.tld" token parses as an exclusion,
  // and trailing sentence punctuation survives in the cleaned query.
  it("treats -node.js as a domain exclusion", () => {
    const result = extractDorks("javascript -node.js runtime");
    assert.deepEqual(result.excludeDomains, ["node.js"]);
  });
  it("leaves trailing punctuation behind", () => {
    const result = extractDorks("avoid -reddit.com.");
    assert.deepEqual(result.excludeDomains, ["reddit.com"]);
    assert.equal(result.query, "avoid .");
  });
});

describe("sanitizeQuery", () => {
  it("trims whitespace", () => {
    assert.equal(sanitizeQuery("  hello  ", []), "hello");
  });

  it("throws on an empty query", () => {
    assert.throws(() => sanitizeQuery("   ", []), /cannot be empty/);
  });

  it("caps at 400 characters with a note", () => {
    const notes: string[] = [];
    const result = sanitizeQuery("x".repeat(500), notes);
    assert.equal(result.length, 400);
    assert.equal(notes.length, 1);
    assert.match(notes[0]!, /truncated to 400/);
  });
});

describe("normalizeOffset", () => {
  it("passes through undefined and NaN", () => {
    assert.equal(normalizeOffset(undefined, []), undefined);
    assert.equal(normalizeOffset(Number.NaN, []), undefined);
  });

  it("keeps allowed values without a note", () => {
    for (const offset of [0, 10, 20, 30]) {
      const notes: string[] = [];
      assert.equal(normalizeOffset(offset, notes), offset);
      assert.equal(notes.length, 0);
    }
  });

  it("snaps to the nearest allowed value with a note", () => {
    const cases: Array<[number, number]> = [
      [14, 10],
      [15, 20],
      [35, 30],
      [-5, 0],
      [Number.POSITIVE_INFINITY, 30],
    ];
    for (const [input, expected] of cases) {
      const notes: string[] = [];
      assert.equal(normalizeOffset(input, notes), expected);
      assert.equal(notes.length, 1);
    }
  });
});

describe("clamp", () => {
  it("clamps to the range", () => {
    assert.equal(clamp(5, 0, 10), 5);
    assert.equal(clamp(-1, 0, 10), 0);
    assert.equal(clamp(11, 0, 10), 10);
  });
});
