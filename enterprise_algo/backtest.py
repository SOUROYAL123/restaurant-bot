"""Event-driven backtesting engine.

Replays historical bars across a symbol universe, one timestamp at a time, and
routes each strategy signal through the SAME risk engine and paper broker used
in live/paper trading. This "single code path" design means a backtest and a
paper run differ only in their data source — not in execution logic — which is
what makes backtest results trustworthy.

It also enforces stop-loss / take-profit exits per bar before evaluating new
entries, so exits are never starved by the max-position cap.
"""
from __future__ import annotations

import logging
from datetime import datetime
from typing import Dict, List, Optional, Sequence

from .brokers.paper import PaperBroker
from .config import Config
from .domain import (Bar, Order, OrderType, ProductType, Side, Signal, SignalType)
from .metrics import PerformanceReport, compute_report
from .portfolio import Portfolio
from .risk import RiskManager
from .strategies.base import Strategy

logger = logging.getLogger("enterprise_algo.backtest")


class BacktestResult:
    def __init__(self, equity_curve: List[float], timestamps: List[datetime],
                 portfolio: Portfolio, report: PerformanceReport):
        self.equity_curve = equity_curve
        self.timestamps = timestamps
        self.portfolio = portfolio
        self.report = report


class BacktestEngine:
    def __init__(self, config: Config, strategy: Strategy,
                 sectors: Optional[Dict[str, str]] = None,
                 product: ProductType = ProductType.DELIVERY):
        self.config = config
        self.strategy = strategy
        self.sectors = sectors or {}
        self.product = product
        self.broker = PaperBroker(slippage_bps=config.execution.slippage_bps)
        self.portfolio = Portfolio(config.risk.capital, sectors=self.sectors)
        self.risk = RiskManager(config.risk, sectors=self.sectors)

    def _submit(self, symbol: str, side: Side, qty: int, ref_price: float,
                ts: datetime, reason: str) -> None:
        if qty <= 0:
            return
        order = Order(symbol=symbol, side=side, quantity=qty,
                      order_type=OrderType.MARKET, product=self.product,
                      timestamp=ts, reject_reason=reason)
        filled = self.broker.place_order(order, reference_price=ref_price)
        self.portfolio.apply_fill(filled)

    def _check_exits(self, prices: Dict[str, float], ts: datetime) -> None:
        for symbol, pos in list(self.portfolio.open_positions().items()):
            price = prices.get(symbol)
            if price is None:
                continue
            hit = None
            if pos.quantity > 0:  # long
                if pos.stop_loss and price <= pos.stop_loss:
                    hit = "stop_loss"
                elif pos.take_profit and price >= pos.take_profit:
                    hit = "take_profit"
            else:  # short
                if pos.stop_loss and price >= pos.stop_loss:
                    hit = "stop_loss"
                elif pos.take_profit and price <= pos.take_profit:
                    hit = "take_profit"
            if hit:
                side = Side.SELL if pos.quantity > 0 else Side.BUY
                self._submit(symbol, side, abs(pos.quantity), price, ts, hit)

    def run(self, data: Dict[str, Sequence[Bar]]) -> BacktestResult:
        """`data` maps symbol -> chronological bars (assumed aligned by index)."""
        symbols = list(data.keys())
        length = min((len(bars) for bars in data.values()), default=0)
        equity_curve: List[float] = []
        timestamps: List[datetime] = []
        warmup = self.strategy.lookback

        for i in range(length):
            ts = data[symbols[0]][i].timestamp
            prices = {s: data[s][i].close for s in symbols}

            # 1) risk-managed exits first
            self._check_exits(prices, ts)

            # 2) daily kill-switch / profit lock
            equity = self.portfolio.equity(prices)
            halt = self.risk.check_daily_limits(ts.date(), equity)

            # 3) entries (skipped while halted or during warmup)
            if not halt and i >= warmup:
                for symbol in symbols:
                    window = data[symbol][: i + 1]
                    signal: Optional[Signal] = self.strategy.generate(symbol, window)
                    if signal is None or signal.type is SignalType.HOLD:
                        continue
                    price = prices[symbol]
                    decision = self.risk.evaluate(signal, price, self.portfolio, prices)
                    if not decision.approved:
                        continue
                    side = Side.BUY if signal.type is SignalType.BUY else Side.SELL
                    # Long-only entries in delivery; shorts allowed in intraday.
                    if side is Side.SELL and self.product is ProductType.DELIVERY \
                            and (symbol not in self.portfolio.open_positions()):
                        continue
                    self._submit(symbol, side, decision.quantity, price, ts, signal.reason)
                    pos = self.portfolio.positions.get(symbol)
                    if pos and pos.is_open:
                        pos.stop_loss = decision.stop_loss
                        pos.take_profit = decision.take_profit

            equity_curve.append(self.portfolio.equity(prices))
            timestamps.append(ts)

        report = compute_report(equity_curve, self.portfolio.closed_trades)
        return BacktestResult(equity_curve, timestamps, self.portfolio, report)
