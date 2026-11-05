import './style.css'
import { api, Track, Artist, Album, AlbumRow, LookupResult, AppSettings, setUnauthorizedHandler, onSessionExpired } from './api'
import { toast } from './toast'
import { esc, fmtDuration, debounce } from './util'
import { state, PAGE_SIZE, TAG_FIELDS, DirNode, saveColPrefs, BROWSE_TAGS, loadColWidths, saveColWidths, saveColOrder } from './state'
import { COL_DEFS, orderedCols } from './columns'
import {
  trackQuality, qualityTitle, QUALITY_ISSUES,
  toTitleCase, needsNormalization, NORMALIZE_FIELDS,
} from './quality'
import { APP_HTML } from './template'
import { ValueChips } from './chips'
import { muteErrorToasts } from './toast'
import { openCleanup } from './cleanup'
import { overlayStaged, editToast, undoToast, missingText, openReview, openHistory, shortPath, errText } from './staged'
import { openBulkRename } from './bulkrename'
import { openParseNames } from './parsenames'
import { openMergeAlbums } from './mergealbums'
import { openMbAlbum } from './mbalbum'
import { openLyrics } from './lyricsdialog'
import { renderBackground, renderAbout, wireBackground } from './background'

// ─── Layout ───────────────────────────────────────────────────────────────────

document.querySelector<HTMLDivElement>('#app')!.innerHTML = APP_HTML

// ─── Element refs ─────────────────────────────────────────────────────────────

const appEl          = document.querySelector<HTMLDivElement>('#app')!
const artistListEl   = document.getElementById('artist-list')!
const dirTreeEl      = document.getElementById('dir-tree')!
const trackTheadRow  = document.getElementById('track-thead-row')!
const trackTbody     = document.getElementById('track-tbody')!
const trackEmpty     = document.getElementById('track-empty')!
const trackLoading   = document.getElementById('track-loading')!
const trackCount     = document.getElementById('track-count')!
const tagEditor      = document.getElementById('tag-editor')!
const tagForm        = document.getElementById('tag-form') as HTMLFormElement

// Session expired (auth proxy redirecting to sign-in): stop the pollers'
// error spam and offer one way out.
onSessionExpired(() => {
  muteErrorToasts()
  if (state.scanPollTimer) { clearInterval(state.scanPollTimer); state.scanPollTimer = null }
  const bar = document.createElement('div')
  bar.className = 'session-expired'
  bar.innerHTML = '<span>Your sign-in has expired — unsaved edits in open dialogs are lost on reload; staged changes are kept.</span>'
    + '<button class="btn btn-primary btn-sm" type="button">Reload to sign in</button>'
  bar.querySelector('button')!.addEventListener('click', () => location.reload())
  document.body.appendChild(bar)
})
// Genre on a multi-track selection: chips (add/remove values per track)
// instead of one string that would overwrite every track's genres.
// Read-only tracks (e.g. a reference mount): say so, and don't offer Save.
const readOnlyNote = document.createElement('div')
readOnlyNote.className = 'readonly-note'
readOnlyNote.hidden = true
tagForm.prepend(readOnlyNote)
const saveBtn = tagForm.querySelector<HTMLButtonElement>('button[type=submit]')!
function setReadOnly(n: number, of: number) {
  readOnlyNote.hidden = n === 0
  tagForm.classList.toggle('form-readonly', n > 0)
  for (const el of tagForm.querySelectorAll<HTMLInputElement | HTMLTextAreaElement | HTMLButtonElement | HTMLSelectElement>(
    'input, textarea, select, button')) {
    if (el.closest('.spectro-section') || el.id === 'spectro-btn') continue   // viewing aids stay usable
    el.disabled = n > 0
  }
  readOnlyNote.textContent = n === of
    ? `🔒 Read-only — ${of === 1 ? 'this file is' : `these ${of.toLocaleString()} files are`} on a read-only folder and can't be changed.`
    : `🔒 ${n.toLocaleString()} of ${of.toLocaleString()} selected tracks are read-only and can't be changed. Deselect them to save.`
  saveBtn.hidden = n > 0
}

const genreChips = new ValueChips('genres')
const genreInput = tagForm.elements.namedItem('genre') as HTMLInputElement
genreInput.closest('.field-label')!.after(genreChips.el)
const editorTitle    = document.getElementById('editor-title')!
const bulkActions    = document.getElementById('bulk-actions')!
const selectionCount = document.getElementById('selection-count')!
const searchEl       = document.getElementById('search') as HTMLInputElement
const scanBtn        = document.getElementById('scan-btn') as HTMLButtonElement
const rescanFolderBtn = document.getElementById('rescan-folder-btn') as HTMLButtonElement
const scanStatusEl   = document.getElementById('scan-status')!
const colPickerBtn   = document.getElementById('col-picker-btn')!
const colPickerEl    = document.getElementById('col-picker')!
const albumGridEl    = document.getElementById('album-grid')!
const tableWrapEl    = document.querySelector<HTMLElement>('.table-wrap')!
const viewListBtn    = document.getElementById('view-list-btn')!
const viewAlbumsBtn  = document.getElementById('view-albums-btn')!
const coverImg         = document.getElementById('cover-img') as HTMLImageElement
const coverPlaceholder = document.getElementById('cover-placeholder')!
const coverInput       = document.getElementById('cover-input') as HTMLInputElement
const playerEl         = document.getElementById('player') as HTMLAudioElement
const editorRenamePreviewEl = document.getElementById('editor-rename-preview')!
const spectroSection   = document.getElementById('spectro-section')!
const spectroBtn       = document.getElementById('spectro-btn') as HTMLButtonElement
const spectroWrap      = document.getElementById('spectro-wrap')!
const spectroImg       = document.getElementById('spectro-img') as HTMLImageElement
const spectroStatus    = document.getElementById('spectro-status')!
const spectroPopout    = document.getElementById('spectro-popout') as HTMLButtonElement
const sidebarEl        = document.querySelector<HTMLElement>('.sidebar')!
const editorResizer    = document.getElementById('editor-resizer')!
let spectrogramAvailable = false

// Rename settings mirrored client-side for the editor's live save-path preview.
let renameOnSave = false
let renameTemplate = ''
let stageChanges = true
const lookupBtn        = document.getElementById('lookup-btn') as HTMLButtonElement
const lookupPanel      = document.getElementById('lookup-panel')!
const lookupResults    = document.getElementById('lookup-results')!
const qualityListEl    = document.getElementById('quality-list')!
const normalizeCaseBtn  = document.getElementById('normalize-case-btn') as HTMLButtonElement
const autonumberBtn     = document.getElementById('autonumber-btn') as HTMLButtonElement
const findReplaceBtn    = document.getElementById('find-replace-btn') as HTMLButtonElement
const removeTracksBtn   = document.getElementById('remove-tracks-btn') as HTMLButtonElement
const deleteFilesBtn    = document.getElementById('delete-files-btn') as HTMLButtonElement
const replaygainBtn     = document.getElementById('replaygain-btn') as HTMLButtonElement
const filterQualityEl  = document.getElementById('filter-quality') as HTMLSelectElement
const filterFormatEl   = document.getElementById('filter-format') as HTMLSelectElement
const inferBtn         = document.getElementById('infer-btn') as HTMLButtonElement
const exportM3uBtn     = document.getElementById('export-m3u-btn') as HTMLButtonElement
const undoBtn          = document.getElementById('undo-btn') as HTMLButtonElement
const reviewBtn        = document.getElementById('review-btn') as HTMLButtonElement
const selectViewBtn    = document.getElementById('select-view-btn') as HTMLButtonElement
const moveFolderBtn    = document.getElementById('move-folder-btn') as HTMLButtonElement
const renameFolderBtn  = document.getElementById('rename-folder-btn') as HTMLButtonElement

// Whether the server has a ReplayGain tool available (set at init)
let replaygainAvailable = false

// ─── Helpers ──────────────────────────────────────────────────────────────────

function coverUrl(trackId: number): string {
  return `/api/covers/${trackId}${state.coverBust ? '?v=' + state.coverBust : ''}`
}

function selectAll(): HTMLInputElement | null {
  return document.getElementById('select-all') as HTMLInputElement | null
}

// ─── Sidebar tabs ─────────────────────────────────────────────────────────────

function renderSidebarTabs() {
  document.querySelectorAll<HTMLButtonElement>('.stab').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.mode === state.sidebarMode)
  })
  document.getElementById('panel-tags')!.hidden    = state.sidebarMode !== 'tags'
  document.getElementById('panel-files')!.hidden   = state.sidebarMode !== 'files'
  document.getElementById('panel-quality')!.hidden = state.sidebarMode !== 'quality'
}

// ─── Tags panel ───────────────────────────────────────────────────────────────

function navRow(cls: string, arrow: 'open' | 'closed' | 'none', label: string, count?: number): HTMLLIElement {
  const li = document.createElement('li')
  li.className = 'nav-item ' + cls
  const a = arrow === 'none' ? '' : (arrow === 'open' ? '▾' : '▸')
  li.innerHTML = `
    <span class="nav-arrow${arrow === 'none' ? ' nav-arrow-empty' : ''}" data-toggle="1">${a}</span>
    <span class="nav-label">${label}</span>
    ${count !== undefined ? `<span class="nav-count">${count.toLocaleString()}</span>` : ''}`
  return li
}

function renderTagsPanel() {
  artistListEl.innerHTML = ''
  const nothingSelected = state.selectedArtist === null && !state.selectedTag

  // All tracks
  const allLi = document.createElement('li')
  allLi.className = 'nav-item nav-all' + (nothingSelected ? ' active' : '')
  allLi.dataset.all = '1'
  allLi.innerHTML = `<span class="nav-icon">♪</span><span class="nav-label">All tracks</span>`
  artistListEl.appendChild(allLi)

  for (const { field, label } of BROWSE_TAGS) {
    const open = state.expandedTags.has(field)
    const values = state.tagValues.get(field)
    const header = navRow('nav-tag', values && !values.length ? 'none' : (open ? 'open' : 'closed'),
                          esc(label), values ? values.length : undefined)
    header.dataset.tag = field
    artistListEl.appendChild(header)
    if (!open || !values) continue

    for (const v of values) {
      const isArtist = field === 'artist'
      const albums = isArtist ? (state.albumsByArtist.get(v.value) ?? []) : []
      const expanded = isArtist && state.expandedArtists.has(v.value)
      const selected = isArtist
        ? state.selectedArtist === v.value && !state.selectedAlbum
        : state.selectedTag?.field === field && state.selectedTag.value === v.value
      const li = navRow('nav-value' + (selected ? ' active' : ''),
                        albums.length ? (expanded ? 'open' : 'closed') : 'none',
                        v.value ? esc(v.value) : '<span class="nav-none">(none)</span>', v.track_count)
      li.dataset.tag = field
      li.dataset.value = v.value
      artistListEl.appendChild(li)

      if (!expanded) continue
      for (const alb of albums) {
        const albLi = document.createElement('li')
        albLi.className = 'nav-item nav-album'
          + (state.selectedArtist === v.value && state.selectedAlbum === alb.album ? ' active' : '')
        albLi.dataset.artist = v.value
        albLi.dataset.album  = alb.album
        albLi.innerHTML = `
          <span class="nav-label">${esc(alb.album || '(Unknown Album)')}</span>
          <span class="nav-count">${alb.track_count}</span>
        `
        artistListEl.appendChild(albLi)
      }
    }
  }
}

async function loadTagValues(field: string) {
  try {
    state.tagValues.set(field, await api.library.tagValues(field))
  } catch (e) {
    toast(`Failed to load ${field} values: ${e}`, 'error')
  }
}

// ─── Files panel ─────────────────────────────────────────────────────────────

function renderFilesPanel() {
  const ul = document.createElement('ul')
  ul.className = 'tree-list'

  const allLi = document.createElement('li')
  const allRow = document.createElement('div')
  allRow.className = 'tree-row tree-all' + (!state.selectedDirectory ? ' active' : '')
  allRow.dataset.path = ''
  allRow.innerHTML = `<span class="tree-icon">♪</span><span class="tree-label">All tracks</span>`
  allLi.appendChild(allRow)
  ul.appendChild(allLi)

  if (state.rootNode) ul.appendChild(renderDirNode(state.rootNode, 0))

  dirTreeEl.innerHTML = ''
  dirTreeEl.appendChild(ul)
  updateRescanBtn()
}

function renderDirNode(node: DirNode, depth: number): HTMLElement {
  const li = document.createElement('li')
  const row = document.createElement('div')
  row.className = 'tree-row' + (state.selectedDirectory === node.path ? ' active' : '')
  row.dataset.path = node.path
  row.draggable = isMovableFolder(node.path)
  row.style.paddingLeft = `${12 + depth * 14}px`

  const arrow = document.createElement('span')
  arrow.className = 'tree-arrow'
  if (node.loading) {
    arrow.textContent = '…'
    arrow.className += ' tree-arrow-loading'
  } else if (node.children === null ? node.hasDirs !== false : node.children.length > 0) {
    arrow.textContent = node.expanded ? '▾' : '▸'
    arrow.dataset.toggle = '1'
  } else {
    arrow.className += ' tree-arrow-empty'
  }

  const icon  = document.createElement('span')
  icon.className = 'tree-icon'
  icon.textContent = node.expanded ? '📂' : '📁'

  const label = document.createElement('span')
  label.className = 'tree-label'
  label.textContent = node.name

  row.append(arrow, icon, label)
  li.appendChild(row)

  if (node.expanded && node.children?.length) {
    const childUl = document.createElement('ul')
    childUl.className = 'tree-list'
    for (const child of node.children) childUl.appendChild(renderDirNode(child, depth + 1))
    li.appendChild(childUl)
  }

  return li
}

// ─── Quality panel ────────────────────────────────────────────────────────────

async function renderQualityPanel() {
  if (!state.qualityIssues) {
    qualityListEl.innerHTML = '<li class="nav-item" style="color:var(--text-muted);font-size:12px;padding:10px 12px">Loading…</li>'
    try {
      state.qualityIssues = await api.library.issues()
    } catch (e) {
      toast(`Failed to load quality report: ${e}`, 'error')
      return
    }
  }

  qualityListEl.innerHTML = ''
  let anyIssues = false

  for (const issue of QUALITY_ISSUES) {
    const count = state.qualityIssues[issue.key] ?? 0
    if (count === 0) continue
    anyIssues = true
    const li = document.createElement('li')
    const isActive = state.selectedIssue === issue.key
    li.className = 'nav-item quality-issue-item' + (isActive ? ' active' : '')
    li.dataset.issue = issue.key
    li.innerHTML = `
      <span class="quality-issue-dot${issue.warn ? ' quality-issue-dot-warn' : ''}"></span>
      <span class="nav-label">${issue.label}</span>
      <span class="nav-count">${count}</span>
    `
    qualityListEl.appendChild(li)
  }

  if (!anyIssues) {
    qualityListEl.innerHTML = '<li class="nav-item quality-all-good">✓ All tags look good</li>'
  }
}

// ─── Album grid ───────────────────────────────────────────────────────────────

function getVisibleAlbums(): Album[] {
  if (state.sidebarMode === 'tags' && state.selectedArtist) {
    return state.albumsByArtist.get(state.selectedArtist) ?? []
  }
  const all: Album[] = []
  for (const albs of state.albumsByArtist.values()) all.push(...albs)
  return all
}

function makeAlbumCard(alb: Album): HTMLElement {
  const card = document.createElement('div')
  card.className = 'album-card'
  const artistDisplay = esc(alb.album_artist || alb.artist || '(Unknown Artist)')
  card.innerHTML = `
    <div class="album-cover-wrap">
      <img class="album-cover" loading="lazy" src="${coverUrl(alb.cover_track_id)}" alt="${esc(alb.album || '')}" />
      <div class="album-cover-placeholder">♪</div>
    </div>
    <div class="album-info">
      <div class="album-title">${esc(alb.album || '(Unknown Album)')}</div>
      <div class="album-artist">${artistDisplay}</div>
      <div class="album-count">${alb.track_count} track${alb.track_count !== 1 ? 's' : ''}</div>
    </div>
  `
  const img = card.querySelector<HTMLImageElement>('.album-cover')!
  const placeholder = card.querySelector<HTMLElement>('.album-cover-placeholder')!
  img.addEventListener('error', () => { img.style.display = 'none'; placeholder.style.display = 'flex' })
  img.addEventListener('load',  () => { img.style.display = 'block'; placeholder.style.display = 'none' })
  card.addEventListener('click', () => {
    state.viewMode = 'list'
    renderViewMode()
    navigateTo(alb.artist ?? '', alb.album)
  })
  return card
}

