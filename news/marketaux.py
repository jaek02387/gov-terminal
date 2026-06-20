"""Marketaux stock-news provider. Dormant without a key.

Supports an optional source-domain filter (config.MARKETAUX_DOMAINS) so you can
restrict to AP/Reuters for maximum neutrality. NOTE: the free tier returns only
~3 articles per request, so this sits below Finnhub in the chain.
"""
from __future__ import annotations

import config
from news.base import NewsProvider

API_URL = "https://api.marketaux.com/v1/news/all"


class MarketauxNews(NewsProvider):
    name = "marketaux"
    enabled = bool(config.MARKETAUX_API_KEY)
    priority = 20

    def fetch(self, ticker: str, limit: int = 12) -> list[dict]:
        import requests

        if not config.MARKETAUX_API_KEY:
            return []
        params = {
            "symbols": ticker,
            "filter_entities": "true",
            "language": "en",
            "api_token": config.MARKETAUX_API_KEY,
        }
        if config.MARKETAUX_DOMAINS:
            params["domains"] = config.MARKETAUX_DOMAINS
        resp = requests.get(API_URL, params=params, timeout=12)
        resp.raise_for_status()

        items: list[dict] = []
        for it in resp.json().get("data", []):
            title = it.get("title") or ""
            if not title:
                continue
            items.append({
                "title": title,
                "publisher": it.get("source") or "Marketaux",
                "url": it.get("url") or "",
                "published": it.get("published_at") or "",
                "summary": it.get("snippet") or it.get("description") or "",
            })
            if len(items) >= limit:
                break
        return items
