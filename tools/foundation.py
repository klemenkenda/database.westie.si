#!/usr/bin/env python
"""Apply and validate content/foundation.yml — the hand-authored root of the graph.

    python tools/foundation.py                 # dry run: the diff, nothing written
    python tools/foundation.py --apply         # write it
    python tools/foundation.py --check         # validate only, exit 1 on a broken promise
    python tools/foundation.py --json          # machine-readable, for the web studio

The foundation is the one part of the concept graph that is not imported, so it is the one
part allowed to write `trust: verified`. Everything it touches gets an edge with an origin
of `foundation@<date>` and a confidence of 1.0.

Three rules keep re-running it safe, and they are the same rules PLAN.md §5 sets for
importing from upstream — applied to our own authoring, because there is no reason our
hand is more trustworthy than anyone else's:

1. **Additive by default.** An edge already in a concept file that the foundation does not
   mention is *kept* and reported as `extra`, never dropped. Removal happens only where an
   entry says `replaces_requires`, and only for the ids it names.
2. **Never clobber a human.** A concept whose status is not `draft`, or whose edge is
   already `verified` by someone other than the foundation, is left alone and reported as
   `held`. The foundation proposes; it does not overrule a later review.
3. **Bodies are never rewritten.** New concept files get a generated body; existing ones
   keep whatever prose is there. Frontmatter is merged key by key.

`--check` asserts the `expects:` block. Those are the properties that make the graph usable
rather than merely parseable — no cycles, no dangling ids, no level inversions, no orphans,
every concept reachable down to a root, and edges that never point from an earlier tier to
a later one. A graph can satisfy graph_check.py and still be unusable if the bottom tier
does not exist, which is exactly the state the import left it in.
"""
from __future__ import annotations

import argparse
import collections
import datetime as _dt
import io
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
except (AttributeError, ValueError):
    pass

import yaml  # noqa: E402

import wcsyaml  # noqa: E402

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CONTENT = os.path.join(HERE, "content")
CONCEPTS = os.path.join(CONTENT, "concepts")
SPEC = os.path.join(CONTENT, "foundation.yml")
AUDIT = os.path.join(CONTENT, ".audit", "foundation.json")

TODAY = _dt.date.today().isoformat()


# --------------------------------------------------------------------------- loading

def load_spec() -> dict:
    with io.open(SPEC, encoding="utf-8") as fh:
        spec = yaml.safe_load(fh) or {}
    if not spec.get("concepts"):
        raise SystemExit("foundation.yml has no concepts")
    return spec


def load_concepts() -> dict[str, tuple[dict, str]]:
    out: dict[str, tuple[dict, str]] = {}
    if not os.path.isdir(CONCEPTS):
        return out
    for name in sorted(os.listdir(CONCEPTS)):
        if name.endswith(".md"):
            out[name[:-3]] = wcsyaml.read(os.path.join(CONCEPTS, name))
    return out


def edge_ids(front: dict) -> list[str]:
    out = []
    for raw in front.get("requires") or []:
        if isinstance(raw, str):
            out.append(raw)
        elif isinstance(raw, dict) and raw.get("id"):
            out.append(raw["id"])
    return out


def edge_map(front: dict) -> dict[str, dict]:
    out: dict[str, dict] = {}
    for raw in front.get("requires") or []:
        if isinstance(raw, str):
            raw = {"id": raw, "trust": "imported", "confidence": 0.5, "strength": "required"}
        if isinstance(raw, dict) and raw.get("id"):
            out[raw["id"]] = dict(raw)
    return out


# --------------------------------------------------------------------------- body text

def body_for(entry: dict) -> str:
    """The generated body for a concept the foundation creates.

    A heading, the meta line, and the spec's summary as a plain description. Nothing else:
    a concept file describes what the concept *is*, and teaching points, drills and related
    patterns belong elsewhere. The earlier version of this emitted the summary under four
    empty headings, which made an unwritten file look finished and left every concept in
    content/ carrying three "-" bullets nobody filled in.

    The summary is the claim the spec is making and belongs in the file. Writing more than
    that here would mean auto-generating prose about a dance the spec does not describe.
    """
    tier = entry.get("tier", "")
    summary = (entry.get("summary") or "").strip().replace("\n", " ")
    level = entry.get("level")
    lines = [
        "# %s" % entry.get("title", entry["id"]),
        "",
        "*%s · level %s · foundation tier `%s`*" % (
            (entry.get("category") or "concept").capitalize(), level, tier),
        "",
        summary or "_To write._",
        "",
    ]
    return "\n".join(lines)


# --------------------------------------------------------------------------- applying

