from __future__ import annotations

from pathlib import Path
from typing import Optional

from fastapi import APIRouter, HTTPException, Query

from core.database import db

router = APIRouter()

_ISSUE_CLAUSES: dict[str, str] = {
    "missing_title":        "(title IS NULL OR title = '')",
    "missing_artist":       "(artist IS NULL OR artist = '')",
    "missing_album":        "(album IS NULL OR album = '')",
    "missing_year":         "(year IS NULL OR year = '')",
    "missing_genre":        "(genre IS NULL OR genre = '')",
    "missing_track_number": "(track_number IS NULL OR track_number = '')",
    "duplicate_tracks": (
        "id IN ("
        "  SELECT t2.id FROM tracks t2"
        "  INNER JOIN ("
        "    SELECT LOWER(title) AS lt, LOWER(artist) AS la"
        "    FROM tracks"
        "    WHERE (title IS NOT NULL AND title != '')"
        "      AND (artist IS NOT NULL AND artist != '')"
        "    GROUP BY LOWER(title), LOWER(artist)"
        "    HAVING COUNT(*) > 1"
        "  ) dups ON LOWER(t2.title) = dups.lt AND LOWER(t2.artist) = dups.la"
        ")"
    ),
}


def _row(row) -> dict:
    return dict(row)


@router.get("/issues")
def get_issues():
    """Return per-issue track counts for the quality panel."""
    with db() as conn:
        result = {}
        for key, clause in _ISSUE_CLAUSES.items():
            result[key] = conn.execute(
                f"SELECT COUNT(*) FROM tracks WHERE {clause}"
            ).fetchone()[0]
        rows = conn.execute("SELECT path FROM tracks").fetchall()
        result["missing_files"] = sum(1 for r in rows if not Path(r["path"]).exists())
    return result


@router.get("/dead")
def get_dead_tracks():
    """Return tracks whose audio files no longer exist on disk."""
    with db() as conn:
        rows = conn.execute("SELECT * FROM tracks").fetchall()
    dead = [_row(r) for r in rows if not Path(r["path"]).exists()]
    return {"total": len(dead), "tracks": dead}


@router.post("/remove")
def remove_tracks(track_ids: list[int]):
    """Remove specific tracks from the library DB (does not delete files)."""
    if not track_ids:
        raise HTTPException(400, "No track IDs provided")
    with db() as conn:
        placeholders = ",".join("?" * len(track_ids))
        conn.execute(f"DELETE FROM tracks WHERE id IN ({placeholders})", track_ids)
    return {"removed": len(track_ids)}


@router.get("/tracks")
def list_tracks(
    directory: Optional[str] = None,
    artist: Optional[str] = None,
    album: Optional[str] = None,
    issue: Optional[str] = None,
    limit: int = Query(100, le=500),
    offset: int = 0,
):
    clauses, params = [], []
    if directory:
        clauses.append("(directory = ? OR substr(directory, 1, ?) = ?)")
        params.extend([directory, len(directory) + 1, directory + "/"])
    if artist is not None:
        if artist == "":
            clauses.append("(artist IS NULL OR artist = '')")
        else:
            clauses.append("artist = ?")
            params.append(artist)
    if album:
        clauses.append("album = ?")
        params.append(album)
    if issue and issue in _ISSUE_CLAUSES:
        clauses.append(_ISSUE_CLAUSES[issue])
    where = ("WHERE " + " AND ".join(clauses)) if clauses else ""

    # Group duplicates together so they're visually adjacent
    if issue == "duplicate_tracks":
        order = "ORDER BY LOWER(COALESCE(title,'')), LOWER(COALESCE(artist,'')), path"
    else:
        order = "ORDER BY directory, disc_number, track_number, title"

    with db() as conn:
        rows = conn.execute(
            f"SELECT * FROM tracks {where} {order} LIMIT ? OFFSET ?",
            [*params, limit, offset],
        ).fetchall()
        total = conn.execute(
            f"SELECT COUNT(*) FROM tracks {where}", params
        ).fetchone()[0]

    return {"total": total, "tracks": [_row(r) for r in rows]}


def _fts_query(q: str) -> str:
    """Convert a user query into an FTS5 prefix-match expression."""
    terms = q.split()
    return " ".join(f'"{t}"*' for t in terms if t)


@router.get("/search")
def search_tracks(
    q: str,
    limit: int = Query(50, le=200),
    offset: int = 0,
):
    fts_q = _fts_query(q)
    with db() as conn:
        rows = conn.execute(
            """
            SELECT t.* FROM tracks t
            JOIN tracks_fts f ON f.rowid = t.id
            WHERE tracks_fts MATCH ?
            ORDER BY rank
            LIMIT ? OFFSET ?
            """,
            (fts_q, limit, offset),
        ).fetchall()
        total = conn.execute(
            """
            SELECT COUNT(*) FROM tracks t
            JOIN tracks_fts f ON f.rowid = t.id
            WHERE tracks_fts MATCH ?
            """,
            (fts_q,),
        ).fetchone()[0]

    return {"total": total, "tracks": [_row(r) for r in rows]}


@router.get("/track/{track_id}")
def get_track(track_id: int):
    with db() as conn:
        row = conn.execute(
            "SELECT * FROM tracks WHERE id = ?", (track_id,)
        ).fetchone()
    if not row:
        raise HTTPException(404, "Track not found")
    return _row(row)


@router.get("/artists")
def list_artists():
    with db() as conn:
        rows = conn.execute(
            """
            SELECT COALESCE(artist, '') AS artist, COUNT(*) AS track_count
            FROM tracks
            GROUP BY COALESCE(artist, '')
            ORDER BY COALESCE(artist, '') COLLATE NOCASE
            """
        ).fetchall()
    return [_row(r) for r in rows]


@router.get("/albums")
def list_albums(artist: Optional[str] = None):
    clauses = ["album IS NOT NULL"]
    params: list = []
    if artist is not None:
        if artist == "":
            clauses.append("(artist IS NULL OR artist = '')")
        else:
            clauses.append("artist = ?")
            params.append(artist)
    where = "WHERE " + " AND ".join(clauses)

    with db() as conn:
        rows = conn.execute(
            f"""
            SELECT album, COALESCE(artist, '') AS artist, album_artist,
                   COUNT(*) AS track_count, MIN(id) AS cover_track_id
            FROM tracks {where}
            GROUP BY COALESCE(artist, ''), album
            ORDER BY COALESCE(artist, '') COLLATE NOCASE, album COLLATE NOCASE
            """,
            params,
        ).fetchall()
    return [_row(r) for r in rows]
