/**
 * The graph studio — build and validate the concept graph.
 *
 * Reads content/ at build time and hands the whole graph to a client component, which is
 * the right split for this page: it is a tool for one person working through a few hundred
 * concepts, so every traversal it needs is cheap in the browser and none of it needs the
 * API. Editing writes through the PHP API, which is the only thing here that cannot be a
 * static file.
 */
import {
  getConcepts,
  getFoundation,
  getVideos,
  type Concept,
} from "@/lib/content";
import GraphStudio from "./GraphStudio";

export const metadata = { title: "Graph studio — database.westie.si" };

export default function GraphPage() {
  const concepts = getConcepts();
  const foundation = getFoundation();
  const videos = getVideos();

  // Which concepts actually have material attached. The audit calls the complement
  // "uncovered" and treats it as the ingestion shopping list; the studio shows it per
  // concept so the gap is visible while you are looking at the concept, not only in a
  // summary count.
  const videoCount = new Map<string, number>();
  for (const video of videos) {
    for (const edge of video.concepts) {
      if (edge?.id) videoCount.set(edge.id, (videoCount.get(edge.id) ?? 0) + 1);
    }
  }

  const rows = concepts.map((c: Concept) => ({
    ...c,
    videos: videoCount.get(c.key) ?? 0,
  }));

  return <GraphStudio concepts={rows} foundation={foundation} />;
}
