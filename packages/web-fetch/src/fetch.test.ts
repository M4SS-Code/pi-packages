import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  assertPublicTarget,
  charsetFromContentType,
  classifyContentType,
  fencedCodeBlock,
  fetchUrl,
  htmlToMarkdown,
  inlineCodeSpan,
  maxBacktickRun,
  metaRefreshTarget,
  parseHttpUrl,
  preprocessHtml,
  readTextWithLimit,
} from "./fetch";

describe("parseHttpUrl", () => {
  it("accepts http and https", () => {
    assert.equal(parseHttpUrl("https://example.com/a").hostname, "example.com");
    assert.equal(parseHttpUrl("http://example.com").hostname, "example.com");
  });

  it("rejects other schemes", () => {
    assert.throws(() => parseHttpUrl("ftp://example.com"), /http/);
    assert.throws(() => parseHttpUrl("file:///etc/passwd"), /http/);
  });

  it("rejects invalid URLs", () => {
    assert.throws(() => parseHttpUrl("not a url"), /Invalid URL/);
  });

  it("rejects embedded credentials", () => {
    assert.throws(
      () => parseHttpUrl("https://user:pass@example.com/"),
      /credentials/,
    );
    assert.throws(
      () => parseHttpUrl("https://user@example.com/"),
      /credentials/,
    );
  });
});

describe("assertPublicTarget", () => {
  const refused = [
    "http://127.0.0.1/",
    "http://127.1.2.3:8080/",
    "http://0.0.0.0/",
    "http://10.0.0.1/",
    "http://100.64.0.1/",
    "http://169.254.169.254/latest/meta-data/",
    "http://172.16.0.1/",
    "http://172.31.255.255/",
    "http://192.168.1.1/",
    "http://224.0.0.1/",
    // WHATWG URL normalizes numeric hosts to a dotted quad
    "http://0x7f000001/",
    "http://2130706433/",
    "http://[::1]/",
    "http://[::]/",
    "http://[fe80::1]/",
    "http://[fd00::1]/",
    "http://[::ffff:127.0.0.1]/",
    "http://[::ffff:10.0.0.1]/",
    "http://localhost/",
    "http://app.localhost/",
    "http://printer.local/",
    "http://intranet/",
  ];
  for (const url of refused) {
    it(`refuses ${url}`, () => {
      assert.throws(
        () => assertPublicTarget(new URL(url)),
        /Refusing to fetch/,
      );
    });
  }

  const allowed = [
    "https://example.com/",
    "http://8.8.8.8/",
    "http://172.32.0.1/", // just outside 172.16/12
    "http://100.128.0.1/", // just outside 100.64/10
    "https://[2606:4700::1111]/",
    "https://sub.domain.example.co.uk/path?q=1",
  ];
  for (const url of allowed) {
    it(`allows ${url}`, () => {
      assertPublicTarget(new URL(url));
    });
  }
});

describe("classifyContentType", () => {
  it("classifies the common types", () => {
    assert.deepEqual(classifyContentType("text/html; charset=utf-8"), {
      isHtml: true,
      isText: true,
      isJson: false,
      isXml: false,
    });
    assert.ok(classifyContentType("application/json").isJson);
    assert.ok(classifyContentType("application/vnd.api+json").isJson);
    assert.ok(classifyContentType("application/xml").isXml);
    assert.ok(classifyContentType("image/svg+xml").isXml);
    assert.ok(classifyContentType("text/plain").isText);
    const image = classifyContentType("image/png");
    assert.ok(!image.isHtml && !image.isText && !image.isJson && !image.isXml);
  });
});

describe("charsetFromContentType", () => {
  it("extracts the charset parameter", () => {
    assert.equal(charsetFromContentType("text/html; charset=utf-8"), "utf-8");
    assert.equal(
      charsetFromContentType('text/html; charset="iso-8859-1"'),
      "iso-8859-1",
    );
    assert.equal(charsetFromContentType("text/plain"), undefined);
  });
});

