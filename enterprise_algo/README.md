# enterprise_algo — paper-first NSE algorithmic trading engine

A clean, broker-agnostic, **paper-and-backtest-first** trading engine for NSE
equities. Built as an upgrade over the legacy scripts in this repo: one tested
code path shared by backtesting, paper trading, and (guarded) live trading.

> ⚠️ **Not financial advice.** Markets carry risk of loss. This is engineering
> scaffolding for research and paper trading. Live trading is disabled by
> default and should only be enabled after extensive paper testing.

## Why this exists

The previous engine (`improved_trading_engine.py`, `nse500_live_trading*.py`)
was Upstox-only, live-first, and had no real backtester or paper simulator.
`enterprise_algo` fixes that with a layered, adapter-based design:

```
          strategies/            risk.py            brokers/
        (signals only)   ->  (sizing + caps)  ->  (execution)
              ^                                        |
              |                                        v
           data/  (synthetic | csv | upstox | angelone)   portfolio.py
                                                          (P&L, trades)
```

The **same** `strategy → risk → portfolio` path runs in the backtester
(`backtest.py`) and the live/paper engine (`engine.py`). Only the data source
and broker adapter change — which is what makes backtest results meaningful.

## Key features

- **Pluggable data providers** — `synthetic` (offline, deterministic), `csv`,
  `upstox` (v2 REST), `angelone` (SmartAPI).
- **Pluggable broker adapters** — `PaperBroker` simulator + guarded `upstox` /
  `angelone` live adapters.
- **Realistic NSE cost model** (`nse.py`) — brokerage (capped ₹20), STT,
  exchange txn, SEBI, GST, stamp duty — so reported P&L is **net**.
- **Risk engine** (`risk.py`) — fixed-fractional position sizing off the stop
  distance, max-positions / per-position / per-sector notional caps, a
  **daily-loss kill-switch** and daily-profit lock, and a confidence filter.
- **Strategies** — `ensemble` (RSI/MACD/Bollinger/Stochastic/momentum vote) and
  `ma_crossover` (EMA cross with trend gate), both emitting ATR stops/targets.
- **Metrics** (`metrics.py`) — total return, CAGR, Sharpe, Sortino, max
  drawdown, win rate, profit factor.
- **Two-key live interlock** — real orders require BOTH `ALGO_ALLOW_LIVE=true`
  AND the CLI flag `--i-understand-live-risk`.
- **Zero-credential offline demo** and a **pytest suite** that needs no network.

## Install

```bash
pip install -r requirements-algo.txt      # numpy + python-dotenv (core)
# optional live extras: requests, smartapi-python, pyotp
```

## Quick start (no credentials needed)

```bash
# Backtest the ensemble strategy on synthetic data
python -m enterprise_algo.cli backtest --strategy ensemble --profile default \
    --symbols RELIANCE,TCS,HDFCBANK,INFY --days 500 --product CNC

# Backtest the trend strategy, aggressive profile, intraday
python -m enterprise_algo.cli backtest --strategy ma_crossover \
    --profile aggressive --symbols RELIANCE,TCS,SBIN,MARUTI --days 800

# Paper-trade one cycle
python -m enterprise_algo.cli paper --strategy ma_crossover --symbols RELIANCE,TCS
```

## Using real NSE data

**CSV** — drop `data/history/<SYMBOL>.csv` (date,open,high,low,close,volume):
```bash
python -m enterprise_algo.cli backtest --data csv --symbols RELIANCE,TCS
```

**Upstox v2** — set `UPSTOX_ACCESS_TOKEN`, supply instrument keys in code, then:
```bash
python -m enterprise_algo.cli paper --data upstox --symbols RELIANCE,TCS
```

**Angel One SmartAPI** — `pip install smartapi-python pyotp`, set
`ANGEL_API_KEY/ANGEL_CLIENT_ID/ANGEL_PASSWORD/ANGEL_TOTP`, then `--data angelone`.

## Going live (deliberately hard)

```bash
export ALGO_ALLOW_LIVE=true
python -m enterprise_algo.cli live --broker upstox --data upstox \
    --symbols RELIANCE,TCS --i-understand-live-risk
```
Without **both** keys the command refuses and exits non-zero.

## Risk profiles

| Profile | risk/trade | max pos | pos cap | sector cap | daily loss | min conf |
|---------|-----------|---------|---------|-----------|-----------|----------|
| conservative | 0.5% | 3 | 10% | 25% | 2% | 0.70 |
| default | 1% | 6 | 16% | 35% | 3% | 0.60 |
| aggressive | 2% | 10 | 25% | 50% | 5% | 0.55 |

Override any value via `ALGO_*` env vars (see `.env.example`).

## Tests

```bash
pip install pytest && python -m pytest tests/ -q     # 20 tests, fully offline
```

## Layout

```
enterprise_algo/
  domain.py      core value objects (Bar, Signal, Order, Position, Trade)
  nse.py         market hours + Indian-equity cost model + sector universe
  indicators.py  vectorized numpy indicators
  config.py      profiles + env config + live-trading guard
  strategies/    Strategy ABC + ensemble + ma_crossover
  data/          DataProvider ABC + synthetic/csv/upstox/angelone
  brokers/       BrokerAdapter ABC + paper + guarded upstox/angelone
  risk.py        position sizing, caps, daily kill-switch
  portfolio.py   cash/positions/P&L accounting
  backtest.py    event-driven backtester
  engine.py      cycle-based paper/live engine
  metrics.py     performance report
  cli.py         `python -m enterprise_algo.cli ...`
```
