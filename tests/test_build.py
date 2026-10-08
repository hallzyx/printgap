"""End-to-end offline build on a SYNTHETIC filing set (documents and XBRL are invented for the test;
prices are the real fixtures). Proves the chain doc -> verified claims -> gap -> reaction works."""
import json
import tempfile
import unittest
from pathlib import Path

from pg import build, extract

ROOT = Path(__file__).resolve().parents[1]

PRIOR_DOC = "ACME Q1 results. Revenue was $40.0 billion. For the second quarter, revenue is expected to be $44.0 billion, plus or minus 2%."
CUR_DOC = "ACME Q2 results\nRevenue was $46.7 billion, up 14% from a year ago.\nNet income | 25,783 | 16,599\n"


def write_event(d, t, acc, filing_date, accept, doc, claims):
    (d / "edgar" / t).mkdir(parents=True, exist_ok=True)
    rec = {"ticker": t, "cik": 1, "company": "NVIDIA CORP", "accession": acc, "filing_date": filing_date,
           "acceptance_utc": accept, "items": "2.02,9.01", "url": "https://example.test/x", "sha256_raw": "0" * 64, "text": doc}
    (d / "edgar" / t / f"{acc}.json").write_text(json.dumps(rec))
    extract.cache_store(d / "extractions", doc, {"period_label": "test", "claims": claims}, "test:fixture")


class BuildE2E(unittest.TestCase):
    def test_pipeline(self):
        with tempfile.TemporaryDirectory() as tmp:
            d = Path(tmp)
            write_event(d, "NVDA", "0000000000-26-000001", "2026-05-20", "2026-05-20T20:20:00+00:00", PRIOR_DOC, [
                {"id": "c1", "metric": "guidance_revenue_mid", "basis": "guidance", "value": 44e9, "unit": "USD",
                 "quote": "revenue is expected to be $44.0 billion, plus or minus 2%"},
                {"id": "c2", "metric": "guidance_tolerance_pct", "basis": "guidance", "value": 2, "unit": "percent",
                 "quote": "plus or minus 2%"},
            ])
            write_event(d, "NVDA", "0000000000-26-000002", "2026-08-26", "2026-08-26T20:20:00+00:00", CUR_DOC, [
                {"id": "c1", "metric": "revenue", "basis": "reported", "value": 46.7e9, "unit": "USD",
                 "quote": "Revenue was $46.7 billion, up 14% from a year ago."},
                {"id": "c2", "metric": "net_income", "basis": "reported", "value": 25_783e6, "unit": "USD",
                 "quote": "Net income | 25,783 | 16,599"},
                {"id": "c3", "metric": "gross_profit", "basis": "reported", "value": 9e9, "unit": "USD",
                 "quote": "Gross profit was a record $9.0 billion"},  # hallucinated -> must be rejected
            ])
            (d / "xbrl").mkdir()
            rows = lambda end, start, v: {"start": start, "end": end, "val": v, "form": "10-Q", "filed": "2026-09-01"}
            (d / "xbrl" / "NVDA.json").write_text(json.dumps({"facts": {
                "revenue": [{"tag": "Revenues", "unit": "USD", "rows": [
                    rows("2025-07-27", "2025-04-28", 40_960e6), rows("2026-07-26", "2026-04-27", 46_743e6)]}],
                "net_income": [{"tag": "NetIncomeLoss", "unit": "USD", "rows": [rows("2026-07-26", "2026-04-27", 25_783e6)]}],
            }}))
            out = d / "events.json"
            res = build.build(out=out, data=d, fx=ROOT / "data" / "fixtures")

            self.assertEqual(res["n_events"], 2)
            cur = next(e for e in res["events"] if e["accession"].endswith("2"))
            st = {c["metric"]: c["status"] for c in cur["claims"]}
            self.assertEqual(st, {"revenue": "verified", "net_income": "verified", "gross_profit": "rejected"})
            self.assertEqual(cur["accuracy"]["xbrl_match"], 2)
            self.assertAlmostEqual(cur["yoy_revenue_pct"], 100 * (46_743 / 40_960 - 1), places=6)
            g = cur["gap"]
            self.assertTrue(g["available"])
            self.assertEqual(g["position"], "above range")  # 46.7 > 44*1.02
            self.assertAlmostEqual(g["vs_mid_pct"], 100 * (46.7 / 44 - 1), places=6)
            self.assertIn("NOT analyst consensus", g["basis"])
            self.assertTrue(cur["reaction"]["ok"], cur["reaction"]["reason"])
            prior = next(e for e in res["events"] if e["accession"].endswith("1"))
            self.assertFalse(prior["reaction"]["ok"])  # before the price data starts: reported, not invented
            self.assertFalse(prior["gap"]["available"])
            self.assertEqual(res["analogs"]["n_valid"], 1)
            self.assertEqual(res["extraction_models"], ["test:fixture"])

    def test_missing_extraction_is_visible_not_silent(self):
        with tempfile.TemporaryDirectory() as tmp:
            d = Path(tmp)
            write_event(d, "NVDA", "0000000000-26-000003", "2026-08-26", "2026-08-26T20:20:00+00:00", "doc", [])
            for p in (d / "extractions").glob("*.json"):
                p.unlink()
            res = build.build(out=d / "e.json", data=d, fx=ROOT / "data" / "fixtures")
            self.assertEqual(res["events_without_extraction"], 1)
            self.assertEqual(res["events"][0]["claims"], [])


if __name__ == "__main__":
    unittest.main()
