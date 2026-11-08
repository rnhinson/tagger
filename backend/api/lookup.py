from __future__ import annotations

import asyncio
import dataclasses
import re
import shutil
import urllib.error
import urllib.request

from fastapi import APIRouter, HTTPException

from core.config import settings
from core.database import db
from core.inference import infer_tags_from_path
from core.providers.musicbrainz import MusicBrainzProvider
from core.tagger import write_cover
from api.config import _load as load_app_settings, get_music_dirs


def _acoustid_key() -> str:
    """AppSettings key takes precedence over env var."""
    app_key = load_app_settings().acoustid_api_key
    return app_key or settings.acoustid_api_key

router = APIRouter()
_mb = MusicBrainzProvider()


@router.get("/status")
def lookup_status():
    """Report which lookup methods are available."""
    acoustid_key = _acoustid_key()
    fpcalc_available = bool(acoustid_key) and shutil.which("fpcalc") is not None
    return {
        "fpcalc_installed": shutil.which("fpcalc") is not None,
        "acoustid_configured": bool(acoustid_key),
        "fpcalc_available": fpcalc_available,
        "method": "acoustid" if (acoustid_key and fpcalc_available) else "text",
    }


@router.post("/search/{track_id}")
async def search_track(track_id: int):
    with db() as conn:
        row = conn.execute("SELECT * FROM tracks WHERE id = ?", (track_id,)).fetchone()
    if not row:
        raise HTTPException(404, "Track not found")

    acoustid_key = _acoustid_key()
    if acoustid_key:
        if not shutil.which("fpcalc"):
            raise HTTPException(400, "fpcalc not found — install libchromaprint-tools to use AcoustID")
        try:
            from core.providers.acoustid_provider import AcoustIDProvider
            results = await AcoustIDProvider(acoustid_key).lookup(row["path"])
            if results:
                return [
                    {k: v for k, v in dataclasses.asdict(r).items() if k != "raw"}
                    for r in results
                ]
        except RuntimeError as e:
            if "fpcalc" in str(e):
                raise HTTPException(400, str(e))
            # Fingerprint failed for this file — fall back to text search

    # Text search with duration for better accuracy
    results = await _mb.search(
        title=row["title"],
        artist=row["artist"],
        album=row["album"],
        duration=row["duration"],
    )

    # Supplement with Discogs when a token is configured
    discogs_token = load_app_settings().discogs_token
    if discogs_token:
        try:
            from core.providers.discogs import DiscogsProvider
            results += await DiscogsProvider(discogs_token).search(
                title=row["title"], artist=row["artist"], album=row["album"]
            )
        except Exception:
            pass  # Discogs is best-effort; never fail the whole lookup

    results.sort(key=lambda r: r.score, reverse=True)
    return [
        {k: v for k, v in dataclasses.asdict(r).items() if k != "raw"}
        for r in results
    ]


@router.get("/releases/{mb_track_id}")
async def list_releases(mb_track_id: str):
    """List the releases/editions a recording appears on (for the edition picker)."""
    return await _mb.list_releases(mb_track_id)


@router.post("/infer/{track_id}")
def infer_from_path(track_id: int):
    """Propose tags parsed from the file's path/name (source='filename')."""
    with db() as conn:
        row = conn.execute("SELECT * FROM tracks WHERE id = ?", (track_id,)).fetchone()
    if not row:
        raise HTTPException(404, "Track not found")
    inferred = infer_tags_from_path(row["path"], get_music_dirs())
    if not inferred:
        return None
    return {
        "title":        inferred.get("title"),
        "artist":       inferred.get("artist"),
        "album":        inferred.get("album"),
        "album_artist": inferred.get("album_artist"),
        "year":         inferred.get("year"),
        "track_number": inferred.get("track_number"),
        "disc_number":  inferred.get("disc_number"),
        "mb_track_id":  None,
        "mb_artist_id": None,
        "mb_album_id":  None,
        "mb_album_artist_id": None,
        "score":        0.5,
        "source":       "filename",
    }


_UUID_RE = re.compile(r"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$")
_MAX_COVER_BYTES = 20 * 1024 * 1024  # 20 MB


def _fetch_caa(mb_album_id: str, size: int = 1200) -> tuple[str, bytes]:
    """
    Fetch the front cover from the Cover Art Archive. Raises on failure.
    A sized JPEG (250/500/1200) first -- originals can be 8 MB PNGs; 0 = the original.
    """
    if size:
        try:
            return _fetch_caa_url(f"https://coverartarchive.org/release/{mb_album_id}/front-{size}")
        except urllib.error.HTTPError as e:
            if e.code != 404:
                raise
    return _fetch_caa_url(f"https://coverartarchive.org/release/{mb_album_id}/front")


