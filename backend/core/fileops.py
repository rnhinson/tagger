"""
Safe file moves and library roots.

Every move in the app (organize, rename-on-save, undo) goes through move_file:
it never overwrites, works across filesystems (shutil.move falls back to
copy + delete where os.rename fails with EXDEV), and handles case-only renames
on case-insensitive shares (SMB), where the destination "exists" because it is
the source.

Library roots are the folders a rename template is relative to. A track is
filed under the deepest root that contains it, so organizing never lifts a
file out of its library -- e.g. with roots `/music/Shared` and
`/music/Libraries/*`, a track in `/music/Libraries/Music - Christmas/...`
stays under that library.
"""
from __future__ import annotations

import glob
import os
import shutil
import uuid
from pathlib import Path


class MoveError(Exception):
    pass


def _same_file(a: Path, b: Path) -> bool:
    try:
        return os.path.samefile(a, b)
    except OSError:
        return False


def move_file(src: str | Path, dst: str | Path) -> None:
    """Move src to dst. Raises MoveError instead of overwriting anything."""
    src, dst = Path(src), Path(dst)
    if not src.exists():
        raise MoveError(f"source missing: {src}")
    if dst.exists():
        if not _same_file(src, dst):
            raise MoveError(f"destination already exists: {dst}")
        # Case-only rename on a case-insensitive filesystem: hop via a temp
        # name in the same directory, or the rename is a no-op.
        tmp = src.with_name(f".tagger-{uuid.uuid4().hex}{src.suffix}")
        os.rename(src, tmp)
        os.rename(tmp, dst)
        return
    dst.parent.mkdir(parents=True, exist_ok=True)
    shutil.move(str(src), str(dst))


def prune_empty_dirs(start: str | Path, stop: str | Path) -> None:
    """Remove start and its empty ancestors, never stop itself or above it."""
    d, stop = Path(start), Path(stop)
    while d != stop and stop in d.parents:
        try:
            d.rmdir()  # only succeeds when empty
        except OSError:
            return
        d = d.parent


def _device(path: Path) -> int | None:
    """st_dev of path, or of its nearest existing ancestor."""
    for p in (path, *path.parents):
        try:
            return p.stat().st_dev
        except OSError:
            continue
    return None


def same_filesystem(src: str | Path, dst: str | Path) -> bool:
    """
    True when dst would land on the same filesystem as src. A different one
    usually means the destination is outside every mount -- e.g. in the
    container's own disk, which is wiped on restart.
    """
    a, b = _device(Path(src)), _device(Path(dst))
    return a is not None and a == b


def expand_roots(patterns: list[str]) -> list[Path]:
    """Expand root patterns (globs allowed) into existing directories."""
    roots: list[Path] = []
    for pat in patterns:
        matches = glob.glob(pat) if glob.has_magic(pat) else [pat]
        for m in sorted(matches):
            p = Path(os.path.normpath(m))
            if p.is_dir() and p not in roots:
                roots.append(p)
    return roots


def root_for(path: str | Path, roots: list[Path]) -> Path | None:
    """The deepest root containing path, or None."""
    p = Path(os.path.normpath(path))
    best = None
    for r in roots:
        if r == p or r in p.parents:
            if best is None or len(r.parts) > len(best.parts):
                best = r
    return best
