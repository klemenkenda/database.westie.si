#!/usr/bin/env python
"""Import the concept vocabulary from teaching.westie.si — as a draft, never as fact.

    python tools/import_concepts.py --dry-run     # show the diff, write nothing
    python tools/import_concepts.py               # apply it
    python tools/import_concepts.py --report      # what the last import decided, per file

Two rules govern this tool, and both exist because the source is not trustworthy enough to
copy blindly.

**The privacy line.** teaching.westie.si holds 525 workshop recordings from events and
privates. They are personal archive material, not ours to republish. This tool therefore
copies *no* video ids, *no* workshop or event references, and *no* body text — the body is
regenerated from scratch here, because upstream bodies embed instructor names, event slugs
and lesson summaries from that archive. Only the vocabulary crosses: names, levels,
categories, tags and the prerequisite edges. The FORBIDDEN set below is asserted on every
record, so a future upstream field cannot quietly open the door.

**Nothing arrives as fact.** Every imported edge lands as `trust: imported` with
`confidence: 0.5`, and a re-import can never demote something a human has since verified.
That merge rule mirrors Trust::merge in the API; the two are asserted equivalent by
tools/api_test.php.
"""
from __future__ import annotations

import argparse
import datetime as _dt
import io
import json
import os
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
DEST = os.path.join(HERE, "content", "concepts")
DEFAULT_SOURCE = os.path.join(
    os.path.dirname(HERE), "www", "teaching.westie.si", "content", "concepts"
)

#: Fields that must never cross from the archive. See "The privacy line" above.
FORBIDDEN = {"videos", "sources", "workshops", "events", "classes", "drills", "plans"}

#: What we do take. Anything not named here is dropped rather than carried along, so a new
#: upstream field is a decision rather than an accident.
CARRY = {"id", "title", "category", "level", "tags"}

TRUST_RANK = {"disputed": -1, "imported": 0, "corroborated": 1, "verified": 2}
IMPORTED_CONFIDENCE = 0.5

#: Canonical frontmatter order, so a rewrite of an unchanged file is a no-op diff.
KEY_ORDER = [
    "id", "type", "title", "category", "level", "level_trust", "tags", "aliases",
    "related", "requires", "videos", "trust", "origin", "status",
    "verified_by", "verified_at", "added", "updated", "generated",
]

BODY_TEMPLATE = """# {title}

*{category} · level {level}* — imported from the teaching syllabus and **not yet reviewed**.

## What it is

_To write._

## Teaching points

-

## Common mistakes

-

## How we know the prerequisites

{prereq_note}
"""


def edge(raw, origin: str) -> dict | None:
    """Canonical edge. Mirrors Trust::edge — a bare string cannot claim to be verified."""
    if isinstance(raw, str):
        raw = {"id": raw}
    if not isinstance(raw, dict) or not raw.get("id"):
        return None
    trust = raw.get("trust") if raw.get("trust") in TRUST_RANK else "imported"
    confidence = raw.get("confidence")
    if not isinstance(confidence, (int, float)):
        confidence = {"verified": 1.0, "corroborated": 0.75, "disputed": 0.1}.get(
            trust, IMPORTED_CONFIDENCE
        )
    strength = raw.get("strength")
    if strength not in ("required", "usually-taught-before", "related"):
        strength = "required"
    out = {
        "id": raw["id"],
        "origin": raw.get("origin") or origin,
        "trust": trust,
        "confidence": round(max(0.0, min(1.0, float(confidence))), 2),
        "strength": strength,
    }
    for optional in ("evidence", "note"):
        if optional in raw:
            out[optional] = raw[optional]
    return out


def differs(a: dict, b: dict) -> bool:
    return a["strength"] != b["strength"] or abs(a["confidence"] - b["confidence"]) > 0.01


