from __future__ import annotations

import shutil
from pathlib import Path
from typing import Optional

from fastapi import APIRouter, HTTPException, Query
from fastapi.responses import PlainTextResponse

from core.config import settings
from core.database import db
from core.history import log_change, snapshot, list_changes, undo_change

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


def _track_filters(
    directory: Optional[str],
    artist: Optional[str],
    album: Optional[str],
    issue: Optional[str],
) -> tuple[str, list, str]:
    """Build the shared WHERE clause + ORDER BY used by listing and export."""
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

    return where, params, order


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
        rows = conn.execute(
            f"SELECT * FROM tracks WHERE id IN ({placeholders})", track_ids
        ).fetchall()
        snaps = [snapshot(r) for r in rows]
        conn.execute(f"DELETE FROM tracks WHERE id IN ({placeholders})", track_ids)
        log_change(conn, "remove", f"Removed {len(snaps)} tracks from library", snaps)
    return {"removed": len(rows)}


@router.post("/dedupe/keep-best")
def dedupe_keep_best():
    """
    For each set of tracks sharing a title+artist, keep the highest-quality copy
    (bitrate, then file size) and remove the rest from the library DB. Files are
    left on disk; the removal is logged so it can be undone.
    """
    with db() as conn:
        rows = conn.execute(
            "SELECT * FROM tracks "
            "WHERE (title IS NOT NULL AND title != '') "
            "  AND (artist IS NOT NULL AND artist != '')"
        ).fetchall()
        groups: dict[tuple[str, str], list] = {}
        for r in rows:
            groups.setdefault((r["title"].lower(), r["artist"].lower()), []).append(r)

        losers = []
        for members in groups.values():
            if len(members) < 2:
                continue
            ranked = sorted(members, key=lambda r: ((r["bitrate"] or 0), (r["size"] or 0)), reverse=True)
            losers.extend(ranked[1:])

        if not losers:
            return {"removed": 0, "kept": 0}
        snaps = [snapshot(r) for r in losers]
        ids = [r["id"] for r in losers]
        placeholders = ",".join("?" * len(ids))
        conn.execute(f"DELETE FROM tracks WHERE id IN ({placeholders})", ids)
        log_change(conn, "remove", f"Removed {len(ids)} duplicate tracks (kept best quality)", snaps)
    return {"removed": len(ids)}


@router.post("/delete-files")
def delete_files(track_ids: list[int]):
    """
    Move the selected files to a trash folder and remove their DB rows. Files
    are not hard-deleted — the move is logged so it can be undone (which
    restores both the file and the row).
    """
    if not track_ids:
        raise HTTPException(400, "No track IDs provided")
    trash_dir = settings.config_dir / "trash"
    trash_dir.mkdir(parents=True, exist_ok=True)

    with db() as conn:
        placeholders = ",".join("?" * len(track_ids))
        rows = conn.execute(
            f"SELECT * FROM tracks WHERE id IN ({placeholders})", track_ids
        ).fetchall()
        snaps = []
        for r in rows:
            snap = snapshot(r)
            src = Path(r["path"])
            if src.exists():
                dest = trash_dir / f"{r['id']}_{src.name}"
                shutil.move(str(src), str(dest))
                snap["_trash"] = str(dest)
            else:
                snap["_trash"] = None
            snaps.append(snap)
        ids = [r["id"] for r in rows]
        conn.execute(f"DELETE FROM tracks WHERE id IN ({placeholders})", ids)
        log_change(conn, "delete_files", f"Deleted {len(ids)} files (moved to trash)", snaps)
    return {"deleted": len(rows)}


@router.get("/trash")
def trash_info():
    """Count and total size of files sitting in the delete-to-trash folder."""
    trash = settings.config_dir / "trash"
    if not trash.is_dir():
        return {"count": 0, "bytes": 0}
    files = [f for f in trash.iterdir() if f.is_file()]
    return {"count": len(files), "bytes": sum(f.stat().st_size for f in files)}


@router.post("/trash/empty")
def empty_trash():
    """Permanently delete everything in the trash folder. Not undoable."""
    trash = settings.config_dir / "trash"
    if not trash.is_dir():
        return {"removed": 0, "bytes": 0}
    removed, freed = 0, 0
    for f in list(trash.iterdir()):
        if f.is_file():
            freed += f.stat().st_size
            f.unlink()
            removed += 1
    return {"removed": removed, "bytes": freed}


@router.get("/history")
def get_history(limit: int = Query(50, le=200)):
    with db() as conn:
        return list_changes(conn, limit)


@router.post("/history/{change_id}/undo")
def undo(change_id: int):
    with db() as conn:
        try:
            return undo_change(conn, change_id)
        except ValueError as exc:
            raise HTTPException(400, str(exc))


@router.get("/tracks")
def list_tracks(
    directory: Optional[str] = None,
    artist: Optional[str] = None,
    album: Optional[str] = None,
    issue: Optional[str] = None,
    limit: int = Query(100, le=500),
    offset: int = 0,
):
    where, params, order = _track_filters(directory, artist, album, issue)

    with db() as conn:
        rows = conn.execute(
            f"SELECT * FROM tracks {where} {order} LIMIT ? OFFSET ?",
            [*params, limit, offset],
        ).fetchall()
        total = conn.execute(
            f"SELECT COUNT(*) FROM tracks {where}", params
        ).fetchone()[0]

    return {"total": total, "tracks": [_row(r) for r in rows]}


def _m3u(tracks: list[dict]) -> str:
    """Render tracks as an EXTM3U playlist with absolute file paths."""
    lines = ["#EXTM3U"]
    for t in tracks:
        secs = int(t["duration"]) if t.get("duration") else -1
        artist = t.get("artist") or ""
        title = t.get("title") or t.get("filename") or ""
        label = f"{artist} - {title}" if artist else title
        lines.append(f"#EXTINF:{secs},{label}")
        lines.append(t["path"])
    return "\n".join(lines) + "\n"


@router.get("/export.m3u", response_class=PlainTextResponse)
def export_m3u(
    directory: Optional[str] = None,
    artist: Optional[str] = None,
    album: Optional[str] = None,
    issue: Optional[str] = None,
    q: Optional[str] = None,
    limit: int = Query(10000, le=100000),
):
    """Export the current view (same filters as /tracks, or a search) as .m3u."""
    with db() as conn:
        if q:
            rows = conn.execute(
                """
                SELECT t.* FROM tracks t
                JOIN tracks_fts f ON f.rowid = t.id
                WHERE tracks_fts MATCH ?
                ORDER BY rank LIMIT ?
                """,
                (_fts_query(q), limit),
            ).fetchall()
        else:
            where, params, order = _track_filters(directory, artist, album, issue)
            rows = conn.execute(
                f"SELECT * FROM tracks {where} {order} LIMIT ?", [*params, limit]
            ).fetchall()

    body = _m3u([_row(r) for r in rows])
    return PlainTextResponse(
        body,
        media_type="audio/x-mpegurl",
        headers={"Content-Disposition": 'attachment; filename="tagger-export.m3u"'},
    )


def _fts_query(q: str) -> str:
    """Convert a user query into an FTS5 prefix-match expression."""
    # Strip double quotes so a stray quote can't break out of the quoted term
    # and produce a malformed MATCH expression (500 / query error).
    terms = q.replace('"', " ").split()
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
