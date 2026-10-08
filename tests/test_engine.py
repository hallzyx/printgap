import unittest
from datetime import datetime, timezone
from pathlib import Path

import pandas as pd

from pg import engine as E

FX = Path(__file__).resolve().parents[1] / "data" / "fixtures"
UTC = timezone.utc


def utc(*a):
    return datetime(*a, tzinfo=UTC)


class EngineTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.rt = E.load_rtoken(FX / "rtoken_15m/RNVDAUSDT.csv")
        cls.cash = E.load_cash(FX / "cash_daily/NVDA.csv")

    def test_after_close_release_has_overnight_window(self):
        # 16:05 ET on a Wednesday == 20:05 UTC (EDT). Mechanics test only.
        r = E.reaction(utc(2026, 8, 26, 20, 5), self.rt, self.cash)
        self.assertTrue(r.ok, r.reason)
        self.assertEqual((r.base_day, r.target_day), ("2026-08-26", "2026-08-27"))
        self.assertAlmostEqual(r.rt_move, r.rt_pre_pub + r.rt_post_pub, places=12)
        self.assertAlmostEqual(r.cash_gap, E.ln(r.cash_open, r.cash_close), places=12)
        self.assertTrue(r.path)
        self.assertGreaterEqual(r.path[0][0], 0)
        self.assertLessEqual(r.path[-1][0], 17.5 * 60 + 1)

    def test_in_session_release_is_excluded(self):
        r = E.reaction(utc(2026, 8, 26, 17, 0), self.rt, self.cash)  # 13:00 ET
        self.assertFalse(r.ok)
        self.assertIn("regular session", r.reason)

    def test_weekend_release_targets_monday(self):
        r = E.reaction(utc(2026, 8, 28, 20, 30), self.rt, self.cash)  # Fri 16:30 ET
        self.assertTrue(r.ok, r.reason)
        self.assertEqual(r.target_day, "2026-08-31")
        self.assertGreater(r.path[-1][0], 24 * 60)

    def test_release_after_data_end_is_not_invented(self):
        r = E.reaction(utc(2026, 10, 1, 20, 5), self.rt, self.cash)
        self.assertFalse(r.ok)

    def test_price_at_uses_only_closed_candles(self):
        idx = pd.to_datetime(["2026-01-05 14:00", "2026-01-05 14:15"], utc=True)
        rt = pd.DataFrame(
            {"open": [1, 2], "high": [1, 2], "low": [1, 2], "close": [10.0, 20.0]}, index=idx
        )
        self.assertEqual(E.price_at(rt, utc(2026, 1, 5, 14, 20)), 10.0)  # 14:15 not closed yet
        self.assertEqual(E.price_at(rt, utc(2026, 1, 5, 14, 30)), 20.0)
        self.assertIsNone(E.price_at(rt, utc(2026, 1, 5, 16, 0)))  # stale > 60 min

    def test_ratio_suppressed_when_gap_tiny(self):
        r = E.Reaction(ok=True, rt_move=0.001, cash_gap=0.0001, residual=0.0)
        s = E.summarize([r])
        self.assertEqual((s["n_valid"], s["n_with_ratio"]), (1, 0))
        self.assertIsNone(s["median_priced_in"])


if __name__ == "__main__":
    unittest.main()
