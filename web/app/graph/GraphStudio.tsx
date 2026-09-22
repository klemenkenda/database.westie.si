"use client";

/**
 * The graph studio.
 *
 * Four views over one in-memory graph:
 *
 *   Tiers     the foundation as authored — the five tiers, what is in each, and whether
 *             every concept in it resolves down to a declared root.
 *   Problems  the audit as a work queue. Every finding is a link into the inspector
 *             rather than a line of text, because a finding you cannot act on from where
 *             you read it gets read and forgotten.
 *   Inspect   one concept: its prerequisite closure downwards, what it unlocks upwards,
 *             the trust on every edge, and an editor that proposes changes.
 *   Coverage  the shape of the whole graph — levels, categories, trust, and the concepts
 *             with no material attached.
 *
 * Everything is computed from the same `concepts` array the page read off disk. The
 * derivations here (closure, unlocks, depth, roots) deliberately mirror
 * tools/foundation.py rather than inventing a second set of rules, and the Problems view
 * shows the tool's own audit next to them so a disagreement is visible instead of quiet.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import type { Concept, Edge, Foundation } from "@/lib/content";

type Row = Concept & { videos: number };

type View = "tiers" | "problems" | "inspect" | "coverage";

const API =
  process.env.NEXT_PUBLIC_API_BASE ??
  (typeof window !== "undefined" ? `${window.location.origin}/api` : "/api");

const TRUST_ORDER = ["verified", "corroborated", "imported", "disputed"];

const LEVEL_NAMES: Record<string, string> = {
  "0": "foundation",
  "1": "beginner",
  "2": "improver",
  "3": "intermediate",
  "4": "advanced",
};

// --------------------------------------------------------------------------- graph maths

type Graph = {
  byKey: Map<string, Row>;
  /** concept -> the ids it requires, filtered to ids that exist. */
  out: Map<string, string[]>;
  /** concept -> the ids that require it. Computed, never stored: a stored backlink rots. */
  into: Map<string, string[]>;
  /** Ids named by a `requires` edge that have no concept file. */
  dangling: { concept: string; requires: string }[];
};

function buildGraph(concepts: Row[]): Graph {
  const byKey = new Map(concepts.map((c) => [c.key, c]));
  const out = new Map<string, string[]>();
  const into = new Map<string, string[]>();
  const dangling: { concept: string; requires: string }[] = [];

  for (const c of concepts) {
    const targets: string[] = [];
    // Edges arrive already normalised by lib/content.ts — a bare id in the Markdown has
    // become an `imported` edge by the time it gets here — so there is exactly one shape
    // to handle rather than two.
    for (const edge of c.requires) {
      const id = edge.id;
      if (!id) continue;
      if (byKey.has(id)) {
        targets.push(id);
        into.set(id, [...(into.get(id) ?? []), c.key]);
      } else {
        dangling.push({ concept: c.key, requires: id });
      }
    }
    out.set(c.key, targets);
  }
  for (const c of concepts) if (!into.has(c.key)) into.set(c.key, []);
  return { byKey, out, into, dangling };
}

/**
 * Everything `key` transitively rests on, with the depth at which it first appears.
 *
 * Depth is what makes this useful rather than just a set: a prerequisite three hops down
 * is a different kind of claim from a direct one, and a learning path renders them in
 * order. Cycle-safe by construction — a node already seen is never re-expanded — so a bad
 * graph gives a truncated answer instead of hanging the browser.
 */
function closure(g: Graph, key: string): Map<string, number> {
  const depth = new Map<string, number>();
  let frontier = [key];
  let d = 0;
  while (frontier.length && d < 24) {
    d += 1;
    const next: string[] = [];
    for (const node of frontier) {
      for (const target of g.out.get(node) ?? []) {
        if (!depth.has(target) && target !== key) {
          depth.set(target, d);
          next.push(target);
        }
      }
    }
    frontier = next;
  }
  return depth;
}

/** Everything that transitively depends on `key`. The "what this unlocks" direction. */
function unlocks(g: Graph, key: string): Map<string, number> {
  const depth = new Map<string, number>();
  let frontier = [key];
  let d = 0;
  while (frontier.length && d < 24) {
    d += 1;
    const next: string[] = [];
    for (const node of frontier) {
      for (const source of g.into.get(node) ?? []) {
        if (!depth.has(source) && source !== key) {
          depth.set(source, d);
          next.push(source);
        }
      }
    }
    frontier = next;
  }
  return depth;
}

