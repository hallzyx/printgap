# Submission drafts (fill the [BRACKETS] from real data before sending)

Deadline: 2026-10-11 23:59 GMT+8 = 2026-10-11 10:59 a.m. Lima. Freeze code 2026-10-10 20:00 Lima.
Items tagged (verify) come from the ideation research and I have not re-checked them against the source; open the link and confirm before sending.
Rule: every number below is either copied from `site/method.html` / `site/data/events.json` after the real run, or left out. Label observed / estimated / targeted.

## Form fields

- Track: AI Trading Desk
- Sub-theme: Information Extraction & Signal Generation
- Submission materials link: [GitHub Pages URL] + [repo URL] + [video URL if any]
- X promotional post link: [your post] (must include #BitgetHackathon and @Bitget_AI, and quote/retweet https://x.com/Bitget_AI/status/2100519318824055159)
- University name (optional): [only if you are a student; it is mutually exclusive with winning a main-track prize]
- Apply for Demo Day: Yes
- S1 participant: [Yes/No]

## Project description (one field, paste into the form)

**1. Thesis.** Tokenized US stocks trade 7x24, but earnings are released after the US close. For roughly 17 hours the rToken is the only place to act on the news, and it is thinly traded, so traders in Asia-Pacific read a headline and trade a book that may already have moved. PrintGap turns the release into figures that are checked against SEC filings, compares revenue with the company's own prior guidance, and measures how much of the eventual opening gap the rToken had already priced in. Signal sources: the 8-K press release, SEC XBRL facts, Bitget rToken 15-minute candles. Decision logic: none automated; PrintGap informs and the human decides. Risk controls: figures that fail verification are discarded; ratios are hidden when the gap is under 0.5%; no orders are placed.

**2. Target user.** A retail trader in UTC+7 to UTC+9 who trades rTokens of 5 to 10 large technology and semiconductor stocks on Bitget, with [TARGETED] US$2,000 to US$25,000 of capital, mostly around earnings, during the hours when the US cash market is closed. Third-party analysis of Bitget rToken spot reports a 95% retail share and an average ticket of about US$422 (observed, DefiLlama Research; verify: https://defillama.com/research/spotlight/bitget-tokenized-stocks-gain-traction-as-retail-demand-accelerates). They need this because they currently read translated headlines and cannot tell what the document actually said versus what the price already reflects.

**3. Validation and key metrics.**
- Extraction accuracy against SEC XBRL (observed): [N checked, N matched, N contradicting]. Source: `site/method.html`.
- Releases processed / measured overnight windows (observed): [N] / [N].
- Median priced-in ratio (observed): [X] over [n] releases. This is a log, not a forecast; n is too small for statistics.
- Entry costs (estimated, not modeled): third parties report 5 to 10 bp per side and disagree.
- Distribution (targeted): [e.g. 50 traders in month one]; not yet observed.
Backtests and paper trading do not apply to this track; the tool does not trade.

**4. Progress.** Built: EDGAR fetch, LLM extraction with strict quotes, deterministic verifier, XBRL cross-check, overnight reaction engine with no look-ahead (tested), static workbench with timeline, claims, guidance gap, history table, evidence-bound Q&A and a memo, a method page. Problems: analyst consensus was not available, so the comparison uses the company's own prior guidance; [MCP status from `data/manifest.json`]. Next: live coverage of the Q3 season, order-book cost estimates. Stack: Python, pandas, SEC EDGAR, Bitget rToken candles, and a swappable language model (extraction and Q&A).

**5. Deliverables.** Demo: [Pages URL]. Code: [repo URL]. Method and accuracy: [Pages URL]/method.html. Raw data and hashes: `data/`. Tests: `python3 -m unittest discover -s tests`.

**6. Take on AI trading.** The useful work for an LLM in trading is reading and checking, not predicting. A public S2 repo reports an LLM news agent on Bitget perps with no measurable edge (verify: https://github.com/lonetravelerxyz/after-the-bell), so PrintGap spends the model on extraction that code can verify, and abstains when evidence is missing.

## Role of the LLM in your project

[Name the provider and model you actually ran, from `site/method.html` ("Models that produced the extractions"). Examples: claude-sonnet-5-5, gpt-4.1, deepseek-chat, or the Qwen model on the hackathon endpoint. If you ran more than one, say which produced the figures shown.]

The model does two things. (1) It reads each 8-K press release and extracts a short list of figures, each with a verbatim quote; code then verifies the quote, the number, and the match with SEC XBRL, and discards failures, so the result does not depend on trusting the model. The same prompt runs on Anthropic, OpenAI, DeepSeek or any OpenAI-compatible endpoint. (2) Optionally, it answers a trader's question using only numbered evidence, citing evidence ids, and says when the evidence does not cover the question; the page flags answers that cite nothing or cite ids that do not exist. It never calculates, sees prices, or recommends trades.

## X post draft

Earnings land at 16:05 ET. Your rToken moves while NYSE sleeps.

PrintGap reads the release, checks every figure against SEC XBRL, and shows how much of the gap the rToken already priced in. You decide.

[demo link] #BitgetHackathon @Bitget_AI

(also quote/retweet https://x.com/Bitget_AI/status/2100519318824055159)

## Checklist (any missing item makes the entry invalid)

- [ ] X post with #BitgetHackathon, @Bitget_AI, a real introduction, and the quote/retweet
- [ ] Project description pasted into the form (a README does not count)
- [ ] "Role of the LLM" filled
- [ ] Materials link opens in a private window
- [ ] Track and sub-theme selected
