from __future__ import annotations

import json
from typing import Optional

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
    scan_tags: list[str] = ALL_SCAN_TAGS
    music_dirs: list[str] = []


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
    return {**s.model_dump(), "default_music_dir": str(settings.music_dir)}


@router.patch("")
def update_settings(update: AppSettings):
    merged = _load().model_copy(update=update.model_dump(exclude_none=True))
    _save(merged)
    return merged
