"""Deterministic reaction engine. No LLM, no look-ahead.

For an earnings release published at `pub` (UTC), we measure how far the rToken
moved while the cash market was closed, and compare it with the gap the cash
market then printed at the next regular open.

Definitions (all log returns, ET = America/New_York):
  base_close   cash close of the last trading day before the release (16:00 ET)
  target_open  09:30 ET of the first trading day that opens after the release
  rt_close     rToken price at 16:00 ET of the base day
  rt_pub       rToken price at the release time
  rt_preopen   rToken price at 09:25 ET of the target day
  rt_move      ln(rt_preopen / rt_close)            what the rToken did overnight
  rt_pre_pub   ln(rt_pub / rt_close)                 what it did BEFORE the release
  rt_post_pub  ln(rt_preopen / rt_pub)               what it did AFTER the release
  cash_gap     ln(cash_open_target / cash_close_base)
  residual     ln(cash_open_target / rt_preopen)     what the rToken had NOT priced
  priced_in    rt_move / cash_gap  (only if |cash_gap| >= MIN_GAP)
"""
from __future__ import annotations

import math
from dataclasses import dataclass
from datetime import datetime, time, timedelta, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

import pandas as pd

ET = ZoneInfo("America/New_York")
UTC = timezone.utc
CANDLE = timedelta(minutes=15)
MAX_STALE = timedelta(minutes=60)  # a price older than this is treated as missing
MIN_GAP = 0.005  # |cash gap| below 0.5% -> ratio is meaningless


def load_rtoken(path: str | Path) -> pd.DataFrame:
    df = pd.read_csv(path)
    df["t"] = pd.to_datetime(df["ts_ms"], unit="ms", utc=True)
    df = df.drop_duplicates("t").sort_values("t").set_index("t")
    return df[["open", "high", "low", "close"]].astype(float)


def load_cash(path: str | Path) -> pd.DataFrame:
    df = pd.read_csv(path, parse_dates=["date"])
    df = df.drop_duplicates("date").sort_values("date")
    df["date"] = df["date"].dt.date
    return df.set_index("date")[["open", "high", "low", "close"]].astype(float)


def price_at(rt: pd.DataFrame, ts: datetime) -> float | None:
    """Close of the last fully-closed 15m candle at or before `ts`."""
    ts = ts.astimezone(UTC)
    # candle opened at T closes at T+15m; usable if T+15m <= ts
    cutoff = ts - CANDLE
    sub = rt.loc[:cutoff]
    if sub.empty:
        return None
    last_t = sub.index[-1]
    if ts - (last_t + CANDLE) > MAX_STALE:
        return None
    return float(sub["close"].iloc[-1])


def _et(d, hh: int, mm: int) -> datetime:
    return datetime.combine(d, time(hh, mm), tzinfo=ET)


def trading_days(cash: pd.DataFrame) -> list:
    return list(cash.index)


def window_for(pub: datetime, days: list):
    """Return (base_day, target_day) or (None, reason)."""
    pub_et = pub.astimezone(ET)
    target = next((d for d in days if _et(d, 9, 30) > pub_et), None)
    if target is None:
        return None, None, "no cash data after the release yet"
    idx = days.index(target)
    if idx == 0:
        return None, None, "no prior trading day in cash data"
    base = days[idx - 1]
    if pub_et < _et(base, 16, 0):
        return None, None, "released during the regular session (cash market open)"
    return base, target, None


def ln(a: float, b: float) -> float:
    return math.log(a / b)


@dataclass
class Reaction:
    ok: bool
    reason: str | None = None
    base_day: str | None = None
    target_day: str | None = None
    rt_close: float | None = None
    rt_pub: float | None = None
    rt_preopen: float | None = None
    cash_close: float | None = None
    cash_open: float | None = None
    rt_move: float | None = None
    rt_pre_pub: float | None = None
    rt_post_pub: float | None = None
    cash_gap: float | None = None
    residual: float | None = None
    priced_in: float | None = None
    sign_agrees: bool | None = None
    path: list | None = None  # [(minutes_since_base_close, pct_vs_rt_close)]
    pub_minute: float | None = None
    preopen_minute: float | None = None
    open_minute: float | None = None

    def to_dict(self) -> dict:
        d = self.__dict__.copy()
        return d


def reaction(pub: datetime, rt: pd.DataFrame, cash: pd.DataFrame) -> Reaction:
    days = trading_days(cash)
    base, target, why = window_for(pub, days)
    if why:
        return Reaction(ok=False, reason=why)
    t_close = _et(base, 16, 0)
    t_pre = _et(target, 9, 25)
    rt_close = price_at(rt, t_close)
    rt_pub = price_at(rt, pub)
    rt_pre = price_at(rt, t_pre)
    if rt_close is None or rt_pre is None or rt_pub is None:
        return Reaction(ok=False, reason="rToken candles missing in the window")
    c_close = float(cash.loc[base, "close"])
    c_open = float(cash.loc[target, "open"])
    gap = ln(c_open, c_close)
    mv = ln(rt_pre, rt_close)
    out = Reaction(
        ok=True,
        base_day=str(base),
        target_day=str(target),
        rt_close=rt_close,
        rt_pub=rt_pub,
        rt_preopen=rt_pre,
        cash_close=c_close,
        cash_open=c_open,
        rt_move=mv,
        rt_pre_pub=ln(rt_pub, rt_close),
        rt_post_pub=ln(rt_pre, rt_pub),
        cash_gap=gap,
        residual=ln(c_open, rt_pre),
    )
    if abs(gap) >= MIN_GAP:
        out.priced_in = mv / gap
        out.sign_agrees = (mv > 0) == (gap > 0) if mv != 0 else None
    # path for the chart, sampled on the 15m grid
    seg = rt.loc[t_close.astimezone(UTC) - CANDLE : t_pre.astimezone(UTC)]
    path = []
    for t, row in seg.iterrows():
        close_t = t + CANDLE
        if close_t < t_close.astimezone(UTC) or close_t > t_pre.astimezone(UTC):
            continue
        minutes = (close_t - t_close.astimezone(UTC)).total_seconds() / 60
        path.append((minutes, 100 * (float(row["close"]) / rt_close - 1)))
    out.path = path
    out.pub_minute = (pub.astimezone(UTC) - t_close.astimezone(UTC)).total_seconds() / 60
    out.preopen_minute = (t_pre.astimezone(UTC) - t_close.astimezone(UTC)).total_seconds() / 60
    out.open_minute = (_et(target, 9, 30).astimezone(UTC) - t_close.astimezone(UTC)).total_seconds() / 60
    return out


def summarize(reactions: list[Reaction]) -> dict:
    """Aggregate over valid events. Always reports n; never implies significance."""
    ok = [r for r in reactions if r.ok]
    ratios = [r.priced_in for r in ok if r.priced_in is not None]
    agree = [r.sign_agrees for r in ok if r.sign_agrees is not None]
    res = [abs(r.residual) for r in ok]

    def med(xs):
        xs = sorted(xs)
        if not xs:
            return None
        m = len(xs) // 2
        return xs[m] if len(xs) % 2 else (xs[m - 1] + xs[m]) / 2

    return {
        "n_events": len(reactions),
        "n_valid": len(ok),
        "n_with_ratio": len(ratios),
        "median_priced_in": med(ratios),
        "sign_agreement": (sum(agree) / len(agree)) if agree else None,
        "n_sign": len(agree),
        "median_abs_residual": med(res),
        "median_abs_cash_gap": med([abs(r.cash_gap) for r in ok]),
        "median_abs_rt_move": med([abs(r.rt_move) for r in ok]),
    }
