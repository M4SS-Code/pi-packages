# @m4ss/pi-web-fetch

We built this so the model can fetch web pages and get clean Markdown instead of
raw HTML. It converts HTML automatically, blocks private network addresses, and
caps response size to keep things manageable.

## Features

- Fetches any HTTP/HTTPS URL and converts HTML to clean Markdown (JSON is pretty-printed)
- Asks for `text/markdown` first, so sites that publish Markdown for agents skip the HTML conversion
- Blocks private network addresses by hostname (localhost, RFC 1918, link-local, CGNAT, IPv6 ULA); the initial URL and every redirect hop are re-validated — see [Private networks](#private-networks) for scope and the DNS-rebinding limitation
- Follows instant meta-refresh redirects (the stub pages static site generators emit)
- 10s default timeout, overrideable per call; large responses capped at 5MB

## Install

```bash
pi install npm:@m4ss/pi-web-fetch
```

## Usage

```
web_fetch(url="https://www.postgresql.org/docs/current/", format="markdown")
web_fetch(url="https://redis.io/docs/latest/", format="html")
web_fetch(url="https://api.github.com/repos/M4SS-Code/watermelon/contents")
web_fetch(url="https://example.com/slow", timeoutMs=20000)
```

## Private networks

The initial URL and every redirect hop (HTTP 3xx or meta-refresh; max 5, each
re-validated) is checked by hostname and refused when it names a private or
internal address: `localhost` and other single-label hostnames, RFC 1918,
loopback, link-local (including the 169.254/16 cloud-metadata range), CGNAT,
and IPv6 loopback/link-local/ULA. Numeric host forms are normalized first, so
`http://0x7f000001/` and `http://2130706433/` are refused too.

The check runs on the URL's _hostname_, not on the resolved address, so it
does not defend against DNS rebinding: a hostile public hostname that resolves
to a private address gets through (closing that would require a pinned
resolver that validates and uses the resolved IP). Treat the guard as
protection against accidental internal access, not as a hard security
boundary; don't rely on it to isolate a machine that can reach sensitive
internal services.

## Related packages

- [`@m4ss/pi-staan-search`](../staan-search/) – search for URLs, then fetch them with `web_fetch`
- [`@m4ss/pi-llms-txt`](../llms-txt/) – discover important pages from `llms.txt`, then fetch with `web_fetch`
- [`@m4ss/pi-search-delegator`](../search-delegator/) – delegates `web_fetch` to the searcher subagent when installed

## License

MIT