// Render album cards in batches, appending more as the user scrolls, so a
// library with thousands of albums doesn't build every card up front.
const ALBUM_BATCH = 60
let albumObserver: IntersectionObserver | null = null

function renderAlbumGrid() {
  albumObserver?.disconnect()
  albumGridEl.innerHTML = ''
  const albums = getVisibleAlbums()

  if (!albums.length) {
    albumGridEl.innerHTML = '<div class="album-empty">No albums found.</div>'
    return
  }

  const sentinel = document.createElement('div')
  sentinel.className = 'album-sentinel'
  albumGridEl.appendChild(sentinel)

  let rendered = 0
  const renderMore = () => {
    const next = albums.slice(rendered, rendered + ALBUM_BATCH)
    for (const alb of next) albumGridEl.insertBefore(makeAlbumCard(alb), sentinel)
    rendered += next.length
    if (rendered >= albums.length) { albumObserver?.disconnect(); sentinel.remove() }
  }
  renderMore()

  if (rendered < albums.length) {
    albumObserver = new IntersectionObserver(
      entries => { if (entries.some(e => e.isIntersecting)) renderMore() },
      { root: albumGridEl, rootMargin: '600px' },
    )
    albumObserver.observe(sentinel)
  }
}

// ─── Album list (default album view) ─────────────────────────────────────────
// One row per folder + album in the current view (same filters as the track
// list), with tracks present vs expected and every tag the tracks share.

const albumListEl = document.getElementById('album-list')!
const albumStyleEl = document.getElementById('album-style')!
let albumStyle: 'list' | 'tiles' = 'list'
try { if (localStorage.getItem('tagger.albumStyle') === 'tiles') albumStyle = 'tiles' } catch { /* storage blocked */ }

function renderAlbumView() { if (albumStyle === 'list') renderAlbumList(); else renderAlbumGrid() }

async function renderAlbumList() {
  albumListEl.innerHTML = '<div class="album-empty">Loading albums…</div>'
  let rows: AlbumRow[]
  try { rows = await api.library.albumList(viewParams()) } catch (e) { albumListEl.innerHTML = `<div class="album-empty">${esc(String(e))}</div>`; return }
  if (!rows.length) { albumListEl.innerHTML = '<div class="album-empty">No albums found.</div>'; return }
  const hover = (r: AlbumRow, f: string) => esc(`Not the same on every track:\n${(r.values[f] ?? []).join('\n')}`)
  const v = (r: AlbumRow, f: keyof AlbumRow) => r.mixed.includes(f as string)
    ? `<span class="al-mixed" title="${hover(r, f as string)}">mixed</span>` : esc(String(r[f] ?? ''))
  // No album artist and the track artists differ: the most common one, "+N".
  const artist = (r: AlbumRow) => r.album_artist ? esc(r.album_artist)
    : r.mixed.includes('artist') ? `<span title="${hover(r, 'artist')}">${esc(r.values.artist?.[0] ?? '')} <span class="al-mixed">+${(r.values.artist?.length ?? 1) - 1}</span></span>`
    : esc(r.artist ?? '')
  const tracks = (r: AlbumRow) => {
    if (r.expected == null) return `${r.tracks}`
    const cls = r.tracks < r.expected ? 'al-short' : r.tracks > r.expected ? 'al-over' : 'al-full'
    return `<span class="${cls}" title="${r.tracks} present of ${r.expected} expected (from “n/N” track numbers)">${r.tracks} / ${r.expected}</span>`
  }
  albumListEl.innerHTML = `<table class="track-table album-table"><thead><tr>
      <th class="al-cover"></th><th>Album</th><th title="Album artist, or the track artists when there is none">Artist</th><th class="al-num">Tracks</th><th class="al-num">Discs</th>
      <th>Year</th><th>Genre</th><th>Format</th><th>Folder</th></tr></thead><tbody>
    ${rows.map((r, i) => `<tr data-i="${i}" title="${esc(r.directory)}">
      <td class="al-cover"><img loading="lazy" src="${coverUrl(r.cover_track_id)}" alt="" onerror="this.style.visibility='hidden'" /></td>
      <td>${esc(r.album || '(no album)')}</td><td>${artist(r)}</td><td class="al-num">${tracks(r)}</td>
      <td class="al-num">${r.discs > 1 ? r.discs : ''}</td><td>${v(r, 'year')}</td><td>${v(r, 'genre')}</td>
      <td>${v(r, 'format')}${r.bitrate ? ` <span class="al-dim">${Math.round(r.bitrate / 1000)}k</span>` : ''}</td>
      <td class="al-dim">${esc(shortPath(r.directory))}</td></tr>`).join('')}
    </tbody></table>`
  albumListEl.querySelector('tbody')!.addEventListener('click', async (e) => {
    const tr = (e.target as HTMLElement).closest<HTMLElement>('tr[data-i]')
    if (!tr) return
    const r = rows[Number(tr.dataset.i)]
    // Open the album: its folder in the Files tab, tracks in the list. (The
    // track view filters by folder only in Files mode.)
    state.viewMode = 'list'
    state.sidebarMode = 'files'
    state.selectedArtist = null; state.selectedAlbum = null; state.selectedTag = null; state.query = ''; searchEl.value = ''
    state.selectedDirectory = r.directory
    state.selectedIds.clear(); state.page = 0
    if (!state.rootNode) await loadTree()
    renderSidebarTabs()
    renderFilesPanel()
    renderViewMode()
    await loadTracks()
    renderEditor()
  })
}

albumStyleEl.addEventListener('click', (e) => {
  const b = (e.target as HTMLElement).closest<HTMLElement>('[data-style]')
  if (!b) return
  albumStyle = b.dataset.style as 'list' | 'tiles'
  try { localStorage.setItem('tagger.albumStyle', albumStyle) } catch { /* storage blocked */ }
  renderViewMode()
})

function renderViewMode() {
  const albums = state.viewMode === 'albums'
  tableWrapEl.style.display  = state.viewMode === 'list' ? '' : 'none'
  albumGridEl.style.display  = albums && albumStyle === 'tiles' ? 'grid' : 'none'
  albumListEl.style.display  = albums && albumStyle === 'list' ? '' : 'none'
  albumStyleEl.hidden = !albums
  albumStyleEl.querySelectorAll<HTMLElement>('[data-style]').forEach(b => b.classList.toggle('active', b.dataset.style === albumStyle))
  viewListBtn.classList.toggle('active',   state.viewMode === 'list')
  viewAlbumsBtn.classList.toggle('active', state.viewMode === 'albums')
  if (albums) renderAlbumView()
}

// ─── Column picker ────────────────────────────────────────────────────────────

function renderColPicker() {
  colPickerEl.innerHTML = ''
  for (const col of orderedCols()) {
    const label = document.createElement('label')
    label.className = 'col-picker-item'
    const cb = document.createElement('input')
    cb.type = 'checkbox'
    cb.checked = state.visibleCols.has(col.key)
    cb.dataset.col = col.key
    label.appendChild(cb)
    label.append(' ' + col.label)
    colPickerEl.appendChild(label)
  }
}

// ─── Sorting and filtering ─────────────────────────────────────────────────────

// Sorting and the Quality/Format filters run on the server over the whole
// view (every page), so this is just the page as delivered.
function getSortedFilteredTracks(): Track[] {
  return state.tracks
}

/** Filters + sort for the current view, for /tracks, select-all and export. */
function viewParams(): Record<string, string | number> {
  const p = currentViewParams()
  if (state.filterFormat)  p.format = state.filterFormat
  if (state.filterQuality) p.quality = state.filterQuality
  if (state.sortKey) { p.sort = state.sortKey; p.sort_dir = state.sortDir }
  return p
}

async function renderFormatOptions() {
  let formats: string[] = []
  try { formats = await api.library.formats() } catch { return }
  const current = filterFormatEl.value
  filterFormatEl.innerHTML = '<option value="">Format</option>'
  for (const fmt of formats) {
    const opt = document.createElement('option')
    opt.value = fmt
    opt.textContent = fmt.toUpperCase()
    filterFormatEl.appendChild(opt)
  }
  if (formats.includes(current)) filterFormatEl.value = current
}

// ─── Keyboard navigation ──────────────────────────────────────────────────────

function navigateTrack(dir: 1 | -1) {
  const displayedTracks = getSortedFilteredTracks()
  if (!displayedTracks.length) return
  const lastId = [...state.selectedIds][state.selectedIds.size - 1]
  const idx = displayedTracks.findIndex(t => t.id === lastId)
  const nextIdx = Math.max(0, Math.min(displayedTracks.length - 1, idx + dir))
  const nextTrack = displayedTracks[nextIdx]
  state.selectedIds.clear()
  state.selectedIds.add(nextTrack.id)
  renderTracks()
  renderEditor()
  const tr = trackTbody.querySelector<HTMLTableRowElement>(`tr[data-id="${nextTrack.id}"]`)
  tr?.scrollIntoView({ block: 'nearest' })
}

// ─── Track table ──────────────────────────────────────────────────────────────

function renderColHeaders() {
  const qualityTh = state.visibleCols.has('quality') ? '<th class="col-quality" title="Tag quality — green: all key tags · yellow: missing album, year or track # · red: missing title or artist. Hover a dot for details."></th>' : ''
  trackTheadRow.innerHTML = `${qualityTh}<th class="col-check"><input type="checkbox" id="select-all" /></th>`
  for (const col of orderedCols()) {
    if (col.key === 'quality') continue
    if (!state.visibleCols.has(col.key)) continue
    const th = document.createElement('th')
    th.className = col.cls
    th.dataset.sort = col.key
    th.style.cursor = 'pointer'
    let label = col.label
    if (state.sortKey === col.key) {
      label += state.sortDir === 'asc' ? ' ↑' : ' ↓'
    }
    th.textContent = label
    th.dataset.col = col.key
    th.draggable = true
    const grip = document.createElement('span')
    grip.className = 'col-resizer'
    grip.title = 'Drag to resize · double-click to reset all widths'
    th.appendChild(grip)
    th.addEventListener('click', (e) => {
      if ((e.target as HTMLElement).classList.contains('col-resizer')) return
      if (state.sortKey === col.key) {
        state.sortDir = state.sortDir === 'asc' ? 'desc' : 'asc'
      } else {
        state.sortKey = col.key
        state.sortDir = 'asc'
      }
      renderColHeaders()
      state.page = 0
      loadTracks()
    })
    trackTheadRow.appendChild(th)
  }
  selectAll()?.addEventListener('change', onSelectAll)
  applyColWidths()
}

// ─── Column reordering ────────────────────────────────────────────────────────
// Drag a header onto another: it lands before or after it (whichever half of
// the target the pointer is over). The order persists and the Columns menu
// follows it.

let draggingCol: string | null = null

trackTheadRow.addEventListener('dragstart', (e) => {
  const th = (e.target as HTMLElement).closest<HTMLElement>('th[data-col]')
  if (!th) return
  draggingCol = th.dataset.col!
  e.dataTransfer!.effectAllowed = 'move'
  e.dataTransfer!.setData('text/plain', draggingCol)
  th.classList.add('col-dragging')
})

trackTheadRow.addEventListener('dragover', (e) => {
  const th = (e.target as HTMLElement).closest<HTMLElement>('th[data-col]')
  if (!draggingCol || !th || th.dataset.col === draggingCol) return
  e.preventDefault()
  const r = th.getBoundingClientRect()
  const after = e.clientX > r.left + r.width / 2
  trackTheadRow.querySelectorAll('.col-drop-before, .col-drop-after').forEach(x => x.classList.remove('col-drop-before', 'col-drop-after'))
  th.classList.add(after ? 'col-drop-after' : 'col-drop-before')
})

trackTheadRow.addEventListener('drop', (e) => {
  const th = (e.target as HTMLElement).closest<HTMLElement>('th[data-col]')
  if (!draggingCol || !th || th.dataset.col === draggingCol) return
  e.preventDefault()
  const after = th.classList.contains('col-drop-after')
  const keys = orderedCols().map(c => c.key).filter(k => k !== draggingCol)
  keys.splice(keys.indexOf(th.dataset.col!) + (after ? 1 : 0), 0, draggingCol)
  saveColOrder(keys)
  renderColHeaders()
  renderTracks()
  if (state.colPickerOpen) renderColPicker()
})

trackTheadRow.addEventListener('dragend', () => {
  draggingCol = null
  trackTheadRow.querySelectorAll('.col-dragging, .col-drop-before, .col-drop-after')
    .forEach(x => x.classList.remove('col-dragging', 'col-drop-before', 'col-drop-after'))
})

// ─── Column resizing ──────────────────────────────────────────────────────────
// Dragging a header's right edge sets that column's width in px. The first
// drag freezes every column at its current width (fixed layout), so one
// column grows or shrinks without the others reflowing; the table can then
// be wider than the pane and scrolls sideways. Double-click resets.

let colWidths = loadColWidths()
const trackTable = trackTheadRow.closest('table') as HTMLTableElement

function dataThs(): HTMLTableCellElement[] {
  return [...trackTheadRow.querySelectorAll<HTMLTableCellElement>('th')]
}

function applyColWidths() {
  const ths = dataThs()
  if (!Object.keys(colWidths).length) {
    trackTable.style.tableLayout = ''; trackTable.style.width = ''
    ths.forEach(th => { th.style.width = '' })
    return
  }
  let total = 0
  for (const th of ths) {
    const key = th.dataset.col
    // Unsized columns (new, or the check/quality cells) keep their current width.
    const w = (key && colWidths[key]) || th.getBoundingClientRect().width || 80
    th.style.width = `${w}px`
    total += w
  }
  trackTable.style.tableLayout = 'fixed'
  trackTable.style.width = `${total}px`
}

trackTheadRow.addEventListener('mousedown', (e) => {
  const grip = e.target as HTMLElement
  if (!grip.classList.contains('col-resizer')) return
  e.preventDefault()
  const th = grip.parentElement as HTMLTableCellElement
  if (!Object.keys(colWidths).length) {
    for (const h of dataThs()) if (h.dataset.col) colWidths[h.dataset.col] = Math.round(h.getBoundingClientRect().width)
    applyColWidths()
  }
  const key = th.dataset.col!
  const startX = e.clientX, startW = th.getBoundingClientRect().width
  document.body.classList.add('col-resizing')
  const move = (ev: MouseEvent) => {
    colWidths[key] = Math.max(40, Math.round(startW + ev.clientX - startX))
    applyColWidths()
  }
  const up = () => {
    document.removeEventListener('mousemove', move)
    document.removeEventListener('mouseup', up)
    document.body.classList.remove('col-resizing')
    saveColWidths(colWidths)
  }
  document.addEventListener('mousemove', move)
  document.addEventListener('mouseup', up)
})

trackTheadRow.addEventListener('dblclick', (e) => {
  if (!(e.target as HTMLElement).classList.contains('col-resizer')) return
  colWidths = {}
  saveColWidths(colWidths)
  applyColWidths()
})

