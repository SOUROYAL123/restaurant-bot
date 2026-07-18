from datetime import datetime, timedelta

from enterprise_algo.backtest import BacktestEngine
from enterprise_algo.config import load_config
from enterprise_algo.data.synthetic import SyntheticDataProvider
from enterprise_algo.domain import ProductType
from enterprise_algo.nse import DEFAULT_UNIVERSE
from enterprise_algo.strategies import get_strategy


def _data(symbols, days=400):
    provider = SyntheticDataProvider(seed=7)
    end = datetime(2024, 1, 1)
    start = end - timedelta(days=days)
    return {s: provider.get_historical(s, "1day", start, end) for s in symbols}


def test_backtest_runs_and_reports():
    symbols = ["RELIANCE", "TCS", "HDFCBANK"]
    data = _data(symbols)
    cfg = load_config("default")
    engine = BacktestEngine(cfg, get_strategy("ensemble"),
                            sectors={s: DEFAULT_UNIVERSE[s] for s in symbols},
                            product=ProductType.DELIVERY)
    result = engine.run(data)
    assert len(result.equity_curve) > 0
    r = result.report
    assert r.start_equity == cfg.risk.capital
    # equity curve length equals number of replayed bars
    assert len(result.timestamps) == len(result.equity_curve)
    # report fields are populated
    assert r.num_trades >= 0
    assert -100 <= r.max_drawdown_pct <= 0


def test_ma_crossover_backtest_executes_trades():
    symbols = ["RELIANCE", "INFY"]
    data = _data(symbols, days=500)
    cfg = load_config("aggressive")
    engine = BacktestEngine(cfg, get_strategy("ma_crossover"),
                            sectors={s: DEFAULT_UNIVERSE[s] for s in symbols},
                            product=ProductType.INTRADAY)
    result = engine.run(data)
    # Over 500 bars of trending synthetic data, expect at least one round trip.
    assert result.report.num_trades >= 1


def test_daily_loss_limit_never_breached_badly():
    symbols = ["RELIANCE"]
    data = _data(symbols, days=300)
    cfg = load_config("conservative")
    engine = BacktestEngine(cfg, get_strategy("ensemble"), product=ProductType.INTRADAY)
    result = engine.run(data)
    # Conservative profile should keep max drawdown bounded (sanity, not exact).
    assert result.report.max_drawdown_pct > -60
