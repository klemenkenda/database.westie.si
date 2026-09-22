/**
 * Group the concept vocabulary into families you can judge as a group.
 *
 * Reviewing 219 concepts alphabetically is the wrong unit of work: `basket-whip`,
 * `reverse-whip` and `whip-cut-off-entry` are one decision about what a whip rests on,
 * made once, and three files that should agree afterwards. Judged one at a time, days
 * apart, they end up with three different answers — which is exactly how the import got
 * a level-1 whip sitting next to a level-4 `acceleration`.
 *
 * Matching is by id token, in declared order, first match wins. Deliberately not by the
 * `category` field: that has `pattern` holding 76 concepts and `turns` holding 4, which
 * says more about how the upstream spreadsheet was filled in than about the dance. And
 * deliberately not by tag either — `pattern` and `patterns` are both in use as separate
 * tags, so tags cannot even group themselves.
 *
 * Order matters. `whip-cut-off-entry` contains both "whip" and "entry"; whips are declared
 * first because the whip is the thing being learned and the entry is a detail of it.
 */

export type Family = {
  id: string;
  title: string;
  /** Any of these tokens in the concept id puts it in this family. */
  tokens: string[];
  note: string;
};

export const FAMILIES: Family[] = [
  {
    id: "foundation",
    title: "Foundation",
    tokens: [],
    note: "The hand-authored root. Placed in a tier, verified edges, already reviewed.",
  },
  {
    id: "whips",
    title: "Whips",
    tokens: ["whip"],
    note: "The eight-count rotational family. The largest cluster in the database and the one where a single wrong prerequisite propagates furthest.",
  },
  {
    id: "passes",
    title: "Passes",
    tokens: ["pass", "send-out", "j-hook"],
    note: "Left side, right side, underarm, and everything built on a pass.",
  },
  {
    id: "sugar",
    title: "Sugar pushes & tucks",
    tokens: ["sugar", "tuck", "push"],
    note: "The compression family. `sugar-tuck` and `tuck turn` are the same figure under two names.",
  },
  {
    id: "turns",
    title: "Turns & spins",
    tokens: ["turn", "spin", "rotation", "swivel", "pivot"],
    note: "Turn technique and everything that rotates. `turns` as a category holds only 4 concepts, which is a filing artefact rather than a fact about the dance.",
  },
  {
    id: "dips",
    title: "Dips & ducks",
    tokens: ["dip", "duck", "drop", "lean"],
    note: "The family where a wrong level is a safety problem, not a pedagogy problem.",
  },
  {
    id: "positions",
    title: "Positions & holds",
    tokens: [
      "position", "closed", "open", "hammerlock", "shadow", "sweetheart", "cuddle",
      "track-base", "telemark",
    ],
    note: "Where the two of you are relative to each other. Named separately from connection because a position is a shape and connection is a force — the import conflated them.",
  },
  {
    id: "connection",
    title: "Connection & frame",
    tokens: [
      "connection", "frame", "stretch", "compression", "anchor", "elastic",
      "tension", "lead", "follow", "handhold", "contact", "resistance",
      "momentum", "intention", "projection", "posting", "distance", "catch",
    ],
    note: "What travels between two bodies. Mostly technique, and mostly under-declared.",
  },
  {
    id: "movement",
    title: "Movement quality",
    tokens: [
      "acceleration", "swing-movement", "segmented", "level-change", "pitch", "poise",
      "bounce", "variation", "wave", "stretch-out", "breathe", "recovery",
    ],
    note: "How a movement is shaped rather than which movement it is. The vaguest family and the one most likely to need splitting again once it has material attached.",
  },
  {
    id: "named",
    title: "Named moves",
    tokens: [
      "elvis", "donnie", "jordan", "superman", "showgirl", "rainbow", "slingshot",
      "frisbee", "apache", "basket", "crossbow", "pretzel",
    ],
    note: "Tricks with proper nouns for names. Worth grouping because they are the least likely to have honest prerequisites — a named move is taught as a party piece and filed by whoever named it.",
  },
  {
    id: "musicality",
    title: "Musicality & timing",
    tokens: [
      "music", "rhythm", "count", "beat", "phrase", "timing", "delay", "syncopat",
      "swung", "tempo", "blues", "hip-hop", "contemporary", "lyrical", "accent",
    ],
    note: "Hearing it and playing with it.",
  },
  {
    id: "footwork",
    title: "Footwork & body",
    tokens: [
      "step", "foot", "feet", "leg", "knee", "hip", "body", "weight", "posture",
      "balance", "kick", "ball-change", "triple", "walk", "roll",
    ],
    note: "What the body does on its own, below the level of any pattern.",
  },
  {
    id: "styling",
    title: "Styling & play",
    tokens: ["styl", "play", "arm", "hand", "head", "shoulder", "isolat", "shimmy", "freeze"],
    note: "The decoration layer. Almost always depends on something underneath it that the import does not name.",
  },
  {
    id: "social",
    title: "Social & floor",
    tokens: ["social", "etiquette", "floor", "ask", "declin", "partner", "adapt", "slot"],
    note: "Sharing a room with other people.",
  },
  {
    id: "routines",
    title: "Routines & combos",
    tokens: [
      "combo", "routine", "flashmob", "choreo", "structure", "event", "weekend",
      "storytelling", "call-and-response", "improvisation", "mirroring", "pattern-length",
    ],
    note: "Composite material. Often mislevelled because a routine is filed by its hardest move.",
  },
  {
    id: "other",
    title: "Unsorted",
    tokens: [],
    note: "Everything no rule claimed. A long tail here means the rules above need another token, not that the dance has an 'other' category.",
  },
];

/** Family id for one concept. Foundation membership wins over every token rule. */
export function familyOf(key: string, foundationTier?: string): string {
  if (foundationTier) return "foundation";
  for (const family of FAMILIES) {
    if (family.tokens.some((t) => key.includes(t))) return family.id;
  }
  return "other";
}
