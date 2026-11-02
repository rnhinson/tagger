from __future__ import annotations

import asyncio
import time

import musicbrainzngs

from core.providers.base import MetadataProvider, TrackMetadata

musicbrainzngs.set_useragent("tagger", "0.2", "https://github.com/rnhinson/tagger")
# MusicBrainz asks for at most one request per second; musicbrainzngs enforces
# this, but set it explicitly so bulk Auto-fix stays within policy.
musicbrainzngs.set_rate_limit(1.0, 1)

_MB_INCLUDES = ["artists", "releases", "release-groups"]


def _with_retry(fn, *args, attempts: int = 3, **kwargs):
    """Call a musicbrainzngs function, retrying transient errors with backoff."""
    delay = 1.0
    for i in range(attempts):
        try:
            return fn(*args, **kwargs)
        except musicbrainzngs.WebServiceError:
            if i == attempts - 1:
                raise
            time.sleep(delay)
            delay *= 2


def recording_to_metadata(rec: dict, *, source: str, score: float) -> TrackMetadata:
    """Convert a MusicBrainz recording dict into a normalised TrackMetadata."""
    release = (rec.get("release-list") or [{}])[0]
    credit = (rec.get("artist-credit") or [{}])[0]
    artist_info = credit.get("artist", {}) if isinstance(credit, dict) else {}
    release_credits = release.get("artist-credit") or []
    release_credit = release_credits[0] if release_credits else {}
    album_artist_info = release_credit.get("artist", {}) if isinstance(release_credit, dict) else {}
    medium = (release.get("medium-list") or [{}])[0]
    track = (medium.get("track-list") or [{}])[0]
    track_number = track.get("number") or str(track.get("position", "")) or None
    disc_number = str(medium.get("position", "")) if medium.get("position") else None
    return TrackMetadata(
        title=rec.get("title"),
        artist=artist_info.get("name"),
        album=release.get("title"),
        album_artist=album_artist_info.get("name") or artist_info.get("name"),
        year=(release.get("date") or "")[:4] or None,
        track_number=track_number,
        disc_number=disc_number,
        mb_track_id=rec.get("id"),
        mb_artist_id=artist_info.get("id"),
        mb_album_id=release.get("id"),
        mb_album_artist_id=album_artist_info.get("id"),
        source=source,
        score=score,
        raw=rec,
    )


class MusicBrainzProvider(MetadataProvider):
    name = "musicbrainz"

    async def search(
        self,
        *,
        title: str | None = None,
        artist: str | None = None,
        album: str | None = None,
        track_number: str | None = None,
        duration: float | None = None,
    ) -> list[TrackMetadata]:
        return await asyncio.to_thread(
            self._search_sync, title=title, artist=artist, album=album, duration=duration
        )

    def _search_sync(
        self,
        title: str | None,
        artist: str | None,
        album: str | None,
        duration: float | None = None,
    ) -> list[TrackMetadata]:
        params: dict = {
            "recording": title or "",
            "artist": artist or "",
            "release": album or "",
            "limit": 10,
        }
        if duration:
            tol = 5000  # ±5 seconds in milliseconds
            dur_ms = int(duration * 1000)
            params["dur"] = f"[{dur_ms - tol} TO {dur_ms + tol}]"
        try:
            resp = _with_retry(musicbrainzngs.search_recordings, **params)
        except Exception:
            return []
        return [
            recording_to_metadata(
                rec,
                source="musicbrainz",
                score=int(rec.get("ext:score", 0)) / 100.0,
            )
            for rec in resp.get("recording-list", [])
        ]

    async def lookup_by_id(self, recording_id: str) -> TrackMetadata | None:
        return await asyncio.to_thread(self._lookup_sync, recording_id)

    def _lookup_sync(self, recording_id: str) -> TrackMetadata | None:
        try:
            resp = _with_retry(musicbrainzngs.get_recording_by_id, recording_id, includes=_MB_INCLUDES)
        except Exception:
            return None
        return recording_to_metadata(resp.get("recording", {}), source="musicbrainz", score=1.0)

    async def list_releases(self, recording_id: str) -> list[dict]:
        return await asyncio.to_thread(self._releases_sync, recording_id)

    def _releases_sync(self, recording_id: str) -> list[dict]:
        """Return the distinct releases (editions) a recording appears on."""
        try:
            resp = _with_retry(
                musicbrainzngs.get_recording_by_id,
                recording_id, includes=["releases", "media", "release-groups"],
            )
        except Exception:
            return []
        out = []
        for rel in resp.get("recording", {}).get("release-list", []):
            medium = (rel.get("medium-list") or [{}])[0]
            out.append({
                "mb_album_id": rel.get("id"),
                "album": rel.get("title"),
                "year": (rel.get("date") or "")[:4] or None,
                "country": rel.get("country"),
                "format": medium.get("format"),
                "track_count": medium.get("track-count"),
            })
        return out


