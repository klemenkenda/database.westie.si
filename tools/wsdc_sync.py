#!/usr/bin/env python
"""Creator records and their WSDC standing.

    python tools/wsdc_sync.py list                    # who we have, and what we know
    python tools/wsdc_sync.py seed                    # create records from tools/seed/creators.psv
    python tools/wsdc_sync.py lookup 10277            # print a registry record, confirm nothing
    python tools/wsdc_sync.py confirm ben-morris 1234 # bind an id to a creator, with evidence
    python tools/wsdc_sync.py none some-teacher       # record that they are genuinely not listed
    python tools/wsdc_sync.py refresh                 # re-fetch points for confirmed creators
    python tools/wsdc_sync.py pending                 # what still needs a human

`confirm` is the only command that binds an id to a person, and it never guesses: you pass
the id, it shows you the name and the best competition behind it, and you say yes. There is
no name search in the registry and this tool does not simulate one.

That is deliberate. A wrong id is invisible — nothing about the resulting page looks
broken, and every video that creator appears in inherits the wrong authority. For sixty to
a hundred creators, confirming by hand once is an hour of work that removes an entire class
of silent error.
"""
from __future__ import annotations

import argparse
import datetime as _dt
import io
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
CREATORS = os.path.join(HERE, "content", "creators")
SEED = os.path.join(HERE, "tools", "seed", "creators.psv")

DIVISIONS = ["CHA", "ALS", "ADV", "INT", "NOV", "NEW"]

KEY_ORDER = [
    "id", "type", "name", "aliases", "wsdc_id", "wsdc_status", "wsdc", "wsdc_evidence",
    "authority", "authority_override", "demote", "demote_reason", "channels", "links",
    "note", "added", "updated", "generated",
]


def load(slug: str) -> tuple[dict, str]:
    path = os.path.join(CREATORS, slug + ".md")
    if not os.path.isfile(path):
        raise SystemExit("no such creator: %s (run `seed` first, or add the file)" % slug)
    return wcsyaml.read(path)


def save(slug: str, front: dict, body: str) -> None:
    os.makedirs(CREATORS, exist_ok=True)
    front["updated"] = _dt.date.today().isoformat()
    ordered = {k: front[k] for k in KEY_ORDER if k in front}
    for k, v in front.items():
        ordered.setdefault(k, v)
    wcsyaml.write(os.path.join(CREATORS, slug + ".md"), ordered, body)


def all_creators() -> dict[str, dict]:
    out = {}
    if not os.path.isdir(CREATORS):
        return out
    for name in sorted(os.listdir(CREATORS)):
        if name.endswith(".md"):
            front, _ = wcsyaml.read(os.path.join(CREATORS, name))
            out[name[:-3]] = front
    return out


def body_for(front: dict) -> str:
    status = front.get("wsdc_status", "unconfirmed")
    if status == "confirmed":
        note = ("WSDC id %s confirmed against the registry on %s."
                % (front.get("wsdc_id"), (front.get("wsdc_evidence") or {}).get("confirmed_at", "?")))
    elif status == "none":
        note = "Looked up and not present in the WSDC registry."
    elif status == "ambiguous":
        note = "Several plausible dancers share this name. Needs a human decision."
    else:
        note = ("No WSDC id confirmed yet. Authority is provisional until someone binds an "
                "id with `wsdc_sync.py confirm`.")
    return "# %s\n\n%s\n" % (front.get("name", front.get("id", "")), note)


# ------------------------------------------------------------------------ commands

def cmd_seed(args) -> int:
    """Create creator records from the hand-authored seed list. Never clobbers."""
    if not os.path.isfile(SEED):
        raise SystemExit("no seed file at %s" % SEED)
    created, skipped = [], []
    today = _dt.date.today().isoformat()
    with io.open(SEED, encoding="utf-8") as fh:
        for line in fh:
            line = line.strip()
            if not line or line.startswith("#"):
                continue
            parts = [p.strip() for p in line.split("|")]
            while len(parts) < 5:
                parts.append("")
            slug, name, aliases, demote, note = parts[:5]
            if not slug:
                continue
            if os.path.isfile(os.path.join(CREATORS, slug + ".md")):
                skipped.append(slug)
                continue
            front = {
                "id": slug,
                "type": "creator",
                "name": name or slug,
                "aliases": [a.strip() for a in aliases.split(";") if a.strip()],
                "wsdc_id": None,
                "wsdc_status": "unconfirmed",
                "wsdc": {},
                "authority": None,
                "authority_override": None,
                "demote": demote.lower() in ("y", "yes", "true", "1"),
                "channels": [],
                "links": [],
                "added": today,
                "generated": True,
            }
            if demote.lower() in ("y", "yes", "true", "1") and note:
                front["demote_reason"] = note
            elif note:
                front["note"] = note
            save(slug, front, body_for(front))
            created.append(slug)
    print("created %d, skipped %d already present" % (len(created), len(skipped)))
    if created:
        print("  " + ", ".join(created))
    print("\nEvery new record is `unconfirmed`: authority is provisional until you bind a")
    print("WSDC id. `wsdc_sync.py pending` lists them.")
    return 0