function renderTracks() {
  trackTbody.innerHTML = ''

  if (!state.tracks.length) {
    const pristine = state.total === 0 && !state.query && !state.artists.length
      && state.selectedArtist === null && state.selectedAlbum === null && !state.selectedTag
      && state.selectedDirectory === null && !state.selectedIssue
    trackEmpty.innerHTML = pristine
      ? 'Your library is empty. Click <strong>Scan Library</strong> to index your music.'
      : 'No tracks found.'
    trackEmpty.hidden = false
    trackLoading.hidden = true
    trackCount.textContent = '0 tracks'
    updateBulkBar()
    return
  }

  trackEmpty.hidden = true
  trackLoading.hidden = true

  const displayedTracks = getSortedFilteredTracks()
  trackCount.textContent = `${state.total.toLocaleString()} track${state.total !== 1 ? 's' : ''}`
    + (state.filterFormat || state.filterQuality ? ' (filtered)' : '')

  const visibleCols = orderedCols().filter(c => state.visibleCols.has(c.key))

  for (const t of displayedTracks) {
    const selected = state.selectedIds.has(t.id)
    const tr = document.createElement('tr')
    tr.dataset.id = String(t.id)
    tr.draggable = true
    if (selected) tr.classList.add('selected')
    if (t.staged) {
      tr.classList.add('row-staged')
      if (t.staged.new_path) {
        tr.classList.add('row-moving')
        tr.title = `Will move to ${shortPath(t.staged.new_path)}`
      }
    }
    const q = trackQuality(t)
    const qualityCell = state.visibleCols.has('quality')
      ? `<td class="col-quality" title="${esc(qualityTitle(t))}"><span class="quality-dot quality-dot-${q}"></span></td>`
      : ''
    // Read-only: no checkbox -- it can be opened (view only), never bulk-selected.
    const check = t.read_only ? '<span class="ro-lock" title="Read-only — view only">🔒</span>'
      : `<input type="checkbox"${selected ? ' checked' : ''} />`
    let cells = `${qualityCell}<td class="col-check">${check}</td>`
    if (t.read_only) tr.classList.add('row-readonly')
    if (t.missing) tr.classList.add('row-missing')
    for (const col of visibleCols) {
      if (col.key === 'quality') continue
      const was = t._orig && col.key in t._orig ? t._orig[col.key] : undefined
      cells += was === undefined
        ? `<td class="${col.cls}">${col.render(t)}</td>`
        : `<td class="${col.cls} cell-staged" title="Staged — on file: ${esc(was || '(empty)')}">${col.render(t)}</td>`
    }
    tr.innerHTML = cells
    tr.querySelectorAll<HTMLElement>('.tag-link').forEach(link => {
      link.addEventListener('click', (e) => {
        e.stopPropagation()
        navigateTo(link.dataset.artist ?? '', link.dataset.album)
      })
    })
    trackTbody.appendChild(tr)
  }

  const sa = selectAll()
  if (sa) {
    const allSel = state.tracks.every(t => state.selectedIds.has(t.id))
    const anySel = state.tracks.some(t => state.selectedIds.has(t.id))
    sa.checked       = allSel
    sa.indeterminate = !allSel && anySel
  }

  updateBulkBar()
}

function updateBulkBar() {
  const n = state.selectedIds.size
  // A read-only track is only ever selected alone, to view: no bulk actions.
  bulkActions.hidden = n === 0 || state.tracks.some(t => t.read_only && state.selectedIds.has(t.id))
  const offPage = n - state.tracks.filter(t => state.selectedIds.has(t.id)).length
  selectionCount.textContent = offPage > 0
    ? `${n.toLocaleString()} selected (${offPage.toLocaleString()} on other pages)`
    : `${n.toLocaleString()} selected`
  // Whole page selected but the view is bigger: offer the rest.
  const pageAll = state.tracks.some(t => !t.read_only)
    && state.tracks.every(t => t.read_only || state.selectedIds.has(t.id))
  selectViewBtn.hidden = !(pageAll && state.total > n)
  selectViewBtn.textContent = `Select all ${state.total.toLocaleString()} in this view`
  removeTracksBtn.style.display = n > 0 ? '' : 'none'
  replaygainBtn.hidden = !(n > 0 && replaygainAvailable)
}

// ─── Pagination ───────────────────────────────────────────────────────────────

const paginationEl = document.getElementById('pagination')!

function renderPagination() {
  const totalPages = Math.ceil(state.total / PAGE_SIZE)
  if (totalPages <= 1) { paginationEl.hidden = true; return }
  paginationEl.hidden = false
  const start = state.page * PAGE_SIZE + 1
  const end   = Math.min((state.page + 1) * PAGE_SIZE, state.total)
  paginationEl.innerHTML = `
    <button class="btn btn-ghost btn-sm" id="page-prev" ${state.page === 0 ? 'disabled' : ''}>← Prev</button>
    <span class="page-info">${start.toLocaleString()}–${end.toLocaleString()} of ${state.total.toLocaleString()}</span>
    <button class="btn btn-ghost btn-sm" id="page-next" ${state.page >= totalPages - 1 ? 'disabled' : ''}>Next →</button>
  `
  document.getElementById('page-prev')!.addEventListener('click', async () => {
    state.page--; await loadTracks()
    paginationEl.scrollIntoView({ block: 'nearest' })
  })
  document.getElementById('page-next')!.addEventListener('click', async () => {
    state.page++; await loadTracks()
    paginationEl.scrollIntoView({ block: 'nearest' })
  })
}

// ─── Tag editor ───────────────────────────────────────────────────────────────

const editorFileEl = document.getElementById('editor-file')!

/** The selected file's name and full path (and a warning when it's gone). */
function renderEditorFile(t: Track | null) {
  editorFileEl.hidden = !t
  if (!t) return
  editorFileEl.classList.toggle('editor-file-missing', !!t.missing)
  editorFileEl.innerHTML = `
    ${t.missing ? '<div class="editor-file-warn">⚠ File not found on disk — moved or deleted since the last scan. Tag edits can\'t be written; rescan or put the file back.</div>' : ''}
    <div class="editor-file-name" title="${esc(t.filename)}">${esc(t.filename)}</div>
    <div class="editor-file-path" title="${esc(t.path)}">${esc(t.directory)}</div>
    ${t.staged?.new_path ? `<div class="editor-file-move" title="${esc(t.staged.new_path)}">→ ${esc(shortPath(t.staged.new_path))}</div>` : ''}
    ${t.layout_path && !t.staged?.new_path ? `<div class="editor-file-layout" title="${esc(t.layout_path)}">Layout puts it at ${esc(shortPath(t.layout_path))}</div>` : ''}`
}

function renderEditor() {
  if (state.selectedIds.size === 0) { tagEditor.hidden = true; editorResizer.hidden = true; lookupPanel.hidden = true; state.pendingCoverAlbumId = null; state.pendingLookupResult = null; playerEl.pause(); playerEl.hidden = true; editorRenamePreviewEl.hidden = true; return }
  tagEditor.hidden = false
  editorResizer.hidden = false
  // Only show lookup/infer for single selection; hide panel when selection changes
  lookupBtn.hidden = state.selectedIds.size !== 1
  inferBtn.hidden = state.selectedIds.size !== 1
  autoFixBtn.hidden = state.selectedIds.size === 0
  if (state.selectedIds.size !== 1) lookupPanel.hidden = true
  const sel = state.tracks.filter(t => state.selectedIds.has(t.id))
  const n = state.selectedIds.size
  editorTitle.textContent = n === 1 && sel.length === 1 ? (sel[0].title || sel[0].filename) : `${n.toLocaleString()} tracks`
  renderEditorFile(n === 1 && sel.length === 1 ? sel[0] : null)
  fillEditorForm()
  updateCoverPreview()
  updatePlayer()
  updateEditorRenamePreview()
  updateSpectro()
}

function updateSpectro() {
  // Shown for a single selection; collapsed by default (rendering is lazy).
  const show = state.selectedIds.size === 1 && spectrogramAvailable
  spectroSection.hidden = !show
  spectroWrap.hidden = true
  spectroImg.removeAttribute('src')
  spectroImg.style.display = 'none'
  spectroPopout.style.display = 'none'
  spectroBtn.textContent = 'Spectrogram ▾'
}

function toggleSpectro() {
  if (state.selectedIds.size !== 1) return
  if (!spectroWrap.hidden) {
    spectroWrap.hidden = true
    spectroBtn.textContent = 'Spectrogram ▾'
    return
  }
  spectroWrap.hidden = false
  spectroBtn.textContent = 'Spectrogram ▴'
  const url = api.spectrogram.url([...state.selectedIds][0])
  if (spectroImg.getAttribute('src') !== url) {
    spectroStatus.textContent = 'Rendering…'
    spectroImg.style.display = 'none'
    spectroPopout.style.display = 'none'
    spectroImg.onload = () => {
      spectroImg.style.display = 'block'
      spectroPopout.style.display = 'block'
      spectroStatus.textContent = ''
    }
    spectroImg.onerror = () => { spectroStatus.textContent = 'Could not render spectrogram' }
    spectroImg.src = url
  } else if (spectroImg.getAttribute('src')) {
    spectroPopout.style.display = 'block'
  }
}

// Open the rendered spectrogram at full size in a dismissible lightbox.
function openSpectroLightbox() {
  const src = spectroImg.getAttribute('src')
  if (!src || spectroImg.style.display === 'none') return

  const overlay = document.createElement('div')
  overlay.className = 'spectro-lightbox-overlay'

  const box = document.createElement('div')
  box.className = 'spectro-lightbox'

  const img = document.createElement('img')
  img.src = src
  img.alt = 'Frequency spectrogram'

  const cap = document.createElement('div')
  cap.className = 'spectro-lightbox-cap'
  cap.textContent = editorTitle.textContent || ''

  const close = document.createElement('button')
  close.type = 'button'
  close.className = 'spectro-lightbox-close'
  close.setAttribute('aria-label', 'Close')
  close.textContent = '✕'

  box.append(img, cap, close)
  overlay.appendChild(box)

  const dismiss = () => { overlay.remove(); document.removeEventListener('keydown', onKey) }
  const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') dismiss() }
  overlay.addEventListener('click', e => { if (e.target === overlay) dismiss() })
  close.addEventListener('click', dismiss)
  document.addEventListener('keydown', onKey)

  document.body.appendChild(overlay)
}

const updateEditorRenamePreview = debounce(async () => {
  const one = state.selectedIds.size === 1
    ? state.tracks.find(t => state.selectedIds.has(t.id)) : undefined
  if (!one || !renameOnSave || !renameTemplate) {
    // Still show a move that is already staged (e.g. from a folder drag or Rename files).
    const staged = one?.staged?.new_path
    editorRenamePreviewEl.hidden = !staged
    if (staged) {
      editorRenamePreviewEl.textContent = 'Will move to: ' + shortPath(staged)
      editorRenamePreviewEl.classList.remove('rename-preview-error')
    }
    return
  }
  const tags: Record<string, string> = {}
  for (const field of TAG_FIELDS) {
    const el = tagForm.elements.namedItem(field) as HTMLInputElement | HTMLTextAreaElement | null
    if (el) tags[field] = el.value
  }
  const track = state.tracks.find(t => state.selectedIds.has(t.id))
  const ext = track ? '.' + (track.filename.split('.').pop() || 'flac') : '.flac'
  try {
    const res = await api.settings.renamePreview(renameTemplate, tags, ext, one.id)
    editorRenamePreviewEl.hidden = false
    editorRenamePreviewEl.textContent = res.ok ? 'Saves to: ' + res.preview : (res.error ?? '')
    editorRenamePreviewEl.classList.toggle('rename-preview-error', !res.ok)
  } catch {
    editorRenamePreviewEl.hidden = true
  }
}, 250)

function updatePlayer() {
  if (state.selectedIds.size === 1) {
    const url = `/api/stream/${[...state.selectedIds][0]}`
    if (playerEl.getAttribute('src') !== url) playerEl.src = url
    playerEl.hidden = false
  } else {
    playerEl.pause()
    playerEl.removeAttribute('src')
    playerEl.load()
    playerEl.hidden = true
  }
}

function updateCoverPreview() {
  if (state.selectedIds.size === 0) return
  const firstId = [...state.selectedIds][0]
  coverPlaceholder.style.display = 'flex'
  coverImg.style.display = 'none'
  coverImg.src = coverUrl(firstId)
  coverImg.onload  = () => { coverImg.style.display = 'block'; coverPlaceholder.style.display = 'none' }
  coverImg.onerror = () => { coverImg.style.display = 'none';  coverPlaceholder.style.display = 'flex' }
}

const compilationCheckbox = () => tagForm.elements.namedItem('compilation') as HTMLInputElement

/**
 * Fill the editor for the selection. Part of it on other pages: ask the
 * server which values the whole selection shares (as staged).
 */
let formToken = 0
async function fillEditorForm() {
  const sel = state.tracks.filter(t => state.selectedIds.has(t.id))
  if (sel.length === state.selectedIds.size) {
    setReadOnly(sel.filter(t => t.read_only).length, sel.length)
    populateForm(sel); return
  }
  const token = ++formToken
  try {
    const sum = await api.library.summary([...state.selectedIds])
    if (token !== formToken) return
    setReadOnly(sum.read_only ?? 0, sum.count)
    const fake = {} as Record<string, string | null>
    for (const [k, v] of Object.entries(sum.values)) fake[k] = v
    // Two pseudo-tracks that differ exactly on the mixed fields.
    const a = { ...fake } as unknown as Track, b = { ...fake } as unknown as Track
    for (const f of sum.mixed) { (a as unknown as Record<string, string>)[f] = 'a'; (b as unknown as Record<string, string>)[f] = 'b' }
    populateForm([a, b])
  } catch (e) {
    toast(`Failed to load the selection: ${e}`, 'error')
  }
}

/** Several tracks: genre is edited as chips; one track: as plain text. */
let chipsToken = 0
function setGenreMode() {
  const multi = state.selectedIds.size > 1
  genreInput.hidden = multi
  genreChips.el.hidden = !multi
  if (!multi) return
  const ids = [...state.selectedIds]
  const token = ++chipsToken
  genreChips.load(ids.length, [], state.tagValues.get('genre') ?? [])
  Promise.all([
    api.library.valueCounts(ids, 'genre'),
    state.tagValues.has('genre') ? Promise.resolve() : loadTagValues('genre'),
  ]).then(([counts]) => {
    if (token === chipsToken) genreChips.load(counts.count, counts.values, state.tagValues.get('genre') ?? [])
  }).catch(e => toast(`Failed to load genres: ${e}`, 'error'))
}

function populateForm(tracks: Track[]) {
  for (const field of TAG_FIELDS) {
    const el = tagForm.elements.namedItem(field) as HTMLInputElement | HTMLTextAreaElement | null
    if (!el) continue
    const vals = tracks.map(t => (t[field as keyof Track] as string | null) ?? '')
    const allSame = vals.every(v => v === vals[0])
    if (allSame) {
      el.value = vals[0]; el.placeholder = ''; delete (el as HTMLElement).dataset.mixed
    } else {
      el.value = ''; el.placeholder = '(multiple values)'; (el as HTMLElement).dataset.mixed = '1'
    }
    el.closest('.field-label')?.classList.toggle('field-staged', tracks.some(t => t._orig && field in t._orig))
    delete (el as HTMLElement).dataset.dirty
  }
  setGenreMode()
  // compilation: boolean checkbox; indeterminate = mixed across the selection.
  const comp = tracks.map(t => t.compilation === '1')
  const compSame = comp.every(v => v === comp[0])
  const cb = compilationCheckbox()
  cb.indeterminate = !compSame
  cb.checked = compSame ? comp[0] : false
  delete cb.dataset.dirty
}

// ─── MusicBrainz lookup ───────────────────────────────────────────────────────

const SOURCE_BADGES: Record<string, { cls: string; label: string }> = {
  acoustid: { cls: 'source-acoustid', label: 'AcoustID' },
  discogs:  { cls: 'source-discogs',  label: 'Discogs' },
  filename: { cls: 'source-filename', label: 'Filename' },
  musicbrainz: { cls: 'source-mb', label: 'MusicBrainz' },
}

function renderSourceBadge(source: string): string {
  const b = SOURCE_BADGES[source] ?? SOURCE_BADGES.musicbrainz
  return `<span class="lookup-source-badge ${b.cls}">${b.label}</span>`
}

function attachEditions(li: HTMLElement, r: LookupResult) {
  const btn = li.querySelector<HTMLButtonElement>('.lookup-editions-btn')
  if (!btn || !r.mb_track_id) return
  let panel: HTMLElement | null = null
  let loaded = false
  btn.addEventListener('click', async (e) => {
    e.stopPropagation()
    if (panel) { panel.hidden = !panel.hidden; return }
    panel = document.createElement('ul')
    panel.className = 'lookup-editions'
    panel.innerHTML = '<li class="lookup-editions-note">Loading editions…</li>'
    li.appendChild(panel)
    try {
      const releases = await api.lookup.releases(r.mb_track_id!)
      loaded = true
      if (!releases.length) { panel.innerHTML = '<li class="lookup-editions-note">No releases found</li>'; return }
      panel.innerHTML = ''
      for (const rel of releases) {
        const row = document.createElement('li')
        row.className = 'lookup-edition'
        const bits = [rel.year, rel.country, rel.format, rel.track_count ? `${rel.track_count} tracks` : null]
          .filter(Boolean).join(' · ')
        row.innerHTML = `<span class="lookup-edition-album">${esc(rel.album || '(unknown)')}</span><span class="lookup-edition-meta">${esc(bits)}</span>`
        row.addEventListener('click', (ev) => {
          ev.stopPropagation()
          applyLookupResult({ ...r, album: rel.album, year: rel.year, mb_album_id: rel.mb_album_id })
        })
        panel.appendChild(row)
      }
    } catch (err) {
      if (!loaded) panel.innerHTML = `<li class="lookup-editions-note">Error: ${esc(String(err))}</li>`
    }
  })
}

