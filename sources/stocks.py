"""Stock quotes via yfinance.

Fully isolated: yfinance is imported lazily so an import/runtime failure here
cannot affect the bill sources or the rest of the app.

The hourly refresh pulls the whole effective catalog (config priorities + any
tickers the user added) in ONE batched download call. Single-ticker helpers
(``get_quote`` / ``classify_ticker``) back the runtime "add a stock" flow and are
the ONLY place that hits the network outside the scheduled refresh.
"""
from __future__ import annotations

import logging
import re
import time

import catalog
import config
import db
from sources.base import Source

log = logging.getLogger("source.stocks")

# A plausible ticker: letters/digits with optional . - ^ (e.g. BRK.B, BF-B).
# Rejects junk/garbage before it ever reaches yfinance.
_TICKER_RE = re.compile(r"^[A-Z0-9][A-Z0-9.\-^]{0,11}$")


def is_valid_ticker(ticker: str) -> bool:
    return bool(_TICKER_RE.match(ticker or ""))


def _parse_quote(frame, ticker: str) -> dict | None:
    """Pull the last two valid daily closes for a ticker out of a yfinance frame.

    Handles both the multi-ticker (columns include the ticker) and single-ticker
    (columns are just OHLCV) frame shapes.
    """
    try:
        import pandas as pd

        cols = frame.columns
        close = None
        if isinstance(cols, pd.MultiIndex):
            lvl0, lvl1 = cols.get_level_values(0), cols.get_level_values(1)
            if ticker in lvl0:            # ('AAPL', 'Close') -> grouped by ticker
                close = frame[ticker]["Close"]
            elif ticker in lvl1 and "Close" in lvl0:  # ('Close', 'AAPL')
                close = frame["Close"][ticker]
            elif "Close" in lvl0:          # single ('Close', <only ticker>)
                sub = frame["Close"]
                if not hasattr(sub, "columns"):
                    close = sub
                elif sub.shape[1] == 1:    # exactly one ticker -> unambiguous
                    close = sub.iloc[:, 0]
                # else: multiple columns and the requested ticker isn't named
                #       here -> ambiguous, leave close = None (treated as no data)
        elif "Close" in cols:              # flat columns
            close = frame["Close"]
        if close is None:
            return None

        closes = [float(x) for x in close.dropna().tolist()]
        if not closes:
            return None

        price = closes[-1]
        prev = closes[-2] if len(closes) >= 2 else closes[-1]
        change = price - prev
        change_pct = (change / prev * 100.0) if prev else 0.0
        return {
            "ticker": ticker,
            "price": round(price, 2),
            "prev_close": round(prev, 2),
            "change": round(change, 2),
            "change_pct": round(change_pct, 2),
            "status": "ok",
        }
    except Exception as exc:
        log.warning("could not parse %s: %s", ticker, exc)
        return None


# Chart ranges -> (yfinance period, interval). Lazy, on click only.
HISTORY_RANGES = {
    "1D": ("1d", "5m"),
    "1W": ("5d", "30m"),
    "1M": ("1mo", "1d"),
    "6M": ("6mo", "1d"),
    "1Y": ("1y", "1d"),
    "5Y": ("5y", "1wk"),
}


def get_history(ticker: str, range_key: str = "1M") -> list[dict]:
    """Historical price points for the chart. Returns ``[{"t", "close"}, ...]``."""
    import yfinance as yf

    period, interval = HISTORY_RANGES.get(range_key, HISTORY_RANGES["1M"])
    try:
        frame = yf.Ticker(ticker).history(period=period, interval=interval)
    except Exception as exc:
        log.warning("history failed for %s (%s): %s", ticker, range_key, exc)
        return []
    if frame is None or frame.empty or "Close" not in frame.columns:
        return []
    out: list[dict] = []
    for idx, val in frame["Close"].dropna().items():
        out.append({"t": idx.isoformat(), "close": round(float(val), 2)})
    return out


def get_stats(ticker: str) -> dict:
    """Key stats (open/high/low/volume/52w/market cap/PE/etc.) for the detail
    view. One yfinance metadata call -- only used lazily on click, then cached."""
    import yfinance as yf

    try:
        info = yf.Ticker(ticker).info or {}
    except Exception as exc:
        log.warning("stats failed for %s: %s", ticker, exc)
        return {}
    g = info.get
    return {
        "name": g("longName") or g("shortName") or "",
        "exchange": g("fullExchangeName") or g("exchange") or "",
        "currency": g("currency") or "USD",
        "open": g("open") or g("regularMarketOpen"),
        "day_high": g("dayHigh") or g("regularMarketDayHigh"),
        "day_low": g("dayLow") or g("regularMarketDayLow"),
        "volume": g("volume") or g("regularMarketVolume"),
        "avg_volume": g("averageVolume"),
        "market_cap": g("marketCap"),
        "pe": g("trailingPE"),
        "eps": g("trailingEps"),
        "beta": g("beta"),
        "dividend_yield": g("dividendYield"),
        "year_high": g("fiftyTwoWeekHigh"),
        "year_low": g("fiftyTwoWeekLow"),
    }


