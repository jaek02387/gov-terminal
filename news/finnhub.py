"""Finnhub stock-news provider (company-news endpoint). Dormant without a key.

Reputable financial sources (Reuters, CNBC, MarketWatch, ...) and a generous
free tier, so it is the highest-priority provider when its key is set.
"""
from __future__ import annotations

from datetime import date, datetime, timedelta, timezone

import config
from news.base import NewsProvider

API_URL = "https://finnhub.io/api/v1/company-news"


class FinnhubNews(NewsProvider):
    name = "finnhub"
    enabled = bool(config.FINNHUB_API_KEY)
    priority = 10  # preferred when available

    def fetch(self, ticker: str, limit: int = 12) -> list[dict]:
        import requests

        if not config.FINNHUB_API_KEY:
            return []
        to = date.today()
        frm = to - timedelta(days=14)
        resp = requests.get(
            API_URL,
            params={
                "symbol": ticker,
                "from": frm.isoformat(),
                "to": to.isoformat(),
                "token": config.FINNHUB_API_KEY,
            },
            timeout=12,
        )
        resp.raise_for_status()

        items: list[dict] = []
        for it in resp.json():
            title = it.get("headline") or ""
            if not title:
                continue
            ts = it.get("datetime")
            published = (
                datetime.fromtimestamp(ts, tz=timezone.utc).isoformat() if ts else ""
            )
            items.append({
                "title": title,
                "publisher": it.get("source") or "Finnhub",
                "url": it.get("url") or "",
                "published": published,
                "summary": it.get("summary") or "",
            })
            if len(items) >= limit:
                break
        return items
