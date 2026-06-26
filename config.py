"""Central configuration for the gov-terminal app.

Everything here is plain data / settings so you can edit categories, tickers and
intervals WITHOUT touching any logic. API keys are loaded from a local .env file
and are never hardcoded.
"""
from __future__ import annotations

import datetime
import os
from pathlib import Path

from dotenv import load_dotenv

# ---------------------------------------------------------------------------
# Paths
# ---------------------------------------------------------------------------
BASE_DIR = Path(__file__).resolve().parent
DB_PATH = str(BASE_DIR / "cache.db")
STATIC_DIR = BASE_DIR / "static"

# Load .env that sits next to this file (if present). Missing file is fine.
load_dotenv(BASE_DIR / ".env")

# ---------------------------------------------------------------------------
# API keys (loaded from .env -- leave blank to keep a source dormant)
# ---------------------------------------------------------------------------
CONGRESS_API_KEY = os.getenv("CONGRESS_API_KEY", "").strip()
LEGISCAN_API_KEY = os.getenv("LEGISCAN_API_KEY", "").strip()

# Optional stock-news providers (leave blank to keep dormant). The news chain
# falls back to free yfinance news when neither key is set.
FINNHUB_API_KEY = os.getenv("FINNHUB_API_KEY", "").strip()
MARKETAUX_API_KEY = os.getenv("MARKETAUX_API_KEY", "").strip()
# Optional: restrict Marketaux to specific source domains for maximum neutrality,
# e.g. "apnews.com,reuters.com". Blank = all sources.
MARKETAUX_DOMAINS = os.getenv("MARKETAUX_DOMAINS", "").strip()

# ---------------------------------------------------------------------------
# Refresh cadence
# ---------------------------------------------------------------------------
# Background job refreshes the SQLite cache every REFRESH_INTERVAL_MINUTES.
REFRESH_INTERVAL_MINUTES = int(os.getenv("REFRESH_INTERVAL_MINUTES", "60"))

# ---------------------------------------------------------------------------
# Stocks: category -> tickers, grouped by federal priority.
# Edit this dict freely; the stocks logic reads it generically.
# (A ticker may appear in more than one category -- that is intentional.)
# ---------------------------------------------------------------------------
STOCK_CATEGORIES: dict[str, list[str]] = {
    "1. Defense & Nuclear Modernization": ["LMT", "RTX", "NOC", "GD", "HII"],
    "2. Nuclear Power / Reactor Buildout": ["CEG", "VST", "CCJ", "OKLO", "SMR"],
    "3. Critical Minerals & Domestic Supply Chains": ["MP", "UUUU", "ALB"],
    "4. AI Infrastructure & Data Centers": ["NVDA", "MSFT", "AMZN", "GOOGL", "VRT"],
    "5. Energy Dominance": ["XOM", "CVX", "LNG", "EQT"],
    "6. Domestic Pharmaceutical Manufacturing": ["LLY", "PFE"],
    "7. Shipbuilding & Maritime": ["HII", "GD"],
    "8. Drones & Space": ["AVAV", "KTOS", "RKLB"],
}


def all_tickers() -> list[str]:
    """Unique, de-duplicated list of every ticker across all categories."""
    seen: dict[str, None] = {}
    for tickers in STOCK_CATEGORIES.values():
        for t in tickers:
            seen.setdefault(t, None)
    return list(seen.keys())


# Catch-all 9th category for user-added tickers that don't match any priority.
OTHER_CATEGORY = "9. Other"

