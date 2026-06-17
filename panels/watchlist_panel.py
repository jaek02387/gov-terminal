"""Watchlist panel API.

Lists the bills the user explicitly watches, with their current stage and a
highlight when that stage changed (from the watchlist snapshot diff). Reads from
the cache for display; add/remove mutate the watchlist and fetch the bill's data
immediately so it appears without waiting for the hourly refresh.
"""
from __future__ import annotations

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

import config
import db
from sources import congress

PANEL = {"id": "watchlist", "title": "Watchlist — Tracked Bills", "order": 4}

router = APIRouter(prefix="/api/watchlist", tags=["watchlist"])


class AddRequest(BaseModel):
    key: str | None = None         # e.g. "119-hr-1215" (from a feed star)
    identifier: str | None = None  # e.g. "HR 1215" (typed by the user)


def _latest_changes() -> dict[str, dict]:
    """Map bill_key -> its most recent stage change (for highlighting)."""
    out: dict[str, dict] = {}
    for ch in db.read_changes("watchlist", limit=500):
        if ch.get("change_type") != "changed":
            continue
        if ch["key"] not in out:  # read_changes is newest-first
            out[ch["key"]] = {
                "from": (ch.get("old") or {}).get("stage"),
                "to": (ch.get("new") or {}).get("stage"),
                "at": ch.get("detected_at"),
            }
    return out


def _resolve(key: str, wl_snap: dict, feed_snap: dict, watched_row: dict) -> dict:
    if key in wl_snap:
        return wl_snap[key]
    if key in feed_snap:
        return feed_snap[key]
    btype = (watched_row.get("type") or "").lower()
    number = watched_row.get("number") or ""
    return {
        "identifier": f"{btype.upper()} {number}".strip(),
        "title": "(loading on next refresh…)",
        "stage": "Unknown",
        "latest_action_date": "",
        "latest_action_text": "",
        "url": "",
    }


@router.get("")
def get_watchlist() -> dict:
    watched = db.list_watchlist()
    wl_snap = {b["_key"]: b for b in db.read_snapshot("watchlist")}
    feed_snap = {b["_key"]: b for b in db.read_snapshot("congress")}
    changes = _latest_changes()

    rows = []
    for w in watched:
        key = w["bill_key"]
        data = dict(_resolve(key, wl_snap, feed_snap, w))
        data["key"] = key
        data["changed"] = changes.get(key)  # None or {from,to,at}
        rows.append(data)

    rows.sort(key=lambda b: b.get("latest_action_date") or "", reverse=True)
    return {
        "bills": rows,
        "total": len(rows),
        "configured": bool(config.CONGRESS_API_KEY),
    }


def _key_parts(key: str):
    parts = key.split("-")
    if len(parts) != 3:
        return None
    return parts[0], parts[1].lower(), parts[2]


@router.post("/add")
def add_watch(req: AddRequest) -> dict:
    # Resolve to (congress, type, number, key) from either a key or an identifier.
    if req.key:
        parts = _key_parts(req.key.strip())
        if not parts:
            raise HTTPException(status_code=400, detail="Malformed bill key.")
        cong, btype, number = parts
    elif req.identifier:
        parsed = congress.parse_identifier(req.identifier)
        if not parsed:
            raise HTTPException(
                status_code=400, detail=f"Could not parse '{req.identifier}'. Try e.g. 'HR 1215'."
            )
        cong, btype, number = parsed
    else:
        raise HTTPException(status_code=400, detail="Provide a bill key or identifier.")

    key = f"{cong}-{btype}-{number}"

    if db.is_watched(key):
        return {"status": "exists", "key": key}

    # Validate: reuse the feed if present, else fetch the single bill.
    feed = {b["_key"]: b for b in db.read_snapshot("congress")}
    if key in feed:
        rec_data = {k: v for k, v in feed[key].items() if not k.startswith("_")}
    else:
        try:
            rec = congress.fetch_bill(cong, btype, number)
        except Exception:
            raise HTTPException(
                status_code=503,
                detail="Couldn't reach Congress.gov right now — please try again.",
            )
        if rec is None:
            raise HTTPException(
                status_code=404, detail=f"No bill found for '{btype.upper()} {number}'."
            )
        rec_data = rec["data"]

    db.add_watchlist(key, cong, btype, number)
    db.store_snapshot("watchlist", [{"key": key, "data": rec_data}])  # show immediately
    return {"status": "added", "key": key, "identifier": rec_data.get("identifier")}


@router.delete("/{key}")
def remove_watch(key: str) -> dict:
    key = key.strip()
    if not db.is_watched(key):
        raise HTTPException(status_code=404, detail=f"'{key}' is not on the watchlist.")
    db.remove_watchlist(key)
    db.delete_snapshot_item("watchlist", key)
    db.delete_changes("watchlist", key)  # don't resurrect a stale highlight on re-add
    return {"status": "removed", "key": key}
