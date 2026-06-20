"""Shared interface for stock-news providers.

To add a provider: drop a file in ``news/`` with a subclass of ``NewsProvider``
defining a unique ``name``, a ``priority`` (lower = tried first), an ``enabled``
flag (usually keyed on an API key), and a ``fetch(ticker)`` method returning a
list of normalized items. It auto-registers on import.

The chain (see ``news/__init__.py``) tries enabled providers in priority order
and returns the first non-empty result -- one call per click, with fallback.
"""
from __future__ import annotations

import logging
from abc import ABC, abstractmethod

_REGISTRY: dict[str, type["NewsProvider"]] = {}


class NewsProvider(ABC):
    name: str = "unnamed"
    enabled: bool = True
    priority: int = 100  # lower runs first; keyed providers should be < 100

    def __init_subclass__(cls, **kwargs):
        super().__init_subclass__(**kwargs)
        if cls.name and cls.name != "unnamed":
            _REGISTRY[cls.name] = cls

    def __init__(self):
        self.log = logging.getLogger(f"news.{self.name}")

    @abstractmethod
    def fetch(self, ticker: str, limit: int = 12) -> list[dict]:
        """Return ``[{title, publisher, url, published, summary}, ...]``. May raise."""
        raise NotImplementedError

    def is_enabled(self) -> bool:
        return self.enabled


def registered_providers() -> dict[str, type[NewsProvider]]:
    return dict(_REGISTRY)
