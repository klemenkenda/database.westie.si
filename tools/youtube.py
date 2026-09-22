"""YouTube metadata, via yt-dlp.

Why not the Data API: it needs a key, and resolving a channel by hand hits Google's EU
consent wall from here. yt-dlp needs neither and gives richer metadata. The cost is a
dependency that tracks YouTube's changes and must be kept updated — an API backend can
slot in behind the same two functions if that ever stops being a good trade.

**Metadata only.** Nothing here downloads a video. We are building an index that points at
other people's material on the platform they published it to, and embeds it there.

Two phases, because they have very different costs:

    discover()  one request for a whole channel, ~15 fields per video. Cheap, so it runs
                on every sync to find what is new.
    detail()    one request per video for description, date and captions. Runs once, only
                for videos we have not seen before.
"""
from __future__ import annotations

import datetime as _dt
import json
import subprocess
from typing import Any, Iterator

YT_DLP = "yt-dlp"
TIMEOUT = 300


class YoutubeError(RuntimeError):
    pass


def _run(args: list[str], timeout: int = TIMEOUT) -> Iterator[dict[str, Any]]:
    try:
        proc = subprocess.run(
            [YT_DLP, *args],
            capture_output=True, text=True, timeout=timeout, encoding="utf-8", errors="replace",
        )
    except FileNotFoundError:
        raise YoutubeError("yt-dlp is not installed (pip install yt-dlp)")
    except subprocess.TimeoutExpired:
        raise YoutubeError("yt-dlp timed out after %ds" % timeout)
    if proc.returncode != 0 and not proc.stdout.strip():
        raise YoutubeError((proc.stderr or "yt-dlp failed").strip().split("\n")[-1])
    for line in proc.stdout.splitlines():
        line = line.strip()
        if line.startswith("{"):
            try:
                yield json.loads(line)
            except json.JSONDecodeError:
                continue


def is_playlist(url: str) -> bool:
    return "list=" in url or "/playlist" in url


def playlist_url(url: str) -> str:
    """A watch-url carrying a list= is a video *inside* a playlist; we want the playlist.

    Fetching it as given would ingest one video and silently ignore the other forty.
    """
    import re as _re
    match = _re.search(r"[?&]list=([A-Za-z0-9_-]+)", url)
    if match:
        return "https://www.youtube.com/playlist?list=" + match.group(1)
    return url


def discover(source_url: str, limit: int = 0) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    """Videos in a channel or a playlist, flat. Returns (source info, rows in order).

    A playlist keeps its own order, which for a course is the teaching order and is worth
    preserving; a channel is newest first.
    """
    args = ["--flat-playlist", "--dump-json", "--ignore-errors"]
    if limit:
        args += ["--playlist-end", str(limit)]
    if is_playlist(source_url):
        args.append(playlist_url(source_url))
    else:
        args.append(source_url.rstrip("/") + ("" if "/videos" in source_url else "/videos"))

    rows, channel = [], {}
    for row in _run(args):
        if not row.get("id"):
            continue
        if not channel:
            channel = {
                "channel_id": row.get("playlist_channel_id"),
                "playlist_id": row.get("playlist_id"),
                "title": row.get("playlist_title") or row.get("playlist_channel"),
                "channel_title": row.get("playlist_channel"),
                "handle": row.get("playlist_uploader_id"),
                "kind": "playlist" if is_playlist(source_url) else "channel",
            }
        rows.append({
            "position": row.get("playlist_index"),
            "id": row["id"],
            "title": (row.get("title") or "").strip(),
            "duration_s": int(row["duration"]) if row.get("duration") else None,
            "view_count": row.get("view_count"),
            "thumbnail": _best_thumb(row.get("thumbnails") or []),
        })
    if not rows:
        raise YoutubeError("no videos found at %s" % source_url)
    return channel, rows


