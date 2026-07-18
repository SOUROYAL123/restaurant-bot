"""Angel One (SmartAPI) live order adapter — DISABLED unless authorized.

Same two-key interlock as the Upstox adapter. Requires ``smartapi-python``.
"""
from __future__ import annotations

import os
from datetime import datetime
from typing import Dict, Optional

from ..domain import Order, OrderStatus, ProductType
from .base import BrokerAdapter
from .upstox import LiveTradingDisabledError


class AngelOneBroker(BrokerAdapter):
    is_live = True

    def __init__(self, allow_live: bool = False, api_key: Optional[str] = None,
                 client_id: Optional[str] = None, password: Optional[str] = None,
                 totp: Optional[str] = None, symbol_tokens: Optional[Dict[str, str]] = None,
                 exchange: str = "NSE"):
        self.allow_live = allow_live
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
            raise RuntimeError("smartapi-python not installed.") from e
        smart = SmartConnect(api_key=self.api_key)
        otp = self.totp
        if otp and len(otp) > 8:
            import pyotp  # type: ignore
            otp = pyotp.TOTP(otp).now()
        smart.generateSession(self.client_id, self.password, otp)
        self._smart = smart
        return smart

    def _guard(self):
        if not self.allow_live:
            raise LiveTradingDisabledError(
                "Live trading is disabled. Paper-trade first. To enable, set "
                "ALGO_ALLOW_LIVE=true and pass --i-understand-live-risk.")

    def place_order(self, order: Order, reference_price: Optional[float] = None) -> Order:
        self._guard()
        smart = self._connect()
        token = self.symbol_tokens.get(order.symbol)
        if not token:
            order.status = OrderStatus.REJECTED
            order.reject_reason = f"no symboltoken for {order.symbol}"
            return order
        product = order.product if isinstance(order.product, ProductType) else ProductType.INTRADAY
        params = {
            "variety": "NORMAL",
            "tradingsymbol": order.symbol,
            "symboltoken": token,
            "transactiontype": order.side.value,
            "exchange": self.exchange,
            "ordertype": order.order_type.value,
            "producttype": "INTRADAY" if product is ProductType.INTRADAY else "DELIVERY",
            "duration": "DAY",
            "price": order.limit_price or 0,
            "quantity": order.quantity,
        }
        order.timestamp = datetime.now()
        try:
            resp = smart.placeOrder(params)
            order.order_id = str(resp)
            order.status = OrderStatus.FILLED
            order.filled_quantity = order.quantity
            order.average_price = reference_price or order.limit_price or 0.0
        except Exception as e:  # noqa: BLE001 - surface broker error to caller
            order.status = OrderStatus.REJECTED
            order.reject_reason = str(e)[:300]
        return order
