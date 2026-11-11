"""The search box's glob and regex modes (plain search is FTS word prefixes)."""
import fnmatch
import re
from functools import lru_cache

MODES = ("glob", "regex")
# Plain search's fields, plus the file name.
FIELDS = ("title", "artist", "album", "album_artist", "genre", "filename")


@lru_cache(maxsize=64)
def compile_query(mode: str, q: str) -> re.Pattern:
    """Raises re.error on a bad regex. Both ignore case."""
    return re.compile(fnmatch.translate(q) if mode == "glob" else q, re.IGNORECASE)


def q_match(mode: str, q: str, *values) -> int:
    """SQL q_match(mode, q, field, ...): a glob matches a whole field (love* = starts
    with love), a regex anywhere in one."""
    rx = compile_query(mode, q)
    hit = rx.fullmatch if mode == "glob" else rx.search
    return int(any(v and hit(str(v)) for v in values))
