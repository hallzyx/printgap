"""Numbered evidence for one event: the only facts the chat may use.

Python twin of evidence() and chatSystem() in site/lib.js, so the server builds the prompt itself and never
trusts text sent by a browser. tests/test_server.py checks both implementations give identical output.
"""
from __future__ import annotations

import math

METRIC_LABEL = {
    "revenue": "Revenue",
    "net_income": "Net income (GAAP)",
    "eps_diluted": "Diluted EPS (GAAP)",
    "operating_income": "Operating income",
    "gross_profit": "Gross profit",
    "gross_margin_pct": "Gross margin (GAAP)",
    "guidance_revenue_low": "Next-quarter revenue guidance, low",
    "guidance_revenue_high": "Next-quarter revenue guidance, high",
    "guidance_revenue_mid": "Next-quarter revenue guidance, midpoint",
    "guidance_tolerance_pct": "Guidance tolerance (+/-)",
    "guidance_gross_margin_pct": "Next-quarter gross margin guidance",
}


def money(v: float) -> str:
    a = abs(v)
    if a >= 1e9:
        return f"${v / 1e9:.{1 if a >= 1e11 else 2}f}B"
    if a >= 1e6:
        return f"${v / 1e6:.1f}M"
    return f"${v:.2f}"


def fmt_value(c: dict) -> str:
    if c["unit"] == "USD":
        return money(c["value"])
    if c["unit"] == "USD_per_share":
        return f"${float(c['value']):.2f}"
    return f"{float(c['value']):.1f}%"


def _signed(p: float, digits: int) -> str:
    return f"{'+' if p >= 0 else ''}{p:.{digits}f}%"


def pct(logret, digits: int = 2) -> str:
    """Log return to signed percent string."""
    if logret is None or (isinstance(logret, float) and math.isnan(logret)):
        return "n/a"
    return _signed((math.exp(logret) - 1) * 100, digits)


def pct_plain(p, digits: int = 1) -> str:
    if p is None or (isinstance(p, float) and math.isnan(p)):
        return "n/a"
    return _signed(p, digits)


def evidence(ev: dict, analogs: dict | None) -> list[dict]:
    out: list[dict] = []

    def add(text: str, kind: str) -> None:
        out.append({"id": f"E{len(out) + 1}", "text": text, "kind": kind})

    for c in ev.get("claims") or []:
        if c.get("status") == "rejected":
            continue
        tag = "verified against SEC XBRL" if c.get("status") == "verified" else "quote verified in the release, no XBRL fact yet"
        add(f'{METRIC_LABEL.get(c["metric"], c["metric"])} = {fmt_value(c)} ({tag}). Source quote: "{c["quote"]}"', "claim")
    g = ev.get("gap")
    if g and g.get("available"):
        add(
            f"Reported revenue {money(g['actual'])} vs prior-quarter company guidance {money(g['guide_low'])} to "
            f"{money(g['guide_high'])} (midpoint {money(g['guide_mid'])}): {pct_plain(g['vs_mid_pct'])} vs midpoint, "
            f"{g['position']}. This is guidance, not analyst consensus.",
            "gap",
        )
    if ev.get("yoy_revenue_pct") is not None:
        add(f"Revenue growth vs the year-ago quarter: {pct_plain(ev['yoy_revenue_pct'])} (from SEC XBRL).", "yoy")
    r = ev.get("reaction")
    if r and r.get("ok"):
        t = ev["ticker"]
        add(
            f"r{t} moved {pct(r['rt_move'])} from the 16:00 ET close to 09:25 ET ({pct(r['rt_pre_pub'])} before the release, "
            f"{pct(r['rt_post_pub'])} after it).",
            "reaction",
        )
        add(
            f"The cash stock opened {pct(r['cash_gap'])} vs its prior close. The rToken's last price before the open was "
            f"{pct(r['residual'])} away from that opening price.",
            "reaction",
        )
        if r.get("priced_in") is not None:
            add(f"Priced-in ratio (rToken overnight move / cash gap): {r['priced_in']:.2f}.", "reaction")
    elif r:
        add(f"Reaction not measured: {r.get('reason') or 'unknown reason'}.", "reaction")
    if analogs:
        n = analogs["n_valid"]
        s = f"Across {n} measured earnings release{'' if n == 1 else 's'} in this dataset"
        if analogs.get("median_priced_in") is not None:
            s += f", the median priced-in ratio is {analogs['median_priced_in']:.2f} ({analogs['n_with_ratio']} with a usable ratio)"
        add(s + ". With so few events this is a log, not a forecast.", "analogs")
    return out


CHAT_RULES = r"""You are PrintGap's analyst. You answer a trader's questions about ONE earnings release using ONLY the numbered evidence below.

Rules
- Cite the evidence id like [E3] after every factual statement or number. Cite only ids that exist below.
- If the evidence does not contain the answer, say exactly "The evidence does not cover that." and stop.
- Never add outside facts, prices, forecasts, analyst views or trade recommendations. You do not tell anyone what to buy or sell.
- You may compare or restate numbers that are in the evidence; any figure you derive must name the evidence ids it comes from.
- Reply in the language the user writes in. Be concise: about 200 words of prose at most. Tables, formulas and charts do not count.

Formatting (rendered by the page; use them when they make the answer clearer, not for decoration)
- GitHub-flavored Markdown: headings, **bold**, lists, tables.
- Math in LaTeX: inline $...$ and display $$...$$. Example: $\text{priced-in} = \frac{\text{rToken move}}{\text{cash gap}}$.
- Diagrams in a fenced block ```mermaid (flowchart or timeline). Keep node text short and plain.
- Charts in a fenced block ```chart containing JSON only:
  {"type": "bar" | "line", "title": "...", "unit": "%", "labels": ["A", "B"], "series": [{"name": "...", "values": [1.5, -2.0]}]}
  Every value must come from the evidence; never invent a data point. Use signed percent numbers as plain numbers (-8.03, not "-8.03%").

EVIDENCE:
"""


def chat_system(ev_list: list[dict]) -> str:
    sep = chr(10)
    return CHAT_RULES + sep.join(f"[{e['id']}] {e['text']}" for e in ev_list)
