"""Synthetic fixtures (not real filings) to test selection logic."""
import unittest

from pg import edgar as G


def facts():
    rows = [
        {"start": "2025-04-27", "end": "2025-07-27", "val": 30_040e6, "form": "10-Q", "filed": "2025-08-27"},
        {"start": "2026-02-02", "end": "2026-05-03", "val": 44_000e6, "form": "10-Q", "filed": "2026-05-30"},
        {"start": "2026-04-27", "end": "2026-07-26", "val": 46_743e6, "form": "10-Q", "filed": "2026-08-28"},
    ]
    return {"facts": {"revenue": [{"tag": "Revenues", "unit": "USD", "rows": rows}]}}


class XbrlSelection(unittest.TestCase):
    def test_picks_reported_quarter_and_yoy(self):
        r = G.xbrl_for_release(facts(), "2026-08-26")  # 10-Q for Jul-26 quarter not needed to exist by then
        # NOTE: the fact has filed=2026-08-28 (after the release). We still use the period itself.
        self.assertEqual(r["revenue"]["end"], "2026-07-26")
        self.assertEqual(r["revenue"]["value"], 46_743e6)
        self.assertEqual(r["revenue"]["yoy_prior"], 30_040e6)

    def test_never_falls_back_to_older_quarter(self):
        # release 120 days after the latest known quarter end: the 10-Q is not on file -> nothing
        r = G.xbrl_for_release(facts(), "2026-11-20")
        self.assertNotIn("revenue", r)

    def test_ignores_periods_ending_after_release(self):
        r = G.xbrl_for_release(facts(), "2026-07-01")
        self.assertEqual(r["revenue"]["end"], "2026-05-03")

    def test_trim_keeps_only_quarters(self):
        raw = {
            "entityName": "X",
            "facts": {"us-gaap": {"Revenues": {"units": {"USD": [
                {"start": "2025-01-01", "end": "2025-12-31", "val": 1, "form": "10-K"},  # annual
                {"start": "2026-01-01", "end": "2026-03-31", "val": 2, "form": "10-Q"},  # quarter
                {"end": "2026-03-31", "val": 3},  # instant
            ]}}}},
        }
        t = G.trim_companyfacts(raw)
        self.assertEqual([r["val"] for r in t["facts"]["revenue"][0]["rows"]], [2])


class HtmlText(unittest.TestCase):
    def test_table_and_blocks(self):
        t = G.html_to_text("<p>Revenue was $1.0 billion</p><table><tr><td>Net income</td><td>25,783</td></tr></table><script>x</script>")
        self.assertIn("Revenue was $1.0 billion", t)
        self.assertIn("Net income | 25,783", t)
        self.assertNotIn("x</", t)


if __name__ == "__main__":
    unittest.main()
