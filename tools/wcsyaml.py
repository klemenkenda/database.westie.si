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
import re
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


def write(path: str, front: dict, body: str) -> None:
    """Write with LF endings regardless of platform — these files are committed."""
    with io.open(path, "w", encoding="utf-8", newline="\n") as fh:
        fh.write(document(front, body))