describe("markdown fencing", () => {
  it("finds the longest backtick run", () => {
    assert.equal(maxBacktickRun("no ticks"), 0);
    assert.equal(maxBacktickRun("a `b` ``c`` d"), 2);
  });

  it("fences with more backticks than the content", () => {
    assert.equal(fencedCodeBlock("plain"), "\n\n```\nplain\n```\n\n");
    assert.ok(fencedCodeBlock("has ``` fence").startsWith("\n\n````\n"));
  });

  it("annotates the language", () => {
    assert.equal(fencedCodeBlock("x", "rust"), "\n\n```rust\nx\n```\n\n");
  });

  it("pads inline code that touches backticks", () => {
    assert.equal(inlineCodeSpan("plain"), "`plain`");
    assert.equal(inlineCodeSpan("`tick"), "`` `tick ``");
  });

  it("handles a large run count without throwing", () => {
    const text = "`x".repeat(200_000);
    assert.equal(maxBacktickRun(text), 1);
  });
});

describe("readTextWithLimit", () => {
  function response(body: Uint8Array | string, contentType?: string): Response {
    const data =
      typeof body === "string" ? new TextEncoder().encode(body) : body;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(data);
        controller.close();
      },
    });
    return new Response(stream, {
      headers: contentType ? { "content-type": contentType } : {},
    });
  }

  it("decodes with the header charset", async () => {
    const body = new Uint8Array([0x63, 0x61, 0x66, 0xe9]); // "café" in latin-1
    const { text } = await readTextWithLimit(
      response(body, "text/plain; charset=iso-8859-1"),
    );
    assert.equal(text, "café");
  });

  it("sniffs a meta charset when the html header lacks one", async () => {
    const head = '<meta charset="iso-8859-1"><p>caf';
    const body = new Uint8Array([...new TextEncoder().encode(head), 0xe9]);
    const { text } = await readTextWithLimit(response(body, "text/html"));
    assert.ok(text.endsWith("café") || text.endsWith("café"));
  });

  it("defaults to utf-8 otherwise", async () => {
    const { text } = await readTextWithLimit(response("héllo", "text/plain"));
    assert.equal(text, "héllo");
  });

  it("caps the read and reports truncation", async () => {
    const { text, inputTruncated } = await readTextWithLimit(
      response("x".repeat(50)),
      10,
    );
    assert.equal(text.length, 10);
    assert.equal(inputTruncated, true);
  });

  it("does not flag a body of exactly the cap", async () => {
    const { text, inputTruncated } = await readTextWithLimit(
      response("x".repeat(10)),
      10,
    );
    assert.equal(text.length, 10);
    assert.equal(inputTruncated, false);
  });
});

