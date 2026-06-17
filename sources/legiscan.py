"""LegiScan bill feed (FALLBACK source).

Dormant until LEGISCAN_API_KEY is set. It emits the SAME canonical record shape
as the Congress.gov source, so the bill panels are source-agnostic: they prefer
Congress.gov and fall back to whatever this writes only if the primary is empty.

NOTE: this path is untested live (no key on hand). It follows LegiScan's
documented getSearch schema and fails gracefully in isolation like every source.
"""
from __future__ import annotations

import bills
import config
from sources.base import Source

API_URL = "https://api.legiscan.com/"


class LegiScanSource(Source):
    name = "legiscan"
    enabled = bool(config.LEGISCAN_API_KEY)  # stays dormant while key is blank
    track_changes = True
    change_fields = ["stage"]

    def fetch(self) -> list[dict]:
        import requests

        if not config.LEGISCAN_API_KEY:
            return []

        kept: dict[str, dict] = {}
        for term in config.BILL_SEARCH_TERMS:
            resp = requests.get(
                API_URL,
                params={
                    "key": config.LEGISCAN_API_KEY,
                    "op": "getSearch",
                    "state": "US",  # US = federal Congress
                    "query": term,
                },
                timeout=20,
            )
            resp.raise_for_status()
            payload = resp.json()
            results = (payload.get("searchresult") or {})
            for k, item in results.items():
                if k == "summary" or not isinstance(item, dict):
                    continue
                rec = self._normalize(item)
                if rec is not None:
                    kept[rec["key"]] = rec

        self.log.info("kept %d bill(s) from LegiScan", len(kept))
        return list(kept.values())

    def _normalize(self, item: dict) -> dict | None:
        try:
            number = str(item.get("bill_number") or "").strip()
            if not number:
                return None
            action_text = item.get("last_action") or ""
            # bill_number like "HR1234" -> split letters/digits for a clean type.
            letters = "".join(c for c in number if c.isalpha())
            digits = "".join(c for c in number if c.isdigit())
            return {
                "key": f"legiscan-{item.get('bill_id') or number}",
                "data": {
                    "title": item.get("title") or "(untitled)",
                    "congress": "",
                    "type": letters.upper(),
                    "number": digits or number,
                    "identifier": number,
                    "stage": bills.derive_stage(action_text),
                    "latest_action_text": action_text,
                    "latest_action_date": item.get("last_action_date") or "",
                    "chamber": "",
                    "update_date": item.get("last_action_date") or "",
                    "url": item.get("url") or item.get("text_url") or "",
                    "source": "LegiScan",
                },
            }
        except Exception as exc:
            self.log.warning("could not normalize a LegiScan bill: %s", exc)
            return None
