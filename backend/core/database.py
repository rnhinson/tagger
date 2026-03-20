import sqlite3
from contextlib import contextmanager
from typing import Generator

from core.config import settings


def get_conn() -> sqlite3.Connection:
    """Return a raw connection. Caller is responsible for commit/close."""
    conn = sqlite3.connect(str(settings.db_path), check_same_thread=False)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA foreign_keys=ON")
    conn.execute("PRAGMA synchronous=NORMAL")
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
                title              TEXT,
                artist             TEXT,
                album              TEXT,
                album_artist       TEXT,
                year               TEXT,
                genre              TEXT,
                track_number       TEXT,
                disc_number        TEXT,
                comment            TEXT,
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

            CREATE VIRTUAL TABLE IF NOT EXISTS tracks_fts USING fts5(
                title, artist, album, album_artist, genre,
                content=tracks,
                content_rowid=id
            );

            CREATE TRIGGER IF NOT EXISTS tracks_ai
            AFTER INSERT ON tracks BEGIN
                INSERT INTO tracks_fts(rowid, title, artist, album, album_artist, genre)
                VALUES (new.id, new.title, new.artist, new.album, new.album_artist, new.genre);
            END;

            CREATE TRIGGER IF NOT EXISTS tracks_ad
            AFTER DELETE ON tracks BEGIN
                INSERT INTO tracks_fts(tracks_fts, rowid, title, artist, album, album_artist, genre)
                VALUES ('delete', old.id, old.title, old.artist, old.album, old.album_artist, old.genre);
            END;

            CREATE TRIGGER IF NOT EXISTS tracks_au
            AFTER UPDATE ON tracks BEGIN
                INSERT INTO tracks_fts(tracks_fts, rowid, title, artist, album, album_artist, genre)
                VALUES ('delete', old.id, old.title, old.artist, old.album, old.album_artist, old.genre);
                INSERT INTO tracks_fts(rowid, title, artist, album, album_artist, genre)
                VALUES (new.id, new.title, new.artist, new.album, new.album_artist, new.genre);
            END;

            CREATE TABLE IF NOT EXISTS scan_jobs (
                id          TEXT PRIMARY KEY,
                status      TEXT NOT NULL DEFAULT 'pending',
                started_at  REAL,
                finished_at REAL,
                total       INTEGER DEFAULT 0,
                scanned     INTEGER DEFAULT 0,
                error       TEXT
            );
        """)
