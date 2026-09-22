# database.westie.si — build plan

A public, searchable database of West Coast Swing video material, with a concept knowledge
graph over it, a ranking driven by the WSDC standing of the teachers, and a guided mode
that turns the graph into a learning path.

Status: planning. Nothing built yet.

---

## 1. What already exists, and what we take from it

| Source | What it gives us |
|---|---|
| `Work/www/teaching.westie.si` | **208 concepts** with category, level 1–4, `requires` (a prerequisite DAG) and tags. Plus 82 drills, 110 classes, a facet taxonomy, and a proven PHP-on-Markdown stack (`public/api/lib/{Yaml,Store,Query,Graph,Export}.php`, 110 passing tests). **Treat as a draft, not as fact — see §5.** |
| `Work/dancing/WSDC` | `wsdcfetcher.py` + `wsdc_summary_records.json` — per-dancer points per division (`CHA`, `ALS`, `ADV`, `INT`, `NOV`, `NEW`), separately for leader and follower role, with first and best competition. **This is the ranking backbone.** |
| `Work/dancing/WCS` | A working YouTube ingestion setup (`tools/yt.py`, `tools/auth.py`) with OAuth already configured. |
| `Work/dancing/WCS-front` | Next.js 14 App Router with `output: "export"` + `trailingSlash: true`, building to `out/`. Proof that static-export Next works on the target host. |

We reuse the *pattern*, not the repo. `database.westie.si` is its own git repo with its own
`content/`. The PHP lib files get copied in and adapted, because the two sites deploy
separately and must not be able to break each other.

### The privacy line

`teaching.westie.si/content/videos/` holds 525 workshop recordings from events and
privates. That is personal archive material and not ours to republish. **None of it is
copied into this project.** What crosses over is only the *concept vocabulary* — names,
levels, categories, prerequisites — which is generic teaching knowledge belonging to
nobody.

---

## 2. Architecture

Traditional server: Apache + PHP, no Node process. So the API is PHP and the frontend is a
**statically exported** Next.js site.

```
database.westie.si/
  content/                     ← the database. Markdown + YAML frontmatter. Above doc root.
    videos/<id>.md
    creators/<slug>.md
    concepts/<slug>.md
    channels/<slug>.md         ← ingestion sources being tracked
    paths/<slug>.md            ← learning paths
    taxonomy.md
    ranking.yml                ← tunable weights (§6)
    .cache/index.json          ← frontmatter cache, keyed by mtime+size
    .index/search.sqlite       ← derived FTS5 index, rebuilt from content/
    .transcripts/<id>.json     ← gitignored, large
  public/                      ← the Apache document root
    api/                       ← PHP 8, no framework
      index.php
      lib/{Yaml,Store,Query,Graph,Rank,Wsdc,Votes,Search}.php
      config.local.php         ← write token, not committed
    _next/ videos/ concepts/   ← the exported Next.js site
  web/                         ← Next.js source, builds into public/
  tools/                       ← Python: ingest, transcribe, classify, wsdc, index
  data/votes.sqlite            ← writes land here, never in content/
```

**The filesystem is the source of truth.** Every record is one Markdown file, diffable and
committable. SQLite appears twice and both times as something disposable that rebuilds from
`content/`: the search index, and the vote event log.

### Frontend: Next.js with `output: "export"`

No Node on the server means no SSR, no ISR, no route handlers, no middleware, no
`next/image` optimisation — the same constraints `WCS-front` already lives under.

The split that keeps it both fast and dynamic:

- **Build time** — `generateStaticParams` reads `content/` straight off disk and
  pre-renders a real HTML page for every video, concept, creator and path. ~1500 static
  pages, instant, fully indexable. A plain page view makes no API call at all.
- **Runtime** — search, faceted browse, vote counts and vote submission go to the PHP API
  via `fetch`. Lists render their baseline WSDC ranking at build time, then re-order
  client-side once vote deltas arrive.

