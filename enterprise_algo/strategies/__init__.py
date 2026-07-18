"""Strategy framework."""
from .base import Strategy
from .ensemble import EnsembleStrategy
from .ma_crossover import MACrossoverStrategy

STRATEGY_REGISTRY = {
    "ensemble": EnsembleStrategy,
    "ma_crossover": MACrossoverStrategy,
}


def get_strategy(name: str, **kwargs) -> Strategy:
    name = name.lower()
    if name not in STRATEGY_REGISTRY:
        raise KeyError(f"Unknown strategy '{name}'. Available: {list(STRATEGY_REGISTRY)}")
    return STRATEGY_REGISTRY[name](**kwargs)


__all__ = ["Strategy", "EnsembleStrategy", "MACrossoverStrategy", "get_strategy", "STRATEGY_REGISTRY"]