def plan(spec: dict, concepts: dict[str, tuple[dict, str]]) -> dict:
    """Compute what would change. Writes nothing."""
    origin = spec.get("origin") or ("foundation@%s" % TODAY)
    tier_order = {t: i for i, t in enumerate((spec.get("expects") or {}).get("tier_order") or [])}

    created, updated, held, conflicts, unknown_targets = [], [], [], [], []
    files: dict[str, tuple[dict, str]] = {}

    known = set(concepts) | {e["id"] for e in spec["concepts"]}

    for entry in spec["concepts"]:
        key = entry["id"]
        wanted = list(entry.get("requires") or [])
        for target in wanted:
            if target not in known:
                unknown_targets.append({"concept": key, "requires": target})

        is_new = key not in concepts
        if is_new and not entry.get("new"):
            # The spec says this concept already exists and it does not. Louder than a
            # silent create, because it means the spec and the content have drifted.
            unknown_targets.append({"concept": key, "requires": "<self: declared existing but missing>"})

        front, body = (dict(concepts[key][0]), concepts[key][1]) if not is_new else ({}, "")

        # Rule 2: a reviewed concept is not overruled by the spec.
        #
        # "Reviewed" means reviewed by someone *other than this file*. The first version of
        # this test compared `verified_by` against the literal "foundation" and so held
        # every concept the previous run had just written, because the run stamps them with
        # the spec's author. A guard that blocks its own second run is not idempotent, it
        # is broken. The marker is `foundation_tier`, which only this tool ever writes, plus
        # `origin` for concepts it created outright. An imported concept keeps its
        # `import:teaching@...` origin so the provenance is not laundered.
        status = front.get("status", "draft")
        ours = bool(front.get("foundation_tier")) or str(front.get("origin") or "").startswith("foundation")
        reviewed_elsewhere = status not in ("draft", "", None) and not ours
        if not is_new and reviewed_elsewhere:
            held.append({"concept": key, "reason": "status=%s origin=%s" % (status, front.get("origin"))})
            continue

        before_edges = edge_map(front)
        changes: list[str] = []

        if is_new:
            front = {
                "id": key,
                "type": "concept",
                "title": entry.get("title", key.replace("-", " ").capitalize()),
                "category": entry.get("category", "technique"),
                "level": entry.get("level", 0),
                "level_trust": "verified",
                "tags": sorted(set(entry.get("tags") or []) | {entry.get("tier", "foundation"), "foundation"}),
                "aliases": list(entry.get("aliases") or []),
                "related": [],
                "requires": [],
                "videos": [],
                "foundation_tier": entry.get("tier"),
                "trust": "verified",
                "origin": origin,
                "status": "review",
                "verified_by": spec.get("author") or "foundation",
                "verified_at": TODAY,
                "added": TODAY,
                "updated": TODAY,
                "generated": False,
            }
            body = body_for(entry)
            changes.append("created")
        else:
            if entry.get("level") is not None and front.get("level") != entry["level"]:
                changes.append("level %s -> %s" % (front.get("level"), entry["level"]))
                front["level"] = entry["level"]
                front["level_trust"] = "verified"
            if entry.get("category") and front.get("category") != entry["category"]:
                changes.append("category %s -> %s" % (front.get("category"), entry["category"]))
                front["category"] = entry["category"]
            if front.get("foundation_tier") != entry.get("tier"):
                changes.append("tier -> %s" % entry.get("tier"))
                front["foundation_tier"] = entry.get("tier")
            was_aliases = list(front.get("aliases") or [])
            merged_aliases = sorted(set(was_aliases) | set(entry.get("aliases") or []))
            added = len(merged_aliases) - len(was_aliases)
            if added > 0:
                changes.append("aliases +%d" % added)
            if merged_aliases != was_aliases:
                front["aliases"] = merged_aliases
            tags = sorted(set(front.get("tags") or []) | {"foundation"})
            if tags != list(front.get("tags") or []):
                front["tags"] = tags

        # ---- edges
        edges = dict(before_edges)

        # Rule 1's one exception: named removals only.
        for drop in entry.get("replaces_requires") or []:
            if drop in edges and drop not in wanted:
                if edges[drop].get("trust") == "verified" and edges[drop].get("origin", "").startswith("foundation") is False:
                    conflicts.append({"concept": key, "edge": drop, "reason": "verified elsewhere, not removed"})
                else:
                    edges.pop(drop)
                    changes.append("-%s" % drop)

        for target in wanted:
            existing = edges.get(target)
            if existing and existing.get("trust") == "verified" and not str(existing.get("origin", "")).startswith("foundation"):
                conflicts.append({"concept": key, "edge": target, "reason": "verified elsewhere, left as is"})
                continue
            edge = {
                "id": target,
                "origin": origin,
                "trust": "verified",
                "confidence": 1.0,
                "strength": "required",
            }
            if existing != edge:
                changes.append(("+%s" if existing is None else "~%s") % target)
            edges[target] = edge

        # Anything left over that the foundation did not assert. Kept, and surfaced.
        for target, edge in edges.items():
            if target not in wanted and edge.get("trust") != "verified":
                conflicts.append({
                    "concept": key, "edge": target, "reason": "extra imported edge, kept",
                    "trust": edge.get("trust"),
                })

        # Deterministic order, so re-running produces no diff.
        front["requires"] = [edges[k] for k in sorted(edges)]
        if not is_new:
            front["updated"] = TODAY
            front.setdefault("trust", "verified")
            if front.get("status") == "draft":
                front["status"] = "review"
            front["verified_by"] = spec.get("author") or "foundation"
            front["verified_at"] = TODAY
            front["generated"] = False

        files[key] = (front, body)
        record = {"concept": key, "tier": entry.get("tier"), "changes": changes}
        (created if is_new else updated).append(record)

    # ---- relevels: standalone level corrections, outside the tier model.
    #
    # Separate from `concepts:` on purpose. These concepts are not part of the foundation
    # and get no tier and no verified edges — the only claim being made is about their
    # level, and `from:` makes that claim falsifiable: if the file has drifted to some
    # other value, we report it rather than overwriting whatever is there now.
    relevelled = []
    for entry in spec.get("relevels") or []:
        key = entry["id"]
        if key not in concepts and key not in files:
            unknown_targets.append({"concept": key, "requires": "<relevel target missing>"})
            continue
        front, body = files.get(key) or (dict(concepts[key][0]), concepts[key][1])
        current = front.get("level")
        expected_from = entry.get("from")
        if expected_from is not None and current != expected_from and current != entry["to"]:
            conflicts.append({
                "concept": key, "edge": "level",
                "reason": "expected level %s, found %s — relevel skipped" % (expected_from, current),
            })
            continue
        if current == entry["to"]:
            continue
        front["level"] = entry["to"]
        front["level_trust"] = "verified"
        front["level_origin"] = origin
        front["updated"] = TODAY
        files[key] = (front, body)
        relevelled.append({"concept": key, "changes": ["level %s -> %s" % (current, entry["to"])]})

    return {
        "origin": origin,
        "created": created,
        "relevelled": relevelled,
        "updated": [u for u in updated if u["changes"]],
        "unchanged": [u["concept"] for u in updated if not u["changes"]],
        "held": held,
        "conflicts": conflicts,
        "unknown_targets": unknown_targets,
        "files": files,
        "tier_order": tier_order,
    }