Content changes arrive in batch ingestion runs, so "rebuild to publish" is the right
cadence: `npm run build` → `out/` → rsync into `public/`.

### API surface

```
GET  /api/health
GET  /api/search?q=&level=&category=&concept=&creator=&platform=&sort=&limit=&offset=
GET  /api/videos            /api/videos/{id}
GET  /api/concepts          /api/concepts/{slug}    /api/concepts/{slug}/graph
GET  /api/creators          /api/creators/{slug}
GET  /api/paths/{slug}
GET  /api/votes?ids=a,b,c                ← batched, so a list page costs one request
POST /api/votes                          ← {target, kind, value}
POST /api/reports                        ← "wrong level", "not about X", "remove this"
GET|PUT|DELETE /api/{collection}/{key}   ← admin, X-Api-Token
GET  /api/queue/review                   ← admin: what the classifier is unsure about
```

Filters combine with AND, matching the convention `teaching.westie.si` already uses, so the
two APIs feel like one system.

---

## 3. Data model

### `content/videos/<id>.md`

IDs namespaced by platform: `yt-1BRAppCB3K0`, `ig-C1a2b3c4d5e`, `fb-1234567890`.

```yaml
---
id: "yt-1BRAppCB3K0"
type: "video"
platform: "youtube"          # youtube | instagram | facebook | vimeo | other
url: "https://youtu.be/1BRAppCB3K0"
embed_url: "https://www.youtube.com/embed/1BRAppCB3K0"
thumbnail_url: "..."
title: "Anchor step variations"
description: "..."
creators: ["ben-morris", "torri-smith"]
channel: "yt-passion-for-wcs"
published: "2024-03-11"
duration_s: 412
language: "en"
format: "tutorial"           # tutorial | demo | routine | social | competition | lecture | drill
role: "both"                 # lead | follow | both
categories: ["technique"]
level: 2                     # primary level, 1–4
level_range: [1, 3]          # who it is still useful for
concepts:
  - {id: "anchor-step", weight: 0.9, confidence: 0.82, source: "llm", t: 74}
  - {id: "stretch",     weight: 0.4, confidence: 0.55, source: "llm"}
authority: 96                # cached from the creators' WSDC score
demoted: false
has_transcript: true
status: "published"          # published | review | hidden | rejected
added: "2026-09-22"
generated: true
---
```

`t:` is the second at which the concept is actually taught. Deep-linking to *the 40 seconds
where someone explains the anchor* is the single feature most likely to make this better
than YouTube's own search.

Every concept edge carries `source` (`manual` | `llm` | `title-match` | `channel-default`)
and `confidence`. A machine-written edge may never silently overwrite a hand-written one —
the same discipline as the `generated:` flag in `teaching.westie.si`.

### `content/creators/<slug>.md`

```yaml
---
id: "ben-morris"
type: "creator"
name: "Ben Morris"
aliases: ["Ben Morris & Torri Smith", "Ben & Torri"]
wsdc_id: 3438
wsdc:                        # mirrored from wsdcfetcher.py, refreshed on a schedule
  leader:   {CHA: 2140, ALS: 0, ADV: 0, INT: 0, NOV: 0, NEW: 0}
  follower: {CHA: 0, ALS: 0, ADV: 0, INT: 0, NOV: 0, NEW: 0}
  fetched: "2026-09-22"
authority: 96                # computed — see §6. Not hand-typed.
authority_override: null     # the escape hatch, used sparingly and visibly
demote: false
channels: ["yt-xxxx"]
---
```

### `content/concepts/<slug>.md`

Imported from `teaching.westie.si`, extended with what a public search engine needs — and
with the provenance that the import itself demands (§5):

