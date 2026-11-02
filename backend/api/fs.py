from __future__ import annotations

import os
from typing import Optional

from fastapi import APIRouter, HTTPException

from pydantic import BaseModel

from api.config import _load as load_settings, get_music_dirs
from core import staging
from core.database import db
from core.naming import _safe
from core.tagger import is_audio_file

router = APIRouter()


def _is_under_any(target: str, dirs: list[str]) -> bool:
    """
    True if target is equal to or under any of the given dirs. Compares fully
    resolved (realpath) paths so a symlink inside a music dir can't be used to
    escape it, while still allowing a music dir that is itself a symlink.
    """
    rt = os.path.realpath(target)
    for d in dirs:
        rd = os.path.realpath(d)
        if rt == rd or rt.startswith(rd + os.sep):
            return True
    return False


def _has_subdirs(path: str) -> bool:
    """Whether a folder has subfolders -- the tree shows an arrow only then."""
    try:
        with os.scandir(path) as it:
            return any(e.is_dir() for e in it)
    except OSError:
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
                dirs.append({"name": entry.name, "path": entry.path,
                             "has_dirs": _has_subdirs(entry.path)})
            elif is_audio_file(entry.name):
                files.append({"name": entry.name, "path": entry.path})
    except PermissionError:
        raise HTTPException(403, "Permission denied")

    return {
        "path": target,
        "dirs": dirs,
        "files": files,
    }


class FolderMove(BaseModel):
    src: str
    dst: str


class FolderRename(BaseModel):
    path: str
    name: str


def _stage_folder(src: str, dst: str, summary: str) -> dict:
    if not _is_under_any(src, get_music_dirs()):
        raise HTTPException(403, "Access denied")
    with db() as conn:
        step = staging.Step(conn, summary)
        try:
            staging.stage_dir(conn, src, dst, step)
        except staging.PlanError as exc:
            raise HTTPException(400, str(exc))
        step.save()
        if load_settings().stage_changes:
            return {"staged": True}
        res = staging.apply(conn, ids=[], dirs=[os.path.normpath(src)], summary=summary)
        return {"staged": False, "applied": res["folders"], "errors": res["errors"]}


@router.post("/move")
def move_folder(req: FolderMove):
    """Stage moving a folder (with everything in it) to dst."""
    return _stage_folder(req.src, req.dst,
                         f"Move folder {os.path.basename(req.src)} → {os.path.dirname(req.dst)}")


@router.post("/rename")
def rename_folder(req: FolderRename):
    """Stage renaming a folder in place."""
    name = _safe(req.name.strip())
    src = os.path.normpath(req.path)
    dst = os.path.join(os.path.dirname(src), name)
    return _stage_folder(src, dst, f"Rename folder {os.path.basename(src)} → {name}")