def cmd_lookup(args) -> int:
    from wsdc import Wsdc, WsdcError, summarise, top_division
    try:
        summary = summarise(Wsdc().fetch(args.wsdc_id))
    except WsdcError as exc:
        print("not found: %s" % exc)
        return 1
    division, points = top_division(summary)
    print("id %s: %s" % (summary.get("wsdc_id"), summary.get("name")))
    print("top division: %s (%d pts)" % (division or "none", points))
    for role in ("leader", "follower"):
        row = summary.get(role) or {}
        if any(row.values()):
            print("  %-9s %s" % (role, "  ".join("%s %d" % (d, row.get(d, 0)) for d in DIVISIONS)))
        best = summary.get(role + "_best")
        if best:
            print("             best: %s, %s (%s) - %s, %s pts"
                  % (best["event"], best["date"], best["division"], best["result"], best["points"]))
    print("\nIf this is the right person:")
    print("    python tools/wsdc_sync.py confirm <slug> %s" % args.wsdc_id)
    return 0


def cmd_confirm(args) -> int:
    from wsdc import Wsdc, WsdcError, summarise, top_division
    front, _ = load(args.slug)
    try:
        summary = summarise(Wsdc().fetch(args.wsdc_id))
    except WsdcError as exc:
        print("not found: %s" % exc)
        return 1

    division, points = top_division(summary)
    registry_name = summary.get("name") or "?"
    print("creator:  %s (%s)" % (front.get("name"), args.slug))
    print("registry: %s (id %s) - %s, %d pts" % (registry_name, args.wsdc_id, division or "none", points))

    if not args.yes:
        answer = input("bind this id to this creator? [y/N] ").strip().lower()
        if answer != "y":
            print("left unconfirmed")
            return 1

    best = summary.get("leader_best") or summary.get("follower_best")
    front["wsdc_id"] = int(args.wsdc_id)
    front["wsdc_status"] = "confirmed"
    front["wsdc"] = {
        "leader": summary.get("leader") or {},
        "follower": summary.get("follower") or {},
        "fetched": _dt.date.today().isoformat(),
    }
    # Why we believe this id is this person, kept so the judgment can be re-checked later.
    front["wsdc_evidence"] = {
        "registry_name": registry_name,
        "confirmed_at": _dt.date.today().isoformat(),
        "top_division": division or "none",
        "top_points": points,
        "best_event": (best or {}).get("event"),
        "best_date": (best or {}).get("date"),
    }
    front["generated"] = False
    save(args.slug, front, body_for(front))
    print("confirmed")
    return 0


def cmd_none(args) -> int:
    front, _ = load(args.slug)
    front["wsdc_status"] = "none"
    front["wsdc_id"] = None
    front["wsdc"] = {}
    front["generated"] = False
    save(args.slug, front, body_for(front))
    print("%s recorded as not present in the registry" % args.slug)
    return 0


def cmd_refresh(args) -> int:
    from wsdc import Wsdc, WsdcError, summarise
    client = Wsdc()
    done, failed = 0, []
    for slug, front in all_creators().items():
        if front.get("wsdc_status") != "confirmed" or not front.get("wsdc_id"):
            continue
        try:
            summary = summarise(client.fetch(int(front["wsdc_id"])))
        except (WsdcError, OSError) as exc:
            failed.append((slug, str(exc)))
            continue
        front["wsdc"] = {
            "leader": summary.get("leader") or {},
            "follower": summary.get("follower") or {},
            "fetched": _dt.date.today().isoformat(),
        }
        save(slug, front, body_for(front))
        done += 1
        print("  %-28s refreshed" % slug)
    print("refreshed %d" % done)
    for slug, error in failed:
        print("  FAILED %-26s %s" % (slug, error))
    return 0