```yaml
aliases: ["tuck turn", "sugar tuck"]   # WCS naming is not standardised
related: ["whip-cut-off-entry"]        # non-prerequisite association
level: 2
level_trust: "imported"                # imported | corroborated | verified | disputed
requires:                              # NOT a bare list — every edge carries its origin
  - {id: "anchor-step",     origin: "import:teaching@2026-09-22", trust: "imported",
     confidence: 0.5, strength: "required"}
  - {id: "closed-position", origin: "corpus:cooccurrence", trust: "corroborated",
     confidence: 0.74, strength: "usually-taught-before", evidence: 11}
verified_by: null                      # who checked it, and when
verified_at: null
```

`strength` separates *"you cannot do this without that"* from *"teachers usually cover that
first"*. The upstream data conflates the two, and a learning aid that says **Required** when
it means **commonly sequenced** sends people away to learn something they did not need.

Aliases matter more than they look. "Cut-off whip" and "terminated whip" are the same
thing; "sugar tuck" and "tuck turn" are the same thing; every teacher names things
differently. Without an alias table, search silently misses half the material.

### `content/channels/<slug>.md`

A tracked ingestion source: channel id, default creators, default tier, sync cursor, and
whether its material is auto-published or lands in review.

Seed list to start from:

- **`@PassionForWCS`** — event workshop and demo footage of touring pros. High value:
  the teachers in it resolve to real WSDC records, so the ranking does the work.
- Ben Morris, Jordan & Tatiana, Thibault & Nicole, Jakub & Emeline, Clem & Evi and
  other champion-division names with their own channels.
- Event channels (Budafest, Hungarian Open, Swingvester, Westie Spring Thing).
- WestCoastSwingOnline — ingested, but `demote: true` at the channel level (§6).

### `content/paths/<slug>.md`

An ordered curriculum: `beginner-first-3-months`, `learning-the-whip`,
`musicality-from-scratch`. A list of concept ids with a note per step. The video for each
step is deliberately *not* stored — it is the top-ranked video for that concept at render
time, so every path improves automatically as the database grows.

---

## 4. The knowledge graph

Nodes: `concept`, `video`, `creator`, `path`. Edges:

- `concept --requires--> concept` (the DAG; already exists upstream)
- `concept --related--> concept` (symmetric, weighted)
- `video --teaches--> concept` (weighted, with confidence and timestamp)
- `creator --teaches--> concept` (computed from their videos)
- `concept --part_of--> path`

Nothing stores a backlink. "Which videos teach this?" is computed, so it cannot rot — the
rule `teaching.westie.si` already follows, and the reason its data has stayed clean.

What the graph buys:

1. **Prerequisite walk.** Open `basic-whip` and the page says: this assumes `anchor-step`,
   `closed-position`, `j-hook` — here is the best video for each, in order.
2. **What next.** The concepts that require what you just learned.
3. **Gap detection.** Concepts with no high-authority video. That is the ingestion to-do
   list, generated rather than guessed.
4. **Related videos** by shared weighted concept edges, which beats title similarity.
5. **Path generation** by topological sort of the DAG filtered to a level — the same
   algorithm as the prerequisite check already written in `teaching.westie.si`'s `Graph.php`.

`tools/graph_check.py` runs on every build: cycle detection, orphan concepts, and level
inversions (a level-2 concept requiring a level-3 one is nearly always a data bug).

### The foundation — done, 2026-09-22

The import gave a vocabulary of *moves* with no vocabulary of *primitives* underneath it.
`basic-whip` declared that it needs `anchor-step`; nothing declared that the anchor needs
being able to triple-step on your own centre. The ladder had no bottom rung, so a generated
learning path started halfway up, and six concepts were orphans precisely because they were
primitives with no primitive tier to attach to.

`content/foundation.yml` is the fix: ~37 concepts in five tiers, hand-authored, the only
part of the database allowed to write `trust: verified`. Level `0` was added below beginner,
because collapsing "have a pulse" and "dance a whip" onto one rung is the same levelling
error the audit already flagged four times.

| Measure | Import | After |
|---|---|---|
| Concepts | 208 | 219 |
| Prerequisite edges | 257 | 313 |
| Density | 1.24 | 1.43 global · **2.11** inside the foundation |
| Verified edges | 0 | 76 |
| Orphans | 6 | **0** |
| Level inversions | 4 | **0** |
| Unrooted (walk ends nowhere declared) | 207 | **0** |
| Roots | 10 accidental | **2 declared** |

