import { getVideos, getCreators, getRanking, authorityOf, type Creator } from "@/lib/content";
import VideoList, { type Row } from "./VideoList";

export default function Home() {
  const ranking = getRanking();
  const creators = getCreators();
  const videos = getVideos();

  const rows: Row[] = videos.map((video) => {
    const people = video.creators
      .map((key) => creators.get(key))
      .filter((c): c is Creator => Boolean(c));
    return {
      key: video.key,
      title: video.title,
      url: video.url,
      thumbnail_url: video.thumbnail_url,
      creatorNames: people.map((p) => p.name),
      published: video.published,
      duration_s: video.duration_s,
      view_count: video.view_count,
      format: video.format,
      status: video.status,
      rejected_reason: video.rejected_reason,
      has_transcript: video.has_transcript,
      transcript_words: video.transcript_words,
      speech_wpm: video.speech_wpm,
      untagged: video.concepts.length === 0,
      demoted: Boolean(video.demoted) || people.some((p) => p.demote),
      channel: video.channel,
      authority: authorityOf(people, ranking),
    };
  });

  // Three tiers, and the order between them is not negotiable by score: teaching first,
  // then demoted sources, then what the prune filtered out as dancing. Within a tier,
  // authority decides. Same rule as lib/Rank.php, plus the rejected bucket.
  rows.sort((a, b) => {
    const tier = (r: Row) => (r.status === "rejected" ? 2 : r.demoted ? 1 : 0);
    if (tier(a) !== tier(b)) return tier(a) - tier(b);
    if (b.authority.score !== a.authority.score) return b.authority.score - a.authority.score;
    return (b.view_count ?? 0) - (a.view_count ?? 0);
  });

  const teaching = rows.filter((r) => r.status !== "rejected").length;
  const attributed = rows.filter((r) => r.creatorNames.length > 0).length;
  const withTranscript = rows.filter((r) => r.has_transcript).length;

  return (
    <>
      <h1>Videos</h1>
      <p className="lede">
        Everything ingested, ordered by the WSDC standing of whoever teaches it. What the
        prune filtered out as dancing is kept visible at the bottom with its reason — a
        filter that throws things away should be auditable. Nothing is tagged yet.
      </p>

      <div className="stats">
        <div className="stat"><b>{rows.length}</b><span>videos</span></div>
        <div className="stat"><b>{teaching}</b><span>teaching material</span></div>
        <div className="stat"><b>{attributed}</b><span>attributed</span></div>
        <div className="stat"><b>{withTranscript}</b><span>with a transcript</span></div>
        <div className="stat"><b>{creators.size}</b><span>creators known</span></div>
      </div>

      <VideoList rows={rows} />
    </>
  );
}
