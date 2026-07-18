"""Angel One SmartAPI market-data provider.

Uses SmartConnect (``pip install smartapi-python``) for historical candles and
LTP. Angel One addresses instruments by numeric ``symboltoken`` on an exchange,
so a symbol->token mapping is required.

Import-safe: the SmartAPI dependency is imported lazily at call time.
"""
from __future__ import annotations

import os
from datetime import datetime
from typing import Dict, List, Optional

from ..domain import Bar
from .base import DataProvider

_INTERVAL_MAP = {
    "1minute": "ONE_MINUTE",
    "5minute": "FIVE_MINUTE",
    "15minute": "FIFTEEN_MINUTE",
    "1hour": "ONE_HOUR",
    "1day": "ONE_DAY",
}


class AngelOneDataProvider(DataProvider):
    def __init__(self, api_key: Optional[str] = None, client_id: Optional[str] = None,
                 password: Optional[str] = None, totp: Optional[str] = None,
                 symbol_tokens: Optional[Dict[str, str]] = None, exchange: str = "NSE"):
        self.api_key = api_key or os.getenv("ANGEL_API_KEY", "")
        self.client_id = client_id or os.getenv("ANGEL_CLIENT_ID", "")
        self.password = password or os.getenv("ANGEL_PASSWORD", "")
        self.totp = totp or os.getenv("ANGEL_TOTP", "")
        self.symbol_tokens = symbol_tokens or {}
        self.exchange = exchange
        self._smart = None

    def _connect(self):
        if self._smart is not None:
            return self._smart
        try:
            from SmartApi import SmartConnect  # type: ignore
        except ImportError as e:
            raise RuntimeError(
                "smartapi-python not installed. `pip install smartapi-python pyotp`."
            ) from e
        if not (self.api_key and self.client_id):
            raise RuntimeError("Angel One credentials (ANGEL_API_KEY/ANGEL_CLIENT_ID) missing.")
        smart = SmartConnect(api_key=self.api_key)
        otp = self.totp
        if otp and len(otp) > 8:  # treat as a TOTP secret, derive current code
            import pyotp  # type: ignore
            otp = pyotp.TOTP(otp).now()
        smart.generateSession(self.client_id, self.password, otp)
        self._smart = smart
        return smart

    def _token(self, symbol: str) -> str:
        token = self.symbol_tokens.get(symbol)
        if not token:
            raise KeyError(f"No Angel One symboltoken for '{symbol}'. Provide symbol_tokens.")
        return token

    def get_historical(self, symbol: str, interval: str,
                       start: datetime, end: datetime) -> List[Bar]:
        smart = self._connect()
        params = {
            "exchange": self.exchange,
            "symboltoken": self._token(symbol),
            "interval": _INTERVAL_MAP.get(interval, "ONE_DAY"),
            "fromdate": start.strftime("%Y-%m-%d %H:%M"),
            "todate": end.strftime("%Y-%m-%d %H:%M"),
        }
        resp = smart.getCandleData(params)
        rows = resp.get("data", []) if isinstance(resp, dict) else []
        bars: List[Bar] = []
        for c in rows:  # [ts, o, h, l, c, volume]
            bars.append(Bar(
                timestamp=datetime.fromisoformat(c[0]).replace(tzinfo=None),
                open=float(c[1]), high=float(c[2]), low=float(c[3]),
                close=float(c[4]), volume=float(c[5]),
            ))
        bars.sort(key=lambda b: b.timestamp)
        return bars

    def get_latest_price(self, symbol: str) -> Optional[float]:
        smart = self._connect()
        data = smart.ltpData(self.exchange, symbol, self._token(symbol))
        if isinstance(data, dict):
            return float(data.get("data", {}).get("ltp", 0)) or None
        return None
