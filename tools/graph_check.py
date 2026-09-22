#!/usr/bin/env python
"""Audit the concept graph and write the findings as a work queue.

    python tools/graph_check.py                 # human-readable report
    python tools/graph_check.py --json          # the raw audit
    python tools/graph_check.py --strict        # exit 1 on a build-breaking finding

Writes content/.audit/graph.json on every run. The API serves the same audit from
Graph.php; tools/api_test.php asserts the two agree, because two implementations of one
rule is how a rule quietly stops being one.

Only cycles and dangling references break a build. They make the path algorithms *wrong*
rather than merely unreviewed, and a learning path that routes someone in a circle is a
bug in a way that an unreviewed level is not. Everything else is a judgment call, so it
leaves a queue entry rather than a failure.
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
import wcsyaml  # noqa: E402

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CONCEPTS = os.path.join(HERE, "content", "concepts")
AUDIT = os.path.join(HERE, "content", ".audit", "graph.json")

TRUST_ORDER = ["verified", "corroborated", "imported", "disputed"]


def load() -> dict[str, dict]:
    out = {}
    if not os.path.isdir(CONCEPTS):
        return out
    for name in sorted(os.listdir(CONCEPTS)):
        if name.endswith(".md"):
            front, _ = wcsyaml.read(os.path.join(CONCEPTS, name))
            out[name[:-3]] = front
    return out


def edges_of(front: dict) -> list[dict]:
    out = []
    for raw in front.get("requires", []) or []:
        if isinstance(raw, str):
            raw = {"id": raw, "trust": "imported", "confidence": 0.5, "strength": "required"}
        if isinstance(raw, dict) and raw.get("id"):
            out.append(raw)
    return out


def audit(concepts: dict[str, dict]) -> dict:
    edges = {k: edges_of(v) for k, v in concepts.items()}
    reverse = collections.defaultdict(list)
    dangling, trust_count, total_edges = [], collections.Counter(), 0
    for key, es in edges.items():
        for e in es:
            total_edges += 1
            trust_count[e.get("trust", "imported")] += 1
            if e["id"] in concepts:
                reverse[e["id"]].append(key)
            else:
                dangling.append({"concept": key, "requires": e["id"]})

    # cycles — iterative DFS, so a deep graph cannot blow the stack
    WHITE, GREY, BLACK = 0, 1, 2
    color = dict.fromkeys(concepts, WHITE)
    cycles, stack = [], []

    def visit(root):
        work = [(root, iter([e["id"] for e in edges[root] if e["id"] in concepts]))]
        color[root] = GREY
        stack.append(root)
        while work:
            node, it = work[-1]
            advanced = False
            for nxt in it:
                if color.get(nxt) == GREY:
                    if nxt in stack:
                        cycles.append(stack[stack.index(nxt):] + [nxt])
                elif color.get(nxt) == WHITE:
                    color[nxt] = GREY
                    stack.append(nxt)
                    work.append((nxt, iter([e["id"] for e in edges[nxt] if e["id"] in concepts])))
                    advanced = True
                    break
            if not advanced:
                work.pop()
                color[node] = BLACK
                if stack and stack[-1] == node:
                    stack.pop()

    for key in concepts:
        if color[key] == WHITE:
            visit(key)

    inversions = []
    for key, front in concepts.items():
        level = front.get("level")
        if not isinstance(level, int):
            continue
        for e in edges[key]:
            req = concepts.get(e["id"], {}).get("level")
            if isinstance(req, int) and req > level:
                inversions.append({
                    "concept": key, "level": level,
                    "requires": e["id"], "requires_level": req,
                    "trust": e.get("trust", "imported"),
                })

    orphans = [k for k in concepts if not edges[k] and not reverse[k]]
    uncovered = [k for k, v in concepts.items() if not (v.get("videos") or [])]
    sparse = [{"concept": k, "level": v.get("level")} for k, v in concepts.items()
              if isinstance(v.get("level"), int) and v["level"] > 1 and not edges[k]]

    draft = sum(1 for v in concepts.values() if (v.get("status") or "draft") == "draft")
    generated = sum(1 for v in concepts.values() if v.get("generated"))

    return {
        "generated": _dt.datetime.now().isoformat(timespec="seconds"),
        "concepts": len(concepts),
        "edges": total_edges,
        "density": round(total_edges / len(concepts), 2) if concepts else 0.0,
        "trust": {t: trust_count.get(t, 0) for t in TRUST_ORDER},
        "unreviewed": {"draft": draft, "generated": generated, "of": len(concepts)},
        "levels": dict(sorted(collections.Counter(
            v.get("level") for v in concepts.values()).items(), key=lambda kv: str(kv[0]))),
        "cycles": cycles,
        "dangling": dangling,
        "inversions": inversions,
        "orphans": orphans,
        "uncovered": uncovered,
        "sparse": sparse,
    }


def report(a: dict) -> None:
    print("concepts %d | edges %d | density %.2f per concept"
          % (a["concepts"], a["edges"], a["density"]))
    print("trust:      " + " | ".join("%s %d" % (t, a["trust"][t]) for t in TRUST_ORDER))
    u = a["unreviewed"]
    print("unreviewed: %d of %d still draft, %d never human-touched"
          % (u["draft"], u["of"], u["generated"]))
    print("levels:     " + " | ".join("L%s %d" % (k, v) for k, v in a["levels"].items()))
    print()

    blocking = len(a["cycles"]) + len(a["dangling"])
    print("BUILD-BREAKING")
    print("  cycles                %d" % len(a["cycles"]))
    for c in a["cycles"][:5]:
        print("      " + " -> ".join(c))
    print("  dangling references   %d" % len(a["dangling"]))
    for d in a["dangling"][:5]:
        print("      %s requires %s, which does not exist" % (d["concept"], d["requires"]))

    print("\nREVIEW QUEUE")
    print("  level inversions      %d   a concept filed below its own prerequisite" % len(a["inversions"]))
    for i in a["inversions"][:10]:
        print("      %-32s L%s requires %-28s L%s"
              % (i["concept"], i["level"], i["requires"], i["requires_level"]))
    print("  orphans               %d   no edge in either direction" % len(a["orphans"]))
    for o in a["orphans"][:10]:
        print("      %s" % o)
    print("  sparse (level 2+)     %d   declares no prerequisites at all" % len(a["sparse"]))
    for s in a["sparse"][:10]:
        print("      %-32s L%s" % (s["concept"], s["level"]))
    print("  uncovered             %d   no video attached - the ingestion shopping list"
          % len(a["uncovered"]))

    print()
    if blocking:
        print("FAIL: %d build-breaking finding(s)." % blocking)
    else:
        print("OK: nothing build-breaking. %d items in the review queue."
              % (len(a["inversions"]) + len(a["orphans"]) + len(a["sparse"])))


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--json", action="store_true", help="print the raw audit instead of a report")
    ap.add_argument("--strict", action="store_true", help="exit 1 on a build-breaking finding")
    args = ap.parse_args()

    a = audit(load())
    os.makedirs(os.path.dirname(AUDIT), exist_ok=True)
    with io.open(AUDIT, "w", encoding="utf-8", newline="\n") as fh:
        json.dump(a, fh, indent=2, ensure_ascii=False)

    if args.json:
        print(json.dumps(a, indent=2, ensure_ascii=False))
    else:
        report(a)
    if args.strict and (a["cycles"] or a["dangling"]):
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