def _caa_size(size: int) -> int:
    """The smallest Cover Art Archive size (250/500/1200) at least `size`; 0 = the original."""
    return next((c for c in (250, 500, 1200) if size and size <= c), 0)


def _fetch_caa_url(url: str) -> tuple[str, bytes]:
    req = urllib.request.Request(url, headers={"User-Agent": "tagger/0.2"})
    with urllib.request.urlopen(req, timeout=30) as resp:
        mime = resp.headers.get("Content-Type", "image/jpeg").split(";")[0].strip()
        data = resp.read(_MAX_COVER_BYTES + 1)
    if len(data) > _MAX_COVER_BYTES:
        raise ValueError("cover art exceeds 20 MB")
    if not mime.startswith("image/"):
        raise ValueError(f"unexpected content type: {mime}")
    return mime, data


@router.post("/cover/{track_id}")
async def apply_cover_from_mb(track_id: int, mb_album_id: str):
    """Fetch cover art from Cover Art Archive and write it to the audio file."""
    # mb_album_id is interpolated into the outbound URL — require a real UUID.
    if not _UUID_RE.match(mb_album_id):
        raise HTTPException(400, "Invalid MusicBrainz album id")
    with db() as conn:
        row = conn.execute("SELECT path FROM tracks WHERE id = ?", (track_id,)).fetchone()
    if not row:
        raise HTTPException(404, "Track not found")
    try:
        mime, data = await asyncio.to_thread(_fetch_caa, mb_album_id)
    except urllib.error.HTTPError as e:
        raise HTTPException(e.code, f"Cover Art Archive returned {e.code}")
    except Exception as e:
        raise HTTPException(502, f"Failed to fetch cover art: {e}")
    try:
        write_cover(row["path"], mime, data)
    except ValueError as e:
        raise HTTPException(400, str(e))
    return {"ok": True}


# ── Album-level match (core/albummatch.py) ────────────────────────────────────

from typing import Optional

from pydantic import BaseModel

from difflib import SequenceMatcher

from core import albummatch, covers, staging
from core.providers import musicbrainz as mbp


class AlbumSearch(BaseModel):
    track_ids: list[int]
    album: Optional[str] = None      # override the selection's own values
    artist: Optional[str] = None
    by: str = "album"                # album | artist (releases by the artist) | track (releases containing it)
    track: Optional[str] = None      # title for by="track"
    source: str = "auto"             # auto (tags; Unknown/missing -> folder names) | names | tags


def _selection(conn, ids: list[int]) -> list[dict]:
    """The selected tracks as staged (what a match should compare against)."""
    from api.tags import _rows
    rows = _rows(conn, ids)
    entries = staging.load(conn, [r["id"] for r in rows])
    return [staging.effective(r, entries.get(r["id"])) for r in rows]


def _common(tracks: list[dict], field: str) -> str | None:
    vals = [t.get(field) for t in tracks if not albummatch.is_placeholder(t.get(field))]
    return max(set(vals), key=vals.count) if vals else None


def _from_names(tracks: list[dict]) -> list[dict]:
    """The selection as its folder and file names say: album, artist, title (other fields kept)."""
    from api.config import get_library_roots
    from core.fileops import root_for
    roots = get_library_roots()
    out = []
    for t in tracks:
        album, artist = albummatch.names_from_path(t["path"], root_for(t["path"], roots))
        out.append({**t, "album": album, "album_artist": artist, "artist": artist,
                    "title": albummatch.name_title(t)})
    return out


