"""Vectorized technical indicators (numpy).

These operate on 1-D price/volume arrays and return full-length arrays aligned
to the input (leading values are NaN until the lookback is satisfied). This
makes them safe to use both in a streaming loop (take the last element) and in
a vectorized backtest.
"""
from __future__ import annotations

import numpy as np


def _as_array(data) -> np.ndarray:
    return np.asarray(data, dtype=float)


def sma(data, period: int) -> np.ndarray:
    x = _as_array(data)
    out = np.full_like(x, np.nan)
    if len(x) < period or period <= 0:
        return out
    cs = np.cumsum(np.insert(x, 0, 0.0))
    out[period - 1:] = (cs[period:] - cs[:-period]) / period
    return out


def ema(data, period: int) -> np.ndarray:
    x = _as_array(data)
    out = np.full_like(x, np.nan)
    if len(x) < period or period <= 0:
        return out
    alpha = 2.0 / (period + 1.0)
    out[period - 1] = x[:period].mean()
    for i in range(period, len(x)):
        out[i] = alpha * x[i] + (1 - alpha) * out[i - 1]
    return out


def rsi(data, period: int = 14) -> np.ndarray:
    x = _as_array(data)
    out = np.full_like(x, np.nan)
    if len(x) < period + 1:
        return out
    delta = np.diff(x)
    gain = np.where(delta > 0, delta, 0.0)
    loss = np.where(delta < 0, -delta, 0.0)
    avg_gain = gain[:period].mean()
    avg_loss = loss[:period].mean()
    for i in range(period, len(x)):
        g = gain[i - 1]
        l = loss[i - 1]
        avg_gain = (avg_gain * (period - 1) + g) / period
        avg_loss = (avg_loss * (period - 1) + l) / period
        if avg_loss == 0:
            out[i] = 100.0
        else:
            rs = avg_gain / avg_loss
            out[i] = 100.0 - (100.0 / (1.0 + rs))
    return out


def macd(data, fast: int = 12, slow: int = 26, signal: int = 9):
    x = _as_array(data)
    ema_fast = ema(x, fast)
    ema_slow = ema(x, slow)
    macd_line = ema_fast - ema_slow
    # Signal EMA over the valid portion of the macd line.
    valid = ~np.isnan(macd_line)
    signal_line = np.full_like(macd_line, np.nan)
    if valid.sum() >= signal:
        sig = ema(macd_line[valid], signal)
        signal_line[valid] = sig
    hist = macd_line - signal_line
    return macd_line, signal_line, hist


def bollinger_bands(data, period: int = 20, num_std: float = 2.0):
    x = _as_array(data)
    mid = sma(x, period)
    std = np.full_like(x, np.nan)
    for i in range(period - 1, len(x)):
        std[i] = x[i - period + 1:i + 1].std()
    upper = mid + num_std * std
    lower = mid - num_std * std
    return upper, mid, lower


def atr(high, low, close, period: int = 14) -> np.ndarray:
    h, l, c = _as_array(high), _as_array(low), _as_array(close)
    out = np.full_like(c, np.nan)
    if len(c) < period + 1:
        return out
    prev_close = np.roll(c, 1)
    tr = np.maximum.reduce([
        h - l,
        np.abs(h - prev_close),
        np.abs(l - prev_close),
    ])
    tr[0] = h[0] - l[0]
    out[period - 1] = tr[:period].mean()
    for i in range(period, len(c)):
        out[i] = (out[i - 1] * (period - 1) + tr[i]) / period
    return out


def stochastic_k(high, low, close, period: int = 14) -> np.ndarray:
    h, l, c = _as_array(high), _as_array(low), _as_array(close)
    out = np.full_like(c, np.nan)
    for i in range(period - 1, len(c)):
        window_low = l[i - period + 1:i + 1].min()
        window_high = h[i - period + 1:i + 1].max()
        rng = window_high - window_low
        out[i] = 50.0 if rng == 0 else 100.0 * (c[i] - window_low) / rng
    return out


def momentum(data, period: int = 10) -> np.ndarray:
    x = _as_array(data)
    out = np.full_like(x, np.nan)
    out[period:] = (x[period:] - x[:-period]) / np.where(x[:-period] == 0, np.nan, x[:-period]) * 100.0
    return out
