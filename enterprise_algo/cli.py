"""Command-line interface for enterprise_algo.

Examples
--------
Backtest the ensemble strategy on synthetic data (no creds needed):
    python -m enterprise_algo.cli backtest --strategy ensemble --profile default

Paper-trade one cycle against Upstox live data (needs UPSTOX_ACCESS_TOKEN):
    python -m enterprise_algo.cli paper --data upstox --symbols RELIANCE,TCS

Live trading is intentionally hard to turn on (see `live --help`).
"""
from __future__ import annotations

import argparse
import json
import sys
from datetime import datetime, timedelta
from typing import Dict, List

from .brokers import get_broker
from .config import load_config
from .data import get_data_provider
from .logging_config import setup_logging
from .nse import DEFAULT_UNIVERSE
from .domain import ProductType


def _parse_symbols(arg: str | None) -> List[str]:
    if not arg:
        return list(DEFAULT_UNIVERSE.keys())
    return [s.strip().upper() for s in arg.split(",") if s.strip()]


def _sectors_for(symbols: List[str]) -> Dict[str, str]:
    return {s: DEFAULT_UNIVERSE.get(s, "UNKNOWN") for s in symbols}


def cmd_backtest(args) -> int:
    from .backtest import BacktestEngine
    from .strategies import get_strategy

    log = setup_logging(args.log_level)
    cfg = load_config(args.profile)
    symbols = _parse_symbols(args.symbols)
    sectors = _sectors_for(symbols)

    provider = get_data_provider(args.data)
    end = datetime.now()
    start = end - timedelta(days=args.days)
    data = {s: provider.get_historical(s, args.interval, start, end) for s in symbols}
    data = {s: b for s, b in data.items() if b}
    if not data:
        log.error("No data for any symbol; aborting.")
        return 2

    strategy = get_strategy(args.strategy)
    product = ProductType.DELIVERY if args.product == "CNC" else ProductType.INTRADAY
    engine = BacktestEngine(cfg, strategy, sectors=sectors, product=product)
    log.info("Backtesting %s on %d symbols over ~%d bars...",
             args.strategy, len(data), min(len(b) for b in data.values()))
    result = engine.run(data)

    report = result.report.to_dict()
    print("\n===== BACKTEST REPORT =====")
    print(json.dumps(report, indent=2))
    print(f"\nClosed trades: {len(result.portfolio.closed_trades)}")
    if args.json_out:
        with open(args.json_out, "w") as f:
            json.dump({"config": cfg.to_dict(), "report": report}, f, indent=2)
        log.info("Wrote report to %s", args.json_out)
    return 0


def cmd_paper(args) -> int:
    from .engine import TradingEngine
    from .strategies import get_strategy

    log = setup_logging(args.log_level)
    cfg = load_config(args.profile)
    cfg.mode = "paper"
    symbols = _parse_symbols(args.symbols)
    sectors = _sectors_for(symbols)

    provider = get_data_provider(args.data)
    broker = get_broker("paper", slippage_bps=cfg.execution.slippage_bps)
    product = ProductType.DELIVERY if args.product == "CNC" else ProductType.INTRADAY
    strategy = get_strategy(args.strategy)

    engine = TradingEngine(cfg, strategy, provider, broker, symbols,
                           sectors=sectors, interval=args.interval,
                           history_days=args.days, product=product)
    log.info("Paper trading %s on %d symbols for %d cycle(s)...",
             args.strategy, len(symbols), args.cycles)
    snap = engine.run(cycles=args.cycles, interval_sec=args.interval_sec)
    print("\n===== PAPER ACCOUNT =====")
    print(json.dumps({k: (v.isoformat() if isinstance(v, datetime) else v)
                      for k, v in snap.items()}, indent=2, default=str))
    return 0


def cmd_live(args) -> int:
    log = setup_logging(args.log_level)
    cfg = load_config(args.profile)

    if not (cfg.allow_live and args.i_understand_live_risk):
        log.error(
            "LIVE TRADING BLOCKED. This places REAL orders with REAL money.\n"
            "  To proceed you must BOTH:\n"
            "    1) export ALGO_ALLOW_LIVE=true\n"
            "    2) pass --i-understand-live-risk\n"
            "  You should paper-trade a strategy for weeks before enabling this.")
        return 3

    from .engine import TradingEngine
    from .strategies import get_strategy

    cfg.mode = "live"
    symbols = _parse_symbols(args.symbols)
    sectors = _sectors_for(symbols)
    provider = get_data_provider(args.data)
    broker = get_broker(args.broker, allow_live=True)
    product = ProductType.DELIVERY if args.product == "CNC" else ProductType.INTRADAY
    strategy = get_strategy(args.strategy)

    engine = TradingEngine(cfg, strategy, provider, broker, symbols,
                           sectors=sectors, interval=args.interval,
                           history_days=args.days, product=product)
    log.warning("LIVE TRADING ENABLED on broker=%s. Ctrl-C to stop.", args.broker)
    engine.run(cycles=args.cycles, interval_sec=args.interval_sec)
    return 0


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(prog="enterprise_algo",
                                description="Paper-first NSE algorithmic trading engine.")
    p.add_argument("--log-level", default="INFO")
    sub = p.add_subparsers(dest="command", required=True)

    def common(sp):
        sp.add_argument("--strategy", default="ensemble", help="ensemble | ma_crossover")
        sp.add_argument("--profile", default="default",
                        help="conservative | default | aggressive")
        sp.add_argument("--symbols", default=None, help="comma-separated, e.g. RELIANCE,TCS")
        sp.add_argument("--interval", default="1day")
        sp.add_argument("--days", type=int, default=365)
        sp.add_argument("--product", default="MIS", choices=["MIS", "CNC"])

    bt = sub.add_parser("backtest", help="Backtest on historical/synthetic data")
    common(bt)
    bt.add_argument("--data", default="synthetic", help="synthetic | csv | upstox | angelone")
    bt.add_argument("--json-out", default=None)
    bt.set_defaults(func=cmd_backtest)

    pa = sub.add_parser("paper", help="Paper trade (no real money)")
    common(pa)
    pa.add_argument("--data", default="synthetic")
    pa.add_argument("--cycles", type=int, default=1)
    pa.add_argument("--interval-sec", type=int, default=0)
    pa.set_defaults(func=cmd_paper)

    lv = sub.add_parser("live", help="Live trade (REAL money; blocked by default)")
    common(lv)
    lv.add_argument("--data", default="upstox")
    lv.add_argument("--broker", default="upstox", help="upstox | angelone")
    lv.add_argument("--cycles", type=int, default=1)
    lv.add_argument("--interval-sec", type=int, default=150)
    lv.add_argument("--i-understand-live-risk", action="store_true",
                    help="Required acknowledgement to place real orders.")
    lv.set_defaults(func=cmd_live)
    return p


def main(argv=None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    return args.func(args)


if __name__ == "__main__":
    sys.exit(main())
