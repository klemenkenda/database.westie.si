"use client";

import { useMemo } from "react";
import { oneOf, text, useUrlState, type Spec } from "@/lib/urlstate";

export type Row = {
  key: string;
  title: string;
  url?: string;
  thumbnail_url?: string;
  creatorNames: string[];
  published?: string;
  duration_s?: number;
  view_count?: number;
  format?: string;
  status?: string;
  rejected_reason?: string;
  has_transcript?: boolean;
  transcript_words?: number;
  speech_wpm?: number;
  untagged: boolean;
  demoted: boolean;
  channel?: string;
  authority: { score: number; basis: string; provisional: boolean };
};

function duration(seconds?: number): string {
  if (!seconds) return "";
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  return h > 0
    ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`
    : `${m}:${String(s).padStart(2, "0")}`;
}

function views(count?: number): string {
  if (!count) return "";
  if (count >= 1000000) return `${(count / 1000000).toFixed(1)}M views`;
  if (count >= 1000) return `${Math.round(count / 1000)}k views`;
  return `${count} views`;
}

const FILTERS = ["all", "teaching", "rejected", "unattributed"] as const;
type Filter = (typeof FILTERS)[number];

/** Same contract as the studio: the filter and the search box are where you are, so they
 *  belong in the URL. A filtered list is the thing worth sending someone, and Back should
 *  take a tab click back rather than leaving the site. */
type Where = { filter: Filter; query: string };

const SPEC: Spec<Where> = {
  filter: oneOf("show", FILTERS, "all"),
  query: text("q"),
};

export default function VideoList({ rows }: { rows: Row[] }) {
  const [{ filter, query }, go] = useUrlState<Where>(SPEC, { filter: "all", query: "" });

  const counts = useMemo(() => ({
    all: rows.length,
    teaching: rows.filter((r) => r.status !== "rejected").length,
    rejected: rows.filter((r) => r.status === "rejected").length,
    unattributed: rows.filter((r) => r.creatorNames.length === 0).length,
  }), [rows]);

  const shown = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return rows.filter((r) => {
      if (filter === "teaching" && r.status === "rejected") return false;
      if (filter === "rejected" && r.status !== "rejected") return false;
      if (filter === "unattributed" && r.creatorNames.length > 0) return false;
      if (!needle) return true;
      return (
        r.title.toLowerCase().includes(needle) ||
        r.creatorNames.some((n) => n.toLowerCase().includes(needle))
      );
    });
  }, [rows, filter, query]);

  const tabs: Array<[Filter, string]> = [
    ["all", `All ${counts.all}`],
    ["teaching", `Teaching ${counts.teaching}`],
    ["rejected", `Dancing ${counts.rejected}`],
    ["unattributed", `Unattributed ${counts.unattributed}`],
  ];

  return (
    <>
      <div className="controls">
        <div className="tabs">
          {tabs.map(([value, label]) => (
            <button
              key={value}
              className={filter === value ? "tab on" : "tab"}
              onClick={() => go({ filter: value }, "push")}
            >
              {label}
            </button>
          ))}
        </div>
        <input
          className="search"
          type="search"
          placeholder="Filter by title or teacher…"
          value={query}
          onChange={(e) => go({ query: e.target.value }, "replace")}
        />
      </div>

      <p className="count">
        {shown.length === rows.length
          ? `${shown.length} videos`
          : `${shown.length} of ${rows.length} videos`}
      </p>

      <div className="list">
        {shown.map((r) => (
          <article
            key={r.key}
            className={
              "row" +
              (r.demoted ? " demoted" : "") +
              (r.status === "rejected" ? " rejected" : "")
            }
          >
            <a href={r.url} target="_blank" rel="noopener noreferrer">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img className="thumb" src={r.thumbnail_url} alt="" loading="lazy" />
            </a>

            <div>
              <h2>
                <a href={r.url} target="_blank" rel="noopener noreferrer">{r.title}</a>
              </h2>
              <p className="meta">
                {r.creatorNames.length > 0
                  ? r.creatorNames.join(" & ")
                  : <em>creator not identified</em>}
                {r.published ? ` · ${r.published}` : ""}
                {r.duration_s ? ` · ${duration(r.duration_s)}` : ""}
                {r.view_count ? ` · ${views(r.view_count)}` : ""}
              </p>
              <div className="chips">
                {r.status === "rejected" && (
                  <span className="chip bad">filtered: {r.rejected_reason}</span>
                )}
                {r.format && r.format !== "unknown" && <span className="chip">{r.format}</span>}
                {r.has_transcript
                  ? <span className="chip">{r.transcript_words} words</span>
                  : <span className="chip warn">no transcript</span>}
                {typeof r.speech_wpm === "number" && r.speech_wpm > 0 && (
                  <span className="chip">{Math.round(r.speech_wpm)} wpm</span>
                )}
                {r.demoted && <span className="chip warn">demoted — sorts last</span>}
                {r.untagged && <span className="chip">untagged</span>}
              </div>
              <p className="why">
                {r.authority.basis}
                {r.authority.provisional ? " · provisional, not low" : ""}
              </p>
            </div>

            <div className="score">
              <b>{r.authority.score.toFixed(0)}</b>
              <span>authority</span>
            </div>
          </article>
        ))}
      </div>

      {shown.length === 0 && <p className="lede">Nothing matches that.</p>}
    </>
  );
}
