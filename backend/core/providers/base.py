from __future__ import annotations

from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from typing import Optional


@dataclass
class TrackMetadata:
    title: Optional[str] = None
    artist: Optional[str] = None
    album: Optional[str] = None
    album_artist: Optional[str] = None
    year: Optional[str] = None
    genre: Optional[str] = None
    track_number: Optional[str] = None
    disc_number: Optional[str] = None
    mb_track_id: Optional[str] = None
    mb_artist_id: Optional[str] = None
    mb_album_id: Optional[str] = None
    mb_album_artist_id: Optional[str] = None
    # Provider metadata
    source: str = ""
    score: float = 0.0
    raw: dict = field(default_factory=dict)


class MetadataProvider(ABC):
    """Abstract base for metadata lookup providers (MusicBrainz, Discogs, etc.)."""

    name: str = ""

    @abstractmethod
    async def search(
        self,
        *,
        title: str | None = None,
        artist: str | None = None,
        album: str | None = None,
        track_number: str | None = None,
    ) -> list[TrackMetadata]:
        """Search for tracks matching the given metadata. Returns ranked results."""
        ...

    @abstractmethod
    async def lookup_by_id(self, provider_id: str) -> TrackMetadata | None:
        """Fetch full metadata for a known provider-specific ID."""
        ...
