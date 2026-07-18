from datetime import datetime

from enterprise_algo.brokers.paper import PaperBroker
from enterprise_algo.domain import Order, OrderStatus, Side
from enterprise_algo.portfolio import Portfolio


def _buy(symbol, qty, price):
    return Order(symbol=symbol, side=Side.BUY, quantity=qty, timestamp=datetime.now(),
                 limit_price=price)


def _sell(symbol, qty, price):
    return Order(symbol=symbol, side=Side.SELL, quantity=qty, timestamp=datetime.now(),
                 limit_price=price)


def test_paper_broker_fills_with_slippage_and_fees():
    broker = PaperBroker(slippage_bps=10)
    order = broker.place_order(_buy("RELIANCE", 10, 1000), reference_price=1000)
    assert order.status is OrderStatus.FILLED
    assert order.average_price > 1000  # buy slips up
    assert order.fees > 0


def test_round_trip_realizes_pnl():
    broker = PaperBroker(slippage_bps=0)
    pf = Portfolio(starting_cash=100_000)

    buy = broker.place_order(_buy("TCS", 10, 100), reference_price=100)
    pf.apply_fill(buy)
    assert pf.open_positions()["TCS"].quantity == 10

    sell = broker.place_order(_sell("TCS", 10, 120), reference_price=120)
    pf.apply_fill(sell)

    assert "TCS" not in pf.open_positions()
    assert len(pf.closed_trades) == 1
    # gross profit 10*(120-100)=200, minus fees
    assert 150 < pf.realized_pnl < 200


def test_averaging_up_updates_avg_price():
    broker = PaperBroker(slippage_bps=0)
    pf = Portfolio(starting_cash=100_000)
    pf.apply_fill(broker.place_order(_buy("INFY", 10, 100), reference_price=100))
    pf.apply_fill(broker.place_order(_buy("INFY", 10, 200), reference_price=200))
    pos = pf.open_positions()["INFY"]
    assert pos.quantity == 20
    assert abs(pos.average_price - 150) < 1e-6


def test_equity_conserved_after_flat_round_trip():
    broker = PaperBroker(slippage_bps=0)
    pf = Portfolio(starting_cash=100_000)
    pf.apply_fill(broker.place_order(_buy("SBIN", 10, 100), reference_price=100))
    pf.apply_fill(broker.place_order(_sell("SBIN", 10, 100), reference_price=100))
    # back to flat at same price: equity = start - fees
    assert pf.equity({"SBIN": 100}) < 100_000
    assert pf.equity({"SBIN": 100}) > 99_900
