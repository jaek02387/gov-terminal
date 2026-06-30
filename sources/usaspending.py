"""Government contracts via USASpending.gov.

USASpending is a fully OPEN government API -- no API key, no signup. We pull
recent contracts matching the SAME federal-priority keywords used for bills, for
the Policy Timeline. Fails in isolation like every source; runs hourly.
"""
from __future__ import annotations

from datetime import date, timedelta

import bills
import config
from sources.base import Source

API_URL = "https://api.usaspending.gov/api/v2/search/spending_by_award/"
MAX_CONTRACTS = 25      # most significant (by obligated amount) priority contracts
LOOKBACK_DAYS = 730     # contracts with action in the last ~2 years


class USASpendingSource(Source):
    name = "usaspending"
    enabled = True       # open API, no key
    track_changes = False

    def fetch(self) -> list[dict]:
        import requests

        today = date.today()
        payload = {
            "filters": {
                "keywords": config.CONTRACT_KEYWORDS,  # curated priority keywords
                "award_type_codes": ["A", "B", "C", "D"],  # contract types
                "time_period": [{
                    "start_date": (today - timedelta(days=LOOKBACK_DAYS)).isoformat(),
                    "end_date": today.isoformat(),
                    "date_type": "action_date",
                }],
            },
            "fields": [
                "Award ID", "Recipient Name", "Award Amount", "Total Outlays",
                "Contract Award Type", "Award Type", "Description",
                "Last Modified Date", "Awarding Agency", "generated_internal_id",
            ],
            "limit": MAX_CONTRACTS,
            "sort": "Award Amount",
            "order": "desc",
        }
        resp = requests.post(API_URL, json=payload, timeout=25)
        resp.raise_for_status()

        records: list[dict] = []
        for a in resp.json().get("results", []):
            rec = self._normalize(a)
            if rec is not None:
                records.append(rec)
        self.log.info("kept %d priority contract(s)", len(records))
        return records

    def _normalize(self, a: dict) -> dict | None:
        try:
            aid = a.get("generated_internal_id") or a.get("Award ID")
            if not aid:
                return None
            recipient = a.get("Recipient Name") or "(unnamed recipient)"
            desc = a.get("Description") or ""
            agency = a.get("Awarding Agency") or ""
            # Classify on description + recipient + awarding agency (the agency,
            # e.g. "Department of Defense"/"Department of Energy", classifies most
            # terse contract descriptions that would otherwise be uncategorized).
            return {
                "key": str(aid),
                "data": {
                    "award_id": a.get("Award ID") or "",
                    "recipient": recipient,
                    "obligations": a.get("Award Amount"),
                    "outlays": a.get("Total Outlays"),
                    "award_type": a.get("Contract Award Type") or a.get("Award Type") or "",
                    "description": desc,
                    "agency": agency,
                    "date": (a.get("Last Modified Date") or "")[:10],
                    "category": bills.classify_category(f"{desc} {recipient} {agency}"),
                    "url": f"https://www.usaspending.gov/award/{aid}",
                    "source": "USASpending",
                },
            }
        except Exception as exc:
            self.log.warning("could not normalize a contract: %s", exc)
            return None