def search_symbols(query: str, limit: int = 8) -> list[dict]:
    """Typeahead suggestions via Yahoo Finance's public search endpoint (no key).

    Returns ``[{symbol, name, exchange, type}, ...]`` for equities and ETFs.
    This is a live call but only fires while the user types in the add box -- it
    never touches the cached panel data path.
    """
    import requests

    q = query.strip()
    if not q:
        return []

    resp = requests.get(
        "https://query2.finance.yahoo.com/v1/finance/search",
        params={"q": q, "quotesCount": limit, "newsCount": 0, "enableFuzzyQuery": False},
        headers={"User-Agent": "Mozilla/5.0 (gov-terminal)"},
        timeout=6,
    )
    resp.raise_for_status()

    out: list[dict] = []
    for item in resp.json().get("quotes", []):
        symbol = item.get("symbol")
        qtype = item.get("quoteType")
        if not symbol or qtype not in ("EQUITY", "ETF"):
            continue
        out.append(
            {
                "symbol": symbol,
                "name": item.get("shortname") or item.get("longname") or "",
                "exchange": item.get("exchDisp") or "",
                "type": item.get("typeDisp") or qtype.title(),
            }
        )
        if len(out) >= limit:
            break
    return out


def fetch_name(ticker: str) -> str:
    """Resolve a ticker's company name. Tries the lightweight (no-auth) search
    endpoint first, then falls back to yfinance metadata."""
    try:
        for r in search_symbols(ticker, limit=10):
            if r["symbol"].upper() == ticker.upper() and r["name"]:
                return r["name"]
    except Exception:
        pass
    try:
        import yfinance as yf

        info = yf.Ticker(ticker).info or {}
        return info.get("longName") or info.get("shortName") or ""
    except Exception:
        return ""


def resolve_names(tickers: list[str]) -> None:
    """Ensure every ticker has a cached company name. Only tickers missing from
    the cache trigger a lookup, so the hourly refresh stays lightweight (it does
    real work only the first time a ticker is seen)."""
    have = db.get_names()
    missing = [t for t in tickers if not have.get(t)]
    if not missing:
        return
    log.info("resolving %d company name(s): %s", len(missing), ", ".join(missing))
    for t in missing:
        name = fetch_name(t)
        if name:
            db.set_name(t, name)
        time.sleep(0.1)  # be polite to the upstream search endpoint


def get_quote(ticker: str) -> dict | None:
    """Fetch a single ticker's quote. Returns None if the ticker has no data
    (used to validate a user-supplied symbol before adding it)."""
    import yfinance as yf

    frame = yf.download(
        tickers=ticker,
        period="5d",
        interval="1d",
        auto_adjust=False,
        progress=False,
        threads=False,
    )
    return _parse_quote(frame, ticker)


def classify_ticker(ticker: str) -> str:
    """Auto-sort a ticker into a federal-priority category using config keyword
    rules against its yfinance metadata. Falls back to the 'Other' category."""
    import yfinance as yf

    info: dict = {}
    try:
        info = yf.Ticker(ticker).info or {}
    except Exception as exc:
        log.warning("no metadata for %s, defaulting to Other: %s", ticker, exc)

    # We already have the metadata in hand -- cache the name to avoid a 2nd call.
    name = info.get("longName") or info.get("shortName")
    if name:
        db.set_name(ticker, name)

    # Classify on the clean canonical fields (sector/industry/name). The business
    # summary is deliberately excluded -- it lists customer verticals ("defense",
    # "energy", ...) that cause false positives (e.g. Snowflake -> Defense).
    hay = " ".join(
        str(info.get(k, "")) for k in ("sector", "industry", "longName", "shortName")
    ).lower()

    for category, keywords in config.CATEGORY_KEYWORDS.items():
        if any(kw in hay for kw in keywords):
            log.info("classified %s -> %s", ticker, category)
            return category
    log.info("classified %s -> %s (no keyword match)", ticker, config.OTHER_CATEGORY)
    return config.OTHER_CATEGORY


class StocksSource(Source):
    name = "stocks"
    enabled = True
    track_changes = False  # prices always move; no point diffing

    def fetch(self) -> list[dict]:
        import yfinance as yf  # lazy import keeps the failure isolated

        tickers = catalog.tickers_to_fetch()
        if not tickers:
            return []

        self.log.info("downloading %d ticker(s): %s", len(tickers), ", ".join(tickers))

        # One batched request for all tickers. 5 calendar days covers weekends
        # and holidays so we reliably get at least two trading-day closes.
        data = yf.download(
            tickers=" ".join(tickers),
            period="5d",
            interval="1d",
            group_by="ticker",
            auto_adjust=False,
            progress=False,
            threads=True,
        )

        records: list[dict] = []
        for ticker in tickers:
            quote = _parse_quote(data, ticker)
            if quote is None:
                self.log.warning("no data for %s", ticker)
                quote = {
                    "ticker": ticker,
                    "price": None,
                    "prev_close": None,
                    "change": None,
                    "change_pct": None,
                    "status": "no_data",
                }
            records.append({"key": ticker, "data": quote})

        # Backfill any company names we don't have yet (one-time per ticker).
        # Best-effort: a name-lookup failure must never discard the price data.
        try:
            resolve_names(tickers)
        except Exception as exc:
            self.log.warning("name backfill failed (non-fatal): %s", exc)
        return records
