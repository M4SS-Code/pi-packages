# Pi Extensions

Custom extensions for [pi](https://github.com/earendil-works/pi).

We built these for our own way of using Pi; we focus on keeping the model's context clean and giving it tools that do one thing well.

> Want to contribute? Read [CONTRIBUTING.md](CONTRIBUTING.md) before opening issues or PRs.

## Packages

| Package                                            | Description                                                           |
| -------------------------------------------------- | --------------------------------------------------------------------- |
| [`binary-file-guard`](packages/binary-file-guard/) | Block `read` from reading binary files                                |
| [`llms-txt`](packages/llms-txt/)                   | Fetch and cache `llms.txt` from domains that publish it (still rare)  |
| [`search-delegator`](packages/search-delegator/)   | Block web tools on the main model and delegate to a searcher subagent |
| [`staan-search`](packages/staan-search/)           | Staan AI European search tool for pi                                  |
| [`web-fetch`](packages/web-fetch/)                 | Fetch web pages and convert HTML to Markdown                          |

## Setup

Install each extension with `pi install`:

```bash
pi install npm:@m4ss/pi-binary-file-guard
pi install npm:@m4ss/pi-llms-txt
pi install npm:@m4ss/pi-search-delegator
pi install npm:@m4ss/pi-staan-search
pi install npm:@m4ss/pi-web-fetch
```

The `search-delegator` package also requires `pi-subagents`:

```bash
pi install npm:pi-subagents
```

## Scaleway LLM Provider

We considered publishing a Scaleway LLM Provider package but [hope to integrate it into Pi directly](https://github.com/earendil-works/pi/issues/6165) instead. For now, configure Scaleway manually in your local `~/.pi/agent/models.json`:

```json
{
  "providers": {
    "scaleway": {
      "baseUrl": "https://api.scaleway.ai/$SCW_PROJECT_ID/v1",
      "api": "openai-completions",
      "apiKey": "$SCW_SECRET_KEY",
      "models": [
        {
          "id": "glm-5.2",
          "name": "GLM 5.2",
          "reasoning": true,
          "contextWindow": 256000,
          "maxTokens": 16384,
          "cost": {
            "input": 1.8,
            "output": 5.5,
            "cacheRead": 0,
            "cacheWrite": 0
          },
          "compat": {
            "thinkingFormat": "zai"
          }
        }
      ]
    }
  }
}
```

Add the models you need from [Scaleway's supported models list](https://www.scaleway.com/en/docs/generative-apis/reference-content/supported-models/).

## License

Each package is licensed under MIT. See the `LICENSE` file in each package.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).