def write(files: dict[str, tuple[dict, str]]) -> int:
    os.makedirs(CONCEPTS, exist_ok=True)
    for key, (front, body) in files.items():
        path = os.path.join(CONCEPTS, key + ".md")
        if not body and os.path.isfile(path):
            _, body = wcsyaml.read(path)
        wcsyaml.write(path, front, body)
    return len(files)


# -------------------------------------------------------------------------- validating

def validate(spec: dict, concepts: dict[str, tuple[dict, str]]) -> dict:
    """Check the `expects:` block against the graph as it stands on disk."""
    expects = spec.get("expects") or {}
    fronts = {k: v[0] for k, v in concepts.items()}
    edges = {k: [e for e in edge_ids(f)] for k, f in fronts.items()}
    tiers = {k: f.get("foundation_tier") for k, f in fronts.items()}

    # Which tiers each tier is allowed to draw on. A tier may always draw on itself.
    allowed: dict[str, set] = {}
    for t in spec.get("tiers") or []:
        allowed[t["id"]] = set(t.get("depends") or []) | {t["id"]}

    reverse = collections.defaultdict(list)
    dangling, total = [], 0
    for key, targets in edges.items():
        for t in targets:
            total += 1
            if t in fronts:
                reverse[t].append(key)
            else:
                dangling.append({"concept": key, "requires": t})

    # cycles, iteratively
    WHITE, GREY, BLACK = 0, 1, 2
    color = dict.fromkeys(fronts, WHITE)
    cycles, stack = [], []
    for root in list(fronts):
        if color[root] != WHITE:
            continue
        work = [(root, iter([t for t in edges[root] if t in fronts]))]
        color[root] = GREY
        stack.append(root)
        while work:
            node, it = work[-1]
            advanced = False
            for nxt in it:
                if color.get(nxt) == GREY and nxt in stack:
                    cycles.append(stack[stack.index(nxt):] + [nxt])
                elif color.get(nxt) == WHITE:
                    color[nxt] = GREY
                    stack.append(nxt)
                    work.append((nxt, iter([t for t in edges[nxt] if t in fronts])))
                    advanced = True
                    break
            if not advanced:
                work.pop()
                color[node] = BLACK
                if stack and stack[-1] == node:
                    stack.pop()

    inversions = []
    for key, front in fronts.items():
        level = front.get("level")
        if not isinstance(level, int):
            continue
        for t in edges[key]:
            req = fronts.get(t, {}).get("level")
            if isinstance(req, int) and req > level:
                inversions.append({"concept": key, "level": level, "requires": t, "requires_level": req})

    orphans = [k for k in fronts if not edges[k] and not reverse[k]]

    # Tier discipline: an edge may only point into a tier its source tier declares.
    #
    # Deliberately not "earlier tier to later tier". That test rejected two correct edges
    # (pulse -> downbeat-and-upbeat, open-position -> the-slot) because it assumed the
    # tiers form a line. They form a DAG, so each tier names what it may reach into and a
    # violation is an undeclared crossing. Cycle safety is the concept-level check's job,
    # not this one's.
    tier_violations = []
    for key, targets in edges.items():
        src = tiers.get(key)
        if src is None or src not in allowed:
            continue
        for t in targets:
            dst = tiers.get(t)
            if dst is not None and dst not in allowed[src]:
                tier_violations.append({
                    "concept": key, "tier": src,
                    "requires": t, "requires_tier": dst,
                    "reason": "tier '%s' does not declare '%s'" % (src, dst),
                })

    # Reachability: walking prerequisites from any concept must terminate at a declared
    # root. A concept that bottoms out somewhere else is resting on an undeclared axiom.
    declared_roots = set(expects.get("roots") or [])
    bottoms: dict[str, set] = {}

    def bottom(key: str, seen: frozenset = frozenset()) -> set:
        if key in bottoms:
            return bottoms[key]
        if key in seen:
            return set()
        targets = [t for t in edges.get(key, []) if t in fronts]
        if not targets:
            out = {key}
        else:
            out = set()
            for t in targets:
                out |= bottom(t, seen | {key})
        bottoms[key] = out
        return out

    unrooted = []
    for key in fronts:
        b = bottom(key)
        if declared_roots and not (b & declared_roots) and key not in declared_roots:
            unrooted.append({"concept": key, "bottoms_out_at": sorted(b)[:4]})

    density = round(total / len(fronts), 2) if fronts else 0.0

    # Density inside the foundation, which is the only part this file is answerable for.
    in_tier = [k for k in fronts if tiers.get(k)]
    tier_edges = sum(len(edges[k]) for k in in_tier)
    foundation_density = round(tier_edges / len(in_tier), 2) if in_tier else 0.0
    min_density = float(expects.get("min_foundation_density") or 0)

    trust = collections.Counter()
    for f in fronts.values():
        for raw in f.get("requires") or []:
            trust[raw.get("trust", "imported") if isinstance(raw, dict) else "imported"] += 1

    coverage = {
        "in_foundation": sum(1 for f in fronts.values() if f.get("foundation_tier")),
        "of": len(fronts),
        "by_tier": dict(collections.Counter(
            t for t in tiers.values() if t)),
    }

    failures = []
    if expects.get("no_cycles") and cycles:
        failures.append("cycles: %d" % len(cycles))
    if expects.get("no_dangling") and dangling:
        failures.append("dangling: %d" % len(dangling))
    if expects.get("no_level_inversions") and inversions:
        failures.append("level inversions: %d" % len(inversions))
    if expects.get("no_orphans") and orphans:
        failures.append("orphans: %d" % len(orphans))
    if expects.get("every_concept_reaches_a_root") and unrooted:
        failures.append("unrooted: %d" % len(unrooted))
    if tier_violations:
        failures.append("tier violations: %d" % len(tier_violations))
    if min_density and foundation_density < min_density:
        failures.append("foundation density %.2f below the expected %.2f"
                        % (foundation_density, min_density))
    for root in declared_roots:
        if root not in fronts:
            failures.append("declared root missing: %s" % root)
        elif edges.get(root):
            failures.append("declared root %s has prerequisites" % root)

    return {
        "generated": _dt.datetime.now().isoformat(timespec="seconds"),
        "concepts": len(fronts),
        "edges": total,
        "density": density,
        "foundation_density": foundation_density,
        "trust": dict(trust),
        "coverage": coverage,
        "cycles": cycles,
        "dangling": dangling,
        "inversions": inversions,
        "orphans": orphans,
        "tier_violations": tier_violations,
        "unrooted": unrooted,
        "roots": sorted(k for k in fronts if not edges[k]),
        "failures": failures,
        "ok": not failures,
    }


