from __future__ import annotations

import json
from pathlib import Path

from fastapi import APIRouter
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


@router.patch("")
def update_settings(update: AppSettings):
    merged = _load().model_copy(update=update.model_dump(exclude_unset=True))
    _save(merged)
    return merged


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
