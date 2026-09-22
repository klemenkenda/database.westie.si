#!/usr/bin/env python
"""Build creator records from the teacher names in the workshop archive.

    python tools/import_creators.py --dry-run
    python tools/import_creators.py
    python tools/import_creators.py --report      # near-duplicates and ambiguities only

Only **names** cross from teaching.westie.si — never a video id, an event slug, a workshop
reference or a date. Who teaches West Coast Swing at events is public professional fact;
the recordings are not. FORBIDDEN below is asserted on every record written.

One number is deliberately left behind too: how often each teacher appears. That is a fact
about whose workshops Klemen attended, not about the teacher, so it stays in the console
report and out of content/.

Nothing here resolves an identity. A first name with no surname is written `unconfirmed`,
a first name that expands to two different people is written `ambiguous`, and near-duplicate
spellings are reported rather than merged. The tool's job is to put the question in front
of a human, not to answer it.
"""
from __future__ import annotations

import argparse
import collections
import datetime as _dt
import difflib
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
# YouTube titles carry emoji, and Windows consoles default to cp1252, where printing one
# raises UnicodeEncodeError mid-run. Replace rather than crash: a mangled character in a
# progress line is not worth losing an ingest over.
try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
except (AttributeError, ValueError):
    pass

import wcsyaml  # noqa: E402

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DEST = os.path.join(HERE, "content", "creators")
DEFAULT_SOURCE = os.path.join(os.path.dirname(HERE), "www", "teaching.westie.si", "content")

#: Never written to a creator record, whatever the source offers.
FORBIDDEN = {"videos", "sources", "workshops", "events", "links_raw", "source_line"}

#: Not a teacher to rank: the archive owner, teaching their own classes.
SELF = {"klemen"}

KEY_ORDER = [
    "id", "type", "name", "aliases", "partners", "wsdc_id", "wsdc_status", "wsdc",
    "wsdc_evidence", "authority", "authority_override", "demote", "demote_reason",
    "channels", "links", "note", "added", "updated", "generated",
]


def slugify(name: str) -> str:
    text = name.lower().strip()
    for a, b in (("ž", "z"), ("š", "s"), ("č", "c"), ("ć", "c"), ("đ", "d"),
                 ("á", "a"), ("é", "e"), ("í", "i"), ("ó", "o"), ("ú", "u"),
                 ("ä", "a"), ("ö", "o"), ("ü", "u"), ("à", "a"), ("è", "e"),
                 ("ï", "i"), ("ê", "e"), ("ç", "c"), ("ñ", "n")):
        text = text.replace(a, b)
    text = re.sub(r"[^a-z0-9]+", "-", text).strip("-")
    return text


def collect(source: str) -> tuple[collections.Counter, dict[str, set], dict[str, set]]:
    """Names, who each appears alongside, and which full names each first name expands to."""
    seen: collections.Counter = collections.Counter()
    partners: dict[str, set] = collections.defaultdict(set)
    expansions: dict[str, set] = collections.defaultdict(set)

    for sub in ("videos", os.path.join("sources", "workshops")):
        directory = os.path.join(source, sub)
        if not os.path.isdir(directory):
            continue
        for name in sorted(os.listdir(directory)):
            if not name.endswith(".md"):
                continue
            front, _ = wcsyaml.read(os.path.join(directory, name))
            people = [p.strip() for p in (front.get("instructors") or []) if isinstance(p, str) and p.strip()]
            for person in people:
                seen[person] += 1
                for other in people:
                    if other != person:
                        partners[person].add(other)
            # "Attila Kobori" tells us something about every bare "Attila".
            for person in people:
                if " " in person:
                    expansions[person.split()[0]].add(person)
    return seen, partners, expansions


