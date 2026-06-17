"""Congress.gov bill feed (PRIMARY bill source).

Pulls the most-recently-updated bills and keeps those whose title matches the
federal-priority search terms in config.py. Each bill's coarse STAGE is tracked
so the snapshot diff can surface status changes in the "movers" panel.

Dormant (skipped) when CONGRESS_API_KEY is not set -- the app still runs fine and
the bill panels show a "key needed" hint.
"""
from __future__ import annotations

import logging
import re

import bills
import config
from sources.base import Source

log = logging.getLogger("source.congress")

API_BASE = "https://api.congress.gov/v3/bill"
PAGE_SIZE = 250          # API max per request
MAX_PAGES = 4            # pages of recent current-congress bills to scan


def normalize_bill(raw: dict) -> dict | None:
    """Map a Congress.gov bill object (list item or single-bill response) to our
    canonical ``{"key", "data"}`` record. Returns None if essential fields are
    missing."""
    try:
        congress = raw.get("congress")
        btype = (raw.get("type") or "").lower()
        number = str(raw.get("number") or "").strip()
        if not (congress and btype and number):
            return None

        action = raw.get("latestAction") or {}
        action_text = action.get("text") or ""
        return {
            "key": f"{congress}-{btype}-{number}",
            "data": {
                "title": raw.get("title") or "(untitled)",
                "congress": congress,
                "type": btype.upper(),
                "number": number,
                "identifier": bills.identifier(btype, number),
                "stage": bills.derive_stage(action_text),
                "latest_action_text": action_text,
                "latest_action_date": action.get("actionDate") or "",
                "chamber": raw.get("originChamber") or "",
                "update_date": raw.get("updateDate") or "",
                "url": bills.website_url(congress, btype, number),
                "source": "Congress.gov",
            },
        }
    except Exception as exc:
        log.warning("could not normalize a bill: %s", exc)
        return None


def parse_identifier(text: str, default_congress=None) -> tuple | None:
    """Parse a free-form bill identifier into (congress, type, number).

    Accepts e.g. "HR 1215", "hr1215", "S.1346", "119 hr 1215". Defaults the
    congress to the current one when not given. Returns None if unparseable.
    """
    if not text:
        return None
    congress = default_congress if default_congress is not None else config.CURRENT_CONGRESS
    t = text.strip().lower().replace(".", "")  # drop dots: "H.R." -> "hr"
    # optional leading congress number (3 digits + space, e.g. "119 hr 1215")
    m = re.match(r"^(\d{3})\s+", t)
    if m:
        congress = int(m.group(1))
        t = t[m.end():]
    t = re.sub(r"\s+", "", t)  # collapse internal spaces: "h r" / "s j res" -> "hr"/"sjres"
    m = re.match(r"^([a-z]+)0*(\d+)$", t)
    if not m:
        return None
    btype, number = m.group(1), m.group(2)
    if btype not in {"hr", "s", "hjres", "sjres", "hconres", "sconres", "hres", "sres"}:
        return None
    return (congress, btype, number)


def fetch_bill(congress, btype: str, number: str) -> dict | None:
    """Fetch a single bill by congress/type/number. Returns a canonical record
    (``{"key","data"}``), or None only for a genuine 404 (bill doesn't exist).

    RAISES on network/HTTP errors so callers can distinguish "not found" from
    "couldn't reach the API". The watchlist source catches this per-bill; the add
    endpoint turns it into a "try again" message.
    """
    import requests

    if not config.CONGRESS_API_KEY:
        return None
    resp = requests.get(
        f"{API_BASE}/{congress}/{btype.lower()}/{number}",
        params={"api_key": config.CONGRESS_API_KEY, "format": "json"},
        timeout=30,
    )
    if resp.status_code == 404:
        return None
    resp.raise_for_status()
    raw = resp.json().get("bill")
    return normalize_bill(raw) if raw else None

# Whole-word matchers for the priority keywords (so "defense" won't match
# "self-defense" and ceremonial titles don't slip in).
_PATTERNS = [re.compile(r"\b" + re.escape(t.lower()) + r"\b") for t in config.BILL_SEARCH_TERMS]
_SUBSTANTIVE = set(config.SUBSTANTIVE_BILL_TYPES)


class CongressSource(Source):
    name = "congress"
    enabled = bool(config.CONGRESS_API_KEY)  # evaluated at startup (.env loaded)
    track_changes = True
    change_fields = ["stage"]  # a "mover" = a bill whose stage changed

    def fetch(self) -> list[dict]:
        import requests

        if not config.CONGRESS_API_KEY:
            self.log.info("no CONGRESS_API_KEY -> nothing to fetch")
            return []

        # Only the current Congress, so we don't surface decade-old bills whose
        # metadata was merely re-touched.
        url = f"{API_BASE}/{config.CURRENT_CONGRESS}"
        kept: dict[str, dict] = {}
        scanned = 0

        for page in range(MAX_PAGES):
            resp = requests.get(
                url,
                params={
                    "api_key": config.CONGRESS_API_KEY,
                    "format": "json",
                    "sort": "updateDate+desc",
                    "limit": PAGE_SIZE,
                    "offset": page * PAGE_SIZE,
                },
                timeout=20,
            )
            resp.raise_for_status()
            page_bills = resp.json().get("bills", [])
            scanned += len(page_bills)

            for raw in page_bills:
                if (raw.get("type") or "").lower() not in _SUBSTANTIVE:
                    continue  # skip ceremonial / procedural resolutions
                title = (raw.get("title") or "").lower()
                if not any(p.search(title) for p in _PATTERNS):
                    continue
                rec = normalize_bill(raw)
                if rec is not None:
                    kept[rec["key"]] = rec

            if len(page_bills) < PAGE_SIZE:
                break  # no more pages

        self.log.info(
            "congress %s: scanned %d bills, kept %d matching priorities",
            config.CURRENT_CONGRESS, scanned, len(kept),
        )
        return list(kept.values())
