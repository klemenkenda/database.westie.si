#!/usr/bin/env python
"""Track YouTube channels and ingest their videos.

    python tools/yt_sync.py add https://www.youtube.com/@PassionForWCS
    python tools/yt_sync.py sync                    # every tracked channel
    python tools/yt_sync.py sync passion-for-wcs --limit 50
    python tools/yt_sync.py transcripts --limit 20  # captions for videos that lack them
    python tools/yt_sync.py channels

Incremental: discovery is one cheap request per channel, and only ids we have never seen
get the expensive per-video detail fetch.

Creator attribution follows the same rule as everything else here — it proposes, it does
not commit. A full name in a title is good evidence; a bare first name is not, because our
creator list is full of bare first names and "Gary" matches any of them. Anything below the
threshold leaves `creators: []`, which the ranking treats as *provisional authority* rather
than as a low score, and the video lands in review.
"""
from __future__ import annotations

import argparse
import datetime as _dt
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import wcsyaml  # noqa: E402
import youtube  # noqa: E402

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CONTENT = os.path.join(HERE, "content")
CHANNELS = os.path.join(CONTENT, "channels")
VIDEOS = os.path.join(CONTENT, "videos")
CREATORS = os.path.join(CONTENT, "creators")
TRANSCRIPTS = os.path.join(CONTENT, ".transcripts")

VIDEO_KEYS = [
    "id", "type", "platform", "youtube_id", "url", "embed_url", "thumbnail_url",
    "title", "description", "creators", "creator_source", "creator_confidence",
    "channel", "published", "duration_s", "view_count", "language",
    "format", "format_source", "role", "categories", "level", "level_range",
    "concepts", "demoted", "has_transcript", "transcript_words",
    "status", "added", "updated", "generated",
]

CHANNEL_KEYS = [
    "id", "type", "platform", "channel_id", "handle", "title", "url",
    "default_creators", "auto_publish", "demote", "note",
    "last_sync", "known_videos", "added", "updated", "generated",
]

# Title patterns. Weak evidence on their own, so each writes its confidence and the video
# stays reviewable; they exist to sort an ingest into rough piles, not to be believed.
FORMAT_PATTERNS = [
    ("competition", r"\b(j&j|jnj|jack\s*(&|and)\s*jill|strictly|finals?|prelims?|semi[- ]?finals?|"
                    r"classic|open|championship|routine division|showcase)\b"),
    # Plurals matter: \bdrill\b does not match "Drills", and "WCS Partner Drills" is
    # exactly the kind of title this is here to catch.
    ("routine",     r"\b(routines?|choreo(graphy)?|performances?|show ?case)\b"),
    ("drill",       r"\b(drills?|exercises?|practice)\b"),
    ("tutorial",    r"\b(tutorials?|lessons?|how to|techniques?|tips?|basics?|workshops?|"
                    r"class(es)?|breakdowns?|explained)\b"),
    ("demo",        r"\b(demos?|demonstrations?|social dancing|social dance)\b"),
]


def slugify(text: str) -> str:
    text = text.lower().strip()
    for a, b in (("ž", "z"), ("š", "s"), ("č", "c"), ("ć", "c"), ("đ", "d"), ("ä", "a"),
                 ("ö", "o"), ("ü", "u"), ("é", "e"), ("è", "e"), ("á", "a"), ("í", "i"),
                 ("ó", "o"), ("ú", "u"), ("ï", "i"), ("ñ", "n"), ("ç", "c")):
        text = text.replace(a, b)
    return re.sub(r"[^a-z0-9]+", "-", text).strip("-")


def read_all(directory: str) -> dict[str, dict]:
    out = {}
    if not os.path.isdir(directory):
        return out
    for name in sorted(os.listdir(directory)):
        if name.endswith(".md"):
            front, _ = wcsyaml.read(os.path.join(directory, name))
            out[name[:-3]] = front
    return out


def write(directory: str, key: str, front: dict, body: str, order: list[str]) -> None:
    os.makedirs(directory, exist_ok=True)
    front["updated"] = _dt.date.today().isoformat()
    ordered = {k: front[k] for k in order if k in front}
    for k, v in front.items():
        ordered.setdefault(k, v)
    wcsyaml.write(os.path.join(directory, key + ".md"), ordered, body)


# ------------------------------------------------------------------ creator matching

