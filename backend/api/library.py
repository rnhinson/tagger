from __future__ import annotations

import shutil
from pathlib import Path
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel
from fastapi.responses import PlainTextResponse

from core.config import settings
from core.database import db
from core import staging
from core.multivalue import MULTI_FIELDS, split_values
from core.history import STAGEABLE, log_change, snapshot, list_changes, undo_change

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


def _tracks(conn, rows) -> list[dict]:
    """
    Track rows as dicts, each with its staged changes (or null). A track under
    a staged folder move gets that folder's destination as its new path.
    """
    import os
    entries = staging.load(conn, [r["id"] for r in rows])
    dirs = staging.load_dirs(conn)
    writable: dict[str, bool] = {}
    out = []
    for r in rows:
        e = entries.get(r["id"])
        moved = staging.moved_path(r["path"], dirs) if dirs else None
        if moved:
            e = {**(e or {"tags": {}}), "new_path": moved, "via_folder": True}
        d = r["directory"]
        if d not in writable:
            writable[d] = os.access(d, os.W_OK)
        out.append({**dict(r), "staged": e, "read_only": not writable[d]})
    return out


# Tags the sidebar can browse by (Tags panel: tag -> values).
BROWSE_FIELDS = ("artist", "album_artist", "album", "genre", "year", "composer")

def _blank(col: str) -> str:
    return f"({col} IS NULL OR {col} = '')"


# Same rule as the UI's quality dot (frontend/src/quality.ts).
_POOR = f"({_blank('title')} OR {_blank('artist')})"
_FAIR = f"(NOT {_POOR} AND ({_blank('album')} OR {_blank('year')} OR {_blank('track_number')}))"
_QUALITY = {"poor": _POOR, "fair": _FAIR, "good": f"(NOT {_POOR} AND NOT {_FAIR})"}

# Sortable columns -> SQL. Numbers sort as numbers; title falls back to the
# file name like the table does; "source" is the folder.
_SORT = {
    "title": "COALESCE(NULLIF(title, ''), filename) COLLATE NOCASE",
    **{c: f"{c} COLLATE NOCASE" for c in ("artist", "album", "album_artist", "genre", "composer", "format")},
    **{c: f"CAST({c} AS INTEGER)" for c in ("year", "track_number", "disc_number", "bpm")},
    **{c: c for c in ("bitrate", "sample_rate", "channels", "duration")},
    "source": "directory COLLATE NOCASE",
}


class View:
    """The track list's filters + sort, shared by listing, export and select-all."""

    def __init__(
        self,
        directory: Optional[str] = None,
        artist: Optional[str] = None,
        album: Optional[str] = None,
        issue: Optional[str] = None,
        tag: Optional[str] = None,
        value: Optional[str] = None,
        q: Optional[str] = None,
        format: Optional[str] = None,
        quality: Optional[str] = None,
        sort: Optional[str] = None,
        sort_dir: str = "asc",
    ):
        self.directory, self.artist, self.album, self.issue = directory, artist, album, issue
        self.tag, self.value, self.q = tag, value, q
        self.format, self.quality, self.sort, self.sort_dir = format, quality, sort, sort_dir


def _track_filters(v: View) -> tuple[str, list, str]:
    """Build the shared WHERE clause + ORDER BY used by listing and export."""
    clauses, params = [], []
    if v.q and _fts_query(v.q):
        clauses.append("id IN (SELECT rowid FROM tracks_fts WHERE tracks_fts MATCH ?)")
        params.append(_fts_query(v.q))
    if v.tag in BROWSE_FIELDS and v.value is not None:
        # `tag` is whitelisted, so it is safe to interpolate.
        if v.value == "":
            clauses.append(_blank(v.tag))
        else:  # one of its ';'-separated values (core/multivalue.py)
            clauses.append(f"has_value({v.tag}, ?)")
            params.append(v.value)
    if v.directory:
        clauses.append("(directory = ? OR substr(directory, 1, ?) = ?)")
        params.extend([v.directory, len(v.directory) + 1, v.directory + "/"])
    if v.artist is not None:
        if v.artist == "":
            clauses.append(_blank("artist"))
        else:
            clauses.append("has_value(artist, ?)")
            params.append(v.artist)
    if v.album:
        clauses.append("album = ?")
        params.append(v.album)
    if v.issue and v.issue in _ISSUE_CLAUSES:
        clauses.append(_ISSUE_CLAUSES[v.issue])
    if v.format:
        clauses.append("format = ?")
        params.append(v.format)
    if v.quality in _QUALITY:
        clauses.append(_QUALITY[v.quality])
    where = ("WHERE " + " AND ".join(clauses)) if clauses else ""

    if v.sort in _SORT:
        col = _SORT[v.sort]
        direction = "DESC" if v.sort_dir == "desc" else "ASC"
        # Blanks last either way (title never is: it falls back to the file
        # name), then a stable tiebreak.
        blanks = "" if v.sort == "title" else _blank("directory" if v.sort == "source" else v.sort) + ", "
        order = f"ORDER BY {blanks}{col} {direction}, directory, path"
    elif v.issue == "duplicate_tracks":
        # Group duplicates together so they're visually adjacent
        order = "ORDER BY LOWER(COALESCE(title,'')), LOWER(COALESCE(artist,'')), path"
    else:
        # Disc/track numbers are text tags ("10", "2/12"): sort them as numbers.
        order = ("ORDER BY directory, CAST(disc_number AS INTEGER), "
                 "CAST(track_number AS INTEGER), filename")

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
    view: View = Depends(),
    limit: int = Query(100, le=500),
    offset: int = 0,
):
    where, params, order = _track_filters(view)

    with db() as conn:
        rows = conn.execute(
            f"SELECT * FROM tracks {where} {order} LIMIT ? OFFSET ?",
            [*params, limit, offset],
        ).fetchall()
        total = conn.execute(
            f"SELECT COUNT(*) FROM tracks {where}", params
        ).fetchone()[0]
        return {"total": total, "tracks": _tracks(conn, rows)}


