# PrintGap

Reads a company's earnings release, checks every figure against the SEC's own filings, and shows how much of the surprise the tokenized stock (rToken) had already priced in while the US cash market was closed. A human decides; PrintGap never places orders.

Built for the Bitget AI Base Camp Hackathon S2, track **AI Trading Desk**, sub-theme **Information Extraction & Signal Generation**.

## What it does

1. **Extract.** A language model reads the 8-K press release and copies out reported revenue, net income, EPS, operating income, gross profit and the company's next-quarter guidance. Each figure carries the exact quote it came from.
2. **Verify (code, not the model).** The quote must exist in the document, the number must appear in the quote, and reported figures must match SEC XBRL company facts for the same quarter. Failures are discarded and shown with the reason.
3. **Compare.** Reported revenue against the company's own prior-quarter guidance (analyst consensus is not available to this build, and the page says so).
4. **Measure the overnight window.** From the 16:00 ET close to the 09:30 ET open: how far the rToken moved, how much of it came before versus after the release, where the cash stock actually opened, and what share of the gap was priced in.

The language model never calculates, never sees prices, and never recommends trades.

## Run it

```
python3 -m unittest discover -s tests        # Python tests, standard library only
node tests/test_lib.js                       # browser-side logic tests, no dependencies
python3 -m pg.build                          # data/ -> site/data/events.json (offline)
cd site && python3 -m http.server 8000       # open http://localhost:8000
```

### Refreshing the real data (GitHub Actions)

The SEC and Bitget are fetched from GitHub Actions, which has open internet.

1. Push this repo to GitHub and enable **Pages** (Settings > Pages > Source: GitHub Actions).
2. Add a repository **variable** `EDGAR_UA` = `PrintGap your-name your-email@example.com` (the SEC requires real contact info).
3. Add **one** model key as a repository **secret** (see the table below). It is only needed to run new extractions; cached ones need no key.
4. Run the **Fetch data** workflow. It downloads filings and XBRL, extracts, tests, rebuilds, commits and deploys.

Everything downloaded is stored under `data/` with a fetch time and a sha256 in `data/manifest.json`. The model output is cached by content hash in `data/extractions/`, so anyone can rebuild the exact same site without an API key.

## Which language model

The same extraction prompt runs on several providers. Pick one by setting its key (and optionally `PRINTGAP_PROVIDER`):

| Provider | Key variable | Default model |
|---|---|---|
| Anthropic | `ANTHROPIC_API_KEY` | `claude-sonnet-5-5` |
| OpenAI | `OPENAI_API_KEY` | `gpt-6.1-sol` |
| DeepSeek | `DEEPSEEK_API_KEY` | `deepseek-flash` |
| Any OpenAI-compatible endpoint (for example the Qwen endpoint the hackathon provides) | `LLM_API_KEY` + `PRINTGAP_BASE_URL` + `PRINTGAP_MODEL` | none, you set it |

- If several keys are present, the order above decides; `PRINTGAP_PROVIDER=openai` (or `anthropic`, `deepseek`, `compatible`) forces one.
- `PRINTGAP_MODEL` overrides the default model of whichever provider is chosen. Model names change, so check the provider's current list if a default is rejected.
- Defaults were checked against the providers' own pages on 2026-10-08:
  - OpenAI ([models](https://developers.openai.com/api/docs/models)): the current flagships are `gpt-6-astra` (most capable, priciest), `gpt-6.1-sol` (near-Astra at a fifth of the price, our default) and `gpt-6-luna` (cheapest). `gpt-4.1` is still listed as active, as a non-reasoning option.
  - DeepSeek ([change log](https://api-docs.deepseek.com/updates/)): `deepseek-flash` (V4.1 Flash, 2026-09-10) and `deepseek-v4-pro`. The older `deepseek-chat` and `deepseek-reasoner` were announced for discontinuation on 2026-07-24, so do not rely on them.
  - Anthropic: `claude-sonnet-5-5` (default), `claude-opus-5-5`, `claude-haiku-5-5`.
- These are reasoning models, which spend output tokens thinking before they answer. The code gives them a large output budget and reports a clear error if an answer is still cut off.
- Hackathon Qwen credits go through the generic mode. The handbook gives the endpoint `https://hackathon.bitgetops.com/v1` and the model `qwen3.8-max`, so set `LLM_API_KEY`, `PRINTGAP_BASE_URL=https://hackathon.bitgetops.com/v1` and `PRINTGAP_MODEL=qwen3.8-max`. Re-check the handbook first, because it may change.
- Each stored extraction records which provider and model made it, and `site/method.html` lists them. Verification is identical whichever model answered: a quote that is not in the document, or a number that contradicts SEC XBRL, is discarded.
- The question box on the page has the same choices (Anthropic, OpenAI, DeepSeek, other endpoint). The key is typed into the page, stays in that tab and goes only to the provider you pick. Some providers do not allow calls straight from a web page (CORS); if one fails that way, the page says so, and the memo and the Python pipeline are unaffected.

## Data and attribution

- SEC EDGAR: 8-K item 2.02 exhibit 99.1 and XBRL company facts.
- rToken 15-minute candles (Bitget) and daily cash bars, 2026-06-01 to 2026-09-21: fixtures from [Megacollins/rift24](https://github.com/Megacollins/rift24), MIT licensed (`data/fixtures/LICENSE-rift24-MIT`). Fetch time is in `data/fixtures/SOURCE_MANIFEST.json`.
- Bitget `bitget-mcp-server`: the first run records the real tool catalog in `data/mcp/`. Parameters are not assumed.

## Honest limits

- One earnings season, eight large companies. Statistics are a log, not a forecast.
- Overnight rToken liquidity is thin; a price on screen is not a fill.
- Guidance is not consensus. Beating a cautious guide is common.
- Transcripts are not read.

See `site/method.html` for how well the extraction did, computed from the real data.

## Layout

```
pg/engine.py    overnight reaction, no look-ahead
pg/extract.py   prompt, verifier, cache
pg/edgar.py     EDGAR + XBRL (runs in Actions)
pg/llm.py       provider layer (Anthropic, OpenAI, DeepSeek, compatible)
pg/mcp.py       Bitget MCP client (best effort)
pg/build.py     offline assembly
site/           static page, no dependencies
tests/          Python and Node tests
```
