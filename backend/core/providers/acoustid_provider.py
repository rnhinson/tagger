from __future__ import annotations

import asyncio

import musicbrainzngs

from core.providers.base import TrackMetadata


class AcoustIDProvider:
    """Identify audio by fingerprint via AcoustID, then enrich from MusicBrainz."""

    def __init__(self, api_key: str):
        self.api_key = api_key

    async def lookup(self, path: str) -> list[TrackMetadata]:
        return await asyncio.to_thread(self._lookup_sync, path)

    def _lookup_sync(self, path: str) -> list[TrackMetadata]:
        import acoustid

        try:
            matches = list(acoustid.match(self.api_key, path))
        except acoustid.NoBackendError:
            raise RuntimeError(
                "fpcalc not found — install chromaprint: sudo apt install libchromaprint-tools"
            )
        except acoustid.FingerprintGenerationError as e:
            raise RuntimeError(f"Could not fingerprint audio: {e}")
        except Exception as e:
            raise RuntimeError(f"AcoustID lookup failed: {e}")

        results: list[TrackMetadata] = []
        for score, recording_id, _title, _artist in matches:
            if not recording_id:
                continue
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
                album_artist_info = (
                    release_credit.get("artist", {}) if isinstance(release_credit, dict) else {}
                )
                results.append(
                    TrackMetadata(
                        title=rec.get("title"),
                        artist=artist_info.get("name"),
                        album=release.get("title"),
                        album_artist=album_artist_info.get("name") or artist_info.get("name"),
                        year=(release.get("date") or "")[:4] or None,
                        mb_track_id=rec.get("id"),
                        mb_artist_id=artist_info.get("id"),
                        mb_album_id=release.get("id"),
                        mb_album_artist_id=album_artist_info.get("id"),
                        source="acoustid",
                        score=score,
                    )
                )
            except Exception:
                # MB enrichment failed — include basic AcoustID result
                results.append(
                    TrackMetadata(
                        title=_title,
                        artist=_artist,
                        mb_track_id=recording_id,
                        source="acoustid",
                        score=score,
                    )
                )
        return results
