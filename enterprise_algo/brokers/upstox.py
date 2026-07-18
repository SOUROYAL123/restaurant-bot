"""Upstox live order adapter — DISABLED unless explicitly authorized.

Two-key interlock: this adapter refuses to place any order unless
``allow_live=True`` is passed (which the CLI only does when the operator passes
``--i-understand-live-risk`` AND env ``ALGO_ALLOW_LIVE=true``). Placing real
orders moves real money; keep it off until you have paper-traded thoroughly.
"""
from __future__ import annotations

import os
from datetime import datetime
from typing import Dict, Optional

from ..domain import Order, OrderStatus, OrderType, ProductType, Side
from .base import BrokerAdapter

BASE_URL = "https://api.upstox.com/v2"


class LiveTradingDisabledError(RuntimeError):
    pass


class UpstoxBroker(BrokerAdapter):
    is_live = True

    def __init__(self, allow_live: bool = False, access_token: Optional[str] = None,
                 instrument_keys: Optional[Dict[str, str]] = None, timeout: int = 10):
        self.allow_live = allow_live
        self.access_token = access_token or os.getenv("UPSTOX_ACCESS_TOKEN", "")
        self.instrument_keys = instrument_keys or {}
        self.timeout = timeout

    def _guard(self):
        if not self.allow_live:
            raise LiveTradingDisabledError(
                "Live trading is disabled. Paper-trade first. To enable, set "
                "ALGO_ALLOW_LIVE=true and pass --i-understand-live-risk.")
        if not self.access_token:
            raise RuntimeError("UPSTOX_ACCESS_TOKEN not set.")

    def place_order(self, order: Order, reference_price: Optional[float] = None) -> Order:
        self._guard()
        import requests
        key = self.instrument_keys.get(order.symbol)
        if not key:
            order.status = OrderStatus.REJECTED
            order.reject_reason = f"no instrument_key for {order.symbol}"
            return order
        product = order.product if isinstance(order.product, ProductType) else ProductType.INTRADAY
        payload = {
            "quantity": order.quantity,
            "product": product.value,
            "validity": "DAY",
            "instrument_token": key,
            "order_type": order.order_type.value,
            "transaction_type": order.side.value,
            "price": order.limit_price or 0,
            "trigger_price": 0,
            "disclosed_quantity": 0,
            "is_amo": False,
        }
        headers = {"Authorization": f"Bearer {self.access_token}",
                   "Content-Type": "application/json", "Accept": "application/json"}
        resp = requests.post(f"{BASE_URL}/order/place", json=payload,
                             headers=headers, timeout=self.timeout)
        order.timestamp = datetime.now()
        if resp.status_code == 200:
            data = resp.json().get("data", {})
            order.order_id = data.get("order_id")
            order.status = OrderStatus.FILLED
            order.filled_quantity = order.quantity
            order.average_price = reference_price or order.limit_price or 0.0
        else:
            order.status = OrderStatus.REJECTED
            order.reject_reason = resp.text[:300]
        return order