def merge_edge(local: dict | None, incoming: dict) -> tuple[dict, bool]:
    """Mirrors Trust::merge. A sync must never cost a human's review."""
    if local is None:
        return incoming, True
    if TRUST_RANK[incoming["trust"]] > TRUST_RANK[local["trust"]]:
        return incoming, True
    if TRUST_RANK[incoming["trust"]] == TRUST_RANK[local["trust"]] and local["trust"] == "imported":
        return incoming, differs(local, incoming)
    # Only `strength` counts as a disagreement once local outranks incoming: confidence is
    # a function of trust, so comparing it would flag every pair. Mirrors Trust::merge.
    if local["strength"] == incoming["strength"]:
        local.pop("upstream", None)
        return local, False
    local["upstream"] = {
        "strength": incoming["strength"],
        "confidence": incoming["confidence"],
        "origin": incoming["origin"],
    }
    return local, True


def ordered(front: dict) -> dict:
    out = {k: front[k] for k in KEY_ORDER if k in front}
    for k, v in front.items():
        if k not in out:
            out[k] = v
    return out


assert not (CARRY & FORBIDDEN), "CARRY and FORBIDDEN must not overlap"


def assert_clean(key: str, carried: dict, local_videos: list, archive_ids: set) -> None:
    """Three checks, because the interesting failure is not the obvious one.

    The obvious one is a forbidden field being carried across. The *real* one is an
    archive video id ending up in our own `videos` list — same field name, entirely
    different provenance, and invisible to a check that only looks at key names.
    """
    leaked = FORBIDDEN & set(carried)
    if leaked:
        raise SystemExit(
            "PRIVACY: %s would carry %s from the workshop archive. Refusing to write."
            % (key, ", ".join(sorted(leaked)))
        )
    bleed = {v for v in local_videos if isinstance(v, str)} & archive_ids
    if bleed:
        raise SystemExit(
            "PRIVACY: %s lists video ids that belong to the workshop archive: %s. "
            "Those recordings are not public material. Refusing to write."
            % (key, ", ".join(sorted(bleed)[:5]))
        )


