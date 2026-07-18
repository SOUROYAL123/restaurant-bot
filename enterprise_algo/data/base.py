"""Data-provider interface. All providers return the package's neutral Bar type
so strategies and engines never depend on a specific broker's JSON shape.
"""
from __future__ import annotations

import abc
from datetime import datetime
from typing import List, Optional

from ..domain import Bar


class DataProvider(abc.ABC):
    @abc.abstractmethod
    def get_historical(self, symbol: str, interval: str,
                       start: datetime, end: datetime) -> List[Bar]:
        """Return chronological OHLCV bars for [start, end]."""
        raise NotImplementedError

    @abc.abstractmethod
    def get_latest_price(self, symbol: str) -> Optional[float]:
        """Return the latest traded price, or None if unavailable."""
        raise NotImplementedError
