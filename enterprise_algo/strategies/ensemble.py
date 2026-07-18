"""Ensemble strategy: weighted vote across RSI, MACD, Bollinger, Stochastic,
and momentum. Ports the intent of the legacy EnsembleSignalGenerator onto the
vectorized indicator library, and adds ATR-based stop/target hints.
"""
from __future__ import annotations

from typing import Optional, Sequence

import numpy as np

from .. import indicators as ind
from ..domain import Bar, Signal, SignalType
from .base import Strategy


class EnsembleStrategy(Strategy):
    name = "ensemble"

    WEIGHTS = {
        "rsi": 0.20,
        "macd": 0.25,
        "bb": 0.20,
        "stoch": 0.15,
        "momentum": 0.20,
    }

    def __init__(self, confidence_threshold: float = 0.4, atr_period: int = 14,
                 stop_atr_mult: float = 2.0, target_atr_mult: float = 3.0):
        self.confidence_threshold = confidence_threshold
        self.atr_period = atr_period
        self.stop_atr_mult = stop_atr_mult
        self.target_atr_mult = target_atr_mult
        self.lookback = 40

    def generate(self, symbol: str, bars: Sequence[Bar]) -> Optional[Signal]:
        if len(bars) < self.lookback:
            return None

        close = self.closes(bars)
        high = self.highs(bars)
        low = self.lows(bars)
        price = float(close[-1])

        votes = {}

        # RSI
        rsi = ind.rsi(close, 14)
        r = rsi[-1]
        if not np.isnan(r):
            votes["rsi"] = 1 if r < 30 else (-1 if r > 70 else 0)

        # MACD histogram sign
        _, _, hist = ind.macd(close)
        h = hist[-1]
        if not np.isnan(h):
            votes["macd"] = 1 if h > 0 else (-1 if h < 0 else 0)

        # Bollinger reversion
        upper, mid, lower = ind.bollinger_bands(close, 20)
        if not np.isnan(lower[-1]):
            votes["bb"] = 1 if price < lower[-1] else (-1 if price > upper[-1] else 0)

        # Stochastic
        k = ind.stochastic_k(high, low, close, 14)
        if not np.isnan(k[-1]):
            votes["stoch"] = 1 if k[-1] < 20 else (-1 if k[-1] > 80 else 0)

        # Momentum
        mom = ind.momentum(close, 10)
        if not np.isnan(mom[-1]):
            votes["momentum"] = 1 if mom[-1] > 0.5 else (-1 if mom[-1] < -0.5 else 0)

        if not votes:
            return None

        total_weight = sum(self.WEIGHTS[k] for k in votes)
        score = sum(votes[k] * self.WEIGHTS[k] for k in votes) / total_weight
        confidence = min(1.0, abs(score))

        atr = ind.atr(high, low, close, self.atr_period)
        atr_val = float(atr[-1]) if not np.isnan(atr[-1]) else price * 0.01

        if score > self.confidence_threshold:
            return Signal(
                symbol=symbol, type=SignalType.BUY, confidence=confidence,
                timestamp=bars[-1].timestamp, price=price,
                reason=f"ensemble score={score:.2f} votes={votes}",
                stop_loss=price - self.stop_atr_mult * atr_val,
                take_profit=price + self.target_atr_mult * atr_val,
            )
        if score < -self.confidence_threshold:
            return Signal(
                symbol=symbol, type=SignalType.SELL, confidence=confidence,
                timestamp=bars[-1].timestamp, price=price,
                reason=f"ensemble score={score:.2f} votes={votes}",
                stop_loss=price + self.stop_atr_mult * atr_val,
                take_profit=price - self.target_atr_mult * atr_val,
            )
        return Signal(symbol=symbol, type=SignalType.HOLD, confidence=confidence,
                      timestamp=bars[-1].timestamp, price=price,
                      reason=f"ensemble score={score:.2f}")