def _artist_releases(artist: str, tracks: list[dict]) -> list[dict]:
    """
    "Which of this artist's releases holds these tracks?" A bare artist search
    returns whatever MusicBrainz scores highest (often obscure uploads), so
    instead look up releases by the artist containing each of your titles
    (up to 6) and order them by how many of your titles each holds.
    """
    titles = list(dict.fromkeys(albummatch.local_title(t) for t in tracks if albummatch.local_title(t)))[:6]
    if not titles:
        return mbp.search_releases(None, artist, 40)
    hits: dict[str, int] = {}
    cands: dict[str, dict] = {}
    want = albummatch._norm(artist)
    for title in titles:
        for c in mbp.releases_with_recording(title, artist):
            # MusicBrainz's artist filter is fuzzy: drop covers / other artists.
            got = albummatch._norm(c.get("artist"))
            if got and want not in got and SequenceMatcher(None, want, got).ratio() < 0.6:
                continue
            hits[c["mb_album_id"]] = hits.get(c["mb_album_id"], 0) + 1
            cands.setdefault(c["mb_album_id"], c)
    ranked = sorted(cands.values(), key=lambda c: (-hits[c["mb_album_id"]], c.get("type") != "Album",
                                                   abs((c.get("tracks") or 999) - len(tracks))))
    for c in ranked:
        c["titles_found"] = hits[c["mb_album_id"]]
    return ranked[:40]


@router.post("/album/search")
async def album_search(req: AlbumSearch):
    """Release candidates for the selection; one its files already name comes first."""
    with db() as conn:
        tracks = _selection(conn, req.track_ids)
    if not tracks:
        raise HTTPException(400, "No tracks")
    names = _from_names(tracks)
    if req.source == "names":
        tracks = names
    fallback = req.source == "auto"
    album = req.album if req.album is not None else (
        _common(tracks, "album") or (_common(names, "album") if fallback else None))
    artist = req.artist if req.artist is not None else (
        _common(tracks, "album_artist") or _common(tracks, "artist") or (_common(names, "artist") if fallback else None))
    if req.by == "track":
        title = (req.track or "").strip()
        if not title:
            raise HTTPException(400, "No track title to search for")
        found = await asyncio.to_thread(mbp.releases_with_recording, title, artist)
        return {"album": album, "artist": artist, "track": title, "by": "track", "source": req.source,
                "local_tracks": len(tracks), "candidates": found}
    if req.by == "artist":
        if not artist:
            raise HTTPException(400, "No artist to search for -- type one")
        found = await asyncio.to_thread(_artist_releases, artist, tracks)
        return {"album": album, "artist": artist, "by": "artist", "source": req.source, "local_tracks": len(tracks), "candidates": found}
    if not album:
        raise HTTPException(400, "No album name to search for -- type one, or try " +
                            ("tags" if req.source == "names" else "folder names" if req.source == "tags" else "naming the folder"))
    found = await asyncio.to_thread(mbp.search_releases, album, artist)
    tagged = _common(tracks, "mb_album_id")
    if tagged and _UUID_RE.match(tagged):
        found = [r for r in found if r["mb_album_id"] != tagged]
        rel = await asyncio.to_thread(mbp.get_release, tagged)
        if rel:
            found.insert(0, {"mb_album_id": tagged, "album": rel["album"], "artist": rel["album_artist"],
                             "date": rel["date"], "country": rel["country"], "formats": [],
                             "discs": rel["discs"], "tracks": len(rel["tracks"]), "type": None,
                             "score": 1.0, "tagged": True})
    return {"album": album, "artist": artist, "by": "album", "source": req.source, "local_tracks": len(tracks), "candidates": found}


class AlbumMatch(BaseModel):
    track_ids: list[int]
    mb_album_id: str


def _release(mb_album_id: str) -> dict:
    if not _UUID_RE.match(mb_album_id):
        raise HTTPException(400, "Invalid MusicBrainz album id")
    rel = mbp.get_release(mb_album_id)
    if not rel:
        raise HTTPException(502, "MusicBrainz didn't return that release")
    return rel


@router.post("/album/match")
async def album_match(req: AlbumMatch):
    """Proposed pairing of the selection with one release, with each pair's tag changes."""
    rel = await asyncio.to_thread(_release, req.mb_album_id)
    await asyncio.to_thread(mbp.release_genre, rel)
    with db() as conn:
        tracks = _selection(conn, req.track_ids)
    pairs = albummatch.match(tracks, rel["tracks"])
    items = []
    for t in sorted(tracks, key=lambda t: (albummatch._int(t.get("disc_number")) or 1,
                                           albummatch._int(t.get("track_number")), t["filename"])):
        key, sc = pairs[t["id"]]
        mb = next((r for r in rel["tracks"] if r["key"] == key), None)
        items.append({"id": t["id"], "filename": t["filename"], "title": t.get("title"),
                      "title_similarity": round(albummatch.title_similarity(t, mb), 3) if mb else None,
                      "artist": t.get("artist"), "track_number": t.get("track_number"),
                      "genre": t.get("genre"), "composer": t.get("composer"),
                      "disc_number": t.get("disc_number"), "duration": t.get("duration"),
                      "key": key, "score": sc})
    used = {i["key"] for i in items if i["key"]}
    release = {k: v for k, v in rel.items() if k not in ("tracks", "tag_list")}
    current = {f: _common(tracks, f) for f in ("album", "album_artist", "year", "genre")}
    return {"release": release, "release_tracks": rel["tracks"], "items": items, "current": current,
            "unmatched": [t["key"] for t in rel["tracks"] if t["key"] not in used]}


