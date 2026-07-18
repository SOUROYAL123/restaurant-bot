"""Classic trend-following: fast EMA crossing slow EMA, filtered by an optional
long-term SMA trend gate. Simple, robust, and a good baseline benchmark.
"""
from __future__ import annotations

from typing import Optional, Sequence

import numpy as np

from .. import indicators as ind
from ..domain import Bar, Signal, SignalType
from .base import Strategy


class MACrossoverStrategy(Strategy):
    name = "ma_crossover"

    def __init__(self, fast: int = 9, slow: int = 21, trend: int = 50,
                 atr_period: int = 14, stop_atr_mult: float = 2.0,
                 target_atr_mult: float = 3.0):
        self.fast = fast
        self.slow = slow
        self.trend = trend
        self.atr_period = atr_period
        self.stop_atr_mult = stop_atr_mult
        self.target_atr_mult = target_atr_mult
        self.lookback = max(slow, trend) + 2

    def generate(self, symbol: str, bars: Sequence[Bar]) -> Optional[Signal]:
        if len(bars) < self.lookback:
            return None

        close = self.closes(bars)
        high = self.highs(bars)
        low = self.lows(bars)
        price = float(close[-1])

        ema_fast = ind.ema(close, self.fast)
        ema_slow = ind.ema(close, self.slow)
        sma_trend = ind.sma(close, self.trend)

        if np.isnan(ema_fast[-2]) or np.isnan(ema_slow[-2]) or np.isnan(sma_trend[-1]):
            return None

        crossed_up = ema_fast[-2] <= ema_slow[-2] and ema_fast[-1] > ema_slow[-1]
        crossed_down = ema_fast[-2] >= ema_slow[-2] and ema_fast[-1] < ema_slow[-1]
        uptrend = price > sma_trend[-1]

        atr = ind.atr(high, low, close, self.atr_period)
        atr_val = float(atr[-1]) if not np.isnan(atr[-1]) else price * 0.01

        # Confidence reflects trend conviction, not EMA separation: at the
        # crossover the two EMAs are equal, so their gap is ~0 and would spuriously
        # veto every signal. Distance of price from the long-term trend line
        # (in ATR units) is a far better proxy for how strong the trend is.
        trend_strength = min(1.0, abs(price - sma_trend[-1]) / (2.0 * max(atr_val, 1e-9)))
        confidence = min(1.0, 0.60 + 0.40 * trend_strength)

        if crossed_up and uptrend:
            return Signal(symbol=symbol, type=SignalType.BUY, confidence=confidence,
                          timestamp=bars[-1].timestamp, price=price,
                          reason="EMA fast crossed above slow in uptrend",
                          stop_loss=price - self.stop_atr_mult * atr_val,
                          take_profit=price + self.target_atr_mult * atr_val)
        if crossed_down and not uptrend:
            return Signal(symbol=symbol, type=SignalType.SELL, confidence=confidence,
                          timestamp=bars[-1].timestamp, price=price,
                          reason="EMA fast crossed below slow in downtrend",
                          stop_loss=price + self.stop_atr_mult * atr_val,
                          take_profit=price - self.target_atr_mult * atr_val)
        return None
