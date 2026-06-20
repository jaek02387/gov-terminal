"""Default stock-news provider via yfinance (free, no key). Last in the chain --
used only when no keyed provider returns anything. Quality is inconsistent."""
from __future__ import annotations

from news.base import NewsProvider


class YahooNews(NewsProvider):
    name = "yfinance"
    enabled = True
    priority = 100  # last resort

    def fetch(self, ticker: str, limit: int = 12) -> list[dict]:
        import yfinance as yf

        raw = yf.Ticker(ticker).news or []
        items: list[dict] = []
        for it in raw[:limit]:
            c = it.get("content", it) if isinstance(it, dict) else {}
            title = c.get("title") or ""
            if not title:
                continue
            prov = c.get("provider")
            publisher = (prov.get("displayName") if isinstance(prov, dict) else None) or c.get("publisher") or "Yahoo Finance"
            url = ""
            for k in ("canonicalUrl", "clickThroughUrl"):
                u = c.get(k)
                if isinstance(u, dict) and u.get("url"):
                    url = u["url"]
                    break
            url = url or c.get("link") or ""
            items.append({
                "title": title,
                "publisher": publisher,
                "url": url,
                "published": c.get("pubDate") or c.get("displayTime") or "",
                "summary": c.get("summary") or "",
            })
        return items
