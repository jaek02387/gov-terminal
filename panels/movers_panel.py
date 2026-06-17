"""Bill movers panel.

Surfaces bills whose legislative STAGE changed between snapshots (introduced ->
committee -> floor -> passed -> law), computed by db's change-detection. Brand-new
bills (change_type 'new') are NOT movers -- only real transitions ('changed').
"""
from __future__ import annotations

from fastapi import APIRouter

import db

PANEL = {"id": "movers", "title": "Bill Movers — Status Changes", "order": 3}

router = APIRouter(prefix="/api/movers", tags=["movers"])

MAX_ROWS = 50


@router.get("")
def get_movers() -> dict:
    raw = db.read_changes("congress", limit=200) + db.read_changes("legiscan", limit=200)

    movers = []
    for ch in raw:
        if ch.get("change_type") != "changed":
            continue
        old, new = ch.get("old") or {}, ch.get("new") or {}
        movers.append(
            {
                "identifier": new.get("identifier") or old.get("identifier") or ch["key"],
                "title": new.get("title") or old.get("title") or "",
                "from_stage": old.get("stage") or "?",
                "to_stage": new.get("stage") or "?",
                "url": new.get("url") or old.get("url") or "",
                "latest_action_text": new.get("latest_action_text") or "",
                "detected_at": ch.get("detected_at"),
            }
        )

    movers.sort(key=lambda m: m.get("detected_at") or "", reverse=True)
    return {"movers": movers[:MAX_ROWS], "total": len(movers)}
