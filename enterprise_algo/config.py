"""Configuration for enterprise_algo.

Self-contained, dependency-light config built from environment variables with
three risk profiles (conservative / default / aggressive). Kept separate from
the legacy ``config_manager.py`` so the package has no import side effects
(no forced .env, no directory creation at import time).
"""
from __future__ import annotations

import os
from dataclasses import dataclass, field, asdict
from typing import Any, Dict


def _env_bool(name: str, default: bool) -> bool:
    v = os.getenv(name)
    if v is None:
        return default
    return v.strip().lower() in {"1", "true", "yes", "on"}


def _env_float(name: str, default: float) -> float:
    try:
        return float(os.getenv(name, default))
    except (TypeError, ValueError):
        return default


def _env_int(name: str, default: int) -> int:
    try:
        return int(os.getenv(name, default))
    except (TypeError, ValueError):
        return default


PROFILES: Dict[str, Dict[str, Any]] = {
    "conservative": {
        "capital": 100_000.0,
        "risk_per_trade": 0.005,
        "max_positions": 3,
        "max_position_pct": 0.10,
        "max_sector_pct": 0.25,
        "daily_loss_limit_pct": 0.02,
        "daily_profit_target_pct": 0.03,
        "min_confidence": 0.70,
    },
    "default": {
        "capital": 100_000.0,
        "risk_per_trade": 0.01,
        "max_positions": 6,
        "max_position_pct": 0.16,
        "max_sector_pct": 0.35,
        "daily_loss_limit_pct": 0.03,
        "daily_profit_target_pct": 0.05,
        "min_confidence": 0.60,
    },
    "aggressive": {
        "capital": 100_000.0,
        "risk_per_trade": 0.02,
        "max_positions": 10,
        "max_position_pct": 0.25,
        "max_sector_pct": 0.50,
        "daily_loss_limit_pct": 0.05,
        "daily_profit_target_pct": 0.10,
        "min_confidence": 0.55,
    },
}


@dataclass
class RiskConfig:
    capital: float = 100_000.0
    risk_per_trade: float = 0.01          # fraction of equity risked per trade
    max_positions: int = 6
    max_position_pct: float = 0.16        # max notional per position / equity
    max_sector_pct: float = 0.35          # max notional per sector / equity
    daily_loss_limit_pct: float = 0.03    # kill-switch
    daily_profit_target_pct: float = 0.05
    min_confidence: float = 0.60
    default_stop_atr_mult: float = 2.0
    default_target_atr_mult: float = 3.0


@dataclass
class ExecutionConfig:
    slippage_bps: float = 5.0             # 5 bps modelled slippage
    product: str = "MIS"                  # MIS intraday / CNC delivery


@dataclass
class Config:
    profile: str = "default"
    mode: str = "paper"                   # backtest | paper | live
    risk: RiskConfig = field(default_factory=RiskConfig)
    execution: ExecutionConfig = field(default_factory=ExecutionConfig)
    data_provider: str = "synthetic"      # synthetic | csv | upstox | angelone
    broker: str = "paper"                 # paper | upstox | angelone
    # Live trading is OFF unless BOTH this env flag is set AND the CLI passes an
    # explicit confirmation. This is a deliberate two-key safety interlock.
    allow_live: bool = False

    def to_dict(self) -> Dict[str, Any]:
        return {
            "profile": self.profile,
            "mode": self.mode,
            "data_provider": self.data_provider,
            "broker": self.broker,
            "allow_live": self.allow_live,
            "risk": asdict(self.risk),
            "execution": asdict(self.execution),
        }


def load_config(profile: str | None = None) -> Config:
    profile = (profile or os.getenv("ALGO_PROFILE", "default")).lower()
    p = PROFILES.get(profile, PROFILES["default"])

    risk = RiskConfig(
        capital=_env_float("ALGO_CAPITAL", p["capital"]),
        risk_per_trade=_env_float("ALGO_RISK_PER_TRADE", p["risk_per_trade"]),
        max_positions=_env_int("ALGO_MAX_POSITIONS", p["max_positions"]),
        max_position_pct=_env_float("ALGO_MAX_POSITION_PCT", p["max_position_pct"]),
        max_sector_pct=_env_float("ALGO_MAX_SECTOR_PCT", p["max_sector_pct"]),
        daily_loss_limit_pct=_env_float("ALGO_DAILY_LOSS_PCT", p["daily_loss_limit_pct"]),
        daily_profit_target_pct=_env_float("ALGO_DAILY_PROFIT_PCT", p["daily_profit_target_pct"]),
        min_confidence=_env_float("ALGO_MIN_CONFIDENCE", p["min_confidence"]),
    )
    execution = ExecutionConfig(
        slippage_bps=_env_float("ALGO_SLIPPAGE_BPS", 5.0),
        product=os.getenv("ALGO_PRODUCT", "MIS"),
    )
    return Config(
        profile=profile,
        mode=os.getenv("ALGO_MODE", "paper"),
        risk=risk,
        execution=execution,
        data_provider=os.getenv("ALGO_DATA_PROVIDER", "synthetic"),
        broker=os.getenv("ALGO_BROKER", "paper"),
        allow_live=_env_bool("ALGO_ALLOW_LIVE", False),
    )
