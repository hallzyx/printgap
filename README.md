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
node tests/test_richtext.js                  # chat renderer: markdown/math/chart splitting, chart JSON, citations
python3 -m pg.build                          # data/ -> site/data/events.json (offline)
python3 -m pg.serve                          # site + API on http://localhost:8000
```

`pg.serve` is the app: the site plus a small JSON API, standard library only. A plain static server (`cd site && python3 -m http.server`) still works: the page falls back to the committed `site/data/events.json` and the chat asks for the visitor's own key.

| Endpoint | What it does |
|---|---|
| `GET /api/events` | the built dataset |
| `GET /api/status` | dataset age, whether chat is on, state of the last refresh |
| `POST /api/ask` | `{event_id, question, history?}`, answered by the server's own model key from the numbered evidence only |
| `POST /api/refresh` | re-runs SEC fetch, extraction and build in the background. Needs `Authorization: Bearer $PRINTGAP_ADMIN_TOKEN`; off if the token is unset |

The model key stays on the server. The evidence in the prompt is built server-side from the dataset (`pg/evidence.py`, kept identical to `site/lib.js` by a test), so a caller can only pick an event and a question. Questions are capped per client per hour and per day for the whole site (`PRINTGAP_ASK_PER_HOUR`, `PRINTGAP_ASK_PER_DAY`).

The chat is the "Ask PrintGap" pop-up at the bottom right (`site/chat.js`, pure helpers in `site/richtext.js`). Answers are Markdown with tables, KaTeX math, mermaid diagrams and ```` ```chart ```` JSON drawn as SVG; every `[E3]` citation links to its evidence row, and ids that do not exist are flagged. Model output is untrusted: raw HTML is escaped, the result is sanitised with DOMPurify, links are limited to http(s)/mailto, mermaid runs with `securityLevel: "strict"`. The libraries are vendored in `site/vendor/` (versions in `site/vendor/README.txt`, no build step); KaTeX and mermaid load only when an answer needs them.

Refresh by hand: `curl -X POST -H "Authorization: Bearer $PRINTGAP_ADMIN_TOKEN" http://localhost:8000/api/refresh`, or set `PRINTGAP_REFRESH_HOURS=6` to refresh on a timer. A refresh updates SEC filings and extractions; the price candles still come from the fixtures in `data/fixtures`, so a newly filed release shows "no cash data" until those are updated.

### Refreshing the real data on your own computer

```
pip install -r requirements.txt
cp .env.example .env     # then edit .env: EDGAR_UA and ONE model key
python3 scripts/fetch_all.py && python3 -m pg.build
```

`.env` is git-ignored. Real environment variables override it.

### Refreshing the real data (GitHub Actions)

The SEC and Bitget are fetched from GitHub Actions, which has open internet.

1. Push this repo to GitHub. No Pages setup is needed: the site is the static folder `site/`, served from any host (for example a VPS behind nginx or Caddy with `git pull`).
2. Add a repository **variable** `EDGAR_UA` = `PrintGap your-name your-email@example.com` (the SEC requires real contact info).
3. Add **one** model key as a repository **secret** (see the table below). It is only needed to run new extractions; cached ones need no key.
4. Run the **Fetch data** workflow. It downloads filings and XBRL, extracts, tests, rebuilds and commits the data. Pull it on your server to update the site.

Everything downloaded is stored under `data/` with a fetch time and a sha256 in `data/manifest.json`. The model output is cached by content hash in `data/extractions/`, so anyone can rebuild the exact same site without an API key.

## Which language model

The same extraction prompt runs on several providers. Pick one by setting its key (and optionally `PRINTGAP_PROVIDER`):

| Provider | Key variable | Default model |
|---|---|---|
| Anthropic | `ANTHROPIC_API_KEY` | `claude-sonnet-5-5` |
| OpenAI | `OPENAI_API_KEY` | `gpt-6-luna` |
| DeepSeek | `DEEPSEEK_API_KEY` | `deepseek-flash` |
| Qwen (hackathon credits) | `QWEN_API_KEY` | `qwen3.8-max` at `https://hackathon.bitgetops.com/v1` |
| Any other OpenAI-compatible endpoint | `LLM_API_KEY` + `PRINTGAP_BASE_URL` + `PRINTGAP_MODEL` | none, you set it |

- If several keys are present, the order above decides; `PRINTGAP_PROVIDER=openai` (or `anthropic`, `deepseek`, `compatible`) forces one.
- `PRINTGAP_MODEL` overrides the default model of whichever provider is chosen. Model names change, so check the provider's current list if a default is rejected.
- Defaults were checked against the providers' own pages on 2026-10-08:
  - OpenAI ([models](https://developers.openai.com/api/docs/models)): the current flagships are `gpt-6-astra` (most capable, priciest), `gpt-6.1-sol` (near-Astra at a fifth of the price) and `gpt-6-luna` (cheapest, our default; switch to Sol with `PRINTGAP_MODEL=gpt-6.1-sol` if extraction quality disappoints). `gpt-4.1` is still listed as active, as a non-reasoning option.
  - DeepSeek ([change log](https://api-docs.deepseek.com/updates/)): `deepseek-flash` (V4.1 Flash, 2026-09-10) and `deepseek-v4-pro`. The older `deepseek-chat` and `deepseek-reasoner` were announced for discontinuation on 2026-07-24, so do not rely on them.
  - Anthropic: `claude-sonnet-5-5` (default), `claude-opus-5-5`, `claude-haiku-5-5`.
- These are reasoning models, which spend output tokens thinking before they answer. The code gives them a large output budget and reports a clear error if an answer is still cut off.
- **Qwen credits from the hackathon.** Set `QWEN_API_KEY`; the endpoint and model default to the ones in the handbook (`https://hackathon.bitgetops.com/v1`, `qwen3.8-max`) and can be overridden with `PRINTGAP_BASE_URL` and `PRINTGAP_MODEL`. How to get the credits, per the handbook: fill in the [Qwen application form](https://forms.gle/2QeJpvGB5VpipqQ68) (separate from the project form), Bitget checks KYC every 24 hours, and an admin in the [official Telegram](https://t.me/+o1tYqQ_lXxllYjgy) hands over the key. The first 300 teams that pass KYC get the equivalent of US$30. The handbook is not consistent about which form is the Qwen one, so confirm in the Telegram. Using Qwen is optional and does not affect judging.
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
