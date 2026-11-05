from __future__ import annotations

import json
import os
from pathlib import Path

from fastapi import APIRouter, BackgroundTasks, HTTPException
from pydantic import BaseModel

from core.config import settings
from core.tagger import TAG_FIELDS

router = APIRouter()

ALL_SCAN_TAGS = TAG_FIELDS


class AppSettings(BaseModel):
    rename_on_save: bool = False
    rename_template: str = "{album_artist}/{album}/{track_number:02d} {title}"
    acoustid_api_key: str = ""
    discogs_token: str = ""
    scan_tags: list[str] = ALL_SCAN_TAGS
    music_dirs: list[str] = []
    scan_exclude: list[str] = []       # glob patterns; matching paths are skipped
    auto_scan_minutes: int = 0         # 0 = off; else rescan every N minutes
    # Edits are held for review and written by "Write changes" (api/staged.py).
    stage_changes: bool = True
    # Folders rename templates are relative to (globs allowed). Empty = the
    # TAGGER_LIBRARY_ROOTS env var, else the music directories.
    library_roots: list[str] = []
    # Library roots switched off: not scanned, their tracks not in the DB.
    inactive_libraries: list[str] = []
    # Library root -> the layout its files should follow (core/layout.py).
    library_templates: dict[str, str] = {}


def get_music_dirs() -> list[str]:
    """Returns all effective music directories: env-var default + user-configured extras."""
    default = str(settings.music_dir)
    extras = _load().music_dirs
    seen: set[str] = {default}
    dirs = [default]
    for d in extras:
        if d not in seen:
            seen.add(d)
            dirs.append(d)
    return dirs


def get_scan_dirs() -> list[str]:
    """
    What a full scan walks. With library roots configured: the active roots
    only -- so a read-only reference mount beside them (e.g. the pre-tidy
    original) isn't scanned and can't be edited by accident. Without roots:
    the music directories, as before.
    """
    s = _load()
    if not (s.library_roots or settings.library_roots):
        return get_music_dirs()
    off = {os.path.normpath(p) for p in s.inactive_libraries}
    return [str(r) for r in get_library_roots() if str(r) not in off]


def get_library_root_patterns() -> list[str]:
    return _load().library_roots or settings.library_roots or get_music_dirs()


def get_library_roots():
    from core.fileops import expand_roots
    return expand_roots(get_library_root_patterns())


def _load() -> AppSettings:
    f = settings.settings_file
    if f.exists():
        try:
            return AppSettings(**json.loads(f.read_text()))
        except Exception:
            pass
    return AppSettings()


def _save(s: AppSettings) -> None:
    settings.config_dir.mkdir(parents=True, exist_ok=True)
    settings.settings_file.write_text(s.model_dump_json(indent=2))


@router.get("")
def get_settings():
    s = _load()
    return {
        **s.model_dump(),
        "default_music_dir": str(settings.music_dir),
        "env_library_roots": settings.library_roots,
        "effective_library_roots": [str(r) for r in get_library_roots()],
    }


@router.get("/libraries")
def list_libraries():
    """Every library root: on/off, writable, tracks in the DB."""
    from core.database import db
    s = _load()
    off = {os.path.normpath(p) for p in s.inactive_libraries}
    out = []
    with db() as conn:
        for r in get_library_roots():
            p = str(r)
            n = conn.execute(
                "SELECT COUNT(*) FROM tracks WHERE directory = ? OR substr(directory, 1, ?) = ?",
                (p, len(p) + 1, p + "/"),
            ).fetchone()[0]
            out.append({"path": p, "name": r.name, "parent": str(r.parent), "active": p not in off,
                        "writable": os.access(p, os.W_OK), "tracks": n,
                        "template": s.library_templates.get(p, "")})
    return out


class LibraryToggle(BaseModel):
    path: str
    active: bool


@router.post("/libraries")
def toggle_library(req: LibraryToggle, background_tasks: BackgroundTasks):
    """
    Switch a library off (its tracks leave the DB now, staged changes with
    them) or back on (a scan of just that library starts).
    """
    from core.database import db
    from core.tasks import active_scan, create_scan_job, run_scan_job
    path = os.path.normpath(req.path)
    if path not in {str(r) for r in get_library_roots()}:
        raise HTTPException(400, "not a library root")
    s = _load()
    off = [p for p in s.inactive_libraries if os.path.normpath(p) != path]
    if not req.active:
        off.append(path)
    _save(s.model_copy(update={"inactive_libraries": off}))
    if not req.active:
        with db() as conn:
            n = conn.execute(
                "DELETE FROM tracks WHERE directory = ? OR substr(directory, 1, ?) = ?",
                (path, len(path) + 1, path + "/"),
            ).rowcount
        return {"active": False, "removed": n}
    if active_scan():
        return {"active": True, "job_id": None}   # the running scan won't include it; next one will
    job_id = create_scan_job(path)
    background_tasks.add_task(run_scan_job, job_id, path)
    return {"active": True, "job_id": job_id}


@router.patch("")
def update_settings(update: AppSettings):
    from core.naming import render_template
    sent = update.model_dump(exclude_unset=True)
    if "library_templates" in sent:
        layouts = {os.path.normpath(k): v.strip() for k, v in sent["library_templates"].items() if v.strip()}
        for root, template in layouts.items():
            try:
                render_template(template, _SAMPLE_TRACK, ".flac")
            except (KeyError, ValueError, IndexError) as exc:
                raise HTTPException(400, f"Layout for {Path(root).name}: invalid template ({exc})")
        sent["library_templates"] = layouts
    merged = _load().model_copy(update=sent)
    _save(merged)
    return get_settings()


_SAMPLE_TRACK = {
    "title": "So What",
    "artist": "Miles Davis",
    "album": "Kind of Blue",
    "album_artist": "Miles Davis",
    "year": "1959",
    "genre": "Jazz",
    "track_number": "1",
    "disc_number": "1",
}


class RenamePreviewRequest(BaseModel):
    template: str
    tags: dict | None = None
    ext: str = ".flac"
    # With a track: the full destination under that track's library root.
    track_id: int | None = None


@router.post("/rename-preview")
def rename_preview(req: RenamePreviewRequest):
    """
    Render a rename template for live UI feedback — against a sample track by
    default, or a specific track's tags/extension when provided (editor preview).
    """
    from core.naming import render_template

    if req.track_id is not None:
        from core import staging
        from core.database import db

        with db() as conn:
            row = conn.execute("SELECT * FROM tracks WHERE id = ?", (req.track_id,)).fetchone()
        if not row:
            return {"ok": False, "error": "Track not found"}
        try:
            dest = staging.plan_path(row, {**dict(row), **(req.tags or {})},
                                     req.template, get_library_roots())
        except staging.PlanError as exc:
            return {"ok": False, "error": str(exc)}
        try:
            shown = str(Path(dest).relative_to(settings.music_dir))
        except ValueError:
            shown = dest
        return {"ok": True, "preview": shown, "path": dest}

    fields = req.tags or _SAMPLE_TRACK
    ext = req.ext or ".flac"
    try:
        rel = render_template(req.template, fields, ext)
    except (KeyError, ValueError, IndexError) as exc:
        return {"ok": False, "error": f"Invalid template: {exc}"}
    return {"ok": True, "preview": rel}