describe("metaRefreshTarget", () => {
  it("finds a hugo-style alias stub", () => {
    const html =
      '<!DOCTYPE html><html lang="en"><head><title>https://example.com/new/</title>' +
      '<link rel="canonical" href="https://example.com/new/">' +
      '<meta name="robots" content="noindex">' +
      '<meta charset="utf-8">' +
      '<meta http-equiv="refresh" content="0; url=https://example.com/new/">' +
      "</head></html>";
    assert.equal(metaRefreshTarget(html), "https://example.com/new/");
  });

  it("accepts relative urls, a comma separator, and no url= prefix", () => {
    assert.equal(
      metaRefreshTarget('<meta http-equiv="refresh" content="0; url=../new/">'),
      "../new/",
    );
    assert.equal(
      metaRefreshTarget('<meta http-equiv="refresh" content="0, url=/new">'),
      "/new",
    );
    assert.equal(
      metaRefreshTarget('<meta http-equiv="refresh" content="0;/new">'),
      "/new",
    );
  });

  it("is case- and attribute-order-insensitive", () => {
    assert.equal(
      metaRefreshTarget('<META CONTENT="0;URL=/x" HTTP-EQUIV="REFRESH">'),
      "/x",
    );
    assert.equal(
      metaRefreshTarget("<meta http-equiv=refresh content=0;url=/x>"),
      "/x",
    );
  });

  it("strips quotes around the url inside the content value", () => {
    assert.equal(
      metaRefreshTarget('<meta http-equiv="refresh" content="0; url=\'/x\'">'),
      "/x",
    );
  });

  it("ignores delayed refreshes", () => {
    assert.equal(
      metaRefreshTarget('<meta http-equiv="refresh" content="5; url=/x">'),
      undefined,
    );
  });

  it("ignores refreshes without a url", () => {
    assert.equal(
      metaRefreshTarget('<meta http-equiv="refresh" content="0">'),
      undefined,
    );
  });

  it("ignores commented-out and scripted markup", () => {
    assert.equal(
      metaRefreshTarget(
        '<!-- <meta http-equiv="refresh" content="0;url=/old"> --><p>hi</p>',
      ),
      undefined,
    );
    assert.equal(
      metaRefreshTarget(
        '<script>document.write(\'<meta http-equiv="refresh" content="0;url=/js">\')</script>',
      ),
      undefined,
    );
  });

  it("ignores unrelated meta tags", () => {
    assert.equal(
      metaRefreshTarget('<meta name="description" content="0; url=/x">'),
      undefined,
    );
  });
});

