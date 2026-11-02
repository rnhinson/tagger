"""
Bulk file rename in the style of Windows PowerRename.

Search is plain text or a regex (Python `re`). The replacement is a template:
  $1 / ${1} / ${name}   capture groups (regex mode)   $0  the whole match
  $$                    a literal $
  ${} ${start=10} ${increment=5} ${padding=3}  (combinable: ${start=1,padding=2})
                        a counter, numbered in list order
Without regex the replacement is literal text (counters still work).
Formatting (lower/upper/title/capitalize) applies to the renamed part.
"""
from __future__ import annotations

import os
import re
from dataclasses import dataclass, field
from pathlib import Path

SMALL_WORDS = {"a", "an", "the", "and", "but", "or", "for", "nor", "on", "at",
               "to", "by", "in", "of", "up", "with", "from"}
_COUNTER_KEYS = {"start", "increment", "padding"}


class RenameError(ValueError):
    pass


@dataclass
class Options:
    find: str = ""
    replace: str = ""
    regex: bool = False
    case_sensitive: bool = False
    match_all: bool = True
    apply_to: str = "name"        # name | ext | both
    transform: str = "none"       # none | lower | upper | title | capitalize


@dataclass
class _Counter:
    start: int = 1
    increment: int = 1
    padding: int = 0

    def value(self, i: int) -> str:
        return str(self.start + i * self.increment).zfill(self.padding)


@dataclass
class Template:
    # each part: ("lit", text) | ("group", int|str) | ("counter", _Counter)
    parts: list = field(default_factory=list)

    @property
    def counters(self) -> bool:
        return any(k == "counter" for k, _ in self.parts)


def _parse_counter(body: str) -> _Counter | None:
    """'' or 'start=1,padding=2' -> counter; anything else is a group name."""
    if body.strip() == "":
        return _Counter()
    c = _Counter()
    for item in body.split(","):
        if "=" not in item:
            return None
        k, v = (x.strip() for x in item.split("=", 1))
        if k not in _COUNTER_KEYS:
            return None
        try:
            setattr(c, k, int(v))
        except ValueError:
            raise RenameError(f"counter {k} must be a number")
    return c


def parse_template(text: str, regex: bool) -> Template:
    parts: list = []
    lit: list[str] = []

    def flush():
        if lit:
            parts.append(("lit", "".join(lit)))
            lit.clear()

    i = 0
    while i < len(text):
        ch = text[i]
        if ch != "$" or i + 1 >= len(text):
            lit.append(ch)
            i += 1
            continue
        nxt = text[i + 1]
        if nxt == "$":
            lit.append("$")
            i += 2
        elif nxt == "{":
            end = text.find("}", i + 2)
            if end == -1:
                raise RenameError("unclosed ${")
            body = text[i + 2:end]
            counter = _parse_counter(body)
            if counter is not None:
                flush()
                parts.append(("counter", counter))
            elif regex:
                flush()
                parts.append(("group", int(body) if body.isdigit() else body))
            else:
                lit.append(text[i:end + 1])
            i = end + 1
        elif nxt.isdigit() and regex:
            j = i + 1
            while j < len(text) and text[j].isdigit():
                j += 1
            flush()
            parts.append(("group", int(text[i + 1:j])))
            i = j
        else:
            lit.append(ch)
            i += 1
    flush()
    return Template(parts)


def compile_search(opts: Options) -> re.Pattern | None:
    if not opts.find:
        return None
    flags = 0 if opts.case_sensitive else re.IGNORECASE
    try:
        return re.compile(opts.find if opts.regex else re.escape(opts.find), flags)
    except re.error as exc:
        raise RenameError(f"bad regular expression: {exc}")


def _title(s: str) -> str:
    words = re.split(r"(\s+)", s.lower())
    out, first = [], True
    for w in words:
        if not w.strip():
            out.append(w)
            continue
        out.append(w if (not first and w in SMALL_WORDS) else w[:1].upper() + w[1:])
        first = False
    return "".join(out)


def _transform(s: str, how: str) -> str:
    if how == "lower":
        return s.lower()
    if how == "upper":
        return s.upper()
    if how == "title":
        return _title(s)
    if how == "capitalize":
        return re.sub(r"\S+", lambda m: m.group(0)[:1].upper() + m.group(0)[1:].lower(), s)
    return s


def rename_one(name: str, opts: Options, pattern: re.Pattern | None, tpl: Template, index: int) -> str:
    """The new file name for `name` (index = position, for counters)."""
    p = Path(name)
    stem, ext = (p.stem, p.suffix[1:]) if p.suffix else (name, "")
    target = {"name": stem, "ext": ext, "both": name}[opts.apply_to]

    if pattern is not None:
        def expand(m: re.Match) -> str:
            out = []
            for kind, val in tpl.parts:
                if kind == "lit":
                    out.append(val)
                elif kind == "counter":
                    out.append(val.value(index))
                else:
                    try:
                        out.append(m.group(val) or "")
                    except IndexError:
                        raise RenameError(f"no capture group {val!r} in the search")
            return "".join(out)

        target = pattern.sub(expand, target, count=0 if opts.match_all else 1)
    target = _transform(target, opts.transform)

    if opts.apply_to == "name":
        return target + (f".{ext}" if ext else "")
    if opts.apply_to == "ext":
        return stem + (f".{target}" if target else "")
    return target


def check_name(new: str) -> str | None:
    """Why a file name can't be used, or None."""
    if not new or new in (".", ".."):
        return "empty name"
    if "/" in new or "\x00" in new:
        return "name contains '/'"
    if new.startswith("."):
        return "name would be hidden (starts with '.')"
    if len(os.fsencode(new)) > 255:
        return "name too long"
    return None