async function runLookup() {
  if (state.selectedIds.size !== 1) return
  const trackId = [...state.selectedIds][0]

  lookupBtn.disabled = true
  lookupBtn.textContent = 'Looking up…'
  lookupPanel.hidden = false
  lookupResults.innerHTML = '<li class="lookup-searching">Searching MusicBrainz…</li>'

  try {
    const results = await api.lookup.search(trackId)
    lookupResults.innerHTML = ''

    if (!results.length) {
      lookupResults.innerHTML = '<li class="lookup-empty">No results found.</li>'
      return
    }

    for (const r of results) {
      const li = document.createElement('li')
      li.className = 'lookup-result'
      const pct = Math.round(r.score * 100)
      const scoreClass = pct >= 90 ? 'score-high' : pct >= 70 ? 'score-mid' : 'score-low'
      const sourceBadge = renderSourceBadge(r.source)
      const thumbHtml = r.mb_album_id
        ? `<img class="lookup-thumb" loading="lazy" src="https://coverartarchive.org/release/${r.mb_album_id}/front-250" alt="" />`
        : `<div class="lookup-thumb lookup-thumb-empty">♪</div>`
      const canPickEdition = r.source === 'musicbrainz' && !!r.mb_track_id
      const editionsBtn = canPickEdition
        ? `<button class="lookup-editions-btn" title="Choose a specific release/edition">Editions ▾</button>`
        : ''
      li.innerHTML = `
        ${thumbHtml}
        <span class="lookup-score ${scoreClass}">${pct}%</span>
        <span class="lookup-info">
          <span class="lookup-track-title">${esc(r.title || '(unknown)')} ${sourceBadge}</span>
          <span class="lookup-meta">${esc(r.artist || '')}${r.album ? ' · ' + esc(r.album) : ''}${r.year ? ' · ' + esc(r.year) : ''} ${editionsBtn}</span>
        </span>
      `
      // Hide broken thumbnails gracefully
      li.querySelector<HTMLImageElement>('.lookup-thumb')
        ?.addEventListener('error', function() { this.style.display = 'none' })
      li.addEventListener('click', () => applyLookupResult(r))
      if (canPickEdition) attachEditions(li, r)
      lookupResults.appendChild(li)
    }
  } catch (e) {
    lookupResults.innerHTML = `<li class="lookup-empty">Error: ${esc(String(e))}</li>`
  } finally {
    lookupBtn.disabled = false
    lookupBtn.textContent = 'Lookup'
  }
}

function applyLookupResult(r: LookupResult) {
  const fields: (keyof LookupResult)[] = ['title', 'artist', 'album', 'album_artist', 'year', 'track_number', 'disc_number']
  for (const field of fields) {
    const el = tagForm.elements.namedItem(field) as HTMLInputElement | null
    if (!el) continue
    el.value = (r[field] as string | null) ?? ''
    delete el.dataset.mixed
    el.dataset.dirty = '1'
  }

  // Store full lookup result so MB IDs are included on save
  state.pendingLookupResult = r
  state.pendingCoverAlbumId = r.mb_album_id
  if (r.mb_album_id) {
    coverPlaceholder.style.display = 'none'
    coverImg.style.display = 'block'
    coverImg.src = `https://coverartarchive.org/release/${r.mb_album_id}/front-250`
    coverImg.onerror = () => { coverImg.style.display = 'none'; coverPlaceholder.style.display = 'flex' }
  }

  lookupPanel.hidden = true
  const coverMsg = r.mb_album_id ? ' + cover art' : ''
  toast(`Applied${coverMsg} — review and save to write to file`, 'info')
}

// ─── Auto-fix ─────────────────────────────────────────────────────────────────

const FIX_SAVE_FIELDS: (keyof LookupResult)[] = [
  'title', 'artist', 'album', 'album_artist', 'year', 'track_number', 'disc_number',
  'mb_track_id', 'mb_artist_id', 'mb_album_id', 'mb_album_artist_id',
]

const FIX_DISPLAY_FIELDS: { key: keyof LookupResult; label: string }[] = [
  { key: 'title',        label: 'Title'        },
  { key: 'artist',       label: 'Artist'       },
  { key: 'album',        label: 'Album'        },
  { key: 'album_artist', label: 'Album Artist' },
  { key: 'year',         label: 'Year'         },
  { key: 'track_number', label: 'Track #'      },
  { key: 'disc_number',  label: 'Disc #'       },
]

interface FixProposal {
  track:  Track
  score:  number
  source: string
  update: Record<string, string>
}

async function buildProposal(track: Track): Promise<FixProposal | null> {
  const results = await api.lookup.search(track.id)
  if (!results.length) return null
  const top = results[0]
  const update: Record<string, string> = {}
  for (const f of FIX_SAVE_FIELDS) {
    const v = top[f]
    if (v != null) update[f as string] = v as string
  }
  if (!Object.keys(update).length) return null
  return { track, score: top.score, source: top.source, update }
}

function showFixConfirmation(proposals: FixProposal[], onConfirm: (p: FixProposal[]) => Promise<void>) {
  const overlay = document.createElement('div')
  overlay.className = 'fix-confirm-overlay'

  const modal = document.createElement('div')
  modal.className = 'fix-confirm-modal'

  const header = document.createElement('div')
  header.className = 'fix-confirm-header'
  header.innerHTML = `
    <span class="fix-confirm-title">Auto-fix — ${proposals.length} track${proposals.length !== 1 ? 's' : ''}</span>
    <button class="btn btn-ghost btn-icon fix-confirm-close">✕</button>
  `

  const body = document.createElement('div')
  body.className = 'fix-confirm-body'

  for (const p of proposals) {
    const pct = Math.round(p.score * 100)
    const scoreClass = pct >= 90 ? 'score-high' : pct >= 70 ? 'score-mid' : 'score-low'
    const rows = FIX_DISPLAY_FIELDS
      .filter(f => p.update[f.key as string] != null)
      .map(f => {
        const proposed = p.update[f.key as string]
        const current  = (p.track[f.key as keyof Track] as string | null) ?? ''
        return `<tr>
          <td class="fix-col-field">${esc(f.label)}</td>
          <td class="fix-col-current">${current ? esc(current) : '<span class="fix-empty">empty</span>'}</td>
          <td class="fix-col-arrow">→</td>
          <td class="fix-col-proposed">${esc(proposed)}</td>
        </tr>`
      }).join('')

    const section = document.createElement('div')
    section.className = 'fix-confirm-track'
    section.innerHTML = `
      <div class="fix-confirm-track-header">
        <span class="fix-confirm-track-name">${esc(p.track.title || p.track.filename)}</span>
        <span class="lookup-score ${scoreClass}">${pct}%</span>
        <span class="fix-confirm-source">${esc(p.source)}</span>
      </div>
      ${rows ? `<table class="fix-confirm-table"><tbody>${rows}</tbody></table>`
              : '<p class="fix-empty-note">No visible tag changes — only metadata IDs will be updated.</p>'}
    `
    body.appendChild(section)
  }

  const footer = document.createElement('div')
  footer.className = 'fix-confirm-footer'
  const cancelBtn = document.createElement('button')
  cancelBtn.className = 'btn btn-ghost'
  cancelBtn.textContent = 'Cancel'
  const applyBtn = document.createElement('button')
  applyBtn.className = 'btn btn-primary'
  applyBtn.textContent = `Apply ${proposals.length} change${proposals.length !== 1 ? 's' : ''}`
  footer.append(cancelBtn, applyBtn)

  modal.append(header, body, footer)
  overlay.appendChild(modal)
  document.body.appendChild(overlay)

  const close = () => overlay.remove()
  cancelBtn.addEventListener('click', close)
  header.querySelector<HTMLElement>('.fix-confirm-close')!.addEventListener('click', close)
  overlay.addEventListener('click', e => { if (e.target === overlay) close() })

  applyBtn.addEventListener('click', async () => {
    applyBtn.disabled = true
    applyBtn.textContent = 'Applying…'
    try { await onConfirm(proposals) } finally { close() }
  })
}

async function applyProposals(proposals: FixProposal[]) {
  let saved = 0
  let last
  for (const p of proposals) {
    try { last = await api.tags.update(p.track.id, p.update); saved++ } catch { /* skip */ }
  }
  editToast(last, `${saved} track${saved !== 1 ? 's' : ''}`)
  state.qualityIssues = null
  if (state.sidebarMode === 'tags') await loadLibrary()
  await loadTracks()
  if (state.sidebarMode === 'quality') await renderQualityPanel()
  await fillEditorForm()
  await refreshUndoButton()
}

async function gatherProposals(tracks: Track[], setLabel: (s: string) => void): Promise<FixProposal[]> {
  const proposals: FixProposal[] = []
  for (let i = 0; i < tracks.length; i++) {
    setLabel(tracks.length === 1 ? 'Looking up…' : `Looking up ${i + 1}/${tracks.length}…`)
    try { const p = await buildProposal(tracks[i]); if (p) proposals.push(p) } catch { /* skip */ }
  }
  return proposals
}

const autoFixBtn = document.getElementById('auto-fix-btn') as HTMLButtonElement

autoFixBtn.addEventListener('click', async () => {
  const tracks = state.tracks.filter(t => state.selectedIds.has(t.id))
  if (!tracks.length) return
  autoFixBtn.disabled = true
  const proposals = await gatherProposals(tracks, s => { autoFixBtn.textContent = s })
  autoFixBtn.disabled = false
  autoFixBtn.textContent = 'Auto-fix'
  if (!proposals.length) { toast('No matches found', 'info'); return }
  showFixConfirmation(proposals, applyProposals)
})

const fixAllBtn      = document.getElementById('fix-all-btn') as HTMLButtonElement
const dedupeBtn      = document.getElementById('dedupe-btn') as HTMLButtonElement
const refileBtn      = document.getElementById('refile-btn') as HTMLButtonElement
const qualityToolbar = document.getElementById('quality-toolbar') as HTMLElement

dedupeBtn.addEventListener('click', async () => {
  dedupeBtn.disabled = true
  try {
    const { removed } = await api.library.dedupeKeepBest()
    if (removed === 0) {
      toast('No duplicates to remove', 'info')
    } else {
      toast(`Removed ${removed} duplicate${removed !== 1 ? 's' : ''} — kept best quality`, 'success')
      state.qualityIssues = null
      await loadTracks()
      await renderQualityPanel()
      await refreshUndoButton()
    }
  } catch (e) {
    toast(`Dedupe failed: ${e}`, 'error')
  } finally {
    dedupeBtn.disabled = false
  }
})

// "Not in layout" view: stage moves for the CHOSEN tracks only -- never the
// whole list in one click (that was the 11-01 Organize incident).
refileBtn.addEventListener('click', async () => {
  const ids = [...state.selectedIds]
  if (!ids.length) { toast('Select the tracks to re-file first', 'info'); return }
  const n = `${ids.length} track${ids.length !== 1 ? 's' : ''}`
  if (!confirm(stageChanges
    ? `Stage moving ${n} to the path its library layout gives? Nothing moves until you write it from Review.`
    : `Move ${n} to the path its library layout gives now? (Undo is in History.)`)) return
  refileBtn.disabled = true
  try {
    const res = await api.tags.refile(ids)
    const errNote = res.errors.length ? ` — ${res.errors.length} skipped: ${res.errors[0].error}` : ''
    if (res.missing) toast(`Nothing written: ${missingText(res.errors)}`, 'error')
    else if (res.staged) toast(`Staged re-filing ${res.planned} track${res.planned !== 1 ? 's' : ''} — Review to write${errNote}`, res.planned ? 'info' : 'error')
    else toast(`Re-filed ${res.moved} track${res.moved !== 1 ? 's' : ''}${errNote}`, res.moved ? 'success' : 'error')
    state.qualityIssues = null
    await (res.staged ? refreshAfterStage() : refreshAfterWrite())
    await renderQualityPanel()
  } catch (e) {
    toast(`Re-file failed: ${errText(e)}`, 'error')
  } finally {
    refileBtn.disabled = false
  }
})

fixAllBtn.addEventListener('click', async () => {
  const tracks = [...state.tracks]
  if (!tracks.length) return
  fixAllBtn.disabled = true
  const proposals = await gatherProposals(tracks, s => { fixAllBtn.textContent = s })
  fixAllBtn.disabled = false
  fixAllBtn.textContent = 'Fix All'
  if (!proposals.length) { toast('No matches found', 'info'); return }
  showFixConfirmation(proposals, applyProposals)
})

// ─── Scan status ──────────────────────────────────────────────────────────────

function renderScanStatus() {
  const job = state.scanJob
  const live = !!job && (job.status === 'running' || job.status === 'pending')
  scanStatusEl.hidden = !live
  document.getElementById('bg-dot')!.hidden = !live
  if (!live) { scanStatusEl.textContent = ''; return }
  const listing = job!.phase === 'listing' || (!job!.scanned && job!.phase !== 'reading')
  const pct = job!.total && !listing ? Math.round((job!.scanned / job!.total) * 100) : 0
  scanStatusEl.textContent = job!.status === 'pending' ? 'Starting scan…'
    : listing ? `Finding files… ${job!.total ? job!.total.toLocaleString() : ''}`
    : `Scanning… ${job!.scanned.toLocaleString()}/${job!.total.toLocaleString()} (${pct}%)`
}

// ─── Data loading ─────────────────────────────────────────────────────────────

async function loadLibrary() {
  try {
    const [artists, albums] = await Promise.all([
      api.library.artists(),
      api.library.albums(),
    ])
    state.artists = artists
    // Group albums by artist; expand all artists by default
    state.albumsByArtist = new Map()
    for (const alb of albums) {
      const key = alb.artist ?? ''
      if (!state.albumsByArtist.has(key)) {
        state.albumsByArtist.set(key, [])
      }
      state.albumsByArtist.get(key)!.push(alb)
    }
    // Values change with every write: refetch the open tags, forget the rest.
    const open = [...state.expandedTags]
    state.tagValues = new Map()
    await Promise.all(open.map(loadTagValues))
    renderTagsPanel()
  } catch (e) {
    toast(`Failed to load library: ${e}`, 'error')
  }
}

function expandedPaths(node: DirNode | null, out: string[] = []): string[] {
  if (!node) return out
  if (node.expanded && node.path) out.push(node.path)
  for (const c of node.children ?? []) expandedPaths(c, out)
  return out
}

async function loadTree() {
  // Reloading after a write: re-open what was open (folders that moved away just stay shut).
  const reopen = expandedPaths(state.rootNode).sort((a, b) => a.length - b.length)
  try {
    const result = await api.fs.tree()
    const name = result.path
      ? (result.path.split('/').filter(Boolean).pop() ?? result.path)
      : 'Music Library'
    state.rootNode = {
      name,
      path:     result.path,
      children: result.dirs.map(d => ({ name: d.name, path: d.path, hasDirs: d.has_dirs, children: null, loading: false, expanded: false })),
      loading:  false,
      expanded: true,
    }
    for (const path of reopen) {
      const node = findDirNode(path)
      if (node && node !== state.rootNode && !node.expanded) await expandDirNode(node)
    }
    renderFilesPanel()
  } catch (e) {
    toast(`Failed to load directory tree: ${e}`, 'error')
  }
}

async function expandDirNode(node: DirNode) {
  if (node.loading) return
  if (node.children !== null) {
    node.expanded = !node.expanded
    renderFilesPanel()
    return
  }
  node.loading = true
  renderFilesPanel()
  try {
    const result = await api.fs.tree(node.path)
    node.children = result.dirs.map(d => ({ name: d.name, path: d.path, hasDirs: d.has_dirs, children: null, loading: false, expanded: false }))
    node.expanded  = true
    node.loading   = false
  } catch (e) {
    node.loading = false
    toast(`Failed to expand directory: ${e}`, 'error')
  }
  renderFilesPanel()
}

