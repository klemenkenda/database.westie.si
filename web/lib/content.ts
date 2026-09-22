/**
 * Reads content/ off disk at build time.
 *
 * This runs during `next build` only — never in the browser — so the exported site needs
 * no API call to render a page. The PHP API is for the things a static file cannot do:
 * search, and voting.
 *
 * The frontmatter parser here is deliberately small and matches lib/Yaml.php's subset:
 * quoted scalars, inline lists, and block lists of mappings. If a file needs more than
 * that, the file is wrong, not this.
 */
import fs from "node:fs";
import path from "node:path";

const CONTENT = path.join(process.cwd(), "..", "content");

export type Edge = {
  id: string;
  trust?: string;
  confidence?: number;
  strength?: string;
  origin?: string;
};

export type Video = {
  key: string;
  id: string;
  title: string;
  description?: string;
  youtube_id?: string;
  url?: string;
  thumbnail_url?: string;
  creators: string[];
  creator_source?: string;
  creator_confidence?: number;
  channel?: string;
  published?: string;
  duration_s?: number;
  view_count?: number;
  format?: string;
  level?: number | null;
  status?: string;
  demoted?: boolean;
  has_transcript?: boolean;
  transcript_words?: number;
  concepts: Edge[];
};

export type Creator = {
  key: string;
  name: string;
  wsdc_status?: string;
  wsdc_id?: number | null;
  wsdc?: Record<string, Record<string, number>>;
  demote?: boolean;
  partners?: string[];
  note?: string;
};

export type Concept = {
  key: string;
  title: string;
  level?: number;
  category?: string;
  tags: string[];
  requires: Edge[];
  trust?: string;
  status?: string;
};

// --------------------------------------------------------------------- parsing

function unquote(raw: string): string {
  const value = raw.trim();
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value
      .slice(1, -1)
      .replace(/\\"/g, '"')
      .replace(/\\\\/g, "\\");
  }
  return value;
}

function scalar(raw: string): unknown {
  const value = raw.trim();
  if (value === "" || value === "null" || value === "~") return null;
  if (value === "true") return true;
  if (value === "false") return false;
  if (value.startsWith("[")) {
    const inner = value.slice(1, -1).trim();
    if (!inner) return [];
    return inner.split(",").map((part) => scalar(part));
  }
  if (/^-?\d+$/.test(value)) return parseInt(value, 10);
  if (/^-?\d*\.\d+$/.test(value)) return parseFloat(value);
  return unquote(value);
}

/** Strip a trailing `# comment`, mirroring Yaml::stripComment. */
function stripComment(line: string): string {
  let quote = "";
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quote) {
      if (ch === "\\") i++;
      else if (ch === quote) quote = "";
      continue;
    }
    if (ch === '"' || ch === "'") quote = ch;
    else if (ch === "#" && (i === 0 || line[i - 1] === " ")) return line.slice(0, i).trimEnd();
  }
  return line;
}

export function parseFrontmatter(raw: string): { front: Record<string, any>; body: string } {
  const text = raw.replace(/^﻿/, "").replace(/\r\n/g, "\n");
  if (!text.startsWith("---\n")) return { front: {}, body: text };
  const end = text.indexOf("\n---", 3);
  if (end === -1) return { front: {}, body: text };

  const front: Record<string, any> = {};
  const lines = text.slice(4, end).split("\n");
  let currentKey: string | null = null;
  let currentList: any[] | null = null;
  let currentMap: Record<string, any> | null = null;

  const flush = () => {
    if (currentKey && currentList) {
      if (currentMap) currentList.push(currentMap);
      front[currentKey] = currentList;
    }
    currentList = null;
    currentMap = null;
  };

  for (const rawLine of lines) {
    const line = stripComment(rawLine);
    if (!line.trim()) continue;
    const indent = line.length - line.trimStart().length;
    const trimmed = line.trim();

    if (indent === 0) {
      flush();
      const colon = trimmed.indexOf(":");
      if (colon === -1) continue;
      const key = trimmed.slice(0, colon).trim();
      const rest = trimmed.slice(colon + 1).trim();
      if (rest === "") {
        currentKey = key;
        currentList = [];
        currentMap = null;
        front[key] = [];
      } else {
        currentKey = null;
        front[key] = scalar(rest);
      }
      continue;
    }

    if (!currentKey || !currentList) continue;
    if (trimmed.startsWith("- ")) {
      if (currentMap) currentList.push(currentMap);
      currentMap = {};
      const item = trimmed.slice(2).trim();
      const colon = item.indexOf(":");
      if (colon === -1) {
        currentList.push(scalar(item));
        currentMap = null;
      } else {
        currentMap[item.slice(0, colon).trim()] = scalar(item.slice(colon + 1));
      }
    } else if (currentMap) {
      const colon = trimmed.indexOf(":");
      if (colon !== -1) currentMap[trimmed.slice(0, colon).trim()] = scalar(trimmed.slice(colon + 1));
    }
  }
  flush();
  return { front, body: text.slice(end + 4).replace(/^\n+/, "") };
}

// --------------------------------------------------------------------- loading

function readCollection(name: string): Array<{ key: string; front: Record<string, any>; body: string }> {
  const dir = path.join(CONTENT, name);
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".md"))
    .map((f) => {
      const { front, body } = parseFrontmatter(fs.readFileSync(path.join(dir, f), "utf8"));
      return { key: f.slice(0, -3), front, body };
    });
}

