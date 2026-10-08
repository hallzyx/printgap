"""LLM extraction + deterministic verification.

The model only EXTRACTS. Every claim must carry a verbatim quote. Code then:
  1. checks the quote exists in the document text,
  2. checks the claimed number appears in that quote (allowing table scaling),
  3. cross-checks reported figures against SEC XBRL company facts.
Anything that fails is REJECTED and shown as such. The model never computes,
never sees prices, and never recommends trades.
"""
from __future__ import annotations

import hashlib
import json
import os
import re
from pathlib import Path

PROMPT_VERSION = "v1"
DEFAULT_MODEL = os.environ.get("PRINTGAP_MODEL", "claude-sonnet-5-5")

METRICS = [
    "revenue",
    "net_income",
    "eps_diluted",
    "operating_income",
    "gross_profit",
    "gross_margin_pct",
    "guidance_revenue_low",
    "guidance_revenue_high",
    "guidance_revenue_mid",
    "guidance_tolerance_pct",
    "guidance_gross_margin_pct",
]
XBRL_METRICS = {"revenue", "net_income", "eps_diluted", "operating_income", "gross_profit"}

SYSTEM = f"""You extract factual claims from a company earnings press release.
Return ONLY a JSON object, no prose, no code fences:
{{"period_label": "<fiscal period the release reports, as written>",
  "claims": [{{"id": "c1", "metric": "<one of {METRICS}>",
    "basis": "reported" | "guidance",
    "value": <number>, "unit": "USD" | "USD_per_share" | "percent",
    "quote": "<VERBATIM text copied from the document, <= 300 chars, containing the number>"}}]}}
Rules:
- Extract only: the CURRENT quarter's reported revenue, net income (GAAP), diluted EPS (GAAP),
  operating income, gross profit, gross margin (GAAP), and the company's own OUTLOOK/GUIDANCE
  for the NEXT quarter: revenue (low/high, or a midpoint with a plus-or-minus percentage),
  and gross margin if given.
- `value` must be in base units: dollars (e.g. 46.7 billion -> 46700000000), dollars per share
  for EPS, percent as a plain number (e.g. 72.4 for 72.4%).
- `quote` MUST be copied character-for-character from the document. Never paraphrase, never
  correct, never merge two places. If a table row is the source, copy that row as it appears.
- Use the GAAP figure unless the metric says otherwise. Do not compute anything. Do not infer.
- If a figure is not stated, omit it. Do not guess. Fewer correct claims beat more doubtful ones.
- Ignore year-ago and sequential comparisons, and non-GAAP figures."""


# ----------------------------- text normalisation -----------------------------

_WS = re.compile(r"\s+")
_TRANS = str.maketrans(
    {"‘": "'", "’": "'", "“": '"', "”": '"', "–": "-", "—": "-", " ": " "}
)


def norm(s: str) -> str:
    return _WS.sub(" ", s.translate(_TRANS)).strip()


# ----------------------------- number handling --------------------------------

_NUM = re.compile(
    r"(?P<num>\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?)\s*(?P<scale>billion|million|thousand|bn|mn|b|m|k)?\b",
    re.I,
)
_SCALE = {"billion": 1e9, "bn": 1e9, "b": 1e9, "million": 1e6, "mn": 1e6, "m": 1e6, "thousand": 1e3, "k": 1e3}


def numbers_in(text: str) -> list[tuple[float, float, float]]:
    """Return (value_as_written, value_with_stated_scale, half_width_of_rounding) per number."""
    out = []
    for m in _NUM.finditer(text):
        num = m.group("num")
        raw = float(num.replace(",", ""))
        sc = m.group("scale")
        factor = _SCALE[sc.lower()] if sc else 1.0
        decimals = len(num.split(".")[1]) if "." in num else 0
        out.append((raw, raw * factor, 0.5 * (10 ** -decimals) * factor))
    return out


def match_number(value: float, unit: str, quote: str) -> float | None:
    """If `value` is one of the numbers in `quote` (allowing table scaling x1e3/x1e6/x1e9),
    return the half-width of that number's rounding; else None."""
    if value is None:
        return None
    for raw, scaled, half in numbers_in(quote):
        cands = [(scaled, half)]
        if unit == "USD":  # table figures often omit the unit that the header states
            cands += [(raw * k, half / (scaled / raw if raw and scaled else 1) * k) for k in (1e3, 1e6, 1e9)]
        for c, h in cands:
            if abs(c - value) <= max(1e-9, abs(value) * 1e-6):
                return h
    return None


def number_supported(value: float, unit: str, quote: str) -> bool:
    return match_number(value, unit, quote) is not None


# ----------------------------- verification -----------------------------------

