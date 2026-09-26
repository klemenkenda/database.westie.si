"use client";

/**
 * The graph builder — rebuild the concept graph from scratch, with the old one as a guide.
 *
 * The imported graph was not fixable by editing: too many of its edges were someone's
 * guess, and correcting it in place meant every concept started from a wrong answer. So
 * the new graph starts empty, under content/graph/nodes/, and the old one is read-only
 * reference material beside it. Three panes:
 *
 *   Old graph   every old concept and what has been decided about it: adopted into a new
 *               node, skipped with a reason, or still pending. "Ready" is the useful
 *               filter — pending concepts whose old prerequisites are all decided — because
 *               it makes building bottom-up the path of least resistance.
 *   New graph   the nodes built so far, in columns by depth (or by level), every edge drawn.
 *   Inspector   the selection. For an old concept: what it said, and adopt / merge / skip.
 *               For a new node: its edges, and the old graph's edges translated into the
 *               new one as one-click suggestions.
 *
 * The suggestions are the whole point of keeping the old graph around. A new node remembers
 * which old concepts it replaces (`from`), so the old prerequisites of those concepts can be
 * looked up, mapped through whatever they were adopted as, and offered — never written
 * without a click. Adopting is a claim that the node exists; every edge is a separate claim.
 *
 * Nothing here writes to content/concepts/. The old graph is edited, if at all, in the old
 * studio at /graph/old/.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { flag, oneOf, text, useUrlState, type Spec } from "@/lib/urlstate";
import { toGraphNode, type GraphEdge, type GraphNode, type Skip } from "@/lib/rebuild";
import { FAMILIES, familyOf } from "./families";
import { SIMILAR_FLOOR, similarity } from "@/lib/similar";

/** The old graph, reduced to what the builder reads. */
export type OldConcept = {
  key: string;
  title: string;
  level?: number;
  aliases: string[];
  foundation_tier?: string;
  /** Ids of the old prerequisites. Trust is dropped on purpose: none of it carries over. */
  requires: string[];
};

type OldState = "adopted" | "skipped" | "pending";

const API =
  process.env.NEXT_PUBLIC_API_BASE ??
  (typeof window !== "undefined" ? `${window.location.origin}/api` : "/api");

const LEVELS = [0, 1, 2, 3, 4];
const LEVEL_NAMES = ["foundation", "beginner", "improver", "intermediate", "advanced"];
const STRENGTHS = ["required", "usually-taught-before"];
const SHOWS = ["ready", "pending", "adopted", "skipped", "all"] as const;
type Show = (typeof SHOWS)[number];

const COL_W = 210;
const NODE_W = COL_W - 50;
const NODE_H = 44;
const GAP_Y = 22;
const PAD = 20;

const today = () => new Date().toISOString().slice(0, 10);
const origin = () => `rebuild@${today()}`;

type Where = {
  /** `o:<key>` for an old concept, `n:<key>` for a new node, empty for nothing. */
  sel: string;
  show: Show;
  fam: string;
  q: string;
  cols: "depth" | "level";
  around: boolean;
};

// ---------------------------------------------------------------------------- graph maths

/**
 * Longest path down to something with no prerequisites.
 *
 * The column a node sits in on the canvas. Depth rather than level by default, because
 * depth is what the edges say and level is a separate judgement — laying out by level
 * would hide exactly the disagreement between the two that is worth seeing. Cycle-safe:
 * writes refuse cycles, but a file edited by hand may still contain one.
 */
function depths(byKey: Map<string, GraphNode>, hardOnly = false): Map<string, number> {
  const memo = new Map<string, number>();
  const onStack = new Set<string>();
  const visit = (key: string): number => {
    const known = memo.get(key);
    if (known !== undefined) return known;
    if (onStack.has(key)) return 0;
    onStack.add(key);
    let best = 0;
    for (const e of byKey.get(key)?.requires ?? []) {
      if (hardOnly && e.strength !== "required") continue;
      if (byKey.has(e.id)) best = Math.max(best, visit(e.id) + 1);
    }
    onStack.delete(key);
    memo.set(key, best);
    return best;
  };
  for (const key of byKey.keys()) visit(key);
  return memo;
}

/** Does `start` already rest on `goal`? An edge goal -> start would then close a cycle. */
function reaches(byKey: Map<string, GraphNode>, start: string, goal: string): boolean {
  const seen = new Set<string>();
  const stack = [start];
  while (stack.length) {
    const at = stack.pop()!;
    if (at === goal) return true;
    if (seen.has(at)) continue;
    seen.add(at);
    for (const e of byKey.get(at)?.requires ?? []) stack.push(e.id);
  }
  return false;
}

/** Every node reachable from `key` by `step`, with its distance. */
function walk(key: string, step: (k: string) => string[]): Map<string, number> {
  const out = new Map<string, number>();
  let frontier = step(key);
  let d = 1;
  while (frontier.length) {
    const next: string[] = [];
    for (const k of frontier) {
      if (k === key || out.has(k)) continue;
      out.set(k, d);
      next.push(...step(k));
    }
    frontier = next;
    d += 1;
  }
  return out;
}

/**
 * The prose of an old concept, without the parts the importer generated.
 *
 * Every imported body opens with a heading repeating the title and an italic line
 * repeating level and category ("*Pattern · level 1* — imported…"). Neither belongs in a
 * new node's description, so adopting copies only what somebody actually wrote.
 */
function cleanOldBody(body: string): string {
  return body
    .replace(/\r\n/g, "\n")
    .split("\n")
    .filter((line) => !/^#\s/.test(line) && !/^\*[^*]+\*\s+—\s+imported/.test(line))
    .join("\n")
    .replace(/^\n+/, "")
    .trim();
}

/** Word overlap between two names — enough to put `tuck-turn` next to `sugar-tuck`. */
const words = (s: string) =>
  new Set(s.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 2 && w !== "the"));

// ------------------------------------------------------------------------------ component

