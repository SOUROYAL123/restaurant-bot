"""Portfolio accounting: cash, positions, realized/unrealized P&L, closed trades.

Handles averaging up, partial closes, and position flips with proper realized
P&L attribution. Broker-agnostic — it consumes filled Orders.
"""
from __future__ import annotations

from datetime import datetime
from typing import Dict, List, Optional

from .domain import (AccountState, Order, OrderStatus, Position, Side, Trade)
from .nse import DEFAULT_UNIVERSE


class Portfolio:
    def __init__(self, starting_cash: float, sectors: Optional[Dict[str, str]] = None):
        self.starting_cash = starting_cash
        self.cash = starting_cash
        self.positions: Dict[str, Position] = {}
        self.closed_trades: List[Trade] = []
        self.fees_paid = 0.0
        self.realized_pnl = 0.0
        self.sectors = sectors or DEFAULT_UNIVERSE

    # -- accounting ----------------------------------------------------------
    def apply_fill(self, order: Order) -> None:
        if order.status is not OrderStatus.FILLED or order.filled_quantity <= 0:
            return

        qty = order.filled_quantity
        price = order.average_price
        signed = qty * order.side.sign
        cash_flow = -signed * price  # buy reduces cash, sell increases
        self.cash += cash_flow - order.fees
        self.fees_paid += order.fees

        pos = self.positions.get(order.symbol)
        if pos is None:
            pos = Position(symbol=order.symbol,
                           sector=self.sectors.get(order.symbol, "UNKNOWN"))
            self.positions[order.symbol] = pos

        old_qty = pos.quantity
        new_qty = old_qty + signed

        if old_qty == 0 or (old_qty > 0) == (signed > 0):
            # opening or adding in same direction -> weighted average price
            total_cost = abs(old_qty) * pos.average_price + abs(signed) * price
            pos.average_price = total_cost / abs(new_qty) if new_qty != 0 else 0.0
            if old_qty == 0:
                pos.opened_at = order.timestamp or datetime.now()
                pos.stop_loss = None
                pos.take_profit = None
        else:
            # reducing / closing / flipping -> realize P&L on the closed portion
            closed = min(abs(signed), abs(old_qty))
            direction = 1 if old_qty > 0 else -1
            realized = (price - pos.average_price) * closed * direction
            realized -= order.fees  # attribute this leg's fees to the trade
            pos.realized_pnl += realized
            self.realized_pnl += realized
            self.closed_trades.append(Trade(
                symbol=order.symbol,
                side=Side.BUY if direction > 0 else Side.SELL,
                quantity=closed,
                entry_price=pos.average_price,
                exit_price=price,
                entry_time=pos.opened_at or (order.timestamp or datetime.now()),
                exit_time=order.timestamp or datetime.now(),
                pnl=realized,
                fees=order.fees,
                reason=order.reject_reason or "",
            ))
            if new_qty == 0:
                pos.average_price = 0.0
                pos.opened_at = None
                pos.stop_loss = None
                pos.take_profit = None
            elif (new_qty > 0) != (old_qty > 0):
                # flipped: remaining qty opens a new position at fill price
                pos.average_price = price
                pos.opened_at = order.timestamp or datetime.now()

        pos.quantity = new_qty
        pos.fees_paid += order.fees

    # -- valuation -----------------------------------------------------------
    def open_positions(self) -> Dict[str, Position]:
        return {s: p for s, p in self.positions.items() if p.is_open}

    def unrealized_pnl(self, prices: Dict[str, float]) -> float:
        return sum(p.unrealized_pnl(prices.get(s, p.average_price))
                   for s, p in self.open_positions().items())

    def equity(self, prices: Dict[str, float]) -> float:
        # cash already reflects proceeds/costs; add market value of holdings
        holdings = sum(p.market_value(prices.get(s, p.average_price))
                       for s, p in self.open_positions().items())
        return self.cash + holdings

    def sector_exposure(self, prices: Dict[str, float]) -> Dict[str, float]:
        out: Dict[str, float] = {}
        for s, p in self.open_positions().items():
            val = abs(p.market_value(prices.get(s, p.average_price)))
            out[p.sector] = out.get(p.sector, 0.0) + val
        return out

    def snapshot(self, prices: Dict[str, float], ts: Optional[datetime] = None) -> AccountState:
        return AccountState(
            cash=self.cash,
            equity=self.equity(prices),
            realized_pnl=self.realized_pnl,
            unrealized_pnl=self.unrealized_pnl(prices),
            fees_paid=self.fees_paid,
            open_positions=len(self.open_positions()),
            timestamp=ts or datetime.now(),
        )
