# Pi Codex Fast Mode

Fast mode for OpenAI Codex models in [Pi](https://github.com/earendil-works/pi).

The extension adds `/fast on|off|status` and `--fast`. It targets ChatGPT-authenticated `openai-codex` requests without inventing model IDs such as `gpt-5.5-fast`.

## Quick start

```bash
pi install git:github.com/vcode11/pi-codex-fast-mode
```

Restart Pi, then enable Fast mode:

```text
/fast on
```

For one process, start Pi with `pi --fast`. `/fast` without an argument toggles the persisted setting. The footer shows `⚡ fast` while the selected model supports it.

## Supported models

| Pi model | Fast mode |
| --- | --- |
| `openai-codex/gpt-5.6-luna` | Yes |
| `openai-codex/gpt-5.6-sol` | Yes |
| `openai-codex/gpt-5.6-terra` | Yes |
| `openai-codex/gpt-5.5` | Yes |
| `openai-codex/gpt-5.4` | Yes |
| `gpt-5.4-mini`, `gpt-5.3-codex-spark`, other providers | No |

OpenAI currently documents roughly 1.5× generation speed and higher ChatGPT credit consumption: 2.5× for GPT-5.6/GPT-5.5 and 2× for GPT-5.4. See [Codex speed](https://developers.openai.com/codex/speed).

## How it works

For an enabled, supported request, the extension sends both signals used by current Codex clients:

| Signal | Value |
| --- | --- |
| Responses payload | `service_tier: "priority"` |
| Routing header | `x-codex-routing-hint: model=<model>;tier=priority` |

The model allowlist prevents these fields from leaking to unrelated providers. The persisted setting lives at `~/.pi/agent/codex-fast-mode.json`, or under `PI_CODING_AGENT_DIR` when set.

Pi briefly shipped `-fast` model aliases, then removed them because ChatGPT Codex rejected those model IDs. Pi maintainers chose an extension over a provider-wide abstraction in [issue #4643](https://github.com/earendil-works/pi/issues/4643). This package implements the request-tier mechanism instead.

## Verification

On 2026-08-11, three paired `gpt-5.6-luna` runs each reported 3,892 output characters:

| Median | Standard | Fast | Speedup |
| --- | ---: | ---: | ---: |
| Streaming | 36.06s | 24.04s | 1.50× |
| Full turn | 37.92s | 26.00s | 1.46× |

The installed Pi OAuth account accepted both request signals. Latency still varies by request and backend load; a response reporting the default tier is not reliable evidence that ChatGPT routing ignored Fast mode. The [benchmark script](bench/benchmark.py) and [raw results](bench/results-2026-08-11.jsonl) are included; rerunning it consumes ChatGPT credits.

## Development

```bash
npm install
npm run check
python3 bench/benchmark.py --output bench/results.jsonl
```

Requires Pi 0.84.1 and Node.js 22.19 or newer. The extension has no runtime dependencies and does not read authentication data.

## References

- [OpenAI Codex Fast mode](https://developers.openai.com/codex/speed)
- [Pi issue #4643](https://github.com/earendil-works/pi/issues/4643)
- [Pi removal commit](https://github.com/earendil-works/pi/commit/266234047ab55cc6082aa6e28021112e8884c065)
- [OpenAI Codex routing-hint commit](https://github.com/openai/codex/commit/270d93268ce9)
- Prior art: [calesennett/pi-codex-fast](https://github.com/calesennett/pi-codex-fast)

## License

MIT