describe("fetchUrl redirects", () => {
  function page(url: string, body: string, init?: ResponseInit): Response {
    const response = new Response(body, {
      headers: { "content-type": "text/html; charset=utf-8" },
      ...init,
    });
    // Response.url is read-only and empty on constructed instances
    Object.defineProperty(response, "url", { value: url });
    return response;
  }

  function redirect(url: string, status: number, location: string): Response {
    const response = new Response(null, {
      status,
      headers: { location },
    });
    Object.defineProperty(response, "url", { value: url });
    return response;
  }

  async function withFetchStub(
    routes: Record<string, () => Response>,
    fn: () => Promise<void>,
  ): Promise<void> {
    const original = globalThis.fetch;
    globalThis.fetch = (async (input: URL | RequestInfo) => {
      const url = input.toString();
      const route = routes[url];
      if (!route) throw new Error(`no stub route for ${url}`);
      return route();
    }) as typeof fetch;
    try {
      await fn();
    } finally {
      globalThis.fetch = original;
    }
  }

  const stub = (target: string) =>
    `<html><head><meta http-equiv="refresh" content="0; url=${target}"></head>` +
    "<body>Redirecting…</body></html>";

  it("follows an instant meta refresh and reports the chain", async () => {
    await withFetchStub(
      {
        "https://site.example/docs/old/": () =>
          page("https://site.example/docs/old/", stub("../new/")),
        "https://site.example/docs/new/": () =>
          page("https://site.example/docs/new/", "<h1>Arrived</h1>"),
      },
      async () => {
        const result = await fetchUrl({
          url: "https://site.example/docs/old/",
          userAgent: "test",
        });
        assert.equal(result.finalUrl, "https://site.example/docs/new/");
        assert.deepEqual(result.redirectChain, [
          { via: "meta refresh", url: "https://site.example/docs/new/" },
        ]);
        assert.match(result.output, /# Arrived/);
        assert.match(
          result.output,
          /Redirected \(meta refresh\) to: https:\/\/site\.example\/docs\/new\//,
        );
      },
    );
  });

  it("chains http and meta refresh hops", async () => {
    await withFetchStub(
      {
        "https://a.example/": () =>
          redirect("https://a.example/", 301, "https://b.example/"),
        "https://b.example/": () =>
          page("https://b.example/", stub("https://c.example/")),
        "https://c.example/": () => page("https://c.example/", "<p>done</p>"),
      },
      async () => {
        const result = await fetchUrl({
          url: "https://a.example/",
          userAgent: "test",
        });
        assert.deepEqual(result.redirectChain, [
          { via: "HTTP 301", url: "https://b.example/" },
          { via: "meta refresh", url: "https://c.example/" },
        ]);
        assert.equal(result.finalUrl, "https://c.example/");
      },
    );
  });

  it("refuses a meta refresh into a private address", async () => {
    await withFetchStub(
      {
        "https://evil.example/": () =>
          page("https://evil.example/", stub("http://169.254.169.254/latest/")),
      },
      async () => {
        await assert.rejects(
          fetchUrl({ url: "https://evil.example/", userAgent: "test" }),
          /Refusing to fetch/,
        );
      },
    );
  });

  it("caps meta refresh hops like http redirects", async () => {
    const routes: Record<string, () => Response> = {};
    for (let i = 0; i <= 6; i++) {
      const url = `https://loop.example/${i}`;
      routes[url] = () => page(url, stub(`/${i + 1}`));
    }
    await withFetchStub(routes, async () => {
      await assert.rejects(
        fetchUrl({ url: "https://loop.example/0", userAgent: "test" }),
        /Too many redirects/,
      );
    });
  });

  it("serves a page that refreshes to itself instead of looping", async () => {
    await withFetchStub(
      {
        "https://self.example/": () =>
          page(
            "https://self.example/",
            '<meta http-equiv="refresh" content="0; url=https://self.example/"><p>live</p>',
          ),
      },
      async () => {
        const result = await fetchUrl({
          url: "https://self.example/",
          userAgent: "test",
        });
        assert.deepEqual(result.redirectChain, []);
        assert.match(result.output, /live/);
      },
    );
  });

  it("does not follow a delayed refresh", async () => {
    await withFetchStub(
      {
        "https://slow.example/": () =>
          page(
            "https://slow.example/",
            '<meta http-equiv="refresh" content="5; url=/elsewhere"><p>content</p>',
          ),
      },
      async () => {
        const result = await fetchUrl({
          url: "https://slow.example/",
          userAgent: "test",
        });
        assert.deepEqual(result.redirectChain, []);
        assert.match(result.output, /content/);
      },
    );
  });
});

describe("preprocessHtml + htmlToMarkdown", () => {
  it("absolutizes relative links against the response url", () => {
    const doc = preprocessHtml(
      '<a href="/docs/intro">intro</a>',
      "https://example.com/base/page",
    );
    assert.equal(
      doc.querySelector("a")?.getAttribute("href"),
      "https://example.com/docs/intro",
    );
  });

  it("honors a base href", () => {
    const doc = preprocessHtml(
      '<base href="https://cdn.example.org/root/"><a href="page">x</a>',
      "https://example.com/",
    );
    assert.equal(
      doc.querySelector("a")?.getAttribute("href"),
      "https://cdn.example.org/root/page",
    );
  });

  it("strips scripts and styles", () => {
    const doc = preprocessHtml(
      "<script>evil()</script><style>p{}</style><p>text</p>",
      "https://example.com/",
    );
    assert.equal(doc.querySelector("script"), null);
    assert.equal(doc.querySelector("style"), null);
    assert.equal(doc.querySelector("p")?.textContent, "text");
  });

  it("converts the prepared document straight to markdown", () => {
    const doc = preprocessHtml(
      '<h1>Title</h1><p>Read <a href="/more">more</a>.</p>',
      "https://example.com/",
    );
    const markdown = htmlToMarkdown(doc);
    assert.match(markdown, /# Title/);
    assert.match(markdown, /\[more\]\(https:\/\/example\.com\/more\)/);
  });

  it("keeps the code language on fenced blocks", () => {
    const doc = preprocessHtml(
      '<pre><code class="language-rust">fn main() {}</code></pre>',
      "https://example.com/",
    );
    assert.match(htmlToMarkdown(doc), /```rust\nfn main\(\) \{\}\n```/);
  });
});