# -------------------------------------------------------------------------------- cli

def render_plan(result: dict) -> None:
    print("foundation %s" % result["origin"])
    print("  create   %d" % len(result["created"]))
    print("  update   %d" % len(result["updated"]))
    print("  relevel  %d" % len(result.get("relevelled") or []))
    print("  no-op    %d" % len(result["unchanged"]))
    print("  held     %d" % len(result["held"]))
    print("  notes    %d" % len(result["conflicts"]))
    if result["unknown_targets"]:
        print("\nUNKNOWN TARGETS (would be dangling)")
        for u in result["unknown_targets"]:
            print("  %-36s -> %s" % (u["concept"], u["requires"]))
    if result["created"]:
        print("\nCREATE")
        for c in result["created"]:
            print("  %-36s %s" % (c["concept"], c["tier"]))
    if result["updated"]:
        print("\nUPDATE")
        for c in result["updated"]:
            print("  %-36s %s" % (c["concept"], " ".join(c["changes"])))
    if result.get("relevelled"):
        print("\nRELEVEL")
        for c in result["relevelled"]:
            print("  %-36s %s" % (c["concept"], " ".join(c["changes"])))
    if result["held"]:
        print("\nHELD (reviewed by a human, left alone)")
        for h in result["held"]:
            print("  %-36s %s" % (h["concept"], h["reason"]))
    if result["conflicts"]:
        print("\nNOTES")
        for c in result["conflicts"][:40]:
            print("  %-36s %-28s %s" % (c["concept"], c["edge"], c["reason"]))
        if len(result["conflicts"]) > 40:
            print("  ... and %d more" % (len(result["conflicts"]) - 40))


