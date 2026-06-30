"""Policy Timeline panel (replaces Bill Movers).

A unified, chronological feed of priority BILLS (from the Congress.gov snapshot)
and government CONTRACTS (from the USASpending snapshot). Reads only from the
cache; the frontend renders it as a vertical timeline (newest at top).
"""
from __future__ import annotations

from fastapi import APIRouter

import config
import db

PANEL = {"id": "timeline", "title": "Policy Timeline", "order": 3}

router = APIRouter(prefix="/api/timeline", tags=["timeline"])

MAX_ITEMS = 80


@router.get("")
def get_timeline() -> dict:
    items: list[dict] = []

    for b in db.read_snapshot("congress"):
        items.append({
            "type": "bill",
            "date": b.get("latest_action_date") or "",
            "key": b.get("_key"),
            "identifier": b.get("identifier"),
            "title": b.get("title"),
            "stage": b.get("stage"),
            "chamber": b.get("chamber"),
            "category": b.get("category") or "",
            "latest_action_text": b.get("latest_action_text") or "",
            "url": b.get("url"),
        })

    for c in db.read_snapshot("usaspending"):  # USASpendingSource.name = "usaspending"
        items.append({
            "type": "contract",
            "date": c.get("date") or "",
            "key": c.get("_key"),
            "recipient": c.get("recipient"),
            "obligations": c.get("obligations"),
            "outlays": c.get("outlays"),
            "award_type": c.get("award_type"),
            "description": c.get("description"),
            "agency": c.get("agency"),
            "category": c.get("category") or "",
            "url": c.get("url"),
        })

    # Newest first -> the frontend draws this top-to-bottom (newest on top).
    items.sort(key=lambda x: x.get("date") or "", reverse=True)
    return {
        "items": items[:MAX_ITEMS],
        "total": len(items),
        "bills": sum(1 for x in items if x["type"] == "bill"),
        "contracts": sum(1 for x in items if x["type"] == "contract"),
        "configured": bool(config.CONGRESS_API_KEY),
    }
