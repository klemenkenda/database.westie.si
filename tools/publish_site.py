#!/usr/bin/env python
"""Copy the exported Next.js site into public/, the Apache document root.

    cd web && npx next build
    python tools/publish_site.py

public/ holds two things that must not touch each other: the PHP API, which is committed
source, and the exported site, which is build output. So this copies the export in and
deletes stale files from previous builds — while never looking inside public/api/.

KEEP below is the whole safety mechanism. Anything named there survives a publish; the
script refuses to run if the export would collide with it.
"""
from __future__ import annotations

import argparse
import filecmp
import os
import shutil
import sys

# YouTube titles carry emoji, and Windows consoles default to cp1252, where printing one
# raises UnicodeEncodeError mid-run. Replace rather than crash: a mangled character in a
# progress line is not worth losing an ingest over.
try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
except (AttributeError, ValueError):
    pass

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
EXPORT = os.path.join(HERE, "web", "out")
PUBLIC = os.path.join(HERE, "public")

#: Committed source living in the document root. Never written, never deleted.
KEEP = {"api"}


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    if not os.path.isdir(EXPORT):
        raise SystemExit("no export at %s - run `cd web && npx next build` first" % EXPORT)

    collisions = KEEP & set(os.listdir(EXPORT))
    if collisions:
        raise SystemExit(
            "the export contains %s, which would overwrite committed source in public/. "
            "Refusing." % ", ".join(sorted(collisions)))

    copied = removed = unchanged = 0

    exported: set[str] = set()
    for root, _dirs, files in os.walk(EXPORT):
        rel_dir = os.path.relpath(root, EXPORT)
        rel_dir = "" if rel_dir == "." else rel_dir
        for name in files:
            rel = os.path.join(rel_dir, name).replace("\\", "/")
            exported.add(rel)
            source = os.path.join(root, name)
            target = os.path.join(PUBLIC, rel)
            if os.path.isfile(target) and filecmp.cmp(source, target, shallow=False):
                unchanged += 1
                continue
            if not args.dry_run:
                os.makedirs(os.path.dirname(target), exist_ok=True)
                shutil.copy2(source, target)
            copied += 1

    # Drop files from an earlier build that the current one no longer produces, so a
    # renamed page does not linger at its old url.
    for root, dirs, files in os.walk(PUBLIC, topdown=True):
        rel_root = os.path.relpath(root, PUBLIC)
        rel_root = "" if rel_root == "." else rel_root
        if rel_root == "":
            dirs[:] = [d for d in dirs if d not in KEEP]
        for name in files:
            rel = os.path.join(rel_root, name).replace("\\", "/")
            if rel.split("/")[0] in KEEP or rel in exported:
                continue
            if not args.dry_run:
                os.remove(os.path.join(root, name))
            removed += 1

    verb = "would copy" if args.dry_run else "copied"
    print("%s %d file(s), %d unchanged, %d stale removed" % (verb, copied, unchanged, removed))
    print("public/api/ untouched.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
