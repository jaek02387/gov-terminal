"""SQLite cache layer.

Design goals:
  * The UI ALWAYS reads from here, never from a live API -> instant, never blocks.
  * Generic key/value snapshot store so any new source just writes JSON rows
    under its own name -- no schema changes needed to add a source.
  * Built-in change detection (diffing new vs. previous snapshot) powers the
    "top movers" panel for bills.
"""
from __future__ import annotations

import json
import logging
import sqlite3
import threading
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone

import config

log = logging.getLogger("db")

# A single process-wide lock keeps concurrent writes (scheduler + requests) safe.
_lock = threading.Lock()


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


@contextmanager
def get_conn():
    """Open a connection, commit on success, roll back on error, ALWAYS close.

    Used as ``with get_conn() as c:``. Closing every connection avoids leaking
    file handles (sqlite's own ``with conn`` context only commits, never closes).
    """
    conn = sqlite3.connect(config.DB_PATH, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    try:
        yield conn
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


def init_db() -> None:
    """Create tables if they do not exist. Safe to call repeatedly."""
    with _lock, get_conn() as c:
        c.executescript(
            """
            CREATE TABLE IF NOT EXISTS snapshots (
                source     TEXT NOT NULL,
                item_key   TEXT NOT NULL,
                payload    TEXT NOT NULL,
                fetched_at TEXT NOT NULL,
                PRIMARY KEY (source, item_key)
            );

            CREATE TABLE IF NOT EXISTS changes (
                id          INTEGER PRIMARY KEY AUTOINCREMENT,
                source      TEXT NOT NULL,
                item_key    TEXT NOT NULL,
                change_type TEXT NOT NULL,   -- 'new' | 'changed'
                old_payload TEXT,
                new_payload TEXT,
                detected_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS meta (
                key   TEXT PRIMARY KEY,
                value TEXT
            );

            -- Tickers the user added at runtime, with their auto-sorted category.
            CREATE TABLE IF NOT EXISTS user_tickers (
                ticker   TEXT PRIMARY KEY,
                category TEXT NOT NULL,
                added_at TEXT NOT NULL
            );

            -- Built-in (config) tickers the user removed from the interface.
            CREATE TABLE IF NOT EXISTS hidden_tickers (
                ticker     TEXT PRIMARY KEY,
                hidden_at  TEXT NOT NULL
            );

            -- Static company-name cache (names rarely change -> resolve once).
            CREATE TABLE IF NOT EXISTS ticker_names (
                ticker TEXT PRIMARY KEY,
                name   TEXT NOT NULL
            );

            -- Bills the user is explicitly watching (key = "congress-type-number").
            CREATE TABLE IF NOT EXISTS watchlist (
                bill_key TEXT PRIMARY KEY,
                congress TEXT,
                type     TEXT,
                number   TEXT,
                added_at TEXT NOT NULL
            );
            """
        )
    log.info("database initialised at %s", config.DB_PATH)


# ---------------------------------------------------------------------------
# Snapshot read / write
# ---------------------------------------------------------------------------
def read_snapshot(source: str) -> list[dict]:
    """Return every stored item for a source as dicts (payload + fetched_at)."""
    with get_conn() as c:
        rows = c.execute(
            "SELECT item_key, payload, fetched_at FROM snapshots WHERE source=?",
            (source,),
        ).fetchall()
    out: list[dict] = []
    for r in rows:
        data = json.loads(r["payload"])
        data["_key"] = r["item_key"]
        data["_fetched_at"] = r["fetched_at"]
        out.append(data)
    return out


def read_item(source: str, item_key: str) -> dict | None:
    with get_conn() as c:
        r = c.execute(
            "SELECT payload, fetched_at FROM snapshots WHERE source=? AND item_key=?",
            (source, item_key),
        ).fetchone()
    if not r:
        return None
    data = json.loads(r["payload"])
    data["_key"] = item_key
    data["_fetched_at"] = r["fetched_at"]
    return data


def store_snapshot(
    source: str,
    records: list[dict],
    *,
    track_changes: bool = False,
    change_fields: list[str] | None = None,
) -> list[dict]:
    """Upsert a fresh set of records for a source.

    Each record must be ``{"key": <unique str>, "data": <json-able dict>}``.

    If ``track_changes`` is True, the previous snapshot is diffed against the new
    one and any new/changed items are written to the ``changes`` table and
    returned (this powers the bill "movers" panel). ``change_fields`` limits the
    comparison to specific keys (e.g. ['status']) so noise is ignored.
    """
    fetched_at = _now()
    detected: list[dict] = []

    with _lock, get_conn() as c:
        old_rows = {
            r["item_key"]: json.loads(r["payload"])
            for r in c.execute(
                "SELECT item_key, payload FROM snapshots WHERE source=?", (source,)
            ).fetchall()
        }

        for rec in records:
            key = str(rec["key"])
            new_data = rec["data"]

            if track_changes:
                old_data = old_rows.get(key)
                change_type = None
                if old_data is None:
                    change_type = "new"
                elif _differs(old_data, new_data, change_fields):
                    change_type = "changed"
                if change_type:
                    c.execute(
                        "INSERT INTO changes(source,item_key,change_type,old_payload,"
                        "new_payload,detected_at) VALUES (?,?,?,?,?,?)",
                        (
                            source,
                            key,
                            change_type,
                            json.dumps(old_data) if old_data is not None else None,
                            json.dumps(new_data),
                            fetched_at,
                        ),
                    )
                    detected.append(
                        {"key": key, "change_type": change_type, "data": new_data}
                    )

            c.execute(
                "INSERT INTO snapshots(source,item_key,payload,fetched_at) "
                "VALUES (?,?,?,?) ON CONFLICT(source,item_key) DO UPDATE SET "
                "payload=excluded.payload, fetched_at=excluded.fetched_at",
                (source, key, json.dumps(new_data), fetched_at),
            )

        set_meta(f"last_refresh:{source}", fetched_at, conn=c)

    if track_changes and detected:
        log.info("%s: detected %d change(s)", source, len(detected))
    return detected


def _differs(old: dict, new: dict, fields: list[str] | None) -> bool:
    if fields:
        return any(old.get(f) != new.get(f) for f in fields)
    return old != new


def delete_snapshot_item(source: str, item_key: str) -> None:
    with _lock, get_conn() as c:
        c.execute(
            "DELETE FROM snapshots WHERE source=? AND item_key=?", (source, item_key)
        )


def delete_changes(source: str, item_key: str) -> None:
    """Drop a single item's change history (e.g. when un-watching a bill)."""
    with _lock, get_conn() as c:
        c.execute(
            "DELETE FROM changes WHERE source=? AND item_key=?", (source, item_key)
        )


# ---------------------------------------------------------------------------
# User-added tickers + hidden built-in tickers (interface customisation)
# ---------------------------------------------------------------------------
def add_user_ticker(ticker: str, category: str) -> None:
    with _lock, get_conn() as c:
        c.execute(
            "INSERT INTO user_tickers(ticker,category,added_at) VALUES (?,?,?) "
            "ON CONFLICT(ticker) DO UPDATE SET category=excluded.category",
            (ticker, category, _now()),
        )


def remove_user_ticker(ticker: str) -> None:
    with _lock, get_conn() as c:
        c.execute("DELETE FROM user_tickers WHERE ticker=?", (ticker,))


def list_user_tickers() -> dict[str, str]:
    with get_conn() as c:
        rows = c.execute("SELECT ticker, category FROM user_tickers").fetchall()
    return {r["ticker"]: r["category"] for r in rows}


def is_user_ticker(ticker: str) -> bool:
    with get_conn() as c:
        return (
            c.execute(
                "SELECT 1 FROM user_tickers WHERE ticker=?", (ticker,)
            ).fetchone()
            is not None
        )


def hide_ticker(ticker: str) -> None:
    with _lock, get_conn() as c:
        c.execute(
            "INSERT OR IGNORE INTO hidden_tickers(ticker,hidden_at) VALUES (?,?)",
            (ticker, _now()),
        )


def unhide_ticker(ticker: str) -> None:
    with _lock, get_conn() as c:
        c.execute("DELETE FROM hidden_tickers WHERE ticker=?", (ticker,))


def list_hidden() -> list[str]:
    with get_conn() as c:
        return [r["ticker"] for r in c.execute("SELECT ticker FROM hidden_tickers")]


def is_hidden(ticker: str) -> bool:
    with get_conn() as c:
        return (
            c.execute(
                "SELECT 1 FROM hidden_tickers WHERE ticker=?", (ticker,)
            ).fetchone()
            is not None
        )


def set_name(ticker: str, name: str) -> None:
    if not name:
        return
    with _lock, get_conn() as c:
        c.execute(
            "INSERT INTO ticker_names(ticker,name) VALUES (?,?) "
            "ON CONFLICT(ticker) DO UPDATE SET name=excluded.name",
            (ticker, name),
        )


def get_names() -> dict[str, str]:
    with get_conn() as c:
        return {r["ticker"]: r["name"] for r in c.execute("SELECT ticker,name FROM ticker_names")}


# ---------------------------------------------------------------------------
# Watchlist (specific bills the user tracks)
# ---------------------------------------------------------------------------
def add_watchlist(bill_key: str, congress, btype: str, number: str) -> None:
    with _lock, get_conn() as c:
        c.execute(
            "INSERT INTO watchlist(bill_key,congress,type,number,added_at) "
            "VALUES (?,?,?,?,?) ON CONFLICT(bill_key) DO NOTHING",
            (bill_key, str(congress), btype, str(number), _now()),
        )


def remove_watchlist(bill_key: str) -> None:
    with _lock, get_conn() as c:
        c.execute("DELETE FROM watchlist WHERE bill_key=?", (bill_key,))


def list_watchlist() -> list[dict]:
    with get_conn() as c:
        rows = c.execute(
            "SELECT bill_key, congress, type, number, added_at FROM watchlist"
        ).fetchall()
    return [dict(r) for r in rows]


def watched_keys() -> set[str]:
    with get_conn() as c:
        return {r["bill_key"] for r in c.execute("SELECT bill_key FROM watchlist")}


def is_watched(bill_key: str) -> bool:
    with get_conn() as c:
        return (
            c.execute("SELECT 1 FROM watchlist WHERE bill_key=?", (bill_key,)).fetchone()
            is not None
        )


def read_changes(source: str, limit: int = 100) -> list[dict]:
    with get_conn() as c:
        rows = c.execute(
            "SELECT * FROM changes WHERE source=? ORDER BY detected_at DESC LIMIT ?",
            (source, limit),
        ).fetchall()
    out = []
    for r in rows:
        out.append(
            {
                "source": r["source"],
                "key": r["item_key"],
                "change_type": r["change_type"],
                "old": json.loads(r["old_payload"]) if r["old_payload"] else None,
                "new": json.loads(r["new_payload"]) if r["new_payload"] else None,
                "detected_at": r["detected_at"],
            }
        )
    return out


# ---------------------------------------------------------------------------
# Meta (refresh timestamps etc.)
# ---------------------------------------------------------------------------
def set_meta(key: str, value: str, conn: sqlite3.Connection | None = None) -> None:
    def _do(c):
        c.execute(
            "INSERT INTO meta(key,value) VALUES (?,?) "
            "ON CONFLICT(key) DO UPDATE SET value=excluded.value",
            (key, value),
        )

    if conn is not None:
        _do(conn)
    else:
        with _lock, get_conn() as c:
            _do(c)


def get_meta(key: str, default: str | None = None) -> str | None:
    with get_conn() as c:
        r = c.execute("SELECT value FROM meta WHERE key=?", (key,)).fetchone()
    return r["value"] if r else default


def has_any_data() -> bool:
    """True if the cache already holds at least one snapshot row."""
    with get_conn() as c:
        r = c.execute("SELECT 1 FROM snapshots LIMIT 1").fetchone()
    return r is not None


def refresh_status() -> dict:
    """Last/next refresh info for the UI indicator."""
    last = get_meta("last_refresh")
    next_ = get_meta("next_refresh")
    return {
        "last_refresh": last,
        "next_refresh": next_,
        "interval_minutes": config.REFRESH_INTERVAL_MINUTES,
    }


def mark_global_refresh() -> None:
    now = datetime.now(timezone.utc)
    nxt = now + timedelta(minutes=config.REFRESH_INTERVAL_MINUTES)
    set_meta("last_refresh", now.isoformat())
    set_meta("next_refresh", nxt.isoformat())
