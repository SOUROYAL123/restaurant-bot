"""Risk engine: the gatekeeper between a strategy signal and an order.

Responsibilities:
  * position sizing (fixed-fractional risk using the stop distance)
  * hard caps: max concurrent positions, per-position notional, per-sector notional
  * a daily-loss kill-switch and daily-profit lock
  * a minimum-confidence filter

Every proposed trade passes through ``evaluate`` which returns either an
approved quantity or a rejection reason. Strategies never size their own trades.
"""
from __future__ import annotations

from dataclasses import dataclass
from datetime import date
from typing import Dict, Optional

from .config import RiskConfig
from .domain import Position, Signal, SignalType
from .portfolio import Portfolio


@dataclass
class RiskDecision:
    approved: bool
    quantity: int = 0
    reason: str = ""
    stop_loss: Optional[float] = None
    take_profit: Optional[float] = None


class RiskManager:
    def __init__(self, config: RiskConfig, sectors: Optional[Dict[str, str]] = None):
        self.cfg = config
        self.sectors = sectors or {}
        self._day: Optional[date] = None
        self._day_start_equity: float = config.capital
        self.halted_reason: str = ""

    # -- daily lifecycle -----------------------------------------------------
    def _roll_day(self, today: date, equity: float) -> None:
        if self._day != today:
            self._day = today
            self._day_start_equity = equity
            self.halted_reason = ""

    def check_daily_limits(self, today: date, equity: float) -> Optional[str]:
        """Return a halt reason if daily loss/profit thresholds are breached."""
        self._roll_day(today, equity)
        pnl = equity - self._day_start_equity
        loss_limit = -self.cfg.daily_loss_limit_pct * self._day_start_equity
        profit_target = self.cfg.daily_profit_target_pct * self._day_start_equity
        if pnl <= loss_limit:
            self.halted_reason = (f"daily loss limit hit: {pnl:.0f} <= {loss_limit:.0f}")
            return self.halted_reason
        if pnl >= profit_target:
            self.halted_reason = (f"daily profit target hit: {pnl:.0f} >= {profit_target:.0f}")
            return self.halted_reason
        return None

    # -- per-trade evaluation ------------------------------------------------
    def evaluate(self, signal: Signal, price: float, portfolio: Portfolio,
                 prices: Dict[str, float]) -> RiskDecision:
        if signal.type is SignalType.HOLD:
            return RiskDecision(False, reason="hold")

        if signal.confidence < self.cfg.min_confidence:
            return RiskDecision(False, reason=f"confidence {signal.confidence:.2f} < "
                                              f"{self.cfg.min_confidence:.2f}")

        equity = portfolio.equity(prices)
        if self.halted_reason:
            return RiskDecision(False, reason=f"halted: {self.halted_reason}")

        existing = portfolio.open_positions()
        pos = existing.get(signal.symbol)

        # Treat a signal as an entry only when flat or adding same-direction.
        want_long = signal.type is SignalType.BUY
        if pos is None or not pos.is_open:
            if len(existing) >= self.cfg.max_positions:
                return RiskDecision(False, reason="max positions reached")

        # --- position sizing: risk a fixed fraction of equity on the stop ---
        stop = signal.stop_loss
        if stop is None or stop <= 0:
            # fall back to a default stop distance from ATR-less signals
            stop_dist = price * 0.02
        else:
            stop_dist = abs(price - stop)
        if stop_dist <= 0:
            return RiskDecision(False, reason="invalid stop distance")

        risk_budget = self.cfg.risk_per_trade * equity
        qty_by_risk = int(risk_budget / stop_dist)

        # --- notional caps --------------------------------------------------
        max_notional = self.cfg.max_position_pct * equity
        qty_by_notional = int(max_notional / price) if price > 0 else 0
        qty = max(0, min(qty_by_risk, qty_by_notional))

        if qty <= 0:
            return RiskDecision(False, reason="sized to zero (risk/notional caps)")

        # --- sector exposure cap -------------------------------------------
        sector = self.sectors.get(signal.symbol, "UNKNOWN")
        exposure = portfolio.sector_exposure(prices).get(sector, 0.0)
        proposed = exposure + qty * price
        max_sector = self.cfg.max_sector_pct * equity
        if proposed > max_sector:
            room = max_sector - exposure
            qty = int(max(0, room) / price) if price > 0 else 0
            if qty <= 0:
                return RiskDecision(False, reason=f"sector '{sector}' exposure cap")

        # --- affordability (cash) for long entries -------------------------
        if want_long:
            affordable = int(portfolio.cash / price) if price > 0 else 0
            qty = min(qty, affordable)
            if qty <= 0:
                return RiskDecision(False, reason="insufficient cash")

        return RiskDecision(True, quantity=qty, reason="approved",
                            stop_loss=signal.stop_loss, take_profit=signal.take_profit)
