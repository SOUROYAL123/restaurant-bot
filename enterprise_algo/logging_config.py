"""Lightweight structured logging setup used by the CLI and engines."""
from __future__ import annotations

import logging
import sys


def setup_logging(level: str = "INFO", to_file: str | None = None) -> logging.Logger:
    logger = logging.getLogger("enterprise_algo")
    logger.setLevel(getattr(logging, level.upper(), logging.INFO))
    logger.handlers.clear()

    fmt = logging.Formatter(
        "%(asctime)s | %(levelname)-7s | %(name)s | %(message)s",
        datefmt="%Y-%m-%d %H:%M:%S",
    )
    ch = logging.StreamHandler(sys.stdout)
    ch.setFormatter(fmt)
    logger.addHandler(ch)

    if to_file:
        fh = logging.FileHandler(to_file)
        fh.setFormatter(fmt)
        logger.addHandler(fh)

    logger.propagate = False
    return logger
