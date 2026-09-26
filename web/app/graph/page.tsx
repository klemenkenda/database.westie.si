/**
 * The graph builder — the concept graph, rebuilt from scratch with the old one beside it.
 *
 * Everything the builder needs is read off disk here so the page paints without the API:
 * the old concepts (the reference, read-only from this page), the new nodes, and the
 * old concepts already set aside. The client then refreshes all three from the API,
 * because every write it makes lands there.
 */
import { getConcepts, getGraphNodes, getSkips } from "@/lib/content";
import Builder, { type OldConcept } from "./Builder";

export const metadata = { title: "Graph builder — database.westie.si" };

export default function GraphBuilderPage() {
  const old: OldConcept[] = getConcepts().map((c) => ({
    key: c.key,
    title: c.title,
    level: c.level,
    aliases: c.aliases,
    foundation_tier: c.foundation_tier,
    requires: c.requires.map((e) => e.id),
  }));
  return <Builder old={old} nodes={getGraphNodes()} skips={getSkips()} />;
}
