"""SEC EDGAR access (runs in GitHub Actions, which has open internet) + XBRL lookup.

SEC fair-access policy requires a descriptive User-Agent with contact info (env EDGAR_UA)
and <= 10 requests/second; we stay well below that.
"""
from __future__ import annotations

import hashlib
import json
import os
import re
import time
from datetime import date, datetime, timedelta, timezone
from html.parser import HTMLParser

TICKERS = {  # ticker -> CIK. Verified at runtime against the `name` field returned by EDGAR.
    "NVDA": (1045810, "NVIDIA"),
    "TSLA": (1318605, "Tesla"),
    "AAPL": (320193, "Apple"),
    "META": (1326801, "Meta"),
    "AMZN": (1018724, "Amazon"),
    "MSFT": (789019, "Microsoft"),
    "GOOGL": (1652044, "Alphabet"),
    "AMD": (2488, "Advanced Micro Devices"),
}

XBRL_CONCEPTS = {
    "revenue": [
        ("us-gaap", "Revenues", "USD"),
        ("us-gaap", "RevenueFromContractWithCustomerExcludingAssessedTax", "USD"),
        ("us-gaap", "SalesRevenueNet", "USD"),
    ],
    "net_income": [("us-gaap", "NetIncomeLoss", "USD")],
    "eps_diluted": [("us-gaap", "EarningsPerShareDiluted", "USD/shares")],
    "operating_income": [("us-gaap", "OperatingIncomeLoss", "USD")],
    "gross_profit": [("us-gaap", "GrossProfit", "USD")],
}


# ------------------------------ HTTP ----------------------------------------

def _session():
    import requests

    ua = os.environ.get("EDGAR_UA", "").strip()
    if "@" not in ua:
        raise RuntimeError("Set EDGAR_UA to 'App Name contact@email' (SEC requires contact info).")
    s = requests.Session()
    s.headers.update({"User-Agent": ua, "Accept-Encoding": "gzip, deflate"})
    return s


def _get(s, url: str, tries: int = 4):
    last = None
    for i in range(tries):
        time.sleep(0.2)
        r = s.get(url, timeout=60)
        if r.status_code == 200:
            return r
        last = r
        if r.status_code in (429, 503):
            time.sleep(2 * (i + 1))
            continue
        break
    raise RuntimeError(f"GET {url} -> {last.status_code}")


# ------------------------------ filings -------------------------------------

def list_earnings_8k(s, cik: int, since: date) -> tuple[str, list[dict]]:
    j = _get(s, f"https://data.sec.gov/submissions/CIK{cik:010d}.json").json()
    rec = j["filings"]["recent"]
    out = []
    for i, form in enumerate(rec["form"]):
        if form != "8-K":
            continue
        items = rec.get("items", [""] * len(rec["form"]))[i] or ""
        if "2.02" not in items.split(","):
            continue
        fdate = date.fromisoformat(rec["filingDate"][i])
        if fdate < since:
            continue
        acc = rec["accessionNumber"][i]
        out.append(
            {
                "accession": acc,
                "filing_date": rec["filingDate"][i],
                "acceptance_utc": _accept_utc(rec["acceptanceDateTime"][i]),
                "items": items,
                "primary_doc": rec["primaryDocument"][i],
            }
        )
    return j.get("name", ""), sorted(out, key=lambda e: e["acceptance_utc"])


def _accept_utc(s: str) -> str:
    # EDGAR gives e.g. 2026-08-26T20:20:41.000Z (already UTC)
    return datetime.fromisoformat(s.replace("Z", "+00:00")).astimezone(timezone.utc).isoformat()


class _Text(HTMLParser):
    BLOCK = {"p", "div", "br", "tr", "li", "h1", "h2", "h3", "h4", "h5", "h6", "table"}

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.parts: list[str] = []
        self.skip = 0

    def handle_starttag(self, tag, attrs):
        if tag in ("script", "style"):
            self.skip += 1
        elif tag in self.BLOCK:
            self.parts.append("\n")
        elif tag in ("td", "th"):
            self.parts.append(" | ")

    def handle_endtag(self, tag):
        if tag in ("script", "style"):
            self.skip = max(0, self.skip - 1)
        elif tag in self.BLOCK:
            self.parts.append("\n")

    def handle_data(self, data):
        if not self.skip:
            self.parts.append(data)