def near_duplicates(names: list[str], partners: dict[str, set]) -> list[tuple]:
    """Spelling variants a human should merge. Reported, never applied.

    Spelling alone is a weak signal in both directions: it misses "Markus"/"Marcus" at a
    0.83 ratio while flagging "Maria"/"Marina", who are two different people. A **shared
    dance partner** is far stronger evidence — the same person spelled two ways will keep
    turning up beside the same partner — so a shared partner lowers the similarity bar and
    is shown alongside each pair as the reason to believe it.
    """
    out = []
    for i, a in enumerate(names):
        for b in names[i + 1:]:
            if a == b or " " in a or " " in b:
                continue
            ratio = difflib.SequenceMatcher(None, a.lower(), b.lower()).ratio()
            shared = sorted(partners.get(a, set()) & partners.get(b, set()))
            if ratio >= 0.85 or (ratio >= 0.6 and shared):
                out.append((a, b, ratio, shared))
    # Pairs with corroborating evidence first; they are the ones worth acting on.
    return sorted(out, key=lambda r: (-len(r[3]), -r[2]))


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--source", default=DEFAULT_SOURCE)
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--report", action="store_true", help="print the questions, write nothing")
    ap.add_argument("--min-seen", type=int, default=2,
                    help="skip teachers appearing fewer than this many times (default 2)")
    args = ap.parse_args()

    assert not (set(KEY_ORDER) & FORBIDDEN), "KEY_ORDER must not contain a forbidden field"

    seen, partners, expansions = collect(args.source)
    if not seen:
        raise SystemExit("no instructors found under %s" % args.source)

    today = _dt.date.today().isoformat()
    os.makedirs(DEST, exist_ok=True)
    existing = {n[:-3] for n in os.listdir(DEST) if n.endswith(".md")}

    created, skipped, ambiguous, thin = [], [], [], []

    for person, count in seen.most_common():
        if slugify(person) in SELF:
            continue
        if count < args.min_seen:
            thin.append((person, count))
            continue

        # A bare first name that expands to more than one person is not an identity.
        candidates = expansions.get(person, set()) if " " not in person else set()
        is_ambiguous = len(candidates) > 1

        slug = slugify(person)
        if not slug:
            continue
        if slug in existing:
            skipped.append(slug)
            continue

        front = {
            "id": slug,
            "type": "creator",
            "name": person,
            "aliases": sorted(candidates) if candidates else [],
            "partners": sorted(partners.get(person, set()))[:8],
            "wsdc_id": None,
            "wsdc_status": "ambiguous" if is_ambiguous else "unconfirmed",
            "wsdc": {},
            "authority": None,
            "authority_override": None,
            "demote": False,
            "channels": [],
            "links": [],
            "added": today,
            "generated": True,
        }
        if is_ambiguous:
            front["note"] = ("This first name covers more than one teacher (%s). Split into "
                             "separate records before confirming a WSDC id."
                             % ", ".join(sorted(candidates)))
            ambiguous.append((slug, sorted(candidates)))
        elif " " not in person:
            front["note"] = ("Surname unknown. Teaches with: %s."
                             % ", ".join(sorted(partners.get(person, set()))[:5]) or "unknown")

        leaked = FORBIDDEN & set(front)
        if leaked:
            raise SystemExit("PRIVACY: %s would carry %s" % (slug, ", ".join(sorted(leaked))))

        body = "# %s\n\n%s\n" % (person, front.get("note", "No WSDC id confirmed yet."))
        if not (args.dry_run or args.report):
            ordered = {k: front[k] for k in KEY_ORDER if k in front}
            wcsyaml.write(os.path.join(DEST, slug + ".md"), ordered, body)
        created.append(slug)

    verb = "would create" if (args.dry_run or args.report) else "created"
    print("teachers found: %d distinct names" % len(seen))
    print("%s: %d   (skipped %d already present, %d below --min-seen=%d)"
          % (verb, len(created), len(skipped), len(thin), args.min_seen))

    if ambiguous:
        print("\nAMBIGUOUS - one first name, several teachers. Split these by hand:")
        for slug, candidates in ambiguous:
            print("  %-22s %s" % (slug, ", ".join(candidates)))

    duplicates = near_duplicates([n for n in seen if seen[n] >= args.min_seen], partners)
    if duplicates:
        print("\nPOSSIBLE SPELLING VARIANTS - merge by hand if they are the same person.")
        print("A shared partner is the strong signal; similarity alone is not.")
        for a, b, ratio, shared in duplicates[:24]:
            why = ("shares " + ", ".join(shared[:3])) if shared else "spelling only"
            print("  %-14s ~ %-14s %3.0f%%  %-30s seen %dx / %dx"
                  % (a, b, ratio * 100, why, seen[a], seen[b]))

    print("\nAppearance counts stay here and never reach content/ - they describe whose")
    print("workshops you attended, not the teachers themselves.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
