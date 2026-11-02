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
- **Sorting and the Quality/Format filters run on the server** over the whole
  view (every page), and combine with search. Numbers sort as numbers.
- **Select all N in this view**: after selecting the page, one click selects
  every track in the folder/tag/search across pages. The editor shows the
  values the whole selection shares (`POST /api/library/summary`).
- **Saving sends only the fields you changed** -- the form can stand for
  tracks on other pages, so re-sending untouched fields would overwrite them.

### Folders (beartums fork)
- **Move…** and **Rename…** a folder from the Files panel: staged, written
  as one directory move (cover art and other files come along), undone as
  one. Destination must be inside a library root; library roots themselves
  can't be moved. Review warns when a folder leaves Shared (Lidarr).
- **Drag and drop** in the Files tree: drag a folder onto a folder, or
  tracks (the selection, across pages) onto a folder -- each drop is a
  staged move. Hovering a closed folder while dragging opens it. Folders
  holding library roots can't be moved.
- Staging no longer reloads the folder tree, and a reload after a write
  keeps open folders open.
- **Rename files…** (PowerRename-style) for the selection: plain or regex
  search, `$1` / `${name}` / `$0` captures, `${start=,increment=,padding=}`
  counters, apply to name / extension / both, case formatting, and a live
  before/after preview with per-row opt-out. Clashes (same new name, an
  existing file, rename chains) are flagged and never staged.
- The default track order sorts disc/track numbers as numbers (it put 10
  before 2).
- **Review lists actions, not files**: one row per staging action ("Rename
  29 files", "Set genre on 120 tracks", newest first) with ↶ Undo on the
  newest; expand a row for one compact line per change. Changes staged
  outside an action (e.g. a move left by a failed write) appear under
  "Other staged changes". Steps now record their result (`after`);
  steps from earlier versions still list and undo, without details.

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