The last two rows are the ones that matter. Every one of the 219 concepts now walks down
to `posture-and-alignment` or `downbeat-and-upbeat` — the graph became traversable rather
than being a pile of patterns with ten accidental floors.

Three things worth keeping in mind for the next pass:

- **Fixing an inversion surfaces the next one.** Relevelling `acceleration` and
  `kick-ball-change` from L4 to L2 immediately exposed `distance-management` and
  `rolling-feet` still sitting at L3 underneath them. The error ran a layer deeper than the
  original audit could see. Expect the same when the next batch is touched.
- **The four inversions were mis-read.** PLAN.md called three of them "a compound filed
  below its own component"; looking at each, the *component* levels were wrong. Raising the
  compounds would have silenced the check while making the advanced tier even more
  top-heavy. Only `playing-with-handholds` was a genuine compound error.
- **Assert what you control.** The first `expects:` block demanded density 1.6 across all
  219 concepts and failed at 1.43 — a number that is 90% a property of the 182 concepts the
  foundation does not touch. No edit to the spec could fix it, so the only path to green was
  weakening the threshold, which is how a check becomes decoration. It now asserts
  foundation density and *reports* global density.

Two tools, one rule each, and they cross-check: `tools/foundation.py --check` validates the
`expects:` block; `tools/graph_check.py` runs the original audit. Both now report zero. The
studio at `/graph` recomputes the same findings in the browser and shows them next to the
Python tool's own audit, so a drift between the two implementations is visible rather than
quiet.

### The graph studio — `web/app/graph/`

A four-view tool over the graph, static-exported, reading `content/` at build time:

- **Tiers** — the foundation as authored, with undeclared roots called out.
- **Problems** — the audit as a work queue where every finding links into the inspector. A
  finding you cannot act on from where you read it gets read and forgotten.
- **Inspect** — one concept: direct prerequisites with the trust on each edge, the full
  transitive closure by depth, what it unlocks, where it bottoms out, and an editor that
  writes through the API. The closure is the best single check on levelling: 30 things
  below a level 1 is a levelling error, two things below a level 4 is a missing edge.
- **Coverage** — levels, categories, the verified/imported split, and the uncovered
  concepts ordered by how much depends on them, which is the ingestion list sorted by
  leverage rather than alphabetically.

An edge added by hand in the editor is written as `verified` with the date. A human edit is
exactly the evidence the trust ladder exists to record; writing `imported` for it would make
the ladder meaningless in the one case it exists for.

---

## 5. Trust, provenance and verification

**Nothing imported from elsewhere is treated as fact.** Not the upstream concept graph, not
the LLM's tags, not YouTube's metadata, not even the WSDC identity match. Each arrives with
an origin and a confidence, and each has a way of being challenged by evidence.

### What the upstream graph actually looks like

Measured on 2026-09-22 against `teaching.westie.si/content/concepts/` (208 files):

| Check | Result | Reading |
|---|---|---|
| Cycles | 0 | Structurally sound |
| Dangling `requires` targets | 0 | Referentially clean |
| `status: draft` | **207 of 208** | Essentially nothing has been reviewed |
| `generated: true` (never human-touched) | 74 | A third is pure machine output |
| Level inversions | 4 | Real judgment errors, see below |
| Concepts with no video | 80 | 38% has no material attached |
| Orphans (no edges in or out) | 6 | Floating, unplaced in the graph |
| `requires` edges | 257 over 208 nodes | 1.2/node — the DAG is **sparse**, not wrong |
| Level distribution | L1 37 · L2 53 · L3 80 · L4 38 | 57% advanced; beginner coverage is thinnest |

The four inversions show the flavour of the errors:

```
playing-with-handholds  (L1) requires body-lead-and-frame (L2)
acceleration-into-whip  (L3) requires acceleration        (L4)
kick-ball-change-1-2    (L3) requires kick-ball-change    (L4)
left-side-pass-acceleration (L2) requires acceleration    (L4)
```

Three of the four are the same bug: a compound move was filed *below* its own component.
These are not transcription slips, they are a levelling pass that was never reviewed.

And the upstream README says the project has 138 concepts while the folder holds 208 — the
documentation has drifted from the data. That is the clearest signal of all that this graph
is a working draft someone is still building, not a finished reference.

**Sparsity is the bigger problem than error.** 1.2 prerequisites per node means most
concepts under-declare what they depend on. A learning path built naively on this graph
would look complete and quietly skip things.

### The rule

Every node and every edge carries `origin`, `trust` and `confidence`. Trust has four states
and only ever moves up by evidence or by a human:

| `trust` | Meaning | Shown to a learner as |
|---|---|---|
| `imported` | Came from upstream. Unreviewed. | Greyed, "suggested" |
| `corroborated` | The video corpus independently supports it | "usually taught before this" |
| `verified` | A human confirmed it, with a name and a date | "required first" |
| `disputed` | Evidence contradicts it | Hidden from paths, shown in the audit |

Imported edges start at `confidence: 0.5` — genuinely uncertain, neither trusted nor
discarded. The UI **never** renders an `imported` edge in the same weight as a `verified`
one. If we cannot say how sure we are, we do not make the claim.

### The corpus checks the graph, not just the other way round

This is the part that earns the distrust its keep. Once there are a few thousand tagged
videos, they become independent evidence about the concept graph:

1. **Co-occurrence.** If champion teachers routinely cover Y within the same lesson as X, Y
   is probably a genuine prerequisite of X even when upstream never said so. This
   *proposes new edges* and directly attacks the sparsity problem.
2. **Level contradiction.** If the graph calls X level 3 but a dozen high-authority videos
   teach it in explicitly beginner material, flag it. Four inversions were found by a
   structural check; this catches the ones that are structurally legal but still wrong.
3. **Sequence evidence.** Multi-part series and course playlists encode a teaching order
   that a syllabus spreadsheet does not. Cheap, strong signal.
4. **Orphan rescue.** The 6 orphans and 80 uncovered concepts are a work queue, not a
   defect to live with.

Crucially, corroboration is **weighted by authority**, exactly like the ranking. A
Champions-division teacher sequencing Y before X is evidence; a content farm doing so is
close to noise. The same WSDC score that orders search results also weights what is allowed
to modify the knowledge graph.

### Audit as data, not as a log line

`tools/graph_check.py` runs on every build and writes `content/.audit/graph.json`. Cycles,
inversions, orphans, sparsity outliers and corpus contradictions become **review-queue
entries** alongside the classifier's proposals — the same screen, the same accept / correct
/ reject keystrokes. Findings that are noticed but never actioned are worthless; findings
that arrive as a work queue get fixed.

The build does not fail on them. It fails only on cycles and dangling references, because
those break the path algorithms. Everything else is a judgment call for a human.

### Import is a diff, never an overwrite

Re-importing from `teaching.westie.si` produces a **reviewable diff**, not a replacement. A
local edge that reached `verified` is never clobbered by an upstream `imported` one. Where
the two genuinely disagree, both are stored with their provenance, so the disagreement is
visible and can be pushed back upstream rather than silently lost in whichever direction
happened to sync last.

### The same suspicion, applied to the other three sources

- **LLM classification** — confidence per edge, review queue below threshold, and
  `source: "llm"` never overwriting `source: "manual"`. Already in §8.
- **YouTube metadata** — titles are marketing. "The ONLY whip tutorial you need" says
  nothing about level or content. Treat title as a weak signal, transcript as a strong one,
  and never let a channel's self-declared level stand unreviewed.
