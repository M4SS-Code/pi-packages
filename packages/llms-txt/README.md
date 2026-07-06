# @m4ss/pi-llms-txt

We built this to let the model discover a site's structure before diving into
individual pages. It fetches and caches `llms.txt` from documentation sites
using a cache-first strategy.

The [`llms.txt`](https://llmstxt.org) standard is a curated, LLM-friendly map of a
website's most important content. Not many sites publish one yet, but when they do,
this extension gives the model a site map before it starts fetching pages. For sites
that don't publish `llms.txt`, the tool reports it and moves on.

## Notes

- Cache-first with 24h TTL for hits; misses (404/410/SPA catch-alls) cached for 7 days.
- Downloaded bodies capped at 40 KB; larger files are truncated with a note.
- Cached files live in `~/.pi/agent/llms-txt-cache/`.

## Install

```bash
pi install npm:@m4ss/pi-llms-txt
```

## Usage

The LLM calls `llms_txt` on its own. You can also invoke it directly:

```
llms_txt("www.postgresql.org")
llms_txt("redis.io", forceRefresh=true)
```

## Commands

| Command          | Action                               |
| ---------------- | ------------------------------------ |
| `/llmstxt`       | Show cached domains and cache status |
| `/llmstxt-clear` | Flush all cached llms.txt files      |

## Related packages

- [`@m4ss/pi-web-fetch`](../web-fetch/) – use `llms.txt` to discover important pages, then fetch them with `web_fetch`
- [`@m4ss/pi-search-delegator`](../search-delegator/) – delegates `llms_txt` to the searcher subagent when installed

## License

MIT
