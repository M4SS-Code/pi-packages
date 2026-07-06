import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  atomicFileWrite,
  looksLikeHtml,
  readBodyBounded,
  timeoutSignal,
} from "./utils";

function streamResponse(chunks: Uint8Array[]): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
  return new Response(stream);
}

describe("readBodyBounded", () => {
  it("returns small bodies whole", async () => {
    const body = await readBodyBounded(
      streamResponse([new TextEncoder().encode("hello")]),
      100,
    );
    assert.deepEqual(body, { text: "hello", truncated: false });
  });

  it("does not flag a body of exactly the cap", async () => {
    const data = new TextEncoder().encode("x".repeat(100));
    const body = await readBodyBounded(
      streamResponse([data.subarray(0, 60), data.subarray(60)]),
      100,
    );
    assert.equal(body.text.length, 100);
    assert.equal(body.truncated, false);
  });

  it("cuts and flags bodies over the cap", async () => {
    const data = new TextEncoder().encode("y".repeat(150));
    const body = await readBodyBounded(
      streamResponse([data.subarray(0, 80), data.subarray(80)]),
      100,
    );
    assert.equal(body.text.length, 100);
    assert.equal(body.truncated, true);
  });

  it("survives a multi-byte character straddling the cap", async () => {
    // "é" is 2 bytes; cap lands in the middle of the final one
    const data = new TextEncoder().encode("aaaé");
    const body = await readBodyBounded(streamResponse([data]), 4);
    assert.equal(body.truncated, true);
    assert.ok(body.text.startsWith("aaa"));
  });
});

describe("looksLikeHtml", () => {
  const html = [
    "<!doctype html><html></html>",
    '<html lang="en"><head></head></html>',
    '  \n<head><meta charset="utf-8"></head>',
    "<!-- spa shell --><html></html>",
    '<meta charset="utf-8">',
    "<body>app</body>",
  ];
  for (const text of html) {
    it(`detects ${JSON.stringify(text.slice(0, 24))}`, () => {
      assert.ok(looksLikeHtml(text));
    });
  }

  const notHtml = [
    "# Docs\n\n> An llms.txt file",
    "plain text",
    "<3 markdown with an angle bracket",
  ];
  for (const text of notHtml) {
    it(`passes ${JSON.stringify(text.slice(0, 24))}`, () => {
      assert.ok(!looksLikeHtml(text));
    });
  }
});

describe("atomicFileWrite", () => {
  it("writes and overwrites, creating directories", () => {
    const dir = mkdtempSync(join(tmpdir(), "llms-txt-utils-test-"));
    const target = join(dir, "nested", "file.json");
    atomicFileWrite(target, "one");
    assert.equal(readFileSync(target, "utf8"), "one");
    atomicFileWrite(target, "two");
    assert.equal(readFileSync(target, "utf8"), "two");
  });
});

describe("timeoutSignal", () => {
  it("forwards an already-aborted parent immediately", () => {
    const parent = new AbortController();
    parent.abort(new Error("stop"));
    const timeout = timeoutSignal(parent.signal, 1000);
    assert.ok(timeout.signal.aborted);
    assert.equal(timeout.timedOut, false);
    timeout.cleanup();
  });

  it("forwards a later parent abort", () => {
    const parent = new AbortController();
    const timeout = timeoutSignal(parent.signal, 1000);
    assert.ok(!timeout.signal.aborted);
    parent.abort();
    assert.ok(timeout.signal.aborted);
    timeout.cleanup();
  });

  it("fires on timeout and sets timedOut", async () => {
    const timeout = timeoutSignal(undefined, 10);
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.ok(timeout.signal.aborted);
    assert.equal(timeout.timedOut, true);
    timeout.cleanup();
  });
});