- **WSDC identity resolution** — the sharpest hazard, because it is silent. Matching
  "Ben Morris" to the wrong WSDC ID assigns a wrong authority to *every video that creator
  appears in*, and nothing about the result looks broken. So: name matching proposes, it
  never commits. Each `wsdc_id` needs confirmation against corroborating evidence (division,
  region, active years, partner names) and stores that evidence in the creator file.
  Ambiguous names go to the review queue rather than picking the best guess.

### And the same suspicion applied here

The corroboration thresholds, the `confidence: 0.5` starting point and the four-state trust
ladder are all first guesses. They should be reviewed against real behaviour once M5 has
produced a few hundred tagged videos, not treated as settled because they are written down.

---

## 6. Ranking — WSDC standing as the backbone

The ordering rule you asked for, stated as a computation rather than a list of opinions.

### Authority from WSDC points

`tools/wsdc_sync.py` reuses `wsdcfetcher.py` to pull each creator's record and store points
per division. `Wsdc.php` turns that into a 0–100 authority:

```
pts       = max over both roles of the division's points
authority = 88 + min(12, CHA/150)    if CHA > 0      → 88–100   Champions
          = 70 + min(17, ALS/120)    if ALS > 0      → 70–87    All-Star
          = 55 + min(14, ADV/100)    if ADV > 0      → 55–69    Advanced
          = 40 + min(14, INT/80)     if INT > 0      → 40–54    Intermediate
          = 25 + min(14, NOV/60)     if NOV > 0      → 25–39    Novice
          = 12                       if a record exists but is empty
          = 8                        if no WSDC record was found at all
```

For a video taught by a couple, authority is the **max** of its creators — a champion
teaching with a less-titled partner still ranks as a champion.

Three consequences, all of them the ones you want:

- Ben Morris, Thibault & Nicole, Jakub & Emeline, Clem & Evi land at 88–100 without
  anybody typing their names into a config file.
- A teacher who is not on the event scene has **no WSDC record**, so they score 8
  automatically. The thing you dislike is expressed as an absence of competitive standing,
  which is precisely what it is — and it needs no blocklist to maintain.
- The list stays current on its own. Someone who breaks into Champions this season moves up
  at the next sync.

The exact constants are a first pass and belong in `ranking.yml`, not in code — expect to
tune them once there is real data to sort.

### Demotion, as a tier rather than a penalty

WestCoastSwingOnline is a brand, not a dancer, so points cannot express it. A channel or
creator may carry `demote: true`, and:

```yaml
tiers:
  demoted_always_last: true
```

Demoted material sorts **after everything non-demoted regardless of score**. It is still in
the database, still searchable, still surfaced when it is the only thing covering a concept
— but always at the back. That is exactly the behaviour you described.

### The blend

```yaml
weights:
  relevance:  1.00   # BM25 from FTS5; 0 when browsing rather than searching
  authority:  0.80   # the WSDC score above
  votes:      0.50   # Wilson lower bound of up/(up+down), not raw count
  fit:        0.40   # level match + concept-edge weight × confidence
  freshness:  0.10   # mild decay, ~5-year half-life
penalties:
  no_transcript: -0.05
  unreviewed_classification: -0.10
```

Two rules keep this trustworthy:

- **Explainable.** Every result can show why it sits where it does — *"Champions division,
  2140 pts (+0.80) · 14 upvotes (+0.35) · matched 'anchor step' in transcript at 1:14"*. A
  ranking you disagree with is impossible to debug otherwise.
- **Tunable without a deploy.** Changing the weights is editing one YAML file.

### One honest caveat

Competitive standing is a proxy for teaching quality, not the same thing. A few superb
teachers have modest comp records, and a few champions teach badly. The WSDC score is the
right *prior* — it is objective, current, and it encodes "on the event scene" exactly — but
the vote weight is deliberately high enough (0.50) that the crowd can move a video several
places against it. `authority_override` exists for the rare case where you want to say so
directly, and it is stored in the creator file so the exception is visible rather than
buried.

---

## 7. Search