def detail(video_id: str) -> dict[str, Any]:
    """Description, publication date and caption availability for one video."""
    rows = list(_run(
        ["--dump-json", "--skip-download", "--no-playlist",
         "https://www.youtube.com/watch?v=" + video_id],
        timeout=120,
    ))
    if not rows:
        raise YoutubeError("no metadata for %s" % video_id)
    row = rows[0]
    return {
        "id": row.get("id", video_id),
        "title": (row.get("title") or "").strip(),
        "description": (row.get("description") or "").strip(),
        "published": _date(row),
        "duration_s": int(row["duration"]) if row.get("duration") else None,
        "channel_id": row.get("channel_id"),
        "channel": row.get("channel") or row.get("uploader"),
        "tags": [t for t in (row.get("tags") or []) if isinstance(t, str)][:20],
        "language": row.get("language") or None,
        # Automatic captions are what make a transcript search possible later.
        "has_captions": bool(row.get("subtitles") or row.get("automatic_captions")),
        "view_count": row.get("view_count"),
        "thumbnail": row.get("thumbnail") or _best_thumb(row.get("thumbnails") or []),
    }


def captions(video_id: str, out_dir: str) -> dict[str, Any] | None:
    """Timestamped automatic captions for one video, normalised.

    The timestamps are the point. A transcript alone tells us a video mentions the anchor
    step; a transcript with timestamps lets the page link to the forty seconds where it is
    actually explained, which is the thing YouTube's own search cannot do.

    A caveat that shapes how much these are worth: West Coast Swing video is mostly music
    and demonstration. A four-minute clip can carry four hundred words, and competition
    footage carries almost none. Transcripts are a strong signal when present and simply
    absent otherwise, so nothing downstream may assume one exists.
    """
    import glob
    import os
    import tempfile

    os.makedirs(out_dir, exist_ok=True)
    with tempfile.TemporaryDirectory() as tmp:
        template = os.path.join(tmp, "c.%(ext)s")
        try:
            subprocess.run(
                [YT_DLP, "--skip-download", "--write-auto-subs", "--write-subs",
                 "--sub-langs", "en.*", "--sub-format", "json3", "--no-warnings",
                 "-o", template, "https://www.youtube.com/watch?v=" + video_id],
                capture_output=True, text=True, timeout=180,
            )
        except (FileNotFoundError, subprocess.TimeoutExpired):
            return None

        # Prefer the manual track over the auto one: "en" before "en-orig".
        files = sorted(glob.glob(os.path.join(tmp, "*.json3")))
        if not files:
            return None
        chosen = next((f for f in files if ".en.json3" in f), files[0])
        try:
            with open(chosen, encoding="utf-8") as fh:
                raw = json.load(fh)
        except (OSError, json.JSONDecodeError):
            return None

    segments = []
    for event in raw.get("events") or []:
        if not event.get("segs"):
            continue
        text = "".join(s.get("utf8", "") for s in event["segs"]).strip()
        text = " ".join(text.split())
        if text and text not in ("[music]", "[Music]", "[Applause]"):
            segments.append({"t": int(event.get("tStartMs", 0)) // 1000, "text": text})

    if not segments:
        return None
    record = {
        "id": video_id,
        "fetched": _dt.date.today().isoformat(),
        "segments": segments,
        "words": sum(len(s["text"].split()) for s in segments),
    }
    import os as _os
    with open(_os.path.join(out_dir, video_id + ".json"), "w", encoding="utf-8", newline="\n") as fh:
        json.dump(record, fh, ensure_ascii=False)
    return record


def _date(row: dict[str, Any]) -> str | None:
    stamp = row.get("timestamp")
    if stamp:
        return _dt.datetime.utcfromtimestamp(int(stamp)).date().isoformat()
    raw = row.get("upload_date") or row.get("release_date")
    if raw and len(str(raw)) == 8:
        raw = str(raw)
        return "%s-%s-%s" % (raw[:4], raw[4:6], raw[6:])
    return None


def _best_thumb(thumbs: list[dict[str, Any]]) -> str | None:
    best, area = None, -1
    for t in thumbs:
        if not t.get("url"):
            continue
        size = int(t.get("width") or 0) * int(t.get("height") or 0)
        if size > area:
            best, area = t["url"], size
    # The canonical hqdefault url is stable and short; prefer it over a signed CDN link
    # that expires and would leave the page with a broken image in a month.
    return best