def html_to_text(html: str) -> str:
    p = _Text()
    p.feed(html)
    t = "".join(p.parts).replace(" ", " ")
    t = re.sub(r"[ \t]+", " ", t)
    t = re.sub(r"(\| ?)+\|", "|", t)  # collapse empty cells
    t = re.sub(r"\n\s*\n+", "\n", t)
    return t.strip()


def _ex99_from_index(s, base: str, accession: str, names: list[str]) -> list[str]:
    """Exhibit file names whose declared type is EX-99.x, EX-99.1 first. Companies name the file anything."""
    html = _get(s, f"{base}{accession}-index.html").text
    found = []
    for href, typ in re.findall(r'<a href="[^"]*/([^/"]+)">[^<]*</a>[^<]*(?:<span[^>]*>[^<]*</span>)?\s*</td>\s*<td[^>]*>(EX-99[^<]*)</td>', html):
        if href in names and href.lower().endswith((".htm", ".html")):
            found.append((typ.strip() != "EX-99.1", href))
    return [h for _, h in sorted(found)]


def fetch_press_release(s, cik: int, accession: str) -> dict:
    nodash = accession.replace("-", "")
    base = f"https://www.sec.gov/Archives/edgar/data/{cik}/{nodash}/"
    idx = _get(s, base + "index.json").json()
    names = [it["name"] for it in idx["directory"]["item"]]
    cands = _ex99_from_index(s, base, accession, names)
    if not cands:  # fall back to the file name
        cands = [n for n in names if re.search(r"ex-?99", n, re.I) and n.lower().endswith((".htm", ".html"))]
        cands.sort(key=lambda n: (not re.search(r"99[-_.]?0?1", n), n))
    if not cands:
        raise RuntimeError(f"no Ex-99 document in {base}")
    url = base + cands[0]
    raw = _get(s, url).text
    return {
        "url": url,
        "sha256_raw": hashlib.sha256(raw.encode()).hexdigest(),
        "text": html_to_text(raw),
    }


# ------------------------------ XBRL ----------------------------------------

def trim_companyfacts(j: dict) -> dict:
    """Keep only the quarterly facts we use, to keep the repo small."""
    out = {"entityName": j.get("entityName"), "facts": {}}
    for metric, concepts in XBRL_CONCEPTS.items():
        for tax, tag, unit in concepts:
            node = j.get("facts", {}).get(tax, {}).get(tag)
            if not node:
                continue
            rows = []
            for f in node.get("units", {}).get(unit, []):
                if "start" not in f or "end" not in f:
                    continue
                d = (date.fromisoformat(f["end"]) - date.fromisoformat(f["start"])).days
                if 80 <= d <= 100:  # a quarter
                    rows.append({k: f[k] for k in ("start", "end", "val", "form", "filed", "accn") if k in f})
            if rows:
                out["facts"].setdefault(metric, []).append({"tag": tag, "unit": unit, "rows": rows})
    return out


def xbrl_for_release(trimmed: dict, filing_date: str, max_age_days: int = 75) -> dict:
    """Pick, per metric, the quarterly fact for the quarter this release reports.

    The reported quarter is the latest quarterly period that ended before the release and
    no more than `max_age_days` earlier. If the 10-Q for it is not on file yet, there is no
    fact and we return nothing for that metric (never fall back to an older quarter).
    """
    fd = date.fromisoformat(filing_date)
    out = {}
    for metric, series in (trimmed.get("facts") or {}).items():
        best = None
        for ser in series:
            for r in ser["rows"]:
                end = date.fromisoformat(r["end"])
                if end >= fd or (fd - end).days > max_age_days:
                    continue
                if best is None or (end, r.get("filed", "")) > (best["end_d"], best.get("filed", "")):
                    best = {"end_d": end, "value": float(r["val"]), "end": r["end"], "start": r["start"],
                            "form": r.get("form"), "filed": r.get("filed", ""), "accn": r.get("accn"), "tag": ser["tag"]}
        if best:
            best.pop("end_d")
            # year-ago quarter, for a deterministic YoY
            prev_end = date.fromisoformat(best["end"]) - timedelta(days=365)
            for ser in series:
                for r in ser["rows"]:
                    if abs((date.fromisoformat(r["end"]) - prev_end).days) <= 10 and r["end"] != best["end"]:
                        best["yoy_prior"] = float(r["val"])
            out[metric] = best
    return out


def fetch_companyfacts(s, cik: int) -> dict:
    return trim_companyfacts(_get(s, f"https://data.sec.gov/api/xbrl/companyfacts/CIK{cik:010d}.json").json())
