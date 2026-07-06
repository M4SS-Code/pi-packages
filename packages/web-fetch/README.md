# @m4ss/pi-web-fetch

We built this so the model can fetch web pages and get clean Markdown instead of
raw HTML. It converts HTML automatically, blocks private network addresses, and
caps response size to keep things manageable.

## Features

- Fetches any HTTP/HTTPS URL and converts HTML to clean Markdown (JSON is pretty-printed)
- Blocks private network addresses (localhost, RFC 1918, link-local); every redirect hop is validated, so a redirect can't bounce into an internal address
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

Blocks private/internal addresses (localhost, RFC 1918, link-local) on all redirect hops (max 5, each validated).

The check runs on the URL's hostname, so it does not defend against DNS
rebinding — a hostile public hostname that resolves to a private address gets
through (that would require a pinned resolver). Treat the guard as protection
against accidental internal access, not as a hard security boundary; don't
rely on it to isolate a machine that can reach sensitive internal services.

## Related packages

- [`@m4ss/pi-staan-search`](../staan-search/) – search for URLs, then fetch them with `web_fetch`
- [`@m4ss/pi-llms-txt`](../llms-txt/) – discover important pages from `llms.txt`, then fetch with `web_fetch`
- [`@m4ss/pi-search-delegator`](../search-delegator/) – delegates `web_fetch` to the searcher subagent when installed

## License

MIT
