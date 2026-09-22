"""Frontmatter I/O that agrees byte-for-byte with public/api/lib/Yaml.php.

The API writes Markdown and so do these tools. If the two disagree about quoting or
indentation, every file touched by one shows up as a spurious diff to the other, and
`git status` stops being a useful signal about what actually changed.

So this is deliberately a mirror of the PHP dumper rather than a general YAML writer:
same quoting rule (every string quoted), same inline form for scalar lists, same two-space
block form for lists of mappings. `tools/api_test.php` asserts the two agree.

Reading is more forgiving than writing — PyYAML handles the subset the PHP parser accepts,
and a hand-edited file that strays outside it should degrade rather than explode.
"""
from __future__ import annotations

import io
import os
import re
import time
from typing import Any

import yaml

_FRONT = re.compile(r"^---\r?\n(.*?)\r?\n---[ \t]*\r?\n?", re.S)


# --------------------------------------------------------------------------- reading

def split_document(raw: str) -> tuple[dict, str]:
    """Split "---\\nfrontmatter\\n---\\nbody" into (dict, body)."""
    raw = raw.lstrip("\ufeff").replace("\r\n", "\n")
    m = _FRONT.match(raw)
    if not m:
        return {}, raw
    try:
        front = yaml.safe_load(m.group(1)) or {}
    except yaml.YAMLError:
        front = {}
    if not isinstance(front, dict):
        front = {}
    return front, raw[m.end():].lstrip("\n")


def read(path: str) -> tuple[dict, str]:
    with io.open(path, encoding="utf-8") as fh:
        return split_document(fh.read())


# --------------------------------------------------------------------------- writing

def dump_scalar(value: Any) -> str:
    """Exactly Yaml::dumpScalar — note that newlines in a string collapse to a space."""
    if value is None:
        return "null"
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, (int, float)):
        return str(value)
    text = str(value).replace("\\", "\\\\").replace('"', '\\"').replace("\n", " ")
    return '"%s"' % text


def _is_scalar_list(value: list) -> bool:
    return all(not isinstance(item, (list, dict)) for item in value)


def dump(data: dict, indent: int = 0) -> str:
    """Exactly Yaml::dump."""
    pad = " " * indent
    out = []
    for key, value in data.items():
        if isinstance(value, dict):
            out.append("%s%s:\n" % (pad, key))
            out.append(dump(value, indent + 2))
            continue
        if isinstance(value, list):
            if not value:
                out.append("%s%s: []\n" % (pad, key))
            elif _is_scalar_list(value):
                out.append("%s%s: [%s]\n" % (pad, key, ", ".join(dump_scalar(v) for v in value)))
            else:
                out.append("%s%s:\n" % (pad, key))
                for item in value:
                    if isinstance(item, dict):
                        rendered = dump(item, indent + 4)
                        out.append(pad + "  - " + rendered[indent + 4:].lstrip(" "))
                    else:
                        out.append(pad + "  - " + dump_scalar(item) + "\n")
            continue
        out.append("%s%s: %s\n" % (pad, key, dump_scalar(value)))
    return "".join(out)


def document(front: dict, body: str) -> str:
    return "---\n" + dump(front) + "---\n\n" + body.lstrip("\n")


def write(path: str, front: dict, body: str, attempts: int = 5) -> None:
    """Write with LF endings regardless of platform — these files are committed.

    Written to a temporary file and moved into place, then retried on a transient OS
    error. On Windows a virus scanner or the search indexer can hold a file it has just
    seen change, and `open(path, "w")` then fails with EINVAL or EACCES for a few hundred
    milliseconds. A caption run that rewrites hundreds of records hits that eventually,
    and the bare open cost a 336-video pass after 26 of them. os.replace is atomic, so a
    failure here can no longer leave a half-written record either.
    """
    text = document(front, body)
    tmp = path + ".tmp"
    for attempt in range(attempts):
        try:
            with io.open(tmp, "w", encoding="utf-8", newline="\n") as fh:
                fh.write(text)
            os.replace(tmp, path)
            return
        except OSError:
            try:
                if os.path.exists(tmp):
                    os.remove(tmp)
            except OSError:
                pass
            if attempt == attempts - 1:
                raise
            time.sleep(0.2 * (attempt + 1))
