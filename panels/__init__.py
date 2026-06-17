"""Panel package with auto-discovery.

To add a UI panel: drop a file in ``panels/`` that defines

    PANEL = {"id": "stocks", "title": "Stocks", "order": 1}
    router = APIRouter()   # FastAPI routes serving this panel's JSON

and a matching ``static/js/panels/<id>.js`` for the frontend. ``mount_panels()``
includes every router and ``panel_manifest()`` tells the frontend what to render
-- no existing file changes.
"""
from __future__ import annotations

import importlib
import logging
import pkgutil

log = logging.getLogger("panels")

_PANELS: list[dict] = []


def _iter_modules():
    for mod in pkgutil.iter_modules(__path__):
        if mod.name.startswith("_") or mod.name == "base":
            continue
        try:
            yield importlib.import_module(f"{__name__}.{mod.name}")
        except Exception as exc:  # a broken panel must not crash the others
            log.exception("could not import panel module '%s': %s", mod.name, exc)


def mount_panels(app) -> None:
    """Include every panel router on the FastAPI app and build the manifest."""
    global _PANELS
    _PANELS = []
    for module in _iter_modules():
        meta = getattr(module, "PANEL", None)
        router = getattr(module, "router", None)
        if router is not None:
            app.include_router(router)
        if meta:
            _PANELS.append(meta)
            log.info("mounted panel '%s'", meta.get("id"))
    _PANELS.sort(key=lambda p: p.get("order", 999))


def panel_manifest() -> list[dict]:
    return list(_PANELS)
