"""Upstox v2 market-data provider.

Uses the public Upstox v2 REST API for historical candles and LTP. Requires an
access token (env ``UPSTOX_ACCESS_TOKEN``) and an instrument-key mapping, since
Upstox addresses instruments by keys like ``NSE_EQ|INE002A01018`` rather than by
trading symbol.

This provider is import-safe: it only needs ``requests`` at call time, and
raises a clear error if credentials/mapping are missing rather than at import.
"""
from __future__ import annotations

import os
from datetime import datetime
from typing import Dict, List, Optional

from ..domain import Bar
from .base import DataProvider

BASE_URL = "https://api.upstox.com/v2"


class UpstoxDataProvider(DataProvider):
    def __init__(self, access_token: Optional[str] = None,
                 instrument_keys: Optional[Dict[str, str]] = None,
                 timeout: int = 10):
        self.access_token = access_token or os.getenv("UPSTOX_ACCESS_TOKEN", "")
        self.instrument_keys = instrument_keys or {}
        self.timeout = timeout

    def _headers(self) -> Dict[str, str]:
        if not self.access_token:
            # Fall back to the token stored by refresh_upstox_token.py.
            from ..upstox_auth import UpstoxAuth
            stored = UpstoxAuth().load_stored()
            if stored:
                self.access_token = stored["access_token"]
        if not self.access_token:
            raise RuntimeError(
                "No Upstox token: set UPSTOX_ACCESS_TOKEN or run "
                "`python refresh_upstox_token.py` (tokens expire daily at 03:30 IST).")
        return {"Authorization": f"Bearer {self.access_token}", "Accept": "application/json"}

    def _key(self, symbol: str) -> str:
        key = self.instrument_keys.get(symbol)
        if not key:
            raise KeyError(
                f"No Upstox instrument_key for '{symbol}'. Provide instrument_keys "
                f"mapping (e.g. {{'RELIANCE': 'NSE_EQ|INE002A01018'}}).")
        return key

    def get_historical(self, symbol: str, interval: str,
                       start: datetime, end: datetime) -> List[Bar]:
        import requests  # local import keeps package import-safe
        unit = "days" if interval.endswith("day") else "minutes"
        key = self._key(symbol)
        url = (f"{BASE_URL}/historical-candle/{key}/{unit}/1/"
               f"{end:%Y-%m-%d}/{start:%Y-%m-%d}")
        resp = requests.get(url, headers=self._headers(), timeout=self.timeout)
        resp.raise_for_status()
        candles = resp.json().get("data", {}).get("candles", [])
        bars: List[Bar] = []
        for c in candles:  # [ts, o, h, l, c, volume, oi]
            bars.append(Bar(
                timestamp=datetime.fromisoformat(c[0]).replace(tzinfo=None),
                open=float(c[1]), high=float(c[2]), low=float(c[3]),
                close=float(c[4]), volume=float(c[5]),
            ))
        bars.sort(key=lambda b: b.timestamp)
        return bars

    def get_latest_price(self, symbol: str) -> Optional[float]:
        import requests
        key = self._key(symbol)
        url = f"{BASE_URL}/market-quote/ltp"
        resp = requests.get(url, headers=self._headers(),
                            params={"instrument_key": key}, timeout=self.timeout)
        resp.raise_for_status()
        data = resp.json().get("data", {})
        for _, quote in data.items():
            return float(quote.get("last_price"))
        return None
