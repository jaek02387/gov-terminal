"""Shared bill helpers used by BOTH bill sources (Congress.gov, LegiScan) and the
bill panels, so they never drift apart.

  * a canonical legislative-stage vocabulary + a heuristic to derive a bill's
    stage from its latest-action text (powers change-detection / "movers")
  * identifier + congress.gov URL formatting
"""
from __future__ import annotations

# Rough linear progression of a bill. Index = how far along it is.
STAGES = [
    "Introduced",
    "In Committee",
    "Reported",
    "On Floor",
    "Passed Chamber",
    "Passed Both Chambers",
    "To President",
    "Became Law",
]
# Off-track terminal states (shown, but not part of the linear progression).
TERMINAL = ["Failed", "Vetoed", "Withdrawn"]


def derive_stage(action_text: str) -> str:
    """Best-effort map of a free-text latest action to a coarse stage. The exact
    label matters less than being STABLE, so the movers diff only fires on real
    transitions rather than wording tweaks."""
    t = (action_text or "").lower()
    if not t:
        return "Introduced"
    if "became public law" in t or "public law no" in t or "signed by president" in t:
        return "Became Law"
    if "veto" in t:
        return "Vetoed"
    if "failed" in t or "rejected" in t or "withdrawn" in t:
        return "Failed"
    if "presented to" in t and "president" in t:
        return "To President"
    if ("passed" in t or "agreed to" in t) and "house" in t and "senate" in t:
        return "Passed Both Chambers"
    if "passed" in t or "agreed to in" in t or "passed/agreed to" in t:
        return "Passed Chamber"
    if "placed on" in t and "calendar" in t:
        return "On Floor"
    if "reported" in t or "ordered to be reported" in t:
        return "Reported"
    if "referred to" in t or "committee" in t:
        return "In Committee"
    if "introduced" in t or "read twice" in t or "read the first time" in t:
        return "Introduced"
    return "In Committee"  # safe default for misc procedural actions


def stage_rank(stage: str) -> int:
    """Position in the linear progression (-1 for terminal/unknown)."""
    try:
        return STAGES.index(stage)
    except ValueError:
        return -1


_TYPE_SLUG = {
    "hr": "house-bill",
    "s": "senate-bill",
    "hjres": "house-joint-resolution",
    "sjres": "senate-joint-resolution",
    "hconres": "house-concurrent-resolution",
    "sconres": "senate-concurrent-resolution",
    "hres": "house-resolution",
    "sres": "senate-resolution",
}


def identifier(bill_type: str, number: str) -> str:
    return f"{(bill_type or '').upper()} {number}"


def website_url(congress, bill_type: str, number: str) -> str:
    slug = _TYPE_SLUG.get((bill_type or "").lower(), "house-bill")
    return f"https://www.congress.gov/bill/{congress}th-congress/{slug}/{number}"