def creator_index(creators: dict[str, dict]) -> list[tuple[str, str, bool, bool]]:
    """(needle, slug, is_full_name, is_ambiguous), longest needle first."""
    index = []
    for slug, front in creators.items():
        names = [front.get("name") or slug] + list(front.get("aliases") or [])
        ambiguous = front.get("wsdc_status") == "ambiguous"
        for name in names:
            if isinstance(name, str) and len(name.strip()) >= 3:
                index.append((name.strip(), slug, " " in name.strip(), ambiguous))
    index.sort(key=lambda row: -len(row[0]))
    return index


#: Phrases that mark what follows as *who made this*, rather than merely who is mentioned.
#: A description names sponsors, organisers, judges and every competitor in the running
#: order; only a few words in it are actually about authorship.
CREDIT_CUE = re.compile(
    r"\b(?:lesson|class|workshop|tutorial|taught|instructed|presented|hosted|demo)\b"
    r"[^.\n]{0,20}?\bby\b|\b(?:with|featuring|feat\.?|instructors?|teachers?)\b[: ]",
    re.I)


def credit_windows(text: str) -> str:
    """The parts of a description that follow an authorship cue.

    "West Coast Swing lesson by Thibault and Nicole" yields the names. "thanks to Kyle
    Redd, Sarah Vann Drake" does not, because gratitude is not authorship — and that
    distinction is the whole difference between attributing a video to its teachers and
    attributing it to the people who ran the event.
    """
    out = []
    for match in CREDIT_CUE.finditer(text):
        out.append(text[match.end():match.end() + 80])
    return " | ".join(out)


#: Below this, evidence is too weak to attribute a video to anybody.
ATTRIBUTION_THRESHOLD = 0.5


def match_creators(title: str, description: str, index, fmt: str = "unknown",
                   threshold: float = ATTRIBUTION_THRESHOLD) -> tuple[list[str], float, str]:
    """Who made this video, with a confidence and how it was decided.

    Evidence is ranked by where it was found, not just by what matched:

      * a **full name in the title** is strong — titles are short and deliberate;
      * a name **after an authorship cue** in the description is strong;
      * a bare first name anywhere else is weak, because our creator list is full of bare
        first names and "Gary" or "Karin" matches anybody;
      * an `ambiguous` creator is weaker still, since the name covers two real people and
        choosing one would silently mis-rank the other's videos.

    Competition footage is attributed only on strong evidence. Its description is a running
    order plus a thank-you list, so loose matching there reliably credits the organisers —
    which is how "All Star JnJ Swingtime 2026" first came out as a video *by* the two
    people the uploader was thanking.
    """
    credits = credit_windows(description)
    haystacks = [("title", title, 1.0), ("credit", credits, 1.0), ("body", description, 0.45)]

    found: dict[str, float] = {}
    where: dict[str, str] = {}
    for needle, slug, is_full, ambiguous in index:
        pattern = r"(?<![\w-])%s(?![\w-])" % re.escape(needle)
        for zone, hay, factor in haystacks:
            if not hay or not re.search(pattern, hay, re.I):
                continue
            base = 0.15 if ambiguous else (0.9 if is_full else 0.35)
            score = round(base * factor, 2)
            if score > found.get(slug, 0.0):
                found[slug], where[slug] = score, zone
            break

    if not found:
        return [], 0.0, "none"

    best = max(found.values())
    zones = {where[s] for s in found}

    # More than two names is a roster, not a credit. West Coast Swing is taught by one
    # person or by a couple, so a match on five names means we found a running order, a
    # judging panel or a thank-you list — and an authorship cue somewhere in the same
    # description does not redeem that.
    if len(found) > 2:
        return [], round(best, 2), "roster"

    # Two names corroborate each other only when they appear *together* — "Thibault and
    # Nicole" is a partnership, two names eighty characters apart in a credits roll is a
    # coincidence.
    if best < 0.5 and len(found) >= 2 and adjacent_names(title + " " + credits, found, index):
        best = min(0.6, best + 0.25)

    if fmt == "competition" and not (best >= 0.9 or "credit" in zones):
        return [], round(best, 2), "competition-weak"

    how = ("full-name" if best >= 0.9
           else "credited" if "credit" in zones
           else "pair" if len(found) >= 2
           else "first-name")

    # The threshold belongs here, not in the caller. A function that hands back names it
    # does not believe in invites somebody to use them without checking the number beside
    # them — and a wrong attribution is invisible once it is written to a file.
    if best < threshold:
        return [], round(best, 2), "weak-" + how
    return sorted(found), round(best, 2), how


