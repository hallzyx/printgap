"""Verifier tests. The document below is a SYNTHETIC TEST FIXTURE, not a real release."""
import unittest

from pg import extract as X

DOC = """ACME Corp announces results for the second quarter of fiscal 2027
Revenue was $46.7 billion, up 12% from a year ago.
GAAP diluted earnings per share was $1.04.
Net income | 25,783 | 16,599
For the third quarter, revenue is expected to be $50.0 billion, plus or minus 2%.
"""
XB = {
    "revenue": {"value": 46_743_000_000.0, "end": "2026-07-26"},
    "eps_diluted": {"value": 1.04, "end": "2026-07-26"},
    "net_income": {"value": 25_783_000_000.0, "end": "2026-07-26"},
}


def claim(**kw):
    base = dict(id="c1", basis="reported", unit="USD")
    base.update(kw)
    return base


class VerifierTests(unittest.TestCase):
    def v(self, c, xb=XB):
        return X.verify_claim(c, X.norm(DOC), xb)

    def test_verified_with_xbrl(self):
        r = self.v(claim(metric="revenue", value=46.7e9, quote="Revenue was $46.7 billion, up 12% from a year ago."))
        self.assertEqual(r["status"], "verified")
        self.assertEqual(r["checks"]["xbrl"], "match")

    def test_table_row_scaled(self):
        r = self.v(claim(metric="net_income", value=25_783e6, quote="Net income | 25,783 | 16,599"))
        self.assertEqual(r["status"], "verified")

    def test_eps(self):
        r = self.v(
            claim(metric="eps_diluted", value=1.04, unit="USD_per_share", quote="GAAP diluted earnings per share was $1.04.")
        )
        self.assertEqual(r["status"], "verified")

    def test_invented_quote_rejected(self):
        r = self.v(claim(metric="revenue", value=46.7e9, quote="Revenue was a record $46.7 billion"))
        self.assertEqual(r["status"], "rejected")
        self.assertIn("quote not found", r["reason"])

    def test_number_not_in_quote_rejected(self):
        r = self.v(claim(metric="revenue", value=47.0e9, quote="Revenue was $46.7 billion, up 12% from a year ago."))
        self.assertEqual(r["status"], "rejected")
        self.assertIn("does not appear", r["reason"])

    def test_quote_matches_but_contradicts_xbrl(self):
        bad = {**XB, "revenue": {"value": 40_000_000_000.0, "end": "2026-07-26"}}
        r = self.v(claim(metric="revenue", value=46.7e9, quote="Revenue was $46.7 billion, up 12% from a year ago."), bad)
        self.assertEqual(r["status"], "rejected")
        self.assertIn("XBRL", r["reason"])

    def test_no_xbrl_yet_is_quote_only_not_verified(self):
        r = self.v(claim(metric="revenue", value=46.7e9, quote="Revenue was $46.7 billion, up 12% from a year ago."), {})
        self.assertEqual(r["status"], "quote_only")

    def test_guidance_is_quote_only(self):
        r = self.v(
            claim(
                metric="guidance_revenue_mid",
                basis="guidance",
                value=50.0e9,
                quote="revenue is expected to be $50.0 billion, plus or minus 2%.",
            )
        )
        self.assertEqual(r["status"], "quote_only")

    def test_whitespace_and_quotes_normalised(self):
        r = self.v(claim(metric="revenue", value=46.7e9, quote="Revenue  was $46.7\nbillion, up 12% from a year ago."))
        self.assertEqual(r["status"], "verified")

    def test_schema_garbage_rejected(self):
        r = self.v({"metric": "vibes", "value": "high", "quote": "x"})
        self.assertEqual(r["status"], "rejected")

    def test_parse_json_tolerates_fences(self):
        d = X.parse_json('```json\n{"claims": []}\n```')
        self.assertEqual(d, {"claims": []})

    def test_accuracy_counts(self):
        res = X.verify_all(
            {
                "claims": [
                    claim(metric="revenue", value=46.7e9, quote="Revenue was $46.7 billion, up 12% from a year ago."),
                    claim(id="c2", metric="net_income", value=25_783e6, quote="Net income | 25,783 | 16,599"),
                    claim(id="c3", metric="gross_profit", value=1.0, quote="made up"),
                ]
            },
            DOC,
            XB,
        )
        acc = X.accuracy(res["claims"])
        self.assertEqual((acc["xbrl_checked"], acc["xbrl_match"], acc["total_claims"]), (2, 2, 3))

    def test_doc_key_changes_with_doc_but_not_with_model(self):
        self.assertNotEqual(X.doc_key("a"), X.doc_key("b"))
        self.assertEqual(X.doc_key("a"), X.doc_key("a"))


class CacheTests(unittest.TestCase):
    def test_lookup_without_label_uses_the_newest_provider(self):
        import tempfile
        from pathlib import Path
        with tempfile.TemporaryDirectory() as t:
            d = Path(t)
            X.cache_store(d, "doc", {"claims": [], "period_label": "old"}, "openai:gpt-4.1")
            X.cache_store(d, "doc", {"claims": [], "period_label": "new"}, "deepseek:deepseek-chat")
            ex, meta = X.cache_lookup(d, "doc")
            self.assertEqual((ex["period_label"], meta["model"]), ("new", "deepseek:deepseek-chat"))
            ex, meta = X.cache_lookup(d, "doc", "openai:gpt-4.1")
            self.assertEqual(ex["period_label"], "old")
            self.assertEqual(X.cache_lookup(d, "doc", "anthropic:x"), (None, None))
            self.assertEqual(X.cache_lookup(d, "other doc"), (None, None))

    def test_extract_cached_without_provider_never_calls_out(self):
        import tempfile
        from pathlib import Path
        with tempfile.TemporaryDirectory() as t:
            ex, meta = X.extract_cached("never seen", Path(t), None)
            self.assertIsNone(ex)
            self.assertEqual(meta["cache"], "miss-no-key")


if __name__ == "__main__":
    unittest.main()
