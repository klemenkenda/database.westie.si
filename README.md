# database.westie.si

A public, searchable database of West Coast Swing video material, with a concept knowledge
graph over it and a ranking driven by the WSDC standing of the teachers.

[PLAN.md](PLAN.md) is the design. This file is how to run what exists.

**No database.** Every record is a Markdown file with YAML frontmatter under
[content/](content/). The API reads and writes those files; `content/` is meant to be
diffed and committed like source code.

## Run it

```bash
docker compose up -d api          # API on http://localhost:8081
docker compose run --rm test      # 134-check suite: libs, trust, ranking, live HTTP
python tools/graph_check.py       # audit the concept graph
```

## Where it is

| Milestone | State |
|---|---|
| M0 — skeleton, PHP API, Docker | done |
| M1 — concepts imported and audited | imported; the review queue is open |
| M2 — creators and WSDC ranking | code done; **12 creators need WSDC ids confirmed** |
| M3 — YouTube ingestion | not started |
| M4 — search | not started |
| M5 — classification + review UI | not started |
| M6 — voting | not started |
| M7 — learning paths | not started |
| M8 — deploy | not started |

The Next.js frontend is not scaffolded yet. `public/` currently holds only the API.

## Layout

| Path | What it is |
|---|---|
| `content/concepts/` | 208 concepts — level, category, prerequisite edges with provenance |
| `content/videos/` | empty until M3 |
| `content/creators/` | 12 seeded — authority is computed from WSDC standing |
| `content/taxonomy.md` | the facet vocabulary |
| `content/ranking.yml` | the tunable weights — ranking is config, not code |
| `content/.audit/` | what the last import and the last graph check decided |
| `public/api/` | the PHP API (no framework, no dependencies) |
| `tools/` | Python: import, audit, WSDC sync; PHP: the test suite |

## Nothing here is treated as fact

The concept vocabulary was imported from `teaching.westie.si`, where 207 of 208 records are
unreviewed drafts. So every prerequisite edge carries where it came from and how sure we
are:

```yaml
requires:
  - id: "anchor-step"
    origin: "import:teaching@2026-09-22"
    trust: "imported"        # imported -> corroborated -> verified, or disputed
    confidence: 0.5
    strength: "required"     # vs "usually-taught-before" — not the same claim
```

Trust only moves up by evidence or by a human. `Trust::merge` refuses to let a routine
re-import demote an edge somebody verified, and records the disagreement on the edge
instead of silently resolving it. That rule is what makes re-importing safe, so it is the
most heavily tested thing in the repo.

`strength` is deliberately separate from `trust`. The upstream graph conflates "you cannot
do this without that" with "teachers usually cover that first", and a learning aid that
says **Required** when it means **commonly sequenced** sends people away to learn something
they did not need.

### What the audit currently says

```
concepts 208 | edges 257 | density 1.24 per concept
trust:      verified 0 | corroborated 0 | imported 257 | disputed 0
unreviewed: 208 of 208 still draft, 208 never human-touched

BUILD-BREAKING
  cycles 0 · dangling references 0

REVIEW QUEUE
  level inversions   4    a concept filed below its own prerequisite
  orphans            6    no edge in either direction
  sparse (level 2+)  1    declares no prerequisites at all
  uncovered        208    no video attached — the ingestion shopping list
```

Three of the four inversions are the same bug: a compound move filed below its own
component (`acceleration-into-whip` at L3 requiring `acceleration` at L4). They are not
transcription slips; they are a levelling pass that was never reviewed.

Only cycles and dangling references break a build. They make the path algorithms *wrong*
rather than merely unreviewed. Everything else leaves a queue entry for a human.

## Ranking is computed, not curated

Authority comes from WSDC standing, so the editorial rule — prefer teachers who compete at
the top of the event scene — is a computation over public data rather than a list of names
somebody keeps current. A dancer who breaks into Champions moves up at the next sync.

| Division | Authority |
|---|---|
| CHA | 88–100 |
| ALS | 70–87 |
| ADV | 55–69 |
| INT | 40–54 |
| NOV | 25–39 |
| NEW | 15–23 |
| confirmed record, no points | 12 |
| looked up, not in the registry | 8 |

Division dominates points, so a huge Intermediate record never overtakes a Champion. A
video takes the **max** across its creators: a champion teaching with a less-titled partner
is still a champion teaching.

**"Not checked yet" is not the same as "checked and absent."** An unconfirmed creator
scores a provisional 45 and is flagged as such wherever it ranks, because collapsing the
two would bury every creator nobody has processed down with the content farms.

**Demotion is a sort tier, not a penalty.** `demote: true` sorts a creator after everything
non-demoted whatever it scores — still searchable, still surfaced when it is the only
coverage of a concept, but always at the back. A penalty can be out-argued by enough of
another signal; a tier cannot.

Weights live in [content/ranking.yml](content/ranking.yml) and `GET /api/ranking` serves
the policy with a worked example of the curve. Every score explains itself:
`CHA division, 2140 pts (+0.79) | 14 up, 2 down (+0.31)`.

### WSDC ids are confirmed by hand, never matched

The registry has **no name search** — lookup is by numeric id. So an id enters the database
only through `wsdc_sync.py confirm`, which shows you the registry name and best competition
before binding it, and stores that evidence in the creator file.

A wrong id is invisible: nothing looks broken, and every video that creator appears in
inherits the wrong authority. Confirming sixty by hand once removes the whole failure class.

```bash
python tools/wsdc_sync.py pending            # who still needs an id
python tools/wsdc_sync.py lookup 10277       # inspect a registry record
python tools/wsdc_sync.py confirm ben-morris 1234
python tools/wsdc_sync.py refresh            # re-fetch points for confirmed creators
```

## The privacy line

`teaching.westie.si` holds 525 workshop recordings from events and privates. That is
personal archive material and not ours to republish. **None of it is in this project**, and
that is enforced rather than remembered — `tools/import_concepts.py` carries five fields
(`id`, `title`, `category`, `level`, `tags`), regenerates every body from scratch, and
refuses to write if an archive video id ever appears in one of our own video lists. The
test suite asserts it too.

## Editing

The API writes the Markdown file and clears its `generated` flag, so a re-import will not
overwrite text you have written:

```bash
curl -X PUT localhost:8081/api/concepts/basic-whip \
     -H 'Content-Type: application/json' \
     -d '{"level": 2}'
```

Re-importing after upstream changes is a reviewable diff, never a replacement:

```bash
python tools/import_concepts.py --dry-run     # what it would do
python tools/import_concepts.py               # apply, then read content/.audit/import.json
```

## API

`GET /api/health · /overview · /taxonomy · /audit · /search?q=`

`GET|POST /api/{collection}` · `GET|PUT|DELETE /api/{collection}/{key}`

`GET /api/concepts/{key}/graph` — prerequisites, what it unlocks, the trust summary.

Filters combine with AND: `?category=pattern&level=3&tags=whip,turns&q=cut-off`.
`tags` requires *all* listed values; other filters accept a comma-separated OR list.
Also `level_min`, `level_max`, `sort`, `dir`, `limit`, `offset`, `fields`.

Writes need `X-Api-Token` when `write_token` is set in `public/api/config.local.php`.

## Deploying

Point the domain at `public/`. `content/` sits above the document root and is unreachable
over HTTP. `content/` and `content/.cache/` must be writable by PHP.

```php
// public/api/config.local.php  (not committed)
<?php return ['write_token' => 'a-long-random-string'];
```
