import { LOGO_MARK } from './logo'

export const APP_HTML = `
  <header class="topbar">
    <button id="sidebar-toggle" class="btn btn-ghost btn-icon" title="Toggle sidebar" aria-label="Toggle sidebar">☰</button>
    <a id="logo" class="logo" href="#" title="Home: all tracks">${LOGO_MARK}Tagger</a>
    <div class="search-wrap">
      <input id="search" class="search-input" type="search" placeholder="Search tracks…" aria-label="Search tracks" autocomplete="off" />
    </div>
    <div class="topbar-actions">
      <button id="scan-status" class="scan-status" type="button" title="Scan progress — click for details" hidden></button>
      <button id="review-btn" class="btn btn-review btn-sm" title="Review staged changes, then write them to the files" hidden></button>
      <button id="undo-btn" class="btn btn-ghost btn-icon" title="Undo last change" aria-label="Undo last change" hidden>↶</button>
      <button id="cleanup-btn" class="btn btn-ghost btn-sm" title="Standardize tag separators (Folk/Celtic → Folk; Celtic)">Clean up</button>
      <button id="history-btn" class="btn btn-ghost btn-sm" title="Change history and undo">History</button>
      <button id="scan-btn" class="btn btn-ghost btn-sm scan-btn" title="Scan the whole library">Scan all</button>
      <button id="settings-btn" class="btn btn-ghost btn-icon" title="Settings" aria-label="Settings">⚙</button>
    </div>
  </header>

  <aside id="settings-sidebar" class="settings-sidebar settings-page">
    <div class="settings-sidebar-header">
      <nav class="settings-tabs" role="tablist">
        <button class="settings-tab active" data-tab="settings" role="tab">Settings</button>
        <button class="settings-tab" data-tab="background" role="tab">Background <span id="bg-dot" class="bg-dot" hidden></span></button>
        <button class="settings-tab" data-tab="about" role="tab">About</button>
      </nav>
      <button id="settings-modal-close" class="btn btn-ghost btn-icon" aria-label="Close settings">✕</button>
    </div>
    <div id="pane-background" class="settings-sidebar-body settings-pane" hidden></div>
    <div id="pane-about" class="settings-sidebar-body settings-pane" hidden></div>
    <div id="pane-settings" class="settings-sidebar-body settings-pane">
      <nav class="settings-subnav" role="tablist" aria-label="Settings sections">
        <button type="button" data-sect="libraries" class="active">Libraries</button>
        <button type="button" data-sect="layouts">Layouts</button>
        <button type="button" data-sect="groups">Groups</button>
        <button type="button" data-sect="scanning">Scanning</button>
        <button type="button" data-sect="sources">Sources</button>
        <button type="button" data-sect="writing">Writing</button>
      </nav>
      <div class="settings-sect" data-sect="libraries">
      <div class="settings-section">
        <div class="settings-section-title">Libraries</div>
        <p class="settings-hint">A full scan covers the libraries switched on. Switching one off removes its tracks from Tagger (files untouched); switching it on scans it. 🔒 = read-only: shown, never written. <strong>Group</strong>: the group its tracks are in unless put in another (Groups).</p>
        <table class="settings-table libraries-table"><thead><tr><th>On</th><th>Library</th><th>Tracks</th><th>Group</th></tr></thead>
          <tbody id="libraries-list"></tbody></table>
      </div>
      <div class="settings-section">
        <div class="settings-section-title">Library Roots</div>
        <p class="settings-hint">Folders layouts are relative to — each file is organized inside the deepest root that contains it, never outside. One per line; <code>*</code> matches each subfolder (e.g. <code>/music/Libraries/*</code>). Empty uses <span id="library-roots-default"></span>.</p>
        <label class="field-label">Roots
          <textarea id="setting-library-roots" rows="3" placeholder="/music/Shared&#10;/music/Libraries/*"></textarea>
        </label>
        <div id="library-roots-effective" class="settings-hint"></div>
      </div>
      <div class="settings-section">
        <div class="settings-section-title">Music Directories</div>
        <p class="settings-hint">Directories scanned for audio files when no library roots are set. The default from <code>TAGGER_MUSIC_DIR</code> is always included.</p>
        <div id="music-dirs-default" class="music-dir-row music-dir-default"></div>
        <ul id="music-dirs-list" class="music-dirs-list"></ul>
        <div class="music-dir-add-row">
          <input id="music-dir-input" type="text" placeholder="Absolute path, e.g. /mnt/data/Music" />
          <button id="music-dir-add-btn" class="btn btn-ghost btn-sm">Add</button>
        </div>
      </div>
      </div>
      <div class="settings-sect" data-sect="layouts" hidden>
      <div class="settings-section">
        <div class="settings-section-title">Layouts</div>
        <p class="settings-hint">A track uses the first layout set: <strong>1.</strong> its group's, <strong>2.</strong> its library's, <strong>3.</strong> the standard one. Libraries with <strong>Check</strong> on are compared — tracks elsewhere are listed under Quality → <em>Not in layout</em>, to re-file the ones you choose.</p>
        <label class="field-label" id="rename-template-wrap">Standard layout
          <input id="setting-rename-template" type="text" spellcheck="false" />
          <div id="rename-preview" class="rename-preview"></div>
        </label>
        <p class="settings-hint">Where a file belongs, relative to its library. Variables: {title} {artist} {album} {album_artist} {year} {genre} {track_number:02d} {disc_number}, and {artist_the} {album_artist_the} {album_the} ("The Pogues" → "Pogues, The", as Lidarr names folders).</p>
        <label class="settings-toggle">
          <input id="setting-rename-on-save" type="checkbox" />
          <span>Rename files on save — saving a track's tags also plans a move to where its layout puts it</span>
        </label>
      </div>
      <div class="settings-section">
        <div class="settings-section-title">Library layouts</div>
        <table class="settings-table layouts-table"><thead><tr><th>Check</th><th>Library</th><th>Layout <span class="ma-dim">(blank: standard)</span></th></tr></thead>
          <tbody id="library-layouts-list"></tbody></table>
      </div>
      <div class="settings-section">
        <div class="settings-section-title">Group layouts</div>
        <p class="settings-hint">For tracks put in the group by hand (<strong>Group…</strong> on a selection). Blank: the library's layout.</p>
        <table class="settings-table layouts-table"><thead><tr><th>Group</th><th>Layout <span class="ma-dim">(blank: library's)</span></th></tr></thead>
          <tbody id="group-layouts-list"></tbody></table>
      </div>
      </div>
      <div class="settings-sect" data-sect="groups" hidden>
      <div class="settings-section">
        <div class="settings-section-title">Groups</div>
        <p class="settings-hint">A track's group: the one it was put in (<strong>Group…</strong> on a selection), else its library's (Libraries), else Standard. A group sets how lyrics are looked up on LRCLIB — queries tried in order until one finds them; a query with no artist searches by title + album (cast recordings) — and can set a layout (Layouts). <strong>Skip</strong>: never looked up, not counted as missing lyrics.</p>
        <p class="settings-hint">Variables: {title} {artist} {album} {album_artist} {year}, {title_base} {album_base} (without trailing "(…)", "[…]", "- From …"), {artist_first} {album_artist_first} (the first of several).</p>
        <div id="lyrics-groups-list" class="lyrics-groups-list"></div>
        <button type="button" id="lyrics-group-add" class="btn btn-ghost btn-sm">Add group</button>
      </div>
      </div>
      <div class="settings-sect" data-sect="scanning" hidden>
      <div class="settings-section">
        <div class="settings-section-title">Scan Tags</div>
        <p class="settings-hint">Choose which tags are read from audio files during a library scan. Disabled tags will be left empty in the database.</p>
        <div id="scan-tags-list" class="scan-tags-list">
          <label class="settings-toggle"><input type="checkbox" data-tag="title" /><span>Title</span></label>
          <label class="settings-toggle"><input type="checkbox" data-tag="artist" /><span>Artist</span></label>
          <label class="settings-toggle"><input type="checkbox" data-tag="album" /><span>Album</span></label>
          <label class="settings-toggle"><input type="checkbox" data-tag="album_artist" /><span>Album Artist</span></label>
          <label class="settings-toggle"><input type="checkbox" data-tag="year" /><span>Year</span></label>
          <label class="settings-toggle"><input type="checkbox" data-tag="genre" /><span>Genre</span></label>
          <label class="settings-toggle"><input type="checkbox" data-tag="track_number" /><span>Track Number</span></label>
          <label class="settings-toggle"><input type="checkbox" data-tag="disc_number" /><span>Disc Number</span></label>
          <label class="settings-toggle"><input type="checkbox" data-tag="comment" /><span>Comment</span></label>
          <label class="settings-toggle"><input type="checkbox" data-tag="composer" /><span>Composer</span></label>
          <label class="settings-toggle"><input type="checkbox" data-tag="bpm" /><span>BPM</span></label>
          <label class="settings-toggle"><input type="checkbox" data-tag="lyrics" /><span>Lyrics</span></label>
          <label class="settings-toggle"><input type="checkbox" data-tag="compilation" /><span>Compilation</span></label>
        </div>
      </div>
      <div class="settings-section">
        <div class="settings-section-title">Scan Options</div>
        <label class="field-label">Exclude patterns
          <textarea id="setting-scan-exclude" rows="3" placeholder="One glob per line — e.g. *Podcasts*  or  ._*"></textarea>
          <span class="settings-hint">Files or folders matching any pattern are skipped during scans.</span>
        </label>
        <label class="field-label">Auto-rescan interval (minutes)
          <input id="setting-auto-scan" type="number" min="0" step="1" />
          <span class="settings-hint">Automatically rescan the library on this interval. 0 disables it.</span>
        </label>
        <div class="scan-now-row"><button type="button" class="btn btn-ghost btn-sm" data-scan-now>Scan library now</button>
          <span class="settings-hint">Progress and Cancel are on the Background tab.</span></div>
      </div>
      </div>
      <div class="settings-sect" data-sect="sources" hidden>
      <p id="secrets-note" class="settings-hint"></p>
      <div class="settings-section">
        <div class="settings-section-title">AcoustID</div>
        <p class="settings-hint">Identifies audio by fingerprint — much more accurate than text search. Get a free application API key at <span class="settings-link">acoustid.org</span>.</p>
        <label class="field-label">API Key
          <span class="secret-row"><input id="setting-acoustid-key" data-secret="acoustid_api_key" type="password" autocomplete="off" placeholder="Paste your AcoustID API key…" data-placeholder="Paste your AcoustID API key…" /><button type="button" class="btn btn-ghost btn-sm" data-secret-remove hidden>Remove</button><button type="button" class="btn btn-ghost btn-sm" data-source-test="acoustid" title="Check it with the service (what you typed, else the saved one)">Test</button></span>
        </label>
        <div class="source-test-result" data-test-result="acoustid" hidden></div>
        <div id="acoustid-status" class="acoustid-status"></div>
      </div>
      <div class="settings-section">
        <div class="settings-section-title">Discogs</div>
        <p class="settings-hint">Optional second metadata source. Supplements MusicBrainz text search with release-level matches. Get a personal-access token from your Discogs account's developer settings.</p>
        <label class="field-label">Token
          <span class="secret-row"><input id="setting-discogs-token" data-secret="discogs_token" type="password" autocomplete="off" placeholder="Paste your Discogs token…" data-placeholder="Paste your Discogs token…" /><button type="button" class="btn btn-ghost btn-sm" data-secret-remove hidden>Remove</button><button type="button" class="btn btn-ghost btn-sm" data-source-test="discogs" title="Check it with the service (what you typed, else the saved one)">Test</button></span>
        </label>
        <div class="source-test-result" data-test-result="discogs" hidden></div>
      </div>
      <div class="settings-section">
        <div class="settings-section-title">LRCLIB (lyrics)</div>
        <p class="settings-hint">Free, no key needed: about 90 lookups a minute, spaced out automatically. Register an app at <span class="settings-link">lrclib.net/developers</span> (server-side) and paste its app ID and key for a far higher limit.</p>
        <label class="field-label">App ID
          <input id="setting-lrclib-app-id" type="text" autocomplete="off" spellcheck="false" placeholder="Optional" />
        </label>
        <label class="field-label">API key
          <span class="secret-row"><input id="setting-lrclib-key" data-secret="lrclib_api_key" type="password" autocomplete="off" placeholder="Optional" data-placeholder="Optional" /><button type="button" class="btn btn-ghost btn-sm" data-secret-remove hidden>Remove</button><button type="button" class="btn btn-ghost btn-sm" data-source-test="lrclib" title="Check it with the service (what you typed, else the saved one)">Test</button></span>
        </label>
        <div class="source-test-result" data-test-result="lrclib" hidden></div>
      </div>
      <div class="settings-section">
        <div class="settings-section-title">ReplayGain</div>
        <p class="settings-hint">Scan volume levels and write ReplayGain tags, so players that read them play tracks at an even volume. Run it from the selection toolbar.</p>
        <div id="replaygain-status" class="acoustid-status"></div>
      </div>
      </div>
      <div class="settings-sect" data-sect="writing" hidden>
      <div class="settings-section">
        <div class="settings-section-title">Writing Changes</div>
        <label class="settings-toggle">
          <input id="setting-stage-changes" type="checkbox" />
          <span>Review changes before writing</span>
        </label>
        <p class="settings-hint">Edits, organizing and lookups are held as staged changes until you write them from <strong>Review</strong>. Off: each edit is written straight away.</p>
      </div>
      <div class="settings-section">
        <div class="settings-section-title">Cover Art</div>
        <label class="field-label">New cover art goes to
          <select id="setting-cover-target">
            <option value="folder">The album folder (cover.jpg)</option>
            <option value="tracks">Each track (embedded)</option>
            <option value="both">Both</option>
          </select></label>
        <label class="field-label">Folder cover: shrink to
          <select id="setting-cover-folder-size">
            <option value="500">500 px</option><option value="800">800 px</option><option value="1000">1000 px</option>
            <option value="1200">1200 px</option><option value="1500">1500 px</option><option value="0">Don't resize</option>
          </select></label>
        <label class="field-label">Track (embedded) art: shrink to
          <select id="setting-cover-size">
            <option value="250">250 px</option><option value="500">500 px</option><option value="800">800 px</option>
            <option value="1200">1200 px</option><option value="0">Don't resize</option>
          </select></label>
        <p class="settings-hint">Plex, Jellyfin, Navidrome and Music Assistant read the folder's cover.jpg; embedded art is a copy in every track, for files that leave the folder. Any art written (Match album, Covers…, an uploaded cover) is shrunk to these sizes on its longest side, never enlarged. To move existing art: select tracks → Covers….</p>
      </div>
      <div class="settings-section">
        <div class="settings-section-title">Trash</div>
        <p class="settings-hint">Deleted files are moved to a trash folder and can be restored with Undo. Emptying trash frees that space permanently.</p>
        <div id="trash-status" class="acoustid-status"></div>
        <button id="empty-trash-btn" class="btn btn-ghost btn-sm">Empty trash</button>
      </div>
      </div>
    </div>
    <div class="settings-sidebar-footer" id="settings-footer">
      <button id="settings-logout" class="btn btn-ghost" hidden>Log out</button>
      <button id="settings-save" class="btn btn-primary">Save</button>
    </div>
  </aside>

  <div class="workspace">
    <aside class="sidebar">
      <div class="sidebar-tabs">
        <button class="stab active" data-mode="tags">Tags</button>
        <button class="stab" data-mode="files">Files</button>
        <button class="stab" data-mode="quality">Quality</button>
      </div>
      <nav id="panel-tags" class="sidebar-panel">
        <div class="nav-toolbar">
          <button id="expand-all-btn" class="btn btn-ghost btn-sm">Expand all</button>
          <button id="collapse-all-btn" class="btn btn-ghost btn-sm">Collapse all</button>
        </div>
        <ul id="artist-list" class="nav-list"></ul>
      </nav>
      <nav id="panel-files" class="sidebar-panel" hidden>
        <div class="nav-toolbar">
          <button id="move-folder-btn" class="btn btn-ghost btn-sm" style="flex:1" title="Move the selected folder (and everything in it) — staged for review" disabled>Move…</button>
          <button id="rename-folder-btn" class="btn btn-ghost btn-sm" style="flex:1" title="Rename the selected folder — staged for review" disabled>Rename…</button>
        </div>
        <div id="dir-tree" class="dir-tree"></div>
      </nav>
      <nav id="panel-quality" class="sidebar-panel" hidden>
        <div class="nav-toolbar" id="quality-toolbar" hidden>
          <button id="fix-all-btn" class="btn btn-ghost btn-sm" style="flex:1">Fix All</button>
          <button id="dedupe-btn" class="btn btn-ghost btn-sm" style="flex:1" title="Review each group: pick the copy to keep, then remove the rest from the library or move their files to the trash (undoable)" hidden>Review duplicates…</button>
          <button id="refile-btn" class="btn btn-ghost btn-sm" style="flex:1" title="Stage moving the selected tracks to the path their library layout gives — reviewed before anything moves" hidden>Re-file selected</button>
          <button id="lyrics-lookup-btn" class="btn btn-ghost btn-sm" style="flex:1" title="Look up lyrics for every track listed (or the selected ones) in the background — what's found is staged for review" hidden>Look up all…</button>
        </div>
        <ul id="quality-list" class="nav-list"></ul>
      </nav>
    </aside>

    <div class="pane-resizer" data-resize="sidebar" role="separator" aria-orientation="vertical"
         title="Drag to resize · double-click to reset"></div>

    <main class="track-pane">
      <div class="track-pane-toolbar">
        <div class="toolbar-left">
          <span id="track-count" class="track-count"></span>
        </div>
        <div class="toolbar-right">
          <div class="filter-group">
            <span class="filter-label">Filter</span>
            <select id="filter-quality" class="filter-select">
              <option value="">Quality</option>
              <option value="good">Good</option>
              <option value="fair">Fair</option>
              <option value="poor">Poor</option>
            </select>
            <select id="filter-format" class="filter-select">
              <option value="">Format</option>
            </select>
          </div>
          <div class="toolbar-divider"></div>
          <button id="export-m3u-btn" class="btn btn-ghost btn-sm" title="Export the current view as an .m3u playlist">Export M3U</button>
          <div class="col-picker-wrap">
            <button id="col-picker-btn" class="btn btn-ghost btn-sm">Columns ▾</button>
            <div id="col-picker" class="col-picker" hidden></div>
          </div>
          <div class="view-toggle">
            <button id="view-list-btn" class="btn btn-ghost btn-sm active" title="Track list">Tracks</button>
            <button id="view-albums-btn" class="btn btn-ghost btn-sm" title="Albums in the current view">Albums</button>
            <span id="album-style" class="album-style" hidden><button class="btn btn-ghost btn-sm" data-style="list" title="Album list">☰</button><button class="btn btn-ghost btn-sm" data-style="tiles" title="Album tiles">▦</button></span>
          </div>
        </div>
      </div>
      <div id="bulk-actions" class="bulk-actions" hidden>
        <span id="selection-count" class="selection-count"></span>
        <button id="select-view-btn" class="btn btn-link btn-sm" hidden></button>
        <span class="bulk-group"><span class="bulk-group-label">Tags</span>
          <button id="normalize-case-btn" class="btn btn-ghost btn-sm">Normalize Case</button>
          <button id="autonumber-btn" class="btn btn-ghost btn-sm" title="Number selected tracks 1…N in filename order">Auto-number</button>
          <button id="find-replace-btn" class="btn btn-ghost btn-sm" title="Find and replace text in one tag across the selection">Find/Replace</button>
          <button id="parse-names-btn" class="btn btn-ghost btn-sm" title="Read tags from the file and folder names with a pattern like %artist%/%album%/%track% - %title% — previewed, then staged">Tags from names…</button>
        </span>
        <span class="bulk-group"><span class="bulk-group-label">Look up</span>
          <button id="mb-album-btn" class="btn btn-ghost btn-sm" title="Match the selected tracks to a MusicBrainz release, track by track — reviewed, then staged">Match album…</button>
          <button id="lyrics-btn" class="btn btn-ghost btn-sm" title="Fetch lyrics (synced when available) from LRCLIB — reviewed, then staged">Lyrics…</button>
          <button id="replaygain-btn" class="btn btn-ghost btn-sm" title="Scan ReplayGain for the selection" hidden>ReplayGain</button>
        </span>
        <span class="bulk-group"><span class="bulk-group-label">Files</span>
          <button id="lyrics-group-btn" class="btn btn-ghost btn-sm" title="Put the selection in a group: how its lyrics are looked up (or No lyrics), and its layout">Group…</button>
          <button id="covers-btn" class="btn btn-ghost btn-sm" title="Move, copy or delete cover art between the album folder (cover.jpg) and the tracks">Covers…</button>
          <button id="merge-albums-btn" class="btn btn-ghost btn-sm" title="Make the selected tracks one album: tags, disc numbers, optionally one folder — previewed, then staged">Merge albums…</button>
          <button id="bulk-rename-btn" class="btn btn-ghost btn-sm" title="Rename the selected files with search &amp; replace (regex, captures, counters) — previewed, then staged">Rename files…</button>
        </span>
        <span class="bulk-group bulk-danger"><button id="remove-tracks-btn" class="btn btn-danger btn-sm" title="Remove from the library index (leaves files on disk)">Remove from library</button>
          <button id="delete-files-btn" class="btn btn-danger btn-sm" title="Move the selected files to trash (undoable)">Delete files</button>
        </span>
        <button id="clear-selection" class="btn btn-ghost btn-sm">✕ Deselect</button>
      </div>
      <div class="table-wrap">
        <table class="track-table">
          <thead><tr id="track-thead-row"></tr></thead>
          <tbody id="track-tbody"></tbody>
        </table>
        <div id="track-empty" class="track-empty" hidden>No tracks found.</div>
        <div id="track-loading" class="track-loading" hidden>Loading…</div>
      </div>
      <div id="album-grid" class="album-grid" style="display:none"></div>
      <div id="album-list" class="album-list" style="display:none"></div>
      <div id="pagination" class="pagination" hidden></div>
    </main>

    <div class="pane-resizer" id="editor-resizer" data-resize="editor" role="separator" aria-orientation="vertical"
         title="Drag to resize · double-click to reset" hidden></div>

    <aside id="tag-editor" class="tag-editor" hidden>
      <div class="tag-editor-header">
        <span id="editor-title" class="editor-title"></span>
        <div class="editor-header-actions">
          <button id="auto-fix-btn" class="btn btn-ghost btn-sm" title="Auto-fix: look up and save the best match">Auto-fix</button>
          <button id="infer-btn" class="btn btn-ghost btn-sm" title="Guess tags from the file name and folders">From filename</button>
          <button id="lookup-btn" class="btn btn-ghost btn-sm" title="Search MusicBrainz">Lookup</button>
          <button id="close-editor" class="btn btn-ghost btn-icon" title="Close" aria-label="Close editor">✕</button>
        </div>
      </div>
      <div id="lookup-panel" class="lookup-panel" hidden>
        <div class="lookup-header">
          <span class="lookup-title">MusicBrainz results</span>
          <button id="lookup-close" class="btn btn-ghost btn-icon btn-sm">✕</button>
        </div>
        <ul id="lookup-results" class="lookup-results"></ul>
      </div>
      <div id="editor-file" class="editor-file" hidden></div>
      <form id="tag-form" class="tag-form" autocomplete="off">
        <div class="cover-section">
          <div class="cover-preview" id="cover-preview">
            <img id="cover-img" alt="Cover art" />
            <div id="cover-placeholder" class="cover-placeholder">♪</div>
          </div>
          <button type="button" id="change-cover-btn" class="btn btn-ghost btn-sm" title="From disk, the Cover Art Archive or a URL">Change Cover…</button>
        </div>
        <audio id="player" class="editor-player" controls preload="none" hidden></audio>
        <div id="spectro-section" class="spectro-section" hidden>
          <button type="button" id="spectro-btn" class="btn btn-ghost btn-sm">Spectrogram ▾</button>
          <div id="spectro-wrap" class="spectro-wrap" hidden>
            <div class="spectro-frame">
              <img id="spectro-img" class="spectro-img" alt="Frequency spectrogram" title="Click to open full size" />
              <button type="button" id="spectro-popout" class="spectro-popout" title="Open full size" aria-label="Open spectrogram full size">⤢</button>
            </div>
            <div id="spectro-status" class="spectro-status"></div>
          </div>
        </div>
        <label class="field-label">Title<input name="title" type="text" /></label>
        <label class="field-label">Artist<input name="artist" type="text" /></label>
        <label class="field-label">Album<input name="album" type="text" /></label>
        <label class="field-label">Album Artist<input name="album_artist" type="text" /></label>
        <label class="field-label">Year<input name="year" type="text" maxlength="4" /></label>
        <label class="field-label">Track #<input name="track_number" type="text" /></label>
        <label class="field-label">Disc #<input name="disc_number" type="text" /></label>
        <label class="field-label">Genre<input name="genre" type="text" /></label>
        <label class="field-label">Composer<input name="composer" type="text" /></label>
        <label class="field-label">BPM<input name="bpm" type="text" inputmode="numeric" /></label>
        <label class="field-check"><input name="compilation" type="checkbox" /><span>Part of a compilation</span></label>
        <label class="field-label">Comment<textarea name="comment" rows="3"></textarea></label>
        <label class="field-label"><span class="field-label-row">Lyrics <button type="button" id="lyrics-search-btn" class="btn btn-link btn-sm" title="Search LRCLIB for this track by hand">Search…</button></span><textarea name="lyrics" rows="4"></textarea></label>
        <div id="editor-rename-preview" class="rename-preview" hidden></div>
        <div class="tag-form-actions">
          <button type="submit" class="btn btn-primary">Save</button>
          <button type="button" id="revert-btn" class="btn btn-ghost">Revert</button>
        </div>
      </form>
    </aside>
  </div>

  <footer id="statusbar" class="statusbar">
    <span id="status-where" class="status-where"></span>
    <span id="status-view" class="status-view"></span>
    <span id="status-sel" class="status-sel"></span>
  </footer>
`
