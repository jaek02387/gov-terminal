"""Stocks panel API.

Reads ONLY from the SQLite snapshot for display (never live network), so the GET
is instant. The add/remove endpoints mutate the user's catalog and -- on add --
do a single lazy quote fetch so the new stock appears immediately.
"""
from __future__ import annotations

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

import catalog
import db
from sources import stocks

PANEL = {"id": "stocks", "title": "Stocks by Federal Priority", "order": 1}

router = APIRouter(prefix="/api/stocks", tags=["stocks"])


class AddRequest(BaseModel):
    ticker: str


@router.get("")
def get_stocks() -> dict:
    quotes = {q["ticker"]: q for q in db.read_snapshot("stocks")}
    names = db.get_names()

    categories = []
    for category, tickers in catalog.display_categories():
        rows = []
        for t in tickers:
            q = quotes.get(t)
            row = dict(q) if q is not None else {"ticker": t, "status": "missing"}
            row["name"] = names.get(t, "")
            rows.append(row)
        categories.append({"category": category, "tickers": rows})

    return {
        "categories": categories,
        "last_refresh": db.get_meta("last_refresh:stocks"),
    }


@router.get("/search")
def search_stocks(q: str = "") -> dict:
    """Typeahead suggestions for the add box. Failures degrade to empty results
    so a flaky search never breaks the panel."""
    try:
        return {"results": stocks.search_symbols(q)}
    except Exception as exc:  # network hiccup / rate limit -> empty, not an error
        return {"results": [], "error": str(exc)}


@router.post("/add")
def add_stock(req: AddRequest) -> dict:
    ticker = req.ticker.strip().upper()
    if not ticker:
        raise HTTPException(status_code=400, detail="Ticker is required.")
    if not stocks.is_valid_ticker(ticker):
        raise HTTPException(
            status_code=400, detail=f"'{ticker}' is not a valid ticker symbol."
        )

    if catalog.is_tracked(ticker):
        return {
            "status": "exists",
            "ticker": ticker,
            "category": catalog.category_of(ticker),
        }

    # Validate the symbol against the live market before committing it.
    quote = stocks.get_quote(ticker)
    if quote is None or quote.get("status") != "ok":
        raise HTTPException(
            status_code=404, detail=f"No market data found for '{ticker}'."
        )

    if db.is_hidden(ticker):
        # Re-adding a previously removed built-in ticker: just un-hide it.
        db.unhide_ticker(ticker)
        category = catalog.category_of(ticker)
        status = "restored"
    else:
        category = stocks.classify_ticker(ticker)
        db.add_user_ticker(ticker, category)
        status = "added"

    # Cache the quote + company name now so both show without waiting for refresh.
    try:
        stocks.resolve_names([ticker])  # best-effort: never fail the add on this
    except Exception:
        pass
    db.store_snapshot("stocks", [{"key": ticker, "data": quote}])
    return {
        "status": status,
        "ticker": ticker,
        "category": category,
        "name": db.get_names().get(ticker, ""),
        "quote": quote,
    }


@router.delete("/{ticker}")
def remove_stock(ticker: str) -> dict:
    ticker = ticker.strip().upper()
    if db.is_user_ticker(ticker):
        db.remove_user_ticker(ticker)
    elif catalog.is_config_ticker(ticker):
        db.hide_ticker(ticker)  # built-ins are hidden, not deleted (re-addable)
    else:
        raise HTTPException(status_code=404, detail=f"'{ticker}' is not tracked.")

    db.delete_snapshot_item("stocks", ticker)
    return {"status": "removed", "ticker": ticker}
