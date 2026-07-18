"""NSE market rules and a realistic Indian-equity cost model.

Charges here approximate the real regulatory/broker charges applied to NSE
equity trades so that backtests and paper trading reflect true net P&L rather
than gross. Rates are as published by discount brokers (Zerodha/Upstox-style)
and can be overridden via ``CostModel`` fields.

NOTE: statutory rates change over time. Treat these as sensible defaults, not
legal/financial advice — override them from config for exact accounting.
"""
from __future__ import annotations

from dataclasses import dataclass
from datetime import time
from zoneinfo import ZoneInfo

from .domain import ProductType, Side

IST = ZoneInfo("Asia/Kolkata")

# Regular market session for NSE equities (IST).
MARKET_OPEN = time(9, 15)
MARKET_CLOSE = time(15, 30)
# Intraday positions are typically auto-squared-off by the broker around this time.
INTRADAY_SQUAREOFF = time(15, 20)


def is_market_open(dt) -> bool:
    """True if ``dt`` (tz-aware or naive-assumed-IST) is within the NSE session
    on a weekday. Exchange holidays are not encoded here."""
    t = dt.timetz() if dt.tzinfo else dt.time()
    if dt.weekday() >= 5:  # Sat/Sun
        return False
    return MARKET_OPEN <= t.replace(tzinfo=None) <= MARKET_CLOSE if dt.tzinfo else MARKET_OPEN <= t <= MARKET_CLOSE


@dataclass
class CostModel:
    """Per-trade cost components for NSE equities.

    All rates are fractions (e.g. 0.0003 == 0.03%). Defaults model a typical
    discount-broker intraday plan.
    """
    brokerage_pct: float = 0.0003          # 0.03% per leg
    brokerage_cap: float = 20.0            # capped at Rs 20 per order
    stt_intraday_pct: float = 0.00025      # 0.025% on sell leg (intraday)
    stt_delivery_pct: float = 0.001        # 0.1% on both legs (delivery)
    exchange_txn_pct: float = 0.0000297    # NSE txn charge ~0.00297%
    sebi_pct: float = 0.000001             # Rs 10 / crore
    gst_pct: float = 0.18                  # 18% on (brokerage + txn + sebi)
    stamp_duty_pct: float = 0.00003        # 0.003% on buy leg (intraday)
    stamp_duty_delivery_pct: float = 0.00015

    def brokerage(self, turnover: float) -> float:
        return min(turnover * self.brokerage_pct, self.brokerage_cap)

    def charges(self, side: Side, price: float, quantity: int,
                product: ProductType = ProductType.INTRADAY) -> float:
        """Total charges for a single leg (buy or sell)."""
        turnover = abs(price * quantity)
        if turnover == 0:
            return 0.0

        brokerage = self.brokerage(turnover)
        exchange_txn = turnover * self.exchange_txn_pct
        sebi = turnover * self.sebi_pct
        gst = (brokerage + exchange_txn + sebi) * self.gst_pct

        if product is ProductType.DELIVERY:
            stt = turnover * self.stt_delivery_pct  # both legs
            stamp = turnover * self.stamp_duty_delivery_pct if side is Side.BUY else 0.0
        else:
            stt = turnover * self.stt_intraday_pct if side is Side.SELL else 0.0
            stamp = turnover * self.stamp_duty_pct if side is Side.BUY else 0.0

        return round(brokerage + exchange_txn + sebi + gst + stt + stamp, 4)


# A small, representative NSE universe with sector tags for diversification
# checks. Extend/replace from instruments file for the full NSE-500.
DEFAULT_UNIVERSE = {
    "RELIANCE": "ENERGY",
    "TCS": "IT",
    "INFY": "IT",
    "HDFCBANK": "BANK",
    "ICICIBANK": "BANK",
    "SBIN": "BANK",
    "HINDUNILVR": "FMCG",
    "ITC": "FMCG",
    "LT": "INFRA",
    "BHARTIARTL": "TELECOM",
    "KOTAKBANK": "BANK",
    "AXISBANK": "BANK",
    "MARUTI": "AUTO",
    "TATAMOTORS": "AUTO",
    "SUNPHARMA": "PHARMA",
}
