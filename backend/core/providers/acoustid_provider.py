from __future__ import annotations

import asyncio

import musicbrainzngs

from core.providers.base import TrackMetadata
from core.providers.musicbrainz import _MB_INCLUDES, _with_retry, recording_to_metadata

ENRICH = 3          # recordings looked up on MusicBrainz per file


class AcoustIDProvider:
    """Identify audio by fingerprint via AcoustID, then enrich from MusicBrainz."""

    def __init__(self, api_key: str):
        self.api_key = api_key

    async def lookup(self, path: str, prefer_album: str | None = None) -> list[TrackMetadata]:
        return await asyncio.to_thread(self._lookup_sync, path, prefer_album)

    def _lookup_sync(self, path: str, prefer_album: str | None = None) -> list[TrackMetadata]:
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

        # The best few recordings only: each is a MusicBrainz request (one a
        # second), and a busy MusicBrainz used to leave every match bare.
        results: list[TrackMetadata] = []
        seen: set[str] = set()
        for score, recording_id, title, artist in sorted(matches, key=lambda m: -m[0]):
            if not recording_id or recording_id in seen:
                continue
            seen.add(recording_id)
            if len(seen) > ENRICH:
                break
            try:
                resp = _with_retry(musicbrainzngs.get_recording_by_id, recording_id, includes=_MB_INCLUDES + ["media"])
                meta = recording_to_metadata(resp.get("recording", {}), source="acoustid", score=score,
                                             prefer_album=prefer_album)
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