/** Where a prerequisite walk from `key` bottoms out. */
function bottoms(g: Graph, key: string): string[] {
  const reached = closure(g, key);
  const ends = [...reached.keys()].filter((k) => (g.out.get(k) ?? []).length === 0);
  return ends.length ? ends.sort() : (g.out.get(key) ?? []).length === 0 ? [key] : [];
}

// ------------------------------------------------------------------------------- helpers

const edgeOf = (c: Row, id: string) => c.requires.find((e) => e.id === id) ?? null;

function trustClass(trust?: string): string {
  if (trust === "verified") return "trust ok";
  if (trust === "corroborated") return "trust mid";
  if (trust === "disputed") return "trust bad";
  return "trust low";
}

function count<T>(items: T[], key: (item: T) => string | undefined): Record<string, number> {
  const out: Record<string, number> = {};
  for (const item of items) {
    const k = key(item);
    if (k === undefined) continue;
    out[k] = (out[k] ?? 0) + 1;
  }
  return out;
}

// --------------------------------------------------------------------------- the component

export default function GraphStudio({
  concepts: initial,
  foundation,
}: {
  concepts: Row[];
  foundation: Foundation;
}) {
  const [view, setView] = useState<View>("tiers");
  const [selected, setSelected] = useState<string>(foundation.roots[0] ?? initial[0]?.key ?? "");
  const [query, setQuery] = useState("");
  const [saving, setSaving] = useState<string | null>(null);
  const [saved, setSaved] = useState<Record<string, string>>({});

  // The build-time snapshot is the starting point, not the source of truth.
  //
  // This page both reads and writes the graph, and the read half was baked in at
  // `next build` while the write half goes to the API — so before this, saving an edge
  // and then looking at the closure showed the graph as it was when the site was last
  // built. A validation tool that cannot see its own last edit is worse than useless: it
  // reports a problem you already fixed.
  //
  // So: render the static snapshot immediately (no spinner, works with the API down),
  // then refresh from the API on mount and after every write.
  const [concepts, setConcepts] = useState<Row[]>(initial);
  const [live, setLive] = useState<"static" | "live" | "offline">("static");

  const refresh = useCallback(async () => {
    try {
      const res = await fetch(`${API}/concepts?limit=500`);
      if (!res.ok) throw new Error(String(res.status));
      const body = await res.json();
      const results: any[] = Array.isArray(body?.results) ? body.results : [];
      if (!results.length) throw new Error("empty");

      // Video counts are not in this payload and do not change under our edits, so carry
      // them over from the build-time snapshot rather than dropping to zero and making
      // every concept look uncovered.
      const videosByKey = new Map(initial.map((c) => [c.key, c.videos]));
      setConcepts(
        results.map((r): Row => ({
          key: r._key ?? r.id,
          title: r.title ?? r._key,
          level: typeof r.level === "number" ? r.level : undefined,
          category: r.category ?? undefined,
          tags: Array.isArray(r.tags) ? r.tags : [],
          aliases: Array.isArray(r.aliases) ? r.aliases : [],
          requires: (Array.isArray(r.requires) ? r.requires : [])
            .map((e: any): Edge | null =>
              typeof e === "string"
                ? { id: e, trust: "imported", confidence: 0.5, strength: "required" }
                : e && typeof e.id === "string"
                  ? {
                      id: e.id,
                      trust: e.trust ?? "imported",
                      confidence: typeof e.confidence === "number" ? e.confidence : 0.5,
                      strength: e.strength ?? "required",
                      origin: e.origin,
                    }
                  : null,
            )
            .filter((e: Edge | null): e is Edge => e !== null),
          trust: r.trust ?? undefined,
          status: r.status ?? undefined,
          foundation_tier: r.foundation_tier ?? undefined,
          origin: r.origin ?? undefined,
          verified_by: r.verified_by ?? undefined,
          videos: videosByKey.get(r._key ?? r.id) ?? 0,
        })),
      );
      setLive("live");
    } catch {
      // Falling back to the snapshot is correct, but it must be visible: the numbers are
      // then as stale as the last build, and a tool that quietly shows stale data is how
      // you end up debugging a problem that no longer exists.
      setLive("offline");
    }
  }, [initial]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const g = useMemo(() => buildGraph(concepts), [concepts]);

  const open = useCallback((key: string) => {
    setSelected(key);
    setView("inspect");
  }, []);

  // ---- live findings, derived here rather than read from the audit file.
  //
  // The audit is the tool's answer and this is the page's; showing both is the point. If
  // they ever differ, one of the two implementations has drifted, and that is worth
  // knowing loudly rather than trusting whichever happened to render.
  const findings = useMemo(() => {
    const inversions: { concept: string; level: number; requires: string; requires_level: number }[] = [];
    const orphans: string[] = [];
    const unrooted: { concept: string; bottoms_out_at: string[] }[] = [];
    const roots = new Set(foundation.roots);

    for (const c of concepts) {
      const targets = g.out.get(c.key) ?? [];
      const dependents = g.into.get(c.key) ?? [];
      if (!targets.length && !dependents.length) orphans.push(c.key);

      if (typeof c.level === "number") {
        for (const t of targets) {
          const other = g.byKey.get(t);
          if (typeof other?.level === "number" && other.level > c.level) {
            inversions.push({
              concept: c.key,
              level: c.level,
              requires: t,
              requires_level: other.level,
            });
          }
        }
      }

      if (roots.size && !roots.has(c.key)) {
        const ends = bottoms(g, c.key);
        if (!ends.some((e) => roots.has(e))) {
          unrooted.push({ concept: c.key, bottoms_out_at: ends.slice(0, 4) });
        }
      }
    }

    const sparse = concepts
      .filter((c) => (c.level ?? 0) > 1 && (g.out.get(c.key) ?? []).length === 0)
      .map((c) => ({ concept: c.key, level: c.level ?? 0 }));

    const uncovered = concepts.filter((c) => c.videos === 0).map((c) => c.key);

    return { inversions, orphans, unrooted, sparse, uncovered, dangling: g.dangling };
  }, [concepts, g, foundation.roots]);

  const totals = useMemo(() => {
    const edges = concepts.reduce((n, c) => n + (g.out.get(c.key) ?? []).length, 0);
    const inFoundation = concepts.filter((c) => c.foundation_tier).length;
    const tierEdges = concepts
      .filter((c) => c.foundation_tier)
      .reduce((n, c) => n + (g.out.get(c.key) ?? []).length, 0);
    const trust: Record<string, number> = {};
    for (const c of concepts) {
      for (const edge of c.requires) {
        const t = edge.trust ?? "imported";
        trust[t] = (trust[t] ?? 0) + 1;
      }
    }
    return {
      concepts: concepts.length,
      edges,
      density: concepts.length ? edges / concepts.length : 0,
      foundationDensity: inFoundation ? tierEdges / inFoundation : 0,
      inFoundation,
      trust,
      roots: concepts.filter((c) => (g.out.get(c.key) ?? []).length === 0).map((c) => c.key),
    };
  }, [concepts, g]);

  const problemCount =
    findings.dangling.length +
    findings.inversions.length +
    findings.orphans.length +
    findings.unrooted.length +
    findings.sparse.length;

  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    return concepts
      .filter(
        (c) =>
          c.key.includes(q) ||
          c.title.toLowerCase().includes(q) ||
          c.aliases.some((a) => a.toLowerCase().includes(q)),
      )
      .slice(0, 12);
  }, [concepts, query]);

  // ---- writes go through the API, which is the only non-static thing on the page.
  const save = useCallback(
    async (key: string, patch: Record<string, unknown>) => {
      setSaving(key);
      try {
        const res = await fetch(`${API}/concepts/${key}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(patch),
        });
        const body = await res.json().catch(() => ({}));
        setSaved((s) => ({
          ...s,
          [key]: res.ok
            ? "saved — graph reloaded; re-run `python tools/foundation.py --check` to revalidate"
            : `failed: ${body?.error ?? res.status}`,
        }));
        // Pull the graph back so the closure, the problem counts and the trust split all
        // reflect the edit that was just made rather than the last build.
        if (res.ok) await refresh();
      } catch (err) {
        // The static export is often opened without the PHP container running, and a
        // silent no-op would look like a successful save. Say which half is missing.
        setSaved((s) => ({
          ...s,
          [key]: `no API at ${API} — start it with \`docker compose up -d api\``,
        }));
      } finally {
        setSaving(null);
      }
    },
    [refresh],
  );

  return (
    <>
      <h1>Graph studio</h1>
      <p className="lede">
        {totals.concepts} concepts, {totals.edges} prerequisite edges, density{" "}
        {totals.density.toFixed(2)} overall and {totals.foundationDensity.toFixed(2)} inside
        the hand-authored foundation. Derived from <code>content/concepts/</code> itself —
        the numbers describe the files, not a cached summary of them.{" "}
        {live === "live" ? (
          <span className="ok">Live from the API; edits appear immediately.</span>
        ) : live === "offline" ? (
          <span className="bad">
            No API — showing the build-time snapshot, so anything changed since the last{" "}
            <code>npm run build</code> is missing, and edits cannot be saved.
          </span>
        ) : (
          <span className="dim">Loading the current graph…</span>
        )}
      </p>

      {live === "offline" && (
        <div className="banner warn">
          <b>Read-only.</b> The studio could not reach the API at <code>{API}</code>. Start
          it with <code>docker compose up -d api</code> — the page stays usable for reading,
          but every number is as old as the last build.
        </div>
      )}

      {foundation.stale && (
        <div className="banner warn">
          <b>foundation.yml is newer than its audit.</b> The spec was edited without
          re-running the tool, so <code>content/.audit/foundation.json</code> describes a
          graph that no longer exists. Run{" "}
          <code>python tools/foundation.py --check</code>.
        </div>
      )}

      <div className="controls">
        <div className="tabs">
          {(
            [
              ["tiers", `Tiers · ${totals.inFoundation}`],
              ["problems", `Problems · ${problemCount}`],
              ["inspect", "Inspect"],
              ["coverage", "Coverage"],
            ] as [View, string][]
          ).map(([id, label]) => (
            <button
              key={id}
              className={`tab ${view === id ? "on" : ""}`}
              onClick={() => setView(id)}
            >
              {label}
            </button>
          ))}
        </div>
        <input
          className="search"
          placeholder="Find a concept or alias…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>

      {matches.length > 0 && (
        <div className="chips" style={{ marginBottom: 16 }}>
          {matches.map((m) => (
            <button key={m.key} className="chip link" onClick={() => open(m.key)}>
              {m.title}
              <span className="dim"> L{m.level ?? "?"}</span>
            </button>
          ))}
        </div>
      )}

      {view === "tiers" && (
        <TiersView g={g} foundation={foundation} totals={totals} onOpen={open} />
      )}
      {view === "problems" && (
        <ProblemsView findings={findings} audit={foundation.audit} onOpen={open} />
      )}
      {view === "inspect" && (
        <InspectView
          g={g}
          selected={selected}
          onOpen={open}
          onSave={save}
          saving={saving}
          message={saved[selected]}
        />
      )}
      {view === "coverage" && <CoverageView concepts={concepts} g={g} onOpen={open} />}
    </>
  );
}

