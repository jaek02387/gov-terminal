"""Bills feed panel.

Reads ONLY from the SQLite snapshot. Prefers the Congress.gov bucket and falls
back to LegiScan only if the primary is empty -- so the panel is agnostic to
which source produced the data.
"""
from __future__ import annotations

from fastapi import APIRouter

import config
import db

PANEL = {"id": "bills", "title": "Bills — Federal Priorities", "order": 2}

router = APIRouter(prefix="/api/bills", tags=["bills"])

MAX_ROWS = 100


def _active_bills() -> tuple[list[dict], str]:
    """Congress.gov first, LegiScan as fallback. Returns (bills, source_name)."""
    primary = db.read_snapshot("congress")
    if primary:
        return primary, "Congress.gov"
    fallback = db.read_snapshot("legiscan")
    if fallback:
        return fallback, "LegiScan"
    return [], ""


@router.get("")
def get_bills() -> dict:
    rows, source = _active_bills()
    # Most-recent action first; missing dates sort last.
    rows.sort(key=lambda b: b.get("latest_action_date") or "", reverse=True)
    watched = db.watched_keys()
    for b in rows:
        b["key"] = b.get("_key")
        b["watched"] = b.get("_key") in watched
    return {
        "bills": rows[:MAX_ROWS],
        "total": len(rows),
        "source": source,
        "configured": bool(config.CONGRESS_API_KEY) or bool(config.LEGISCAN_API_KEY),
        "last_refresh": db.get_meta("last_refresh:congress")
        or db.get_meta("last_refresh:legiscan"),
    }
