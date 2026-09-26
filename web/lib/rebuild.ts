/**
 * The shape of the graph being rebuilt from scratch.
 *
 * Its own module, apart from lib/content.ts, because both halves need it: the build reads
 * these records off disk, and the builder parses the same records out of API responses in
 * the browser — where content.ts, which imports `fs`, cannot go.
 */

/**
 * An edge in the rebuilt graph. No trust ladder: every edge here was drawn by a person,
 * so the only things worth recording are how strong the claim is and when it was made.
 */
export type GraphEdge = { id: string; strength: string; origin?: string };

/** A node in the graph being rebuilt, under content/graph/nodes/. */
export type GraphNode = {
  key: string;
  title: string;
  level?: number;
  /** The old concepts this node replaces. Empty for a node with no ancestor. */
  from: string[];
  requires: GraphEdge[];
  added?: string;
  updated?: string;
};

/** An old concept deliberately not carried into the new graph, under content/graph/skipped/. */
export type Skip = { key: string; title?: string; reason?: string; skipped_at?: string };

const asArray = (value: unknown): any[] => (Array.isArray(value) ? value : []);

export function toGraphEdges(value: unknown): GraphEdge[] {
  return asArray(value)
    .map((raw): GraphEdge | null =>
      typeof raw === "string" && raw
        ? { id: raw, strength: "required" }
        : raw && typeof raw === "object" && typeof raw.id === "string"
          ? { id: raw.id, strength: raw.strength ?? "required", origin: raw.origin ?? undefined }
          : null,
    )
    .filter((e): e is GraphEdge => e !== null);
}

export function toGraphNode(key: string, front: Record<string, any>): GraphNode {
  return {
    key,
    title: front.title ?? key,
    level: typeof front.level === "number" ? front.level : undefined,
    from: asArray(front.from).filter((v): v is string => typeof v === "string"),
    requires: toGraphEdges(front.requires),
    added: front.added ?? undefined,
    updated: front.updated ?? undefined,
  };
}
