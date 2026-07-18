"""Core domain types shared across the enterprise_algo package.

These are broker-agnostic value objects. Nothing here talks to a network, a
database, or a broker — that keeps the domain model easy to test and reuse
across the backtester, the paper simulator, and (guarded) live trading.
"""
from __future__ import annotations

import enum
from dataclasses import dataclass, field
from datetime import datetime
from typing import Optional


class Side(enum.Enum):
    BUY = "BUY"
    SELL = "SELL"

    @property
    def sign(self) -> int:
        return 1 if self is Side.BUY else -1


class SignalType(enum.Enum):
    BUY = "BUY"
    SELL = "SELL"
    HOLD = "HOLD"


class OrderType(enum.Enum):
    MARKET = "MARKET"
    LIMIT = "LIMIT"


class ProductType(enum.Enum):
    """NSE product types. MIS = intraday, CNC = delivery."""
    INTRADAY = "MIS"
    DELIVERY = "CNC"


class OrderStatus(enum.Enum):
    PENDING = "PENDING"
    FILLED = "FILLED"
    REJECTED = "REJECTED"
    CANCELLED = "CANCELLED"


@dataclass(frozen=True)
class Bar:
    """A single OHLCV candle for one instrument."""
    timestamp: datetime
    open: float
    high: float
    low: float
    close: float
    volume: float

    def as_tuple(self) -> tuple:
        return (self.open, self.high, self.low, self.close, self.volume)


@dataclass(frozen=True)
class Signal:
    """A strategy's opinion on an instrument at a point in time."""
    symbol: str
    type: SignalType
    confidence: float  # 0..1
    timestamp: datetime
    price: float
    reason: str = ""
    # Optional strategy-supplied risk hints (absolute prices).
    stop_loss: Optional[float] = None
    take_profit: Optional[float] = None


@dataclass
class Order:
    symbol: str
    side: Side
    quantity: int
    order_type: OrderType = OrderType.MARKET
    product: ProductType = ProductType.INTRADAY
    limit_price: Optional[float] = None
    order_id: Optional[str] = None
    status: OrderStatus = OrderStatus.PENDING
    filled_quantity: int = 0
    average_price: float = 0.0
    fees: float = 0.0
    timestamp: Optional[datetime] = None
    reject_reason: str = ""


@dataclass
class Position:
    """Net position in a single instrument."""
    symbol: str
    quantity: int = 0          # signed: +long, -short
    average_price: float = 0.0
    realized_pnl: float = 0.0
    fees_paid: float = 0.0
    stop_loss: Optional[float] = None
    take_profit: Optional[float] = None
    opened_at: Optional[datetime] = None
    sector: str = "UNKNOWN"

    @property
    def is_open(self) -> bool:
        return self.quantity != 0

    @property
    def direction(self) -> int:
        return (self.quantity > 0) - (self.quantity < 0)

    def market_value(self, last_price: float) -> float:
        return self.quantity * last_price

    def unrealized_pnl(self, last_price: float) -> float:
        if self.quantity == 0:
            return 0.0
        return (last_price - self.average_price) * self.quantity


@dataclass
class Trade:
    """A completed round-trip (entry + exit) used for reporting."""
    symbol: str
    side: Side
    quantity: int
    entry_price: float
    exit_price: float
    entry_time: datetime
    exit_time: datetime
    pnl: float
    fees: float
    reason: str = ""

    @property
    def return_pct(self) -> float:
        if self.entry_price == 0:
            return 0.0
        return (self.exit_price - self.entry_price) / self.entry_price * self.side.sign


@dataclass
class AccountState:
    """Snapshot of the trading account at a point in time."""
    cash: float
    equity: float
    realized_pnl: float
    unrealized_pnl: float
    fees_paid: float
    open_positions: int
    timestamp: datetime = field(default_factory=datetime.now)
