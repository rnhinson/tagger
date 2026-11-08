"""
Album cover art in its two places: an image in the album folder (cover.jpg,
which Plex, Jellyfin and Navidrome read) and art embedded in each track.
The `cover_target` setting picks where new art goes; act() moves, copies or
deletes it per album folder. Anything removed goes to the trash first.
"""
from __future__ import annotations

import os
import shutil
import uuid
from pathlib import Path

from core.config import settings
from core.fileops import IMAGE_EXTS
from core.tagger import cover_info, image_size, read_cover, remove_cover, write_cover

NAMES = ("cover", "folder", "front", "album", "albumart")     # most to least conventional
TARGETS = ("folder", "tracks", "both")
ACTIONS = ("copy_to_folder", "move_to_folder", "copy_to_tracks", "move_to_tracks",
           "delete_folder", "delete_tracks", "shrink")
_EXT = {"image/jpeg": ".jpg", "image/png": ".png", "image/webp": ".webp", "image/gif": ".gif"}
_MIME = {".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".webp": "image/webp",
         ".gif": "image/gif", ".bmp": "image/bmp"}


def fit(mime: str, data: bytes, size: int) -> tuple[str, bytes]:
    """
    Shrink to `size` px on the longest side (0 = as is), saved as JPEG (PNG if
    it has transparency). Already small enough, or not an image Pillow reads: unchanged.
    """
    if not size:
        return mime, data
    from io import BytesIO
    from PIL import Image
    try:
        img = Image.open(BytesIO(data))
        if max(img.size) <= size:
            return mime, data
        img.thumbnail((size, size), Image.Resampling.LANCZOS)
        out = BytesIO()
        if img.mode in ("RGBA", "LA") or (img.mode == "P" and "transparency" in img.info):
            img.save(out, "PNG", optimize=True)
            return "image/png", out.getvalue()
        img.convert("RGB").save(out, "JPEG", quality=90, optimize=True)
        return "image/jpeg", out.getvalue()
    except Exception:  # noqa: BLE001 -- unreadable: keep the original rather than fail the write
        return mime, data


def folder_image(files) -> str | None:
    """The folder's cover among its file names: cover/folder/front/album(art).<image>."""
    imgs = {Path(f).stem.lower(): f for f in sorted(files) if Path(f).suffix.lower() in IMAGE_EXTS}
    return next((imgs[n] for n in NAMES if n in imgs), None)


def record_folder(conn, directory: str, name: str | None, data: bytes | None = None) -> None:
    """Note the folder's cover (or none). Its size is read only when new or changed."""
    if not name:
        conn.execute("DELETE FROM folder_covers WHERE directory = ?", (directory,))
        return
    p = Path(directory) / name
    if data is None:
        try:
            nbytes = p.stat().st_size
        except OSError:
            return
        had = conn.execute("SELECT name, bytes, width FROM folder_covers WHERE directory = ?", (directory,)).fetchone()
        if had and had[0] == name and had[1] == nbytes and had[2]:
            return
        try:
            data = p.read_bytes()
        except OSError:
            return
    w, h = image_size(data)
    conn.execute("INSERT OR REPLACE INTO folder_covers (directory, name, width, height, bytes) VALUES (?, ?, ?, ?, ?)",
                 (directory, name, w, h, len(data)))


def read_folder(directory: str) -> tuple[Path, str, bytes] | None:
    """(path, mime, data) of the folder's cover, read from disk (the DB may be stale)."""
    try:
        name = folder_image(os.listdir(directory))
    except OSError:
        return None
    if not name:
        return None
    p = Path(directory) / name
    return p, _MIME.get(p.suffix.lower(), "image/jpeg"), p.read_bytes()


def _trash_dir() -> Path:
    d = settings.config_dir / "trash"
    d.mkdir(parents=True, exist_ok=True)
    return d


def _trash(p: Path) -> None:
    shutil.move(str(p), str(_trash_dir() / f"cover_{uuid.uuid4().hex[:8]}_{p.name}"))


