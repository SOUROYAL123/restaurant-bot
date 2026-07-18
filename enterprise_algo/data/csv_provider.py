"""CSV data provider for backtesting against downloaded NSE history.

Expects one CSV per symbol at ``<data_dir>/<SYMBOL>.csv`` with a header row
containing (case-insensitive): date/timestamp, open, high, low, close, volume.
This is the free/offline path — export bars from NSE, yfinance, or your broker
and drop them in ``data_dir``.
"""
from __future__ import annotations

import csv
from datetime import datetime
from pathlib import Path
from typing import List, Optional

from ..domain import Bar
from .base import DataProvider

_DATE_KEYS = ("date", "timestamp", "datetime", "time")
_FMTS = ("%Y-%m-%d %H:%M:%S", "%Y-%m-%dT%H:%M:%S", "%Y-%m-%d", "%d-%m-%Y", "%m/%d/%Y")


def _parse_dt(s: str) -> datetime:
    s = s.strip()
    for fmt in _FMTS:
        try:
            return datetime.strptime(s, fmt)
        except ValueError:
            continue
    # last resort: ISO parser
    return datetime.fromisoformat(s)


class CSVDataProvider(DataProvider):
    def __init__(self, data_dir: str = "data/history"):
        self.data_dir = Path(data_dir)

    def _load(self, symbol: str) -> List[Bar]:
        path = self.data_dir / f"{symbol}.csv"
        if not path.exists():
            raise FileNotFoundError(
                f"No CSV for {symbol} at {path}. Export OHLCV history there.")
        bars: List[Bar] = []
        with path.open(newline="") as f:
            reader = csv.DictReader(f)
            lower_map = {k.lower(): k for k in (reader.fieldnames or [])}
            date_key = next((lower_map[k] for k in _DATE_KEYS if k in lower_map), None)
            if date_key is None:
                raise ValueError(f"{path}: no date/timestamp column found")
            for row in reader:
                bars.append(Bar(
                    timestamp=_parse_dt(row[date_key]),
                    open=float(row[lower_map["open"]]),
                    high=float(row[lower_map["high"]]),
                    low=float(row[lower_map["low"]]),
                    close=float(row[lower_map["close"]]),
                    volume=float(row.get(lower_map.get("volume", ""), 0) or 0),
                ))
        bars.sort(key=lambda b: b.timestamp)
        return bars

    def get_historical(self, symbol: str, interval: str,
                       start: datetime, end: datetime) -> List[Bar]:
        return [b for b in self._load(symbol) if start <= b.timestamp <= end]

    def get_latest_price(self, symbol: str) -> Optional[float]:
        bars = self._load(symbol)
        return bars[-1].close if bars else None
