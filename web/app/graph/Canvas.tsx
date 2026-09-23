"use client";

/**
 * The graph canvas — a workspace for building the graph by hand, one family at a time.
 *
 * The list-based studio was the wrong shape for this job. Judging whether
 * `whip-roll-of-the-back` rests on the right things means seeing it next to the other
 * whips and the things they all point at; a list shows you one concept and asks you to
 * remember the rest. So: one family on screen, laid out in columns by level, with every
 * edge drawn.
 *
 * The decisions worth stating, because they are what make it usable rather than pretty:
 *
 * 1. **Columns are levels, left to right.** Level is the thing being judged most often, and
 *    laying it out spatially makes a wrong one visible without reading anything — an edge
 *    that points *rightwards* is a level inversion, drawn in red, no audit required.
 * 2. **Prerequisites outside the family are still shown**, in a separate column on the
 *    left. A whip requiring `closed-position` is the normal case, and hiding it would make
 *    every family look rootless.
 * 3. **The card is the level control: drag it into another column.** Level is the thing
 *    edited most often, and the only way to edit it was a row of numbered buttons in the
 *    footer — a form bolted to a graph. Dragging the card to where it belongs is the same
 *    judgement as reading the column it lands in, so making the edit and checking it are
 *    one gesture. Vertical movement means nothing, because the order inside a column is
 *    computed; and the leftmost column is not a level, so a card dropped there is refused
 *    rather than quietly clamped to 0.
 * 4. **An edge is drawn from a port, and the port picks the direction.** The left port,
 *    where incoming wires land, means "this needs what I drop it on". The right port means
 *    "what I drop it on needs this". Every edge still means "A requires B" — what the ports
 *    add is being able to build in either direction. The one-gesture version could only
 *    write the dependent's file, so extending a prerequisite upwards meant finding each
 *    dependent and dragging from it, which is how a family gets edited in two sittings and
 *    two answers. The layout already says prerequisites are left and dependents are right,
 *    so the port you grab is the relationship, and neither one can state it backwards.
 * 5. **Selecting a node paints its two closures in two colours.** What it rests on and what
 *    rests on it are different questions — "is this prerequisite right" versus "what breaks
 *    if I move this" — and one highlight colour answers neither. Upstream is drawn in blue
 *    on the left edge of the card, downstream in magenta on the right edge, so the
 *    direction survives colour-blindness and the everything-else fade keeps the family
 *    readable rather than hiding it.
 * 6. **Status is an icon on the card, not a border.** The border is spent on relation now,
 *    and `draft` versus `review` is the thing you most often want to know without clicking.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Concept, Edge } from "@/lib/content";
import { FAMILIES, familyOf } from "./families";

type Row = Concept & { videos: number };

type Placed = {
  row: Row;
  /** Column index: 0..4 for level 0..4, or -1 for an external prerequisite. */
  col: number;
  x: number;
  y: number;
};

const COL_W = 232;
const NODE_W = COL_W - 64;
const NODE_H = 46;
const GAP_Y = 14;
const PAD = 22;
const LEVELS = [0, 1, 2, 3, 4];

/** The left edge of a column: index 0 is the external prerequisites, 1..5 are levels 0..4. */
const colX = (i: number) => PAD + i * COL_W;

/**
 * Which column a dragged card has landed in, as a level — or `null` for the external column.
 *
 * Takes the card's left edge, not the cursor: the card is what you are aiming, and a cursor
 * held near the card's right edge would otherwise write the column to its right. Nearest
 * column rather than strict containment, so the throw is half a column wide in each
 * direction instead of the card having to clear the 64px gutter first.
 *
 * `null` rather than a clamp to 0, because the first column is other families' concepts and
 * not a level: a card dropped there is a miss, not a demotion to 0.
 */
const levelAt = (cardX: number): number | null => {
  const i = Math.round((cardX - PAD) / COL_W);
  if (i <= 0) return null;
  return Math.min(4, i - 1);
};

/**
 * Which way an edge is being drawn.
 *
 * `needs` writes the grabbed concept's own file; `neededBy` writes the other one's. Both
 * produce the same shape of edge — the distinction is only whose `requires:` list grows.
 */
type Dir = "needs" | "neededBy";

