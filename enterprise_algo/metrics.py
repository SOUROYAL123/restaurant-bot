"""Performance metrics computed from an equity curve and closed trades."""
from __future__ import annotations

from dataclasses import dataclass, asdict
from typing import Dict, List, Sequence

import numpy as np

from .domain import Trade

TRADING_DAYS = 252


@dataclass
class PerformanceReport:
    start_equity: float
    end_equity: float
    total_return_pct: float
    cagr_pct: float
    sharpe: float
    sortino: float
    max_drawdown_pct: float
    volatility_pct: float
    num_trades: int
    win_rate_pct: float
    profit_factor: float
    avg_win: float
    avg_loss: float
    total_fees: float

    def to_dict(self) -> Dict[str, float]:
        return asdict(self)


def _returns(equity: Sequence[float]) -> np.ndarray:
    eq = np.asarray(equity, dtype=float)
    if len(eq) < 2:
        return np.array([])
    return np.diff(eq) / eq[:-1]


def max_drawdown(equity: Sequence[float]) -> float:
    eq = np.asarray(equity, dtype=float)
    if len(eq) == 0:
        return 0.0
    peak = np.maximum.accumulate(eq)
    dd = (eq - peak) / peak
    return float(dd.min())


def compute_report(equity_curve: Sequence[float], trades: List[Trade],
                   periods_per_year: int = TRADING_DAYS) -> PerformanceReport:
    eq = np.asarray(equity_curve, dtype=float)
    start = float(eq[0]) if len(eq) else 0.0
    end = float(eq[-1]) if len(eq) else 0.0
    rets = _returns(eq)

    total_return = (end / start - 1.0) if start > 0 else 0.0
    n_periods = max(1, len(eq) - 1)
    years = n_periods / periods_per_year
    cagr = ((end / start) ** (1 / years) - 1.0) if start > 0 and years > 0 else 0.0

    vol = float(rets.std(ddof=1)) if len(rets) > 1 else 0.0
    ann_vol = vol * np.sqrt(periods_per_year)
    mean_ret = float(rets.mean()) if len(rets) else 0.0
    sharpe = (mean_ret / vol * np.sqrt(periods_per_year)) if vol > 0 else 0.0
    downside = rets[rets < 0]
    dstd = float(downside.std(ddof=1)) if len(downside) > 1 else 0.0
    sortino = (mean_ret / dstd * np.sqrt(periods_per_year)) if dstd > 0 else 0.0

    wins = [t.pnl for t in trades if t.pnl > 0]
    losses = [t.pnl for t in trades if t.pnl <= 0]
    win_rate = (len(wins) / len(trades) * 100.0) if trades else 0.0
    gross_win = sum(wins)
    gross_loss = abs(sum(losses))
    profit_factor = (gross_win / gross_loss) if gross_loss > 0 else (float("inf") if gross_win > 0 else 0.0)

    return PerformanceReport(
        start_equity=round(start, 2),
        end_equity=round(end, 2),
        total_return_pct=round(total_return * 100, 2),
        cagr_pct=round(cagr * 100, 2),
        sharpe=round(sharpe, 2),
        sortino=round(sortino, 2),
        max_drawdown_pct=round(max_drawdown(eq) * 100, 2),
        volatility_pct=round(ann_vol * 100, 2),
        num_trades=len(trades),
        win_rate_pct=round(win_rate, 2),
        profit_factor=round(profit_factor, 2) if profit_factor != float("inf") else profit_factor,
        avg_win=round(float(np.mean(wins)), 2) if wins else 0.0,
        avg_loss=round(float(np.mean(losses)), 2) if losses else 0.0,
        total_fees=round(sum(t.fees for t in trades), 2),
    )
