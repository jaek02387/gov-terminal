"""News provider package with auto-discovery + a priority/fallback chain."""
from __future__ import annotations

import importlib
import logging
import pkgutil

from news.base import NewsProvider, registered_providers

log = logging.getLogger("news")


def _import_all() -> None:
    for mod in pkgutil.iter_modules(__path__):
        if mod.name.startswith("_") or mod.name == "base":
            continue
        try:
            importlib.import_module(f"{__name__}.{mod.name}")
        except Exception as exc:
            log.exception("could not import news provider '%s': %s", mod.name, exc)


def discover() -> list[NewsProvider]:
    _import_all()
    out: list[NewsProvider] = []
    for name, cls in registered_providers().items():
        try:
            out.append(cls())
        except Exception as exc:
            log.exception("could not instantiate news provider '%s': %s", name, exc)
    return sorted(out, key=lambda p: p.priority)


def get_news(ticker: str, limit: int = 12) -> dict:
    """Run enabled providers in priority order; return the first non-empty result.

    One provider call per request (with fallback) -- keeps it light and respects
    rate limits. Each provider is isolated: a failure just falls through.
    """
    for p in discover():
        if not p.is_enabled():
            continue
        try:
            items = p.fetch(ticker, limit=limit)
        except Exception as exc:
            log.warning("%s news failed for %s: %s", p.name, ticker, exc)
            continue
        if items:
            return {"items": items[:limit], "provider": p.name}
    return {"items": [], "provider": ""}
