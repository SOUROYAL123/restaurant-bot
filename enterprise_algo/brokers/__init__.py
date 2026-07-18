"""Broker execution adapters (adapter pattern)."""
from .base import BrokerAdapter
from .paper import PaperBroker


def get_broker(name: str, allow_live: bool = False, **kwargs) -> BrokerAdapter:
    name = (name or "paper").lower()
    if name == "paper":
        return PaperBroker(**kwargs)
    if name == "upstox":
        from .upstox import UpstoxBroker
        return UpstoxBroker(allow_live=allow_live, **kwargs)
    if name == "angelone":
        from .angelone import AngelOneBroker
        return AngelOneBroker(allow_live=allow_live, **kwargs)
    raise KeyError(f"Unknown broker '{name}'")


__all__ = ["BrokerAdapter", "PaperBroker", "get_broker"]