/**
 * A gesture in progress.
 *
 * One state, not two, because a card can only be doing one of these at a time and two
 * independent states could disagree about it. `moved` is what separates a drag from a
 * click: the level write only happens once the pointer has travelled far enough to mean it.
 */
type Grab =
  | { kind: "move"; key: string; x: number; y: number; dx: number; dy: number; moved: boolean }
  | { kind: "link"; key: string; dir: Dir; x1: number; y1: number; x: number; y: number; over: string | null };

/**
 * The review state, as one character.
 *
 * A 46px card has room for a glyph and nothing else, so the word lives in the tooltip. The
 * corpus only holds `draft` and `review` today; the other three are PLAN.md's vocabulary
 * and are listed so an unfamiliar status renders as itself rather than as a fallback dot.
 */
const STATUS: Record<string, { icon: string; label: string }> = {
  draft: { icon: "✎", label: "draft — imported, nobody has checked it" },
  review: { icon: "◐", label: "review — looked at once, not final" },
  published: { icon: "●", label: "published" },
  hidden: { icon: "◌", label: "hidden" },
  rejected: { icon: "✕", label: "rejected" },
};

const statusOf = (s?: string) =>
  STATUS[s ?? "draft"] ?? { icon: "·", label: s ?? "unknown" };

/**
 * Which family, which card, and whether the filter is on live in the URL, not here.
 *
 * They are what the canvas *is* rather than what it is doing, and the studio owns the URL
 * (see web/lib/urlstate.ts — one owner per page, or two writers drop each other's
 * parameters). So they arrive as props and every change goes back up. What stays local is
 * the gesture in flight, the pending link and the last message: state a reload should
 * forget, and state no link should try to carry.
 */
