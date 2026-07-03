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


# Map a tracked ticker to lowercased name fragments of its company, so a
# USASpending contract recipient (e.g. "LOCKHEED MARTIN CORPORATION") can be
# linked to the stock (LMT) and marked on its chart. Edit as you add tickers.
COMPANY_ALIASES: dict[str, list[str]] = {
    "LMT": ["lockheed martin"], "RTX": ["rtx", "raytheon"], "NOC": ["northrop grumman"],
    "GD": ["general dynamics"], "HII": ["huntington ingalls"], "CEG": ["constellation energy"],
    "VST": ["vistra"], "CCJ": ["cameco"], "OKLO": ["oklo"], "SMR": ["nuscale"],
    "MP": ["mp materials"], "UUUU": ["energy fuels"], "ALB": ["albemarle"],
    "NVDA": ["nvidia"], "MSFT": ["microsoft"], "AMZN": ["amazon"],
    "GOOGL": ["alphabet", "google"], "VRT": ["vertiv"], "XOM": ["exxon"],
    "CVX": ["chevron"], "LNG": ["cheniere"], "EQT": ["eqt"], "LLY": ["eli lilly"],
    "PFE": ["pfizer"], "AVAV": ["aerovironment"], "KTOS": ["kratos"], "RKLB": ["rocket lab"],
}


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

# Bill keywords GROUPED BY the same 8 priorities as the stocks (keys match
# STOCK_CATEGORIES exactly). One source of truth: used to FILTER bills (title)
# and to CLASSIFY each bill into a priority -> which drives the timeline's policy
# label and the "related stocks" shown in the bill detail. Matched as whole words.
BILL_PRIORITY_KEYWORDS: dict[str, list[str]] = {
    "1. Defense & Nuclear Modernization": [
        "defense", "defense industrial", "national security", "armed forces",
        "missile", "hypersonic", "munitions", "warfighter",
    ],
    "2. Nuclear Power / Reactor Buildout": [
        "nuclear", "reactor", "uranium", "enrichment", "small modular reactor",
    ],
    "3. Critical Minerals & Domestic Supply Chains": [
        # NOTE: generic terms like "supply chain"/"domestic manufacturing" are
        # intentionally excluded -- they cross-cut priorities (e.g. "semiconductor
        # supply chain") and would mis-classify into this bucket.
        "critical mineral", "critical minerals", "rare earth", "mining", "battery",
    ],
    "4. AI Infrastructure & Data Centers": [
        "semiconductor", "chip", "artificial intelligence", "machine learning",
        "data center", "quantum",
    ],
    "5. Energy Dominance": [
        "energy", "natural gas", "liquefied natural gas", "pipeline", "grid",
        "electricity", "petroleum", "drilling",
    ],
    "6. Domestic Pharmaceutical Manufacturing": [
        "pharmaceutical", "drug manufacturing", "active pharmaceutical ingredient",
    ],
    "7. Shipbuilding & Maritime": [
        "shipbuilding", "shipyard", "naval", "submarine", "maritime",
    ],
    "8. Drones & Space": [
        "drone", "unmanned", "satellite", "space launch", "launch vehicle",
    ],
}

# Flattened union of all priority keywords (whole-word title filter + USASpending).
BILL_SEARCH_TERMS: list[str] = [
    kw for kws in BILL_PRIORITY_KEYWORDS.values() for kw in kws
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
# Committee-matched bills (no title keyword) are classified to this priority.
BILL_COMMITTEE_CATEGORY = "1. Defense & Nuclear Modernization"

# Curated, high-signal priority keywords for the USASpending contract search.
# (The full BILL_SEARCH_TERMS list is too broad for USASpending's keyword OR
# search -- it 503s -- so this is a distinctive subset across the priorities.)
CONTRACT_KEYWORDS: list[str] = [
    "defense", "nuclear", "uranium", "semiconductor", "rare earth",
    "critical minerals", "shipbuilding", "submarine", "missile", "drone",
    "satellite", "pharmaceutical",
]

# A bill is flagged "NEW" in the Bills tab if it was first seen within this many days.
NEW_BILL_WINDOW_DAYS = 7
