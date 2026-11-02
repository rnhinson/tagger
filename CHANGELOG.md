# Changelog

## Unreleased

### Staged changes (beartums fork)
- **Review before writing.** Edits, auto-fix, find/replace, auto-number and
  Organize are held as staged changes; the topbar **Review N changes** button
  shows a field-by-field diff and planned moves, and writes them as one
  undoable change (or discards them, all or per track). Settings → *Review
  changes before writing* turns it off. Cover art and ReplayGain still write
  immediately.
- The track list shows staged values in place (amber, with the on-file value
  on hover); rows with a planned move are marked.
- **History** dialog: every change, undo any of them newest-first per track.
- **Undo staged steps.** Each staging action (save, bulk edit, organize,
  find/replace, auto-number) is a step, labelled by the fields it changed;
  ↶ undoes the newest staged step first, and Review has *Undo last step*.
  Writing or discarding a track drops it from the steps.

### Browsing (beartums fork)
- The Tags panel is a tree: tag (Artist, Album Artist, Album, Genre, Year,
  Composer) → its values with counts → (for artists) albums. `(none)` lists
  tracks missing that tag. `GET /api/library/tag-values`, and `tag`/`value`
  filters on `/tracks` and the M3U export.
- Folder tree shows an open/close arrow only on folders with subfolders.

### Safe moves (beartums fork)
- **Library roots**: rename templates are relative to the deepest root
  containing the file (`TAGGER_LIBRARY_ROOTS` or Settings, globs allowed),
  so Organize keeps files inside their library. Files outside every root are
  refused. Previously the template was relative to `TAGGER_MUSIC_DIR`, which
  could place files outside any mounted volume.
- Moves never overwrite, work across filesystems, handle case-only renames on
  case-insensitive shares, and prune the folders they empty. A move onto a
  different filesystem than the source is refused.
- **Undo of a move works across filesystems** (it used `Path.rename`, which
  fails with EXDEV), each track is committed on its own, and a partly failed
  undo stays retryable instead of being marked done.
- Settings PATCH only changes the fields sent (it used to reset the rest to
  defaults).

### Audio quality
- Per-file **spectrogram** in the tag editor, rendered on demand by ffmpeg and
  cached by track + mtime — a lossy transcode dressed up as lossless shows up
  as a hard frequency shelf the codec and bitrate columns can't reveal.
- Click the spectrogram to open it full size in a dismissible lightbox.

### Metadata
- MusicBrainz rate limiting (1 req/s) and retry-with-backoff.
- Edition picker: list the releases a recording appears on and tag from the
  one you actually own.
- Lyrics and compilation tag fields, written per format.

### Library & scanning
- Scan-exclude glob patterns, and an opt-in auto-rescan interval.
- Windowed album grid and lazy-loaded cover art, so large libraries stay
  responsive.
- Empty the trash from Settings.

### UI
- Drag-resizable sidebar and tag-editor panes; widths persist per browser and
  reset on double-click.
- Responsive layout for phones and tablets, visible focus outlines, and a
  keyboard-shortcut help modal on `?`.
- Per-file rename preview in the editor, and a context-aware empty state.

### Operations & hardening
- `GET /api/health` for liveness/version checks, exempt from auth.
- Configurable `TAGGER_LOG_LEVEL`, structured scan-job logging, a JSON 500
  handler, and OpenAPI docs at `/docs`.
- Security: symlink-aware path containment, a cap on cover uploads, UUID
  validation before Cover Art Archive fetches, and FTS query sanitizing.

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