async function loadTracks() {
  trackLoading.hidden = false
  trackTbody.innerHTML = ''
  trackEmpty.hidden = true

  const offset = state.page * PAGE_SIZE

  try {
    let result
    if (state.sidebarMode === 'quality' && !state.query && !state.selectedIssue) {
      state.tracks = []; state.total = 0; renderTracks(); renderPagination(); return
    }
    if (state.sidebarMode === 'quality' && !state.query && state.selectedIssue === 'missing_files') {
      result = await api.library.dead()
    } else {
      result = await api.library.tracks({ ...viewParams(), limit: PAGE_SIZE, offset })
    }
    state.tracks = result.tracks.map(overlayStaged)
    state.total  = result.total
    renderTracks()
    renderPagination()
    if (state.viewMode === 'albums' && albumStyle === 'list') renderAlbumList()   // same filters as the tracks
  } catch (e) {
    toast(`Failed to load tracks: ${e}`, 'error')
    trackLoading.hidden = true
  }
}

// ─── Scan ─────────────────────────────────────────────────────────────────────

/** The header's Scan Library is for first-time setup; afterwards it lives in Settings. */
async function updateScanBtnVisibility() {
  try { scanBtn.hidden = (await api.about()).tracks > 0 } catch { /* keep as is */ }
}

function updateRescanBtn() {
  rescanFolderBtn.disabled = state.selectedDirectory === null || state.scanPollTimer !== null
  const movable = isMovableFolder(state.selectedDirectory)
  moveFolderBtn.disabled = renameFolderBtn.disabled = !movable
}

async function startScan(directory?: string) {
  try {
    scanBtn.disabled = true
    rescanFolderBtn.disabled = true
    const { job_id } = await api.jobs.startScan(directory)
    pollScan(job_id)
  } catch (e) {
    const msg = String(e).includes('409') ? 'A scan is already running' : `Scan failed to start: ${e}`
    toast(msg, 'error')
    scanBtn.disabled = false
    updateRescanBtn()
  }
}

function pollScan(jobId: string) {
  if (state.scanPollTimer) clearInterval(state.scanPollTimer)
  state.scanPollTimer = setInterval(async () => {
    try {
      const job = await api.jobs.get(jobId)
      state.scanJob = job
      renderScanStatus()
      if (job.status !== 'running' && job.status !== 'pending') {
        clearInterval(state.scanPollTimer!)
        state.scanPollTimer = null
        scanBtn.disabled = false
        updateRescanBtn()
        updateScanBtnVisibility()
        if (job.status === 'done') {
          toast(`Scan complete — ${job.total.toLocaleString()} files, ${(job.changed ?? 0).toLocaleString()} changed`, 'success')
          state.qualityIssues = null
          await loadLibrary()
          await loadTree()
          await loadTracks()
          if (state.sidebarMode === 'quality') await renderQualityPanel()
        } else if (job.status === 'cancelled') {
          toast('Scan cancelled — what it read is kept', 'info')
          await loadTracks()
        } else {
          toast(`Scan ${job.status}: ${job.error ?? ''}`, 'error')
        }
        renderScanStatus()
      }
    } catch (e) {
      clearInterval(state.scanPollTimer!)
      state.scanPollTimer = null
      scanBtn.disabled = false
      updateRescanBtn()
      toast(`Scan polling failed: ${e}`, 'error')
    }
  }, 1000)
}

// ─── Tag saving ───────────────────────────────────────────────────────────────

async function saveTags(e: Event) {
  e.preventDefault()
  const update: Record<string, string> = {}
  // Only fields the user changed: the form may stand for tracks on other
  // pages whose values it doesn't show, so re-sending the rest could clobber them.
  for (const field of TAG_FIELDS) {
    const el = tagForm.elements.namedItem(field) as HTMLInputElement | HTMLTextAreaElement | null
    if (!el || (el as HTMLElement).dataset.dirty !== '1') continue
    update[field] = el.value
  }
  const cb = compilationCheckbox()
  if (cb.dataset.dirty === '1' && !cb.indeterminate) update.compilation = cb.checked ? '1' : ''
  // Attach MB IDs from pending lookup result
  if (state.pendingLookupResult) {
    const r = state.pendingLookupResult
    if (r.mb_track_id)        update.mb_track_id        = r.mb_track_id
    if (r.mb_artist_id)       update.mb_artist_id       = r.mb_artist_id
    if (r.mb_album_id)        update.mb_album_id        = r.mb_album_id
    if (r.mb_album_artist_id) update.mb_album_artist_id = r.mb_album_artist_id
  }

  const chips = state.selectedIds.size > 1 && genreChips.dirty
  if (Object.keys(update).length === 0 && !chips) { toast('No changes to save', 'info'); return }

  const ids = [...state.selectedIds]
  try {
    let res: import('./api').EditResult | undefined
    if (Object.keys(update).length) {
      res = ids.length === 1
        ? await api.tags.update(ids[0], update)
        : await api.tags.bulk(ids, update)
    }
    if (chips) {
      const r = await api.tags.editValues(ids, 'genre', genreChips.add, genreChips.remove)
      if (r.changed || !res) res = r
      state.tagValues.delete('genre')
    }
    const what = ids.length === 1 ? 'tags' : `tags on ${ids.length} tracks`

    // Write cover art from Cover Art Archive if one was selected via lookup
    if (state.pendingCoverAlbumId) {
      const albumId = state.pendingCoverAlbumId
      try {
        await Promise.all(ids.map(id => api.lookup.applyCover(id, albumId)))
        state.pendingCoverAlbumId = null
        state.pendingLookupResult = null
        state.coverBust++
        updateCoverPreview()
        if (state.viewMode === 'albums') renderAlbumView()
        // Cover art is written straight away; it isn't staged.
        editToast(res, `${what} (cover art written)`)
      } catch {
        toast('Cover art write failed', 'error')
      }
    } else {
      state.pendingLookupResult = null
      editToast(res, what)
    }

    state.qualityIssues = null
    if (state.sidebarMode === 'tags') await loadLibrary()
    await loadTracks()
    await fillEditorForm()
    await refreshUndoButton()
  } catch (e) {
    toast(`Save failed: ${e}`, 'error')
  }
}

// ─── Normalize case ───────────────────────────────────────────────────────────

async function normalizeCaseBulk() {
  const selected = state.tracks.filter(t => state.selectedIds.has(t.id))
  if (!selected.length) return

  const tasks: Array<Promise<import('./api').EditResult>> = []
  let changeCount = 0

  for (const track of selected) {
    const upd: Record<string, string> = {}
    for (const field of NORMALIZE_FIELDS) {
      const val = track[field] as string | null
      if (needsNormalization(val)) upd[field as string] = toTitleCase(val!)
    }
    if (Object.keys(upd).length) {
      changeCount++
      tasks.push(api.tags.update(track.id, upd))
    }
  }

  if (!tasks.length) { toast('No tags needed normalization', 'info'); return }

  normalizeCaseBtn.disabled = true
  try {
    const results = await Promise.all(tasks)
    editToast(results[0], `case on ${changeCount} track${changeCount !== 1 ? 's' : ''}`)
    state.qualityIssues = null
    if (state.sidebarMode === 'tags') await loadLibrary()
    await loadTracks()
    if (state.sidebarMode === 'quality') await renderQualityPanel()
    await fillEditorForm()
    await refreshUndoButton()
  } catch (e) {
    toast(`Normalize failed: ${e}`, 'error')
  } finally {
    normalizeCaseBtn.disabled = false
  }
}

// ─── Remove dead tracks ───────────────────────────────────────────────────────

async function removeFromLibrary() {
  const ids = [...state.selectedIds]
  if (!ids.length) return
  removeTracksBtn.disabled = true
  try {
    const { removed } = await api.library.removeTracks(ids)
    toast(`Removed ${removed} track${removed !== 1 ? 's' : ''} from library`, 'success')
    state.selectedIds.clear()
    state.qualityIssues = null
    await loadTracks()
    renderEditor()
    await renderQualityPanel()
    await refreshUndoButton()
  } catch (e) {
    toast(`Failed to remove tracks: ${e}`, 'error')
  } finally {
    removeTracksBtn.disabled = false
  }
}

// ─── Delete files ─────────────────────────────────────────────────────────────────

async function deleteFiles() {
  const ids = [...state.selectedIds]
  if (!ids.length) return
  const ok = confirm(
    `Move ${ids.length} file${ids.length !== 1 ? 's' : ''} to trash?\n\n` +
    `The files leave your library folder but can be restored with Undo.`
  )
  if (!ok) return
  deleteFilesBtn.disabled = true
  try {
    const { deleted } = await api.library.deleteFiles(ids)
    toast(`Moved ${deleted} file${deleted !== 1 ? 's' : ''} to trash`, 'success')
    state.selectedIds.clear()
    state.qualityIssues = null
    await loadTracks()
    renderEditor()
    if (state.sidebarMode === 'quality') await renderQualityPanel()
    await refreshUndoButton()
  } catch (e) {
    toast(`Delete failed: ${e}`, 'error')
  } finally {
    deleteFilesBtn.disabled = false
  }
}


// ─── Folder move / rename ───────────────────────────────────────────────────────

function isMovableFolder(path: string | null): boolean {
  return path !== null && path !== ''
    && !state.musicDirs.includes(path)
    && !state.libraryRoots.some(r => r === path || r.startsWith(path + '/'))
}

function rootOf(path: string): string | undefined {
  return [...state.libraryRoots].sort((a, b) => b.length - a.length)
    .find(r => path.startsWith(r + '/'))
}

async function afterFolderStage(res: import('./api').EditResult, what: string) {
  if (res.staged) toast(`Staged ${what} — Review to write`, 'info')
  else if (res.missing) toast(`Nothing written: ${missingText(res.errors ?? [])}`, 'error')
  else if (res.errors?.length) toast(`${what} failed: ${res.errors[0].error}`, 'error')
  else toast(`Done: ${what}`, 'success')
  if (res.staged) { await refreshAfterStage(); return }
  if (state.selectedDirectory && !(await dirExists(state.selectedDirectory))) state.selectedDirectory = null
  await refreshAfterWrite()
}

async function dirExists(path: string): Promise<boolean> {
  try { await api.fs.tree(path); return true } catch { return false }
}

function showMoveFolder() {
  const src = state.selectedDirectory
  if (!src) return
  const from = rootOf(src)
  const rel = from ? src.slice(from.length + 1) : src.split('/').pop()!
  const overlay = document.createElement('div')
  overlay.className = 'modal-overlay'
  overlay.innerHTML = `
    <form class="modal-card modal-wide" id="mv-form">
      <div class="modal-title">Move folder</div>
      <div class="modal-path">${esc(shortPath(src))}</div>
      <label class="field-label">To library
        <select id="mv-root">${state.libraryRoots.map(r =>
          `<option value="${esc(r)}"${r === from ? ' selected' : ''}>${esc(shortPath(r))}</option>`).join('')}</select>
      </label>
      <label class="field-label">As folder
        <input id="mv-rel" type="text" autocomplete="off" value="${esc(rel)}" />
      </label>
      <div id="mv-preview" class="rename-preview"></div>
      <p class="settings-hint">Everything in the folder moves with it — cover art too. Staged: nothing moves until you write it from Review.</p>
      <div class="modal-actions">
        <button type="button" class="btn btn-ghost" id="mv-cancel">Cancel</button>
        <button type="submit" class="btn btn-primary">Stage move</button>
      </div>
    </form>`
  document.body.appendChild(overlay)
  const close = () => overlay.remove()
  overlay.addEventListener('click', e => { if (e.target === overlay) close() })
  overlay.querySelector('#mv-cancel')!.addEventListener('click', close)
  const rootEl = overlay.querySelector<HTMLSelectElement>('#mv-root')!
  const relEl  = overlay.querySelector<HTMLInputElement>('#mv-rel')!
  const prevEl = overlay.querySelector<HTMLElement>('#mv-preview')!
  const dst = () => rootEl.value + '/' + relEl.value.split('/').map(p => p.trim()).filter(Boolean).join('/')
  const preview = () => { prevEl.textContent = '→ ' + shortPath(dst()) }
  rootEl.addEventListener('change', preview)
  relEl.addEventListener('input', preview)
  preview()
  relEl.focus()
  overlay.querySelector<HTMLFormElement>('#mv-form')!.addEventListener('submit', async (e) => {
    e.preventDefault()
    try {
      const res = await api.fs.move(src, dst())
      close()
      await afterFolderStage(res, `move of ${src.split('/').pop()}`)
    } catch (err) {
      toast(`Can't move: ${errText(err)}`, 'error')
    }
  })
}

function showRenameFolder() {
  const path = state.selectedDirectory
  if (!path) return
  const name = path.split('/').pop()!
  const overlay = document.createElement('div')
  overlay.className = 'modal-overlay'
  overlay.innerHTML = `
    <form class="modal-card modal-wide" id="rn-form">
      <div class="modal-title">Rename folder</div>
      <div class="modal-path">${esc(shortPath(path))}</div>
      <label class="field-label">New name<input id="rn-name" type="text" autocomplete="off" value="${esc(name)}" /></label>
      <div class="modal-actions">
        <button type="button" class="btn btn-ghost" id="rn-cancel">Cancel</button>
        <button type="submit" class="btn btn-primary">Stage rename</button>
      </div>
    </form>`
  document.body.appendChild(overlay)
  const close = () => overlay.remove()
  overlay.addEventListener('click', e => { if (e.target === overlay) close() })
  overlay.querySelector('#rn-cancel')!.addEventListener('click', close)
  const input = overlay.querySelector<HTMLInputElement>('#rn-name')!
  input.focus()
  input.select()
  overlay.querySelector<HTMLFormElement>('#rn-form')!.addEventListener('submit', async (e) => {
    e.preventDefault()
    try {
      const res = await api.fs.rename(path, input.value)
      close()
      await afterFolderStage(res, `rename of ${name}`)
    } catch (err) {
      toast(`Can't rename: ${errText(err)}`, 'error')
    }
  })
}

moveFolderBtn.addEventListener('click', showMoveFolder)

// Bulk rename: list order = the view's order (counters number in that order).
document.getElementById('mb-album-btn')!.addEventListener('click', () => {
  const ids = [...state.selectedIds]
  if (ids.length) openMbAlbum(ids, refreshAfterBulk)
})
document.getElementById('lyrics-btn')!.addEventListener('click', () => {
  const ids = [...state.selectedIds]
  if (ids.length) openLyrics(ids, refreshAfterBulk)
})
document.getElementById('merge-albums-btn')!.addEventListener('click', () => {
  const ids = [...state.selectedIds]
  if (ids.length) openMergeAlbums(ids, refreshAfterBulk)
})
document.getElementById('parse-names-btn')!.addEventListener('click', () => {
  const ids = [...state.selectedIds]
  if (ids.length) openParseNames(ids, refreshAfterBulk)
})
document.getElementById('bulk-rename-btn')!.addEventListener('click', () => {
  const onPage = state.tracks.filter(t => state.selectedIds.has(t.id)).map(t => t.id)
  const ids = onPage.length === state.selectedIds.size ? onPage : [...state.selectedIds]
  if (ids.length) openBulkRename(ids, refreshAfterStage)
})

// ─── Drag and drop: folders and tracks onto a folder in the Files tree ─────────
// A drop stages a move (same as Move…); nothing touches disk until written.

const DND_DIR = 'application/x-tagger-dir'
const DND_TRACKS = 'application/x-tagger-tracks'
let dragExpandTimer: ReturnType<typeof setTimeout> | null = null
let dragOverRow: HTMLElement | null = null

function dragBadge(e: DragEvent, text: string) {
  const el = document.createElement('div')
  el.className = 'drag-badge'
  el.textContent = text
  document.body.appendChild(el)
  e.dataTransfer!.setDragImage(el, -10, -10)
  setTimeout(() => el.remove(), 0)
}

dirTreeEl.addEventListener('dragstart', (e) => {
  const row = (e.target as HTMLElement).closest<HTMLElement>('.tree-row')
  if (!row?.dataset.path || !row.draggable) { e.preventDefault(); return }
  e.dataTransfer!.setData(DND_DIR, row.dataset.path)
  e.dataTransfer!.effectAllowed = 'move'
  dragBadge(e, '📁 ' + row.dataset.path.split('/').pop())
})