export default function Canvas({
  concepts,
  onSave,
  busy,
  onOpenConcept,
  family: familyId,
  onFamily: setFamilyId,
  focus: focusKey,
  onFocus: setFocus,
  onlyProblems,
  onOnlyProblems: setOnlyProblems,
}: {
  concepts: Row[];
  onSave: (key: string, patch: Record<string, unknown>) => Promise<boolean>;
  busy: string | null;
  onOpenConcept: (key: string) => void;
  family: string;
  onFamily: (id: string) => void;
  /** Empty string for nothing selected — the URL has no way to say `null`. */
  focus: string;
  onFocus: (key: string | null) => void;
  onlyProblems: boolean;
  onOnlyProblems: (on: boolean) => void;
}) {
  // Back to a nullable inside the component: "nothing selected" is a real state here and
  // every test below reads better as a null than as an empty string.
  const focus = focusKey || null;
  /** A link started from the keyboard, waiting for its other end. The mouse uses `grab`. */
  const [pending, setPending] = useState<{ key: string; dir: Dir } | null>(null);
  const [grab, setGrab] = useState<Grab | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const plane = useRef<HTMLDivElement>(null);

  const byKey = useMemo(() => new Map(concepts.map((c) => [c.key, c])), [concepts]);

  const counts = useMemo(() => {
    const out = new Map<string, number>();
    for (const c of concepts) {
      const f = familyOf(c.key, c.foundation_tier);
      out.set(f, (out.get(f) ?? 0) + 1);
    }
    return out;
  }, [concepts]);

  /** The family's members, plus any prerequisite they reach outside it. */
  const { placed, edges, problems } = useMemo(() => {
    const members = concepts.filter((c) => familyOf(c.key, c.foundation_tier) === familyId);
    const memberKeys = new Set(members.map((m) => m.key));

    const external = new Set<string>();
    for (const m of members) {
      for (const e of m.requires) {
        if (!memberKeys.has(e.id) && byKey.has(e.id)) external.add(e.id);
      }
    }

    // Columns: external first, then one per level.
    const columns: Row[][] = [[], [], [], [], [], []];
    for (const key of external) columns[0].push(byKey.get(key)!);
    for (const m of members) {
      const lv = typeof m.level === "number" ? Math.max(0, Math.min(4, m.level)) : 0;
      columns[lv + 1].push(m);
    }
    for (const col of columns) {
      col.sort((a, b) => (b.requires.length - a.requires.length) || a.key.localeCompare(b.key));
    }

    const placed: Placed[] = [];
    columns.forEach((col, i) => {
      col.forEach((row, j) => {
        placed.push({
          row,
          col: i - 1,
          x: colX(i),
          y: PAD + 40 + j * (NODE_H + GAP_Y),
        });
      });
    });

    const pos = new Map(placed.map((p) => [p.row.key, p]));
    const edges: {
      from: string;
      to: string;
      edge: Edge;
      inversion: boolean;
      x1: number; y1: number; x2: number; y2: number;
    }[] = [];
    const problems: string[] = [];

    for (const p of placed) {
      if (!memberKeys.has(p.row.key)) continue;
      for (const e of p.row.requires) {
        const t = pos.get(e.id);
        if (!t) continue;
        const a = byKey.get(p.row.key)!;
        const b = byKey.get(e.id)!;
        const inversion =
          typeof a.level === "number" && typeof b.level === "number" && b.level > a.level;
        if (inversion) problems.push(`${a.key} L${a.level} requires ${b.key} L${b.level}`);
        // Left port of the dependent to right port of the prerequisite — the same two
        // points the link gesture starts from, so a drawn edge lands where you drew it.
        edges.push({
          from: p.row.key,
          to: e.id,
          edge: e,
          inversion,
          x1: p.x, y1: p.y + NODE_H / 2,
          x2: t.x + NODE_W, y2: t.y + NODE_H / 2,
        });
      }
      if (p.row.requires.length === 0 && (p.row.level ?? 0) > 1) {
        problems.push(`${p.row.key} is L${p.row.level} and declares no prerequisites`);
      }
    }
    return { placed, edges, problems };
  }, [concepts, byKey, familyId]);

  const visible = useMemo(() => {
    if (!onlyProblems) return placed;
    const flagged = new Set<string>();
    for (const e of edges) if (e.inversion) { flagged.add(e.from); flagged.add(e.to); }
    for (const p of placed) {
      if (p.col >= 0 && p.row.requires.length === 0 && (p.row.level ?? 0) > 1) flagged.add(p.row.key);
      if (p.col >= 0 && p.row.status === "draft") flagged.add(p.row.key);
    }
    return placed.filter((p) => flagged.has(p.row.key));
  }, [placed, edges, onlyProblems]);

  const visibleKeys = useMemo(() => new Set(visible.map((p) => p.row.key)), [visible]);

  /**
   * The reverse index, built over the whole corpus rather than the family on screen.
   *
   * "What rests on this" is the question the file itself cannot answer — a concept records
   * what it requires and nothing records what requires it — and it is the one that decides
   * whether an edit is safe. Built once per corpus, not per selection.
   */
  const dependents = useMemo(() => {
    const out = new Map<string, string[]>();
    for (const c of concepts) {
      for (const e of c.requires) {
        const at = out.get(e.id);
        if (at) at.push(c.key);
        else out.set(e.id, [c.key]);
      }
    }
    return out;
  }, [concepts]);

  /**
   * The two closures of the selected node, keyed by distance.
   *
   * Transitive, not just the direct neighbours: `basic-whip` resting on `anchor-step` is
   * not the interesting fact, `basic-whip` resting on `downbeat-and-upbeat` five hops down
   * is. Distance is kept so the immediate neighbours can be drawn louder than the tail —
   * a flat closure on a well-connected node lights up half the family and says nothing.
   *
   * The visited set is what terminates this. The graph is asserted acyclic by
   * `tools/foundation.py --check`, but this runs against whatever is on disk right now,
   * which during an editing session is exactly when a cycle exists.
   */
  const rel = useMemo(() => {
    const up = new Map<string, number>();
    const down = new Map<string, number>();
    if (!focus) return { up, down };

    const walk = (out: Map<string, number>, step: (key: string) => string[]) => {
      let frontier = step(focus);
      let depth = 1;
      while (frontier.length) {
        const next: string[] = [];
        for (const key of frontier) {
          if (key === focus || out.has(key)) continue;
          out.set(key, depth);
          next.push(...step(key));
        }
        frontier = next;
        depth += 1;
      }
    };

    walk(up, (key) =>
      (byKey.get(key)?.requires ?? []).map((e) => e.id).filter((id) => byKey.has(id)));
    walk(down, (key) => dependents.get(key) ?? []);
    return { up, down };
  }, [focus, byKey, dependents]);

  /** Direct neighbours, for the counts in the footer — the closure sizes alone overstate. */
  const direct = useMemo(() => {
    if (!focus) return { up: [] as string[], down: [] as string[] };
    return {
      up: (byKey.get(focus)?.requires ?? []).map((e) => e.id),
      down: dependents.get(focus) ?? [],
    };
  }, [focus, byKey, dependents]);

  const height = Math.max(
    360,
    ...placed.map((p) => p.y + NODE_H + PAD),
  );
  const width = PAD * 2 + 6 * COL_W;

  // ---- actions

  const addEdge = useCallback(
    async (from: string, to: string) => {
      if (from === to) return;
      const a = byKey.get(from);
      const b = byKey.get(to);
      if (!a || !b) return;
      if (a.requires.some((e) => e.id === to)) {
        setMessage(`${from} already requires ${to}`);
        return;
      }
      // Refuse the two edges that break the path algorithms rather than merely being
      // debatable: a self-loop, and anything that would close a cycle. Checked here
      // because the canvas is the fastest way to create one by accident, and the audit
      // only notices after the file is already written.
      const reaches = (start: string, goal: string): boolean => {
        const seen = new Set<string>();
        const stack = [start];
        while (stack.length) {
          const x = stack.pop()!;
          if (x === goal) return true;
          if (seen.has(x)) continue;
          seen.add(x);
          for (const e of byKey.get(x)?.requires ?? []) stack.push(e.id);
        }
        return false;
      };
      if (reaches(to, from)) {
        setMessage(`refused: ${to} already depends on ${from}, so this would make a cycle`);
        return;
      }
      const ok = await onSave(from, {
        requires: [
          ...a.requires,
          {
            id: to,
            origin: `canvas@${new Date().toISOString().slice(0, 10)}`,
            trust: "verified",
            confidence: 1.0,
            strength: "required",
          },
        ],
        status: "review",
      });
      setMessage(ok ? `${from} now requires ${to}` : `failed to save ${from}`);
      if (ok) {
        setUndo({
          label: `added ${from} → ${to}`,
          apply: async () => {
            await onSave(from, { requires: a.requires });
            setMessage(`removed ${from} → ${to} again`);
            setUndo(null);
          },
        });
      }
    },
    [byKey, onSave],
  );

  const dropEdge = useCallback(
    async (from: string, to: string) => {
      const a = byKey.get(from);
      if (!a) return;
      const ok = await onSave(from, {
        requires: a.requires.filter((e) => e.id !== to),
        status: "review",
      });
      setMessage(ok ? `removed ${from} → ${to}` : `failed to save ${from}`);
      if (ok) {
        setUndo({
          label: `removed ${from} → ${to}`,
          apply: async () => {
            await onSave(from, { requires: a.requires });
            setMessage(`restored ${from} → ${to}`);
            setUndo(null);
          },
        });
      }
    },
    [byKey, onSave],
  );

  /**
   * Undo, one step deep.
   *
   * Every action here writes a Markdown file immediately, and during development a stray
   * keypress relevelled `basic-music-structure` from 1 to 4 — which stayed invisible until
   * the validator reported six level inversions in concepts that were themselves fine. The
   * edit is cheap to make and expensive to find, so it needs to be cheap to take back.
   * One step is enough: the file is in git, and anything deeper is git's job.
   */
  const [undo, setUndo] = useState<{ label: string; apply: () => Promise<void> } | null>(null);

  const setLevel = useCallback(
    async (key: string, level: number) => {
      const before = byKey.get(key)?.level;
      if (before === level) return;
      const ok = await onSave(key, { level, level_trust: "verified", status: "review" });
      setMessage(ok ? `${key} → level ${level}` : `failed to save ${key}`);
      if (ok) {
        setUndo({
          label: `${key} level ${before ?? "?"} → ${level}`,
          apply: async () => {
            await onSave(key, { level: before ?? null, level_trust: "imported" });
            setMessage(`reverted ${key} to level ${before ?? "none"}`);
            setUndo(null);
          },
        });
      }
    },
    [byKey, onSave],
  );

  /**
   * One end of an edge is the concept you grabbed; `dir` says which end.
   *
   * The whole point of having two ports is that this function is the only place that knows
   * the mapping, so no caller can get the argument order of `addEdge` wrong.
   */
  const link = useCallback(
    (key: string, dir: Dir, other: string) =>
      dir === "needs" ? addEdge(key, other) : addEdge(other, key),
    [addEdge],
  );

  // ---- gestures: the card sets the level, the ports draw the edges

  /** Cursor position in canvas coordinates. The wrapper scrolls, so measure the plane. */
  const pointIn = useCallback((ev: { clientX: number; clientY: number }) => {
    const r = plane.current?.getBoundingClientRect();
    return { x: ev.clientX - (r?.left ?? 0), y: ev.clientY - (r?.top ?? 0) };
  }, []);

  /**
   * The concept under the cursor.
   *
   * Hit-tested against the document rather than tracked with enter/leave handlers on every
   * card: a drag that crosses a wire or the gap between two columns generates no enter
   * event, and the version that tracked hover missed drops that visibly landed on a card.
   */
  const keyUnder = (ev: { clientX: number; clientY: number }) => {
    const el = document.elementFromPoint(ev.clientX, ev.clientY) as HTMLElement | null;
    return el?.closest("[data-node]")?.getAttribute("data-node") ?? null;
  };

  /**
   * Drag the card itself: horizontal position is the level.
   *
   * Vertical movement is deliberately inert. Within a column the order is computed from the
   * prerequisite count, so an y offset has nowhere to be stored — letting the card stay
   * where it was dropped would be a position the next refresh silently throws away.
   */
  const beginMove = useCallback(
    (ev: React.PointerEvent, p: Placed) => {
      if (ev.button !== 0) return;
      // No preventDefault here: it suppresses the compatibility mouse events, and with them
      // the double-click that opens a concept. Text selection is held off by CSS instead.
      const startX = ev.clientX;
      const startY = ev.clientY;
      let moved = false;
      const onMove = (m: PointerEvent) => {
        const dx = m.clientX - startX;
        const dy = m.clientY - startY;
        // Five pixels of slop: a shaky click selects rather than writing a level.
        if (!moved && Math.abs(dx) + Math.abs(dy) < 5) return;
        moved = true;
        setGrab({ kind: "move", key: p.row.key, x: p.x, y: p.y, dx, dy, moved });
      };
      const onUp = (m: PointerEvent) => {
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
        setGrab(null);
        if (!moved) {
          // Still a click. Finish a keyboard-started link if one is open, else select.
          if (pending && pending.key !== p.row.key) {
            void link(pending.key, pending.dir, p.row.key);
            setPending(null);
          } else {
            setFocus(p.row.key);
          }
          return;
        }
        const level = levelAt(p.x + (m.clientX - startX));
        if (level === null) {
          setMessage("the first column holds other families' concepts — it is not a level");
        } else if (level === p.row.level) {
          setMessage(`${p.row.key} is already level ${level}`);
        } else {
          void setLevel(p.row.key, level);
        }
      };
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
    },
    [pending, link, setLevel, setFocus],
  );

  /** Drag from a port: the port is the direction, the card you drop on is the other end. */
  const beginLink = useCallback(
    (ev: React.PointerEvent, p: Placed, dir: Dir) => {
      if (ev.button !== 0) return;
      // Without this the card underneath starts a move at the same time.
      ev.stopPropagation();
      ev.preventDefault();
      const x1 = dir === "needs" ? p.x : p.x + NODE_W;
      const y1 = p.y + NODE_H / 2;
      const at = pointIn(ev);
      setPending(null);
      setGrab({ kind: "link", key: p.row.key, dir, x1, y1, x: at.x, y: at.y, over: null });
      const onMove = (m: PointerEvent) => {
        const q = pointIn(m);
        const over = keyUnder(m);
        setGrab({
          kind: "link", key: p.row.key, dir, x1, y1,
          x: q.x, y: q.y,
          over: over === p.row.key ? null : over,
        });
      };
      const onUp = (m: PointerEvent) => {
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
        setGrab(null);
        const over = keyUnder(m);
        if (!over || over === p.row.key) {
          setMessage("nothing there — a link has to land on a card");
          return;
        }
        void link(p.row.key, dir, over);
      };
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
    },
    [link, pointIn],
  );

  // ---- keyboard: the whole point is not reaching for the mouse
  useEffect(() => {
    const onKey = (ev: KeyboardEvent) => {
      const tag = (ev.target as HTMLElement)?.tagName;
      if (tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA") return;

      const order = visible.filter((p) => p.col >= 0).map((p) => p.row.key);
      const at = focus ? order.indexOf(focus) : -1;

      if (ev.key === "j" || ev.key === "ArrowDown") {
        ev.preventDefault();
        setFocus(order[Math.min(order.length - 1, at + 1)] ?? order[0] ?? null);
      } else if (ev.key === "k" || ev.key === "ArrowUp") {
        ev.preventDefault();
        setFocus(order[Math.max(0, at - 1)] ?? order[0] ?? null);
      } else if (ev.key === "Escape") {
        setPending(null);
        setFocus(null);
      } else if (focus && (ev.key === "h" || ev.key === "l" || ev.key === "ArrowLeft" || ev.key === "ArrowRight")) {
        // The keyboard equivalent of dragging the card sideways, and the same write. Bare
        // arrows are safe here in a way a bare digit was not: one press is one level, in a
        // direction you can see, and it is `u` away from being undone.
        ev.preventDefault();
        const step = ev.key === "h" || ev.key === "ArrowLeft" ? -1 : 1;
        const now = byKey.get(focus)?.level ?? 0;
        void setLevel(focus, Math.max(0, Math.min(4, now + step)));
      } else if (ev.key === "u" && undo) {
        ev.preventDefault();
        void undo.apply();
      } else if (focus && ev.shiftKey && ev.key >= "0" && ev.key <= "4") {
        // Shift, deliberately. A bare number key writing a level straight to disk was too
        // easy to fire by accident: it silently relevelled a concept during testing, and
        // the damage only showed up later as six level inversions in *other* concepts. The
        // modifier costs nothing to learn and makes the action intentional.
        ev.preventDefault();
        void setLevel(focus, Number(ev.key));
      } else if (focus && (ev.key === "e" || ev.key === "d")) {
        // Start an edge from the focused card; the next click or Enter on another card
        // completes it. Two keys for the two ports: `e` is the left one, `d` the right.
        ev.preventDefault();
        const dir: Dir = ev.key === "e" ? "needs" : "neededBy";
        setPending({ key: focus, dir });
        setMessage(
          dir === "needs"
            ? `${focus} needs … — click or focus its prerequisite, then Enter`
            : `… needs ${focus} — click or focus what rests on it, then Enter`,
        );
      } else if (ev.key === "Enter" && pending && focus && pending.key !== focus) {
        ev.preventDefault();
        void link(pending.key, pending.dir, focus);
        setPending(null);
      } else if (focus && ev.key === "o") {
        ev.preventDefault();
        onOpenConcept(focus);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [visible, focus, pending, undo, byKey, link, setLevel, setFocus, onOpenConcept]);

  const family = FAMILIES.find((f) => f.id === familyId);
  const focused = focus ? byKey.get(focus) : null;

  return (
    <>
      <div className="famtabs">
        {FAMILIES.map((f) => (
          <button
            key={f.id}
            className={`tab ${familyId === f.id ? "on" : ""}`}
            onClick={() => { setFamilyId(f.id); setPending(null); }}
          >
            {f.title} <span className="dim">{counts.get(f.id) ?? 0}</span>
          </button>
        ))}
      </div>

      <div className="canvasbar">
        <p className="note" style={{ margin: 0, flex: "1 1 320px" }}>
          {family?.note}
        </p>
        <label className="inlinecheck">
          <input
            type="checkbox"
            checked={onlyProblems}
            onChange={(e) => setOnlyProblems(e.target.checked)}
          />
          Only unreviewed or inconsistent
        </label>
        <span className={problems.length ? "chip bad" : "chip ok"}>
          {problems.length ? `${problems.length} to look at` : "consistent"}
        </span>
      </div>

      <p className="note keys">
        Drag a card sideways to set its level · drag the <b>left</b> port onto what it needs,
        the <b>right</b> port onto what needs it · click an edge to cut it
      </p>
      <p className="note keys">
        <b>j/k</b> select · <b>h/l</b> or <b>⇧ 0–4</b> level · <b>e</b>/<b>d</b> then{" "}
        <b>Enter</b> link · <b>o</b> open · <b>u</b> undo · <b>Esc</b> cancel
      </p>

      <div className="canvaswrap">
        <div className="canvas" style={{ width, height }} ref={plane}>
          {/*
            * The level columns, drawn only while a card is being dragged.
            *
            * Permanent gridlines would be noise on a view whose job is the wires; during a
            * drag they are the only thing that says what the drop will write. The lit one
            * is computed from the card's centre, the same expression the drop uses, so the
            * highlight cannot promise a level the release does not deliver.
            */}
          {grab?.kind === "move" && (
            <div className="dropcols" aria-hidden>
              {LEVELS.map((l) => (
                <div
                  key={l}
                  className={`dropcol ${levelAt(grab.x + grab.dx) === l ? "on" : ""}`}
                  style={{ left: colX(l + 1) - 12, width: COL_W }}
                >
                  <span>L{l}</span>
                </div>
              ))}
            </div>
          )}

          <div className="collabels">
            {["from elsewhere", ...LEVELS.map((l) => `level ${l}`)].map((label, i) => (
              <span key={label} style={{ left: PAD + i * COL_W }} className="collabel">
                {label}
              </span>
            ))}
          </div>

          <svg width={width} height={height} className="wires">
            {edges
              .filter((e) => visibleKeys.has(e.from) && visibleKeys.has(e.to))
              .map((e, i) => {
                const mx = (e.x1 + e.x2) / 2;
                // An edge joins a closure only when *both* ends are in it. The edge reads
                // "from requires to", so a rung of the upstream ladder runs from the
                // selection, or from something already upstream, down into a prerequisite;
                // downstream is the same test mirrored. An edge with one foot in each is
                // neither, and fades with everything else.
                const up = !!focus && (e.from === focus || rel.up.has(e.from)) && rel.up.has(e.to);
                const down = !!focus && (e.to === focus || rel.down.has(e.to)) && rel.down.has(e.from);
                const near = focus !== null && (e.from === focus || e.to === focus);
                return (
                  <path
                    key={`${e.from}-${e.to}-${i}`}
                    d={`M ${e.x1} ${e.y1} C ${mx} ${e.y1}, ${mx} ${e.y2}, ${e.x2} ${e.y2}`}
                    className={[
                      "wire",
                      e.inversion ? "inv" : "",
                      e.edge.trust === "verified" ? "ver" : "",
                      up ? "up" : "",
                      down ? "down" : "",
                      near ? "near" : "",
                      focus && !up && !down ? "mute" : "",
                    ].join(" ")}
                    onClick={() => void dropEdge(e.from, e.to)}
                  />
                );
              })}

            {/* The link being drawn. Curved the same way as a real edge so the gesture
                previews its own result, and never hit-tested, or it would shadow the card
                the cursor is trying to land on. */}
            {grab?.kind === "link" && (
              <path
                className={`wire ghost ${grab.dir === "needs" ? "up" : "down"}`}
                d={`M ${grab.x1} ${grab.y1} C ${(grab.x1 + grab.x) / 2} ${grab.y1}, ${
                  (grab.x1 + grab.x) / 2
                } ${grab.y}, ${grab.x} ${grab.y}`}
              />
            )}
          </svg>

          {visible.map((p) => {
            const isExternal = p.col < 0;
            const inv = edges.some((e) => e.inversion && (e.from === p.row.key || e.to === p.row.key));
            const st = statusOf(p.row.status);
            const upAt = rel.up.get(p.row.key);
            const downAt = rel.down.get(p.row.key);
            const related = upAt ?? downAt;
            const moving = grab?.kind === "move" && grab.key === p.row.key;
            const linking =
              (grab?.kind === "link" && grab.key === p.row.key) || pending?.key === p.row.key;
            const isTarget =
              (grab?.kind === "link" && grab.over === p.row.key) ||
              (!!pending && pending.key !== p.row.key && focus === p.row.key);
            return (
              <div
                key={p.row.key}
                data-node={p.row.key}
                className={[
                  "node",
                  isExternal ? "ext" : "",
                  focus === p.row.key ? "focus" : "",
                  moving ? "moving" : "",
                  linking ? "linking" : "",
                  isTarget ? "target" : "",
                  inv ? "inv" : "",
                  busy === p.row.key ? "busy" : "",
                  upAt ? "rel-up" : "",
                  downAt ? "rel-down" : "",
                  related === 1 ? "rel-near" : "",
                  focus && focus !== p.row.key && !related ? "mute" : "",
                ].join(" ")}
                style={{
                  left: p.x,
                  top: p.y,
                  width: NODE_W,
                  // Only the x offset is applied: dragging up and down is not a thing this
                  // graph can store, and a card that follows the cursor vertically would
                  // promise it can.
                  transform: moving ? `translateX(${grab.dx}px)` : undefined,
                }}
                onPointerDown={(ev) => beginMove(ev, p)}
                onDoubleClick={() => onOpenConcept(p.row.key)}
                title={[
                  p.row.key,
                  `L${p.row.level ?? "?"} · ${p.row.requires.length} prerequisites · ${st.label}`,
                  upAt ? `${upAt} step${upAt > 1 ? "s" : ""} beneath the selection` : "",
                  downAt ? `${downAt} step${downAt > 1 ? "s" : ""} above the selection` : "",
                ].filter(Boolean).join("\n")}
              >
                {/*
                  * The two ports. Left is where this card's wires leave for what it needs,
                  * right is where the wires of things that need it arrive — the same sides
                  * the layout already uses, so the gesture reads off the picture.
                  */}
                <span
                  className="port left"
                  title={`drag onto a prerequisite — ${p.row.key} needs it`}
                  onPointerDown={(ev) => beginLink(ev, p, "needs")}
                />
                <span
                  className="port right"
                  title={`drag onto a dependent — it needs ${p.row.key}`}
                  onPointerDown={(ev) => beginLink(ev, p, "neededBy")}
                />
                <b>{p.row.title}</b>
                <span className="nodemeta">
                  L{p.row.level ?? "?"}
                  {p.row.requires.length > 0 && ` · ${p.row.requires.length}↓`}
                  {p.row.videos === 0 && " · no video"}
                </span>
                <span className={`nodestate s-${p.row.status ?? "draft"}`} aria-hidden>
                  {st.icon}
                </span>
              </div>
            );
          })}
        </div>
      </div>

      <div className="canvasfoot">
        {focused ? (
          <>
            <b>{focused.title}</b>
            <span className="dim"><code>{focused.key}</code></span>
            {/*
              * The two closure counts, doubling as the legend for the canvas colours.
              *
              * Both numbers are corpus-wide, not family-wide: "what rests on this" is a
              * property of the concept, and answering it with only the whips that happen
              * to be on screen would be the more dangerous kind of wrong. The highlight
              * shows the part of it that fits in this view; the number is the truth.
              */}
            <span
              className="relchip up"
              title={
                direct.up.length
                  ? `directly needs ${direct.up.join(", ")}`
                  : "needs nothing — this is a root"
              }
            >
              needs {direct.up.length}
              {rel.up.size > direct.up.length && (
                <span className="dim"> · {rel.up.size} deep</span>
              )}
            </span>
            <span
              className="relchip down"
              title={
                direct.down.length
                  ? `directly needed by ${direct.down.slice(0, 12).join(", ")}${
                      direct.down.length > 12 ? ", …" : ""
                    }`
                  : "nothing needs this yet"
              }
            >
              needed by {direct.down.length}
              {rel.down.size > direct.down.length && (
                <span className="dim"> · {rel.down.size} deep</span>
              )}
            </span>
            <span className={`relchip state s-${focused.status ?? "draft"}`}>
              {statusOf(focused.status).icon} {focused.status ?? "draft"}
            </span>
            <span className="levelset">
              {LEVELS.map((l) => (
                <button
                  key={l}
                  className={`tab mini ${focused.level === l ? "on" : ""}`}
                  onClick={() => void setLevel(focused.key, l)}
                >
                  {l}
                </button>
              ))}
            </span>
            <button className="tab mini" onClick={() => onOpenConcept(focused.key)}>
              Inspect
            </button>
          </>
        ) : (
          <span className="dim">
            Nothing selected — click a node, or press j. Selecting one paints what it
            rests on and what rests on it.
          </span>
        )}
        {undo && (
          <button className="tab mini undo" onClick={() => void undo.apply()}>
            ↩ undo {undo.label}
          </button>
        )}
        {message && <span className="canvasmsg">{message}</span>}
      </div>

      {problems.length > 0 && (
        <ul className="findlist" style={{ marginTop: 14 }}>
          {problems.slice(0, 12).map((p) => (
            <li key={p}><span className="dim">{p}</span></li>
          ))}
        </ul>
      )}
    </>
  );
}
