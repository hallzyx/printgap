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
python3 -m unittest discover -s tests        # 26 tests, standard library only
python3 -m pg.build                          # data/ -> site/data/events.json (offline)
cd site && python3 -m http.server 8000       # open http://localhost:8000
```

### Refreshing the real data (GitHub Actions)

The SEC and Bitget are fetched from GitHub Actions, which has open internet.

1. Push this repo to GitHub and enable **Pages** (Settings > Pages > Source: GitHub Actions).
2. Add a repository **variable** `EDGAR_UA` = `PrintGap your-name your-email@example.com` (the SEC requires real contact info).
3. Add a repository **secret** `ANTHROPIC_API_KEY` (only needed to run new extractions; cached ones need no key).
4. Run the **Fetch data** workflow. It downloads filings and XBRL, extracts, tests, rebuilds, commits and deploys.

Everything downloaded is stored under `data/` with a fetch time and a sha256 in `data/manifest.json`. The model output is cached by content hash in `data/extractions/`, so anyone can rebuild the exact same site without an API key.

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
pg/mcp.py       Bitget MCP client (best effort)
pg/build.py     offline assembly
site/           static page, no dependencies
tests/          26 tests
```
