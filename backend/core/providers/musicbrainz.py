from __future__ import annotations

import asyncio

import musicbrainzngs

from core.providers.base import MetadataProvider, TrackMetadata

musicbrainzngs.set_useragent("tagger", "0.1", "https://github.com/user/tagger")


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
        results: list[TrackMetadata] = []
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
            resp = musicbrainzngs.search_recordings(**params)
            for rec in resp.get("recording-list", []):
                release = (rec.get("release-list") or [{}])[0]
                credit = (rec.get("artist-credit") or [{}])[0]
                artist_info = credit.get("artist", {}) if isinstance(credit, dict) else {}
                release_credits = release.get("artist-credit") or []
                release_credit = release_credits[0] if release_credits else {}
                album_artist_info = release_credit.get("artist", {}) if isinstance(release_credit, dict) else {}
                medium = ((release.get("medium-list") or [{}])[0])
                track  = ((medium.get("track-list") or [{}])[0])
                track_number = track.get("number") or str(track.get("position", "")) or None
                disc_number  = str(medium.get("position", "")) if medium.get("position") else None
                results.append(
                    TrackMetadata(
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
                        source="musicbrainz",
                        score=int(rec.get("ext:score", 0)) / 100.0,
                        raw=rec,
                    )
                )
        except Exception:
            pass
        return results

    async def lookup_by_id(self, recording_id: str) -> TrackMetadata | None:
        return await asyncio.to_thread(self._lookup_sync, recording_id)

    def _lookup_sync(self, recording_id: str) -> TrackMetadata | None:
        try:
            resp = musicbrainzngs.get_recording_by_id(
                recording_id,
                includes=["artists", "releases", "release-groups"],
            )
            rec = resp.get("recording", {})
            release = (rec.get("release-list") or [{}])[0]
            credit = (rec.get("artist-credit") or [{}])[0]
            artist_info = credit.get("artist", {}) if isinstance(credit, dict) else {}
            release_credits = release.get("artist-credit") or []
            release_credit = release_credits[0] if release_credits else {}
            album_artist_info = release_credit.get("artist", {}) if isinstance(release_credit, dict) else {}
            medium = ((release.get("medium-list") or [{}])[0])
            track  = ((medium.get("track-list") or [{}])[0])
            track_number = track.get("number") or str(track.get("position", "")) or None
            disc_number  = str(medium.get("position", "")) if medium.get("position") else None
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
                source="musicbrainz",
                score=1.0,
                raw=rec,
            )
        except Exception:
            return None
