"""Cycle-based trading engine for paper and (guarded) live trading.

Reuses the exact strategy + risk + portfolio components as the backtester. Each
cycle it pulls a recent history window per symbol, evaluates exits, checks the
daily kill-switch, then evaluates entries. Execution goes through whatever
BrokerAdapter is injected (PaperBroker by default; live adapters are gated).
"""
from __future__ import annotations

import logging
import time as _time
from datetime import datetime, timedelta
from typing import Dict, List, Optional

from .brokers.base import BrokerAdapter
from .config import Config
from .data.base import DataProvider
from .domain import (Order, OrderType, ProductType, Side, Signal, SignalType)
from .portfolio import Portfolio
from .risk import RiskManager
from .strategies.base import Strategy

logger = logging.getLogger("enterprise_algo.engine")


class TradingEngine:
    def __init__(self, config: Config, strategy: Strategy, data: DataProvider,
                 broker: BrokerAdapter, symbols: List[str],
                 sectors: Optional[Dict[str, str]] = None,
                 interval: str = "1day", history_days: int = 120,
                 product: ProductType = ProductType.INTRADAY):
        self.config = config
        self.strategy = strategy
        self.data = data
        self.broker = broker
        self.symbols = symbols
        self.sectors = sectors or {}
        self.interval = interval
        self.history_days = history_days
        self.product = product
        self.portfolio = Portfolio(config.risk.capital, sectors=self.sectors)
        self.risk = RiskManager(config.risk, sectors=self.sectors)

        if broker.is_live and not config.allow_live:
            raise RuntimeError(
                "Refusing to start engine with a LIVE broker while allow_live=False.")

    def _history(self, symbol: str):
        end = datetime.now()
        start = end - timedelta(days=self.history_days)
        return self.data.get_historical(symbol, self.interval, start, end)

    def _price_of(self, symbol: str, fallback_bars) -> Optional[float]:
        p = self.data.get_latest_price(symbol)
        if p is not None:
            return p
        return fallback_bars[-1].close if fallback_bars else None

    def _submit(self, symbol: str, side: Side, qty: int, ref_price: float, reason: str):
        if qty <= 0:
            return None
        order = Order(symbol=symbol, side=side, quantity=qty,
                      order_type=OrderType.MARKET, product=self.product,
                      timestamp=datetime.now(), reject_reason=reason)
        filled = self.broker.place_order(order, reference_price=ref_price)
        self.portfolio.apply_fill(filled)
        logger.info("ORDER %s %s x%d @ %.2f status=%s reason=%s",
                    side.value, symbol, qty, filled.average_price,
                    filled.status.value, reason)
        return filled

    def run_once(self) -> Dict:
        prices: Dict[str, float] = {}
        histories = {}
        for symbol in self.symbols:
            bars = self._history(symbol)
            histories[symbol] = bars
            price = self._price_of(symbol, bars)
            if price is not None:
                prices[symbol] = price

        # exits
        for symbol, pos in list(self.portfolio.open_positions().items()):
            price = prices.get(symbol)
            if price is None:
                continue
            hit = None
            if pos.quantity > 0:
                if pos.stop_loss and price <= pos.stop_loss:
                    hit = "stop_loss"
                elif pos.take_profit and price >= pos.take_profit:
                    hit = "take_profit"
            else:
                if pos.stop_loss and price >= pos.stop_loss:
                    hit = "stop_loss"
                elif pos.take_profit and price <= pos.take_profit:
                    hit = "take_profit"
            if hit:
                side = Side.SELL if pos.quantity > 0 else Side.BUY
                self._submit(symbol, side, abs(pos.quantity), price, hit)

        equity = self.portfolio.equity(prices)
        halt = self.risk.check_daily_limits(datetime.now().date(), equity)
        if halt:
            logger.warning("Trading halted for the day: %s", halt)
            return self.portfolio.snapshot(prices).__dict__

        # entries
        for symbol in self.symbols:
            bars = histories[symbol]
            if len(bars) < self.strategy.lookback:
                continue
            signal: Optional[Signal] = self.strategy.generate(symbol, bars)
            if signal is None or signal.type is SignalType.HOLD:
                continue
            price = prices.get(symbol)
            if price is None:
                continue
            decision = self.risk.evaluate(signal, price, self.portfolio, prices)
            if not decision.approved:
                logger.debug("skip %s: %s", symbol, decision.reason)
                continue
            side = Side.BUY if signal.type is SignalType.BUY else Side.SELL
            self._submit(symbol, side, decision.quantity, price, signal.reason)
            pos = self.portfolio.positions.get(symbol)
            if pos and pos.is_open:
                pos.stop_loss = decision.stop_loss
                pos.take_profit = decision.take_profit

        snap = self.portfolio.snapshot(prices)
        logger.info("CYCLE equity=%.2f cash=%.2f open=%d realized=%.2f fees=%.2f",
                    snap.equity, snap.cash, snap.open_positions,
                    snap.realized_pnl, snap.fees_paid)
        return snap.__dict__

    def run(self, cycles: int = 1, interval_sec: int = 0) -> Dict:
        result = {}
        for c in range(cycles):
            logger.info("=== cycle %d/%d ===", c + 1, cycles)
            result = self.run_once()
            if interval_sec and c < cycles - 1:
                _time.sleep(interval_sec)
        return result
