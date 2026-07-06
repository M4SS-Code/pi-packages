# @m4ss/pi-staan-search

We use Staan's Web Search for AI API because the semantic snippets work well for
our RAG-style usage. This extension registers the `staan_search` tool so the
model can search the web and get enriched result chunks.

## Features

- Web and news search, with semantic enrichment (extra snippets for RAG-style usage)
- Domain filters via `site:domain` or `-domain.tld` in the query
- Market selection for language/region-aware results (default: `fr-fr`)
- Full-content requests that ask Staan for page bodies and reranking

## Install

```bash
pi install npm:@m4ss/pi-staan-search
```

## Usage

Requires `STAAN_API_KEY`:

```bash
export STAAN_API_KEY='your_staan_api_key'
```

```
staan_search("GDPR NIS2 Europe")
staan_search("AI Act", type="news")
staan_search("site:redis.io transactions")
staan_search("PostgreSQL performance", minScore=0.2, maxSnippets=5)
```

## API Key

Get a key at the [Staan console](https://staan.ai/console).

- Free tier: 1,000 requests/month
- Web Search: €1 / 1,000 requests
- Web Search for AI: €2 / 1,000 requests

## Limits

- Queries are capped at 400 characters (API limit). A note is added if truncated.
- Domain filters via `site:` syntax may not work when Staan routes through its fallback provider; `market="fr-fr"` filters reliably.

## Related packages

- [`@m4ss/pi-web-fetch`](../web-fetch/) – fetch the pages that `staan_search` finds
- [`@m4ss/pi-search-delegator`](../search-delegator/) – delegates `staan_search` to the searcher subagent when installed

## License

MIT
