from __future__ import annotations

import os
from typing import Optional

from fastapi import APIRouter, HTTPException

from api.config import get_music_dirs
from core.tagger import is_audio_file

router = APIRouter()


def _is_under_any(target: str, dirs: list[str]) -> bool:
    """Return True if target is equal to or under any of the given dirs."""
    for d in dirs:
        d = os.path.normpath(d)
        if target == d or target.startswith(d + os.sep):
            return True
    return False


@router.get("/tree")
def get_tree(path: Optional[str] = None):
    """Return immediate children (subdirs + audio files) of a directory."""
    music_dirs = get_music_dirs()

    if not path:
        # With a single dir, return it as the root (existing behaviour).
        # With multiple dirs, return a virtual root whose children are the top-level dirs.
        if len(music_dirs) == 1:
            target = os.path.normpath(music_dirs[0])
        else:
            dirs = [
                {"name": os.path.basename(d) or d, "path": d}
                for d in music_dirs
                if os.path.isdir(d)
            ]
            return {"path": "", "dirs": dirs, "files": []}
    else:
        target = os.path.normpath(path)
        if not _is_under_any(target, music_dirs):
            raise HTTPException(403, "Access denied")

    if not os.path.isdir(target):
        raise HTTPException(404, "Directory not found")

    dirs, files = [], []
    try:
        for entry in sorted(os.scandir(target), key=lambda e: (not e.is_dir(), e.name.lower())):
            if entry.is_dir():
                dirs.append({"name": entry.name, "path": entry.path})
            elif is_audio_file(entry.name):
                files.append({"name": entry.name, "path": entry.path})
    except PermissionError:
        raise HTTPException(403, "Permission denied")

    return {
        "path": target,
        "dirs": dirs,
        "files": files,
    }
