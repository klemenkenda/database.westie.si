"use client";

/**
 * The graph canvas — a workspace for building the graph by hand, one family at a time.
 *
 * The list-based studio was the wrong shape for this job. Judging whether
 * `whip-cut-off-entry` rests on the right things means seeing it next to the other nine
 * whips and the things they all point at; a list shows you one concept and asks you to
 * remember the rest. So: one family on screen, laid out in columns by level, with every
 * edge drawn.
 *
 * Three decisions worth stating, because they are what make it usable rather than pretty:
 *
 * 1. **Columns are levels, left to right.** Level is the thing being judged most often, and
 *    laying it out spatially makes a wrong one visible without reading anything — an edge
 *    that points *rightwards* is a level inversion, drawn in red, no audit required.
 * 2. **Prerequisites outside the family are still shown**, in a separate column on the
 *    left. A whip requiring `closed-position` is the normal case, and hiding it would make
 *    every family look rootless.
 * 3. **Drag from a node onto another node creates the edge**, and the direction is fixed:
 *    you always drag the dependent onto what it needs. Every edge in this graph means "A
 *    requires B", and offering both directions would just be an opportunity to write the
 *    relationship backwards.
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
const NODE_H = 46;
const GAP_Y = 14;
const PAD = 22;
const LEVELS = [0, 1, 2, 3, 4];

export default function Canvas({
  concepts,
  onSave,
  busy,
  onOpenConcept,
}: {
  concepts: Row[];
  onSave: (key: string, patch: Record<string, unknown>) => Promise<boolean>;
  busy: string | null;
  onOpenConcept: (key: string) => void;
}) {
  const [familyId, setFamilyId] = useState("whips");
  const [focus, setFocus] = useState<string | null>(null);
  const [dragFrom, setDragFrom] = useState<string | null>(null);
  const [hoverTarget, setHoverTarget] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [onlyProblems, setOnlyProblems] = useState(false);
  const surface = useRef<HTMLDivElement>(null);

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
          x: PAD + i * COL_W,
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
        edges.push({
          from: p.row.key,
          to: e.id,
          edge: e,
          inversion,
          x1: p.x, y1: p.y + NODE_H / 2,
          x2: t.x + COL_W - 64, y2: t.y + NODE_H / 2,
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
        setDragFrom(null);
        setFocus(null);
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
      } else if (focus && ev.key === "e") {
        // Start an edge from the focused node; the next click or Enter on another node
        // completes it. Same gesture as the drag, without the mouse.
        ev.preventDefault();
        setDragFrom(focus);
        setMessage(`linking from ${focus} — click or focus its prerequisite, then press Enter`);
      } else if (ev.key === "Enter" && dragFrom && focus && dragFrom !== focus) {
        ev.preventDefault();
        void addEdge(dragFrom, focus);
        setDragFrom(null);
      } else if (focus && ev.key === "o") {
        ev.preventDefault();
        onOpenConcept(focus);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [visible, focus, dragFrom, undo, addEdge, setLevel, onOpenConcept]);

  const family = FAMILIES.find((f) => f.id === familyId);
  const focused = focus ? byKey.get(focus) : null;

  return (
    <>
      <div className="famtabs">
        {FAMILIES.map((f) => (
          <button
            key={f.id}
            className={`tab ${familyId === f.id ? "on" : ""}`}
            onClick={() => { setFamilyId(f.id); setFocus(null); setDragFrom(null); }}
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
        <b>j/k</b> move · <b>⇧ 0–4</b> set level · <b>e</b> then <b>Enter</b> link · <b>o</b>{" "}
        open · <b>u</b> undo · <b>Esc</b> cancel · drag a node onto its prerequisite · click an
        edge to cut it
      </p>

      <div className="canvaswrap" ref={surface}>
        <div className="canvas" style={{ width, height }}>
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
                const active = focus === e.from || focus === e.to;
                return (
                  <path
                    key={`${e.from}-${e.to}-${i}`}
                    d={`M ${e.x1} ${e.y1} C ${mx} ${e.y1}, ${mx} ${e.y2}, ${e.x2} ${e.y2}`}
                    className={`wire ${e.inversion ? "inv" : ""} ${active ? "on" : ""} ${
                      e.edge.trust === "verified" ? "ver" : ""
                    }`}
                    onClick={() => void dropEdge(e.from, e.to)}
                  />
                );
              })}
          </svg>

          {visible.map((p) => {
            const isExternal = p.col < 0;
            const inv = edges.some((e) => e.inversion && (e.from === p.row.key || e.to === p.row.key));
            return (
              <div
                key={p.row.key}
                className={[
                  "node",
                  isExternal ? "ext" : "",
                  focus === p.row.key ? "focus" : "",
                  dragFrom === p.row.key ? "linking" : "",
                  hoverTarget === p.row.key && dragFrom && dragFrom !== p.row.key ? "target" : "",
                  inv ? "inv" : "",
                  p.row.status === "draft" ? "draft" : "",
                  busy === p.row.key ? "busy" : "",
                ].join(" ")}
                style={{ left: p.x, top: p.y, width: COL_W - 64 }}
                draggable={!isExternal}
                onDragStart={() => setDragFrom(p.row.key)}
                onDragEnd={() => { setDragFrom(null); setHoverTarget(null); }}
                onDragOver={(ev) => { ev.preventDefault(); setHoverTarget(p.row.key); }}
                onDrop={(ev) => {
                  ev.preventDefault();
                  if (dragFrom) void addEdge(dragFrom, p.row.key);
                  setDragFrom(null);
                  setHoverTarget(null);
                }}
                onClick={() => {
                  if (dragFrom && dragFrom !== p.row.key) {
                    void addEdge(dragFrom, p.row.key);
                    setDragFrom(null);
                  } else {
                    setFocus(p.row.key);
                  }
                }}
                onDoubleClick={() => onOpenConcept(p.row.key)}
                title={`${p.row.key}\nL${p.row.level ?? "?"} · ${p.row.requires.length} prerequisites`}
              >
                <b>{p.row.title}</b>
                <span className="nodemeta">
                  L{p.row.level ?? "?"}
                  {p.row.requires.length > 0 && ` · ${p.row.requires.length}↓`}
                  {p.row.videos === 0 && " · no video"}
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
            <span className="dim">
              needs{" "}
              {focused.requires.length
                ? focused.requires.map((e) => e.id).join(", ")
                : "nothing"}
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
          <span className="dim">Nothing selected — click a node, or press j.</span>
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