# Keyword rules used to AUTO-SORT a user-added ticker into a priority category.
# Matched (in this order, so #1 wins ties) against the stock's sector, industry,
# name and business summary from yfinance. No match -> OTHER_CATEGORY.
# Plain data -- edit freely to tune classification without touching logic.
CATEGORY_KEYWORDS: dict[str, list[str]] = {
    "1. Defense & Nuclear Modernization": [
        "aerospace & defense", "defense", "military", "weapon", "missile",
        "armament", "tactical", "warfare",
    ],
    "2. Nuclear Power / Reactor Buildout": [
        "nuclear", "reactor", "uranium", "enrichment",
    ],
    "3. Critical Minerals & Domestic Supply Chains": [
        "mining", "minerals", "lithium", "rare earth", "metals & mining",
        "copper", "steel", "aluminum", "specialty chemicals",
    ],
    "4. AI Infrastructure & Data Centers": [
        "semiconductor", "software", "information technology", "data center",
        "cloud", "computer hardware", "internet", "artificial intelligence",
        "communication equipment", "electronic",
    ],
    "5. Energy Dominance": [
        "oil", "gas", "petroleum", "drilling", "pipeline", "refining", "lng",
        "midstream", "upstream", "energy",
    ],
    "6. Domestic Pharmaceutical Manufacturing": [
        "pharmaceutical", "drug manufacturers", "biotechnology", "biopharma",
        "therapeutics", "medicine",
    ],
    "7. Shipbuilding & Maritime": [
        "shipbuilding", "marine", "maritime", "shipping", "naval", "vessel",
    ],
    "8. Drones & Space": [
        "drone", "unmanned", "space", "satellite", "rocket", "launch", "uav",
    ],
}


# ---------------------------------------------------------------------------
# Bills: specific measures to watch, tied to the federal priorities above.
# These are placeholders you can edit; the watchlist panel reads this list.
# Format: {"congress": 119, "type": "hr", "number": "1234", "note": "why"}
# ---------------------------------------------------------------------------
WATCHLIST_BILLS: list[dict] = []

# Which Congress to track. Computed for "now" (e.g. 119th for 2025-2026); edit
# if you want to pin a specific one. New congress every 2 years, odd-year start.
CURRENT_CONGRESS = (datetime.date.today().year - 1789) // 2 + 1

# Only substantive legislation (bills + joint resolutions). Excludes simple and
# concurrent resolutions, which are mostly ceremonial/procedural noise.
SUBSTANTIVE_BILL_TYPES = ["hr", "s", "hjres", "sjres"]

# Keywords used to keep bills relevant to the federal priorities above. Matched
# as whole words against the bill TITLE *and* its latest-action text (so a bill
# referred to e.g. the Committee on Armed Services is caught even if its title
# has no keyword). Edit freely -- a wider list = wider net (more recall, a bit
# less precision).
BILL_SEARCH_TERMS: list[str] = [
    # 1. Defense & nuclear modernization
    "defense", "defense industrial", "national security", "armed forces",
    "missile", "hypersonic", "munitions", "warfighter",
    # 2. Nuclear power / reactor buildout
    "nuclear", "reactor", "uranium", "enrichment", "small modular reactor",
    # 3. Critical minerals & domestic supply chains
    "critical mineral", "critical minerals", "rare earth", "mining", "battery",
    "supply chain", "domestic manufacturing",
    # 4. AI infrastructure & data centers
    "semiconductor", "chip", "artificial intelligence", "machine learning",
    "data center", "quantum",
    # 5. Energy dominance
    "energy", "natural gas", "liquefied natural gas", "pipeline", "grid",
    "electricity", "petroleum", "drilling",
    # 6. Domestic pharmaceutical manufacturing
    "pharmaceutical", "drug manufacturing", "active pharmaceutical ingredient",
    # 7. Shipbuilding & maritime
    "shipbuilding", "shipyard", "naval", "submarine", "maritime",
    # 8. Drones & space
    "drone", "unmanned", "satellite", "space launch", "launch vehicle",
]

# Committee names matched against the latest-action text ONLY (a bill "Referred
# to the Committee on Armed Services" is kept even if its title has no keyword).
# Keep these HIGH-SIGNAL: broad committees like "Energy and Commerce" handle
# health/telecom too and would flood the feed, so they are deliberately excluded.
BILL_COMMITTEE_TERMS: list[str] = [
    "armed services",
    "strategic forces",
    "seapower",
]

# A bill is flagged "NEW" in the Bills tab if it was first seen within this many days.
NEW_BILL_WINDOW_DAYS = 7
