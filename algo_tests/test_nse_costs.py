from enterprise_algo.nse import CostModel
from enterprise_algo.domain import Side, ProductType


def test_brokerage_capped():
    cm = CostModel()
    # Large turnover -> brokerage should hit the Rs 20 cap
    charges = cm.charges(Side.BUY, price=1000, quantity=1000, product=ProductType.INTRADAY)
    assert charges > 0
    assert cm.brokerage(1000 * 1000) == 20.0


def test_intraday_stt_only_on_sell():
    cm = CostModel()
    buy = cm.charges(Side.BUY, 500, 100, ProductType.INTRADAY)
    sell = cm.charges(Side.SELL, 500, 100, ProductType.INTRADAY)
    # Sell leg carries STT intraday, so it should cost more than the buy leg.
    assert sell > buy


def test_zero_quantity_is_free():
    cm = CostModel()
    assert cm.charges(Side.BUY, 100, 0) == 0.0
