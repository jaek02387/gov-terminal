"""Source package with auto-discovery.

Importing this package imports every ``*.py`` module inside it (except private
ones), which triggers each ``Source`` subclass to self-register. ``discover()``
returns instantiated, registered sources so the scheduler can run them.
"""
from __future__ import annotations

import importlib
import logging
import pkgutil

from sources.base import Source, registered_sources

log = logging.getLogger("sources")


def _import_all() -> None:
    for mod in pkgutil.iter_modules(__path__):
        if mod.name.startswith("_") or mod.name == "base":
            continue
        try:
            importlib.import_module(f"{__name__}.{mod.name}")
        except Exception as exc:  # a broken source file must not crash discovery
            log.exception("could not import source module '%s': %s", mod.name, exc)


def discover() -> list[Source]:
    _import_all()
    instances: list[Source] = []
    for name, cls in registered_sources().items():
        try:
            instances.append(cls())
        except Exception as exc:
            log.exception("could not instantiate source '%s': %s", name, exc)
    return instances