def verify_claim(claim: dict, doc_norm: str, xbrl: dict | None) -> dict:
    """Return the claim + {status, checks}. status: verified | quote_only | rejected."""
    c = dict(claim)
    checks = {}
    metric = c.get("metric")
    quote = c.get("quote") or ""
    ok_schema = (
        metric in METRICS
        and isinstance(c.get("value"), (int, float))
        and c.get("unit") in ("USD", "USD_per_share", "percent")
        and c.get("basis") in ("reported", "guidance")
        and quote
    )
    checks["schema"] = bool(ok_schema)
    if not ok_schema:
        return {**c, "status": "rejected", "reason": "malformed claim", "checks": checks}

    checks["quote_in_document"] = norm(quote) in doc_norm
    if not checks["quote_in_document"]:
        return {**c, "status": "rejected", "reason": "quote not found in the document", "checks": checks}

    half = match_number(float(c["value"]), c["unit"], quote)
    checks["number_in_quote"] = half is not None
    if half is None:
        return {**c, "status": "rejected", "reason": "value does not appear in the quote", "checks": checks}

    if c["basis"] == "reported" and metric in XBRL_METRICS:
        ref = (xbrl or {}).get(metric)
        if ref is None:
            checks["xbrl"] = "unavailable"
            return {**c, "status": "quote_only", "reason": "no XBRL fact for this period yet", "checks": checks}
        # the press release rounds; XBRL is exact. Allow the rounding the quote itself shows.
        tol = half * 1.0001 + abs(ref["value"]) * 1e-4
        match = abs(float(c["value"]) - ref["value"]) <= tol
        checks["xbrl"] = "match" if match else "mismatch"
        c["xbrl"] = ref
        if not match:
            return {**c, "status": "rejected", "reason": "does not match SEC XBRL", "checks": checks}
        return {**c, "status": "verified", "checks": checks}

    return {**c, "status": "quote_only", "checks": checks}


def verify_all(extraction: dict, doc_text: str, xbrl: dict | None) -> dict:
    dn = norm(doc_text)
    seen = set()
    claims = []
    for cl in extraction.get("claims", []):
        v = verify_claim(cl, dn, xbrl)
        key = (v.get("metric"), v.get("basis"), v.get("value"))
        if key in seen and v["status"] != "rejected":
            continue  # same figure quoted twice: keep the first
        seen.add(key)
        claims.append(v)
    return {"period_label": extraction.get("period_label"), "claims": claims}


def accuracy(verified: list[dict]) -> dict:
    """Precision/recall of REPORTED, XBRL-checkable metrics (the objective part)."""
    rep = [c for c in verified if c.get("basis") == "reported" and c.get("metric") in XBRL_METRICS]
    judged = [c for c in rep if c.get("checks", {}).get("xbrl") in ("match", "mismatch")]
    match = sum(1 for c in judged if c["checks"]["xbrl"] == "match")
    return {
        "xbrl_checked": len(judged),
        "xbrl_match": match,
        "xbrl_mismatch": len(judged) - match,
        "quote_rejected": sum(1 for c in verified if c["status"] == "rejected" and not c.get("xbrl")),
        "total_claims": len(verified),
    }


# ----------------------------- LLM call + cache --------------------------------

def cache_key(doc_text: str, model: str = DEFAULT_MODEL) -> str:
    h = hashlib.sha256()
    h.update(f"{model}|{PROMPT_VERSION}|".encode())
    h.update(SYSTEM.encode())
    h.update(doc_text.encode())
    return h.hexdigest()


def parse_json(text: str) -> dict:
    text = text.strip()
    text = re.sub(r"^```(?:json)?\s*|\s*```$", "", text)
    i, j = text.find("{"), text.rfind("}")
    if i < 0 or j < 0:
        raise ValueError("no JSON object in model output")
    return json.loads(text[i : j + 1])


def call_anthropic(doc_text: str, model: str, api_key: str, max_chars: int = 120_000) -> dict:
    import requests  # imported lazily so the offline build needs no network libs

    r = requests.post(
        "https://api.anthropic.com/v1/messages",
        headers={"x-api-key": api_key, "anthropic-version": "2023-06-01", "content-type": "application/json"},
        json={
            "model": model,
            "max_tokens": 4096,
            "temperature": 0,
            "system": SYSTEM,
            "messages": [{"role": "user", "content": "DOCUMENT:\n" + doc_text[:max_chars]}],
        },
        timeout=180,
    )
    r.raise_for_status()
    body = r.json()
    text = "".join(b.get("text", "") for b in body.get("content", []) if b.get("type") == "text")
    return {"raw_text": text, "usage": body.get("usage"), "stop_reason": body.get("stop_reason")}


def extract_cached(doc_text: str, cache_dir: Path, api_key: str | None, model: str = DEFAULT_MODEL):
    """Return (extraction_dict | None, meta). Never calls the API if a cache entry exists."""
    cache_dir.mkdir(parents=True, exist_ok=True)
    key = cache_key(doc_text, model)
    p = cache_dir / f"{key}.json"
    if p.exists():
        d = json.loads(p.read_text())
        return d["extraction"], {"cache": "hit", "key": key, "model": d.get("model")}
    if not api_key:
        return None, {"cache": "miss-no-key", "key": key}
    resp = call_anthropic(doc_text, model, api_key)
    extraction = parse_json(resp["raw_text"])
    p.write_text(
        json.dumps(
            {"model": model, "prompt_version": PROMPT_VERSION, "usage": resp.get("usage"), "extraction": extraction},
            ensure_ascii=False,
            indent=1,
        )
    )
    return extraction, {"cache": "miss-called", "key": key, "model": model}