const asArray = (value: unknown): any[] => (Array.isArray(value) ? value : []);
const asStrings = (value: unknown): string[] => asArray(value).filter((v) => typeof v === "string");

export function getVideos(): Video[] {
  return readCollection("videos").map(({ key, front }) => ({
    key,
    id: front.id ?? key,
    title: front.title ?? key,
    description: front.description ?? "",
    youtube_id: front.youtube_id,
    url: front.url,
    thumbnail_url: front.thumbnail_url,
    creators: asStrings(front.creators),
    creator_source: front.creator_source,
    creator_confidence: front.creator_confidence ?? 0,
    channel: front.channel,
    published: front.published ?? undefined,
    duration_s: front.duration_s ?? undefined,
    view_count: front.view_count ?? undefined,
    format: front.format ?? "unknown",
    level: front.level ?? null,
    status: front.status ?? "review",
    demoted: Boolean(front.demoted),
    has_transcript: Boolean(front.has_transcript),
    transcript_words: front.transcript_words ?? 0,
    concepts: asArray(front.concepts).filter((c) => c && typeof c === "object"),
  }));
}

export function getCreators(): Map<string, Creator> {
  const out = new Map<string, Creator>();
  for (const { key, front } of readCollection("creators")) {
    out.set(key, {
      key,
      name: front.name ?? key,
      wsdc_status: front.wsdc_status ?? "unconfirmed",
      wsdc_id: front.wsdc_id ?? null,
      wsdc: front.wsdc ?? {},
      demote: Boolean(front.demote),
      partners: asStrings(front.partners),
      note: front.note,
    });
  }
  return out;
}

export function getConcepts(): Concept[] {
  return readCollection("concepts").map(({ key, front }) => ({
    key,
    title: front.title ?? key,
    level: front.level ?? undefined,
    category: front.category ?? undefined,
    tags: asStrings(front.tags),
    requires: asArray(front.requires).filter((e) => e && typeof e === "object"),
    trust: front.trust,
    status: front.status,
  }));
}

export function getRanking(): Record<string, any> {
  const file = path.join(CONTENT, "ranking.yml");
  if (!fs.existsSync(file)) return {};
  // ranking.yml is nested two levels; the flat parser above is not enough, and the page
  // only needs the division bands, so read those directly.
  const text = fs.readFileSync(file, "utf8");
  const bands: Record<string, { base: number; span: number; per_point: number }> = {};
  const section = text.split(/^authority:/m)[1] ?? "";
  const re = /^\s{4}([A-Z]{3}):\s*$/gm;
  let match: RegExpExecArray | null;
  while ((match = re.exec(section))) {
    const after = section.slice(match.index, match.index + 200);
    const num = (field: string) => {
      const m = new RegExp(`${field}:\\s*(\\d+)`).exec(after);
      return m ? parseInt(m[1], 10) : 0;
    };
    bands[match[1]] = { base: num("base"), span: num("span"), per_point: num("per_point") };
  }
  const single = (field: string) => {
    const m = new RegExp(`^\\s{2}${field}:\\s*(\\d+)`, "m").exec(section);
    return m ? parseInt(m[1], 10) : 0;
  };
  return {
    divisions: bands,
    unconfirmed: single("unconfirmed") || 45,
    unregistered: single("unregistered") || 8,
    registered_no_points: single("registered_no_points") || 12,
  };
}

// ------------------------------------------------------------------- authority

const DIVISIONS = ["CHA", "ALS", "ADV", "INT", "NOV", "NEW"];

/** Mirrors Wsdc::score. Kept in step by tools/api_test.php comparing the two. */
export function authorityOf(
  creators: Creator[],
  ranking: Record<string, any>
): { score: number; basis: string; provisional: boolean } {
  if (creators.length === 0) {
    return { score: ranking.unconfirmed ?? 45, basis: "no creator resolved yet", provisional: true };
  }
  let best = { score: -1, basis: "", provisional: false };
  for (const creator of creators) {
    const scored = scoreOne(creator, ranking);
    if (scored.score > best.score) best = scored;
  }
  return best;
}

function scoreOne(creator: Creator, ranking: Record<string, any>) {
  const status = creator.wsdc_status ?? "unconfirmed";
  if (status === "unconfirmed" || status === "ambiguous") {
    return {
      score: ranking.unconfirmed ?? 45,
      basis: status === "ambiguous" ? "WSDC identity ambiguous" : "WSDC id not confirmed yet",
      provisional: true,
    };
  }
  if (status === "none") {
    return { score: ranking.unregistered ?? 8, basis: "no WSDC record", provisional: false };
  }
  const byDivision: Record<string, number> = {};
  for (const role of ["leader", "follower"]) {
    const row = creator.wsdc?.[role] ?? {};
    for (const division of DIVISIONS) {
      byDivision[division] = Math.max(byDivision[division] ?? 0, Number(row?.[division] ?? 0));
    }
  }
  const division = DIVISIONS.find((d) => (byDivision[d] ?? 0) > 0);
  if (!division) {
    return {
      score: ranking.registered_no_points ?? 12,
      basis: "WSDC record with no points",
      provisional: false,
    };
  }
  const points = byDivision[division];
  const band = ranking.divisions?.[division];
  if (!band) return { score: 12, basis: `unknown division ${division}`, provisional: false };
  const score = Math.min(100, band.base + Math.min(band.span, points / Math.max(1, band.per_point)));
  return {
    score: Math.round(score * 10) / 10,
    basis: `${division} division, ${points} pts`,
    provisional: false,
  };
}
