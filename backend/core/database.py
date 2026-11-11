import sqlite3
from contextlib import contextmanager
from typing import Generator

from core.config import settings
from core.multivalue import has_value_sql


def get_conn() -> sqlite3.Connection:
    """Return a raw connection. Caller is responsible for commit/close."""
    conn = sqlite3.connect(str(settings.db_path), check_same_thread=False)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA foreign_keys=ON")
    conn.execute("PRAGMA synchronous=NORMAL")
    # has_value(column, v): v is one of the ';'-separated values in column.
    conn.create_function("has_value", 2, has_value_sql, deterministic=True)
    # layout_path(path, title, ...): where the library's layout puts a track.
    from core.layout import COLUMNS, sql_function
    conn.create_function("layout_path", len(COLUMNS), sql_function())
    # lyrics_skip(path, assigned group): the track's lyrics group is never looked up.
    from core import lyricsgroups
    conn.create_function("lyrics_skip", 2, lyricsgroups.sql_function())
    # dup_rank(id) / dup_album(directory): duplicate groups (core/duplicates.py).
    from core import duplicates
    conn.create_function("dup_rank", 1, duplicates.dup_rank)
    conn.create_function("dup_album", 1, duplicates.dup_album)
    # q_match(mode, q, field, ...): the search box's glob/regex modes (core/search.py).
    from core.search import q_match
    conn.create_function("q_match", -1, q_match, deterministic=True)
    return conn


@contextmanager
def db() -> Generator[sqlite3.Connection, None, None]:
    """Context manager: auto-commit on success, rollback on exception."""
    conn = get_conn()
    try:
        yield conn
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


def _migrate(conn) -> None:
    """Add columns introduced after a DB was first created."""
    have = {r[1] for r in conn.execute("PRAGMA table_info(tracks)")}
    for col, decl in (
        ("bitrate", "INTEGER"),
        ("sample_rate", "INTEGER"),
        ("channels", "INTEGER"),
        ("composer", "TEXT"),
        ("bpm", "TEXT"),
        ("lyrics", "TEXT"),
        ("compilation", "TEXT"),
        ("has_cover", "INTEGER"),      # embedded cover art: 1/0, NULL = not read yet
        ("cover_width", "INTEGER"),    # ...its size in px and bytes
        ("cover_height", "INTEGER"),
        ("cover_bytes", "INTEGER"),
    ):
        if col not in have:
            conn.execute(f"ALTER TABLE tracks ADD COLUMN {col} {decl}")
    # Staging steps record what they changed TO (for Review), not just what
    # they replaced (for undo). Steps from before this have no details.
    # Scan jobs: scope, phase and changed-file count, for the Background page.
    jobs = {r[1] for r in conn.execute("PRAGMA table_info(scan_jobs)")}
    # kind: 'scan', or 'lyrics' for a background lyrics lookup (core/lyricsjob.py).
    for col, decl in (("directory", "TEXT"), ("phase", "TEXT"), ("changed", "INTEGER"),
                      ("kind", "TEXT NOT NULL DEFAULT 'scan'")):
        if jobs and col not in jobs:
            conn.execute(f"ALTER TABLE scan_jobs ADD COLUMN {col} {decl}")
    # The cover image in each album folder (core/covers.py), found at scan time.
    conn.execute("CREATE TABLE IF NOT EXISTS folder_covers (directory TEXT PRIMARY KEY, name TEXT NOT NULL,"
                 " width INTEGER, height INTEGER, bytes INTEGER)")
    steps = {r[1] for r in conn.execute("PRAGMA table_info(staged_steps)")}
    if "after" not in steps:
        conn.execute("ALTER TABLE staged_steps ADD COLUMN after TEXT")


def _fts(conn) -> None:
    """The search index over search.FTS_FIELDS, kept in step by triggers; rebuilt
    once when that list changes."""
    from core.search import FTS_FIELDS
    have = [r[1] for r in conn.execute("PRAGMA table_info(tracks_fts)")]
    if have == list(FTS_FIELDS):
        return
    cols = ", ".join(FTS_FIELDS)
    new = ", ".join(f"new.{c}" for c in FTS_FIELDS)
    old = ", ".join(f"old.{c}" for c in FTS_FIELDS)
    conn.executescript(f"""
        DROP TRIGGER IF EXISTS tracks_ai;
        DROP TRIGGER IF EXISTS tracks_ad;
        DROP TRIGGER IF EXISTS tracks_au;
        DROP TABLE IF EXISTS tracks_fts;
        CREATE VIRTUAL TABLE tracks_fts USING fts5({cols}, content=tracks, content_rowid=id);
        CREATE TRIGGER tracks_ai AFTER INSERT ON tracks BEGIN
            INSERT INTO tracks_fts(rowid, {cols}) VALUES (new.id, {new});
        END;
        CREATE TRIGGER tracks_ad AFTER DELETE ON tracks BEGIN
            INSERT INTO tracks_fts(tracks_fts, rowid, {cols}) VALUES ('delete', old.id, {old});
        END;
        CREATE TRIGGER tracks_au AFTER UPDATE ON tracks BEGIN
            INSERT INTO tracks_fts(tracks_fts, rowid, {cols}) VALUES ('delete', old.id, {old});
            INSERT INTO tracks_fts(rowid, {cols}) VALUES (new.id, {new});
        END;
        INSERT INTO tracks_fts(tracks_fts) VALUES ('rebuild');
    """)


