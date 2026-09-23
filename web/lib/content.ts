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
  speech_wpm?: number;
  rejected_reason?: string;
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
  aliases: string[];
  /** Sibling links the graph does not walk. Carried so the studio can edit them. */
  related: string[];
  requires: Edge[];
  trust?: string;
  status?: string;
  foundation_tier?: string;
  level_trust?: string;
  origin?: string;
  verified_by?: string;
  verified_at?: string;
  added?: string;
  updated?: string;
};

/** The validation written by tools/foundation.py, plus the tier structure of the spec. */
export type FoundationTier = {
  id: string;
  title: string;
  depends: string[];
  note: string;
};

export type FoundationAudit = {
  generated?: string;
  concepts: number;
  edges: number;
  density: number;
  foundation_density: number;
  trust: Record<string, number>;
  coverage?: { in_foundation: number; of: number; by_tier: Record<string, number> };
  cycles: unknown[];
  dangling: { concept: string; requires: string }[];
  inversions: { concept: string; level: number; requires: string; requires_level: number }[];
  orphans: string[];
  tier_violations: { concept: string; tier: string; requires: string; requires_tier: string }[];
  unrooted: { concept: string; bottoms_out_at: string[] }[];
  roots: string[];
  failures: string[];
  ok: boolean;
};

export type Foundation = {
  version?: number;
  author?: string;
  origin?: string;
  roots: string[];
  tiers: FoundationTier[];
  audit: FoundationAudit | null;
  /** True when foundation.yml has been edited since the audit was last written. */
  stale: boolean;
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

/**
 * A missing content/ is a broken build, not an empty database.
 *
 * This used to `return []` for a missing directory, and the consequence showed up the
 * first time the site was built inside Docker: the compose service did not mount
 * `content/`, every collection read as empty, the build reported success, and the
 * published site rendered every page with a count of zero. Nothing anywhere said why.
 *
 * An absent collection directory is indistinguishable from a database with no records in
 * it, so the only safe reading is that the *root* must exist — if it does not, the build is
 * misconfigured and should stop. An empty collection inside a real content root is still
 * fine: that is a project that has not ingested videos yet.
 */
function contentRoot(): string {
  if (!fs.existsSync(CONTENT)) {
    throw new Error(
      `content/ not found at ${CONTENT} (cwd ${process.cwd()}). The build reads the ` +
        `database off disk, so this would otherwise produce a site with zero records in ` +
        `it and still report success. In Docker, mount it: \`- ./content:/content:ro\`.`,
    );
  }
  return CONTENT;
}

function readCollection(name: string): Array<{ key: string; front: Record<string, any>; body: string }> {
  const dir = path.join(contentRoot(), name);
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

/**
 * Normalise a `requires:` list into structured edges.
 *
 * The upstream graph writes some edges as a bare id (`requires: ["anchor-step"]`), and the
 * previous version of this file filtered those out with `typeof e === "object"` — so a
 * hand-written bare edge silently vanished from every page, which is a worse failure than
 * rendering it wrong. A bare id becomes an `imported` edge at confidence 0.5, matching
 * Trust::edge() in the PHP and the same function in tools/foundation.py: a bare id cannot
 * claim to be verified, but it does not get to disappear either.
 */
const asEdges = (value: unknown): Edge[] =>
  asArray(value)
    .map((raw): Edge | null => {
      if (typeof raw === "string" && raw) {
        return { id: raw, trust: "imported", confidence: 0.5, strength: "required" };
      }
      if (raw && typeof raw === "object" && typeof raw.id === "string") {
        return {
          id: raw.id,
          trust: raw.trust ?? "imported",
          confidence: typeof raw.confidence === "number" ? raw.confidence : 0.5,
          strength: raw.strength ?? "required",
          origin: raw.origin,
        };
      }
      return null;
    })
    .filter((e): e is Edge => e !== null);

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
    speech_wpm: front.speech_wpm ?? 0,
    rejected_reason: front.rejected_reason,
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
    // `?? undefined` and not `|| undefined`: level 0 is a real level since the foundation
    // pass added a floor below beginner, and the falsy test would erase every one of the
    // 17 concepts that sit on it.
    level: front.level ?? undefined,
    category: front.category ?? undefined,
    tags: asStrings(front.tags),
    aliases: asStrings(front.aliases),
    related: asStrings(front.related),
    requires: asEdges(front.requires),
    trust: front.trust,
    status: front.status,
    foundation_tier: front.foundation_tier ?? undefined,
    level_trust: front.level_trust ?? undefined,
    origin: front.origin ?? undefined,
    verified_by: front.verified_by ?? undefined,
    verified_at: front.verified_at ?? undefined,
    added: front.added ?? undefined,
    updated: front.updated ?? undefined,
  }));
}

