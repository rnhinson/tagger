"""
Tag read/write for MP3, FLAC, AAC/M4A, and OGG Vorbis via mutagen.

Uses mutagen's Easy* interfaces for a unified key namespace across formats.
"""
from __future__ import annotations

from pathlib import Path
from typing import Any

import mutagen
from mutagen.easyid3 import EasyID3

AUDIO_EXTENSIONS = {".mp3", ".flac", ".m4a", ".aac", ".ogg", ".oga"}

# Mapping: internal field name → easy-tag key
_TO_EASY: dict[str, str] = {
    "title": "title",
    "artist": "artist",
    "album": "album",
    "album_artist": "albumartist",
    "year": "date",
    "genre": "genre",
    "track_number": "tracknumber",
    "disc_number": "discnumber",
    "comment": "comment",
}

_FROM_EASY: dict[str, str] = {v: k for k, v in _TO_EASY.items()}

# MusicBrainz ID fields — handled separately per format
_MB_TXXX = {
    "mb_track_id":        "MusicBrainz Track Id",
    "mb_artist_id":       "MusicBrainz Artist Id",
    "mb_album_id":        "MusicBrainz Album Id",
    "mb_album_artist_id": "MusicBrainz Album Artist Id",
}
_MB_VORBIS = {
    "mb_track_id":        "musicbrainz_trackid",
    "mb_artist_id":       "musicbrainz_artistid",
    "mb_album_id":        "musicbrainz_albumid",
    "mb_album_artist_id": "musicbrainz_albumartistid",
}


def _first(val: Any) -> str | None:
    if val is None:
        return None
    if isinstance(val, list):
        return str(val[0]) if val else None
    return str(val)


def read_tags(path: str | Path) -> dict:
    """Return normalised tag fields + duration/format for an audio file."""
    f = mutagen.File(str(path), easy=True)
    if f is None:
        return {}

    tags = f.tags or {}
    result: dict = {internal: _first(tags.get(easy)) for easy, internal in _FROM_EASY.items()}
    result["duration"] = getattr(f.info, "length", None)
    result["format"] = _detect_format(str(path))
    return result


def write_tags(path: str | Path, updates: dict) -> None:
    """
    Write tag updates to an audio file.
    Only keys present in `updates` are changed; others are left untouched.
    Pass None or "" for a key to delete that tag.
    """
    f = mutagen.File(str(path), easy=True)
    if f is None:
        raise ValueError(f"Cannot open audio file: {path}")
    if f.tags is None:
        f.add_tags()

    for internal_key, easy_key in _TO_EASY.items():
        if internal_key not in updates:
            continue
        val = updates[internal_key]
        if val is None or val == "":
            if easy_key in f.tags:
                del f.tags[easy_key]
        else:
            f.tags[easy_key] = [str(val)]

    f.save()

    mb_updates = {k: updates[k] for k in _MB_TXXX if k in updates}
    if mb_updates:
        _write_mb_ids(str(path), mb_updates)


def _write_mb_ids(path: str, mb_updates: dict) -> None:
    """Write MusicBrainz ID fields using format-specific raw APIs."""
    ext = Path(path).suffix.lower()

    if ext == ".mp3":
        from mutagen.id3 import ID3, TXXX
        try:
            tags = ID3(path)
        except Exception:
            tags = ID3()
        for field, val in mb_updates.items():
            desc = _MB_TXXX[field]
            tags.delall(f"TXXX:{desc}")
            if val:
                tags.add(TXXX(encoding=3, desc=desc, text=[val]))
        tags.save(path)

    elif ext == ".flac":
        from mutagen.flac import FLAC
        f = FLAC(path)
        for field, val in mb_updates.items():
            key = _MB_VORBIS[field]
            if val:
                f[key] = [val]
            elif key in f:
                del f[key]
        f.save()

    elif ext in (".ogg", ".oga"):
        from mutagen.oggvorbis import OggVorbis
        f = OggVorbis(path)
        for field, val in mb_updates.items():
            key = _MB_VORBIS[field]
            if val:
                f[key] = [val]
            elif key in f:
                del f[key]
        f.save()

    elif ext in (".m4a", ".aac"):
        from mutagen.mp4 import MP4, MP4FreeForm
        f = MP4(path)
        if f.tags is None:
            f.add_tags()
        for field, val in mb_updates.items():
            key = f"----:com.apple.iTunes:{_MB_TXXX[field]}"
            if val:
                f.tags[key] = [MP4FreeForm(val.encode())]
            elif key in f.tags:
                del f.tags[key]
        f.save()