export default function Builder({
  old: oldInitial,
  nodes: nodesInitial,
  skips: skipsInitial,
}: {
  old: OldConcept[];
  nodes: GraphNode[];
  skips: Skip[];
}) {
  const spec: Spec<Where> = useMemo(
    () => ({
      sel: text("s"),
      show: oneOf("show", SHOWS, "ready"),
      fam: text("f"),
      q: text("q"),
      cols: oneOf("cols", ["depth", "level"] as const, "depth"),
      around: flag("around"),
    }),
    [],
  );
  const [where, go] = useUrlState<Where>(spec, {
    sel: "",
    show: "ready",
    fam: "",
    q: "",
    cols: "depth",
    around: false,
  });

  const [old, setOld] = useState<OldConcept[]>(oldInitial);
  const [nodes, setNodes] = useState<GraphNode[]>(nodesInitial);
  const [skips, setSkips] = useState<Skip[]>(skipsInitial);
  const [live, setLive] = useState<"static" | "live" | "offline">("static");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ text: string; bad?: boolean } | null>(null);
  /** The title being typed into the new-node form, for the look-alike list on the left. */
  const [draft, setDraft] = useState("");

  // ---- data: the build-time snapshot first, then the API, and again after every write.
  const refresh = useCallback(async () => {
    try {
      const get = async (path: string) => {
        const res = await fetch(`${API}/${path}?limit=500`);
        if (!res.ok) throw new Error(`${path}: ${res.status}`);
        const body = await res.json();
        return (Array.isArray(body?.results) ? body.results : []) as any[];
      };
      const [o, n, s] = await Promise.all([get("concepts"), get("nodes"), get("skipped")]);
      if (!o.length) throw new Error("no concepts");
      setOld(
        o.map((r) => ({
          key: r._key,
          title: r.title ?? r._key,
          level: typeof r.level === "number" ? r.level : undefined,
          aliases: Array.isArray(r.aliases) ? r.aliases : [],
          foundation_tier: r.foundation_tier ?? undefined,
          requires: (Array.isArray(r.requires) ? r.requires : [])
            .map((e: any) => (typeof e === "string" ? e : e?.id))
            .filter((id: unknown): id is string => typeof id === "string"),
        })),
      );
      setNodes(n.map((r) => toGraphNode(r._key, r)));
      setSkips(
        s.map((r) => ({
          key: r._key,
          title: r.title ?? undefined,
          reason: r.reason ?? undefined,
          skipped_at: r.skipped_at ?? undefined,
        })),
      );
      setLive("live");
    } catch {
      setLive("offline");
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  /** One write. Every action below is a sequence of these followed by one refresh. */
  const call = useCallback(
    async (method: string, path: string, body?: Record<string, unknown>) => {
      const res = await fetch(`${API}/${path}`, {
        method,
        headers: { "Content-Type": "application/json" },
        body: body ? JSON.stringify(body) : undefined,
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err?.error ?? `${method} ${path}: ${res.status}`);
      }
      return res.json().catch(() => ({}));
    },
    [],
  );

  /** Run an action, report it, reload. Failures are said out loud — a silent no-op on a
      tool that writes files looks exactly like success. */
  const act = useCallback(
    async (label: string, fn: () => Promise<void>): Promise<boolean> => {
      setBusy(true);
      try {
        await fn();
        setMessage({ text: label });
        return true;
      } catch (err) {
        setMessage({
          text:
            err instanceof TypeError
              ? `no API at ${API} — start it with \`docker compose up -d api\``
              : `failed: ${(err as Error).message}`,
          bad: true,
        });
        return false;
      } finally {
        await refresh();
        setBusy(false);
      }
    },
    [refresh],
  );

  // ---- derived state
  const oldBy = useMemo(() => new Map(old.map((c) => [c.key, c])), [old]);
  const nodeBy = useMemo(() => new Map(nodes.map((n) => [n.key, n])), [nodes]);
  const skipBy = useMemo(() => new Map(skips.map((s) => [s.key, s])), [skips]);

  /** Old concept -> the new node that took it over. */
  const adoptedAs = useMemo(() => {
    const out = new Map<string, string>();
    for (const n of nodes) for (const f of n.from) out.set(f, n.key);
    return out;
  }, [nodes]);

  const oldInto = useMemo(() => {
    const out = new Map<string, string[]>();
    for (const c of old) {
      for (const id of c.requires) out.set(id, [...(out.get(id) ?? []), c.key]);
    }
    return out;
  }, [old]);

  const nodeInto = useMemo(() => {
    const out = new Map<string, string[]>();
    for (const n of nodes) {
      for (const e of n.requires) out.set(e.id, [...(out.get(e.id) ?? []), n.key]);
    }
    return out;
  }, [nodes]);

  const stateOf = useCallback(
    (key: string): OldState =>
      adoptedAs.has(key) ? "adopted" : skipBy.has(key) ? "skipped" : "pending",
    [adoptedAs, skipBy],
  );

  /** Pending, and nothing it used to rest on is still undecided. */
  const isReady = useCallback(
    (key: string) =>
      stateOf(key) === "pending" &&
      (oldBy.get(key)?.requires ?? []).every((id) => !oldBy.has(id) || stateOf(id) !== "pending"),
    [oldBy, stateOf],
  );

  const progress = useMemo(() => {
    let adopted = 0, skipped = 0, ready = 0;
    for (const c of old) {
      const s = stateOf(c.key);
      if (s === "adopted") adopted += 1;
      else if (s === "skipped") skipped += 1;
      else if (isReady(c.key)) ready += 1;
    }
    const edges = nodes.reduce((n, x) => n + x.requires.length, 0);
    const dangling = nodes.flatMap((n) =>
      n.requires.filter((e) => !nodeBy.has(e.id)).map((e) => `${n.key} → ${e.id}`),
    );
    const inversions = nodes.flatMap((n) =>
      n.requires
        .filter((e) => {
          const t = nodeBy.get(e.id);
          return typeof n.level === "number" && typeof t?.level === "number" && t.level > n.level;
        })
        .map((e) => `${n.key} L${n.level} needs ${e.id} L${nodeBy.get(e.id)?.level}`),
    );
    return {
      adopted, skipped, ready,
      pending: old.length - adopted - skipped,
      edges, dangling, inversions,
    };
  }, [old, nodes, nodeBy, stateOf, isReady]);

  /** Everything already named like the draft, new nodes and old concepts together: a new
      node that duplicates one is the mistake this exists to catch. */
  const similar = useMemo(() => {
    if (draft.trim().length < 2) return [];
    const hits: { kind: "old" | "new"; key: string; title: string; level?: number; score: number }[] = [];
    for (const n of nodes) {
      const score = similarity(draft, [n.title, n.key, ...n.from.map((f) => oldBy.get(f)?.title ?? f)]);
      if (score >= SIMILAR_FLOOR) hits.push({ kind: "new", key: n.key, title: n.title, level: n.level, score });
    }
    for (const c of old) {
      const score = similarity(draft, [c.title, c.key, ...c.aliases]);
      if (score >= SIMILAR_FLOOR) hits.push({ kind: "old", key: c.key, title: c.title, level: c.level, score });
    }
    return hits.sort((a, b) => b.score - a.score || (a.kind === "new" ? -1 : 1)).slice(0, 12);
  }, [draft, nodes, old, oldBy]);

  const selKind = where.sel.startsWith("o:") ? "old" : where.sel.startsWith("n:") ? "new" : null;
  const selKey = where.sel.slice(2);
  const select = useCallback(
    (kind: "old" | "new", key: string) => go({ sel: `${kind === "old" ? "o" : "n"}:${key}` }, "push"),
    [go],
  );

  // ---- actions

  /**
   * Add `from requires to` to the new graph, refusing a cycle.
   *
   * `extra` is a node written in the same action that the loaded graph does not know yet,
   * so the cycle test sees it — otherwise "adopt this and link it" would check against a
   * graph missing half the edge.
   */
  const linkIn = useCallback(
    async (from: string, to: string, extra?: GraphNode, strength = "required") => {
      const graph = new Map(nodeBy);
      if (extra) graph.set(extra.key, extra);
      const a = graph.get(from);
      if (!a || !graph.has(to) || from === to) throw new Error(`cannot link ${from} → ${to}`);
      if (a.requires.some((e) => e.id === to)) return;
      if (reaches(graph, to, from)) {
        throw new Error(`${to} already rests on ${from}, so ${from} → ${to} would be a cycle`);
      }
      const edge: GraphEdge = { id: to, strength, origin: origin() };
      await call("PUT", `nodes/${from}`, { requires: [...a.requires, edge] });
    },
    [nodeBy, call],
  );

  const addEdge = (from: string, to: string, strength = "required") =>
    act(`${from} now needs ${to}`, () => linkIn(from, to, undefined, strength));

  /**
   * Several prerequisites in one write. Not a loop over `addEdge`: each of those PUTs the
   * whole `requires` list as it was before any of them landed, so all but the last would
   * be overwritten.
   */
  const addEdges = (from: string, tos: string[]) =>
    act(`${from} now needs ${tos.join(", ")}`, async () => {
      const a = nodeBy.get(from);
      if (!a) return;
      const fresh = tos.filter((t) => t !== from && nodeBy.has(t) && !a.requires.some((e) => e.id === t));
      for (const t of fresh) {
        if (reaches(nodeBy, t, from)) throw new Error(`${t} already rests on ${from}; nothing written`);
      }
      await call("PUT", `nodes/${from}`, {
        requires: [...a.requires, ...fresh.map((id) => ({ id, strength: "required", origin: origin() }))],
      });
    });

  const dropEdge = (from: string, to: string) =>
    act(`${from} no longer needs ${to}`, async () => {
      const a = nodeBy.get(from);
      if (!a) return;
      await call("PUT", `nodes/${from}`, { requires: a.requires.filter((e) => e.id !== to) });
    });

  const setLevel = (key: string, level: number) =>
    act(`${key} → level ${level}`, () => call("PUT", `nodes/${key}`, { level }).then(() => {}));

  /**
   * Undo, one step deep, for the canvas gestures.
   *
   * A drag writes a file the moment the pointer is released, and a release over the wrong
   * card is easy. The undo runs through `latest` rather than a closure captured at the time
   * of the gesture: by the time you press it the graph has been reloaded, and an undo
   * built on the pre-gesture snapshot would write that whole snapshot back over anything
   * done since. One step is enough — the files are in git.
   */
  const [undo, setUndo] = useState<{ label: string; apply: () => Promise<unknown> } | null>(null);
  const latest = useRef({
    dropEdge: (_a: string, _b: string) => Promise.resolve(false),
    addEdge: (_a: string, _b: string, _s?: string) => Promise.resolve(false),
    setLevel: (_k: string, _l: number) => Promise.resolve(false),
    setStrength: (_a: string, _b: string, _s: string) => Promise.resolve(false),
  });

  const canvasLink = async (from: string, to: string, strength = "required") => {
    const existing = nodeBy.get(from)?.requires.find((e) => e.id === to);
    if (existing) {
      // Drawing the other kind of edge over an existing one changes its strength rather
      // than refusing — redrawing is the obvious way to say "no, it is the other kind".
      if (existing.strength !== strength) {
        if (await setStrength(from, to, strength)) {
          setUndo({ label: `${from} → ${to} is ${strength}`, apply: () => latest.current.setStrength(from, to, existing.strength) });
        }
      } else {
        setMessage({ text: `${from} already needs ${to}` });
      }
      return;
    }
    if (await addEdge(from, to, strength)) {
      setUndo({ label: `added ${from} → ${to}`, apply: () => latest.current.dropEdge(from, to) });
    }
  };
  const canvasUnlink = async (from: string, to: string) => {
    if (await dropEdge(from, to)) {
      const was = nodeBy.get(from)?.requires.find((e) => e.id === to)?.strength ?? "required";
      setUndo({ label: `removed ${from} → ${to}`, apply: () => latest.current.addEdge(from, to, was) });
    }
  };
  const canvasLevel = async (key: string, level: number) => {
    const before = nodeBy.get(key)?.level;
    if (before === level) return;
    if (await setLevel(key, level)) {
      setUndo(
        before === undefined
          ? null
          : { label: `${key} level ${before} → ${level}`, apply: () => latest.current.setLevel(key, before) },
      );
    }
  };
  const runUndo = async () => {
    const u = undo;
    setUndo(null);
    if (u) await u.apply();
  };

  const setStrength = (from: string, to: string, strength: string) =>
    act(`${from} → ${to} is now ${strength}`, async () => {
      const a = nodeBy.get(from);
      if (!a) return;
      await call("PUT", `nodes/${from}`, {
        requires: a.requires.map((e) => (e.id === to ? { ...e, strength } : e)),
      });
    });

  /**
   * Create a new node from an old concept. Returns the node as written, so a caller that
   * links it in the same action can hand it to `linkIn` before the reload lands.
   *
   * With `wire`, it also takes every old prerequisite that already has a new home — the
   * suggestion you would accept anyway on every adopt, done in the same write.
   */
  const adoptOld = useCallback(
    async (
      oldKey: string,
      opts: { key?: string; title?: string; level?: number; wire: boolean; requires?: { id: string; strength: string }[] },
    ) => {
      const c = oldBy.get(oldKey);
      if (!c) throw new Error(`no old concept ${oldKey}`);
      const key = (opts.key ?? oldKey).trim();
      if (nodeBy.has(key)) throw new Error(`${key} already exists in the new graph — merge into it instead`);

      let body = "";
      try {
        const res = await fetch(`${API}/concepts/${oldKey}`);
        if (res.ok) body = cleanOldBody(String((await res.json())?.body ?? ""));
      } catch {
        // The description is a convenience. A node without one is still a correct node.
      }

      const requires: GraphEdge[] = opts.requires
        ? opts.requires
            .filter((e) => e.id !== key && nodeBy.has(e.id))
            .map((e) => ({ id: e.id, strength: e.strength, origin: origin() }))
        : opts.wire
          ? [...new Set(c.requires.map((id) => adoptedAs.get(id)).filter((k): k is string => !!k && k !== key))]
              .map((id) => ({ id, strength: "required", origin: origin() }))
          : [];
      const node: GraphNode = {
        key,
        title: opts.title?.trim() || c.title,
        level: opts.level ?? c.level,
        from: [oldKey],
        requires,
      };
      await call("POST", "nodes", {
        key,
        title: node.title,
        level: node.level ?? null,
        from: node.from,
        requires,
        added: today(),
        body,
      });
      return node;
    },
    [oldBy, nodeBy, adoptedAs, call],
  );

  /** Adopt an old concept and connect it to an existing node, in one action. */
  const adoptAndLink = (nodeKey: string, oldKey: string, dir: "prereq" | "dependent", strength = "required") =>
    act(
      dir === "prereq" ? `adopted ${oldKey}; ${nodeKey} needs it` : `adopted ${oldKey}; it needs ${nodeKey}`,
      async () => {
        const node = await adoptOld(oldKey, { wire: true });
        if (dir === "prereq") await linkIn(nodeKey, node.key, node, strength);
        else await linkIn(node.key, nodeKey, node, strength);
      },
    );

  /**
   * Adopt an old concept the way Opus placed it: its level, the prerequisites you kept
   * ticked, and the existing nodes you agreed should need it. Selects the new node after,
   * so its own edge suggestions are one click away.
   */
  const applyPlacement = (
    oldKey: string,
    plan: { level?: number; needs: { id: string; strength: string }[]; neededBy: { id: string; strength: string }[] },
  ) =>
    act(`adopted ${oldKey} as placed`, async () => {
      const node = await adoptOld(oldKey, { wire: false, level: plan.level, requires: plan.needs });
      for (const d of plan.neededBy) await linkIn(d.id, node.key, node, d.strength);
      select("new", node.key);
    });

  const createBlank = (key: string, title: string, level?: number) =>
    act(`created ${key}`, async () => {
      if (nodeBy.has(key)) throw new Error(`${key} already exists`);
      await call("POST", "nodes", {
        key, title, level: level ?? null, from: [], requires: [], added: today(), body: "",
      });
      select("new", key);
    });

  const mergeInto = (oldKey: string, target: string) =>
    act(`${oldKey} merged into ${target}`, async () => {
      const t = nodeBy.get(target);
      if (!t) throw new Error(`no node ${target}`);
      await call("PUT", `nodes/${target}`, { from: [...new Set([...t.from, oldKey])] });
    });

  const detach = (nodeKey: string, oldKey: string) =>
    act(`${oldKey} is pending again`, async () => {
      const n = nodeBy.get(nodeKey);
      if (!n) return;
      await call("PUT", `nodes/${nodeKey}`, { from: n.from.filter((f) => f !== oldKey) });
    });

  const skip = (oldKey: string, reason: string) =>
    act(`skipped ${oldKey}`, async () => {
      await call("POST", "skipped", {
        key: oldKey,
        title: oldBy.get(oldKey)?.title ?? oldKey,
        reason: reason.trim(),
        skipped_at: today(),
      });
    });

  const unskip = (oldKey: string) =>
    act(`${oldKey} is pending again`, () => call("DELETE", `skipped/${oldKey}`).then(() => {}));

  /**
   * Delete a node, and every edge pointing at it.
   *
   * The dangling edges are cleaned up in the same action rather than left for an audit:
   * the old graph ended up with a dozen references to concepts that no longer existed,
   * and this is the one place that knows exactly which files need touching.
   */
  const deleteNode = (key: string) =>
    act(`deleted ${key}`, async () => {
      for (const dep of nodeInto.get(key) ?? []) {
        const d = nodeBy.get(dep);
        if (d) await call("PUT", `nodes/${dep}`, { requires: d.requires.filter((e) => e.id !== key) });
      }
      await call("DELETE", `nodes/${key}`);
      go({ sel: "" }, "replace");
    });

  const saveNode = (key: string, patch: Record<string, unknown>, label: string) =>
    act(label, () => call("PUT", `nodes/${key}`, patch).then(() => {}));

  latest.current = { dropEdge, addEdge, setLevel, setStrength };

  // ---- the old list
  const oldList = useMemo(() => {
    const q = where.q.trim().toLowerCase();
    return old
      .filter((c) => {
        const s = stateOf(c.key);
        if (where.show === "ready" && !isReady(c.key)) return false;
        if (where.show === "pending" && s !== "pending") return false;
        if (where.show === "adopted" && s !== "adopted") return false;
        if (where.show === "skipped" && s !== "skipped") return false;
        if (where.fam && familyOf(c.key, c.foundation_tier) !== where.fam) return false;
        if (
          q &&
          !c.key.includes(q) &&
          !c.title.toLowerCase().includes(q) &&
          !c.aliases.some((a) => a.toLowerCase().includes(q))
        ) return false;
        return true;
      })
      .sort((a, b) => (a.level ?? 9) - (b.level ?? 9) || a.title.localeCompare(b.title));
  }, [old, where.q, where.show, where.fam, stateOf, isReady]);

  const offline = live === "offline";

  return (
    <div className="builder-page">
      <h1>Graph builder</h1>
      <p className="lede">
        Building the concept graph from scratch into <code>content/graph/nodes/</code>, with
        the old graph as a read-only guide. <b>{nodes.length}</b> nodes and{" "}
        <b>{progress.edges}</b> edges so far. Of {old.length} old concepts:{" "}
        <b>{progress.adopted}</b> adopted, <b>{progress.skipped}</b> skipped,{" "}
        <b>{progress.pending}</b> pending ({progress.ready} ready).{" "}
        {live === "live" ? (
          <span className="ok">Live from the API.</span>
        ) : offline ? (
          <span className="bad">No API — read-only build-time snapshot.</span>
        ) : (
          <span className="dim">Loading…</span>
        )}
      </p>

      <div className="progressbar" aria-hidden>
        <span className="p-adopted" style={{ width: `${(progress.adopted / Math.max(1, old.length)) * 100}%` }} />
        <span className="p-skipped" style={{ width: `${(progress.skipped / Math.max(1, old.length)) * 100}%` }} />
      </div>

      {offline && (
        <div className="banner warn">
          <b>Read-only.</b> Could not reach the API at <code>{API}</code>. Start it with{" "}
          <code>docker compose up -d api</code>.
        </div>
      )}
      {(progress.dangling.length > 0 || progress.inversions.length > 0) && (
        <div className="banner warn">
          {progress.dangling.length > 0 && (
            <>
              <b>Dangling:</b> {progress.dangling.join(", ")}.{" "}
            </>
          )}
          {progress.inversions.length > 0 && (
            <>
              <b>Level inversions:</b> {progress.inversions.join("; ")}.
            </>
          )}
        </div>
      )}

      <div className="builder">
        {/* ------------------------------------------------------------- old graph */}
        <section className="bpane oldpane">
          {((selKind === "new" && nodeBy.has(selKey)) || (selKind === "old" && oldBy.has(selKey))) && (
            <OpusBox
              key={where.sel}
              kind={selKind!}
              subject={selKey}
              nodeBy={nodeBy}
              oldBy={oldBy}
              stateOf={stateOf}
              disabled={offline || busy}
              onSelectOld={(k) => select("old", k)}
              onSelectNew={(k) => select("new", k)}
              onAdoptAndLink={adoptAndLink}
              onMerge={mergeInto}
              onSkip={skip}
              onPlace={applyPlacement}
            />
          )}
          <header>
            <h2>Old graph</h2>
            <span className="dim">{oldList.length} shown</span>
          </header>
          {draft.trim().length >= 2 && (
            <div className="similar" aria-live="polite">
              <h3>
                Like “{draft.trim()}” <span className="dim">{similar.length || "nothing"}</span>
              </h3>
              {similar.length > 0 ? (
                <ul className="oldlist">
                  {similar.map((h) => {
                    const s = h.kind === "old" ? stateOf(h.key) : null;
                    const on = selKind === h.kind && selKey === h.key;
                    return (
                      <li key={`${h.kind}:${h.key}`}>
                        <button
                          className={`oldrow ${s ? `s-${s}` : "s-new"} ${on ? "on" : ""}`}
                          onClick={() => select(h.kind, h.key)}
                          title={`${h.kind === "new" ? "new node" : "old concept"} ${h.key} · ${Math.round(h.score * 100)}% match`}
                        >
                          <span className="glyph">
                            {h.kind === "new" ? "◆" : s === "adopted" ? "●" : s === "skipped" ? "✕" : "○"}
                          </span>
                          <span className="t">{h.title}</span>
                          <span className="dim">{h.kind === "new" ? "new" : "old"} L{h.level ?? "?"}</span>
                        </button>
                      </li>
                    );
                  })}
                </ul>
              ) : (
                <p className="note">No existing concept looks like this — a new node is warranted.</p>
              )}
            </div>
          )}
          <input
            className="search"
            placeholder="Find an old concept…"
            value={where.q}
            onChange={(e) => go({ q: e.target.value }, "replace")}
          />
          <div className="tabs">
            {SHOWS.map((s) => (
              <button
                key={s}
                className={`tab mini ${where.show === s ? "on" : ""}`}
                onClick={() => go({ show: s }, "push")}
              >
                {s}
              </button>
            ))}
          </div>
          <select value={where.fam} onChange={(e) => go({ fam: e.target.value }, "push")}>
            <option value="">all families</option>
            {FAMILIES.map((f) => (
              <option key={f.id} value={f.id}>{f.title}</option>
            ))}
          </select>
          {where.show === "ready" && (
            <p className="note">
              Pending concepts whose old prerequisites are all decided. Working from this list
              builds the graph bottom-up, so every adopt can wire its prerequisites at once.
            </p>
          )}
          <ul className="oldlist">
            {oldList.map((c) => {
              const s = stateOf(c.key);
              return (
                <li key={c.key}>
                  <button
                    className={`oldrow s-${s} ${selKind === "old" && selKey === c.key ? "on" : ""}`}
                    onClick={() => select("old", c.key)}
                    title={c.key}
                  >
                    <span className="glyph" aria-label={s}>
                      {s === "adopted" ? "●" : s === "skipped" ? "✕" : isReady(c.key) ? "◎" : "○"}
                    </span>
                    <span className="t">{c.title}</span>
                    <span className="dim">L{c.level ?? "?"}</span>
                  </button>
                </li>
              );
            })}
            {oldList.length === 0 && <li className="dim">Nothing matches.</li>}
          </ul>
        </section>

        {/* ------------------------------------------------------------- new graph */}
        <section className="bpane newpane">
          <NewCanvas
            nodes={nodes}
            nodeBy={nodeBy}
            nodeInto={nodeInto}
            cols={where.cols}
            onCols={(cols) => go({ cols }, "push")}
            around={where.around}
            onAround={(around) => go({ around }, "push")}
            selected={selKind === "new" ? selKey : null}
            // An old concept selected on the left lights up where its old neighbours
            // landed on the right — the question "where does this go" answered in place.
            oldHint={
              selKind === "old"
                ? {
                    self: adoptedAs.get(selKey) ?? null,
                    up: new Set((oldBy.get(selKey)?.requires ?? []).map((id) => adoptedAs.get(id)).filter((k): k is string => !!k)),
                    down: new Set((oldInto.get(selKey) ?? []).map((id) => adoptedAs.get(id)).filter((k): k is string => !!k)),
                  }
                : null
            }
            onSelect={(key) => select("new", key)}
            onLink={canvasLink}
            onUnlink={canvasUnlink}
            onLevel={canvasLevel}
            undo={undo?.label ?? null}
            onUndo={runUndo}
            busy={busy || offline}
          />
          <NewNodeForm
            disabled={offline || busy}
            onCreate={createBlank}
            onDraft={setDraft}
            exists={(k) => nodeBy.has(k)}
          />
        </section>

        {/* ------------------------------------------------------------- inspector */}
        <section className="bpane inspectpane">
          {message && <p className={`bmsg ${message.bad ? "bad" : "ok"}`}>{message.text}</p>}
          {selKind === "old" && oldBy.has(selKey) ? (
            <OldInspector
              key={selKey}
              c={oldBy.get(selKey)!}
              state={stateOf(selKey)}
              skipReason={skipBy.get(selKey)?.reason}
              adoptedAs={adoptedAs}
              oldBy={oldBy}
              oldInto={oldInto}
              stateOf={stateOf}
              nodes={nodes}
              nodeBy={nodeBy}
              disabled={offline || busy}
              onSelectOld={(k) => select("old", k)}
              onSelectNew={(k) => select("new", k)}
              onAdopt={(opts) =>
                act(`adopted ${selKey}`, async () => {
                  const node = await adoptOld(selKey, opts);
                  select("new", node.key);
                })
              }
              onMerge={(target) => mergeInto(selKey, target)}
              onSkip={(reason) => skip(selKey, reason)}
              onUnskip={() => unskip(selKey)}
            />
          ) : selKind === "new" && nodeBy.has(selKey) ? (
            <NodeInspector
              key={selKey}
              n={nodeBy.get(selKey)!}
              nodeBy={nodeBy}
              nodeInto={nodeInto}
              oldBy={oldBy}
              oldInto={oldInto}
              adoptedAs={adoptedAs}
              stateOf={stateOf}
              disabled={offline || busy}
              onSelectOld={(k) => select("old", k)}
              onSelectNew={(k) => select("new", k)}
              onAddEdge={addEdge}
              onAddEdges={addEdges}
              onDropEdge={dropEdge}
              onStrength={setStrength}
              onSave={saveNode}
              onDetach={(oldKey) => detach(selKey, oldKey)}
              onDelete={() => deleteNode(selKey)}
              onAdoptAndLink={(oldKey, dir, strength) => adoptAndLink(selKey, oldKey, dir, strength)}
            />
          ) : (
            <div className="note">
              <p>
                <b>Start on the left.</b> Pick an old concept and adopt it, merge it into a
                node that already covers it, or skip it. Or create a node the old graph never
                had, under the canvas.
              </p>
              <p>
                Select a new node to see its edges, and what the old graph said about it
                translated into the new one — each suggestion is one click, and none is
                written without one.
              </p>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}

// -------------------------------------------------------------------------------- canvas

/**
 * Which way an edge is being drawn, and so which file it writes.
 *
 *   needs      left port    this needs what it is dropped on        (required)
 *   neededBy   right port   what it is dropped on needs this        (required)
 *   after      top port     this is usually taught after the drop   (usually-taught-before)
 *   before     bottom port  this is usually taught before the drop  (usually-taught-before)
 *
 * The two kinds of edge leave from different sides because they mean different things to
 * the layout: required edges decide the columns and run left to right; usually-taught-
 * before edges run from the bottom of the earlier concept to the top of the later one, and
 * only nudge the order inside a column. A soft edge is a sequencing hint, and letting it
 * push a node a whole column right would draw a dependency that is not there.
 */
type Dir = "needs" | "neededBy" | "after" | "before";

/** A gesture in flight — one at a time, so one state. */
type Grab =
  | { kind: "move"; key: string; x: number; dx: number }
  | { kind: "link"; key: string; dir: Dir; x1: number; y1: number; x: number; y: number; over: string | null };

/** The level column a card's left edge is nearest to, with columns by level. */
const levelAt = (cardX: number) => Math.max(0, Math.min(4, Math.round((cardX - PAD) / COL_W)));

function NewCanvas({
  nodes,
  nodeBy,
  nodeInto,
  cols,
  onCols,
  around,
  onAround,
  selected,
  oldHint,
  onSelect,
  onLink,
  onUnlink,
  onLevel,
  undo,
  onUndo,
  busy,
}: {
  nodes: GraphNode[];
  nodeBy: Map<string, GraphNode>;
  nodeInto: Map<string, string[]>;
  cols: "depth" | "level";
  onCols: (c: "depth" | "level") => void;
  around: boolean;
  onAround: (on: boolean) => void;
  selected: string | null;
  oldHint: { self: string | null; up: Set<string>; down: Set<string> } | null;
  onSelect: (key: string) => void;
  onLink: (from: string, to: string, strength?: string) => void;
  onUnlink: (from: string, to: string) => void;
  onLevel: (key: string, level: number) => void;
  undo: string | null;
  onUndo: () => void;
  busy: boolean;
}) {
  const depth = useMemo(() => depths(nodeBy, true), [nodeBy]);
  const plane = useRef<HTMLDivElement>(null);
  const [grab, setGrab] = useState<Grab | null>(null);

  // `u` undoes, as on the old canvas. Ignored while typing, where it is a letter.
  useEffect(() => {
    const onKey = (ev: KeyboardEvent) => {
      const tag = (ev.target as HTMLElement)?.tagName;
      if (tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA") return;
      if (ev.key === "u" && undo && !busy) {
        ev.preventDefault();
        onUndo();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [undo, busy, onUndo]);

  const rel = useMemo(() => {
    if (!selected) return { up: new Map<string, number>(), down: new Map<string, number>() };
    return {
      up: walk(selected, (k) => (nodeBy.get(k)?.requires ?? []).map((e) => e.id).filter((id) => nodeBy.has(id))),
      down: walk(selected, (k) => nodeInto.get(k) ?? []),
    };
  }, [selected, nodeBy, nodeInto]);

  const shown = useMemo(
    () =>
      around && selected
        ? nodes.filter((n) => n.key === selected || rel.up.has(n.key) || rel.down.has(n.key))
        : nodes,
    [nodes, around, selected, rel],
  );

  /**
   * Columns from the required edges, then an order inside each column that keeps wires short.
   *
   * Barycentre sweeps: each node moves towards the mean row of its neighbours, alternately
   * left-to-right and right-to-left. A required neighbour pulls towards its own row; a
   * usually-taught-before neighbour pulls to one row above (for what comes before) or one
   * below (for what comes after), because that edge is drawn bottom-to-top and reads best
   * when the earlier concept sits just over the later one. A last pass then guarantees it
   * inside a column: a soft prerequisite in the same column is always above its dependent.
   *
   * Deterministic — same graph, same picture — so a node stays where you last saw it.
   */
  const { placed, width, height } = useMemo(() => {
    const colOf = (n: GraphNode) =>
      cols === "level" ? Math.max(0, Math.min(4, n.level ?? 0)) : depth.get(n.key) ?? 0;
    const count = Math.max(1, ...shown.map((n) => colOf(n) + 1));
    const columns: GraphNode[][] = Array.from({ length: count }, () => []);
    for (const n of shown) columns[colOf(n)].push(n);
    for (const col of columns) col.sort((a, b) => a.title.localeCompare(b.title));

    const shownKeys = new Set(shown.map((n) => n.key));
    // Every neighbour of a node with the row offset it prefers relative to that neighbour.
    const pulls = new Map<string, { id: string; offset: number }[]>();
    const pull = (a: string, b: string, offset: number) =>
      pulls.set(a, [...(pulls.get(a) ?? []), { id: b, offset }]);
    for (const n of shown) {
      for (const e of n.requires) {
        if (!shownKeys.has(e.id)) continue;
        if (e.strength === "required") {
          pull(n.key, e.id, 0);
          pull(e.id, n.key, 0);
        } else {
          pull(n.key, e.id, 1); // the later concept wants to sit one row below
          pull(e.id, n.key, -1); // the earlier one, one row above
        }
      }
    }

    const row = new Map<string, number>();
    const index = () => columns.forEach((col) => col.forEach((n, j) => row.set(n.key, j)));
    index();
    for (let sweep = 0; sweep < 8; sweep++) {
      const order = sweep % 2 === 0 ? columns : [...columns].reverse();
      for (const col of order) {
        const score = new Map<string, number>();
        for (const n of col) {
          const ps = (pulls.get(n.key) ?? []).filter((q) => row.has(q.id));
          score.set(
            n.key,
            ps.length ? ps.reduce((sum, q) => sum + row.get(q.id)! + q.offset, 0) / ps.length : row.get(n.key)!,
          );
        }
        col.sort((a, b) => score.get(a.key)! - score.get(b.key)! || row.get(a.key)! - row.get(b.key)!);
        col.forEach((n, j) => row.set(n.key, j));
      }
    }

    // Inside a column, a usually-taught-before prerequisite goes above what it comes before.
    for (let c = 0; c < columns.length; c++) {
      const col = columns[c];
      const here = new Set(col.map((n) => n.key));
      const before = new Map<string, string[]>();
      for (const n of col) {
        for (const e of n.requires) {
          if (e.strength !== "required" && here.has(e.id)) before.set(n.key, [...(before.get(n.key) ?? []), e.id]);
        }
      }
      if (!before.size) continue;
      const out: GraphNode[] = [];
      const done = new Set<string>();
      const visiting = new Set<string>();
      const place = (n: GraphNode) => {
        if (done.has(n.key) || visiting.has(n.key)) return;
        visiting.add(n.key);
        for (const id of before.get(n.key) ?? []) place(col.find((x) => x.key === id)!);
        visiting.delete(n.key);
        done.add(n.key);
        out.push(n);
      };
      col.forEach(place);
      columns[c] = out;
    }

    // Rows, not indexes: a column may leave a gap so that something usually taught after a
    // concept in an earlier column sits at least one row below it, and the bottom-to-top
    // edge between them runs downwards instead of looping back up.
    const slot = new Map<string, number>();
    columns.forEach((col) => {
      let next = 0;
      for (const n of col) {
        let min = next;
        for (const e of n.requires) {
          const at = slot.get(e.id);
          if (e.strength !== "required" && at !== undefined) min = Math.max(min, at + 1);
        }
        slot.set(n.key, min);
        next = min + 1;
      }
    });
    const placed = new Map<string, { x: number; y: number; col: number }>();
    columns.forEach((col, i) =>
      col.forEach((n) =>
        placed.set(n.key, { x: PAD + i * COL_W, y: PAD + 30 + slot.get(n.key)! * (NODE_H + GAP_Y), col: i }),
      ),
    );
    const tallest = Math.max(0, ...[...slot.values()].map((r) => r + 1));
    return {
      placed,
      width: PAD * 2 + count * COL_W,
      height: Math.max(260, PAD * 2 + 30 + tallest * (NODE_H + GAP_Y)),
    };
  }, [shown, cols, depth]);

  const colCount = Math.round((width - PAD * 2) / COL_W);

  /** Cursor position in canvas coordinates. The wrapper scrolls, so measure the plane. */
  const pointIn = (ev: { clientX: number; clientY: number }) => {
    const r = plane.current?.getBoundingClientRect();
    return { x: ev.clientX - (r?.left ?? 0), y: ev.clientY - (r?.top ?? 0) };
  };

  /**
   * The node under the cursor, hit-tested against the document. Enter/leave tracking on
   * every card misses drops that cross a wire or a column gap on the way in.
   */
  const keyUnder = (ev: { clientX: number; clientY: number }) => {
    const el = document.elementFromPoint(ev.clientX, ev.clientY) as HTMLElement | null;
    return el?.closest("[data-node]")?.getAttribute("data-node") ?? null;
  };

  /**
   * Press on a card: a click selects (shift-click links), a drag sets the level.
   *
   * The drag only means something with columns by level — by depth, the column is
   * computed from the edges and there is nothing to write — so there the card stays put
   * and the gesture is just a click.
   */
  const beginMove = (ev: React.PointerEvent, key: string, x: number, level?: number) => {
    if (ev.button !== 0) return;
    const shift = ev.shiftKey;
    const startX = ev.clientX;
    const startY = ev.clientY;
    let moved = false;
    const onMove = (m: PointerEvent) => {
      if (cols !== "level" || busy) return;
      const dx = m.clientX - startX;
      if (!moved && Math.abs(dx) + Math.abs(m.clientY - startY) < 5) return;
      moved = true;
      setGrab({ kind: "move", key, x, dx });
    };
    const onUp = (m: PointerEvent) => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      setGrab(null);
      if (!moved) {
        if (shift && selected && selected !== key && !busy) onLink(selected, key);
        else onSelect(key);
        return;
      }
      const next = levelAt(x + (m.clientX - startX));
      if (next !== level) onLevel(key, next);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };

  /**
   * Press on a port: draw an edge. The left port means "this needs what I drop it on",
   * the right port "what I drop it on needs this" — the sides the wires already use.
   */
  const beginLink = (ev: React.PointerEvent, key: string, dir: Dir) => {
    if (ev.button !== 0 || busy) return;
    ev.stopPropagation();
    ev.preventDefault();
    const p = placed.get(key)!;
    const x1 = dir === "needs" ? p.x : dir === "neededBy" ? p.x + NODE_W : p.x + NODE_W / 2;
    const y1 = dir === "after" ? p.y : dir === "before" ? p.y + NODE_H : p.y + NODE_H / 2;
    const at = pointIn(ev);
    setGrab({ kind: "link", key, dir, x1, y1, x: at.x, y: at.y, over: null });
    const onMove = (m: PointerEvent) => {
      const q = pointIn(m);
      const over = keyUnder(m);
      setGrab({ kind: "link", key, dir, x1, y1, x: q.x, y: q.y, over: over === key ? null : over });
    };
    const onUp = (m: PointerEvent) => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      setGrab(null);
      const over = keyUnder(m);
      if (!over || over === key) return;
      if (dir === "needs") onLink(key, over);
      else if (dir === "neededBy") onLink(over, key);
      else if (dir === "after") onLink(key, over, "usually-taught-before");
      else onLink(over, key, "usually-taught-before");
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };

  if (nodes.length === 0) {
    return (
      <div className="canvaswrap empty">
        <p className="note">
          The new graph is empty. Adopt an old concept from the left — the <b>ready</b> list
          starts with the ones that rest on nothing — or create a node below.
        </p>
      </div>
    );
  }

  return (
    <>
      <div className="canvasbar">
        <div className="tabs">
          {(["depth", "level"] as const).map((c) => (
            <button key={c} className={`tab mini ${cols === c ? "on" : ""}`} onClick={() => onCols(c)}>
              columns by {c}
            </button>
          ))}
        </div>
        <label className="inlinecheck">
          <input type="checkbox" checked={around} onChange={(e) => onAround(e.target.checked)} />
          only around the selection
        </label>
        {undo && (
          <button className="tab mini undo" disabled={busy} onClick={onUndo}>
            ↩ undo {undo} <span className="dim">u</span>
          </button>
        )}
      </div>
      <p className="note keys">
        <b>Required:</b> drag the <b>left</b> port onto what a node needs, the <b>right</b> port
        onto what needs it · <b>Usually taught before:</b> drag the <b>bottom</b> port onto what
        comes after, the <b>top</b> port onto what comes before · click an edge to cut it ·{" "}
        <b>shift</b>-click: the selected node needs this one
        {cols === "level" ? <> · drag a card sideways to set its level</> : <> · switch to columns by level to drag levels</>}
      </p>
      <div className="canvaswrap">
        <div className="canvas" style={{ width, height }} ref={plane}>
          {grab?.kind === "move" && (
            <div className="dropcols" aria-hidden>
              {LEVELS.map((l) => (
                <div
                  key={l}
                  className={`dropcol ${levelAt(grab.x + grab.dx) === l ? "on" : ""}`}
                  style={{ left: PAD + l * COL_W - 10, width: COL_W - 20 }}
                >
                  <span>L{l}</span>
                </div>
              ))}
            </div>
          )}
          <div className="collabels">
            {Array.from({ length: colCount }, (_, i) => (
              <span key={i} style={{ left: PAD + i * COL_W }} className="collabel">
                {cols === "level" ? `L${i} ${LEVEL_NAMES[i] ?? ""}` : i === 0 ? "rests on nothing" : `depth ${i}`}
              </span>
            ))}
          </div>
          <svg width={width} height={height} className="wires">
            <defs>
              <marker id="soft-arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto">
                <path d="M 0 0 L 8 4 L 0 8 z" className="softhead" />
              </marker>
            </defs>
            {shown.flatMap((n) =>
              n.requires
                .filter((e) => placed.has(e.id))
                .map((e) => {
                  const a = placed.get(n.key)!;
                  const b = placed.get(e.id)!;
                  const soft = e.strength !== "required";
                  let d: string;
                  if (soft) {
                    // From the bottom of the prerequisite (b) to the top of the later
                    // concept (a), leaving and arriving vertically. When the later one
                    // sits higher, the handles stretch so the curve loops round instead
                    // of cutting back through both cards.
                    const x1 = b.x + NODE_W / 2, y1 = b.y + NODE_H;
                    const x2 = a.x + NODE_W / 2, y2 = a.y;
                    const reach = Math.max(28, Math.abs(y2 - y1) / 2, y2 < y1 ? NODE_H + 40 : 0);
                    d = `M ${x1} ${y1} C ${x1} ${y1 + reach}, ${x2} ${y2 - reach}, ${x2} ${y2}`;
                  } else {
                    const x1 = a.x, y1 = a.y + NODE_H / 2;
                    const x2 = b.x + NODE_W, y2 = b.y + NODE_H / 2;
                    const mx = (x1 + x2) / 2;
                    d = `M ${x1} ${y1} C ${mx} ${y1}, ${mx} ${y2}, ${x2} ${y2}`;
                  }
                  const t = nodeBy.get(e.id);
                  const inv = typeof n.level === "number" && typeof t?.level === "number" && t.level > n.level;
                  const up = !!selected && (n.key === selected || rel.up.has(n.key)) && rel.up.has(e.id);
                  const down = !!selected && (e.id === selected || rel.down.has(e.id)) && rel.down.has(n.key);
                  return (
                    <path
                      key={`${n.key}>${e.id}`}
                      d={d}
                      markerEnd={soft ? "url(#soft-arrow)" : undefined}
                      className={[
                        "wire",
                        inv ? "inv" : "",
                        soft ? "soft" : "",
                        up ? "up" : "",
                        down ? "down" : "",
                        selected && !up && !down ? "mute" : "",
                      ].join(" ")}
                      onClick={() => !busy && onUnlink(n.key, e.id)}
                    >
                      <title>
                        {soft
                          ? `${e.id} is usually taught before ${n.key} — click to cut`
                          : `${n.key} needs ${e.id} — click to cut`}
                      </title>
                    </path>
                  );
                }),
            )}
            {/* The edge being drawn, curved like a real one, never hit-tested. */}
            {grab?.kind === "link" && (
              <path
                className={`wire ghost ${grab.dir === "needs" || grab.dir === "after" ? "up" : "down"} ${
                  grab.dir === "after" || grab.dir === "before" ? "soft" : ""
                }`}
                d={
                  grab.dir === "after" || grab.dir === "before"
                    ? `M ${grab.x1} ${grab.y1} C ${grab.x1} ${(grab.y1 + grab.y) / 2}, ${grab.x} ${(grab.y1 + grab.y) / 2}, ${grab.x} ${grab.y}`
                    : `M ${grab.x1} ${grab.y1} C ${(grab.x1 + grab.x) / 2} ${grab.y1}, ${(grab.x1 + grab.x) / 2} ${grab.y}, ${grab.x} ${grab.y}`
                }
              />
            )}
          </svg>
          {shown.map((n) => {
            const p = placed.get(n.key)!;
            const upAt = rel.up.get(n.key);
            const downAt = rel.down.get(n.key);
            const hinted = oldHint && (oldHint.self === n.key || oldHint.up.has(n.key) || oldHint.down.has(n.key));
            const hinting = !!oldHint && (!!oldHint.self || oldHint.up.size > 0 || oldHint.down.size > 0);
            const moving = grab?.kind === "move" && grab.key === n.key;
            return (
              <div
                key={n.key}
                data-node={n.key}
                className={[
                  "node",
                  moving ? "moving" : "",
                  grab?.kind === "link" && grab.key === n.key ? "linking" : "",
                  grab?.kind === "link" && grab.over === n.key ? "target" : "",
                  selected === n.key ? "focus" : "",
                  upAt ? "rel-up" : "",
                  downAt ? "rel-down" : "",
                  (upAt ?? downAt) === 1 ? "rel-near" : "",
                  oldHint?.up.has(n.key) ? "rel-up rel-near" : "",
                  oldHint?.down.has(n.key) ? "rel-down rel-near" : "",
                  oldHint?.self === n.key ? "focus" : "",
                  (selected && selected !== n.key && !upAt && !downAt) || (hinting && !hinted) ? "mute" : "",
                  busy ? "busy" : "",
                ].join(" ")}
                style={{
                  left: p.x, top: p.y, width: NODE_W, height: NODE_H,
                  transform: moving ? `translateX(${grab.dx}px)` : undefined,
                }}
                onPointerDown={(ev) => beginMove(ev, n.key, p.x, n.level)}
                title={`${n.key}\nL${n.level ?? "?"} · depth ${depth.get(n.key) ?? 0} · ${
                  n.from.length ? `replaces ${n.from.join(", ")}` : "no old concept"
                }`}
              >
                <span
                  className="port left"
                  title={`drag onto a prerequisite — ${n.key} needs it`}
                  onPointerDown={(ev) => beginLink(ev, n.key, "needs")}
                />
                <span
                  className="port right"
                  title={`drag onto a dependent — it needs ${n.key}`}
                  onPointerDown={(ev) => beginLink(ev, n.key, "neededBy")}
                />
                <span
                  className="port top"
                  title={`drag onto what is usually taught before ${n.key}`}
                  onPointerDown={(ev) => beginLink(ev, n.key, "after")}
                />
                <span
                  className="port bottom"
                  title={`drag onto what is usually taught after ${n.key}`}
                  onPointerDown={(ev) => beginLink(ev, n.key, "before")}
                />
                <b>{n.title}</b>
                <span className="nodemeta">
                  L{n.level ?? "?"}
                  {n.requires.length > 0 && ` · ${n.requires.length}↓`}
                  {(nodeInto.get(n.key) ?? []).length > 0 && ` · ${(nodeInto.get(n.key) ?? []).length}↑`}
                  {n.from.length === 0 ? " · new" : n.from.length > 1 ? ` · ${n.from.length} merged` : ""}
                </span>
              </div>
            );
          })}
        </div>
      </div>
    </>
  );
}

/** A node the old graph never had. The id is the filename, so it is typed deliberately. */
function NewNodeForm({
  disabled,
  onCreate,
  onDraft,
  exists,
}: {
  disabled: boolean;
  onCreate: (key: string, title: string, level?: number) => void;
  onDraft: (title: string) => void;
  exists: (key: string) => boolean;
}) {
  const [title, setTitle] = useState("");
  const [key, setKey] = useState("");
  const [touched, setTouched] = useState(false);
  const [level, setLevel] = useState("");
  const slug = touched ? key : title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  const valid = /^[a-z0-9][a-z0-9-]*$/.test(slug) && !exists(slug) && title.trim() !== "";
  return (
    <div className="editrow newnode">
      <label>
        New node
        <input
          value={title}
          placeholder="title"
          onChange={(e) => {
            setTitle(e.target.value);
            onDraft(e.target.value);
          }}
        />
      </label>
      <label>
        id
        <input
          value={slug}
          onChange={(e) => {
            setTouched(true);
            setKey(e.target.value);
          }}
        />
      </label>
      <label>
        level
        <select value={level} onChange={(e) => setLevel(e.target.value)}>
          <option value="">—</option>
          {LEVELS.map((l) => <option key={l} value={l}>{l}</option>)}
        </select>
      </label>
      <button
        className="tab"
        disabled={disabled || !valid}
        onClick={() => {
          onCreate(slug, title.trim(), level === "" ? undefined : Number(level));
          setTitle("");
          setKey("");
          setTouched(false);
          onDraft("");
        }}
      >
        Create
      </button>
      {slug && exists(slug) && <span className="dim bad">{slug} exists</span>}
    </div>
  );
}

// ------------------------------------------------------------------------ old inspector

function OldInspector({
  c,
  state,
  skipReason,
  adoptedAs,
  oldBy,
  oldInto,
  stateOf,
  nodes,
  nodeBy,
  disabled,
  onSelectOld,
  onSelectNew,
  onAdopt,
  onMerge,
  onSkip,
  onUnskip,
}: {
  c: OldConcept;
  state: OldState;
  skipReason?: string;
  adoptedAs: Map<string, string>;
  oldBy: Map<string, OldConcept>;
  oldInto: Map<string, string[]>;
  stateOf: (k: string) => OldState;
  nodes: GraphNode[];
  nodeBy: Map<string, GraphNode>;
  disabled: boolean;
  onSelectOld: (k: string) => void;
  onSelectNew: (k: string) => void;
  onAdopt: (opts: { key: string; title: string; level?: number; wire: boolean }) => void;
  onMerge: (target: string) => void;
  onSkip: (reason: string) => void;
  onUnskip: () => void;
}) {
  const [body, setBody] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    fetch(`${API}/concepts/${c.key}`)
      .then((r) => (r.ok ? r.json() : Promise.reject()))
      .then((rec) => alive && setBody(cleanOldBody(String(rec?.body ?? ""))))
      .catch(() => alive && setBody(""));
    return () => {
      alive = false;
    };
  }, [c.key]);

  const [key, setKey] = useState(c.key);
  const [title, setTitle] = useState(c.title);
  const [level, setLevel] = useState(c.level === undefined ? "" : String(c.level));
  const [wire, setWire] = useState(true);
  const [target, setTarget] = useState("");
  const [reason, setReason] = useState("");

  const prereqs = c.requires.filter((id) => oldBy.has(id));
  const dependents = oldInto.get(c.key) ?? [];
  const wired = [...new Set(prereqs.map((id) => adoptedAs.get(id)).filter((k): k is string => !!k))];

  // Nodes that might already cover this: shared words in the name, or a source that is
  // one of this concept's own aliases. Offered as merge targets, never applied.
  const candidates = useMemo(() => {
    const mine = words([c.title, c.key, ...c.aliases].join(" "));
    return nodes
      .map((n) => {
        const theirs = words([n.title, n.key, ...n.from.map((f) => oldBy.get(f)?.title ?? f)].join(" "));
        let score = 0;
        for (const w of mine) if (theirs.has(w)) score += 1;
        return { n, score };
      })
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 5)
      .map((x) => x.n);
  }, [c, nodes, oldBy]);

  const keyOk = /^[a-z0-9][a-z0-9-]*$/.test(key) && !nodeBy.has(key);

  return (
    <div className="insp">
      <header>
        <span className="dim">old concept</span>
        <h2>{c.title}</h2>
        <div className="chips">
          <span className="chip"><code>{c.key}</code></span>
          <span className="chip">L{c.level ?? "?"}</span>
          <span className="chip">{FAMILIES.find((f) => f.id === familyOf(c.key, c.foundation_tier))?.title}</span>
          <span className={`chip ${state === "adopted" ? "ok" : state === "skipped" ? "bad" : "warn"}`}>{state}</span>
        </div>
      </header>

      {body === null ? (
        <p className="dim">loading description…</p>
      ) : body ? (
        <p className="oldbody">{body}</p>
      ) : (
        <p className="dim">No description.</p>
      )}
      {c.aliases.length > 0 && <p className="dim">also: {c.aliases.join(", ")}</p>}

      <h3>Old prerequisites · {prereqs.length}</h3>
      <OldRefs keys={prereqs} oldBy={oldBy} stateOf={stateOf} adoptedAs={adoptedAs} onSelectOld={onSelectOld} onSelectNew={onSelectNew} />
      <h3>Old dependents · {dependents.length}</h3>
      <OldRefs keys={dependents} oldBy={oldBy} stateOf={stateOf} adoptedAs={adoptedAs} onSelectOld={onSelectOld} onSelectNew={onSelectNew} />

      {state === "adopted" && (
        <div className="decide">
          <p>
            Adopted into{" "}
            <button className="chip link ok" onClick={() => onSelectNew(adoptedAs.get(c.key)!)}>
              {adoptedAs.get(c.key)}
            </button>
            . Detach it from that node to decide again.
          </p>
        </div>
      )}

      {state === "skipped" && (
        <div className="decide">
          <p>
            Skipped{skipReason ? <>: <i>{skipReason}</i></> : " with no reason given"}.
          </p>
          <button className="tab mini" disabled={disabled} onClick={onUnskip}>Un-skip</button>
        </div>
      )}

      {state === "pending" && (
        <>
          <div className="decide">
            <h3>Adopt as a new node</h3>
            <div className="fieldgrid tight">
              <label className="editfield">
                <span className="fieldlabel">id</span>
                <input value={key} onChange={(e) => setKey(e.target.value.trim())} />
              </label>
              <label className="editfield">
                <span className="fieldlabel">level</span>
                <select value={level} onChange={(e) => setLevel(e.target.value)}>
                  <option value="">—</option>
                  {LEVELS.map((l) => <option key={l} value={l}>{l} · {LEVEL_NAMES[l]}</option>)}
                </select>
              </label>
            </div>
            <label className="editfield">
              <span className="fieldlabel">title</span>
              <input value={title} onChange={(e) => setTitle(e.target.value)} />
            </label>
            <label className="inlinecheck">
              <input type="checkbox" checked={wire} onChange={(e) => setWire(e.target.checked)} />
              {wired.length
                ? `also needs ${wired.join(", ")} — its old prerequisites already in the new graph`
                : "wire old prerequisites already in the new graph (none yet)"}
            </label>
            <button
              className="tab primary"
              disabled={disabled || !keyOk || !title.trim()}
              onClick={() => onAdopt({ key, title, level: level === "" ? undefined : Number(level), wire })}
            >
              Adopt
            </button>
            {!keyOk && key && <span className="dim bad"> {nodeBy.has(key) ? `${key} exists — merge instead` : "invalid id"}</span>}
          </div>

          <div className="decide">
            <h3>Merge into an existing node</h3>
            <p className="note">
              When a node already covers this under another name. The node keeps its id; this
              concept is recorded as one of its sources, so its old edges become suggestions there.
            </p>
            {candidates.length > 0 && (
              <div className="chips">
                {candidates.map((n) => (
                  <button key={n.key} className="chip link" disabled={disabled} onClick={() => onMerge(n.key)}>
                    ⤵ {n.title}
                  </button>
                ))}
              </div>
            )}
            <div className="editrow">
              <input list="builder-nodes" value={target} placeholder="node id" onChange={(e) => setTarget(e.target.value)} />
              <button className="tab" disabled={disabled || !nodeBy.has(target.trim())} onClick={() => onMerge(target.trim())}>
                Merge
              </button>
            </div>
            <datalist id="builder-nodes">
              {nodes.map((n) => <option key={n.key} value={n.key}>{n.title}</option>)}
            </datalist>
          </div>

          <div className="decide">
            <h3>Skip</h3>
            <p className="note">Not carried over. The reason is kept, so the decision can be read back later.</p>
            <div className="editrow">
              <input value={reason} placeholder="why — e.g. not a concept, a combo; duplicate of…" onChange={(e) => setReason(e.target.value)} />
              <button className="tab" disabled={disabled} onClick={() => onSkip(reason)}>Skip</button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

function OldRefs({
  keys,
  oldBy,
  stateOf,
  adoptedAs,
  onSelectOld,
  onSelectNew,
}: {
  keys: string[];
  oldBy: Map<string, OldConcept>;
  stateOf: (k: string) => OldState;
  adoptedAs: Map<string, string>;
  onSelectOld: (k: string) => void;
  onSelectNew: (k: string) => void;
}) {
  if (!keys.length) return <p className="dim">none</p>;
  return (
    <ul className="reflist">
      {keys.map((k) => {
        const s = stateOf(k);
        const as = adoptedAs.get(k);
        return (
          <li key={k}>
            <button className="linkish" onClick={() => onSelectOld(k)}>{oldBy.get(k)?.title ?? k}</button>
            <span className="dim"> L{oldBy.get(k)?.level ?? "?"}</span>{" "}
            {as ? (
              <button className="chip link ok" onClick={() => onSelectNew(as)}>→ {as}</button>
            ) : (
              <span className={`chip ${s === "skipped" ? "bad" : "warn"}`}>{s}</span>
            )}
          </li>
        );
      })}
    </ul>
  );
}

// ----------------------------------------------------------------------- node inspector

type Suggestion =
  | { kind: "link"; oldKey: string; node: string; cycle: boolean }
  | { kind: "adopt"; oldKey: string }
  | { kind: "skipped"; oldKey: string };

function NodeInspector({
  n,
  nodeBy,
  nodeInto,
  oldBy,
  oldInto,
  adoptedAs,
  stateOf,
  disabled,
  onSelectOld,
  onSelectNew,
  onAddEdge,
  onAddEdges,
  onDropEdge,
  onStrength,
  onSave,
  onDetach,
  onDelete,
  onAdoptAndLink,
}: {
  n: GraphNode;
  nodeBy: Map<string, GraphNode>;
  nodeInto: Map<string, string[]>;
  oldBy: Map<string, OldConcept>;
  oldInto: Map<string, string[]>;
  adoptedAs: Map<string, string>;
  stateOf: (k: string) => OldState;
  disabled: boolean;
  onSelectOld: (k: string) => void;
  onSelectNew: (k: string) => void;
  onAddEdge: (from: string, to: string, strength?: string) => void;
  onAddEdges: (from: string, tos: string[]) => void;
  onDropEdge: (from: string, to: string) => void;
  onStrength: (from: string, to: string, strength: string) => void;
  onSave: (key: string, patch: Record<string, unknown>, label: string) => Promise<boolean>;
  onDetach: (oldKey: string) => void;
  onDelete: () => void;
  onAdoptAndLink: (oldKey: string, dir: "prereq" | "dependent", strength?: string) => void;
}) {
  const [title, setTitle] = useState(n.title);
  const [addId, setAddId] = useState("");
  const [addDepId, setAddDepId] = useState("");

  const [body, setBody] = useState("");
  const [loaded, setLoaded] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    fetch(`${API}/nodes/${n.key}`)
      .then((r) => (r.ok ? r.json() : Promise.reject()))
      .then((rec) => {
        if (!alive) return;
        const text = String(rec?.body ?? "");
        setBody(text);
        setLoaded(text);
      })
      .catch(() => alive && setLoaded(null));
    return () => {
      alive = false;
    };
  }, [n.key]);

  const dependents = nodeInto.get(n.key) ?? [];
  const sources = new Set(n.from);

  /**
   * The old graph's opinion, translated.
   *
   * For every old concept this node replaces: each old prerequisite becomes either an
   * edge to the node it was adopted as, an offer to adopt it and link in one go, or a
   * note that it was skipped. Same for old dependents in the other direction. Anything
   * already true in the new graph is dropped — a suggestion list that includes what you
   * already did is a list you stop reading.
   */
  const suggest = (oldKeys: string[], dir: "prereq" | "dependent"): Suggestion[] => {
    const seen = new Set<string>();
    const out: Suggestion[] = [];
    for (const k of oldKeys) {
      if (sources.has(k) || !oldBy.has(k)) continue;
      const as = adoptedAs.get(k);
      const dedupe = as ?? `old:${k}`;
      if (seen.has(dedupe)) continue;
      seen.add(dedupe);
      if (as) {
        if (as === n.key) continue;
        const already =
          dir === "prereq"
            ? n.requires.some((e) => e.id === as)
            : (nodeBy.get(as)?.requires ?? []).some((e) => e.id === n.key);
        if (already) continue;
        const cycle = dir === "prereq" ? reaches(nodeBy, as, n.key) : reaches(nodeBy, n.key, as);
        out.push({ kind: "link", oldKey: k, node: as, cycle });
      } else if (stateOf(k) === "skipped") {
        out.push({ kind: "skipped", oldKey: k });
      } else {
        out.push({ kind: "adopt", oldKey: k });
      }
    }
    return out;
  };

  const oldPrereqs = [...new Set(n.from.flatMap((f) => oldBy.get(f)?.requires ?? []))];
  const oldDeps = [...new Set(n.from.flatMap((f) => oldInto.get(f) ?? []))];
  const upSugg = suggest(oldPrereqs, "prereq");
  const downSugg = suggest(oldDeps, "dependent");
  const linkable = upSugg.filter((s): s is Extract<Suggestion, { kind: "link" }> => s.kind === "link" && !s.cycle);

  const renderSugg = (s: Suggestion, dir: "prereq" | "dependent") => {
    const oldTitle = oldBy.get(s.oldKey)?.title ?? s.oldKey;
    if (s.kind === "link") {
      const label = dir === "prereq" ? `needs ${s.node}` : `${s.node} needs this`;
      return (
        <li key={s.oldKey}>
          <button
            className="chip link ok"
            disabled={disabled || s.cycle}
            title={s.cycle ? "would close a cycle" : `from old: ${s.oldKey}`}
            onClick={() => (dir === "prereq" ? onAddEdge(n.key, s.node) : onAddEdge(s.node, n.key))}
          >
            + {label}
          </button>
          {s.cycle && <span className="dim bad"> cycle</span>}
          {s.oldKey !== s.node && <span className="dim"> via {oldTitle}</span>}
        </li>
      );
    }
    if (s.kind === "adopt") {
      return (
        <li key={s.oldKey}>
          <button className="linkish" onClick={() => onSelectOld(s.oldKey)}>{oldTitle}</button>
          <span className="dim"> L{oldBy.get(s.oldKey)?.level ?? "?"} pending </span>
          <button className="chip link" disabled={disabled} onClick={() => onAdoptAndLink(s.oldKey, dir)}>
            adopt &amp; link
          </button>
        </li>
      );
    }
    return (
      <li key={s.oldKey} className="dim">
        <button className="linkish dim" onClick={() => onSelectOld(s.oldKey)}>{oldTitle}</button> — skipped
      </li>
    );
  };

  const addable = (id: string) => nodeBy.has(id) && id !== n.key;

  return (
    <div className="insp">
      <header>
        <span className="dim">new node</span>
        <div className="editrow">
          <input className="titleedit" value={title} onChange={(e) => setTitle(e.target.value)} />
          {title.trim() && title.trim() !== n.title && (
            <button className="tab mini" disabled={disabled} onClick={() => onSave(n.key, { title: title.trim() }, `renamed ${n.key}`)}>
              Save title
            </button>
          )}
        </div>
        <div className="chips">
          <span className="chip"><code>{n.key}</code></span>
          <span className="levelset">
            {LEVELS.map((l) => (
              <button
                key={l}
                className={`tab mini ${n.level === l ? "on" : ""}`}
                disabled={disabled}
                title={LEVEL_NAMES[l]}
                onClick={() => onSave(n.key, { level: l }, `${n.key} → level ${l}`)}
              >
                {l}
              </button>
            ))}
          </span>
        </div>
      </header>

      <h3>Needs · {n.requires.length}</h3>
      {n.requires.length === 0 ? (
        <p className="dim">Nothing — a root of the new graph.</p>
      ) : (
        <ul className="reflist">
          {n.requires.map((e) => (
            <li key={e.id}>
              <button className={`linkish ${nodeBy.has(e.id) ? "" : "bad"}`} onClick={() => onSelectNew(e.id)}>
                {nodeBy.get(e.id)?.title ?? `${e.id} (missing)`}
              </button>{" "}
              <select value={e.strength} disabled={disabled} onChange={(ev) => onStrength(n.key, e.id, ev.target.value)}>
                {STRENGTHS.map((s) => <option key={s} value={s}>{s}</option>)}
              </select>{" "}
              <button className="chip link bad" disabled={disabled} onClick={() => onDropEdge(n.key, e.id)}>✕</button>
            </li>
          ))}
        </ul>
      )}
      <div className="editrow">
        <input list="builder-node-ids" value={addId} placeholder="add prerequisite (node id)" onChange={(e) => setAddId(e.target.value)} />
        <button className="tab mini" disabled={disabled || !addable(addId.trim())} onClick={() => { onAddEdge(n.key, addId.trim()); setAddId(""); }}>
          Add
        </button>
      </div>

      <h3>Needed by · {dependents.length}</h3>
      {dependents.length === 0 ? (
        <p className="dim">Nothing yet.</p>
      ) : (
        <ul className="reflist">
          {dependents.map((d) => (
            <li key={d}>
              <button className="linkish" onClick={() => onSelectNew(d)}>{nodeBy.get(d)?.title ?? d}</button>{" "}
              <button className="chip link bad" disabled={disabled} onClick={() => onDropEdge(d, n.key)}>✕</button>
            </li>
          ))}
        </ul>
      )}
      <div className="editrow">
        <input list="builder-node-ids" value={addDepId} placeholder="add dependent (node id)" onChange={(e) => setAddDepId(e.target.value)} />
        <button className="tab mini" disabled={disabled || !addable(addDepId.trim())} onClick={() => { onAddEdge(addDepId.trim(), n.key); setAddDepId(""); }}>
          Add
        </button>
      </div>
      <datalist id="builder-node-ids">
        {[...nodeBy.values()].map((x) => <option key={x.key} value={x.key}>{x.title}</option>)}
      </datalist>

      <AiPanel
        n={n}
        nodeBy={nodeBy}
        oldBy={oldBy}
        stateOf={stateOf}
        disabled={disabled}
        onAddEdge={onAddEdge}
        onDropEdge={onDropEdge}
        onAdoptAndLink={onAdoptAndLink}
        onSelectOld={onSelectOld}
        onSelectNew={onSelectNew}
        onLevel={(l) => onSave(n.key, { level: l }, `${n.key} → level ${l}`)}
      />

      <div className="decide sugg">
        <h3>
          The old graph says it needs · {upSugg.length}
          {linkable.length > 1 && (
            <button
              className="tab mini"
              disabled={disabled}
              style={{ marginLeft: 8 }}
              onClick={() => onAddEdges(n.key, linkable.map((s) => s.node))}
            >
              accept {linkable.length}
            </button>
          )}
        </h3>
        {upSugg.length ? <ul className="reflist">{upSugg.map((s) => renderSugg(s, "prereq"))}</ul> : <p className="dim">Nothing left to suggest.</p>}
        <h3>The old graph says these need it · {downSugg.length}</h3>
        {downSugg.length ? <ul className="reflist">{downSugg.map((s) => renderSugg(s, "dependent"))}</ul> : <p className="dim">Nothing left to suggest.</p>}
      </div>

      <h3>Replaces · {n.from.length}</h3>
      {n.from.length === 0 ? (
        <p className="dim">No old concept — this node is new, so the old graph has nothing to suggest.</p>
      ) : (
        <ul className="reflist">
          {n.from.map((f) => (
            <li key={f}>
              <button className="linkish" onClick={() => onSelectOld(f)}>{oldBy.get(f)?.title ?? f}</button>
              <span className="dim"> {f} </span>
              <button className="chip link bad" disabled={disabled} title="back to pending" onClick={() => onDetach(f)}>detach</button>
            </li>
          ))}
        </ul>
      )}

      <h3>Description</h3>
      <textarea
        className="bodyedit"
        rows={8}
        value={loaded === null ? "" : body}
        disabled={loaded === null}
        onChange={(e) => setBody(e.target.value)}
        placeholder={loaded === null ? "unavailable while the API is down" : "What it is, in a sentence or two."}
      />
      <div className="editrow">
        <button
          className="tab mini"
          disabled={disabled || loaded === null || body === loaded}
          onClick={() => void onSave(n.key, { body }, `saved ${n.key}'s description`).then((ok) => ok && setLoaded(body))}
        >
          Save description
        </button>
        <span style={{ flex: 1 }} />
        <button
          className="tab mini danger"
          disabled={disabled}
          onClick={() => {
            if (window.confirm(`Delete ${n.key}? Edges pointing at it are removed; its old concepts go back to pending.`)) onDelete();
          }}
        >
          Delete node
        </button>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------------- model panel

type AiTarget = { kind: "node" | "old"; id: string; via?: string; strength: string; reason: string };
type AiAnswer = {
  node: string;
  level: { value: number; reason: string } | null;
  prerequisites: AiTarget[];
  dependents: AiTarget[];
  remove: { id: string; reason: string }[];
  notes: string;
  dropped: string[];
  model: string;
  cached: boolean;
  usage?: { prompt_tokens?: number; completion_tokens?: number; cost?: number } | null;
};

/**
 * Opus's reading of one node, through the API's OpenRouter proxy.
 *
 * Asked for, never automatic: every uncached call costs money and takes the better part
 * of a minute, so it runs when the button is pressed and not when a node is selected.
 * Each suggestion carries its reason and is applied by its own click, exactly like the
 * old graph's suggestions below it — the model is a second opinion, not an author.
 *
 * The list is filtered against the graph as it is now, not as it was when the model
 * answered: accept one and it disappears, and one that has become redundant since (the
 * edge is implied through something else) says so instead of inviting a duplicate.
 */
function AiPanel({
  n,
  nodeBy,
  oldBy,
  stateOf,
  disabled,
  onAddEdge,
  onDropEdge,
  onAdoptAndLink,
  onSelectOld,
  onSelectNew,
  onLevel,
}: {
  n: GraphNode;
  nodeBy: Map<string, GraphNode>;
  oldBy: Map<string, OldConcept>;
  stateOf: (k: string) => OldState;
  disabled: boolean;
  onAddEdge: (from: string, to: string, strength?: string) => void;
  onDropEdge: (from: string, to: string) => void;
  onAdoptAndLink: (oldKey: string, dir: "prereq" | "dependent", strength?: string) => void;
  onSelectOld: (k: string) => void;
  onSelectNew: (k: string) => void;
  onLevel: (level: number) => void;
}) {
  const [answer, setAnswer] = useState<AiAnswer | null>(null);
  const [state, setState] = useState<"idle" | "asking" | "error">("idle");
  const [error, setError] = useState("");

  const ask = async (fresh: boolean) => {
    setState("asking");
    setError("");
    try {
      const res = await fetch(`${API}/nodes/${n.key}/suggest`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ fresh }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body?.error ?? String(res.status));
      setAnswer(body as AiAnswer);
      setState("idle");
    } catch (err) {
      setError(err instanceof TypeError ? `no API at ${API}` : (err as Error).message);
      setState("error");
    }
  };

  const row = (t: AiTarget, dir: "prereq" | "dependent") => {
    const from = dir === "prereq" ? n.key : t.id;
    const to = dir === "prereq" ? t.id : n.key;
    const title = t.kind === "node" ? nodeBy.get(t.id)?.title ?? t.id : oldBy.get(t.id)?.title ?? t.id;
    let action: React.ReactNode;
    if (t.kind === "node") {
      if (!nodeBy.has(t.id)) return null;
      if ((nodeBy.get(from)?.requires ?? []).some((e) => e.id === to)) return null;
      const cycle = reaches(nodeBy, to, from);
      const implied = !cycle && reaches(nodeBy, from, to);
      action = (
        <>
          <button
            className="chip link ok"
            disabled={disabled || cycle}
            onClick={() => onAddEdge(from, to, t.strength)}
          >
            + {dir === "prereq" ? `needs ${t.id}` : `${t.id} needs this`}
          </button>
          {cycle && <span className="dim bad"> would be a cycle</span>}
          {implied && <span className="dim"> already implied</span>}
        </>
      );
    } else {
      const s = stateOf(t.id);
      if (s !== "pending") return null;
      action = (
        <button
          className="chip link"
          disabled={disabled}
          onClick={() => onAdoptAndLink(t.id, dir, t.strength)}
        >
          adopt &amp; link
        </button>
      );
    }
    return (
      <li key={`${t.kind}:${t.id}`} className="airow">
        <div>
          <button
            className="linkish"
            onClick={() => (t.kind === "node" ? onSelectNew(t.id) : onSelectOld(t.id))}
          >
            {title}
          </button>
          {t.kind === "old" && <span className="dim"> not yet adopted</span>}
          {t.strength !== "required" && <span className="dim"> · {t.strength}</span>}{" "}
          {action}
        </div>
        {t.reason && <p className="aireason">{t.reason}</p>}
      </li>
    );
  };

  const prereqRows = answer?.prerequisites.map((t) => row(t, "prereq")).filter(Boolean) ?? [];
  const depRows = answer?.dependents.map((t) => row(t, "dependent")).filter(Boolean) ?? [];
  const removeRows =
    answer?.remove.filter((r) => n.requires.some((e) => e.id === r.id)) ?? [];
  const levelLive = answer?.level && answer.level.value !== n.level ? answer.level : null;

  return (
    <div className="decide ai">
      <h3>
        Ask Opus
        <button
          className="tab mini"
          style={{ marginLeft: 8 }}
          disabled={state === "asking"}
          onClick={() => void ask(false)}
        >
          {state === "asking" ? "thinking…" : answer ? "ask again" : "suggest edges"}
        </button>
        {answer?.cached && state !== "asking" && (
          <button className="tab mini" style={{ marginLeft: 4 }} onClick={() => void ask(true)}>
            fresh answer
          </button>
        )}
      </h3>
      {state === "asking" && (
        <p className="dim">Reading the node, its old concepts and the graph so far — this takes up to a minute.</p>
      )}
      {state === "error" && <p className="dim bad">{error}</p>}
      {answer && state !== "asking" && (
        <>
          {levelLive && (
            <div className="airow">
              <div>
                Level {n.level ?? "?"} → <b>{levelLive.value}</b>{" "}
                <button className="chip link ok" disabled={disabled} onClick={() => onLevel(levelLive.value)}>
                  set level {levelLive.value}
                </button>
              </div>
              {levelLive.reason && <p className="aireason">{levelLive.reason}</p>}
            </div>
          )}
          <p className="fieldlabel">Needs</p>
          {prereqRows.length ? <ul className="reflist">{prereqRows}</ul> : <p className="dim">Nothing to add.</p>}
          <p className="fieldlabel">Needed by</p>
          {depRows.length ? <ul className="reflist">{depRows}</ul> : <p className="dim">Nothing to add.</p>}
          {removeRows.length > 0 && (
            <>
              <p className="fieldlabel">Would drop</p>
              <ul className="reflist">
                {removeRows.map((r) => (
                  <li key={r.id} className="airow">
                    <div>
                      {nodeBy.get(r.id)?.title ?? r.id}{" "}
                      <button className="chip link bad" disabled={disabled} onClick={() => onDropEdge(n.key, r.id)}>
                        ✕ drop
                      </button>
                    </div>
                    {r.reason && <p className="aireason">{r.reason}</p>}
                  </li>
                ))}
              </ul>
            </>
          )}
          {answer.notes && <p className="aireason">{answer.notes}</p>}
          <p className="dim">
            {answer.model}
            {answer.cached ? " · cached answer" : ""}
            {typeof answer.usage?.cost === "number" ? ` · $${answer.usage.cost.toFixed(3)}` : ""}
            {answer.dropped.length > 0 && ` · ignored unknown ids: ${answer.dropped.join(", ")}`}
          </p>
        </>
      )}
    </div>
  );
}

// --------------------------------------------------------------------------- opus box

type Candidate = {
  id: string;
  action: "adopt" | "merge" | "skip";
  relation: "needs" | "needed-by" | null;
  into: string | null;
  strength: string;
  reason: string;
};
type PlaceEdge = { kind: "node" | "old"; id: string; via?: string; strength: string; reason: string };
type Placement = {
  action: "adopt" | "merge" | "skip";
  into: string | null;
  level: number | null;
  needs: PlaceEdge[];
  needed_by: PlaceEdge[];
  reason: string;
};
type OpusMeta = {
  notes: string;
  dropped: string[];
  model: string;
  cached: boolean;
  /** Saved before the graph last changed. Rows are still re-checked against the graph. */
  stale?: boolean;
  usage?: { cost?: number } | null;
};

/**
 * Opus, answering for whatever is selected — at the top of the old-graph list, because
 * both of its answers are about what to do with old concepts.
 *
 *   a new node     which pending old concepts belong next to it, and whether to adopt
 *                  each (as a prerequisite or as something built on it), merge it into a
 *                  node that already covers it, or skip it.
 *   an old concept where it belongs: adopt it (at this level, needing these, needed by
 *                  those), merge it into a node, or skip it.
 *
 * On selection it asks the API for a cached answer only, which is free: an answer paid for
 * once comes back by itself. A new answer is fetched on the button and nowhere else.
 * Everything shown is re-checked against the graph as it is now, so a candidate you have
 * since adopted or skipped drops out rather than offering a button that would fail.
 */
function OpusBox({
  kind,
  subject,
  nodeBy,
  oldBy,
  stateOf,
  disabled,
  onSelectOld,
  onSelectNew,
  onAdoptAndLink,
  onMerge,
  onSkip,
  onPlace,
}: {
  kind: "new" | "old";
  subject: string;
  nodeBy: Map<string, GraphNode>;
  oldBy: Map<string, OldConcept>;
  stateOf: (k: string) => OldState;
  disabled: boolean;
  onSelectOld: (k: string) => void;
  onSelectNew: (k: string) => void;
  onAdoptAndLink: (nodeKey: string, oldKey: string, dir: "prereq" | "dependent", strength?: string) => void;
  onMerge: (oldKey: string, into: string) => void;
  onSkip: (oldKey: string, reason: string) => void;
  onPlace: (
    oldKey: string,
    plan: { level?: number; needs: { id: string; strength: string }[]; neededBy: { id: string; strength: string }[] },
  ) => void;
}) {
  const path = kind === "new" ? `nodes/${subject}/candidates` : `concepts/${subject}/place`;
  const [answer, setAnswer] = useState<((Placement | { candidates: Candidate[] }) & OpusMeta) | null>(null);
  const [state, setState] = useState<"idle" | "asking" | "error">("idle");
  const [error, setError] = useState("");
  /** Placement edges you unticked. Keyed by `needs:<id>` / `by:<id>`. */
  const [off, setOff] = useState<Set<string>>(new Set());

  const ask = useCallback(
    async (opts: { fresh?: boolean; cachedOnly?: boolean }) => {
      if (!opts.cachedOnly) setState("asking");
      setError("");
      try {
        const res = await fetch(`${API}/${path}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ fresh: !!opts.fresh, cached_only: !!opts.cachedOnly }),
        });
        const body = await res.json().catch(() => null);
        if (!res.ok) throw new Error(body?.error ?? String(res.status));
        if (body) setAnswer(body);
        setState("idle");
      } catch (err) {
        if (opts.cachedOnly) return; // a missing cache is not worth an error line
        setError(err instanceof TypeError ? `no API at ${API}` : (err as Error).message);
        setState("error");
      }
    },
    [path],
  );

  useEffect(() => {
    void ask({ cachedOnly: true });
  }, [ask]);

  const pendingHere = kind === "old" && stateOf(subject) !== "pending";
  const titleOf = (id: string) => nodeBy.get(id)?.title ?? oldBy.get(id)?.title ?? id;

  let content: React.ReactNode = null;
  if (answer && "candidates" in answer) {
    const rows = answer.candidates.filter((c) => stateOf(c.id) === "pending" && (!c.into || nodeBy.has(c.into)));
    content = rows.length ? (
      <ul className="reflist">
        {rows.map((c) => (
          <li key={c.id} className="airow">
            <div>
              <button className="linkish" onClick={() => onSelectOld(c.id)}>{titleOf(c.id)}</button>
              <span className="dim"> L{oldBy.get(c.id)?.level ?? "?"}</span>{" "}
              {c.action === "adopt" && (
                <button
                  className="chip link ok"
                  disabled={disabled}
                  onClick={() => onAdoptAndLink(subject, c.id, c.relation === "needs" ? "prereq" : "dependent", c.strength)}
                >
                  + adopt as {c.relation === "needs" ? "prerequisite" : "dependent"}
                </button>
              )}
              {c.action === "merge" && c.into && (
                <button className="chip link" disabled={disabled} onClick={() => onMerge(c.id, c.into!)}>
                  ⤵ merge into {c.into}
                </button>
              )}
              {c.action === "skip" && (
                <button className="chip link bad" disabled={disabled} onClick={() => onSkip(c.id, c.reason)}>
                  skip
                </button>
              )}
            </div>
            {c.reason && <p className="aireason">{c.reason}</p>}
          </li>
        ))}
      </ul>
    ) : (
      <p className="dim">Nothing left from this answer — ask again for more.</p>
    );
  } else if (answer && "action" in answer) {
    const p = answer as Placement;
    if (pendingHere) {
      content = <p className="dim">Already {stateOf(subject)} — nothing to place.</p>;
    } else if (p.action === "merge" && p.into && nodeBy.has(p.into)) {
      content = (
        <div className="airow">
          <button className="chip link ok" disabled={disabled} onClick={() => onMerge(subject, p.into!)}>
            ⤵ merge into {titleOf(p.into)}
          </button>
          {p.reason && <p className="aireason">{p.reason}</p>}
        </div>
      );
    } else if (p.action === "skip") {
      content = (
        <div className="airow">
          <button className="chip link bad" disabled={disabled} onClick={() => onSkip(subject, p.reason)}>
            skip it
          </button>
          {p.reason && <p className="aireason">{p.reason}</p>}
        </div>
      );
    } else {
      const needs = p.needs.filter((e) => e.kind === "old" || nodeBy.has(e.id));
      const by = p.needed_by.filter((e) => nodeBy.has(e.id));
      const kept = {
        needs: needs.filter((e) => e.kind === "node" && !off.has(`needs:${e.id}`)),
        by: by.filter((e) => !off.has(`by:${e.id}`)),
      };
      const toggle = (k: string) =>
        setOff((prev) => {
          const next = new Set(prev);
          if (next.has(k)) next.delete(k);
          else next.add(k);
          return next;
        });
      const edgeRow = (e: PlaceEdge, side: "needs" | "by") => (
        <li key={`${side}:${e.id}`} className="airow">
          <label className="inlinecheck">
            {e.kind === "node" ? (
              <input type="checkbox" checked={!off.has(`${side}:${e.id}`)} onChange={() => toggle(`${side}:${e.id}`)} />
            ) : (
              <span className="glyph">○</span>
            )}
            <span>
              <button
                className="linkish"
                onClick={(ev) => {
                  ev.preventDefault();
                  if (e.kind === "node") onSelectNew(e.id);
                  else onSelectOld(e.id);
                }}
              >
                {titleOf(e.id)}
              </button>
              {e.kind === "old" && <span className="dim"> not adopted yet — add it after</span>}
              {e.strength !== "required" && <span className="dim"> · {e.strength}</span>}
            </span>
          </label>
          {e.reason && <p className="aireason">{e.reason}</p>}
        </li>
      );
      content = (
        <>
          <div className="airow">
            <button
              className="chip link ok"
              disabled={disabled}
              onClick={() =>
                onPlace(subject, {
                  level: p.level ?? undefined,
                  needs: kept.needs.map((e) => ({ id: e.id, strength: e.strength })),
                  neededBy: kept.by.map((e) => ({ id: e.id, strength: e.strength })),
                })
              }
            >
              + adopt at L{p.level ?? oldBy.get(subject)?.level ?? "?"}
              {kept.needs.length + kept.by.length > 0 && ` with ${kept.needs.length + kept.by.length} edge${kept.needs.length + kept.by.length > 1 ? "s" : ""}`}
            </button>
            {p.reason && <p className="aireason">{p.reason}</p>}
          </div>
          {needs.length > 0 && (
            <>
              <p className="fieldlabel">Needs</p>
              <ul className="reflist">{needs.map((e) => edgeRow(e, "needs"))}</ul>
            </>
          )}
          {by.length > 0 && (
            <>
              <p className="fieldlabel">Needed by</p>
              <ul className="reflist">{by.map((e) => edgeRow(e, "by"))}</ul>
            </>
          )}
        </>
      );
    }
  }

  return (
    <div className="opusbox">
      <h3>
        Opus · {kind === "new" ? "what to bring in next" : "where this belongs"}
        <button
          className="tab mini"
          style={{ marginLeft: "auto" }}
          disabled={state === "asking" || pendingHere}
          onClick={() => void ask({ fresh: !!answer })}
        >
          {state === "asking" ? "thinking…" : answer ? "ask again" : "ask"}
        </button>
      </h3>
      {state === "asking" && <p className="dim">Reading the graph — up to a minute.</p>}
      {state === "error" && <p className="dim bad">{error}</p>}
      {!answer && state === "idle" && (
        <p className="dim">
          {kind === "new"
            ? "Which pending old concepts belong next to this node, and what to do with each."
            : pendingHere
              ? `Already ${stateOf(subject)}.`
              : "Adopt it (and connect it), merge it into a node, or skip it."}
        </p>
      )}
      {answer && state !== "asking" && (
        <>
          {content}
          {answer.notes && <p className="aireason">{answer.notes}</p>}
          <p className="dim">
            {answer.stale ? "saved before your last changes — ask again for a fresh one" : answer.cached ? "saved answer" : answer.model}
            {typeof answer.usage?.cost === "number" && !answer.cached ? ` · $${answer.usage.cost.toFixed(3)}` : ""}
            {answer.dropped.length > 0 && ` · ignored: ${answer.dropped.join(", ")}`}
          </p>
        </>
      )}
    </div>
  );
}
