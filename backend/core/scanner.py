"""
Library scanner — walks the music directory and keeps the SQLite DB in sync.

Strategy:
  - Collect all audio file paths upfront (enables progress reporting).
  - Compare each file's mtime against the DB; skip unchanged files.
  - Upsert changed/new tracks; delete DB rows for missing files.
  - Commits in batches to balance memory vs. write frequency.
"""
from __future__ import annotations

import os
import time
from pathlib import Path
from typing import Callable

from core.config import settings
from core.database import get_conn
from core.tagger import read_tags, is_audio_file

_BATCH_SIZE = 200


def scan_library(
    progress_cb: Callable[[int, int], None] | None = None,
    scan_tags: list[str] | None = None,
    music_dirs: list[str] | None = None,
) -> tuple[int, int]:
    """
    Scan the music directories and upsert changed/new tracks into the DB.
    Returns (total_found, upserted).
    """
    if music_dirs is None:
        music_dirs = [str(settings.music_dir)]

    # Collect all audio files first so we know the total
    all_files: list[str] = []
    for music_dir in music_dirs:
        if not os.path.isdir(music_dir):
            continue
        for root, _, files in os.walk(music_dir):
            for fname in sorted(files):
                fpath = os.path.join(root, fname)
                if is_audio_file(fpath):
                    all_files.append(fpath)

    total = len(all_files)
    upserted = 0
    now = time.time()

    conn = get_conn()
    try:
        # Load existing mtimes for fast change detection
        existing: dict[str, float] = {
            row[0]: row[1]
            for row in conn.execute("SELECT path, mtime FROM tracks")
        }

        for i, fpath in enumerate(all_files):
            try:
                stat = os.stat(fpath)
                mtime = stat.st_mtime

                if existing.get(fpath) != mtime:
                    tags = read_tags(fpath)
                    if scan_tags is not None:
                        for tag in ("title", "artist", "album", "album_artist", "year", "genre", "track_number", "disc_number", "comment"):
                            if tag not in scan_tags:
                                tags.pop(tag, None)
                    p = Path(fpath)
                    conn.execute(
                        """
                        INSERT INTO tracks (
                            path, filename, directory, format, size, mtime, duration,
                            title, artist, album, album_artist, year, genre,
                            track_number, disc_number, comment, scanned_at
                        ) VALUES (
                            :path, :filename, :directory, :format, :size, :mtime, :duration,
                            :title, :artist, :album, :album_artist, :year, :genre,
                            :track_number, :disc_number, :comment, :scanned_at
                        )
                        ON CONFLICT(path) DO UPDATE SET
                            filename     = excluded.filename,
                            directory    = excluded.directory,
                            format       = excluded.format,
                            size         = excluded.size,
                            mtime        = excluded.mtime,
                            duration     = excluded.duration,
                            title        = excluded.title,
                            artist       = excluded.artist,
                            album        = excluded.album,
                            album_artist = excluded.album_artist,
                            year         = excluded.year,
                            genre        = excluded.genre,
                            track_number = excluded.track_number,
                            disc_number  = excluded.disc_number,
                            comment      = excluded.comment,
                            scanned_at   = excluded.scanned_at
                        """,
                        {
                            "path": fpath,
                            "filename": p.name,
                            "directory": str(p.parent),
                            "format": tags.get("format", "unknown"),
                            "size": stat.st_size,
                            "mtime": mtime,
                            "duration": tags.get("duration"),
                            "title": tags.get("title"),
                            "artist": tags.get("artist"),
                            "album": tags.get("album"),
                            "album_artist": tags.get("album_artist"),
                            "year": tags.get("year"),
                            "genre": tags.get("genre"),
                            "track_number": tags.get("track_number"),
                            "disc_number": tags.get("disc_number"),
                            "comment": tags.get("comment"),
                            "scanned_at": now,
                        },
                    )
                    upserted += 1

            except Exception:
                pass  # skip unreadable / permission-denied files

            # Commit in batches and report progress
            if (i + 1) % _BATCH_SIZE == 0:
                conn.commit()
                if progress_cb:
                    progress_cb(i + 1, total)

        conn.commit()

        # Remove DB rows for files that no longer exist on disk
        scanned = set(all_files)
        for db_path in list(existing):
            if db_path not in scanned:
                conn.execute("DELETE FROM tracks WHERE path = ?", (db_path,))
        conn.commit()

    finally:
        conn.close()

    if progress_cb:
        progress_cb(total, total)

    return total, upserted
