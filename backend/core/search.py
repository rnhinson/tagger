"""The search box: which tags it looks in (Settings → Search), and its glob and regex modes."""
import fnmatch
import re
from functools import lru_cache

MODES = ("glob", "regex")
# What can be searched; the full-text index covers only FTS_FIELDS.
SEARCHABLE = ("title", "artist", "album", "album_artist", "year", "genre", "composer", "comment",
              "lyrics", "filename")
FTS_FIELDS = ("title", "artist", "album", "album_artist", "genre")
DEFAULT_FIELDS = list(FTS_FIELDS)


def fields(chosen: list[str]) -> list[str]:
    return [f for f in SEARCHABLE if f in chosen] or DEFAULT_FIELDS


def terms(q: str) -> list[str]:
    # Quotes go, so a stray one can't break the FTS expression.
    return [t for t in q.replace('"', " ").split() if t]


@lru_cache(maxsize=64)
def compile_query(mode: str, q: str) -> list[re.Pattern]:
    """Raises re.error on a bad regex. All ignore case."""
    if mode == "words":
        return [re.compile(r"(?<!\w)" + re.escape(t), re.IGNORECASE) for t in terms(q)]
    return [re.compile(fnmatch.translate(q) if mode == "glob" else q, re.IGNORECASE)]


def q_match(mode: str, q: str, *values) -> int:
    """SQL q_match(mode, q, field, ...): a glob matches a whole field (love* = starts
    with love), a regex anywhere in one; words (plain search off the index) each
    start a word in some field."""
    vals = [str(v) for v in values if v]
    pats = compile_query(mode, q)
    if mode == "words":
        return int(bool(pats) and all(any(p.search(v) for v in vals) for p in pats))
    hit = pats[0].fullmatch if mode == "glob" else pats[0].search
    return int(any(hit(v) for v in vals))