def _detect_format(path: str) -> str:
    return {
        ".mp3": "mp3",
        ".flac": "flac",
        ".m4a": "aac",
        ".aac": "aac",
        ".ogg": "ogg",
        ".oga": "ogg",
    }.get(Path(path).suffix.lower(), "unknown")


def is_audio_file(path: str | Path) -> bool:
    return Path(path).suffix.lower() in AUDIO_EXTENSIONS


def read_cover(path: str | Path) -> tuple[str, bytes] | None:
    """Return (mime_type, image_data) for the embedded cover art, or None."""
    p = str(path)
    ext = Path(path).suffix.lower()
    try:
        if ext == ".mp3":
            from mutagen.id3 import ID3, APIC
            f = ID3(p)
            for tag in f.values():
                if isinstance(tag, APIC):
                    return tag.mime, tag.data

        elif ext == ".flac":
            from mutagen.flac import FLAC
            f = FLAC(p)
            if f.pictures:
                pic = f.pictures[0]
                return pic.mime, pic.data

        elif ext in (".m4a", ".aac"):
            from mutagen.mp4 import MP4, MP4Cover
            f = MP4(p)
            if f.tags and "covr" in f.tags:
                cover = f.tags["covr"][0]
                mime = "image/jpeg" if cover.imageformat == MP4Cover.FORMAT_JPEG else "image/png"
                return mime, bytes(cover)

        elif ext in (".ogg", ".oga"):
            from mutagen.oggvorbis import OggVorbis
            from mutagen.flac import Picture
            import base64
            f = OggVorbis(p)
            if "metadata_block_picture" in f:
                pic_data = base64.b64decode(f["metadata_block_picture"][0])
                pic = Picture(pic_data)
                return pic.mime, pic.data

    except Exception:
        pass
    return None


def write_cover(path: str | Path, mime_type: str, image_data: bytes) -> None:
    """Write (or replace) the embedded cover art for an audio file."""
    p = str(path)
    ext = Path(path).suffix.lower()

    if ext == ".mp3":
        from mutagen.id3 import ID3, APIC
        try:
            f = ID3(p)
        except Exception:
            from mutagen.id3 import ID3NoHeaderError
            f = ID3()
        f.delall("APIC")
        f.add(APIC(encoding=3, mime=mime_type, type=3, desc="Cover", data=image_data))
        f.save(p)

    elif ext == ".flac":
        from mutagen.flac import FLAC, Picture
        f = FLAC(p)
        f.clear_pictures()
        pic = Picture()
        pic.type = 3
        pic.mime = mime_type
        pic.data = image_data
        pic.width = pic.height = pic.depth = pic.colors = 0
        f.add_picture(pic)
        f.save()

    elif ext in (".m4a", ".aac"):
        from mutagen.mp4 import MP4, MP4Cover
        f = MP4(p)
        if f.tags is None:
            f.add_tags()
        fmt = MP4Cover.FORMAT_JPEG if mime_type == "image/jpeg" else MP4Cover.FORMAT_PNG
        f.tags["covr"] = [MP4Cover(image_data, imageformat=fmt)]
        f.save()

    elif ext in (".ogg", ".oga"):
        from mutagen.oggvorbis import OggVorbis
        from mutagen.flac import Picture
        import base64
        f = OggVorbis(p)
        pic = Picture()
        pic.type = 3
        pic.mime = mime_type
        pic.data = image_data
        pic.width = pic.height = pic.depth = pic.colors = 0
        f["metadata_block_picture"] = [base64.b64encode(pic.write()).decode("ascii")]
        f.save()

    else:
        raise ValueError(f"Cover art not supported for format: {ext}")