trackTbody.addEventListener('dragstart', (e) => {
  const tr = (e.target as HTMLElement).closest<HTMLTableRowElement>('tr')
  if (!tr?.dataset.id) return
  const id = parseInt(tr.dataset.id, 10)
  // Dragging an unselected row moves just that row; a selected one, the selection.
  if (!state.selectedIds.has(id)) {
    state.selectedIds.clear()
    state.selectedIds.add(id)
    renderTracks()
    renderEditor()
  }
  const ids = [...state.selectedIds]
  e.dataTransfer!.setData(DND_TRACKS, JSON.stringify(ids))
  e.dataTransfer!.effectAllowed = 'move'
  dragBadge(e, `♪ ${ids.length} track${ids.length !== 1 ? 's' : ''}`)
})

function clearDropTarget() {
  dragOverRow?.classList.remove('drop-target')
  dragOverRow = null
  if (dragExpandTimer) { clearTimeout(dragExpandTimer); dragExpandTimer = null }
}

dirTreeEl.addEventListener('dragover', (e) => {
  const types = e.dataTransfer?.types ?? []
  if (!types.includes(DND_DIR) && !types.includes(DND_TRACKS)) return
  const row = (e.target as HTMLElement).closest<HTMLElement>('.tree-row')
  if (!row?.dataset.path) { clearDropTarget(); return }
  e.preventDefault()
  e.dataTransfer!.dropEffect = 'move'
  if (row === dragOverRow) return
  clearDropTarget()
  dragOverRow = row
  row.classList.add('drop-target')
  // Hover a closed folder to open it, so drops can go deep.
  const node = findDirNode(row.dataset.path)
  if (node && !node.expanded) {
    dragExpandTimer = setTimeout(() => { expandDirNode(node) }, 700)
  }
})

dirTreeEl.addEventListener('dragleave', (e) => {
  if (!dirTreeEl.contains(e.relatedTarget as Node)) clearDropTarget()
})

dirTreeEl.addEventListener('drop', async (e) => {
  const row = (e.target as HTMLElement).closest<HTMLElement>('.tree-row')
  const target = row?.dataset.path
  clearDropTarget()
  if (!target) return
  e.preventDefault()
  const dir = e.dataTransfer!.getData(DND_DIR)
  const tracks = e.dataTransfer!.getData(DND_TRACKS)
  try {
    if (dir) {
      const name = dir.split('/').pop()!
      if (target === dir || target.startsWith(dir + '/') || dir.slice(0, dir.lastIndexOf('/')) === target) return
      const res = await api.fs.move(dir, `${target}/${name}`)
      await afterFolderStage(res, `move of ${name} → ${target.split('/').pop()}`)
    } else if (tracks) {
      const ids = JSON.parse(tracks) as number[]
      const res = await api.tags.moveTo(ids, target)
      const errNote = res.errors.length ? ` — ${res.errors.length} skipped: ${res.errors[0].error}` : ''
      if (res.missing) toast(`Nothing written: ${missingText(res.errors)}`, 'error')
      else if (!res.planned && !res.errors.length) toast('Already in that folder', 'info')
      else if (res.staged) toast(`Staged moving ${res.planned} track${res.planned !== 1 ? 's' : ''} → ${target.split('/').pop()} — Review to write${errNote}`, res.planned ? 'info' : 'error')
      else toast(`Moved ${res.moved} track${res.moved !== 1 ? 's' : ''}${errNote}`, res.moved ? 'success' : 'error')
      await (res.staged ? refreshAfterStage() : refreshAfterWrite())
    }
  } catch (err) {
    toast(`Can't move there: ${errText(err)}`, 'error')
  }
})
renameFolderBtn.addEventListener('click', showRenameFolder)

// ─── Album flows: auto-number & find/replace ────────────────────────────────────

async function refreshAfterBulk() {
  state.qualityIssues = null
  if (state.sidebarMode === 'tags') await loadLibrary()
  await loadTracks()
  if (state.sidebarMode === 'quality') await renderQualityPanel()
  await fillEditorForm()
  await refreshUndoButton()
}

async function autoNumber() {
  const ids = [...state.selectedIds]
  if (!ids.length) return
  autonumberBtn.disabled = true
  try {
    const res = await api.tags.autonumber(ids)
    editToast(res, `numbers on ${res.numbered} track${res.numbered !== 1 ? 's' : ''}`)
    await refreshAfterBulk()
  } catch (e) {
    toast(`Auto-number failed: ${e}`, 'error')
  } finally {
    autonumberBtn.disabled = false
  }
}

const FIND_REPLACE_FIELDS: { key: string; label: string }[] = [
  { key: 'title', label: 'Title' }, { key: 'artist', label: 'Artist' },
  { key: 'album', label: 'Album' }, { key: 'album_artist', label: 'Album Artist' },
  { key: 'genre', label: 'Genre' }, { key: 'composer', label: 'Composer' },
  { key: 'comment', label: 'Comment' },
]

function showFindReplace() {
  const ids = [...state.selectedIds]
  if (!ids.length) return
  const overlay = document.createElement('div')
  overlay.className = 'modal-overlay'
  overlay.innerHTML = `
    <form class="modal-card" id="fr-form">
      <div class="modal-title">Find & replace in ${ids.length} track${ids.length !== 1 ? 's' : ''}</div>
      <label class="field-label">Field
        <select id="fr-field">${FIND_REPLACE_FIELDS.map(f => `<option value="${f.key}">${f.label}</option>`).join('')}</select>
      </label>
      <label class="field-label">Find<input id="fr-find" type="text" autocomplete="off" /></label>
      <label class="field-label">Replace with<input id="fr-replace" type="text" autocomplete="off" /></label>
      <div class="modal-actions">
        <button type="button" class="btn btn-ghost" id="fr-cancel">Cancel</button>
        <button type="submit" class="btn btn-primary">Replace</button>
      </div>
    </form>
  `
  document.body.appendChild(overlay)
  const close = () => overlay.remove()
  overlay.addEventListener('click', e => { if (e.target === overlay) close() })
  overlay.querySelector('#fr-cancel')!.addEventListener('click', close)
  const findInput = overlay.querySelector<HTMLInputElement>('#fr-find')!
  findInput.focus()
  overlay.querySelector<HTMLFormElement>('#fr-form')!.addEventListener('submit', async (e) => {
    e.preventDefault()
    const field = overlay.querySelector<HTMLSelectElement>('#fr-field')!.value
    const find = findInput.value
    const replace = overlay.querySelector<HTMLInputElement>('#fr-replace')!.value
    if (!find) { findInput.focus(); return }
    try {
      const res = await api.tags.findReplace(ids, field, find, replace)
      if (res.changed) editToast(res, `replacements in ${res.changed} track${res.changed !== 1 ? 's' : ''}`)
      else toast('No matches found', 'info')
      close()
      await refreshAfterBulk()
    } catch (err) {
      toast(`Find/replace failed: ${err}`, 'error')
    }
  })
}

// ─── Infer tags from filename ───────────────────────────────────────────────────

async function inferFromFilename() {
  if (state.selectedIds.size !== 1) return
  const trackId = [...state.selectedIds][0]
  inferBtn.disabled = true
  inferBtn.textContent = 'Reading…'
  try {
    const result = await api.lookup.infer(trackId)
    if (!result) { toast('Could not infer anything from the file name', 'info'); return }
    applyLookupResult(result)
  } catch (e) {
    toast(`Inference failed: ${e}`, 'error')
  } finally {
    inferBtn.disabled = false
    inferBtn.textContent = 'From filename'
  }
}

// ─── Export current view as M3U ─────────────────────────────────────────────────

function currentViewParams(): Record<string, string | number> {
  if (state.query) return { q: state.query }
  if (state.sidebarMode === 'files') {
    return state.selectedDirectory !== null ? { directory: state.selectedDirectory } : {}
  }
  if (state.sidebarMode === 'quality') {
    return state.selectedIssue && state.selectedIssue !== 'missing_files'
      ? { issue: state.selectedIssue }
      : {}
  }
  const params: Record<string, string | number> = {}
  if (state.selectedTag) { params.tag = state.selectedTag.field; params.value = state.selectedTag.value }
  if (state.selectedArtist !== null) params.artist = state.selectedArtist
  if (state.selectedAlbum !== null) params.album = state.selectedAlbum
  return params
}

function exportM3u() {
  if (!state.total) { toast('Nothing to export', 'info'); return }
  const url = api.library.exportM3uUrl(viewParams())
  const a = document.createElement('a')
  a.href = url
  a.download = 'tagger-export.m3u'
  document.body.appendChild(a)
  a.click()
  a.remove()
}

// ─── ReplayGain scan ────────────────────────────────────────────────────────────

async function scanReplayGain() {
  const ids = [...state.selectedIds]
  if (!ids.length) return
  replaygainBtn.disabled = true
  replaygainBtn.textContent = 'Scanning…'
  try {
    const res = await api.tags.replaygain(ids, ids.length > 1)
    if (res.ok) {
      toast(`ReplayGain written to ${res.processed} track${res.processed !== 1 ? 's' : ''} (${res.tool})`, 'success')
    } else {
      toast(`ReplayGain failed: ${res.error ?? 'unknown error'}`, 'error')
    }
  } catch (e) {
    toast(`ReplayGain failed: ${e}`, 'error')
  } finally {
    replaygainBtn.disabled = false
    replaygainBtn.textContent = 'ReplayGain'
  }
}

// ─── Undo / history ─────────────────────────────────────────────────────────────

// ↶ undoes the newest STAGED step first (nothing on disk changes); with
// nothing staged it undoes the newest written change.
let undoTarget: { kind: 'staged' } | { kind: 'written'; id: number } | null = null

async function refreshReviewButton() {
  try {
    const { count } = await api.staged.count()
    reviewBtn.hidden = count === 0
    reviewBtn.textContent = `Review ${count} change${count !== 1 ? 's' : ''}`
  } catch {
    reviewBtn.hidden = true
  }
}

/** Reload everything an edit, write or undo can change. */
/** After staging only: nothing on disk moved, so leave the tree alone. */
async function refreshAfterStage() {
  await loadTracks()
  renderEditor()
  await refreshUndoButton()
}

async function refreshAfterWrite() {
  state.qualityIssues = null
  if (state.sidebarMode === 'tags') await loadLibrary()
  if (state.sidebarMode === 'files') await loadTree()
  await loadTracks()
  if (state.sidebarMode === 'quality') await renderQualityPanel()
  renderEditor()
  await refreshUndoButton()
}

async function refreshUndoButton() {
  refreshReviewButton()
  try {
    const st = await api.staged.count()
    if (st.last_step) {
      undoTarget = { kind: 'staged' }
      undoBtn.hidden = false
      undoBtn.title = `Undo staged: ${st.last_step.summary}`
      return
    }
    const history = await api.library.history(10)
    const undoable = history.find(h => !h.undone)
    undoTarget = undoable ? { kind: 'written', id: undoable.id } : null
    undoBtn.hidden = !undoable
    undoBtn.title = undoable ? `Undo: ${undoable.summary}` : 'Nothing to undo'
  } catch {
    undoBtn.hidden = true
  }
}

async function undoLast() {
  const target = undoTarget
  if (!target) return
  undoBtn.disabled = true
  try {
    if (target.kind === 'staged') {
      const r = await api.staged.undo()
      toast(`Undid staged: ${r.summary}`, 'success')
      await refreshAfterWrite()
      return
    }
    undoToast(await api.library.undo(target.id))
    state.qualityIssues = null
    if (state.sidebarMode === 'tags') await loadLibrary()
    await loadTracks()
    if (state.sidebarMode === 'quality') await renderQualityPanel()
    renderEditor()
  } catch (e) {
    toast(`Undo failed: ${errText(e)}`, 'error')
  } finally {
    undoBtn.disabled = false
    await refreshUndoButton()
  }
}

// ─── Event handlers ───────────────────────────────────────────────────────────

function onSelectAll() {
  const sa = selectAll()
  if (!sa) return
  state.tracks.forEach(t => {
    if (sa.checked && !t.read_only) state.selectedIds.add(t.id); else state.selectedIds.delete(t.id)
  })
  renderTracks()
  renderEditor()
}

// ─── Event wiring ─────────────────────────────────────────────────────────────

selectViewBtn.addEventListener('click', async () => {
  selectViewBtn.disabled = true
  try {
    const { ids } = await api.library.trackIds(viewParams())
    state.selectedIds = new Set(ids)
    renderTracks()
    renderEditor()
  } catch (e) {
    toast(`Select all failed: ${e}`, 'error')
  } finally {
    selectViewBtn.disabled = false
  }
})

document.getElementById('sidebar-toggle')!.addEventListener('click', () => {
  appEl.classList.toggle('sidebar-collapsed')
})

// On phones/tablets the sidebar overlays the content, so start it collapsed
// and close it once the user picks something from it.
const MOBILE_BP = 820
if (window.innerWidth <= MOBILE_BP) appEl.classList.add('sidebar-collapsed')
document.querySelector('.sidebar')!.addEventListener('click', (e) => {
  if (window.innerWidth > MOBILE_BP) return
  if ((e.target as HTMLElement).closest('.nav-item, .tree-row, .quality-issue-item')) {
    appEl.classList.add('sidebar-collapsed')
  }
})

// ─── Resizable panes ──────────────────────────────────────────────────────────
// The left nav and the right tag editor can each be widened by dragging the
// divider beside them; widths persist per-browser and reset on double-click.
const PANE = {
  sidebar: { key: 'tagger_sidebar_w', varName: '--sidebar-w', def: 220, min: 160, max: 560, el: sidebarEl },
  editor:  { key: 'tagger_editor_w',  varName: '--editor-w',  def: 272, min: 240, max: 720, el: tagEditor },
} as const
type PaneName = keyof typeof PANE

const clampPane = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))

function applyPaneWidth(name: PaneName, px: number) {
  document.documentElement.style.setProperty(PANE[name].varName, `${Math.round(px)}px`)
}

function restorePaneWidths() {
  for (const name of Object.keys(PANE) as PaneName[]) {
    const p = PANE[name]
    const saved = parseInt(localStorage.getItem(p.key) || '', 10)
    if (!Number.isNaN(saved)) applyPaneWidth(name, clampPane(saved, p.min, p.max))
  }
}

function beginPaneResize(e: PointerEvent) {
  if (window.innerWidth <= MOBILE_BP) return   // panes overlay on mobile; no resize
  const handle = e.currentTarget as HTMLElement
  const name = handle.dataset.resize as PaneName
  const p = PANE[name]
  e.preventDefault()
  const startX = e.clientX
  const startW = p.el.getBoundingClientRect().width
  handle.classList.add('dragging')
  document.body.classList.add('resizing-pane')
  handle.setPointerCapture(e.pointerId)

  const onMove = (ev: PointerEvent) => {
    // Sidebar sits left of its handle (drag right = wider); editor sits right
    // of its handle (drag left = wider).
    const delta = name === 'sidebar' ? ev.clientX - startX : startX - ev.clientX
    applyPaneWidth(name, clampPane(startW + delta, p.min, p.max))
  }
  const onUp = () => {
    handle.releasePointerCapture(e.pointerId)
    handle.removeEventListener('pointermove', onMove)
    handle.removeEventListener('pointerup', onUp)
    handle.classList.remove('dragging')
    document.body.classList.remove('resizing-pane')
    localStorage.setItem(p.key, String(Math.round(p.el.getBoundingClientRect().width)))
  }
  handle.addEventListener('pointermove', onMove)
  handle.addEventListener('pointerup', onUp)
}

for (const handle of document.querySelectorAll<HTMLElement>('.pane-resizer')) {
  handle.addEventListener('pointerdown', beginPaneResize)
  handle.addEventListener('dblclick', () => {
    const name = handle.dataset.resize as PaneName
    applyPaneWidth(name, PANE[name].def)
    localStorage.removeItem(PANE[name].key)
  })
}
restorePaneWidths()