/**
 * Read content/foundation.yml and the audit tools/foundation.py writes beside it.
 *
 * Only the tier headers and the expectations are parsed out of the YAML — the concept
 * entries themselves are not, because the applied result is already on disk in the concept
 * files and reading it from there is what makes the studio show reality rather than
 * intent. The audit JSON is read as-is; nothing is recomputed here.
 */
export function getFoundation(): Foundation {
  const specPath = path.join(contentRoot(), "foundation.yml");
  const auditPath = path.join(contentRoot(), ".audit", "foundation.json");

  let audit: FoundationAudit | null = null;
  if (fs.existsSync(auditPath)) {
    try {
      audit = JSON.parse(fs.readFileSync(auditPath, "utf8")) as FoundationAudit;
    } catch {
      audit = null;
    }
  }

  if (!fs.existsSync(specPath)) {
    return { roots: [], tiers: [], audit, stale: false };
  }
  // Normalise line endings before any regex touches this. Every `^`-anchored and
  // `\n`-anchored pattern below silently matched nothing on a CRLF file, so the page
  // rendered "37 concepts in the foundation" above five empty tiers — the worst kind of
  // failure, because the counts looked right. The Python tools write LF, but this file is
  // hand-edited on Windows and git may check it out either way, so the parser has to cope
  // rather than the file having to be lucky.
  const text = fs.readFileSync(specPath, "utf8").replace(/\r\n/g, "\n");

  // The spec being newer than its own audit means the YAML was edited without re-running
  // the tool, so every number the studio is about to show describes a graph that no longer
  // exists. Worth a banner rather than silence.
  const stale = audit
    ? fs.statSync(specPath).mtimeMs > fs.statSync(auditPath).mtimeMs
    : true;

  const scalar = (field: string): string | undefined =>
    new RegExp(`^${field}:\\s*"?([^"\\n]*)"?\\s*$`, "m").exec(text)?.[1]?.trim();

  const inlineList = (raw: string | undefined): string[] =>
    (raw ?? "")
      .split(",")
      .map((s) => s.trim().replace(/^["']|["']$/g, ""))
      .filter(Boolean);

  const roots = inlineList(/^\s*roots:\s*\[([^\]]*)\]/m.exec(text)?.[1]);

  // Tier headers only: `  - id: "self"` through the next `- id:` at the same indent,
  // inside the `tiers:` block. Stops at the first top-level key so the `concepts:` list
  // below can never be mistaken for a tier.
  const tiers: FoundationTier[] = [];
  const tiersBlock = /^tiers:\n([\s\S]*?)^\S/m.exec(text)?.[1] ?? "";
  for (const chunk of tiersBlock.split(/^\s{2}- /m).slice(1)) {
    const id = /^id:\s*"([^"]+)"/m.exec(chunk)?.[1] ?? /id:\s*"([^"]+)"/.exec(chunk)?.[1];
    if (!id) continue;
    tiers.push({
      id,
      title: /title:\s*"([^"]+)"/.exec(chunk)?.[1] ?? id,
      depends: inlineList(/depends:\s*\[([^\]]*)\]/.exec(chunk)?.[1]),
      note: (/note:\s*>\n([\s\S]*?)(?=\n\s{4}\w+:|$)/.exec(chunk)?.[1] ?? "")
        .split("\n")
        .map((l) => l.trim())
        .join(" ")
        .trim(),
    });
  }

  return {
    version: Number(scalar("version")) || undefined,
    author: scalar("author"),
    origin: scalar("origin"),
    roots,
    tiers,
    audit,
    stale,
  };
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
