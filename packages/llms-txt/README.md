# @m4ss/pi-llms-txt

Fetch and cache a site's [`llms.txt`](https://llmstxt.org), a curated LLM-friendly
map of a website's most important content, so the model can survey a documentation
site's structure before deep-fetching individual pages. Few sites publish one yet;
when a site doesn't, the tool reports that and moves on. Cache-first, so repeat
lookups are cheap.

## Notes

- Cache-first with 24h TTL for hits; misses (404/410/SPA catch-alls) cached for 7 days.
- Downloaded bodies capped at 40 KB; larger files are truncated with a note.
- Cached files live in `~/.pi/agent/llms-txt-cache/`.

## Install

```bash
pi install npm:@m4ss/pi-llms-txt
```

## Usage

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
