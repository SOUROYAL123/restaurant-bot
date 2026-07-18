"""enterprise_algo — a broker-agnostic, paper-first algorithmic trading engine
for NSE equities.

Design pillars:
  * one strategy/risk/execution code path shared by backtest, paper, and live
  * pluggable data providers (synthetic/CSV/Upstox/Angel One)
  * pluggable broker adapters (paper + guarded live)
  * realistic Indian-equity cost model so P&L is net, not gross
  * live trading behind a deliberate two-key safety interlock
"""
from __future__ import annotations

__version__ = "1.0.0"

from .config import Config, load_config
from .domain import Bar, Order, Position, Side, Signal, SignalType
from .backtest import BacktestEngine, BacktestResult
from .engine import TradingEngine
from .metrics import compute_report, PerformanceReport
from .portfolio import Portfolio
from .risk import RiskManager
from .strategies import get_strategy, STRATEGY_REGISTRY

__all__ = [
    "__version__",
    "Config", "load_config",
    "Bar", "Order", "Position", "Side", "Signal", "SignalType",
    "BacktestEngine", "BacktestResult", "TradingEngine",
    "compute_report", "PerformanceReport",
    "Portfolio", "RiskManager",
    "get_strategy", "STRATEGY_REGISTRY",
]