def cmd_merge(args) -> int:
    """Fold one creator record into another and repoint everything that referenced it.

    Two sources produced these records — a hand-written seed and the workshop archive — so
    "Jordan Frisbee" and a bare "Jordan" can both exist and be the same person. Left alone
    they split his videos, and therefore his authority, across two records.

    The merge refuses when the evidence disagrees. A first-name record whose partners are
    not a subset of the target's partners is probably a *different* person with the same
    name, and silently folding those together is the same invisible error as binding a
    wrong WSDC id.
    """
    source_front, _ = load(args.source)
    target_front, _ = load(args.target)

    src_partners = set(source_front.get("partners") or [])
    dst_partners = set(target_front.get("partners") or [])

    # Conflicting evidence: both records know who they dance with, and it is nobody in
    # common. Two different people with the same first name.
    if src_partners and dst_partners and not (src_partners & dst_partners) and not args.force:
        print("refusing: %s dances with %s, %s with %s — no overlap."
              % (args.source, ", ".join(sorted(src_partners)),
                 args.target, ", ".join(sorted(dst_partners))))
        print("Those look like two different people. --force if they are not.")
        return 1

    # The source itself may be two people. A bare first name seen with two different
    # partners is exactly the shape of "Tatiana danced with Jordan" and "Tatiana danced
    # with Christopher" being two women — and folding both into one record would hand one
    # of them the other's authority. An absent partner list on the target proves nothing
    # either way, so it cannot resolve this.
    if len(src_partners) > 1 and not args.force:
        print("refusing: %s is seen with %d different partners (%s)."
              % (args.source, len(src_partners), ", ".join(sorted(src_partners))))
        print("That name may cover more than one person. Check which of them %s is,"
              % args.target)
        print("then re-run with --force, or split the record first.")
        return 1

    if source_front.get("wsdc_id") and target_front.get("wsdc_id") \
            and source_front["wsdc_id"] != target_front["wsdc_id"]:
        print("refusing: the two records carry different confirmed WSDC ids.")
        return 1

    aliases = set(target_front.get("aliases") or [])
    aliases.add(source_front.get("name") or args.source)
    aliases.discard(target_front.get("name"))
    target_front["aliases"] = sorted(a for a in aliases if a)
    target_front["partners"] = sorted(dst_partners | src_partners)
    if source_front.get("wsdc_id") and not target_front.get("wsdc_id"):
        for field in ("wsdc_id", "wsdc_status", "wsdc", "wsdc_evidence"):
            if field in source_front:
                target_front[field] = source_front[field]
    target_front["generated"] = False

    # Repoint every video that credited the old record.
    videos_dir = os.path.join(HERE, "content", "videos")
    repointed = 0
    if os.path.isdir(videos_dir):
        for name in sorted(os.listdir(videos_dir)):
            if not name.endswith(".md"):
                continue
            path = os.path.join(videos_dir, name)
            front, body = wcsyaml.read(path)
            people = front.get("creators") or []
            if args.source not in people:
                continue
            front["creators"] = sorted({args.target if p == args.source else p for p in people})
            wcsyaml.write(path, front, body)
            repointed += 1

    if not args.dry_run:
        save(args.target, target_front, body_for(target_front))
        os.remove(os.path.join(CREATORS, args.source + ".md"))
    verb = "would merge" if args.dry_run else "merged"
    print("%s %s into %s (%d video reference(s) repointed)"
          % (verb, args.source, args.target, repointed))
    return 0


def cmd_list(args) -> int:
    creators = all_creators()
    if not creators:
        print("no creators yet - run `python tools/wsdc_sync.py seed`")
        return 0
    print("%-30s %-12s %-8s %s" % ("slug", "status", "id", "standing"))
    for slug, front in creators.items():
        wsdc = front.get("wsdc") or {}
        standing = "-"
        for division in DIVISIONS:
            points = max(int((wsdc.get("leader") or {}).get(division, 0) or 0),
                         int((wsdc.get("follower") or {}).get(division, 0) or 0))
            if points:
                standing = "%s %d pts" % (division, points)
                break
        flag = "  [demoted]" if front.get("demote") else ""
        print("%-30s %-12s %-8s %s%s" % (
            slug, front.get("wsdc_status", "?"), front.get("wsdc_id") or "-", standing, flag))
    return 0


def cmd_pending(args) -> int:
    pending = [(s, f) for s, f in all_creators().items()
               if f.get("wsdc_status", "unconfirmed") in ("unconfirmed", "ambiguous")]
    if not pending:
        print("nothing pending - every creator has a confirmed status")
        return 0
    print("%d creator(s) need a WSDC id confirmed. Their authority is provisional until" % len(pending))
    print("they do, and they are flagged as such wherever they are ranked.\n")
    for slug, front in pending:
        print("  %-30s %s" % (slug, front.get("name", "")))
    print("\n  python tools/wsdc_sync.py lookup <id>")
    print("  python tools/wsdc_sync.py confirm <slug> <id>")
    return 0


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="command", required=True)
    sub.add_parser("seed").set_defaults(func=cmd_seed)
    sub.add_parser("list").set_defaults(func=cmd_list)
    sub.add_parser("pending").set_defaults(func=cmd_pending)
    sub.add_parser("refresh").set_defaults(func=cmd_refresh)

    p = sub.add_parser("lookup")
    p.add_argument("wsdc_id", type=int)
    p.set_defaults(func=cmd_lookup)

    p = sub.add_parser("confirm")
    p.add_argument("slug")
    p.add_argument("wsdc_id", type=int)
    p.add_argument("--yes", action="store_true", help="skip the prompt (for scripted use)")
    p.set_defaults(func=cmd_confirm)

    p = sub.add_parser("merge")
    p.add_argument("source"); p.add_argument("target")
    p.add_argument("--dry-run", action="store_true")
    p.add_argument("--force", action="store_true", help="merge despite unexplained partners")
    p.set_defaults(func=cmd_merge)

    p = sub.add_parser("none")
    p.add_argument("slug")
    p.set_defaults(func=cmd_none)

    args = ap.parse_args()
    return args.func(args)


if __name__ == "__main__":
    raise SystemExit(main())
