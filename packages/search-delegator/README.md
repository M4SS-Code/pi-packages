# @m4ss/pi-search-delegator

We designed this to keep your main model's context clean. The extension removes
`staan_search`, `web_fetch`, and `llms_txt` from the main model and forces it to
delegate web research to a focused **searcher** subagent instead.

The searcher runs headless, does the web work, and returns a compact summary with
source URLs, keeping the main context uncluttered. This also lets you run the
searcher on a cheaper model.

Delegating web work to the searcher:

```
subagent({
  agent: "searcher",
  task: "Find the latest GDPR NIS2 and AI Act requirements for companies in Europe; return key obligations, dates, source URLs."
})
```

`curl`, `wget`, and other shell commands are **not** blocked.

## Related packages

- [`@m4ss/pi-staan-search`](../staan-search/) – provides the `staan_search` tool
- [`@m4ss/pi-web-fetch`](../web-fetch/) – provides the `web_fetch` tool
- [`@m4ss/pi-llms-txt`](../llms-txt/) – provides the `llms_txt` tool

## Install

```bash
pi install npm:pi-subagents
pi install npm:@m4ss/pi-search-delegator
```

It creates `~/.pi/agent/agents/searcher.md` and blocks the web tools at session start.

## Commands

| Command             | Action              |
| ------------------- | ------------------- |
| `/search-delegator` | Show current status |

## Configuration

Config file: `~/.pi/agent/search-delegator.json` (missing fields fall back to defaults).

| Field                    | Default                                     | Description                                                                                                                     |
| ------------------------ | ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `blocked_tools`          | `["staan_search", "web_fetch", "llms_txt"]` | Tool names removed from the main model and granted to the searcher                                                              |
| `searcher_subagent_name` | `"searcher"`                                | Subagent name (must match the `.md`)                                                                                            |
| `searcher_model`         | `""`                                        | Model for the searcher (`provider/model`). Empty = inherit parent's default. Set a cheap model to keep web research inexpensive |

The `searcher.md` template is regenerated whenever the config changes. If you edit
`searcher.md` by hand, your version is detected and left untouched.

### Tightening the searcher

`searcher.md` restricts the child to the tools listed in `blocked_tools` (by default
`tools: staan_search, web_fetch, llms_txt`). To narrow it further, edit
`~/.pi/agent/agents/searcher.md`, but keep whatever extensions provide those tools loaded.

## License

MIT
