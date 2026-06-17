"""Congress.gov bill feed (PRIMARY bill source).

Pulls the most-recently-updated bills and keeps those whose title matches the
federal-priority search terms in config.py. Each bill's coarse STAGE is tracked
so the snapshot diff can surface status changes in the "movers" panel.

Dormant (skipped) when CONGRESS_API_KEY is not set -- the app still runs fine and
the bill panels show a "key needed" hint.
"""
from __future__ import annotations

import re

import bills
import config
from sources.base import Source

API_BASE = "https://api.congress.gov/v3/bill"
PAGE_SIZE = 250          # API max per request
MAX_PAGES = 4            # pages of recent current-congress bills to scan

# Whole-word matchers for the priority keywords (so "defense" won't match
# "self-defense" and ceremonial titles don't slip in).
_PATTERNS = [re.compile(r"\b" + re.escape(t.lower()) + r"\b") for t in config.BILL_SEARCH_TERMS]
_SUBSTANTIVE = set(config.SUBSTANTIVE_BILL_TYPES)


class CongressSource(Source):
    name = "congress"
    enabled = bool(config.CONGRESS_API_KEY)  # evaluated at startup (.env loaded)
    track_changes = True
    change_fields = ["stage"]  # a "mover" = a bill whose stage changed

    def fetch(self) -> list[dict]:
        import requests

        if not config.CONGRESS_API_KEY:
            self.log.info("no CONGRESS_API_KEY -> nothing to fetch")
            return []

        # Only the current Congress, so we don't surface decade-old bills whose
        # metadata was merely re-touched.
        url = f"{API_BASE}/{config.CURRENT_CONGRESS}"
        kept: dict[str, dict] = {}
        scanned = 0

        for page in range(MAX_PAGES):
            resp = requests.get(
                url,
                params={
                    "api_key": config.CONGRESS_API_KEY,
                    "format": "json",
                    "sort": "updateDate+desc",
                    "limit": PAGE_SIZE,
                    "offset": page * PAGE_SIZE,
                },
                timeout=20,
            )
            resp.raise_for_status()
            page_bills = resp.json().get("bills", [])
            scanned += len(page_bills)

            for raw in page_bills:
                if (raw.get("type") or "").lower() not in _SUBSTANTIVE:
                    continue  # skip ceremonial / procedural resolutions
                title = (raw.get("title") or "").lower()
                if not any(p.search(title) for p in _PATTERNS):
                    continue
                rec = self._normalize(raw)
                if rec is not None:
                    kept[rec["key"]] = rec

            if len(page_bills) < PAGE_SIZE:
                break  # no more pages

        self.log.info(
            "congress %s: scanned %d bills, kept %d matching priorities",
            config.CURRENT_CONGRESS, scanned, len(kept),
        )
        return list(kept.values())

    def _normalize(self, raw: dict) -> dict | None:
        try:
            congress = raw.get("congress")
            btype = (raw.get("type") or "").lower()
            number = str(raw.get("number") or "").strip()
            if not (congress and btype and number):
                return None

            action = raw.get("latestAction") or {}
            action_text = action.get("text") or ""
            return {
                "key": f"{congress}-{btype}-{number}",
                "data": {
                    "title": raw.get("title") or "(untitled)",
                    "congress": congress,
                    "type": btype.upper(),
                    "number": number,
                    "identifier": bills.identifier(btype, number),
                    "stage": bills.derive_stage(action_text),
                    "latest_action_text": action_text,
                    "latest_action_date": action.get("actionDate") or "",
                    "chamber": raw.get("originChamber") or "",
                    "update_date": raw.get("updateDate") or "",
                    "url": bills.website_url(congress, btype, number),
                    "source": "Congress.gov",
                },
            }
        except Exception as exc:
            self.log.warning("could not normalize a bill: %s", exc)
            return None
