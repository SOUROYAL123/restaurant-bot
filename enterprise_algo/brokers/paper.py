"""Paper-trading broker: deterministic fill simulation with modelled slippage
and the realistic NSE cost model. No network, no money — the default execution
venue for both backtests and paper runs.
"""
from __future__ import annotations

import uuid
from datetime import datetime
from typing import Optional

from ..domain import Order, OrderStatus, OrderType, ProductType, Side
from ..nse import CostModel
from .base import BrokerAdapter


class PaperBroker(BrokerAdapter):
    is_live = False

    def __init__(self, cost_model: Optional[CostModel] = None, slippage_bps: float = 5.0):
        self.cost_model = cost_model or CostModel()
        self.slippage_bps = slippage_bps

    def _fill_price(self, side: Side, ref_price: float) -> float:
        # Slippage always works against the taker.
        slip = ref_price * (self.slippage_bps / 10_000.0)
        return ref_price + slip if side is Side.BUY else ref_price - slip

    def place_order(self, order: Order, reference_price: Optional[float] = None) -> Order:
        ref = reference_price if reference_price is not None else order.limit_price
        if ref is None or ref <= 0 or order.quantity <= 0:
            order.status = OrderStatus.REJECTED
            order.reject_reason = "no reference price or non-positive quantity"
            return order

        # Limit orders only fill if the market is at/through the limit.
        if order.order_type is OrderType.LIMIT and order.limit_price is not None:
            if order.side is Side.BUY and ref > order.limit_price:
                order.status = OrderStatus.PENDING
                return order
            if order.side is Side.SELL and ref < order.limit_price:
                order.status = OrderStatus.PENDING
                return order

        fill = self._fill_price(order.side, ref)
        product = order.product if isinstance(order.product, ProductType) else ProductType.INTRADAY
        fees = self.cost_model.charges(order.side, fill, order.quantity, product)

        order.order_id = str(uuid.uuid4())
        order.status = OrderStatus.FILLED
        order.filled_quantity = order.quantity
        order.average_price = round(fill, 2)
        order.fees = fees
        order.timestamp = order.timestamp or datetime.now()
        return order
