#!/usr/bin/env python
"""Tests for creator attribution and format detection.

    python tools/match_test.py

Every case below is a real title and description from the first ingest, including the two
that were attributed wrongly before the rules were tightened. They are here so the rules
cannot quietly loosen again: a false positive in attribution is invisible — the page looks
fine and the video simply carries somebody else's authority.
"""
from __future__ import annotations

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from yt_sync import (creator_index, match_creators, guess_format, credit_windows,  # noqa: E402
                     speech_rate, COMPETITION)

PASSED = 0
FAILED: list[str] = []


def check(name: str, actual, expected) -> None:
    global PASSED
    if actual == expected:
        PASSED += 1
    else:
        FAILED.append("  %s\n      expected: %r\n      actual:   %r" % (name, expected, actual))


def ok(name: str, condition: bool) -> None:
    check(name, bool(condition), True)


CREATORS = {
    "nicole": {"name": "Nicole", "wsdc_status": "unconfirmed"},
    "thibault": {"name": "Thibault", "wsdc_status": "unconfirmed"},
    "kyle": {"name": "Kyle", "wsdc_status": "unconfirmed"},
    "sarah": {"name": "Sarah", "wsdc_status": "unconfirmed"},
    "anna": {"name": "Anna", "wsdc_status": "unconfirmed"},
    "lauren": {"name": "Lauren", "wsdc_status": "unconfirmed"},
    "thomas": {"name": "Thomas", "wsdc_status": "unconfirmed"},
    "attila": {"name": "Attila", "wsdc_status": "ambiguous",
               "aliases": ["Attila Kobori", "Attila Partos"]},
    "ben-morris": {"name": "Ben Morris", "wsdc_status": "unconfirmed"},
}
INDEX = creator_index(CREATORS)

# --------------------------------------------------------------- true positives

title = "WCS Constant Connection"
desc = ("West Coast Swing lesson by Thibault and Nicole covering constant connection. "
        "Check them out at www.ThibaultandNicole.com")
people, confidence, how = match_creators(title, desc, INDEX, "tutorial")
check("a credited couple is attributed", people, ["nicole", "thibault"])
check("and the route is recorded", how, "credited")
ok("with usable confidence", confidence >= 0.5)

people, confidence, how = match_creators("Ben Morris - Whip technique", "", INDEX, "tutorial")
check("a full name in the title is attributed", people, ["ben-morris"])
check("as a full-name match", how, "full-name")
ok("with high confidence", confidence >= 0.9)

# -------------------------------------------------------------- false positives
#
# The case that broke it. Kyle Redd and Sarah Vann Drake are *thanked as organisers*; the
# dancers are listed in the timestamps. Two weak first-name hits used to corroborate each
# other into a confident wrong answer.

comp_desc = ("West Coast Swing, All Star division, Jack and Jill finals at Swingtime 2026, "
             "Denver. Awesome event as always, thanks to Kyle Redd, Sarah Vann Drake, and "
             "Jalene Haramia.  00:00 Intro 00:04 Aaron Nuno & Maria Ivanova")
people, confidence, how = match_creators("All Star JnJ Swingtime 2026", comp_desc, INDEX,
                                         "competition")
check("organisers thanked in a competition description are not creators", people, [])
ok("and the reason is recorded", how in ("competition-weak", "roster", "none"))

roster = ("Swingtime INT Jack and Jill. With Kyle, Sarah, Anna, Lauren and Thomas judging. "
          "Great event.")
people, _confidence, how = match_creators("Swingtime INT Jack & Jill - Denver", roster,
                                          INDEX, "competition")
check("a roster of five names is not a credit", people, [])
check("and is labelled a roster", how, "roster")

# "thanks to" is gratitude, not authorship.
ok("gratitude is not an authorship cue", "Kyle Redd" not in credit_windows(
    "Awesome event as always, thanks to Kyle Redd, Sarah Vann Drake"))
ok("'lesson by' is an authorship cue", "Thibault" in credit_windows(
    "West Coast Swing lesson by Thibault and Nicole covering connection"))

# A bare first name buried in body text is not enough on its own.
people, confidence, how = match_creators(
    "WCS Social Dancing", "Filmed at the party. Thanks to Lauren for the venue.", INDEX, "demo")
check("a lone first name in body text does not attribute", people, [])

# An ambiguous creator must never be silently picked.
people, confidence, how = match_creators("Attila teaching musicality", "", INDEX, "tutorial")
check("an ambiguous first name is not attributed", people, [])
ok("and stays well below the threshold", confidence < 0.5)

# Adjacency: names must sit together to corroborate each other.
people, _c, _h = match_creators(
    "WCS lesson", "A lesson by Nicole. Camera by somebody else. Thanks to Thomas as well.",
    INDEX, "tutorial")
ok("names far apart do not form a pair", people in ([], ["nicole"]))

# ------------------------------------------------------------------ format

check("a Jack & Jill is competition", guess_format("All Star JnJ Swingtime 2026")[0], "competition")
check("J&J is competition", guess_format("All  Star J&J - Colorado Classic")[0], "competition")
check("prelims are competition", guess_format("WCS High-Low JnJ Prelim")[0], "competition")
check("drills are drills", guess_format("WCS Partner Drills-Aris DeMarco")[0], "drill")
check("technique is a tutorial", guess_format("WCS Gary McIntyre - Blues technique")[0], "tutorial")
check("an unrecognised title stays unknown", guess_format("WCS Apache Jazzbox")[0], "unknown")
ok("an unknown format carries no confidence", guess_format("WCS Apache Jazzbox")[1] == 0.0)

# The regression that made this rule title-only. Half of West Coast Swing's events are
# named "... Classic" or "... Open", so an event name in a description is not a format.
workshop = ("West Coast Swing Champions Gary McIntyre & Susan Kirklin taught this amazing "
            "workshop at Colorado Country/Swing Classic, Denver Colorado, 2026.")
check("an event named Classic is not a competition",
      guess_format("WCS Fun Footwork Challenge - Gary & Susan", workshop)[0], "tutorial")
check("nor is an event named Open",
      guess_format("WCS Sugar Push basics", "Filmed at the Hungarian Open 2026.")[0], "tutorial")
ok("a J&J in the title still wins outright",
   guess_format("All Star J&J - Colorado Classic", workshop)[0] == "competition")

# ------------------------------------------------------------------ pruning

ok("a Jack & Jill title is competition", bool(COMPETITION.search("Swingtime INT Jack & Jill")))
ok("JnJ is competition", bool(COMPETITION.search("WCS Advanced JnJ Swingtime 2026")))
ok("J & J spaced out is competition", bool(COMPETITION.search("All Star J & J Finals")))
ok("an invitational is competition", bool(COMPETITION.search("Champ/All Star Invitational JNJ")))
ok("a tutorial title is not", not COMPETITION.search("WCS Constant Connection"))
ok("nor is a drill title", not COMPETITION.search("WCS Partner Drills-Aris DeMarco"))

check("speech rate is words per minute", speech_rate(200, 120), 100.0)
check("no duration means no rate", speech_rate(200, 0), 0.0)
ok("a tutorial out-talks a competition", speech_rate(1240, 365) > speech_rate(767, 771))

# ------------------------------------------------------------------------ done

if FAILED:
    print("FAILURES")
    print("\n".join(FAILED))
    print()
print("%d passed, %d failed" % (PASSED, len(FAILED)))
sys.exit(1 if FAILED else 0)