SQLite **FTS5** at `content/.index/search.sqlite`, rebuilt by `tools/build_index.py` from
`content/`. Indexed fields, descending BM25 weight:

`title` › `concept names + aliases` › `creator names` › `description` › `transcript` › `tags`

Requires `pdo_sqlite` on the host — near-universal on PHP 8, but **verify at M0**, because
it decides the engine. The fallback is the in-memory scorer already written in
`teaching.westie.si`'s `Query.php`: slower, but it needs nothing but a file tree.

Beyond plain matching:

- **Alias query expansion** — searching "tuck" finds "sugar tuck" and "tuck turn" material.
- **Concept detection in the query** — "how do I lead a whip" resolves to `basic-whip` and
  puts the concept page above the raw video hits.
- **Facets** — level, category, concept, creator, WSDC division, platform, duration bucket,
  language, has-transcript, format.
- **Transcript snippets with timestamps** — a hit shows the sentence and links to that
  second of the video.

---

## 8. Ingestion

### Phase A — YouTube (the 90% case, fully automatable)

YouTube Data API v3: channel → uploads playlist → `videos.list` for duration, tags and
description. Quota is generous at this volume. `content/channels/` holds each tracked
channel and the cursor of its last sync, so runs are incremental.

Transcripts via `youtube-transcript-api`. Auto-captions are good enough for topic detection
and they carry timestamps, which is the part we actually need. Stored in
`content/.transcripts/`, gitignored.

### Phase B — Instagram / Facebook (the weak part, stated honestly)

There is no supported public API for reading arbitrary third-party Instagram or Facebook
content. The Instagram Graph API only reaches accounts that have authorised your app,
Facebook's oEmbed needs an app token, and scraping breaks constantly besides being against
their terms.

So the realistic design is **assisted manual entry**: a paste-a-URL admin form that stores
the URL, renders the public blockquote embed, and lets the classifier propose tags from
whatever caption text comes with it. Optionally `yt-dlp` on your workstation during
curation for metadata on a URL you already have — never on the server, never as a crawler.

Expect tens of hand-picked items there, not thousands. The good short-form WCS content on
those platforms is a curated set anyway.

### Phase C — Classification

`tools/classify.py` feeds title + description + transcript + the 208-concept vocabulary
(with aliases) to an LLM and gets back proposed categories, level, format, role, and
concept edges with confidence and timestamps.

- Writes `generated: true`, `source: "llm"`, confidence per edge.
- Anything below the confidence threshold lands in `/api/queue/review` rather than going
  live — a keyboard-driven screen where a proposal is accepted, corrected or rejected.
- Accepting flips it to `source: "manual"` and `generated: false`, which permanently
  protects it from the next re-classification run.

### Deduplication

The same lesson gets posted to YouTube and cut into an Instagram reel. Match on creator +
fuzzy title + duration, and link them as `same_as` rather than merging, so both embeds stay
available.

---

## 9. Voting and moderation

Votes are events in `data/votes.sqlite`, **never** written into `content/`. The curated
database stays clean and a vote brigade can never corrupt the source of truth.

```
votes(id, target_type, target_id, voter_hash, kind, value, created_at)
  kind: quality | level_wrong | concept_wrong | remove
```

- **Identity** — a `voter_hash` from a long-lived cookie id plus a salted IP hash. No
  accounts in v1; accounts kill participation on a niche site. Revisit if abuse appears.
- **Anti-abuse** — one vote per target per voter, hourly rate limit, and a minimum vote
  count before a target's score moves at all. Wilson lower bound, so 3 upvotes never
  outrank 200.
- **Corrective votes feed a queue, they do not auto-apply.** Five people saying "this is
  level 3, not level 1" produces a moderation entry; you apply it to the Markdown through
  the API. Removal votes hide a video from default results at a threshold and queue it for
  a decision — they never delete a file.

---

## 10. The learning aid

Two ways in, both reading the same graph.

