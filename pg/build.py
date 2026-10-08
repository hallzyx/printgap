"""Offline, reproducible build: data/ -> site/data/events.json. No network, no LLM calls."""
from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path

from . import edgar, engine, extract

ROOT = Path(__file__).resolve().parents[1]
DATA = ROOT / "data"
FX = DATA / "fixtures"
UTC = timezone.utc


def _claim(claims, metric, basis):
    for c in claims:
        if c["metric"] == metric and c["basis"] == basis and c["status"] != "rejected":
            return c
    return None


def guidance_range(claims):
    """(low, high, mid, source_ids) from a release's verified guidance claims, or None."""
    lo, hi = _claim(claims, "guidance_revenue_low", "guidance"), _claim(claims, "guidance_revenue_high", "guidance")
    mid, tol = _claim(claims, "guidance_revenue_mid", "guidance"), _claim(claims, "guidance_tolerance_pct", "guidance")
    if lo and hi:
        return lo["value"], hi["value"], (lo["value"] + hi["value"]) / 2, [lo["id"], hi["id"]]
    if mid and tol:
        m, t = mid["value"], tol["value"] / 100
        return m * (1 - t), m * (1 + t), m, [mid["id"], tol["id"]]
    if mid:
        return None
    return None


def expectation_gap(claims, prior_claims, prior_id):
    actual = _claim(claims, "revenue", "reported")
    g = guidance_range(prior_claims) if prior_claims else None
    if not actual:
        return {"available": False, "reason": "revenue figure not extracted/verified for this release"}
    if not g:
        return {"available": False, "reason": "no usable prior-quarter revenue guidance on file"}
    lo, hi, mid, ids = g
    pos = "above range" if actual["value"] > hi else "below range" if actual["value"] < lo else "within range"
    return {
        "available": True,
        "basis": "prior-quarter company guidance (NOT analyst consensus)",
        "actual": actual["value"],
        "actual_claim": actual["id"],
        "guide_low": lo,
        "guide_high": hi,
        "guide_mid": mid,
        "guide_claims": ids,
        "guide_from_event": prior_id,
        "vs_mid_pct": 100 * (actual["value"] / mid - 1),
        "position": pos,
        "actual_status": actual["status"],
    }


def _round_path(path):
    return [[round(m, 1), round(p, 3)] for m, p in (path or [])][::1]


def build(out: Path | None = None, data: Path | None = None, fx: Path | None = None) -> dict:
    out = out or ROOT / "site" / "data" / "events.json"
    DATA, FX = data or globals()["DATA"], fx or globals()["FX"]
    events, reactions = [], []
    acc_tot = {"xbrl_checked": 0, "xbrl_match": 0, "xbrl_mismatch": 0, "quote_rejected": 0, "total_claims": 0}
    not_extracted = 0
    models = set()

    for t, (_cik, _label) in edgar.TICKERS.items():
        docs = [json.loads(p.read_text()) for p in sorted((DATA / "edgar" / t).glob("*.json"))] if (DATA / "edgar" / t).exists() else []
        docs.sort(key=lambda d: d["acceptance_utc"])
        xp = DATA / "xbrl" / f"{t}.json"
        trimmed = json.loads(xp.read_text()) if xp.exists() else {"facts": {}}
        rtp, cp = FX / "rtoken_15m" / f"R{t}USDT.csv", FX / "cash_daily" / f"{t}.csv"
        rt = engine.load_rtoken(rtp) if rtp.exists() else None
        cash = engine.load_cash(cp) if cp.exists() else None
        prev = None
        for d in docs:
            pub = datetime.fromisoformat(d["acceptance_utc"]).astimezone(UTC)
            xb = edgar.xbrl_for_release(trimmed, d["filing_date"])
            ex, meta = extract.extract_cached(d["text"], DATA / "extractions", None)
            if meta.get("model"):
                models.add(meta["model"])
            if ex is None:
                not_extracted += 1
                ver = {"period_label": None, "claims": []}
            else:
                ver = extract.verify_all(ex, d["text"], xb)
            claims = ver["claims"]
            acc = extract.accuracy(claims)
            for k in acc_tot:
                acc_tot[k] += acc[k]
            if rt is not None and cash is not None:
                rx = engine.reaction(pub, rt, cash)
            else:
                rx = engine.Reaction(ok=False, reason="no rToken/cash price data for this ticker")
            reactions.append(rx)
            ev_id = f"{t}-{d['accession']}"
            rev = xb.get("revenue")
            events.append(
                {
                    "id": ev_id,
                    "ticker": t,
                    "company": d.get("company"),
                    "pub_utc": pub.isoformat(),
                    "pub_et": pub.astimezone(engine.ET).strftime("%Y-%m-%d %H:%M ET"),
                    "filing_date": d["filing_date"],
                    "accession": d["accession"],
                    "url": d["url"],
                    "sha256_raw": d["sha256_raw"],
                    "period_label": ver["period_label"],
                    "extraction": meta,
                    "claims": claims,
                    "accuracy": acc,
                    "xbrl_period_end": rev["end"] if rev else None,
                    "yoy_revenue_pct": (100 * (rev["value"] / rev["yoy_prior"] - 1)) if rev and rev.get("yoy_prior") else None,
                    "gap": expectation_gap(claims, prev["claims"] if prev else None, prev["id"] if prev else None),
                    "reaction": {
                        **{k: v for k, v in rx.to_dict().items() if k != "path"},
                        "path": _round_path(rx.path),
                    },
                }
            )
            prev = {"id": ev_id, "claims": claims}

    manifest = json.loads((DATA / "manifest.json").read_text()) if (DATA / "manifest.json").exists() else None
    src_manifest = json.loads((FX / "SOURCE_MANIFEST.json").read_text()) if (FX / "SOURCE_MANIFEST.json").exists() else None
    events.sort(key=lambda e: e["pub_utc"], reverse=True)
    result = {
        "generated_at_utc": datetime.now(UTC).isoformat(),
        "n_events": len(events),
        "events_without_extraction": not_extracted,
        "extraction_models": sorted(models),
        "analogs": engine.summarize(reactions),
        "accuracy_total": acc_tot,
        "fetch": {
            "fetched_at_utc": manifest["fetched_at_utc"] if manifest else None,
            "errors": manifest["errors"] if manifest else [],
            "notes": manifest["notes"] if manifest else [],
        },
        "price_data": {
            "source": "github.com/Megacollins/rift24 fixtures (MIT) - rToken 15m candles from Bitget and daily cash bars",
            "fetched_at_utc": (src_manifest or {}).get("fetched_at_utc"),
        },
        "events": events,
    }
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(result, ensure_ascii=False, indent=1))
    return result


if __name__ == "__main__":
    r = build()
    print(f"events={r['n_events']} valid_reactions={r['analogs']['n_valid']} accuracy={r['accuracy_total']}")
