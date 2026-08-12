# Changelog

## 0.2.0

A large feature and hardening release building on the 0.1 proof of concept.

### Metadata & tagging
- Composer and BPM tag fields.
- Discogs as an optional second metadata source (token-gated).
- Tag inference from a file's path/name ("From filename").
- Album flows: auto-number by filename, and find/replace within a tag.
- Case normalization for shouty/lowercase tags.

### Library & files
- Full-library or single-folder rescan, with a concurrent-scan guard.
- File operations: move to a recoverable trash, or reorganize on disk using
  the rename template — both undoable.
- "Keep best quality" de-duplicator on the duplicates panel.
- Audio-quality columns (bitrate / sample rate / channels).
- Undo/redo history for tag edits, bulk edits, renames, removals, deletes,
  and reorganizes.

### Playback, playlists, loudness
- Inline, range-streamed audio playback in the tag editor.
- Export the current view or search as an `.m3u` playlist.
- ReplayGain scanning via `rsgain`/`loudgain`, bundled in the Docker image.

### Access & operations
- Optional single-password authentication with login rate-limiting.
- Live rename-template preview in settings.
- Multi-arch (`amd64` + `arm64`) images published to GHCR on version tags;
  runs under Docker and Apple's `container` runtime.
- GitHub Actions CI (backend pytest + frontend typecheck/build).
- Test suite covering pure logic, the HTTP API, and real-audio round-trips.

## 0.1.0

Initial proof of concept: browse a library, read/edit tags for FLAC/MP3/
AAC-M4A/OGG, bulk edits, MusicBrainz/AcoustID lookup, cover art, and
template-based rename-on-save.