def write_folder(conn, directory: str, mime: str, data: bytes, size: int = 0) -> Path:
    """Write the folder's cover.<ext> (shrunk to `size`); one already there goes to the trash."""
    mime, data = fit(mime, data, size)
    old = read_folder(directory)
    dest = Path(directory) / ("cover" + _EXT.get(mime, ".jpg"))
    if old:
        _trash(old[0])
    dest.write_bytes(data)
    record_folder(conn, directory, dest.name, data)
    return dest


def _note_track(conn, row, data: bytes | None) -> None:
    info = cover_info(data)
    conn.execute("UPDATE tracks SET has_cover = :has_cover, cover_width = :cover_width, cover_height = :cover_height,"
                 " cover_bytes = :cover_bytes WHERE id = :id", {**info, "id": row["id"]})


def set_track(conn, row, mime: str, data: bytes, size: int = 0) -> None:
    mime, data = fit(mime, data, size)
    write_cover(row["path"], mime, data)
    _note_track(conn, row, data)


def clear_track(conn, row) -> None:
    remove_cover(row["path"])
    _note_track(conn, row, None)


def _too_big(data: bytes, size: int) -> bool:
    w, h = image_size(data)
    return bool(size and w and max(w, h or 0) > size)


def act(conn, directory: str, rows: list, action: str, folder_size: int = 0, embed_size: int = 0) -> dict:
    """
    One album folder; `rows` are its selected tracks. Returns what happened.
    Art written is shrunk to folder_size / embed_size (0 = as is).
    """
    out = {"directory": directory, "folder": 0, "tracks": 0, "errors": [], "note": None}

    def each(fn, *args):
        for r in rows:
            try:
                fn(conn, r, *args)
                out["tracks"] += 1
            except Exception as e:  # noqa: BLE001 -- report per file
                out["errors"].append({"id": r["id"], "error": str(e)})

    embedded = [(r, a) for r in rows if (a := read_cover(r["path"]))]
    if action in ("copy_to_folder", "move_to_folder"):
        if not embedded:
            out["note"] = "no track has cover art"
            return out
        write_folder(conn, directory, *embedded[0][1], folder_size)
        out["folder"] = 1
        if action == "move_to_folder":
            rows = [r for r, _ in embedded]
            each(clear_track)
    elif action in ("copy_to_tracks", "move_to_tracks"):
        f = read_folder(directory)
        if not f:
            out["note"] = "no folder cover"
            return out
        each(set_track, f[1], f[2], embed_size)
        if action == "move_to_tracks" and not out["errors"]:
            _trash(f[0])
            record_folder(conn, directory, None)
            out["folder"] = 1
    elif action == "delete_folder":
        f = read_folder(directory)
        if not f:
            out["note"] = "no folder cover"
            return out
        _trash(f[0])
        record_folder(conn, directory, None)
        out["folder"] = 1
    elif action == "delete_tracks":
        if not embedded:
            out["note"] = "no track has cover art"
            return out
        mime, data = embedded[0][1]        # one copy kept in the trash
        (_trash_dir() / f"cover_{uuid.uuid4().hex[:8]}_{Path(directory).name}{_EXT.get(mime, '.jpg')}").write_bytes(data)
        rows = [r for r, _ in embedded]
        each(clear_track)
    elif action == "shrink":
        f = read_folder(directory)
        if f and _too_big(f[2], folder_size):
            write_folder(conn, directory, f[1], f[2], folder_size)     # the original goes to the trash
            out["folder"] = 1
        rows = [r for r, (_, data) in embedded if _too_big(data, embed_size)]
        art = {r["id"]: a for r, a in embedded}
        for r in rows:
            try:
                set_track(conn, r, *art[r["id"]], embed_size)
                out["tracks"] += 1
            except Exception as e:  # noqa: BLE001
                out["errors"].append({"id": r["id"], "error": str(e)})
        if not out["folder"] and not rows:
            out["note"] = "nothing larger than the size settings"
    else:
        raise ValueError(f"unknown action {action}")
    return out
