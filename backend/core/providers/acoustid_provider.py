from __future__ import annotations

import asyncio

import musicbrainzngs

from core.providers.base import TrackMetadata
from core.providers.musicbrainz import _MB_INCLUDES, recording_to_metadata


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
        for score, recording_id, title, artist in matches:
            if not recording_id:
                continue
            try:
                resp = musicbrainzngs.get_recording_by_id(recording_id, includes=_MB_INCLUDES)
                meta = recording_to_metadata(resp.get("recording", {}), source="acoustid", score=score)
            except Exception:
                # MB enrichment failed — include the basic AcoustID result
                meta = TrackMetadata(
                    title=title,
                    artist=artist,
                    mb_track_id=recording_id,
                    source="acoustid",
                    score=score,
                )
            results.append(meta)
        return results
