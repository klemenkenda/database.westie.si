import { getVideos, getCreators, getRanking, authorityOf, type Video, type Creator } from "@/lib/content";

function duration(seconds?: number): string {
  if (!seconds) return "";
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

function views(count?: number): string {
  if (!count) return "";
  if (count >= 1000000) return `${(count / 1000000).toFixed(1)}M views`;
  if (count >= 1000) return `${Math.round(count / 1000)}k views`;
  return `${count} views`;
}

export default function Home() {
  const ranking = getRanking();
  const creators = getCreators();
  const videos = getVideos();

  const scored = videos.map((video) => {
    const people = video.creators
      .map((key) => creators.get(key))
      .filter((c): c is Creator => Boolean(c));
    const authority = authorityOf(people, ranking);
    const demoted = video.demoted || people.some((p) => p.demote);
    return { video, people, authority, demoted };
  });

  // Tier first, always: a demoted source sorts after everything else whatever it scores.
  // Within a tier, authority decides. This is the same rule as lib/Rank.php.
  scored.sort((a, b) => {
    if (a.demoted !== b.demoted) return a.demoted ? 1 : -1;
    if (b.authority.score !== a.authority.score) return b.authority.score - a.authority.score;
    return (b.video.view_count ?? 0) - (a.video.view_count ?? 0);
  });

  const attributed = scored.filter((s) => s.people.length > 0).length;
  const withTranscript = videos.filter((v) => v.has_transcript).length;

  return (
    <>
      <h1>Videos</h1>
      <p className="lede">
        Ordered by the WSDC standing of whoever teaches them. Nothing is tagged yet — the
        concept graph comes next, and until then every video is unclassified.
      </p>

      <div className="stats">
        <div className="stat"><b>{videos.length}</b><span>videos</span></div>
        <div className="stat"><b>{attributed}</b><span>attributed to a creator</span></div>
        <div className="stat"><b>{withTranscript}</b><span>with a transcript</span></div>
        <div className="stat"><b>{creators.size}</b><span>creators known</span></div>
      </div>

      <div className="list">
        {scored.map(({ video, people, authority, demoted }) => (
          <article key={video.key} className={demoted ? "row demoted" : "row"}>
            <a href={video.url} target="_blank" rel="noopener noreferrer">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img className="thumb" src={video.thumbnail_url} alt="" loading="lazy" />
            </a>

            <div>
              <h2>
                <a href={video.url} target="_blank" rel="noopener noreferrer">
                  {video.title}
                </a>
              </h2>
              <p className="meta">
                {people.length > 0
                  ? people.map((p) => p.name).join(" & ")
                  : <em>creator not identified</em>}
                {video.published ? ` · ${video.published}` : ""}
                {video.duration_s ? ` · ${duration(video.duration_s)}` : ""}
                {video.view_count ? ` · ${views(video.view_count)}` : ""}
              </p>
              <div className="chips">
                {video.format && video.format !== "unknown" && (
                  <span className="chip">{video.format}</span>
                )}
                {video.has_transcript ? (
                  <span className="chip">transcript · {video.transcript_words} words</span>
                ) : (
                  <span className="chip warn">no transcript</span>
                )}
                {video.status === "review" && <span className="chip warn">in review</span>}
                {demoted && <span className="chip warn">demoted — sorts last</span>}
                {video.concepts.length === 0 && <span className="chip">untagged</span>}
              </div>
              <p className="why">
                {authority.basis}
                {authority.provisional ? " · authority provisional, not low" : ""}
              </p>
            </div>

            <div className="score">
              <b>{authority.score.toFixed(0)}</b>
              <span>authority</span>
            </div>
          </article>
        ))}
      </div>
    </>
  );
}
