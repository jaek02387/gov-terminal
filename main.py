"""FastAPI app + background scheduler wiring.

Responsibilities (kept thin on purpose):
  * initialise the SQLite cache
  * auto-discover sources and panels
  * run an hourly background refresh that writes to SQLite
  * do an immediate first fetch when the cache is empty
  * serve the static frontend + a couple of app-level endpoints

All UI reads come from SQLite via the panel routers, so the UI never blocks on a
live API call.
"""
from __future__ import annotations

import logging
from concurrent.futures import ThreadPoolExecutor
from contextlib import asynccontextmanager

from apscheduler.schedulers.background import BackgroundScheduler
from fastapi import FastAPI
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

import config
import db
import panels
import sources

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s  %(levelname)-7s  %(name)s  %(message)s",
)
log = logging.getLogger("main")

scheduler = BackgroundScheduler()


def refresh_all() -> list[dict]:
    """Run every source once, in isolation, then stamp the global refresh time.

    Sources are grouped by ``phase``: those in the same phase run concurrently
    (the slow part is network I/O), and phases run in order so a later source can
    depend on an earlier one's fresh snapshot. SQLite writes serialise behind the
    db lock, so concurrency is safe.
    """
    log.info("=== refresh cycle starting ===")
    phases: dict[int, list] = {}
    for src in sources.discover():
        phases.setdefault(getattr(src, "phase", 0), []).append(src)

    results: list[dict] = []
    for phase in sorted(phases):
        group = phases[phase]
        if len(group) == 1:
            results.append(group[0].run())
        else:
            with ThreadPoolExecutor(max_workers=len(group)) as pool:
                results.extend(pool.map(lambda s: s.run(), group))

    db.mark_global_refresh()
    ok = sum(1 for r in results if r["status"] == "ok")
    log.info("=== refresh cycle done: %d/%d ok ===", ok, len(results))
    return results


@asynccontextmanager
async def lifespan(app: FastAPI):
    db.init_db()

    # Immediate first fetch if the cache is empty, so data shows up right away.
    if not db.has_any_data():
        log.info("cache empty -> running initial fetch now")
        scheduler.add_job(refresh_all, id="initial", misfire_grace_time=None)

    scheduler.add_job(
        refresh_all,
        "interval",
        minutes=config.REFRESH_INTERVAL_MINUTES,
        id="hourly",
        next_run_time=None,
    )
    scheduler.start()

    # Keep the UI "next refresh" indicator honest after a restart (when no
    # immediate refresh runs) by stamping the hourly job's real next run time.
    job = scheduler.get_job("hourly")
    if job and job.next_run_time:
        db.set_meta("next_refresh", job.next_run_time.isoformat())

    log.info("scheduler started (every %d min)", config.REFRESH_INTERVAL_MINUTES)
    yield
    scheduler.shutdown(wait=False)


app = FastAPI(title="Gov Policy Terminal", lifespan=lifespan)

# Auto-mount every panel router.
panels.mount_panels(app)


@app.get("/api/meta")
def meta() -> dict:
    return {
        "refresh": db.refresh_status(),
        "panels": panels.panel_manifest(),
        "sources": [
            {"name": s.name, "enabled": s.is_enabled()} for s in sources.discover()
        ],
    }


@app.post("/api/refresh")
def manual_refresh() -> JSONResponse:
    """Trigger an out-of-band refresh (also handy from the README troubleshooting)."""
    results = refresh_all()
    return JSONResponse({"ok": True, "results": results})


@app.get("/")
def index() -> FileResponse:
    return FileResponse(config.STATIC_DIR / "index.html")


# Static assets (css/js). Mounted last so it doesn't shadow the API routes.
app.mount("/static", StaticFiles(directory=config.STATIC_DIR), name="static")
