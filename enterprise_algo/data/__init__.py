"""Market-data providers (adapter pattern)."""
from .base import DataProvider
from .synthetic import SyntheticDataProvider
from .csv_provider import CSVDataProvider


def get_data_provider(name: str, **kwargs) -> DataProvider:
    name = (name or "synthetic").lower()
    if name == "synthetic":
        return SyntheticDataProvider(**kwargs)
    if name == "csv":
        return CSVDataProvider(**kwargs)
    if name == "upstox":
        from .upstox_provider import UpstoxDataProvider
        return UpstoxDataProvider(**kwargs)
    if name == "angelone":
        from .angelone_provider import AngelOneDataProvider
        return AngelOneDataProvider(**kwargs)
    raise KeyError(f"Unknown data provider '{name}'")


__all__ = ["DataProvider", "SyntheticDataProvider", "CSVDataProvider", "get_data_provider"]
