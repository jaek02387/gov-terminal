"""Resolves the *effective* ticker catalog: the static federal-priority config
in config.py layered with the user's runtime customisations stored in SQLite
(added tickers + hidden built-ins).

Both the stocks source (which tickers to fetch) and the stocks panel (how to
group them for display) read from here, so the two never drift apart.
"""
from __future__ import annotations

import config
import db


def is_config_ticker(ticker: str) -> bool:
    return ticker in set(config.all_tickers())


def is_tracked(ticker: str) -> bool:
    """True if the ticker currently shows in the interface."""
    if db.is_user_ticker(ticker):
        return True
    return is_config_ticker(ticker) and not db.is_hidden(ticker)


def category_of(ticker: str) -> str:
    """Which category a ticker belongs to (user assignment wins)."""
    user = db.list_user_tickers()
    if ticker in user:
        return user[ticker]
    for name, tickers in config.STOCK_CATEGORIES.items():
        if ticker in tickers:
            return name
    return config.OTHER_CATEGORY


def display_categories() -> list[tuple[str, list[str]]]:
    """Ordered (category, tickers) pairs for the UI: the 8 priority categories
    (built-ins minus hidden, plus user tickers sorted into them) followed by the
    9th 'Other' category."""
    hidden = set(db.list_hidden())
    user = db.list_user_tickers()

    result: list[tuple[str, list[str]]] = []
    for name, tickers in config.STOCK_CATEGORIES.items():
        eff = [t for t in tickers if t not in hidden]
        for t, cat in user.items():
            if cat == name and t not in hidden and t not in eff:
                eff.append(t)
        result.append((name, eff))

    other = [t for t, cat in user.items() if cat == config.OTHER_CATEGORY and t not in hidden]
    result.append((config.OTHER_CATEGORY, other))
    return result


def tickers_to_fetch() -> list[str]:
    """Flat, de-duplicated list of every ticker the price refresh should pull."""
    hidden = set(db.list_hidden())
    out: list[str] = []
    for t in config.all_tickers():
        if t not in hidden:
            out.append(t)
    for t in db.list_user_tickers():
        if t not in hidden and t not in out:
            out.append(t)
    return out
