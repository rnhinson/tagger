export const APP_HTML = `
  <header class="topbar">
    <button id="sidebar-toggle" class="btn btn-ghost btn-icon" title="Toggle sidebar" aria-label="Toggle sidebar">☰</button>
    <span class="logo">Tagger</span>
    <div class="search-wrap">
      <input id="search" class="search-input" type="search" placeholder="Search tracks…" aria-label="Search tracks" autocomplete="off" />
    </div>
    <div class="topbar-actions">
      <span id="scan-status" class="scan-status"></span>
      <button id="undo-btn" class="btn btn-ghost btn-icon" title="Undo last change" aria-label="Undo last change" hidden>↶</button>
      <button id="scan-btn" class="btn btn-primary">Scan Library</button>
      <button id="settings-btn" class="btn btn-ghost btn-icon" title="Settings" aria-label="Settings">⚙</button>
    </div>
  </header>

  <aside id="settings-sidebar" class="settings-sidebar">
    <div class="settings-sidebar-header">
      <span class="settings-sidebar-title">Settings</span>
      <button id="settings-modal-close" class="btn btn-ghost btn-icon" aria-label="Close settings">✕</button>
    </div>
    <div class="settings-sidebar-body">
      <div class="settings-section">
        <div class="settings-section-title">Music Directories</div>
        <p class="settings-hint">Directories scanned for audio files. The default from <code>TAGGER_MUSIC_DIR</code> is always included.</p>
        <div id="music-dirs-default" class="music-dir-row music-dir-default"></div>
        <ul id="music-dirs-list" class="music-dirs-list"></ul>
        <div class="music-dir-add-row">
          <input id="music-dir-input" type="text" placeholder="Absolute path, e.g. /mnt/data/Music" />
          <button id="music-dir-add-btn" class="btn btn-ghost btn-sm">Add</button>
        </div>
      </div>
      <div class="settings-section">
        <div class="settings-section-title">AcoustID</div>
        <p class="settings-hint">Identifies audio by fingerprint — much more accurate than text search. Get a free API key at <span class="settings-link">acoustid.org</span>, then install chromaprint: <code>sudo apt install libchromaprint-tools</code></p>
        <label class="field-label">API Key
          <input id="setting-acoustid-key" type="password" autocomplete="off" placeholder="Paste your AcoustID API key…" />
        </label>
        <div id="acoustid-status" class="acoustid-status"></div>
      </div>
      <div class="settings-section">
        <div class="settings-section-title">Discogs</div>
        <p class="settings-hint">Optional second metadata source. Supplements MusicBrainz text search with release-level matches. Get a personal-access token from your Discogs account's developer settings.</p>
        <label class="field-label">Token
          <input id="setting-discogs-token" type="password" autocomplete="off" placeholder="Paste your Discogs token…" />
        </label>
      </div>
      <div class="settings-section">
        <div class="settings-section-title">ReplayGain</div>
        <p class="settings-hint">Scan volume levels and write ReplayGain tags. Requires <code>rsgain</code> or <code>loudgain</code> installed on the server. Run it from the selection toolbar.</p>
        <div id="replaygain-status" class="acoustid-status"></div>
      </div>
      <div class="settings-section">
        <div class="settings-section-title">Trash</div>
        <p class="settings-hint">Deleted files are moved to a trash folder and can be restored with Undo. Emptying trash frees that space permanently.</p>
        <div id="trash-status" class="acoustid-status"></div>
        <button id="empty-trash-btn" class="btn btn-ghost btn-sm">Empty trash</button>
      </div>
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
      </div>
      <div class="settings-section">
        <div class="settings-section-title">File Renaming</div>
        <label class="settings-toggle">
          <input id="setting-rename-on-save" type="checkbox" />
          <span>Rename files on save</span>
        </label>
        <p class="settings-hint">When enabled, saving a track's tags will also move the audio file to a new path built from the template below, relative to your music root directory.</p>
        <label class="field-label" id="rename-template-wrap">Template
          <input id="setting-rename-template" type="text" />
          <span class="settings-hint">Variables: {title} {artist} {album} {album_artist} {year} {track_number:02d} {disc_number} — e.g. <code>{album_artist}/{album}/{track_number:02d} {title}</code></span>
          <div id="rename-preview" class="rename-preview"></div>
        </label>
      </div>
    </div>
    <div class="settings-sidebar-footer">
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
          <button id="rescan-folder-btn" class="btn btn-ghost btn-sm" style="flex:1" title="Rescan just the selected folder" disabled>Rescan folder</button>
        </div>
        <div id="dir-tree" class="dir-tree"></div>
      </nav>
      <nav id="panel-quality" class="sidebar-panel" hidden>
        <div class="nav-toolbar" id="quality-toolbar" hidden>
          <button id="fix-all-btn" class="btn btn-ghost btn-sm" style="flex:1">Fix All</button>
          <button id="dedupe-btn" class="btn btn-ghost btn-sm" style="flex:1" title="Keep the highest-quality copy of each duplicate and remove the rest from the library" hidden>Keep best</button>
        </div>
        <ul id="quality-list" class="nav-list"></ul>
      </nav>
    </aside>

    <main class="track-pane">
      <div class="track-pane-toolbar">
        <div class="toolbar-left">
          <span id="track-count" class="track-count"></span>
          <div id="bulk-actions" class="bulk-actions" hidden>
            <span id="selection-count" class="selection-count"></span>
            <button id="normalize-case-btn" class="btn btn-ghost btn-sm">Normalize Case</button>
            <button id="autonumber-btn" class="btn btn-ghost btn-sm" title="Number selected tracks 1…N in filename order">Auto-number</button>
            <button id="find-replace-btn" class="btn btn-ghost btn-sm" title="Find and replace text in one tag across the selection">Find/Replace</button>
            <button id="replaygain-btn" class="btn btn-ghost btn-sm" title="Scan ReplayGain for the selection" hidden>ReplayGain</button>
            <button id="organize-btn" class="btn btn-ghost btn-sm" title="Move the selected files on disk using the rename template">Organize files</button>
            <button id="remove-tracks-btn" class="btn btn-danger btn-sm" title="Remove from the library index (leaves files on disk)">Remove from library</button>
            <button id="delete-files-btn" class="btn btn-danger btn-sm" title="Move the selected files to trash (undoable)">Delete files</button>
            <button id="clear-selection" class="btn btn-ghost btn-sm">✕ Deselect</button>
          </div>
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
            <button id="view-albums-btn" class="btn btn-ghost btn-sm" title="Album grid">Albums</button>
          </div>
        </div>
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
      <div id="pagination" class="pagination" hidden></div>
    </main>

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
      <form id="tag-form" class="tag-form" autocomplete="off">
        <div class="cover-section">
          <div class="cover-preview" id="cover-preview">
            <img id="cover-img" alt="Cover art" />
            <div id="cover-placeholder" class="cover-placeholder">♪</div>
          </div>
          <label class="btn btn-ghost btn-sm cover-upload-label">
            Change Cover
            <input id="cover-input" type="file" accept="image/jpeg,image/png,image/webp" />
          </label>
        </div>
        <audio id="player" class="editor-player" controls preload="none" hidden></audio>
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
        <label class="field-label">Lyrics<textarea name="lyrics" rows="4"></textarea></label>
        <div id="editor-rename-preview" class="rename-preview" hidden></div>
        <div class="tag-form-actions">
          <button type="submit" class="btn btn-primary">Save</button>
          <button type="button" id="revert-btn" class="btn btn-ghost">Revert</button>
        </div>
      </form>
    </aside>
  </div>
`
