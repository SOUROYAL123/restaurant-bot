from datetime import date, datetime

from enterprise_algo.config import RiskConfig
from enterprise_algo.domain import Signal, SignalType
from enterprise_algo.portfolio import Portfolio
from enterprise_algo.risk import RiskManager


def _sig(symbol="RELIANCE", price=1000.0, stop=980.0, conf=0.9):
    return Signal(symbol=symbol, type=SignalType.BUY, confidence=conf,
                  timestamp=datetime.now(), price=price, stop_loss=stop,
                  take_profit=price + 40)


def test_confidence_filter_rejects_low_confidence():
    rm = RiskManager(RiskConfig(min_confidence=0.6))
    pf = Portfolio(100_000)
    d = rm.evaluate(_sig(conf=0.3), 1000, pf, {"RELIANCE": 1000})
    assert not d.approved and "confidence" in d.reason


def test_position_sizing_respects_risk_budget():
    cfg = RiskConfig(capital=100_000, risk_per_trade=0.01, max_position_pct=1.0,
                     max_sector_pct=1.0)
    rm = RiskManager(cfg)
    pf = Portfolio(100_000)
    # risk 1% of 100k = 1000; stop distance 20 -> ~50 shares
    d = rm.evaluate(_sig(price=1000, stop=980), 1000, pf, {"RELIANCE": 1000})
    assert d.approved
    assert 40 <= d.quantity <= 60


def test_notional_cap_limits_quantity():
    cfg = RiskConfig(capital=100_000, risk_per_trade=1.0, max_position_pct=0.10)
    rm = RiskManager(cfg)
    pf = Portfolio(100_000)
    d = rm.evaluate(_sig(price=1000, stop=999), 1000, pf, {"RELIANCE": 1000})
    # max notional 10% of 100k = 10k -> 10 shares max
    assert d.approved and d.quantity == 10


def test_daily_loss_kill_switch():
    cfg = RiskConfig(capital=100_000, daily_loss_limit_pct=0.03)
    rm = RiskManager(cfg)
    today = date.today()
    assert rm.check_daily_limits(today, 100_000) is None
    # drop equity 4% -> should halt
    reason = rm.check_daily_limits(today, 96_000)
    assert reason is not None and "loss" in reason


def test_max_positions_enforced():
    cfg = RiskConfig(capital=100_000, max_positions=1)
    rm = RiskManager(cfg, sectors={"RELIANCE": "ENERGY", "TCS": "IT"})
    pf = Portfolio(100_000, sectors={"RELIANCE": "ENERGY", "TCS": "IT"})
    from enterprise_algo.brokers.paper import PaperBroker
    from enterprise_algo.domain import Order, Side
    broker = PaperBroker(slippage_bps=0)
    pf.apply_fill(broker.place_order(
        Order(symbol="RELIANCE", side=Side.BUY, quantity=5, timestamp=datetime.now(),
              limit_price=1000), reference_price=1000))
    prices = {"RELIANCE": 1000, "TCS": 1000}
    d = rm.evaluate(_sig(symbol="TCS"), 1000, pf, prices)
    assert not d.approved and "max positions" in d.reason
