from __future__ import annotations

from fastapi import APIRouter, File, Form, HTTPException, UploadFile
from fastapi.responses import Response

from pydantic import BaseModel

from core import covers
from core.database import db
from core.tagger import read_cover, write_cover

router = APIRouter()

_MAX_COVER_BYTES = 20 * 1024 * 1024  # 20 MB


class CoverAction(BaseModel):
    track_ids: list[int]
    action: str = ""
    dry_run: bool = False            # just the selection's album folders and what they hold


def _public_image(url: str) -> tuple[str, bytes]:
    """
    Download an image from a public http(s) URL. Refuses hosts that resolve to
    a private, loopback or link-local address (no reaching into the cluster).
    """
    import ipaddress
    import socket
    import urllib.parse
    import urllib.request
    def check(target: str) -> None:
        u = urllib.parse.urlparse(target.strip())
        if u.scheme not in ("http", "https") or not u.hostname:
            raise HTTPException(400, "Give an http(s) image URL")
        try:
            addrs = {a[4][0] for a in socket.getaddrinfo(u.hostname, u.port or (443 if u.scheme == "https" else 80))}
        except OSError:
            raise HTTPException(400, f"Can't resolve {u.hostname}")
        if any(not ipaddress.ip_address(a.split("%")[0]).is_global for a in addrs):
            raise HTTPException(400, "That address isn't on the public internet")

    class Checked(urllib.request.HTTPRedirectHandler):      # every redirect hop too
        def redirect_request(self, req, fp, code, msg, headers, newurl):
            check(newurl)
            return super().redirect_request(req, fp, code, msg, headers, newurl)

    check(url)
    req = urllib.request.Request(url.strip(), headers={"User-Agent": "tagger/0.2"})
    try:
        with urllib.request.build_opener(Checked).open(req, timeout=30) as r:
            mime = r.headers.get("Content-Type", "").split(";")[0].strip()
            data = r.read(_MAX_COVER_BYTES + 1)
    except HTTPException:
        raise
    except Exception as e:  # noqa: BLE001
        raise HTTPException(502, f"Download failed: {e}")
    if len(data) > _MAX_COVER_BYTES:
        raise HTTPException(413, "Cover image too large (max 20 MB)")
    if not mime.startswith("image/"):
        raise HTTPException(400, f"Not an image ({mime or 'no content type'})")
    return mime, data


@router.post("/set")
async def set_covers(track_ids: str = Form(...), file: UploadFile | None = File(None),
                     url: str = Form(""), mb_album_id: str = Form("")):
    """
    New cover art for the selection, from a file, a URL or the Cover Art
    Archive; written where Settings → Cover Art says (folder, tracks or both),
    shrunk to its sizes.
    """
    import asyncio
    import json
    from api.config import _load as load_settings
    from api.lookup import _UUID_RE, _caa_size, _fetch_caa
    from api.tags import _rows
    cfg = load_settings()
    ids = [int(i) for i in json.loads(track_ids)]
    if file is not None:
        if not file.content_type or not file.content_type.startswith("image/"):
            raise HTTPException(400, "File must be an image")
        data = await file.read(_MAX_COVER_BYTES + 1)
        if len(data) > _MAX_COVER_BYTES:
            raise HTTPException(413, "Cover image too large (max 20 MB)")
        art = {"any": (file.content_type, data)}
    elif mb_album_id:
        if not _UUID_RE.match(mb_album_id):
            raise HTTPException(400, "Invalid MusicBrainz album id")
        try:
            sizes = {"folder": cfg.cover_folder_size, "tracks": cfg.cover_embed_size}
            art = {k: await asyncio.to_thread(_fetch_caa, mb_album_id, _caa_size(v)) for k, v in sizes.items()}
        except Exception as e:  # noqa: BLE001
            raise HTTPException(502, f"Cover Art Archive: {e}")
    elif url:
        art = {"any": await asyncio.to_thread(_public_image, url)}
    else:
        raise HTTPException(400, "No image: give a file, a URL or a MusicBrainz release")
    pick = lambda k: art.get(k) or art["any"]
    out = {"folders": 0, "tracks": 0, "errors": []}
    with db() as conn:
        rows = _rows(conn, ids)
        if cfg.cover_target in ("folder", "both"):
            for d in sorted({r["directory"] for r in rows}):
                try:
                    covers.write_folder(conn, d, *pick("folder"), cfg.cover_folder_size)
                    out["folders"] += 1
                except Exception as e:  # noqa: BLE001
                    out["errors"].append({"id": None, "error": f"{d}: {e}"})
        if cfg.cover_target in ("tracks", "both"):
            for r in rows:
                try:
                    covers.set_track(conn, r, *pick("tracks"), cfg.cover_embed_size)
                    out["tracks"] += 1
                except Exception as e:  # noqa: BLE001
                    out["errors"].append({"id": r["id"], "error": str(e)})
    return out


@router.post("/albums")
def album_covers(req: CoverAction):
    """Move, copy or delete cover art for the selection's album folders (core/covers.py)."""
    if not req.dry_run and req.action not in covers.ACTIONS:
        raise HTTPException(400, f"Unknown action {req.action}")
    from api.config import _load as load_settings
    from api.tags import _rows
    cfg = load_settings()
    with db() as conn:
        by_dir: dict[str, list] = {}
        for r in _rows(conn, req.track_ids):
            by_dir.setdefault(r["directory"], []).append(r)
        if req.dry_run:
            folders = {r[0] for r in conn.execute("SELECT directory FROM folder_covers")}
            return {"albums": [{"directory": d, "track_ids": [r["id"] for r in rows],
                                "embedded": sum(1 for r in rows if r["has_cover"]), "folder": d in folders}
                               for d, rows in sorted(by_dir.items())]}
        results = []
        for d, rows in by_dir.items():
            try:
                results.append(covers.act(conn, d, rows, req.action, cfg.cover_folder_size, cfg.cover_embed_size))
            except Exception as e:  # noqa: BLE001 -- one album failing doesn't stop the rest
                results.append({"directory": d, "folder": 0, "tracks": 0, "errors": [], "note": str(e)})
    return {"albums": results}


@router.get("/{track_id}")
def get_cover(track_id: int):
    with db() as conn:
        row = conn.execute("SELECT path, directory FROM tracks WHERE id = ?", (track_id,)).fetchone()
    if not row:
        raise HTTPException(404, "Track not found")
    result = read_cover(row["path"])          # embedded, else the album folder's
    if not result:
        folder = covers.read_folder(row["directory"])
        result = folder[1:] if folder else None
    if not result:
        raise HTTPException(404, "No cover art")
    mime, data = result
    return Response(content=data, media_type=mime, headers={"Cache-Control": "max-age=3600"})


@router.post("/{track_id}")
async def set_cover(track_id: int, file: UploadFile = File(...)):
    with db() as conn:
        row = conn.execute("SELECT id, path FROM tracks WHERE id = ?", (track_id,)).fetchone()
    if not row:
        raise HTTPException(404, "Track not found")
    if not file.content_type or not file.content_type.startswith("image/"):
        raise HTTPException(400, "File must be an image")
    data = await file.read(_MAX_COVER_BYTES + 1)
    if len(data) > _MAX_COVER_BYTES:
        raise HTTPException(413, "Cover image too large (max 20 MB)")
    from api.config import _load as load_settings
    try:
        with db() as conn:
            covers.set_track(conn, row, file.content_type, data, load_settings().cover_embed_size)
    except ValueError as e:
        raise HTTPException(400, str(e))
    return {"ok": True}