@router.get("/track-ids")
def list_track_ids(view: View = Depends(), limit: int = Query(20000, le=100000)):
    """Every writable track id in the view, in view order -- 'select all N' across pages."""
    where, params, order = _track_filters(view)
    with db() as conn:
        rows = conn.execute(f"SELECT id, directory FROM tracks {where} {order} LIMIT ?", [*params, limit]).fetchall()
    # Read-only tracks can't be edited, so they never join a bulk selection.
    import os
    writable = {d: os.access(d, os.W_OK) for d in {r["directory"] for r in rows}}
    return {"ids": [r["id"] for r in rows if writable[r["directory"]]]}


@router.get("/formats")
def list_formats():
    with db() as conn:
        return [r["format"] for r in conn.execute("SELECT DISTINCT format FROM tracks ORDER BY format")]


class Selection(BaseModel):
    track_ids: list[int]


def _rows_chunked(conn, ids: list[int]) -> list:
    """SELECT * for any number of ids (SQLite caps bound parameters)."""
    rows = []
    for i in range(0, len(ids), 900):
        chunk = ids[i:i + 900]
        ph = ",".join("?" * len(chunk))
        rows += conn.execute(f"SELECT * FROM tracks WHERE id IN ({ph})", chunk).fetchall()
    return rows


@router.post("/summary")
def selection_summary(sel: Selection):
    """
    For the editor on a selection larger than one page: each field's value
    when every track agrees (as staged), else null -- 'multiple values'.
    """
    values: dict[str, Optional[str]] = {}
    mixed: list[str] = []
    with db() as conn:
        rows = _rows_chunked(conn, sel.track_ids)
        entries = staging.load(conn, [r["id"] for r in rows])
    eff = [staging.effective(r, entries.get(r["id"])) for r in rows]
    for f in STAGEABLE:
        seen = {(e.get(f) or "") for e in eff}
        if len(seen) > 1:
            mixed.append(f)
        else:
            values[f] = seen.pop() if seen else ""
    import os
    ro_dirs = {d for d in {r["directory"] for r in rows} if not os.access(d, os.W_OK)}
    ro = sum(1 for r in rows if r["directory"] in ro_dirs)
    return {"count": len(rows), "values": values, "mixed": mixed, "read_only": ro}


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
def export_m3u(view: View = Depends(), limit: int = Query(10000, le=100000)):
    """Export the current view (same filters and order as /tracks) as .m3u."""
    where, params, order = _track_filters(view)
    with db() as conn:
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
        return {"total": total, "tracks": _tracks(conn, rows)}


@router.get("/track/{track_id}")
def get_track(track_id: int):
    with db() as conn:
        row = conn.execute(
            "SELECT * FROM tracks WHERE id = ?", (track_id,)
        ).fetchone()
        if not row:
            raise HTTPException(404, "Track not found")
        return _tracks(conn, [row])[0]


@router.get("/tag-values")
def tag_values(field: str):
    """
    Values of one tag with track counts; '' = tracks without it. A tag holding
    several ';'-separated values counts under each, so an album tagged
    "Folk; Celtic" is listed under both.
    """
    if field not in BROWSE_FIELDS:
        raise HTTPException(400, "Invalid field")
    with db() as conn:
        rows = conn.execute(
            f"SELECT {field} AS value, COUNT(*) AS n FROM tracks GROUP BY {field}"
        ).fetchall()
    counts: dict[str, int] = {}
    for r in rows:
        for v in split_values(r["value"]) or [""]:
            counts[v] = counts.get(v, 0) + r["n"]
    key = (lambda v: v) if field == "year" else (lambda v: v.casefold())
    return [{"value": v, "track_count": n}
            for v, n in sorted(counts.items(), key=lambda kv: key(kv[0]), reverse=field == "year")]


class ValueCounts(BaseModel):
    track_ids: list[int]
    field: str


@router.post("/value-counts")
def value_counts(req: ValueCounts):
    """How many of these tracks carry each value of a multi-value tag (as staged)."""
    if req.field not in MULTI_FIELDS:
        raise HTTPException(400, "Invalid field")
    with db() as conn:
        rows = _rows_chunked(conn, req.track_ids)
        entries = staging.load(conn, [r["id"] for r in rows])
    counts: dict[str, int] = {}
    for r in rows:
        for v in split_values(staging.effective(r, entries.get(r["id"])).get(req.field)):
            counts[v] = counts.get(v, 0) + 1
    return {"count": len(rows),
            "values": [{"value": v, "tracks": n} for v, n in sorted(counts.items(), key=lambda kv: kv[0].casefold())]}


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
            clauses.append("has_value(artist, ?)")
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