**"I am starting West Coast Swing."** → `/paths/beginner`. The concept DAG filtered to
level 1, topologically sorted, grouped into weeks. Each step: what it is, the two or three
best-ranked videos, common mistakes, and a "mark as learned" toggle. Progress lives in
`localStorage` — no account, no friction.

**"I want to learn the whip."** → `/concepts/basic-whip`. Prerequisites first, with a
warning if you have not marked them learned. Then the ranked videos. Then what this
unlocks, the related concepts, and the creators who teach it best.

A third, quieter entry point, admin-only: **the gap list** — concepts with no
high-authority video. It tells you what to go and find next.

---

## 11. Milestones

Each ends with something that runs.

**M0 — Skeleton (½ day).** `git init`. Repo layout. Copy and adapt `Yaml.php`, `Store.php`,
`Query.php`, `Graph.php`. `/api/health` answering. Next.js scaffold from `WCS-front`'s
config, building into `public/`. Verify PHP version and `pdo_sqlite` on the host.

**M1 — Concepts, imported as a draft (1–2 days).** `tools/import_concepts.py` brings the
208 concepts in with `trust: "imported"` and `confidence: 0.5` on every edge — never as
fact. `tools/graph_check.py` writes the first `content/.audit/graph.json`. Then the triage
that the audit already names: fix the 4 level inversions, place the 6 orphans, split
`requires` into `required` vs `usually-taught-before`, and add aliases for the ambiguous
concepts. Statically generated concept pages that render trust honestly. **The site is
useful here even with zero videos** — and the 80 uncovered concepts become M3's shopping
list.

**M2 — Creators and WSDC ranking (1–2 days).** `content/creators/`, `tools/wsdc_sync.py`
over `wsdcfetcher.py`, `Wsdc.php` + `Rank.php`, `ranking.yml`. The name → WSDC-ID
resolution is the fiddly bit and wants a review step. Nothing to rank yet, but the policy
lands before the data does — retrofitting a ranking onto an existing corpus means
re-reviewing all of it.

**M3 — YouTube ingestion (2–3 days).** Channel tracking, incremental sync, transcripts,
dedup. Target 500–1500 videos from 30–60 channels, starting with `@PassionForWCS`.
Browsable, filterable, ranked — not yet well tagged.

**M4 — Search (1–2 days).** FTS5 index build, `/api/search`, facets, alias expansion,
timestamped transcript snippets. The point at which it becomes genuinely useful.

**M5 — Classification + review UI (2–3 days).** `classify.py`, thresholds, the review
queue. Most of the calendar time here is *reviewing*, not coding — budget a few evenings.

**M6 — Voting (1 day).** `votes.sqlite`, API, widget, Wilson scoring, rate limits, the
moderation queue.

**M7 — Learning paths (1–2 days).** `content/paths/`, path pages, prerequisite walk,
localStorage progress, "what next".

**M8 — Deploy.** Domain → `public/`. `content/` above the document root, unreachable over
HTTP. Write token in `config.local.php`. Build-and-rsync script. Nightly cron: incremental
YouTube sync, WSDC refresh, index rebuild.

---

## 12. Open decisions

1. **Where do concepts live canonically?** The audit in §5 changes my answer here.
   `teaching.westie.si` owns the concept *ids* — drills, classes and season plans hang off
   them — but 207 of 208 records are unreviewed drafts, so it is not a source of truth
   about levels or prerequisites. Recommended split: **ids upstream, judgments here.** This
   project keeps the ids stable, does the verification work the upstream never did, and
   offers corrections back as a diff. The alternative — waiting for upstream to be reviewed
   first — blocks everything behind a job nobody has started.
2. **Voting identity.** Recommended: anonymous with a cookie hash for v1.
3. **`pdo_sqlite` on the host.** Checked at M0; it decides the search engine.
4. **Scale target.** 500 videos curated well, or 5000 ingested broadly? This sets how far
   the classifier is trusted without review. Recommended: start curated, widen later.
5. **Language.** English-only, or a Slovenian UI over English content?
