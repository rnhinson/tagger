"""
Discogs metadata provider.

Discogs search is release-level (not per-track), so results fill in
album/artist/year but leave title untouched — useful as a second opinion
alongside MusicBrainz. Requires a free personal-access token.
"""
from __future__ import annotations

import asyncio
import json
import urllib.parse
import urllib.request

from core.providers.base import TrackMetadata

_SEARCH_URL = "https://api.discogs.com/database/search"
_USER_AGENT = "tagger/0.1 +https://github.com/user/tagger"


class DiscogsProvider:
    name = "discogs"

    def __init__(self, token: str):
        self.token = token

    async def search(
        self,
        *,
        title: str | None = None,
        artist: str | None = None,
        album: str | None = None,
    ) -> list[TrackMetadata]:
        return await asyncio.to_thread(self._search_sync, title, artist, album)

    def _search_sync(
        self, title: str | None, artist: str | None, album: str | None
    ) -> list[TrackMetadata]:
        params = {"type": "release", "per_page": 8, "token": self.token}
        if artist:
            params["artist"] = artist
        if album:
            params["release_title"] = album
        if title and not album:
            params["track"] = title
        if not (artist or album or title):
            return []

        url = f"{_SEARCH_URL}?{urllib.parse.urlencode(params)}"
        req = urllib.request.Request(url, headers={"User-Agent": _USER_AGENT})
        try:
            with urllib.request.urlopen(req, timeout=15) as resp:
                data = json.loads(resp.read().decode("utf-8"))
        except Exception:
            return []

        results: list[TrackMetadata] = []
        for item in data.get("results", []):
            r_artist, r_album = _split_title(item.get("title", ""))
            year = str(item.get("year")) if item.get("year") else None
            results.append(
                TrackMetadata(
                    title=title,  # echo the query title; Discogs search is release-level
                    artist=r_artist or artist,
                    album=r_album or album,
                    album_artist=r_artist or artist,
                    year=year,
                    genre=(item.get("genre") or [None])[0],
                    source="discogs",
                    score=0.6,
                    raw={"discogs_id": item.get("id"), "cover_image": item.get("cover_image")},
                )
            )
        return results


def _split_title(title: str) -> tuple[str | None, str | None]:
    """Discogs release titles look like 'Artist - Album'."""
    if " - " in title:
        artist, album = title.split(" - ", 1)
        return artist.strip() or None, album.strip() or None
    return None, title.strip() or None