def init_db() -> None:
    with db() as conn:
        conn.executescript("""
            CREATE TABLE IF NOT EXISTS tracks (
                id                 INTEGER PRIMARY KEY AUTOINCREMENT,
                path               TEXT UNIQUE NOT NULL,
                filename           TEXT NOT NULL,
                directory          TEXT NOT NULL,
                format             TEXT NOT NULL,
                size               INTEGER,
                mtime              REAL,
                duration           REAL,
                bitrate            INTEGER,
                sample_rate        INTEGER,
                channels           INTEGER,
                title              TEXT,
                artist             TEXT,
                album              TEXT,
                album_artist       TEXT,
                year               TEXT,
                genre              TEXT,
                track_number       TEXT,
                disc_number        TEXT,
                comment            TEXT,
                composer           TEXT,
                bpm                TEXT,
                lyrics             TEXT,
                compilation        TEXT,
                mb_track_id        TEXT,
                mb_artist_id       TEXT,
                mb_album_id        TEXT,
                mb_album_artist_id TEXT,
                scanned_at         REAL NOT NULL,
                tagged_at          REAL
            );

            CREATE INDEX IF NOT EXISTS idx_tracks_directory
                ON tracks(directory);
            CREATE INDEX IF NOT EXISTS idx_tracks_artist
                ON tracks(artist COLLATE NOCASE);
            CREATE INDEX IF NOT EXISTS idx_tracks_album
                ON tracks(album COLLATE NOCASE);
            CREATE INDEX IF NOT EXISTS idx_tracks_album_artist
                ON tracks(album_artist COLLATE NOCASE);

            CREATE TABLE IF NOT EXISTS scan_jobs (
                id          TEXT PRIMARY KEY,
                status      TEXT NOT NULL DEFAULT 'pending',
                started_at  REAL,
                finished_at REAL,
                total       INTEGER DEFAULT 0,
                scanned     INTEGER DEFAULT 0,
                error       TEXT
            );

            CREATE TABLE IF NOT EXISTS change_log (
                id      INTEGER PRIMARY KEY AUTOINCREMENT,
                ts      REAL NOT NULL,
                kind    TEXT NOT NULL,      -- 'tag_edit' | 'remove'
                summary TEXT NOT NULL,      -- human-readable description
                data    TEXT NOT NULL,      -- JSON snapshot for undo
                undone  INTEGER NOT NULL DEFAULT 0
            );

            -- Edits held for review until written (core/staging.py).
            CREATE TABLE IF NOT EXISTS staged (
                track_id  INTEGER PRIMARY KEY REFERENCES tracks(id) ON DELETE CASCADE,
                tags      TEXT NOT NULL DEFAULT '{}',   -- JSON: field -> new value
                new_path  TEXT,                         -- planned move, or NULL
                staged_at REAL NOT NULL
            );

            -- Folder moves/renames held for review (core/staging.py).
            CREATE TABLE IF NOT EXISTS staged_dirs (
                src       TEXT PRIMARY KEY,
                dst       TEXT NOT NULL,
                staged_at REAL NOT NULL
            );

            -- Lyrics groups a track was put in (core/lyricsgroups.py); none = its
            -- library's default.
            CREATE TABLE IF NOT EXISTS lyrics_members (
                track_id INTEGER PRIMARY KEY REFERENCES tracks(id) ON DELETE CASCADE,
                group_id TEXT NOT NULL
            );

            -- The last lyrics lookup per track: synced | plain | instrumental | missing | ...
            CREATE TABLE IF NOT EXISTS lyrics_lookups (
                track_id INTEGER PRIMARY KEY REFERENCES tracks(id) ON DELETE CASCADE,
                status   TEXT NOT NULL,
                at       REAL NOT NULL
            );

            -- Chromaprint fingerprints (fpcalc -raw, first 30 s) for duplicates by
            -- sound; stale when the file's mtime changes. fp '' = fpcalc failed.
            CREATE TABLE IF NOT EXISTS fingerprints (
                track_id INTEGER PRIMARY KEY REFERENCES tracks(id) ON DELETE CASCADE,
                mtime    REAL,
                fp       TEXT NOT NULL
            );

            -- Undo stack for staging: what each staging action replaced.
            CREATE TABLE IF NOT EXISTS staged_steps (
                id      INTEGER PRIMARY KEY AUTOINCREMENT,
                ts      REAL NOT NULL,
                summary TEXT NOT NULL,
                data    TEXT NOT NULL,  -- JSON: track_id -> previous entry or null
                after   TEXT            -- JSON: same keys -> entry after the step
            );
        """)
        _migrate(conn)
        _fts(conn)
