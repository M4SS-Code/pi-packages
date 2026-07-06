# @m4ss/pi-staan-search

We use Staan's Web Search for AI API because the semantic snippets work well for
our RAG-style usage. This extension registers the `staan_search` tool so the
model can search the web and get enriched result chunks.

## Features

- Web and news search with semantic enrichment (extra snippets for RAG-style usage)
- Domain filters via `site:domain` or `-domain.tld` in the query
- Market selection for language/region-aware results (default: `fr-fr`)
- Full-content requests that ask Staan for page bodies and reranking

## Install

```bash
pi install npm:@m4ss/pi-staan-search
```

## Usage

Set your API key:

```bash
export STAAN_API_KEY='your_staan_api_key'
```

The LLM will automatically see `staan_search` as an available tool. Example calls:

- `staan_search("GDPR NIS2 Europe")` – Web Search for AI using the default `fr-fr` market
- `staan_search("AI Act", type="news")` – plain news search
- `staan_search("site:redis.io transactions")` – narrow to a specific domain
- `staan_search("PostgreSQL performance", minScore=0.2, maxSnippets=5)` – RAG-ready chunks

## API Key

Get a key at [staan.ai](https://staan.ai) → Developer Console.

- Free tier: 1,000 requests/month
- Web Search: €1 / 1,000 requests
- Web Search for AI: €2 / 1,000 requests

## Routing, privacy, and fallback behavior

- `fr-fr` (default) prefers the European/Staan-backed route.
- `en-us` may use fallback/non-EU infrastructure and domain filters (`site:`) may not work on fallback-routed markets.
- For compliance-sensitive use, verify Staan's DPA/subprocessors and request EU-only routing.

## Limits

- Queries are capped at 400 characters (API limit). A note is added if truncated.
- Domain filters via `site:` syntax may not work when Staan routes through its fallback provider; use `market="fr-fr"` for reliable filtering.
- Pagination supports offsets of 0, 10, 20, or 30 (10 results per page).
- Web searches use semantic enrichment by default. Set `extraSnippets=false` for plain Web Search.
- All API calls use a 10s timeout.

## Related packages

- [`@m4ss/pi-web-fetch`](../web-fetch/) – fetch the pages that `staan_search` finds
- [`@m4ss/pi-search-delegator`](../search-delegator/) – delegates `staan_search` to the searcher subagent when installed

## License

MIT
