import numpy as np

from enterprise_algo import indicators as ind


def test_sma_matches_manual():
    data = [1, 2, 3, 4, 5]
    out = ind.sma(data, 3)
    assert np.isnan(out[:2]).all()
    np.testing.assert_allclose(out[2:], [2.0, 3.0, 4.0])


def test_rsi_bounds():
    rng = np.random.default_rng(0)
    prices = np.cumsum(rng.normal(0, 1, 200)) + 100
    r = ind.rsi(prices, 14)
    valid = r[~np.isnan(r)]
    assert valid.min() >= 0 and valid.max() <= 100


def test_ema_trends_up_on_rising_series():
    data = list(range(1, 60))
    e = ind.ema(data, 10)
    assert e[-1] > e[20]


def test_atr_non_negative():
    rng = np.random.default_rng(1)
    close = np.cumsum(rng.normal(0, 1, 100)) + 100
    high = close + np.abs(rng.normal(0, 0.5, 100))
    low = close - np.abs(rng.normal(0, 0.5, 100))
    a = ind.atr(high, low, close, 14)
    valid = a[~np.isnan(a)]
    assert (valid >= 0).all()


def test_macd_shapes():
    data = list(np.linspace(100, 200, 100))
    macd, signal, hist = ind.macd(data)
    assert len(macd) == len(signal) == len(hist) == 100
