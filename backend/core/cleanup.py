"""
Standardize the separator in multi-value tags: "Folk/Celtic", "Folk, Celtic"
or "Ann & Bob" -> "Folk; Celtic" (core/multivalue.py's form). Players only
agree on ';'.

Which separators apply is the user's call per field -- a comma or '&' is
often part of a name ("Earth, Wind & Fire") -- and single values can be
kept as they are ("AC/DC"). '&' and '+' only count with spaces around them,
so "R&B" never splits.
"""
from __future__ import annotations

import re

from core.multivalue import join_values, split_values

SEPARATORS: dict[str, str] = {
    "/": r"/",
    "\\": r"\\",
    "|": r"\|",
    ",": r",",
    "&": r"\s+&\s+",
    "+": r"\s+\+\s+",
}


def _pattern(seps: list[str]) -> re.Pattern | None:
    alts = [SEPARATORS[s] for s in seps if s in SEPARATORS]
    return re.compile("|".join(alts)) if alts else None


def standardize(value: str | None, seps: list[str], keep: set[str] = frozenset()) -> str:
    """Split each ';'-value on the chosen separators, unless it is in `keep`."""
    pat = _pattern(seps)
    keep_cf = {k.casefold() for k in keep}
    out: list[str] = []
    for part in split_values(value):
        if pat is None or part.casefold() in keep_cf:
            out.append(part)
        else:
            out.extend(pat.split(part))
    return join_values(split_values(";".join(out)))


def found_separators(values: dict[str, int]) -> list[dict]:
    """For {value: tracks}: per separator, the ';'-values that contain it."""
    found: dict[str, dict[str, int]] = {s: {} for s in SEPARATORS}
    for value, n in values.items():
        for part in split_values(value):
            for s in SEPARATORS:
                if _pattern([s]).search(part):
                    found[s][part] = found[s].get(part, 0) + n
    return [
        {"sep": s, "tracks": sum(v.values()),
         "values": [{"value": k, "tracks": n} for k, n in sorted(v.items(), key=lambda kv: (-kv[1], kv[0].casefold()))]}
        for s, v in found.items() if v
    ]