// Sidebar tabs
document.querySelector('.sidebar-tabs')!.addEventListener('click', async (e) => {
  const btn = (e.target as HTMLElement).closest<HTMLButtonElement>('.stab')
  if (!btn?.dataset.mode) return
  const mode = btn.dataset.mode as 'tags' | 'files' | 'quality'
  if (mode === state.sidebarMode) return
  state.sidebarMode = mode
  if (mode === 'tags') {
    state.selectedDirectory = null
    if (!state.artists.length) await loadLibrary()
  } else if (mode === 'files') {
    state.selectedArtist = null
    state.selectedAlbum  = null
    state.selectedTag    = null
    if (!state.rootNode) await loadTree()
  } else {
    state.selectedIssue = null
    qualityToolbar.hidden = true
    renderSidebarTabs()
    await renderQualityPanel()
    state.selectedIds.clear()
    state.tracks = []; state.total = 0
    renderTracks()
    renderEditor()
    return
  }
  state.selectedIds.clear()
  state.page = 0
  renderSidebarTabs()
  await loadTracks()
  renderEditor()
})

// Tags panel: tag headers open/close; values and albums filter the tracks.
async function selectInTags(apply: () => void) {
  state.selectedArtist = null
  state.selectedAlbum  = null
  state.selectedTag    = null
  apply()
  state.selectedIds.clear()
  state.page = 0
  renderTagsPanel()
  await loadTracks()
  renderEditor()
}

artistListEl.addEventListener('click', async (e) => {
  const target = e.target as HTMLElement
  const li = target.closest<HTMLElement>('.nav-item')
  if (!li) return
  const onArrow = target.dataset.toggle === '1'

  if (li.dataset.all === '1') {
    await selectInTags(() => {})
    return
  }

  // Album under an artist
  if (li.dataset.album !== undefined) {
    await selectInTags(() => {
      state.selectedArtist = li.dataset.artist ?? ''
      state.selectedAlbum  = li.dataset.album ?? ''
    })
    return
  }

  const field = li.dataset.tag!
  // Tag header: open/close, loading its values the first time
  if (li.dataset.value === undefined) {
    if (state.expandedTags.has(field)) {
      state.expandedTags.delete(field)
    } else {
      state.expandedTags.add(field)
      if (!state.tagValues.has(field)) await loadTagValues(field)
    }
    renderTagsPanel()
    return
  }

  const value = li.dataset.value
  if (field === 'artist') {
    const toggle = () => state.expandedArtists.has(value)
      ? state.expandedArtists.delete(value) : state.expandedArtists.add(value)
    if (onArrow) { toggle(); renderTagsPanel(); return }
    await selectInTags(() => { state.selectedArtist = value })
    return
  }
  await selectInTags(() => { state.selectedTag = { field, value } })
})

// Tags panel: expand/collapse all
document.getElementById('expand-all-btn')!.addEventListener('click', async () => {
  for (const t of BROWSE_TAGS) state.expandedTags.add(t.field)
  await Promise.all(BROWSE_TAGS.filter(t => !state.tagValues.has(t.field)).map(t => loadTagValues(t.field)))
  renderTagsPanel()
})

document.getElementById('collapse-all-btn')!.addEventListener('click', () => {
  state.expandedTags.clear()
  state.expandedArtists.clear()
  renderTagsPanel()
})

// Files panel: directory tree clicks
dirTreeEl.addEventListener('click', async (e) => {
  const target = e.target as HTMLElement
  const row = target.closest<HTMLElement>('.tree-row')
  if (!row) return
  const path = row.dataset.path ?? null

  if (target.dataset.toggle === '1') {
    const node = findDirNode(path)
    if (node) { await expandDirNode(node); return }
  }

  state.selectedDirectory = path === '' ? null : path
  state.selectedIds.clear()
  state.page = 0
  renderFilesPanel()
  await loadTracks()
  renderEditor()
})

function findDirNode(path: string | null): DirNode | null {
  if (!state.rootNode || path === null) return null
  function search(node: DirNode): DirNode | null {
    if (node.path === path) return node
    if (node.children) for (const c of node.children) { const r = search(c); if (r) return r }
    return null
  }
  return search(state.rootNode)
}

// Tag-link navigation
async function navigateTo(artist: string, album?: string) {
  state.sidebarMode     = 'tags'
  state.selectedArtist  = artist || null
  state.selectedAlbum   = album  || null
  state.selectedTag     = null
  state.expandedTags.add('artist')
  if (!state.tagValues.has('artist')) await loadTagValues('artist')
  state.selectedIds.clear()
  state.page = 0
  if (artist) state.expandedArtists.add(artist)
  renderSidebarTabs()
  renderTagsPanel()
  await loadTracks()
  renderEditor()
}

// Track table clicks
trackTbody.addEventListener('click', (e) => {
  const tr = (e.target as HTMLElement).closest<HTMLTableRowElement>('tr')
  if (!tr) return
  const id = parseInt(tr.dataset.id!, 10)
  const isCheckbox = (e.target as HTMLElement).matches('input[type=checkbox]')
  const cb = tr.querySelector<HTMLInputElement>('input[type=checkbox]')
  const readOnly = new Set(state.tracks.filter(t => t.read_only).map(t => t.id))

  if (readOnly.has(id) && !isCheckbox) {
    // View only, and only on its own.
    const only = state.selectedIds.size === 1 && state.selectedIds.has(id)
    state.selectedIds.clear()
    if (!only) state.selectedIds.add(id)
  } else if (e.shiftKey && state.selectedIds.size > 0) {
    const rows  = [...trackTbody.querySelectorAll<HTMLTableRowElement>('tr')]
    const ids   = rows.map(r => parseInt(r.dataset.id!, 10))
    const idArr = [...state.selectedIds]
    const last  = idArr[idArr.length - 1]
    const from = ids.indexOf(last), to = ids.indexOf(id)
    const [lo, hi] = from < to ? [from, to] : [to, from]
    ids.slice(lo, hi + 1).forEach(i => { if (!readOnly.has(i)) state.selectedIds.add(i) })
    for (const i of readOnly) state.selectedIds.delete(i)
  } else if (isCheckbox && cb) {
    for (const i of readOnly) state.selectedIds.delete(i)
    cb.checked ? state.selectedIds.add(id) : state.selectedIds.delete(id)
  } else {
    if (state.selectedIds.has(id) && state.selectedIds.size === 1) {
      state.selectedIds.clear()
    } else {
      state.selectedIds.clear()
      state.selectedIds.add(id)
    }
  }
  renderTracks()
  renderEditor()
})

// MusicBrainz lookup
lookupBtn.addEventListener('click', runLookup)
spectroBtn.addEventListener('click', toggleSpectro)
spectroPopout.addEventListener('click', openSpectroLightbox)
spectroImg.addEventListener('click', openSpectroLightbox)
document.getElementById('lookup-close')!.addEventListener('click', () => { lookupPanel.hidden = true })

// View toggle
viewListBtn.addEventListener('click', () => {
  if (state.viewMode === 'list') return
  state.viewMode = 'list'
  renderViewMode()
})

viewAlbumsBtn.addEventListener('click', () => {
  if (state.viewMode === 'albums') return
  state.viewMode = 'albums'
  renderViewMode()
})

// Cover art upload
coverInput.addEventListener('change', async () => {
  const file = coverInput.files?.[0]
  if (!file) return
  const ids = [...state.selectedIds]
  if (!ids.length) return
  try {
    await Promise.all(ids.map(id => api.covers.update(id, file)))
    state.coverBust++
    updateCoverPreview()
    if (state.viewMode === 'albums') renderAlbumView()
    toast(`Cover art updated`, 'success')
  } catch (err) {
    toast(`Failed to update cover: ${err}`, 'error')
  }
  coverInput.value = ''
})

// Column picker
colPickerBtn.addEventListener('click', (e) => {
  e.stopPropagation()
  state.colPickerOpen = !state.colPickerOpen
  colPickerEl.hidden  = !state.colPickerOpen
  if (state.colPickerOpen) renderColPicker()
})

colPickerEl.addEventListener('change', (e) => {
  const cb = e.target as HTMLInputElement
  if (!cb.dataset.col) return
  if (cb.checked) state.visibleCols.add(cb.dataset.col)
  else            state.visibleCols.delete(cb.dataset.col)
  saveColPrefs(state.visibleCols)
  renderColHeaders()
  renderTracks()
})

document.addEventListener('click', (e) => {
  if (state.colPickerOpen && !colPickerEl.contains(e.target as Node) && e.target !== colPickerBtn) {
    state.colPickerOpen = false
    colPickerEl.hidden  = true
  }
})

document.getElementById('clear-selection')!.addEventListener('click', () => {
  state.selectedIds.clear(); renderTracks(); renderEditor()
})

normalizeCaseBtn.addEventListener('click', normalizeCaseBulk)
removeTracksBtn.addEventListener('click', removeFromLibrary)
deleteFilesBtn.addEventListener('click', deleteFiles)
autonumberBtn.addEventListener('click', autoNumber)
findReplaceBtn.addEventListener('click', showFindReplace)
document.getElementById('cleanup-btn')!.addEventListener('click', () =>
  openCleanup([...state.selectedIds], async () => { state.tagValues = new Map(); await refreshAfterBulk() }))
replaygainBtn.addEventListener('click', scanReplayGain)
inferBtn.addEventListener('click', inferFromFilename)
exportM3uBtn.addEventListener('click', exportM3u)
undoBtn.addEventListener('click', undoLast)
reviewBtn.addEventListener('click', () => openReview(refreshAfterWrite))
document.getElementById('history-btn')!.addEventListener('click', () => openHistory(refreshAfterWrite))

// Filter selects
filterQualityEl.addEventListener('change', () => { state.filterQuality = filterQualityEl.value; state.page = 0; loadTracks() })
filterFormatEl.addEventListener('change',  () => { state.filterFormat  = filterFormatEl.value;  state.page = 0; loadTracks() })


// Keyboard shortcuts
document.addEventListener('keydown', (e) => {
  const target = e.target as HTMLElement
  if (target.matches('input, textarea, select') || target.isContentEditable) return

  if (e.key === 'Escape') {
    if (!tagEditor.hidden) {
      state.selectedIds.clear()
      renderTracks()
      renderEditor()
    }
  } else if (e.key === 'ArrowUp') {
    if (state.selectedIds.size > 0) {
      e.preventDefault()
      navigateTrack(-1)
    }
  } else if (e.key === 'ArrowDown') {
    if (state.selectedIds.size > 0) {
      e.preventDefault()
      navigateTrack(1)
    }
  } else if ((e.ctrlKey || e.metaKey) && e.key === 's') {
    if (!tagEditor.hidden) {
      e.preventDefault()
      tagForm.requestSubmit()
    }
  } else if (e.key === '?') {
    e.preventDefault()
    showKeyboardHelp()
  }
})

const SHORTCUTS: [string, string][] = [
  ['↑ / ↓', 'Move between tracks'],
  ['Click', 'Select a track'],
  ['Shift-click', 'Select a range'],
  ['Ctrl/⌘ + S', 'Save tags'],
  ['Esc', 'Close the editor'],
  ['?', 'Show this help'],
]

function showKeyboardHelp() {
  if (document.querySelector('.modal-overlay')) return
  const overlay = document.createElement('div')
  overlay.className = 'modal-overlay'
  const rows = SHORTCUTS.map(([k, d]) => `<tr><td class="kbd-key"><kbd>${esc(k)}</kbd></td><td>${esc(d)}</td></tr>`).join('')
  overlay.innerHTML = `
    <div class="modal-card">
      <div class="modal-title">Keyboard shortcuts</div>
      <table class="kbd-table"><tbody>${rows}</tbody></table>
      <div class="modal-actions"><button class="btn btn-primary" id="kbd-close">Close</button></div>
    </div>
  `
  document.body.appendChild(overlay)
  const close = () => overlay.remove()
  overlay.addEventListener('click', e => { if (e.target === overlay) close() })
  overlay.querySelector('#kbd-close')!.addEventListener('click', close)
}

// Quality panel: issue item clicks
qualityListEl.addEventListener('click', async (e) => {
  const li = (e.target as HTMLElement).closest<HTMLElement>('.quality-issue-item')
  if (!li?.dataset.issue) return
  const issue = li.dataset.issue
  state.selectedIssue = state.selectedIssue === issue ? null : issue
  qualityToolbar.hidden = !state.selectedIssue || state.selectedIssue === 'missing_files'
  const isDupes = state.selectedIssue === 'duplicate_tracks'
  const isLayout = state.selectedIssue === 'not_in_layout'
  dedupeBtn.hidden = !isDupes
  refileBtn.hidden = !isLayout
  fixAllBtn.hidden = isDupes || isLayout
  state.selectedIds.clear()
  state.page = 0
  await renderQualityPanel()
  await loadTracks()
  renderEditor()
})

document.getElementById('close-editor')!.addEventListener('click', () => {
  state.selectedIds.clear(); renderTracks(); renderEditor()
})

tagForm.addEventListener('submit', saveTags)
tagForm.addEventListener('input', (e) => {
  const el = e.target as HTMLElement
  delete el.dataset.mixed
  el.dataset.dirty = '1'
  updateEditorRenamePreview()
})
tagForm.addEventListener('change', (e) => { (e.target as HTMLElement).dataset.dirty = '1' })

document.getElementById('revert-btn')!.addEventListener('click', () => { fillEditorForm() })

const debouncedSearch = debounce(async () => {
  state.selectedIds.clear()
  state.page = 0
  await loadTracks()
  renderEditor()
}, 300)

searchEl.addEventListener('input', () => {
  state.query = searchEl.value.trim()
  debouncedSearch()
})

scanBtn.addEventListener('click', () => startScan())
document.addEventListener('click', async (e) => {
  const b = (e.target as HTMLElement).closest<HTMLButtonElement>('[data-scan-now]')
  if (!b) return
  b.disabled = true
  await startScan()
  if (settingsModal.classList.contains('open')) showSettingsTab('background')
  b.disabled = false
})
updateScanBtnVisibility()
rescanFolderBtn.addEventListener('click', () => {
  if (state.selectedDirectory) startScan(state.selectedDirectory)
})

// ─── Settings modal ───────────────────────────────────────────────────────────

const settingsModal     = document.getElementById('settings-sidebar')!
const acoustidKeyInput  = document.getElementById('setting-acoustid-key') as HTMLInputElement
const discogsTokenInput = document.getElementById('setting-discogs-token') as HTMLInputElement
const scanExcludeInput  = document.getElementById('setting-scan-exclude') as HTMLTextAreaElement
const autoScanInput     = document.getElementById('setting-auto-scan') as HTMLInputElement
const renameOnSaveInput = document.getElementById('setting-rename-on-save') as HTMLInputElement
const stageChangesInput = document.getElementById('setting-stage-changes') as HTMLInputElement
const libraryRootsInput = document.getElementById('setting-library-roots') as HTMLTextAreaElement
const libraryRootsDefaultEl   = document.getElementById('library-roots-default')!
const libraryRootsEffectiveEl = document.getElementById('library-roots-effective')!
const renameTemplateInput = document.getElementById('setting-rename-template') as HTMLInputElement
const renamePreviewEl   = document.getElementById('rename-preview')!
const replaygainStatusEl = document.getElementById('replaygain-status')!
const musicDirsDefaultEl  = document.getElementById('music-dirs-default')!
const musicDirsListEl     = document.getElementById('music-dirs-list')!
const musicDirInput       = document.getElementById('music-dir-input') as HTMLInputElement

let localMusicDirs: string[] = []

function renderMusicDirsList() {
  musicDirsListEl.innerHTML = ''
  for (const dir of localMusicDirs) {
    const li = document.createElement('li')
    li.className = 'music-dir-row'
    li.innerHTML = `<span class="music-dir-path">${esc(dir)}</span><button class="btn btn-ghost btn-sm btn-icon music-dir-remove" data-dir="${esc(dir)}" title="Remove">✕</button>`
    musicDirsListEl.appendChild(li)
  }
}
const acoustidStatusEl  = document.getElementById('acoustid-status')!

function getScanTagCheckboxes(): NodeListOf<HTMLInputElement> {
  return document.querySelectorAll<HTMLInputElement>('#scan-tags-list input[data-tag]')
}

const librariesListEl = document.getElementById('libraries-list') as HTMLUListElement

