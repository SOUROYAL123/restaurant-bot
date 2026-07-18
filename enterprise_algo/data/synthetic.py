"""Offline synthetic data provider.

Generates deterministic geometric-Brownian-motion OHLCV series so the whole
system (backtest + paper) runs with zero network access and zero credentials.
Ideal for CI, demos, and reproducible tests.
"""
from __future__ import annotations

from datetime import datetime, timedelta
from typing import Dict, List, Optional

import numpy as np

from ..domain import Bar
from .base import DataProvider


class SyntheticDataProvider(DataProvider):
    def __init__(self, seed: int = 42, start_price: float = 1000.0,
                 annual_drift: float = 0.10, annual_vol: float = 0.30,
                 base_prices: Optional[Dict[str, float]] = None):
        self.seed = seed
        self.start_price = start_price
        self.annual_drift = annual_drift
        self.annual_vol = annual_vol
        self.base_prices = base_prices or {}
        self._last: Dict[str, float] = {}

    def _symbol_seed(self, symbol: str) -> int:
        return (self.seed + abs(hash(symbol))) % (2 ** 32)

    def get_historical(self, symbol: str, interval: str,
                       start: datetime, end: datetime) -> List[Bar]:
        rng = np.random.default_rng(self._symbol_seed(symbol))
        step = timedelta(days=1) if interval.endswith("day") else timedelta(minutes=1)
        n = max(1, int((end - start) / step))
        n = min(n, 5000)  # cap

        # bars-per-year for drift/vol scaling
        per_year = 252 if step >= timedelta(days=1) else 252 * 375
        dt = 1.0 / per_year
        mu, sigma = self.annual_drift, self.annual_vol

        p0 = self.base_prices.get(symbol, self.start_price)
        shocks = rng.normal((mu - 0.5 * sigma ** 2) * dt, sigma * np.sqrt(dt), n)
        closes = p0 * np.exp(np.cumsum(shocks))

        bars: List[Bar] = []
        t = start
        prev = p0
        for i in range(n):
            c = float(closes[i])
            o = prev
            intrabar = abs(rng.normal(0, sigma * np.sqrt(dt))) * max(o, c)
            hi = max(o, c) + intrabar
            lo = min(o, c) - intrabar
            vol = float(rng.integers(50_000, 500_000))
            bars.append(Bar(t, round(o, 2), round(hi, 2), round(lo, 2), round(c, 2), vol))
            prev = c
            t += step
        if bars:
            self._last[symbol] = bars[-1].close
        return bars

    def get_latest_price(self, symbol: str) -> Optional[float]:
        if symbol in self._last:
            return self._last[symbol]
        bars = self.get_historical(symbol, "1day",
                                   datetime.now() - timedelta(days=60), datetime.now())
        return bars[-1].close if bars else None
