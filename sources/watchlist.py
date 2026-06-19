"""Watchlist source — keeps the user's explicitly-watched bills current.

For each watched bill it reuses the Congress.gov feed snapshot when the bill is
already there (no extra API call), and fetches the rest individually by number
(so you can watch bills that aren't in the priority feed). Stage changes are
tracked so the Watchlist panel can highlight status movement.

Dormant when CONGRESS_API_KEY is not set.
"""
from __future__ import annotations

import time

import config
import db
from sources import congress
from sources.base import Source

MAX_WATCHED = 60  # safety cap on per-refresh individual fetches


class WatchlistSource(Source):
    name = "watchlist"
    enabled = bool(config.CONGRESS_API_KEY)
    track_changes = True
    change_fields = ["stage"]
    phase = 1  # run after the bill feed (phase 0) so it reuses a fresh snapshot

    def fetch(self) -> list[dict]:
        watched = db.list_watchlist()
        if not watched:
            return []

        # Reuse the priority-feed snapshot to avoid re-fetching bills we already have.
        feed = {b["_key"]: b for b in db.read_snapshot("congress")}

        records: list[dict] = []
        fetched = 0
        for w in watched[:MAX_WATCHED]:
            key = w["bill_key"]
            if key in feed:
                data = {k: v for k, v in feed[key].items() if not k.startswith("_")}
                records.append({"key": key, "data": data})
                continue
            # Not in the feed -> fetch the bill individually (per-bill isolation).
            try:
                rec = congress.fetch_bill(w["congress"], w["type"], w["number"])
            except Exception as exc:
                self.log.warning("watchlist fetch failed for %s: %s", key, exc)
                rec = None
            fetched += 1
            if rec is not None:
                records.append(rec)
            else:
                records.append({"key": key, "data": _placeholder(w)})
            time.sleep(0.1)  # be polite to the API

        self.log.info(
            "watchlist: %d watched, %d fetched individually", len(watched), fetched
        )
        return records


def _placeholder(w: dict) -> dict:
    """Minimal record for a watched bill we couldn't resolve (e.g. bad number)."""
    btype = (w.get("type") or "").lower()
    number = w.get("number") or ""
    return {
        "title": "(could not load bill)",
        "congress": w.get("congress") or "",
        "type": btype.upper(),
        "number": number,
        "identifier": f"{btype.upper()} {number}".strip(),
        "stage": "Unknown",
        "latest_action_text": "",
        "latest_action_date": "",
        "chamber": "",
        "update_date": "",
        "url": "",
        "source": "Congress.gov",
    }
