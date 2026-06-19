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
from concurrent.futures import ThreadPoolExecutor

import bills
import config
from sources.base import Source

log = logging.getLogger("source.congress")

API_BASE = "https://api.congress.gov/v3/bill"
PAGE_SIZE = 250          # API max per request
MAX_PAGES = 4            # pages of recent current-congress bills to scan
REQUEST_TIMEOUT = 15     # seconds; fail fast instead of stalling the whole refresh


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


def _strip_html(s: str) -> str:
    return re.sub(r"<[^>]+>", "", s or "").strip()


def fetch_detail(congress, btype: str, number: str) -> dict | None:
    """Lazily fetch a single bill's FULL detail (sponsors, cosponsors, the action
    /committee timeline, recorded votes, text-version links, CRS summary).

    The main bill object is essential (None => 404, network error => raises). The
    sub-sections are best-effort and fetched in parallel, so a partial API outage
    still returns whatever succeeded. Only ever called on click -- never during
    the hourly refresh.
    """
    import requests

    if not config.CONGRESS_API_KEY:
        return None
    base = f"{API_BASE}/{congress}/{btype.lower()}/{number}"

    def get(path: str):
        r = requests.get(
            base + path,
            params={"api_key": config.CONGRESS_API_KEY, "format": "json", "limit": 250},
            timeout=REQUEST_TIMEOUT,
        )
        if path == "" and r.status_code == 404:
            return None
        r.raise_for_status()
        return r.json()

    with ThreadPoolExecutor(max_workers=5) as pool:
        f_bill = pool.submit(get, "")
        f_actions = pool.submit(get, "/actions")
        f_cos = pool.submit(get, "/cosponsors")
        f_text = pool.submit(get, "/text")
        f_sum = pool.submit(get, "/summaries")

        bill_json = f_bill.result()  # essential; raises on network error
        if bill_json is None:
            return None  # 404

        def safe(fut):
            try:
                return fut.result()
            except Exception as exc:
                log.warning("detail sub-section failed for %s: %s", base, exc)
                return None

        return _assemble_detail(
            congress, btype, number,
            bill_json.get("bill") or {},
            safe(f_actions), safe(f_cos), safe(f_text), safe(f_sum),
        )


def _assemble_detail(congress, btype, number, bill, actions_j, cos_j, text_j, sum_j) -> dict:
    sponsors = [
        {"name": s.get("fullName") or "", "party": s.get("party") or "", "state": s.get("state") or ""}
        for s in (bill.get("sponsors") or [])
    ]

    actions, votes = [], []
    for a in (actions_j or {}).get("actions", []) if actions_j else []:
        actions.append({"date": a.get("actionDate") or "", "text": a.get("text") or ""})
        for rv in a.get("recordedVotes") or []:
            votes.append({
                "chamber": rv.get("chamber") or "",
                "roll": rv.get("rollNumber") or "",
                "date": (rv.get("date") or a.get("actionDate") or "")[:10],
                "url": rv.get("url") or "",
                "action": a.get("text") or "",
            })

    cosponsors = [
        {"name": c.get("fullName") or "", "party": c.get("party") or "", "state": c.get("state") or ""}
        for c in (cos_j or {}).get("cosponsors", []) if cos_j
    ]
    cos_count = ((cos_j or {}).get("pagination") or {}).get("count") if cos_j else None

    text_versions = [
        {
            "type": t.get("type") or "Text",
            "date": t.get("date") or "",
            "formats": [{"type": f.get("type") or "", "url": f.get("url") or ""} for f in (t.get("formats") or [])],
        }
        for t in (text_j or {}).get("textVersions", []) if text_j
    ]

    summary = ""
    summaries = (sum_j or {}).get("summaries", []) if sum_j else []
    if summaries:
        summary = _strip_html(summaries[-1].get("text") or "")

    la = bill.get("latestAction") or {}
    return {
        "identifier": bills.identifier(btype, number),
        "title": bill.get("title") or "(untitled)",
        "congress": congress, "type": btype.upper(), "number": str(number),
        "url": bills.website_url(congress, btype, number),
        "introduced_date": bill.get("introducedDate") or "",
        "policy_area": (bill.get("policyArea") or {}).get("name") or "",
        "origin_chamber": bill.get("originChamber") or "",
        "sponsors": sponsors,
        "cosponsor_count": cos_count if cos_count is not None else len(cosponsors),
        "cosponsors": cosponsors[:25],
        "latest_action": {"date": la.get("actionDate") or "", "text": la.get("text") or ""},
        "actions": actions,
        "votes": votes,
        "text_versions": text_versions,
        "summary": summary,
    }


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
        timeout=REQUEST_TIMEOUT,
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
        if not config.CONGRESS_API_KEY:
            self.log.info("no CONGRESS_API_KEY -> nothing to fetch")
            return []

        # Fetch all pages concurrently (the pages are independent). pool.map
        # re-raises on iteration, so a failed page fails the cycle as before --
        # but now in ~one request's time, not the sum of all four.
        with ThreadPoolExecutor(max_workers=MAX_PAGES) as pool:
            pages = list(pool.map(self._fetch_page, range(MAX_PAGES)))

        kept: dict[str, dict] = {}
        scanned = 0
        for page_bills in pages:
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

        self.log.info(
            "congress %s: scanned %d bills, kept %d matching priorities",
            config.CURRENT_CONGRESS, scanned, len(kept),
        )
        return list(kept.values())

    def _fetch_page(self, page: int) -> list[dict]:
        """Fetch one page of the current Congress's recent bills."""
        import requests

        resp = requests.get(
            f"{API_BASE}/{config.CURRENT_CONGRESS}",
            params={
                "api_key": config.CONGRESS_API_KEY,
                "format": "json",
                "sort": "updateDate+desc",
                "limit": PAGE_SIZE,
                "offset": page * PAGE_SIZE,
            },
            timeout=REQUEST_TIMEOUT,
        )
        resp.raise_for_status()
        return resp.json().get("bills", [])
