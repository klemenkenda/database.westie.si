/**
 * Fuzzy name matching for the builder's "is this already here?" check.
 *
 * Runs on every keystroke over a few hundred names, so it stays plain and in-memory. Each
 * word typed is matched to its best word in the candidate — exact, prefix, substring, or
 * near-spelling by trigrams — and the scores are averaged, so "suger tuk" still finds
 * `sugar-tuck`, and a half-typed "anch" already finds `anchor-step`.
 */

const tokens = (s: string) =>
  s.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 1 && w !== "the");

function trigrams(w: string): Set<string> {
  const p = ` ${w} `;
  const out = new Set<string>();
  for (let i = 0; i + 3 <= p.length; i++) out.add(p.slice(i, i + 3));
  return out;
}

/** Dice coefficient over trigrams: 1 for the same word, ~0.5 for one typo in a short one. */
function dice(a: string, b: string): number {
  const ta = trigrams(a), tb = trigrams(b);
  let both = 0;
  for (const t of ta) if (tb.has(t)) both += 1;
  return (2 * both) / (ta.size + tb.size);
}

/** True when one insertion, deletion or substitution turns `a` into `b`. */
function oneEdit(a: string, b: string): boolean {
  if (Math.abs(a.length - b.length) > 1) return false;
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  const rest = (x: string, n: number) => x.slice(i + n);
  return rest(a, 1) === rest(b, 1) || rest(a, 1) === rest(b, 0) || rest(a, 0) === rest(b, 1);
}

function wordScore(q: string, c: string): number {
  if (q === c) return 1;
  if (c.startsWith(q) || q.startsWith(c)) return 0.85;
  // Trigrams are too coarse for a short word: "tuk" shares one with "tuck".
  if (q.length > 2 && oneEdit(q, c)) return 0.75;
  if (q.length > 2 && c.includes(q)) return 0.6;
  const d = dice(q, c);
  return d >= 0.4 ? d * 0.8 : 0;
}

/** 0..1 — how well `query` names the same thing as any of `names`. */
export function similarity(query: string, names: string[]): number {
  const q = tokens(query);
  if (!q.length) return 0;
  const phrase = q.join(" ");
  let best = 0;
  for (const name of names) {
    const c = tokens(name);
    if (!c.length) continue;
    const mean = q.reduce((sum, w) => sum + Math.max(0, ...c.map((x) => wordScore(w, x))), 0) / q.length;
    // How much of the candidate the query accounts for, so "anch" ranks `Anchor step`
    // above `Pattern structure — starter, middle, anchor` rather than tying with it.
    const covered = c.filter((x) => q.some((w) => wordScore(w, x) > 0)).length / c.length;
    // The whole phrase appearing as written beats the same words scattered.
    const bonus = c.join(" ").includes(phrase) ? 0.1 : 0;
    best = Math.max(best, (mean * (0.75 + 0.25 * covered) + bonus) / 1.1);
  }
  return best;
}

export const SIMILAR_FLOOR = 0.38;