async function renderLibraries() {
  try {
    const libs = await api.settings.libraries()
    librariesListEl.innerHTML = libs.length ? libs.map(l => `
      <li class="library-row${l.active ? '' : ' library-off'}">
        <label class="settings-toggle"><input type="checkbox" data-path="${esc(l.path)}" ${l.active ? 'checked' : ''} />
          <span>${l.writable ? '' : '🔒 '}${esc(l.name)}</span></label>
        <span class="library-meta" title="${esc(l.path)}">${l.active ? `${l.tracks.toLocaleString()} tracks` : 'off'}</span>
        <div class="library-layout" data-path="${esc(l.path)}" data-override="${esc(l.template)}">
          <label class="settings-toggle"><input type="checkbox" data-layout-check ${l.layout ? 'checked' : ''} /><span>Check layout</span></label>
          ${layoutTextHtml(l.template)}
        </div>
      </li>`).join('')
      : '<li class="settings-hint">No library roots — every music directory is scanned.</li>'
  } catch (e) {
    librariesListEl.innerHTML = `<li class="settings-hint">Failed to load libraries: ${esc(String(e))}</li>`
  }
}

/** A library's layout, read-only: its own (✎ to edit) or the standard one, muted. */
function layoutTextHtml(override: string): string {
  const shown = override || renameTemplateInput.value.trim()
  return `<code class="library-layout-text${override ? '' : ' library-layout-std'}"
      title="${override ? 'This library\'s own layout' : 'The standard layout (Layout, below)'}">${esc(shown) || '—'}</code>
    <button type="button" class="btn btn-ghost btn-sm library-layout-edit" title="Give this library its own layout">✎</button>`
}

// ✎ swaps the text for an input in place; "Standard" drops the override.
librariesListEl.addEventListener('click', (e) => {
  const t = e.target as HTMLElement
  const box = t.closest<HTMLElement>('.library-layout')
  if (!box) return
  if (t.closest('.library-layout-edit')) {
    const text = box.querySelector('.library-layout-text')!
    const edit = document.createElement('span')
    edit.className = 'library-layout-editing'
    edit.innerHTML = `<input type="text" spellcheck="false" data-layout-input value="${esc(box.dataset.override || renameTemplateInput.value.trim())}" />
      <button type="button" class="btn btn-ghost btn-sm library-layout-reset" title="Use the standard layout">Standard</button>`
    text.replaceWith(edit)
    box.querySelector('.library-layout-edit')!.remove()
    edit.querySelector('input')!.focus()
  } else if (t.closest('.library-layout-reset')) {
    box.dataset.override = ''
    box.querySelector('.library-layout-editing')!.outerHTML = layoutTextHtml('')
  }
})

librariesListEl.addEventListener('change', async (e) => {
  const cb = e.target as HTMLInputElement
  if (!cb.dataset.path) return
  cb.disabled = true
  try {
    const r = await api.settings.setLibrary(cb.dataset.path, cb.checked)
    if (r.active) {
      toast(r.job_id ? 'Library on — scanning it now' : 'Library on — it will be included in the next scan', 'success')
      if (r.job_id) pollScan(r.job_id)
    } else {
      toast(`Library off — ${(r.removed ?? 0).toLocaleString()} tracks removed from Tagger (files untouched)`, 'success')
      state.tagValues = new Map()
      await refreshAfterBulk()
    }
  } catch (err) {
    toast(`Failed: ${err}`, 'error'); cb.checked = !cb.checked
  } finally {
    await renderLibraries()
  }
})

async function openSettings() {
  try {
    const [s, status, rgStatus] = await Promise.all([
      api.settings.get(), api.lookup.status(), api.tags.replaygainStatus(),
    ])
    acoustidKeyInput.value    = s.acoustid_api_key
    discogsTokenInput.value   = s.discogs_token ?? ''
    scanExcludeInput.value    = (s.scan_exclude ?? []).join('\n')
    autoScanInput.value       = String(s.auto_scan_minutes ?? 0)
    renameOnSaveInput.checked = s.rename_on_save
    stageChangesInput.checked = s.stage_changes ?? true
    libraryRootsInput.value   = (s.library_roots ?? []).join('\n')
    libraryRootsDefaultEl.textContent = s.env_library_roots?.length
      ? `TAGGER_LIBRARY_ROOTS (${s.env_library_roots.join(', ')})`
      : 'the music directories'
    libraryRootsEffectiveEl.textContent = s.effective_library_roots?.length
      ? `Now: ${s.effective_library_roots.join(' · ')}`
      : 'No root folder exists yet — organizing is refused.'

    renameTemplateInput.value = s.rename_template
    updateRenamePreview()
    getScanTagCheckboxes().forEach(cb => {
      cb.checked = s.scan_tags.includes(cb.dataset.tag!)
    })
    renderLibraries()
    musicDirsDefaultEl.textContent = s.default_music_dir ?? ''
    localMusicDirs = [...(s.music_dirs ?? [])]
    renderMusicDirsList()
    renderAcoustidStatus(status)
    replaygainStatusEl.innerHTML = rgStatus.available
      ? `<span class="status-ok">✓ ReplayGain available via ${rgStatus.tool}</span>`
      : '<span class="status-warn">⚠ No ReplayGain tool found — install rsgain or loudgain on the server</span>'
  } catch (e) {
    toast(`Failed to load settings: ${e}`, 'error')
  }
  logoutBtn.hidden = !authRequired
  refreshTrashStatus()
  settingsModal.classList.add('open')
  showSettingsTab('settings')
}

const trashStatusEl = document.getElementById('trash-status')!
const emptyTrashBtn = document.getElementById('empty-trash-btn') as HTMLButtonElement

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`
  const units = ['KB', 'MB', 'GB']
  let v = n / 1024, i = 0
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++ }
  return `${v.toFixed(1)} ${units[i]}`
}

async function refreshTrashStatus() {
  try {
    const { count, bytes } = await api.library.trashInfo()
    trashStatusEl.textContent = count
      ? `${count} file${count !== 1 ? 's' : ''} in trash · ${fmtBytes(bytes)}`
      : 'Trash is empty'
    emptyTrashBtn.disabled = count === 0
  } catch {
    trashStatusEl.textContent = ''
  }
}

emptyTrashBtn.addEventListener('click', async () => {
  if (!confirm('Permanently delete all files in the trash? This cannot be undone.')) return
  emptyTrashBtn.disabled = true
  try {
    const { removed, bytes } = await api.library.emptyTrash()
    toast(`Emptied trash — removed ${removed} file${removed !== 1 ? 's' : ''} (${fmtBytes(bytes)})`, 'success')
    await refreshTrashStatus()
  } catch (e) {
    toast(`Failed to empty trash: ${e}`, 'error')
  }
})

const updateRenamePreview = debounce(async () => {
  const tpl = renameTemplateInput.value.trim()
  if (!tpl) { renamePreviewEl.textContent = ''; return }
  try {
    const res = await api.settings.renamePreview(tpl)
    if (res.ok) {
      renamePreviewEl.textContent = 'Preview: ' + res.preview
      renamePreviewEl.classList.remove('rename-preview-error')
    } else {
      renamePreviewEl.textContent = res.error ?? 'Invalid template'
      renamePreviewEl.classList.add('rename-preview-error')
    }
  } catch {
    renamePreviewEl.textContent = ''
  }
}, 250)

function renderAcoustidStatus(status: { acoustid_configured: boolean; fpcalc_available: boolean; method: string }) {
  if (!status.acoustid_configured) {
    acoustidStatusEl.innerHTML = ''
    return
  }
  if (status.fpcalc_available) {
    acoustidStatusEl.innerHTML = '<span class="status-ok">✓ AcoustID active — fingerprint lookup enabled</span>'
  } else {
    acoustidStatusEl.innerHTML = '<span class="status-warn">⚠ API key set but fpcalc not found — install libchromaprint-tools</span>'
  }
}

function closeSettings() {
  settingsModal.classList.remove('open')
  if (bgTimer) { clearInterval(bgTimer); bgTimer = null }
}

const paneBackground = document.getElementById('pane-background')!
const paneAbout = document.getElementById('pane-about')!
let bgTimer: ReturnType<typeof setInterval> | null = null

async function refreshBackground() {
  const active = await renderBackground(paneBackground)
  if (active) {
    state.scanJob = active
    renderScanStatus()
    if (!state.scanPollTimer) pollScan(active.id)   // a scan started elsewhere (auto, another tab)
  }
}

function showSettingsTab(tab: string) {
  settingsModal.querySelectorAll<HTMLElement>('.settings-tab').forEach(b => b.classList.toggle('active', b.dataset.tab === tab))
  settingsModal.querySelectorAll<HTMLElement>('.settings-pane').forEach(p => { p.hidden = p.id !== `pane-${tab}` })
  document.getElementById('settings-footer')!.hidden = tab !== 'settings'
  if (bgTimer) { clearInterval(bgTimer); bgTimer = null }
  if (tab === 'background') { refreshBackground(); bgTimer = setInterval(refreshBackground, 1500) }
  if (tab === 'about') renderAbout(paneAbout)
}

settingsModal.querySelector('.settings-tabs')!.addEventListener('click', (e) => {
  const t = (e.target as HTMLElement).closest<HTMLElement>('.settings-tab')
  if (t) showSettingsTab(t.dataset.tab!)
})
wireBackground(paneBackground, refreshBackground)
scanStatusEl.addEventListener('click', async () => {
  if (!settingsModal.classList.contains('open')) await openSettings()
  showSettingsTab('background')
})
// A scan already running when the page loads (auto-scan, another tab).
api.jobs.list().then(jobs => {
  const active = jobs.find(j => j.status === 'running' || j.status === 'pending')
  if (active) { state.scanJob = active; renderScanStatus(); pollScan(active.id) }
}).catch(() => { /* not signed in yet */ })

document.getElementById('settings-btn')!.addEventListener('click', () => {
  settingsModal.classList.contains('open') ? closeSettings() : openSettings()
})
document.getElementById('settings-modal-close')!.addEventListener('click', closeSettings)

const logoutBtn = document.getElementById('settings-logout') as HTMLButtonElement
logoutBtn.addEventListener('click', async () => {
  try {
    await api.auth.logout()
    showLogin()
    closeSettings()
  } catch (e) {
    toast(`Logout failed: ${e}`, 'error')
  }
})

renameTemplateInput.addEventListener('input', () => {
  updateRenamePreview()
  // libraries following the standard layout show it as you type
  librariesListEl.querySelectorAll('.library-layout-std').forEach(c => { c.textContent = renameTemplateInput.value.trim() || '—' })
})

document.getElementById('music-dir-add-btn')!.addEventListener('click', () => {
  const val = musicDirInput.value.trim()
  if (!val) return
  if (!localMusicDirs.includes(val)) {
    localMusicDirs.push(val)
    renderMusicDirsList()
  }
  musicDirInput.value = ''
})

musicDirInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') document.getElementById('music-dir-add-btn')!.click()
})

musicDirsListEl.addEventListener('click', (e) => {
  const btn = (e.target as HTMLElement).closest<HTMLButtonElement>('.music-dir-remove')
  if (!btn) return
  const dir = btn.dataset.dir!
  localMusicDirs = localMusicDirs.filter(d => d !== dir)
  renderMusicDirsList()
})

document.getElementById('settings-save')!.addEventListener('click', async () => {
  const scanTags: string[] = []
  getScanTagCheckboxes().forEach(cb => { if (cb.checked) scanTags.push(cb.dataset.tag!) })
  const update: Partial<AppSettings> = {
    acoustid_api_key:  acoustidKeyInput.value.trim(),
    discogs_token:     discogsTokenInput.value.trim(),
    rename_on_save:    renameOnSaveInput.checked,
    stage_changes:     stageChangesInput.checked,
    library_roots:     libraryRootsInput.value.split('\n').map(x => x.trim()).filter(Boolean),
    rename_template:   renameTemplateInput.value.trim(),
    scan_tags:         scanTags,
    music_dirs:        localMusicDirs,
    scan_exclude:      scanExcludeInput.value.split('\n').map(x => x.trim()).filter(Boolean),
    auto_scan_minutes: Math.max(0, parseInt(autoScanInput.value, 10) || 0),
  }
  // Layouts: only when the library list loaded (else leave them as they are).
  // An override equal to the standard layout isn't one -- it follows the standard.
  const layoutBoxes = [...librariesListEl.querySelectorAll<HTMLElement>('.library-layout')]
  if (layoutBoxes.length) {
    const std = renameTemplateInput.value.trim()
    update.layout_libraries = layoutBoxes
      .filter(b => b.querySelector<HTMLInputElement>('[data-layout-check]')!.checked).map(b => b.dataset.path!)
    update.library_templates = Object.fromEntries(layoutBoxes.map(b => {
      const v = (b.querySelector<HTMLInputElement>('[data-layout-input]')?.value ?? b.dataset.override ?? '').trim()
      return [b.dataset.path!, v === std ? '' : v]
    }).filter(([, v]) => v))
  }
  try {
    const saved = await api.settings.update(update)
    state.musicDirs = [saved.default_music_dir ?? '', ...(saved.music_dirs ?? [])].filter(Boolean)
    state.libraryRoots = saved.effective_library_roots ?? state.libraryRoots
    renameOnSave = saved.rename_on_save
    renameTemplate = saved.rename_template
    stageChanges = saved.stage_changes ?? true
    state.qualityIssues = null   // layouts may have changed what is "Not in layout"
    if (state.sidebarMode === 'quality') renderQualityPanel()
    // Refresh lookup status after saving
    const status = await api.lookup.status()
    lookupBtn.title = status.method === 'acoustid'
      ? 'Identify via AcoustID fingerprint'
      : 'Search MusicBrainz by title/artist/album'
    toast('Settings saved', 'success')
    closeSettings()
  } catch (e) {
    toast(`Failed to save settings: ${errText(e)}`, 'error')
  }
})

// ─── Authentication gate ────────────────────────────────────────────────────────

let authRequired = false
let loginOverlay: HTMLElement | null = null

function showLogin() {
  if (loginOverlay) { loginOverlay.hidden = false; return }
  const overlay = document.createElement('div')
  overlay.className = 'login-overlay'
  overlay.innerHTML = `
    <form class="login-card" id="login-form">
      <div class="login-title">Tagger</div>
      <p class="login-hint">This library is password-protected.</p>
      <input id="login-password" type="password" placeholder="Password" autocomplete="current-password" autofocus />
      <div id="login-error" class="login-error"></div>
      <button type="submit" class="btn btn-primary">Log in</button>
    </form>
  `
  document.body.appendChild(overlay)
  loginOverlay = overlay
  const form = overlay.querySelector<HTMLFormElement>('#login-form')!
  const pw = overlay.querySelector<HTMLInputElement>('#login-password')!
  const err = overlay.querySelector<HTMLElement>('#login-error')!
  form.addEventListener('submit', async (e) => {
    e.preventDefault()
    err.textContent = ''
    try {
      await api.auth.login(pw.value)
      overlay.hidden = true
      pw.value = ''
      await startApp()
    } catch {
      err.textContent = 'Incorrect password'
      pw.select()
    }
  })
  pw.focus()
}

// ─── Init ─────────────────────────────────────────────────────────────────────

async function init() {
  renderColHeaders()
  renderViewMode()
  setUnauthorizedHandler(showLogin)
  try {
    const st = await api.auth.status()
    authRequired = st.required
    if (st.required && !st.authed) { showLogin(); return }
  } catch { /* status unreachable — fall through and let calls surface errors */ }
  await startApp()
}

async function startApp() {
  api.lookup.status().then(s => {
    lookupBtn.title = s.method === 'acoustid'
      ? 'Identify via AcoustID fingerprint'
      : 'Search MusicBrainz by title/artist/album'
    if (s.acoustid_configured && !s.fpcalc_available) {
      lookupBtn.title += ' (AcoustID key set but fpcalc not found — install libchromaprint-tools)'
    }
  }).catch(() => {})
  renderFormatOptions()
  api.settings.get().then(s => {
    state.libraryRoots = s.effective_library_roots ?? []
    state.musicDirs = [s.default_music_dir ?? '', ...s.music_dirs].filter(Boolean)
    renameOnSave = s.rename_on_save
    renameTemplate = s.rename_template
    stageChanges = s.stage_changes ?? true
  }).catch(() => {})
  api.tags.replaygainStatus().then(s => {
    replaygainAvailable = s.available
    updateBulkBar()
  }).catch(() => {})
  api.spectrogram.status().then(s => { spectrogramAvailable = s.available }).catch(() => {})
  await refreshUndoButton()
  await loadLibrary()
  await loadTracks()
}

init()
