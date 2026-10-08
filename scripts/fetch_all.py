#!/usr/bin/env python3
"""Download everything PrintGap needs. Runs in GitHub Actions (open internet).

Env: EDGAR_UA (required, 'Name contact@email').
Model key (optional): ANTHROPIC_API_KEY, OPENAI_API_KEY, DEEPSEEK_API_KEY, or LLM_API_KEY with
PRINTGAP_BASE_URL and PRINTGAP_MODEL. See pg/llm.py. Without a key, only cached extractions are used.
Every file written is listed in data/manifest.json with its fetch time and sha256.
"""
from __future__ import annotations

import hashlib
import json
import os
import sys
import traceback
from datetime import date, datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from pg import edgar, extract, llm, mcp  # noqa: E402

DATA = ROOT / "data"
SINCE = date.fromisoformat(os.environ.get("PRINTGAP_SINCE", "2026-03-01"))  # includes the PRIOR quarter's release (for guidance)


def now():
    return datetime.now(timezone.utc).isoformat()


def sha(p: Path) -> str:
    return hashlib.sha256(p.read_bytes()).hexdigest()


def main() -> int:
    manifest = {"fetched_at_utc": now(), "since": str(SINCE), "files": {}, "errors": [], "notes": []}
    s = edgar._session()
    try:
        provider = llm.resolve(os.environ)
    except ValueError as e:
        print(f"LLM configuration problem: {e}", file=sys.stderr)
        return 2
    manifest["notes"].append(f"extraction provider: {provider.label if provider else 'none (cached extractions only)'}")

    for t, (cik, label) in edgar.TICKERS.items():
        try:
            name, evs = edgar.list_earnings_8k(s, cik, SINCE)
            if label.lower() not in name.lower():
                manifest["errors"].append(f"{t}: CIK {cik} resolved to '{name}', expected '{label}' - skipped")
                continue
            out = DATA / "edgar" / t
            out.mkdir(parents=True, exist_ok=True)
            for ev in evs:
                p = out / f"{ev['accession']}.json"
                if not p.exists():
                    try:
                        pr = edgar.fetch_press_release(s, cik, ev["accession"])
                    except Exception as e:  # noqa: BLE001
                        manifest["errors"].append(f"{t} {ev['accession']}: press release: {e}")
                        continue
                    rec = {"ticker": t, "cik": cik, "company": name, **ev, **pr, "fetched_at_utc": now()}
                    p.write_text(json.dumps(rec, ensure_ascii=False, indent=1))
                manifest["files"][str(p.relative_to(ROOT))] = sha(p)
            # XBRL company facts (trimmed)
            xp = DATA / "xbrl" / f"{t}.json"
            xp.parent.mkdir(parents=True, exist_ok=True)
            xp.write_text(json.dumps(edgar.fetch_companyfacts(s, cik), ensure_ascii=False))
            manifest["files"][str(xp.relative_to(ROOT))] = sha(xp)
        except Exception as e:  # noqa: BLE001
            manifest["errors"].append(f"{t}: {e}")
            traceback.print_exc()

    # LLM extraction (cached by content hash)
    n_called = n_hit = n_skip = 0
    for p in sorted((DATA / "edgar").glob("*/*.json")):
        rec = json.loads(p.read_text())
        try:
            ex, meta = extract.extract_cached(rec["text"], DATA / "extractions", provider)
        except Exception as e:  # noqa: BLE001
            manifest["errors"].append(f"extract {p.name}: {e}")
            continue
        n_called += meta["cache"] == "miss-called"
        n_hit += meta["cache"] == "hit"
        n_skip += meta["cache"] == "miss-no-key"
    manifest["notes"].append(f"extraction: called={n_called} cache_hit={n_hit} skipped_no_key={n_skip}")

    # Bitget MCP: capture the real catalog first, never assume parameters
    try:
        c = mcp.Client()
        c.start()
        mdir = DATA / "mcp"
        mdir.mkdir(exist_ok=True)
        (mdir / "tools.json").write_text(json.dumps(c.list_tools(), ensure_ascii=False, indent=1))
        try:
            (mdir / "guide.json").write_text(json.dumps(c.call("guide", {}), ensure_ascii=False, indent=1))
        except Exception as e:  # noqa: BLE001
            manifest["errors"].append(f"mcp guide: {e}")
        manifest["notes"].append("mcp: tools/list captured")
        for f in mdir.glob("*.json"):
            manifest["files"][str(f.relative_to(ROOT))] = sha(f)
    except Exception as e:  # noqa: BLE001
        manifest["notes"].append(f"mcp: unavailable ({e})")

    (DATA / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=1))
    print(json.dumps({k: manifest[k] for k in ("errors", "notes")}, indent=1))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
