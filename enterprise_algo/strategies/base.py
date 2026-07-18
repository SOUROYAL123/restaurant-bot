"""Strategy interface.

A strategy is a pure function of market history -> optional Signal. It must not
place orders, size positions, or read account state; that separation lets the
same strategy run unchanged in the backtester, the paper engine, and live.
"""
from __future__ import annotations

import abc
from typing import List, Optional, Sequence

import numpy as np

from ..domain import Bar, Signal


class Strategy(abc.ABC):
    #: minimum number of bars required before the strategy can emit a signal
    lookback: int = 30
    name: str = "base"

    @abc.abstractmethod
    def generate(self, symbol: str, bars: Sequence[Bar]) -> Optional[Signal]:
        """Return a Signal for the most recent bar, or None to stay flat."""
        raise NotImplementedError

    # -- helpers shared by concrete strategies -------------------------------
    @staticmethod
    def closes(bars: Sequence[Bar]) -> np.ndarray:
        return np.array([b.close for b in bars], dtype=float)

    @staticmethod
    def highs(bars: Sequence[Bar]) -> np.ndarray:
        return np.array([b.high for b in bars], dtype=float)

    @staticmethod
    def lows(bars: Sequence[Bar]) -> np.ndarray:
        return np.array([b.low for b in bars], dtype=float)

    @staticmethod
    def volumes(bars: Sequence[Bar]) -> np.ndarray:
        return np.array([b.volume for b in bars], dtype=float)
