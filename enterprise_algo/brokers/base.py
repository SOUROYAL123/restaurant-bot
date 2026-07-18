"""Broker adapter interface.

The engine speaks only this interface, so swapping paper <-> Upstox <-> Angel One
is a one-line config change and never touches strategy or risk code.
"""
from __future__ import annotations

import abc
from typing import Optional

from ..domain import Order


class BrokerAdapter(abc.ABC):
    #: True for adapters that transact real money. Guards live safety checks.
    is_live: bool = False

    @abc.abstractmethod
    def place_order(self, order: Order, reference_price: Optional[float] = None) -> Order:
        """Submit an order and return it updated with fill status/price/fees.

        ``reference_price`` is the current market price, used by the paper
        simulator to model fills; live adapters ignore it.
        """
        raise NotImplementedError

    def cancel_order(self, order_id: str) -> bool:  # pragma: no cover - optional
        return False
