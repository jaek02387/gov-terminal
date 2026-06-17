"""Shared interface every data source implements.

To add a new source: drop a file in ``sources/`` that defines a subclass of
``Source`` with a unique ``name`` and a ``fetch()`` method. It auto-registers on
import -- no other file needs to change.

Contract:
  * ``name``            -> unique short id, also the SQLite snapshot bucket.
  * ``enabled``         -> False keeps the source dormant (e.g. missing API key).
  * ``track_changes``   -> True diffs against the previous snapshot (bills).
  * ``change_fields``   -> which payload fields count as a "change".
  * ``fetch()``         -> returns ``[{"key": str, "data": dict}, ...]`` or raises.

Failures are isolated by the runner (``run()`` below): one source raising never
affects another. Each source logs under ``source.<name>``.
"""
from __future__ import annotations

import logging
import time
from abc import ABC, abstractmethod

import db

# Registry of concrete sources, populated automatically via __init_subclass__.
_REGISTRY: dict[str, type["Source"]] = {}


class Source(ABC):
    name: str = "unnamed"
    enabled: bool = True
    track_changes: bool = False
    change_fields: list[str] | None = None

    def __init_subclass__(cls, **kwargs):
        super().__init_subclass__(**kwargs)
        if cls.name and cls.name != "unnamed":
            _REGISTRY[cls.name] = cls

    def __init__(self):
        self.log = logging.getLogger(f"source.{self.name}")

    @abstractmethod
    def fetch(self) -> list[dict]:
        """Pull fresh data and return ``[{"key", "data"}, ...]``. May raise."""
        raise NotImplementedError

    def is_enabled(self) -> bool:
        return self.enabled

    def run(self) -> dict:
        """Fetch + store in isolation. Never raises; returns a status dict."""
        if not self.is_enabled():
            self.log.info("skipped (dormant / disabled)")
            return {"source": self.name, "status": "skipped", "count": 0}

        started = time.monotonic()
        try:
            records = self.fetch()
        except Exception as exc:  # isolation boundary -- one source can't break others
            self.log.exception("fetch failed: %s", exc)
            return {"source": self.name, "status": "error", "error": str(exc), "count": 0}

        try:
            changes = db.store_snapshot(
                self.name,
                records,
                track_changes=self.track_changes,
                change_fields=self.change_fields,
            )
        except Exception as exc:
            self.log.exception("store failed: %s", exc)
            return {"source": self.name, "status": "error", "error": str(exc), "count": 0}

        elapsed = time.monotonic() - started
        self.log.info(
            "ok: %d item(s), %d change(s) in %.2fs",
            len(records),
            len(changes),
            elapsed,
        )
        return {
            "source": self.name,
            "status": "ok",
            "count": len(records),
            "changes": len(changes),
            "elapsed": round(elapsed, 2),
        }


def registered_sources() -> dict[str, type[Source]]:
    return dict(_REGISTRY)