def adjacent_names(text: str, found: dict[str, float], index) -> bool:
    """Do at least two matched names sit within 30 characters of each other?"""
    needles = [n for n, slug, _f, _a in index if slug in found]
    spans = []
    for needle in needles:
        for m in re.finditer(r"(?<![\w-])%s(?![\w-])" % re.escape(needle), text, re.I):
            spans.append((m.start(), m.end()))
    spans.sort()
    return any(spans[i + 1][0] - spans[i][1] <= 30 for i in range(len(spans) - 1))


def guess_format(title: str, description: str = "") -> tuple[str, float]:
    text = "%s %s" % (title, description[:400])
    for name, pattern in FORMAT_PATTERNS:
        if re.search(pattern, text, re.I):
            return name, 0.6
    return "unknown", 0.0


# ------------------------------------------------------------------------- commands

def cmd_add(args) -> int:
    channel, rows = youtube.discover(args.url, limit=1)
    handle = (channel.get("handle") or "").lstrip("@")
    slug = slugify(handle or channel.get("title") or "channel")
    path = os.path.join(CHANNELS, slug + ".md")
    if os.path.isfile(path) and not args.force:
        print("already tracked: %s" % slug)
        return 0
    front = {
        "id": slug,
        "type": "channel",
        "platform": "youtube",
        "channel_id": channel.get("channel_id"),
        "handle": "@" + handle if handle else None,
        "title": channel.get("title"),
        "url": args.url,
        "default_creators": [],
        # New material is reviewable by default. A channel earns auto-publish once you have
        # seen what it actually posts.
        "auto_publish": False,
        "demote": False,
        "last_sync": None,
        "known_videos": 0,
        "added": _dt.date.today().isoformat(),
        "generated": True,
    }
    body = "# %s\n\nTracked YouTube channel. New videos land in review until\n`auto_publish` is set.\n" % (
        channel.get("title") or slug)
    write(CHANNELS, slug, front, body, CHANNEL_KEYS)
    print("tracking %s (%s)" % (slug, channel.get("channel_id")))
    print("  python tools/yt_sync.py sync %s" % slug)
    return 0


def cmd_channels(args) -> int:
    channels = read_all(CHANNELS)
    if not channels:
        print("no channels tracked - `yt_sync.py add <url>`")
        return 0
    for slug, front in channels.items():
        print("%-24s %-28s videos=%-5s last=%s%s" % (
            slug, front.get("title", "")[:28], front.get("known_videos", 0),
            front.get("last_sync") or "never",
            "  [demoted]" if front.get("demote") else ""))
    return 0