// ------------------------------------------------------------------------------- tiers

function TiersView({
  g,
  foundation,
  totals,
  onOpen,
}: {
  g: Graph;
  foundation: Foundation;
  totals: { roots: string[] };
  onOpen: (key: string) => void;
}) {
  const roots = new Set(foundation.roots);
  const byTier = new Map<string, Row[]>();
  for (const c of g.byKey.values()) {
    if (!c.foundation_tier) continue;
    byTier.set(c.foundation_tier, [...(byTier.get(c.foundation_tier) ?? []), c]);
  }

  // A root the spec did not declare is the finding that matters most on this page: it is
  // an axiom nobody wrote down, and every concept resting on it is resting on nothing.
  const undeclared = totals.roots.filter((k) => !roots.has(k));

  return (
    <>
      <p className="note">
        The foundation is the only part of the graph carrying <code>trust: verified</code>.
        Tiers form a DAG, not a ladder — each declares which others it may draw on, and an
        edge crossing into an undeclared tier is a failure. Authored by{" "}
        <b>{foundation.author ?? "—"}</b>, origin <code>{foundation.origin ?? "—"}</code>.
      </p>

      <div className="banner">
        <b>Roots.</b> Nothing may rest on{" "}
        {foundation.roots.map((r, i) => (
          <span key={r}>
            {i > 0 && " and "}
            <button className="chip link" onClick={() => onOpen(r)}>
              {r}
            </button>
          </span>
        ))}
        . Every other concept's prerequisite walk must terminate at one of them.
        {undeclared.length > 0 ? (
          <>
            {" "}
            <span className="bad">
              {undeclared.length} undeclared root{undeclared.length === 1 ? "" : "s"}:
            </span>{" "}
            {undeclared.slice(0, 8).map((k) => (
              <button key={k} className="chip link bad" onClick={() => onOpen(k)}>
                {k}
              </button>
            ))}
          </>
        ) : (
          <> No undeclared roots.</>
        )}
      </div>

      <div className="tiergrid">
        {foundation.tiers.map((tier) => {
          const members = (byTier.get(tier.id) ?? []).sort(
            (a, b) => (a.level ?? 0) - (b.level ?? 0) || a.key.localeCompare(b.key),
          );
          return (
            <section key={tier.id} className="tier">
              <header>
                <h2>{tier.title}</h2>
                <span className="dim">
                  {members.length} concept{members.length === 1 ? "" : "s"}
                  {tier.depends.length > 0 && <> · draws on {tier.depends.join(", ")}</>}
                </span>
              </header>
              {tier.note && <p className="note">{tier.note}</p>}
              <ul className="conceptlist">
                {members.map((c) => (
                  <li key={c.key}>
                    <button className="linkish" onClick={() => onOpen(c.key)}>
                      {c.title}
                    </button>
                    <span className="dim">
                      L{c.level ?? "?"} · {(g.out.get(c.key) ?? []).length} req ·{" "}
                      {(g.into.get(c.key) ?? []).length} dep
                      {c.videos === 0 && <span className="bad"> · no video</span>}
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          );
        })}
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------- problems

function ProblemsView({
  findings,
  audit,
  onOpen,
}: {
  findings: {
    dangling: { concept: string; requires: string }[];
    inversions: { concept: string; level: number; requires: string; requires_level: number }[];
    orphans: string[];
    unrooted: { concept: string; bottoms_out_at: string[] }[];
    sparse: { concept: string; level: number }[];
    uncovered: string[];
  };
  audit: Foundation["audit"];
  onOpen: (key: string) => void;
}) {
  const groups: {
    id: string;
    title: string;
    why: string;
    breaking?: boolean;
    items: { key: string; detail: string }[];
  }[] = [
    {
      id: "dangling",
      title: "Dangling references",
      breaking: true,
      why: "A requires an id with no concept file. Breaks every path algorithm that walks through it, so this fails a build rather than joining a queue.",
      items: findings.dangling.map((d) => ({
        key: d.concept,
        detail: `requires ${d.requires}, which does not exist`,
      })),
    },
    {
      id: "inversions",
      title: "Level inversions",
      why: "A concept filed below its own prerequisite. Nearly always the component being mislevelled rather than the compound — fix the primitive, and expect the next layer down to surface.",
      items: findings.inversions.map((i) => ({
        key: i.concept,
        detail: `L${i.level} requires ${i.requires} at L${i.requires_level}`,
      })),
    },
    {
      id: "unrooted",
      title: "Unrooted",
      why: "The prerequisite walk bottoms out somewhere other than a declared root, so the concept rests on an axiom nobody wrote down.",
      items: findings.unrooted.map((u) => ({
        key: u.concept,
        detail: `bottoms out at ${u.bottoms_out_at.join(", ") || "nothing"}`,
      })),
    },
    {
      id: "orphans",
      title: "Orphans",
      why: "No edge in either direction. Unplaced in the graph, invisible to every traversal, and usually a genuine primitive with no tier to attach to.",
      items: findings.orphans.map((k) => ({ key: k, detail: "no edge in or out" })),
    },
    {
      id: "sparse",
      title: "Sparse",
      why: "Above level 1 and declaring no prerequisites at all. Sparsity is subtler than error: a path built on it looks complete while quietly skipping things.",
      items: findings.sparse.map((s) => ({ key: s.concept, detail: `L${s.level}, no prerequisites` })),
    },
    {
      id: "uncovered",
      title: "No video attached",
      why: "The ingestion shopping list, generated rather than guessed.",
      items: findings.uncovered.map((k) => ({ key: k, detail: "no material" })),
    },
  ];

  return (
    <>
      <p className="note">
        The audit as a work queue. Every finding links into the inspector, because a
        finding you cannot act on from where you read it gets read and forgotten. Only
        dangling references and cycles break a build — they make the path algorithms wrong
        rather than merely unreviewed. Everything else is a judgment call.
      </p>

      {audit && (
        <div className={`banner ${audit.ok ? "" : "warn"}`}>
          <b>tools/foundation.py</b> last ran {audit.generated ?? "at an unknown time"} and
          reported{" "}
          {audit.ok ? (
            <span className="ok">the foundation holds</span>
          ) : (
            <span className="bad">{audit.failures.join("; ")}</span>
          )}
          . The counts below are recomputed in the browser from the same files; if the two
          disagree, one implementation has drifted.
        </div>
      )}

      {groups.map((group) => (
        <section key={group.id} className="findings">
          <header>
            <h2>
              {group.title} <span className="dim">{group.items.length}</span>
            </h2>
            {group.breaking && <span className="chip bad">build-breaking</span>}
            {group.items.length === 0 && <span className="chip ok">clear</span>}
          </header>
          <p className="note">{group.why}</p>
          {group.items.length > 0 && (
            <ul className="findlist">
              {group.items.slice(0, 40).map((item, i) => (
                <li key={`${item.key}-${i}`}>
                  <button className="linkish" onClick={() => onOpen(item.key)}>
                    {item.key}
                  </button>
                  <span className="dim">{item.detail}</span>
                </li>
              ))}
              {group.items.length > 40 && (
                <li className="dim">…and {group.items.length - 40} more</li>
              )}
            </ul>
          )}
        </section>
      ))}
    </>
  );
}

// ----------------------------------------------------------------------------- inspect

function InspectView({
  g,
  selected,
  onOpen,
  onSave,
  saving,
  message,
}: {
  g: Graph;
  selected: string;
  onOpen: (key: string) => void;
  onSave: (key: string, patch: Record<string, unknown>) => void;
  saving: string | null;
  message?: string;
}) {
  const concept = g.byKey.get(selected);
  if (!concept) return <p className="note">No concept selected.</p>;

  const direct = g.out.get(selected) ?? [];
  const below = closure(g, selected);
  const above = unlocks(g, selected);
  const ends = bottoms(g, selected);

  const byDepth = new Map<number, string[]>();
  for (const [key, depth] of below) {
    byDepth.set(depth, [...(byDepth.get(depth) ?? []), key]);
  }

  return (
    <>
      <section className="inspect">
        <header>
          <h2>{concept.title}</h2>
          <div className="chips">
            <span className="chip">
              L{concept.level ?? "?"} {LEVEL_NAMES[String(concept.level)] ?? ""}
            </span>
            {concept.category && <span className="chip">{concept.category}</span>}
            {concept.foundation_tier && (
              <span className="chip ok">foundation · {concept.foundation_tier}</span>
            )}
            <span className={`chip ${concept.status === "draft" ? "warn" : ""}`}>
              {concept.status ?? "draft"}
            </span>
            {concept.videos === 0 && <span className="chip bad">no video</span>}
          </div>
        </header>

        <p className="note">
          <code>{concept.key}</code> · origin <code>{concept.origin ?? "—"}</code>
          {concept.verified_by && <> · verified by {concept.verified_by}</>}
          {concept.aliases.length > 0 && (
            <>
              {" "}
              · also called {concept.aliases.map((a) => `“${a}”`).join(", ")}
            </>
          )}
        </p>

        <div className="panels">
          <div className="panel">
            <h3>Requires directly · {direct.length}</h3>
            {direct.length === 0 ? (
              <p className="note">
                Nothing. This concept is a root — every walk that reaches it stops here, so
                it had better be something genuinely axiomatic.
              </p>
            ) : (
              <ul className="edgelist">
                {direct.map((id) => {
                  const edge = edgeOf(concept, id);
                  const other = g.byKey.get(id);
                  return (
                    <li key={id}>
                      <button className="linkish" onClick={() => onOpen(id)}>
                        {other?.title ?? id}
                      </button>
                      <span className={trustClass(edge?.trust)}>{edge?.trust ?? "imported"}</span>
                      <span className="dim">
                        L{other?.level ?? "?"} · {edge?.strength ?? "required"} ·{" "}
                        {typeof edge?.confidence === "number" ? edge.confidence.toFixed(2) : "—"}
                      </span>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>

          <div className="panel">
            <h3>Unlocks · {above.size}</h3>
            {above.size === 0 ? (
              <p className="note">Nothing depends on this yet.</p>
            ) : (
              <ul className="edgelist">
                {[...above.entries()]
                  .sort((a, b) => a[1] - b[1] || a[0].localeCompare(b[0]))
                  .slice(0, 24)
                  .map(([id, depth]) => (
                    <li key={id}>
                      <button className="linkish" onClick={() => onOpen(id)}>
                        {g.byKey.get(id)?.title ?? id}
                      </button>
                      <span className="dim">
                        {depth === 1 ? "directly" : `${depth} hops up`}
                      </span>
                    </li>
                  ))}
                {above.size > 24 && <li className="dim">…and {above.size - 24} more</li>}
              </ul>
            )}
          </div>
        </div>

        <div className="panel">
          <h3>Prerequisite closure · {below.size}</h3>
          <p className="note">
            Everything this transitively rests on, by depth. This is what a learning path
            would make you cover first, in this order, and it is the single best check on
            whether a concept is filed at the right level: 30 things below a level 1 is a
            levelling error, and two things below a level 4 is a missing-edge error.
          </p>
          {[...byDepth.entries()]
            .sort((a, b) => a[0] - b[0])
            .map(([depth, keys]) => (
              <div key={depth} className="depthrow">
                <span className="depth">−{depth}</span>
                <div className="chips">
                  {keys.sort().map((k) => (
                    <button key={k} className="chip link" onClick={() => onOpen(k)}>
                      {g.byKey.get(k)?.title ?? k}
                      <span className="dim"> L{g.byKey.get(k)?.level ?? "?"}</span>
                    </button>
                  ))}
                </div>
              </div>
            ))}
          <p className="note">
            Bottoms out at{" "}
            {ends.length ? (
              ends.map((e, i) => (
                <span key={e}>
                  {i > 0 && ", "}
                  <button className="chip link" onClick={() => onOpen(e)}>
                    {e}
                  </button>
                </span>
              ))
            ) : (
              <>nothing — this is a root</>
            )}
            .
          </p>
        </div>

        {/*
          Keyed on the concept so React remounts the editor when you navigate.
          Its `level` select seeds from props via useState, which only reads the initial
          value — without the key, clicking from a level 1 to a level 4 concept left the
          dropdown showing 1, and pressing "Set level" would then have silently relevelled
          the new concept to the old one's value. A stale form on a tool that writes to
          disk is a data-corruption bug, not a cosmetic one.
        */}
        <Editor
          key={concept.key}
          concept={concept}
          g={g}
          onSave={onSave}
          busy={saving === concept.key}
          message={message}
        />
      </section>
    </>
  );
}

// ------------------------------------------------------------------------------ editor

function Editor({
  concept,
  g,
  onSave,
  busy,
  message,
}: {
  concept: Row;
  g: Graph;
  onSave: (key: string, patch: Record<string, unknown>) => void;
  busy: boolean;
  message?: string;
}) {
  const [level, setLevel] = useState(String(concept.level ?? ""));
  const [addId, setAddId] = useState("");
  const [strength, setStrength] = useState("required");
  const [alias, setAlias] = useState("");

  const direct = g.out.get(concept.key) ?? [];

  // An edge added here is `verified`, because a person is adding it by hand and saying so
  // is the whole point of the trust ladder. The alternative — writing `imported` for a
  // human edit — would make the ladder meaningless in the one case it exists for.
  const addEdge = () => {
    const id = addId.trim();
    if (!id || !g.byKey.has(id)) return;
    const existing = concept.requires.filter((e) => e.id !== id);
    onSave(concept.key, {
      requires: [
        ...existing,
        {
          id,
          origin: `studio@${new Date().toISOString().slice(0, 10)}`,
          trust: "verified",
          confidence: 1.0,
          strength,
        },
      ],
      status: "review",
    });
    setAddId("");
  };

  const dropEdge = (id: string) => {
    onSave(concept.key, {
      requires: concept.requires.filter((e) => e.id !== id),
      status: "review",
    });
  };

  return (
    <div className="panel editor">
      <h3>Edit</h3>
      <p className="note">
        Writes go straight to <code>content/concepts/{concept.key}.md</code> through the PHP
        API, so the change is a file diff you can read and revert. An edge added by hand is
        recorded as <code>verified</code> with today's date — a human edit is exactly the
        evidence the trust ladder exists to record. Re-run{" "}
        <code>python tools/foundation.py --check</code> afterwards to revalidate.
      </p>

      <div className="editrow">
        <label>
          Level
          <select value={level} onChange={(e) => setLevel(e.target.value)}>
            <option value="">—</option>
            {["0", "1", "2", "3", "4"].map((l) => (
              <option key={l} value={l}>
                {l} · {LEVEL_NAMES[l]}
              </option>
            ))}
          </select>
        </label>
        <button
          className="tab"
          disabled={busy || level === String(concept.level ?? "")}
          onClick={() =>
            onSave(concept.key, {
              level: level === "" ? null : Number(level),
              level_trust: "verified",
              status: "review",
            })
          }
        >
          Set level
        </button>
      </div>

      <div className="editrow">
        <label>
          Add prerequisite
          <input
            list="concept-ids"
            value={addId}
            onChange={(e) => setAddId(e.target.value)}
            placeholder="concept id"
          />
        </label>
        <label>
          Strength
          <select value={strength} onChange={(e) => setStrength(e.target.value)}>
            <option value="required">required</option>
            <option value="usually-taught-before">usually-taught-before</option>
            <option value="related">related</option>
          </select>
        </label>
        <button className="tab" disabled={busy || !g.byKey.has(addId.trim())} onClick={addEdge}>
          Add edge
        </button>
      </div>

      {direct.length > 0 && (
        <div className="editrow wrap">
          <span className="dim">Remove:</span>
          {direct.map((id) => (
            <button key={id} className="chip link bad" disabled={busy} onClick={() => dropEdge(id)}>
              {id} ✕
            </button>
          ))}
        </div>
      )}

      <div className="editrow">
        <label>
          Add alias
          <input
            value={alias}
            onChange={(e) => setAlias(e.target.value)}
            placeholder="another name for this"
          />
        </label>
        <button
          className="tab"
          disabled={busy || !alias.trim()}
          onClick={() => {
            onSave(concept.key, {
              aliases: [...new Set([...concept.aliases, alias.trim()])].sort(),
            });
            setAlias("");
          }}
        >
          Add alias
        </button>
      </div>

      <datalist id="concept-ids">
        {[...g.byKey.keys()].sort().map((k) => (
          <option key={k} value={k} />
        ))}
      </datalist>

      {message && <p className={`note ${message.startsWith("saved") ? "ok" : "bad"}`}>{message}</p>}
    </div>
  );
}

// ---------------------------------------------------------------------------- coverage

function CoverageView({
  concepts,
  g,
  onOpen,
}: {
  concepts: Row[];
  g: Graph;
  onOpen: (key: string) => void;
}) {
  const levels = count(concepts, (c) => String(c.level ?? "?"));
  const categories = count(concepts, (c) => c.category);
  const trust: Record<string, number> = {};
  for (const c of concepts) {
    for (const edge of c.requires) {
      const t = edge.trust ?? "imported";
      trust[t] = (trust[t] ?? 0) + 1;
    }
  }

  // The concepts most worth attaching material to first: many things depend on them and
  // nothing covers them. A shopping list ordered by leverage rather than alphabetically.
  const leverage = concepts
    .filter((c) => c.videos === 0)
    .map((c) => ({ c, deps: unlocks(g, c.key).size }))
    .sort((a, b) => b.deps - a.deps)
    .slice(0, 20);

  const bar = (n: number, of: number) => ({ width: `${of ? (n / of) * 100 : 0}%` });
  const max = (obj: Record<string, number>) => Math.max(1, ...Object.values(obj));

  return (
    <>
      <p className="note">
        The shape of the vocabulary. The advanced tail is a real property of the imported
        set and not something a foundation pass fixes — but the trust split is, and it is
        the honest measure of how much of this graph anyone has actually checked.
      </p>

      <div className="tiergrid">
        <section className="tier">
          <header>
            <h2>Levels</h2>
            <span className="dim">0 foundation → 4 advanced</span>
          </header>
          {Object.keys(levels)
            .sort()
            .map((l) => (
              <div key={l} className="barrow">
                <span className="barlabel">
                  L{l} <span className="dim">{LEVEL_NAMES[l] ?? ""}</span>
                </span>
                <span className="bartrack">
                  <span className="barfill" style={bar(levels[l], max(levels))} />
                </span>
                <span className="barnum">{levels[l]}</span>
              </div>
            ))}
        </section>

        <section className="tier">
          <header>
            <h2>Edge trust</h2>
            <span className="dim">what has actually been checked</span>
          </header>
          {TRUST_ORDER.filter((t) => trust[t]).map((t) => (
            <div key={t} className="barrow">
              <span className="barlabel">{t}</span>
              <span className="bartrack">
                <span className={`barfill ${t}`} style={bar(trust[t], max(trust))} />
              </span>
              <span className="barnum">{trust[t]}</span>
            </div>
          ))}
          <p className="note">
            An <code>imported</code> edge is never rendered to a learner with the weight of
            a <code>verified</code> one. If we cannot say how sure we are, we do not make
            the claim.
          </p>
        </section>

        <section className="tier">
          <header>
            <h2>Categories</h2>
            <span className="dim">{Object.keys(categories).length} in use</span>
          </header>
          {Object.entries(categories)
            .sort((a, b) => b[1] - a[1])
            .map(([cat, n]) => (
              <div key={cat} className="barrow">
                <span className="barlabel">{cat}</span>
                <span className="bartrack">
                  <span className="barfill" style={bar(n, max(categories))} />
                </span>
                <span className="barnum">{n}</span>
              </div>
            ))}
        </section>

        <section className="tier">
          <header>
            <h2>Cover these first</h2>
            <span className="dim">uncovered, by how much depends on them</span>
          </header>
          <ul className="conceptlist">
            {leverage.map(({ c, deps }) => (
              <li key={c.key}>
                <button className="linkish" onClick={() => onOpen(c.key)}>
                  {c.title}
                </button>
                <span className="dim">
                  L{c.level ?? "?"} · {deps} concept{deps === 1 ? "" : "s"} depend on it
                </span>
              </li>
            ))}
          </ul>
        </section>
      </div>
    </>
  );
}
