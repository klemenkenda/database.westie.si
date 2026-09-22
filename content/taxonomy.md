---
id: "taxonomy"
type: "taxonomy"
title: "Facet vocabulary"
categories: ["technique", "pattern", "connection", "musicality", "styling", "partnerwork", "footwork", "turns", "choreography"]
levels: [1, 2, 3, 4]
formats: ["tutorial", "demo", "routine", "drill", "lecture", "social", "competition"]
roles: ["lead", "follow", "both"]
platforms: ["youtube", "instagram", "facebook", "vimeo", "other"]
trust_states: ["imported", "corroborated", "verified", "disputed"]
edge_strengths: ["required", "usually-taught-before", "related"]
divisions: ["CHA", "ALS", "ADV", "INT", "NOV", "NEW"]
updated: "2026-09-22"
generated: true
---

# Facet vocabulary

The filter vocabulary the UI offers. Counts are from the 208 concepts imported on
2026-09-22 and will drift as the database grows — they are a description, not a contract.

## Categories

| Category | Concepts |
|---|---|
| `technique` | 74 |
| `pattern` | 74 |
| `musicality` | 16 |
| `connection` | 15 |
| `styling` | 12 |
| `partnerwork` | 7 |
| `footwork` | 5 |
| `turns` | 4 |
| `choreography` | 1 |

The tail is thin enough to be suspicious. `turns` holding four concepts while `pattern`
holds 74 says more about how the upstream spreadsheet was filled in than about the dance,
and re-categorising is part of the M1 review queue rather than a settled fact.

## Levels

`1` beginner · `2` improver · `3` intermediate · `4` advanced.

The imported distribution is L1 37 · L2 53 · L3 80 · L4 38 — 57% of the vocabulary sits at
level 3 or above, while level 1, the part a learning path needs most, is the thinnest
bucket. Expect to add beginner concepts rather than assume the ladder is complete.

## Trust states

Every edge and contested field carries one. See §5 of PLAN.md and `lib/Trust.php`.

- `imported` — came from upstream, unreviewed. Shown as *suggested*.
- `corroborated` — the video corpus independently supports it.
- `verified` — a human confirmed it, with a name and a date.
- `disputed` — evidence contradicts it. Excluded from learning paths.

## Edge strengths

`required` is not the same claim as `usually-taught-before`, and the UI must never render
the second as the first. The upstream graph conflates them; splitting them is M1 work.

## Tags

45 in use. The frequent ones: `technique` 63, `blw` 57, `pattern` 50, `connection` 43,
`turns` 41, `fundamentals` 28, `whip` 25, `footwork` 23, `patterns` 23, `timing` 21,
`musicality` 20, `styling` 20, `blues` 18, `slot` 17, `rotation` 17, `body-lead` 15.

`pattern` (50) and `patterns` (23) are the same tag spelled two ways, and `blw` is a
course code from the upstream syllabus rather than a property of the material. Both are
review-queue items.