def cmd_sync(args) -> int:
    channels = read_all(CHANNELS)
    if args.slug:
        if args.slug not in channels:
            raise SystemExit("not tracked: %s" % args.slug)
        channels = {args.slug: channels[args.slug]}
    if not channels:
        raise SystemExit("no channels tracked - `yt_sync.py add <url>`")

    existing = read_all(VIDEOS)
    creators = read_all(CREATORS)
    index = creator_index(creators)
    today = _dt.date.today().isoformat()
    total_new, total_seen, unresolved = 0, 0, []

    for slug, channel in channels.items():
        try:
            info, rows = youtube.discover(channel.get("url") or channel["handle"], limit=args.limit)
        except youtube.YoutubeError as exc:
            print("%-24s FAILED %s" % (slug, exc))
            continue
        print("%s: %d videos listed" % (slug, len(rows)))
        new = 0
        for row in rows:
            total_seen += 1
            key = "yt-" + row["id"]
            if key in existing and not args.refresh:
                continue
            try:
                info_v = youtube.detail(row["id"])
            except youtube.YoutubeError as exc:
                print("  %-14s detail failed: %s" % (row["id"], exc))
                continue

            title = info_v["title"] or row["title"]
            fmt, fmt_conf = guess_format(title, info_v["description"])
            matched, confidence, how = match_creators(
                title, info_v["description"], index, fmt)
            matched_out = matched
            unresolved_flag = not matched
            if not matched_out and channel.get("default_creators"):
                matched_out = list(channel["default_creators"])
                how, confidence, unresolved_flag = "channel-default", 0.8, False

            front = {
                "id": key,
                "type": "video",
                "platform": "youtube",
                "youtube_id": row["id"],
                "url": "https://youtu.be/" + row["id"],
                "embed_url": "https://www.youtube.com/embed/" + row["id"],
                "thumbnail_url": "https://img.youtube.com/vi/%s/hqdefault.jpg" % row["id"],
                "title": title,
                "description": info_v["description"][:1200],
                "creators": matched_out,
                "creator_source": how,
                "creator_confidence": confidence,
                "channel": slug,
                "published": info_v["published"],
                "duration_s": info_v["duration_s"] or row["duration_s"],
                "view_count": info_v["view_count"],
                "language": info_v["language"],
                "format": fmt,
                "format_source": "title-match" if fmt_conf else "unknown",
                "role": "both",
                "categories": [],
                "level": None,
                "concepts": [],
                "demoted": bool(channel.get("demote")),
                "has_transcript": False,
                "status": "published" if (channel.get("auto_publish") and not unresolved_flag)
                          else "review",
                "added": today,
                "generated": True,
            }
            note = []
            if unresolved_flag:
                note.append("Creator not resolved from the title (best %.2f, %s). Authority "
                            "is provisional until someone attributes it." % (confidence, how))
                unresolved.append((key, title[:56]))
            if fmt == "unknown":
                note.append("Format not recognised from the title.")
            body = "# %s\n\n%s\n" % (title, "\n\n".join(note) or "Ingested from YouTube.")
            write(VIDEOS, key, front, body, VIDEO_KEYS)
            existing[key] = front
            new += 1
            total_new += 1

        channel["last_sync"] = today
        channel["known_videos"] = sum(
            1 for v in existing.values() if v.get("channel") == slug)
        write(CHANNELS, slug, channel, "# %s\n\nTracked YouTube channel.\n" % channel.get("title", slug),
              CHANNEL_KEYS)
        print("  %d new" % new)

    print("\n%d new video(s) from %d listed" % (total_new, total_seen))
    if unresolved:
        print("\n%d could not be attributed to a creator - they rank as provisional, not low:"
              % len(unresolved))
        for key, title in unresolved[:15]:
            print("    %-16s %s" % (key, title))
    return 0


def cmd_transcripts(args) -> int:
    videos = read_all(VIDEOS)
    todo = [k for k, v in videos.items()
            if not v.get("has_transcript") and v.get("platform") == "youtube"]
    if args.limit:
        todo = todo[:args.limit]
    if not todo:
        print("every video already has a transcript, or none need one")
        return 0
    print("fetching captions for %d video(s)" % len(todo))
    got, missing = 0, 0
    for key in todo:
        video = videos[key]
        # A `sync --refresh` rewrites the video record and clears has_transcript, but the
        # captions themselves are still on disk. Re-downloading them would be a request to
        # YouTube for something we already have.
        cached = os.path.join(TRANSCRIPTS, video["youtube_id"] + ".json")
        if os.path.isfile(cached) and not args.force:
            import json as _json
            with open(cached, encoding="utf-8") as fh:
                record = _json.load(fh)
        else:
            record = youtube.captions(video["youtube_id"], TRANSCRIPTS)
        if record:
            video["has_transcript"] = True
            video["transcript_words"] = record["words"]
            got += 1
            print("  %-16s %5d words" % (key, record["words"]))
        else:
            video["has_transcript"] = False
            video["transcript_words"] = 0
            missing += 1
            print("  %-16s none" % key)
        write(VIDEOS, key, video, "# %s\n" % video.get("title", key), VIDEO_KEYS)
    print("\n%d with captions, %d without." % (got, missing))
    print("Dance video is mostly music and demonstration, so a thin transcript is normal")
    print("and competition footage often has none. Nothing downstream may assume one.")
    return 0


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="command", required=True)

    p = sub.add_parser("add"); p.add_argument("url"); p.add_argument("--force", action="store_true")
    p.set_defaults(func=cmd_add)

    sub.add_parser("channels").set_defaults(func=cmd_channels)

    p = sub.add_parser("sync")
    p.add_argument("slug", nargs="?")
    p.add_argument("--limit", type=int, default=0, help="only the newest N per channel")
    p.add_argument("--refresh", action="store_true", help="re-fetch videos already stored")
    p.set_defaults(func=cmd_sync)

    p = sub.add_parser("transcripts")
    p.add_argument("--limit", type=int, default=0)
    p.add_argument("--force", action="store_true", help="re-download even if cached on disk")
    p.set_defaults(func=cmd_transcripts)

    args = ap.parse_args()
    return args.func(args)


if __name__ == "__main__":
    raise SystemExit(main())
