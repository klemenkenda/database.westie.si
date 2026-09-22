"""Minimal WSDC points lookup.

A self-contained rewrite of the fetcher in Work/dancing/WSDC, without its `dt.py`
dataclass dependency, so this repository stands alone.

The registry lookup is **by numeric id only** — there is no name search endpoint. That is
a feature here rather than a limitation: it means an id can only ever enter the database
because a human put it there, so the silent failure mode of fuzzy name matching (one wrong
match quietly mis-ranking every video that creator appears in) cannot occur.

Be polite. This is somebody's public service and we are a guest on it: one request at a
time, a real delay between them, and never a sweep of the id space.
"""
from __future__ import annotations

import json
import re
import time
from typing import Any

import requests

BASE = "https://points.worldsdc.com"
LOOKUP = BASE + "/lookup2020"
FIND = BASE + "/lookup2020/find"

DIVISIONS = ["CHA", "ALS", "ADV", "INT", "NOV", "NEW"]

_UA = "database.westie.si creator sync (contact: klemen.kenda@ijs.si)"
_TOKEN_RE = re.compile(r'<input[^>]*name="_token"[^>]*value="([^"]+)"')


class WsdcError(RuntimeError):
    pass


class Wsdc:
    def __init__(self, delay: float = 1.5):
        self.session = requests.Session()
        self.session.headers["User-Agent"] = _UA
        self.token: str | None = None
        self.delay = delay
        self._last = 0.0

    def _wait(self) -> None:
        elapsed = time.time() - self._last
        if elapsed < self.delay:
            time.sleep(self.delay - elapsed)
        self._last = time.time()

    def _get_token(self) -> str:
        if self.token:
            return self.token
        self._wait()
        response = self.session.get(LOOKUP, timeout=30)
        response.raise_for_status()
        match = _TOKEN_RE.search(response.text)
        if not match:
            raise WsdcError("no CSRF token on the lookup page — the site markup may have changed")
        self.token = match.group(1)
        return self.token

    def fetch(self, wsdc_id: int) -> dict[str, Any]:
        """Raw record for one id. Raises WsdcError if the id is unknown."""
        self._wait()
        response = self.session.post(
            FIND, data={"num": int(wsdc_id), "_token": self._get_token()}, timeout=30
        )
        if response.status_code == 419:                     # token expired
            self.token = None
            self._wait()
            response = self.session.post(
                FIND, data={"num": int(wsdc_id), "_token": self._get_token()}, timeout=30
            )
        response.raise_for_status()
        try:
            data = response.json()
        except json.JSONDecodeError:
            raise WsdcError("id %s: the registry did not return JSON" % wsdc_id)
        if not isinstance(data, dict) or not (data.get("leader") or data.get("follower")):
            raise WsdcError("id %s: no dancer found" % wsdc_id)
        return data


def summarise(record: dict[str, Any]) -> dict[str, Any]:
    """Points per division per role, plus the identity fields a human confirms against.

    The competition details are not decoration. They are the evidence that this id is the
    person we think it is, and they get stored in the creator file so the confirmation can
    be re-checked later by someone who was not there when it was made.
    """
    out: dict[str, Any] = {"name": None, "wsdc_id": None}
    for role in ("leader", "follower"):
        role_data = record.get(role)
        if not isinstance(role_data, dict):
            out[role] = {d: 0 for d in DIVISIONS}
            continue
        placements = role_data.get("placements") or {}
        wcs = placements.get("West Coast Swing") or {} if isinstance(placements, dict) else {}
        out[role] = {d: int((wcs.get(d) or {}).get("total_points", 0) or 0) for d in DIVISIONS}

        dancer = role_data.get("dancer") or {}
        if dancer.get("first_name") and not out["name"]:
            out["name"] = ("%s %s" % (dancer.get("first_name", ""), dancer.get("last_name", ""))).strip()
            out["wsdc_id"] = dancer.get("wscid")

        best = None
        for division, block in (wcs.items() if isinstance(wcs, dict) else []):
            for comp in (block or {}).get("competitions", []) or []:
                event = comp.get("event") or {}
                candidate = {
                    "event": event.get("name"),
                    "location": event.get("location"),
                    "date": event.get("date"),
                    "result": comp.get("result"),
                    "points": comp.get("points", 0),
                    "division": division,
                }
                rank = (DIVISIONS.index(division) if division in DIVISIONS else 99,
                        -int(candidate["points"] or 0))
                if best is None or rank < best[0]:
                    best = (rank, candidate)
        out[role + "_best"] = best[1] if best else None
    return out


def top_division(summary: dict[str, Any]) -> tuple[str | None, int]:
    """Highest division held in either role, and the points in it."""
    for division in DIVISIONS:
        points = max(
            int((summary.get("leader") or {}).get(division, 0) or 0),
            int((summary.get("follower") or {}).get(division, 0) or 0),
        )
        if points > 0:
            return division, points
    return None, 0