def render_validation(v: dict) -> None:
    print("\ngraph  %d concepts | %d edges | density %.2f global, %.2f inside the foundation"
          % (v["concepts"], v["edges"], v["density"], v["foundation_density"]))
    print("trust  " + " | ".join("%s %d" % (k, n) for k, n in sorted(v["trust"].items())))
    cov = v["coverage"]
    print("found. %d of %d concepts placed in a tier %s" % (
        cov["in_foundation"], cov["of"],
        "(" + ", ".join("%s %d" % kv for kv in sorted(cov["by_tier"].items())) + ")" if cov["by_tier"] else ""))
    print("roots  " + (", ".join(v["roots"]) if v["roots"] else "none"))
    for name in ("cycles", "dangling", "inversions", "orphans", "tier_violations", "unrooted"):
        items = v[name]
        print("  %-16s %d" % (name, len(items)))
        for item in items[:6]:
            print("      %s" % (item if not isinstance(item, dict) else
                                " ".join("%s=%s" % kv for kv in item.items())))
        if len(items) > 6:
            print("      ... and %d more" % (len(items) - 6))
    print("\n%s" % ("OK: the foundation holds." if v["ok"] else "FAIL: " + "; ".join(v["failures"])))


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--apply", action="store_true", help="write the changes")
    ap.add_argument("--check", action="store_true", help="validate the graph on disk only")
    ap.add_argument("--json", action="store_true", help="machine-readable output")
    args = ap.parse_args()

    spec = load_spec()
    concepts = load_concepts()

    if args.check:
        v = validate(spec, concepts)
    else:
        result = plan(spec, concepts)
        if args.apply:
            write(result["files"])
            concepts = load_concepts()
        v = validate(spec, concepts)
        v["plan"] = {k: result[k] for k in
                     ("origin", "created", "relevelled", "updated", "unchanged", "held",
                      "conflicts", "unknown_targets")}
        v["applied"] = bool(args.apply)

    os.makedirs(os.path.dirname(AUDIT), exist_ok=True)
    with io.open(AUDIT, "w", encoding="utf-8", newline="\n") as fh:
        json.dump(v, fh, indent=2, ensure_ascii=False)
        fh.write("\n")

    if args.json:
        print(json.dumps(v, indent=2, ensure_ascii=False))
    else:
        if "plan" in v:
            render_plan(v["plan"])
            print("\n" + ("applied." if v["applied"] else "dry run — nothing written. Re-run with --apply."))
        render_validation(v)
        print("audit written to content/.audit/foundation.json")

    return 0 if v["ok"] or not (args.check or args.apply) else 1


if __name__ == "__main__":
    raise SystemExit(main())