def load_source(source_dir: str) -> dict[str, dict]:
    if not os.path.isdir(source_dir):
        raise SystemExit("source not found: %s" % source_dir)
    out = {}
    for name in sorted(os.listdir(source_dir)):
        if not name.endswith(".md"):
            continue
        front, _body = wcsyaml.read(os.path.join(source_dir, name))
        if front.get("id"):
            out[name[:-3]] = front
    return out


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--source", default=DEFAULT_SOURCE, help="upstream concepts/ directory")
    ap.add_argument("--dry-run", action="store_true", help="report without writing")
    ap.add_argument("--report", action="store_true", help="print the per-file decision table")
    args = ap.parse_args()

    stamp = _dt.date.today().isoformat()
    origin = "import:teaching@%s" % stamp
    source = load_source(args.source)
    os.makedirs(DEST, exist_ok=True)

    # Every video id the archive knows about. Nothing in this database may reference one.
    archive_video_ids = set()
    for up in source.values():
        for vid in up.get("videos", []) or []:
            if isinstance(vid, str):
                archive_video_ids.add(vid)

    created, updated, unchanged, protected, conflicts = [], [], [], [], []

    for key, up in sorted(source.items()):
        local_path = os.path.join(DEST, key + ".md")
        local_front, local_body = ({}, "")
        if os.path.isfile(local_path):
            local_front, local_body = wcsyaml.read(local_path)

        carried = {k: v for k, v in up.items() if k in CARRY}
        front = dict(carried)
        front.setdefault("id", key)
        front["type"] = "concept"
        front.setdefault("title", key.replace("-", " ").capitalize())
        front.setdefault("category", "technique")
        front.setdefault("level", 1)
        front.setdefault("tags", [])

        # Local judgments outrank the import: these are ours, not upstream's.
        front["level_trust"] = local_front.get("level_trust", "imported")
        if front["level_trust"] in ("verified", "corroborated") and "level" in local_front:
            if local_front["level"] != front["level"]:
                conflicts.append((key, "level", local_front["level"], front["level"]))
            front["level"] = local_front["level"]

        front["aliases"] = local_front.get("aliases", [])
        front["related"] = local_front.get("related", [])
        front["videos"] = local_front.get("videos", [])

        local_edges = {e["id"]: e for e in
                       (edge(r, origin) for r in local_front.get("requires", []) or []) if e}
        merged, changed_edges = [], False
        seen = set()
        for raw in up.get("requires", []) or []:
            inc = edge(raw, origin)
            if inc is None:
                continue
            seen.add(inc["id"])
            result, changed = merge_edge(local_edges.get(inc["id"]), inc)
            merged.append(result)
            changed_edges = changed_edges or changed
        # An edge we hold that upstream dropped is kept when someone vouched for it.
        for eid, local_edge in local_edges.items():
            if eid in seen:
                continue
            if TRUST_RANK[local_edge["trust"]] > 0:
                merged.append(local_edge)
                protected.append((key, eid, local_edge["trust"]))
            else:
                changed_edges = True
        merged.sort(key=lambda e: e["id"])
        front["requires"] = merged

        front["trust"] = local_front.get("trust", "imported")
        front["origin"] = local_front.get("origin", origin)
        front["status"] = local_front.get("status", "draft")
        front["verified_by"] = local_front.get("verified_by")
        front["verified_at"] = local_front.get("verified_at")
        front["added"] = local_front.get("added", stamp)
        front["updated"] = stamp
        front["generated"] = local_front.get("generated", True)

        assert_clean(key, carried, front["videos"], archive_video_ids)
        front = ordered(front)

        unreviewed = sum(1 for e in merged if e["trust"] == "imported")
        prereq_note = (
            "_No prerequisites recorded. For a level %s concept that is more likely to be a "
            "gap in the import than a fact about the dance._" % front["level"]
            if not merged else
            "%d of %d prerequisites below are unreviewed imports, shown as *suggested* until "
            "the corpus corroborates them or someone checks them by hand."
            % (unreviewed, len(merged))
        )
        body = local_body if local_body.strip() and not local_front.get("generated", True) else \
            BODY_TEMPLATE.format(
                title=front["title"],
                category=str(front["category"]).capitalize(),
                level=front["level"],
                prereq_note=prereq_note,
            )

        rendered = wcsyaml.document(front, body)
        if not os.path.isfile(local_path):
            created.append(key)
        else:
            with io.open(local_path, encoding="utf-8") as fh:
                if fh.read() == rendered:
                    unchanged.append(key)
                else:
                    updated.append(key)
        if not args.dry_run and (key in created or key in updated):
            wcsyaml.write(local_path, front, body)

    verb = "would write" if args.dry_run else "wrote"
    print("source:   %s" % args.source)
    print("concepts: %d" % len(source))
    print("%s:  %d created, %d updated, %d unchanged" % (verb, len(created), len(updated), len(unchanged)))
    if protected:
        print("\nkept against the import (locally vouched for):")
        for key, eid, trust in protected[:20]:
            print("    %-36s requires %-28s [%s]" % (key, eid, trust))
    if conflicts:
        print("\nupstream disagrees with a local judgment (local kept):")
        for key, field, mine, theirs in conflicts[:20]:
            print("    %-36s %s: local=%s upstream=%s" % (key, field, mine, theirs))
    if args.report:
        print("\ncreated: %s" % ", ".join(created[:40]))
        print("updated: %s" % ", ".join(updated[:40]))

    if not args.dry_run:
        manifest = {
            "imported_at": stamp,
            "source": args.source,
            "origin": origin,
            "counts": {"created": len(created), "updated": len(updated), "unchanged": len(unchanged)},
            "protected": [{"concept": k, "requires": e, "trust": t} for k, e, t in protected],
            "conflicts": [{"concept": k, "field": f, "local": m, "upstream": t} for k, f, m, t in conflicts],
        }
        audit_dir = os.path.join(HERE, "content", ".audit")
        os.makedirs(audit_dir, exist_ok=True)
        with io.open(os.path.join(audit_dir, "import.json"), "w", encoding="utf-8", newline="\n") as fh:
            json.dump(manifest, fh, indent=2, ensure_ascii=False)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