@router.post("/album/score")
async def album_score(req: AlbumMatch):
    """One candidate's fit to the selection -- the dialog ranks candidates by this."""
    rel = await asyncio.to_thread(_release, req.mb_album_id)
    with db() as conn:
        tracks = _selection(conn, req.track_ids)
    q = albummatch.quality(tracks, rel["tracks"])
    return {"mb_album_id": req.mb_album_id, **{k: v for k, v in q.items() if k != "pairs"}}


class AlbumApply(BaseModel):
    mb_album_id: str
    pairs: dict[int, str]                    # track id -> release track key
    fields: list[str] = list(albummatch.FIELDS)
    original_year: bool = True
    cover: bool = False
    keep: list[str] = []                     # fields only filled where empty (genre, composer)
    unpaired: list[int] = []                 # tracks on no release track: album-level fields only


@router.post("/album/apply")
async def album_apply(req: AlbumApply):
    """Stage the chosen pairs' tags as one step; cover art (optional) is written now."""
    from api.tags import _finish, _rows
    rel = await asyncio.to_thread(_release, req.mb_album_id)
    if "genre" in req.fields:
        await asyncio.to_thread(mbp.release_genre, rel)
    by_key = {t["key"]: t for t in rel["tracks"]}
    fields = [f for f in req.fields if f in albummatch.FIELDS]
    if not fields and not req.cover:
        raise HTTPException(400, "Nothing chosen: pick tags or cover art")
    errors: list[dict] = []
    targets = {**{tid: by_key.get(key) for tid, key in req.pairs.items()}, **{tid: None for tid in req.unpaired}}
    with db() as conn:
        rows = {r["id"]: r for r in _rows(conn, list(targets))}
        entries = staging.load(conn, list(rows))
        todo = []
        for tid, mb in targets.items():
            row = rows.get(tid)
            if not row or (tid in req.pairs and not mb):
                errors.append({"id": tid, "error": "unknown track or release track"})
                continue
            eff = staging.effective(row, entries.get(tid))
            tags = albummatch.tags_for(rel, mb, req.original_year)
            change = {f: tags[f] for f in fields if f in tags and (eff.get(f) or "") != tags[f]
                      and not (f in req.keep and (eff.get(f) or "").strip())}
            if change:
                todo.append((row, change))
        res: dict = {"staged": True}
        if todo:
            step = staging.Step(conn, f"MusicBrainz: {rel['album']} ({len(todo)} tracks)")
            for row, change in todo:
                staging.stage_edit(conn, row, change, step)
            res = _finish(conn, step, [r["id"] for r, _ in todo])
    covered = folders = 0
    if req.cover and rows:
        cfg = load_app_settings()
        try:
            with db() as conn:
                if cfg.cover_target in ("folder", "both"):
                    mime, data = await asyncio.to_thread(_fetch_caa, req.mb_album_id, _caa_size(cfg.cover_folder_size))
                    for d in {r["directory"] for r in rows.values()}:
                        try:
                            covers.write_folder(conn, d, mime, data, cfg.cover_folder_size)
                            folders += 1
                        except Exception as e:  # noqa: BLE001
                            errors.append({"id": None, "error": f"folder cover: {e}"})
                if cfg.cover_target in ("tracks", "both"):
                    mime, data = await asyncio.to_thread(_fetch_caa, req.mb_album_id, _caa_size(cfg.cover_embed_size))
                    for row in rows.values():
                        try:
                            covers.set_track(conn, row, mime, data, cfg.cover_embed_size)
                            covered += 1
                        except Exception as e:  # noqa: BLE001 -- report per file
                            errors.append({"id": row["id"], "error": f"cover: {e}"})
        except Exception as e:  # noqa: BLE001
            errors.append({"id": None, "error": f"cover art: {e}"})
    return {**res, "changed": len(todo), "covers": covered, "folder_covers": folders,
            "errors": errors + res.get("errors", [])}