# ── Releases (album-level matching, core/albummatch.py) ───────────────────────

_RELEASE_CACHE: dict[str, tuple[float, dict]] = {}
_RELEASE_TTL = 900.0


def _candidate(rel: dict, score: float | None = None) -> dict:
    media = rel.get("medium-list") or []
    return {
        "mb_album_id": rel.get("id"),
        "album": rel.get("title"),
        "artist": rel.get("artist-credit-phrase"),
        "date": rel.get("date"),
        "country": rel.get("country"),
        "formats": sorted({m.get("format") for m in media if m.get("format")}),
        "discs": len(media) or None,
        "tracks": int(rel["medium-track-count"]) if rel.get("medium-track-count") else
                  sum(int(m.get("track-count") or 0) for m in media) or None,
        "type": (rel.get("release-group") or {}).get("primary-type") or (rel.get("release-group") or {}).get("type"),
        "score": score if score is not None else int(rel.get("ext:score", 0)) / 100.0,
    }


def search_releases(album: str | None, artist: str | None, limit: int = 15) -> list[dict]:
    """Release candidates for an album title and/or artist, best first."""
    params: dict = {"limit": limit}
    if album:
        params["release"] = album
    if artist:
        params["artist"] = artist
    if len(params) == 1:
        return []
    try:
        resp = _with_retry(musicbrainzngs.search_releases, **params)
    except Exception:
        return []
    return [_candidate(rel) for rel in resp.get("release-list", [])]


def releases_with_recording(title: str, artist: str | None, limit: int = 25) -> list[dict]:
    """Releases containing a recording with this title (+ artist): 'which album is this track on?'"""
    params = {"recording": title, "limit": limit}
    if artist:
        params["artist"] = artist
    try:
        resp = _with_retry(musicbrainzngs.search_recordings, **params)
    except Exception:
        return []
    out, seen = [], set()
    for rec in resp.get("recording-list", []):
        score = int(rec.get("ext:score", 0)) / 100.0
        for rel in rec.get("release-list", []):
            if rel.get("id") in seen:
                continue
            seen.add(rel.get("id"))
            c = _candidate(rel, score)
            c["artist"] = c["artist"] or rec.get("artist-credit-phrase")
            out.append(c)
    return out[:40]


def get_release(mb_album_id: str) -> dict | None:
    """One release with every track (cached: the match and the apply both need it)."""
    hit = _RELEASE_CACHE.get(mb_album_id)
    if hit and time.time() - hit[0] < _RELEASE_TTL:
        return hit[1]
    try:
        resp = _with_retry(musicbrainzngs.get_release_by_id, mb_album_id,
                           includes=["recordings", "artist-credits", "release-groups", "media"])
    except Exception:
        return None
    rel = resp.get("release") or {}
    credits = [c for c in rel.get("artist-credit") or [] if isinstance(c, dict)]
    aa_id = credits[0]["artist"]["id"] if credits and credits[0].get("artist") else None
    rg = rel.get("release-group") or {}
    out = {
        "mb_album_id": rel.get("id"),
        "album": rel.get("title"),
        "album_artist": rel.get("artist-credit-phrase"),
        "mb_album_artist_id": aa_id,
        "date": rel.get("date"),
        "original_year": (rg.get("first-release-date") or "")[:4] or None,
        "year": (rel.get("date") or "")[:4] or None,
        "country": rel.get("country"),
        "tracks": [],
    }
    for medium in rel.get("medium-list") or []:
        disc = int(medium.get("position") or 1)
        for t in medium.get("track-list") or []:
            rec = t.get("recording") or {}
            rcred = [c for c in rec.get("artist-credit") or [] if isinstance(c, dict)]
            length = t.get("length") or rec.get("length")
            out["tracks"].append({
                "key": f"{disc}-{t.get('position')}",
                "disc": disc,
                "position": int(t.get("position") or 0),
                "number": t.get("number"),
                "title": t.get("title") or rec.get("title"),
                "artist": t.get("artist-credit-phrase") or rec.get("artist-credit-phrase") or out["album_artist"],
                "mb_artist_id": rcred[0]["artist"]["id"] if rcred and rcred[0].get("artist") else aa_id,
                "mb_track_id": rec.get("id"),
                "duration": int(length) / 1000 if length else None,
            })
    out["discs"] = len({t["disc"] for t in out["tracks"]})
    _RELEASE_CACHE[mb_album_id] = (time.time(), out)
    return out
