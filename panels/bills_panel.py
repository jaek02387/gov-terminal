"""Bills feed panel.

Reads ONLY from the SQLite snapshot. Prefers the Congress.gov bucket and falls
back to LegiScan only if the primary is empty -- so the panel is agnostic to
which source produced the data.
"""
from __future__ import annotations

from datetime import datetime, timezone

from fastapi import APIRouter, HTTPException

import config
import db
from sources import congress

PANEL = {"id": "bills", "title": "Bills — Federal Priorities", "order": 2}

router = APIRouter(prefix="/api/bills", tags=["bills"])

MAX_ROWS = 100
DETAIL_TTL_SECONDS = 6 * 3600  # re-use a cached detail for up to 6h


def _strip_meta(item: dict) -> dict:
    return {k: v for k, v in item.items() if not k.startswith("_")}


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


@router.get("/detail/{key}")
def bill_detail(key: str) -> dict:
    """Lazily fetch (and cache) a single bill's full detail. Called on click only."""
    parts = key.split("-")
    if len(parts) != 3:
        raise HTTPException(status_code=400, detail="Malformed bill key.")
    cong, btype, number = parts[0], parts[1].lower(), parts[2]
    if not (cong.isdigit() and number.isdigit() and btype.isalpha()):
        raise HTTPException(status_code=400, detail="Malformed bill key.")

    cached = db.read_item("detail", key)
    if cached:
        try:
            age = (
                datetime.now(timezone.utc)
                - datetime.fromisoformat(cached["_fetched_at"])
            ).total_seconds()
        except Exception:
            age = None
        if age is not None and age < DETAIL_TTL_SECONDS:
            return {"detail": _strip_meta(cached), "cached": True}

    try:
        detail = congress.fetch_detail(cong, btype, number)
    except Exception:
        if cached:  # API down but we have an older copy -> serve it
            return {"detail": _strip_meta(cached), "cached": True, "stale": True}
        raise HTTPException(
            status_code=503, detail="Couldn't reach Congress.gov right now — please try again."
        )
    if detail is None:
        raise HTTPException(status_code=404, detail=f"No bill found for '{key}'.")

    db.store_snapshot("detail", [{"key": key, "data": detail}])
    return {"detail": detail, "cached": False}
