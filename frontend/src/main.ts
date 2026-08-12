import './style.css'
import { api, Track, Artist, Album, LookupResult, AppSettings, setUnauthorizedHandler } from './api'
import { toast } from './toast'
import { esc, fmtDuration, debounce } from './util'
import { state, PAGE_SIZE, TAG_FIELDS, DirNode, saveColPrefs } from './state'
import { COL_DEFS } from './columns'
import {
  trackQuality, QUALITY_TITLES, QUALITY_ISSUES,
  toTitleCase, needsNormalization, NORMALIZE_FIELDS,
} from './quality'
import { APP_HTML } from './template'

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

// Rename settings mirrored client-side for the editor's live save-path preview.
let renameOnSave = false
let renameTemplate = ''
const lookupBtn        = document.getElementById('lookup-btn') as HTMLButtonElement
const lookupPanel      = document.getElementById('lookup-panel')!
const lookupResults    = document.getElementById('lookup-results')!
const qualityListEl    = document.getElementById('quality-list')!
const normalizeCaseBtn  = document.getElementById('normalize-case-btn') as HTMLButtonElement
const autonumberBtn     = document.getElementById('autonumber-btn') as HTMLButtonElement
const findReplaceBtn    = document.getElementById('find-replace-btn') as HTMLButtonElement
const removeTracksBtn   = document.getElementById('remove-tracks-btn') as HTMLButtonElement
const deleteFilesBtn    = document.getElementById('delete-files-btn') as HTMLButtonElement
const organizeBtn       = document.getElementById('organize-btn') as HTMLButtonElement
const replaygainBtn     = document.getElementById('replaygain-btn') as HTMLButtonElement
const filterQualityEl  = document.getElementById('filter-quality') as HTMLSelectElement
const filterFormatEl   = document.getElementById('filter-format') as HTMLSelectElement
const inferBtn         = document.getElementById('infer-btn') as HTMLButtonElement
const exportM3uBtn     = document.getElementById('export-m3u-btn') as HTMLButtonElement
const undoBtn          = document.getElementById('undo-btn') as HTMLButtonElement

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

function renderTagsPanel() {
  artistListEl.innerHTML = ''

  // All tracks
  const allLi = document.createElement('li')
  allLi.className = 'nav-item nav-all' + (!state.selectedArtist && state.selectedArtist !== '' ? ' active' : '')
  allLi.dataset.all = '1'
  allLi.innerHTML = `<span class="nav-icon">♪</span><span class="nav-label">All tracks</span>`
  artistListEl.appendChild(allLi)

  for (const a of state.artists) {
    const artistKey = a.artist
    const isSelected = state.selectedArtist === artistKey
    const isExpanded = state.expandedArtists.has(artistKey)
    const artistAlbums = state.albumsByArtist.get(artistKey) ?? []

    const artistLi = document.createElement('li')
    artistLi.className = 'nav-item nav-artist' + (isSelected && !state.selectedAlbum ? ' active' : '')
    artistLi.dataset.artist = artistKey
    artistLi.innerHTML = `
      <span class="nav-arrow" data-toggle="1">${isExpanded ? '▾' : '▸'}</span>
      <span class="nav-label">${esc(a.artist || '(Unknown Artist)')}</span>
      <span class="nav-count">${a.track_count}</span>
    `
    artistListEl.appendChild(artistLi)

    if (isExpanded) {
      for (const alb of artistAlbums) {
        const albLi = document.createElement('li')
        albLi.className = 'nav-item nav-album' + (isSelected && state.selectedAlbum === alb.album ? ' active' : '')
        albLi.dataset.artist = artistKey
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
  row.style.paddingLeft = `${12 + depth * 14}px`

  const arrow = document.createElement('span')
  arrow.className = 'tree-arrow'
  if (node.loading) {
    arrow.textContent = '…'
    arrow.className += ' tree-arrow-loading'
  } else if (node.children === null || node.children.length > 0) {
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

function renderAlbumGrid() {
  albumGridEl.innerHTML = ''
  const albums = getVisibleAlbums()

  if (!albums.length) {
    albumGridEl.innerHTML = '<div class="album-empty">No albums found.</div>'
    return
  }

  for (const alb of albums) {
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
    albumGridEl.appendChild(card)
  }
}

function renderViewMode() {
  tableWrapEl.style.display  = state.viewMode === 'list'   ? ''     : 'none'
  albumGridEl.style.display  = state.viewMode === 'albums' ? 'grid' : 'none'
  viewListBtn.classList.toggle('active',   state.viewMode === 'list')
  viewAlbumsBtn.classList.toggle('active', state.viewMode === 'albums')
  if (state.viewMode === 'albums') renderAlbumGrid()
}

// ─── Column picker ────────────────────────────────────────────────────────────

function renderColPicker() {
  colPickerEl.innerHTML = ''
  for (const col of COL_DEFS) {
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

function getSortedFilteredTracks(): Track[] {
  let result = [...state.tracks]

  if (state.filterFormat) {
    result = result.filter(t => t.format === state.filterFormat)
  }
  if (state.filterQuality) {
    result = result.filter(t => trackQuality(t) === state.filterQuality)
  }

  if (state.sortKey) {
    const key = state.sortKey
    const dir = state.sortDir === 'asc' ? 1 : -1
    result.sort((a, b) => {
      const av = (a[key as keyof Track] as string | null | undefined) ?? null
      const bv = (b[key as keyof Track] as string | null | undefined) ?? null
      if (av === null && bv === null) return 0
      if (av === null) return 1
      if (bv === null) return -1
      return String(av).localeCompare(String(bv), undefined, { numeric: true, sensitivity: 'base' }) * dir
    })
  }

  return result
}

function renderFormatOptions() {
  const formats = [...new Set(state.tracks.map(t => t.format))].sort()
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
  const qualityTh = state.visibleCols.has('quality') ? '<th class="col-quality"></th>' : ''
  trackTheadRow.innerHTML = `${qualityTh}<th class="col-check"><input type="checkbox" id="select-all" /></th>`
  for (const col of COL_DEFS) {
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
    th.addEventListener('click', () => {
      if (state.sortKey === col.key) {
        state.sortDir = state.sortDir === 'asc' ? 'desc' : 'asc'
      } else {
        state.sortKey = col.key
        state.sortDir = 'asc'
      }
      renderColHeaders()
      renderTracks()
    })
    trackTheadRow.appendChild(th)
  }
  selectAll()?.addEventListener('change', onSelectAll)
}

function renderTracks() {
  trackTbody.innerHTML = ''

  if (!state.tracks.length) {
    trackEmpty.hidden = false
    trackLoading.hidden = true
    trackCount.textContent = '0 tracks'
    updateBulkBar()
    return
  }

  trackEmpty.hidden = true
  trackLoading.hidden = true

  const displayedTracks = getSortedFilteredTracks()
  const filtersActive = !!(state.filterFormat || state.filterQuality)
  if (filtersActive) {
    trackCount.textContent = `${displayedTracks.length.toLocaleString()} of ${state.total.toLocaleString()} track${state.total !== 1 ? 's' : ''}`
  } else {
    trackCount.textContent = `${state.total.toLocaleString()} track${state.total !== 1 ? 's' : ''}`
  }

  const visibleCols = COL_DEFS.filter(c => state.visibleCols.has(c.key))

  for (const t of displayedTracks) {
    const selected = state.selectedIds.has(t.id)
    const tr = document.createElement('tr')
    tr.dataset.id = String(t.id)
    if (selected) tr.classList.add('selected')
    const q = trackQuality(t)
    const qualityCell = state.visibleCols.has('quality')
      ? `<td class="col-quality"><span class="quality-dot quality-dot-${q}" title="${QUALITY_TITLES[q]}"></span></td>`
      : ''
    let cells = `${qualityCell}<td class="col-check"><input type="checkbox"${selected ? ' checked' : ''} /></td>`
    for (const col of visibleCols) {
      if (col.key === 'quality') continue
      cells += `<td class="${col.cls}">${col.render(t)}</td>`
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
  bulkActions.hidden = n === 0
  selectionCount.textContent = `${n} selected`
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

function renderEditor() {
  if (state.selectedIds.size === 0) { tagEditor.hidden = true; lookupPanel.hidden = true; state.pendingCoverAlbumId = null; state.pendingLookupResult = null; playerEl.pause(); playerEl.hidden = true; editorRenamePreviewEl.hidden = true; return }
  tagEditor.hidden = false
  // Only show lookup/infer for single selection; hide panel when selection changes
  lookupBtn.hidden = state.selectedIds.size !== 1
  inferBtn.hidden = state.selectedIds.size !== 1
  autoFixBtn.hidden = state.selectedIds.size === 0
  if (state.selectedIds.size !== 1) lookupPanel.hidden = true
  const sel = state.tracks.filter(t => state.selectedIds.has(t.id))
  editorTitle.textContent = sel.length === 1 ? (sel[0].title || sel[0].filename) : `${sel.length} tracks`
  populateForm(sel)
  updateCoverPreview()
  updatePlayer()
  updateEditorRenamePreview()
}

const updateEditorRenamePreview = debounce(async () => {
  if (state.selectedIds.size !== 1 || !renameOnSave || !renameTemplate) {
    editorRenamePreviewEl.hidden = true
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
    const res = await api.settings.renamePreview(renameTemplate, tags, ext)
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
  }
  // compilation: boolean checkbox; indeterminate = mixed across the selection.
  const comp = tracks.map(t => t.compilation === '1')
  const compSame = comp.every(v => v === comp[0])
  const cb = compilationCheckbox()
  cb.indeterminate = !compSame
  cb.checked = compSame ? comp[0] : false
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
  for (const p of proposals) {
    try { await api.tags.update(p.track.id, p.update); saved++ } catch { /* skip */ }
  }
  toast(`Saved ${saved} track${saved !== 1 ? 's' : ''}`, 'success')
  state.qualityIssues = null
  if (state.sidebarMode === 'tags') await loadLibrary()
  await loadTracks()
  if (state.sidebarMode === 'quality') await renderQualityPanel()
  const updated = state.tracks.filter(t => state.selectedIds.has(t.id))
  if (updated.length) populateForm(updated)
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
  if (!job || job.status === 'done' || job.status === 'error') { scanStatusEl.textContent = ''; return }
  const pct = job.total ? Math.round((job.scanned / job.total) * 100) : 0
  scanStatusEl.textContent = job.status === 'running'
    ? `Scanning… ${job.scanned}/${job.total} (${pct}%)`
    : 'Starting scan…'
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
    renderTagsPanel()
  } catch (e) {
    toast(`Failed to load library: ${e}`, 'error')
  }
}

async function loadTree() {
  try {
    const result = await api.fs.tree()
    const name = result.path
      ? (result.path.split('/').filter(Boolean).pop() ?? result.path)
      : 'Music Library'
    state.rootNode = {
      name,
      path:     result.path,
      children: result.dirs.map(d => ({ name: d.name, path: d.path, children: null, loading: false, expanded: false })),
      loading:  false,
      expanded: true,
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
    node.children = result.dirs.map(d => ({ name: d.name, path: d.path, children: null, loading: false, expanded: false }))
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
    if (state.query) {
      result = await api.library.search(state.query, PAGE_SIZE, offset)
    } else if (state.sidebarMode === 'files') {
      const params: Record<string, string | number> = { limit: PAGE_SIZE, offset }
      if (state.selectedDirectory !== null) params.directory = state.selectedDirectory
      result = await api.library.tracks(params)
    } else if (state.sidebarMode === 'quality') {
      if (!state.selectedIssue) {
        state.tracks = []; state.total = 0; renderTracks(); renderPagination(); return
      }
      if (state.selectedIssue === 'missing_files') {
        result = await api.library.dead()
      } else {
        result = await api.library.tracks({ issue: state.selectedIssue, limit: PAGE_SIZE, offset })
      }
    } else {
      const params: Record<string, string | number> = { limit: PAGE_SIZE, offset }
      if (state.selectedArtist !== null) params.artist = state.selectedArtist
      if (state.selectedAlbum  !== null) params.album  = state.selectedAlbum
      result = await api.library.tracks(params)
    }
    state.tracks = result.tracks
    state.total  = result.total
    renderTracks()
    renderPagination()
    renderFormatOptions()
  } catch (e) {
    toast(`Failed to load tracks: ${e}`, 'error')
    trackLoading.hidden = true
  }
}

// ─── Scan ─────────────────────────────────────────────────────────────────────

function updateRescanBtn() {
  rescanFolderBtn.disabled = state.selectedDirectory === null || state.scanPollTimer !== null
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
      if (job.status === 'done' || job.status === 'error') {
        clearInterval(state.scanPollTimer!)
        state.scanPollTimer = null
        scanBtn.disabled = false
        updateRescanBtn()
        if (job.status === 'done') {
          toast(`Scan complete — ${job.scanned} tracks indexed`, 'success')
          state.qualityIssues = null
          await loadLibrary()
          await loadTree()
          await loadTracks()
          if (state.sidebarMode === 'quality') await renderQualityPanel()
        } else {
          toast(`Scan error: ${job.error}`, 'error')
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
  for (const field of TAG_FIELDS) {
    const el = tagForm.elements.namedItem(field) as HTMLInputElement | HTMLTextAreaElement | null
    if (!el) continue
    if ((el as HTMLElement).dataset.mixed === '1' && el.value === '') continue
    update[field] = el.value
  }
  // compilation: apply unless it's still "mixed" (indeterminate) across a multi-selection.
  const cb = compilationCheckbox()
  if (!cb.indeterminate) update.compilation = cb.checked ? '1' : ''
  // Attach MB IDs from pending lookup result
  if (state.pendingLookupResult) {
    const r = state.pendingLookupResult
    if (r.mb_track_id)        update.mb_track_id        = r.mb_track_id
    if (r.mb_artist_id)       update.mb_artist_id       = r.mb_artist_id
    if (r.mb_album_id)        update.mb_album_id        = r.mb_album_id
    if (r.mb_album_artist_id) update.mb_album_artist_id = r.mb_album_artist_id
  }

  if (Object.keys(update).length === 0) { toast('No changes to save', 'info'); return }

  const ids = [...state.selectedIds]
  try {
    if (ids.length === 1) {
      await api.tags.update(ids[0], update)
    } else {
      await api.tags.bulk(ids, update)
    }

    // Write cover art from Cover Art Archive if one was selected via lookup
    if (state.pendingCoverAlbumId) {
      const albumId = state.pendingCoverAlbumId
      try {
        await Promise.all(ids.map(id => api.lookup.applyCover(id, albumId)))
        state.pendingCoverAlbumId = null
        state.pendingLookupResult = null
        state.coverBust++
        updateCoverPreview()
        if (state.viewMode === 'albums') renderAlbumGrid()
        toast('Tags and cover art saved', 'success')
      } catch {
        toast('Tags saved — cover art write failed', 'error')
      }
    } else {
      state.pendingLookupResult = null
      toast('Tags saved', 'success')
    }

    state.qualityIssues = null
    if (state.sidebarMode === 'tags') await loadLibrary()
    await loadTracks()
    const updated = state.tracks.filter(t => state.selectedIds.has(t.id))
    if (updated.length) populateForm(updated)
    await refreshUndoButton()
  } catch (e) {
    toast(`Save failed: ${e}`, 'error')
  }
}

// ─── Normalize case ───────────────────────────────────────────────────────────

async function normalizeCaseBulk() {
  const selected = state.tracks.filter(t => state.selectedIds.has(t.id))
  if (!selected.length) return

  const tasks: Array<Promise<unknown>> = []
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
    await Promise.all(tasks)
    toast(`Normalized case on ${changeCount} track${changeCount !== 1 ? 's' : ''}`, 'success')
    state.qualityIssues = null
    if (state.sidebarMode === 'tags') await loadLibrary()
    await loadTracks()
    if (state.sidebarMode === 'quality') await renderQualityPanel()
    const updated = state.tracks.filter(t => state.selectedIds.has(t.id))
    if (updated.length) populateForm(updated)
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

// ─── Delete files / reorganize ────────────────────────────────────────────────────

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

async function organizeFiles() {
  const ids = [...state.selectedIds]
  if (!ids.length) return
  organizeBtn.disabled = true
  try {
    const { moved, errors } = await api.tags.reorganize(ids)
    if (moved === 0 && errors.length === 0) {
      toast('Files already match the template', 'info')
    } else {
      const errNote = errors.length ? `, ${errors.length} skipped` : ''
      toast(`Moved ${moved} file${moved !== 1 ? 's' : ''}${errNote}`, moved ? 'success' : 'error')
    }
    if (state.sidebarMode === 'tags') await loadLibrary()
    if (state.sidebarMode === 'files') await loadTree()
    await loadTracks()
    renderEditor()
    await refreshUndoButton()
  } catch (e) {
    toast(`Organize failed: ${e}`, 'error')
  } finally {
    organizeBtn.disabled = false
  }
}

// ─── Album flows: auto-number & find/replace ────────────────────────────────────

async function refreshAfterBulk() {
  state.qualityIssues = null
  if (state.sidebarMode === 'tags') await loadLibrary()
  await loadTracks()
  if (state.sidebarMode === 'quality') await renderQualityPanel()
  const updated = state.tracks.filter(t => state.selectedIds.has(t.id))
  if (updated.length) populateForm(updated)
  await refreshUndoButton()
}

async function autoNumber() {
  const ids = [...state.selectedIds]
  if (!ids.length) return
  autonumberBtn.disabled = true
  try {
    const { numbered } = await api.tags.autonumber(ids)
    toast(`Numbered ${numbered} track${numbered !== 1 ? 's' : ''}`, 'success')
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
      const { changed } = await api.tags.findReplace(ids, field, find, replace)
      toast(changed ? `Replaced in ${changed} track${changed !== 1 ? 's' : ''}` : 'No matches found',
            changed ? 'success' : 'info')
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
  if (state.selectedArtist !== null) params.artist = state.selectedArtist
  if (state.selectedAlbum !== null) params.album = state.selectedAlbum
  return params
}

function exportM3u() {
  if (!state.total) { toast('Nothing to export', 'info'); return }
  const url = api.library.exportM3uUrl(currentViewParams())
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

async function refreshUndoButton() {
  try {
    const history = await api.library.history(10)
    const undoable = history.find(h => !h.undone)
    undoBtn.hidden = !undoable
    undoBtn.title = undoable ? `Undo: ${undoable.summary}` : 'Nothing to undo'
    undoBtn.dataset.changeId = undoable ? String(undoable.id) : ''
  } catch {
    undoBtn.hidden = true
  }
}

async function undoLast() {
  const id = undoBtn.dataset.changeId
  if (!id) return
  undoBtn.disabled = true
  try {
    const res = await api.library.undo(Number(id))
    toast(`Undone — restored ${res.restored} track${res.restored !== 1 ? 's' : ''}`, 'success')
    state.qualityIssues = null
    if (state.sidebarMode === 'tags') await loadLibrary()
    await loadTracks()
    if (state.sidebarMode === 'quality') await renderQualityPanel()
    renderEditor()
  } catch (e) {
    toast(`Undo failed: ${e}`, 'error')
  } finally {
    undoBtn.disabled = false
    await refreshUndoButton()
  }
}

// ─── Event handlers ───────────────────────────────────────────────────────────

function onSelectAll() {
  const sa = selectAll()
  if (!sa) return
  state.tracks.forEach(t => sa.checked ? state.selectedIds.add(t.id) : state.selectedIds.delete(t.id))
  renderTracks()
  renderEditor()
}

// ─── Event wiring ─────────────────────────────────────────────────────────────

document.getElementById('sidebar-toggle')!.addEventListener('click', () => {
  appEl.classList.toggle('sidebar-collapsed')
})

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

// Tags panel: artist/album clicks
artistListEl.addEventListener('click', async (e) => {
  const li = (e.target as HTMLElement).closest<HTMLElement>('.nav-item')
  if (!li) return

  const artist = li.dataset.artist ?? null
  const album  = li.dataset.album  ?? null

  // "All tracks"
  if (li.dataset.all === '1') {
    state.selectedArtist  = null
    state.selectedAlbum   = null
    state.expandedArtists.clear()
    state.selectedIds.clear()
    state.page = 0
    renderTagsPanel()
    await loadTracks()
    renderEditor()
    return
  }

  // Album click (has both artist and album dataset attrs)
  if (album !== null) {
    state.selectedArtist = artist
    state.selectedAlbum  = album
    state.selectedIds.clear()
    state.page = 0
    renderTagsPanel()
    await loadTracks()
    renderEditor()
    return
  }

  // Artist row click — select artist and toggle expand/collapse
  if (state.expandedArtists.has(artist!)) {
    state.expandedArtists.delete(artist!)
  } else {
    state.expandedArtists.add(artist!)
  }
  state.selectedArtist = artist
  state.selectedAlbum  = null
  state.selectedIds.clear()
  state.page = 0
  renderTagsPanel()
  await loadTracks()
  renderEditor()
})

// Tags panel: expand/collapse all
document.getElementById('expand-all-btn')!.addEventListener('click', () => {
  for (const a of state.artists) state.expandedArtists.add(a.artist)
  renderTagsPanel()
})

document.getElementById('collapse-all-btn')!.addEventListener('click', () => {
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
  const cb = tr.querySelector<HTMLInputElement>('input[type=checkbox]')!

  if (e.shiftKey && state.selectedIds.size > 0) {
    const rows  = [...trackTbody.querySelectorAll<HTMLTableRowElement>('tr')]
    const ids   = rows.map(r => parseInt(r.dataset.id!, 10))
    const idArr = [...state.selectedIds]
    const last  = idArr[idArr.length - 1]
    const from = ids.indexOf(last), to = ids.indexOf(id)
    const [lo, hi] = from < to ? [from, to] : [to, from]
    ids.slice(lo, hi + 1).forEach(i => state.selectedIds.add(i))
  } else if (isCheckbox) {
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
    if (state.viewMode === 'albums') renderAlbumGrid()
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
organizeBtn.addEventListener('click', organizeFiles)
autonumberBtn.addEventListener('click', autoNumber)
findReplaceBtn.addEventListener('click', showFindReplace)
replaygainBtn.addEventListener('click', scanReplayGain)
inferBtn.addEventListener('click', inferFromFilename)
exportM3uBtn.addEventListener('click', exportM3u)
undoBtn.addEventListener('click', undoLast)

// Filter selects
filterQualityEl.addEventListener('change', () => { state.filterQuality = filterQualityEl.value; renderTracks() })
filterFormatEl.addEventListener('change',  () => { state.filterFormat  = filterFormatEl.value;  renderTracks() })


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
  }
})

// Quality panel: issue item clicks
qualityListEl.addEventListener('click', async (e) => {
  const li = (e.target as HTMLElement).closest<HTMLElement>('.quality-issue-item')
  if (!li?.dataset.issue) return
  const issue = li.dataset.issue
  state.selectedIssue = state.selectedIssue === issue ? null : issue
  qualityToolbar.hidden = !state.selectedIssue || state.selectedIssue === 'missing_files'
  const isDupes = state.selectedIssue === 'duplicate_tracks'
  dedupeBtn.hidden = !isDupes
  fixAllBtn.hidden = isDupes
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
tagForm.addEventListener('input', (e) => { delete (e.target as HTMLElement).dataset.mixed; updateEditorRenamePreview() })

document.getElementById('revert-btn')!.addEventListener('click', () => {
  populateForm(state.tracks.filter(t => state.selectedIds.has(t.id)))
})

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
const renameTemplateWrap  = document.getElementById('rename-template-wrap')!
const acoustidStatusEl  = document.getElementById('acoustid-status')!

function getScanTagCheckboxes(): NodeListOf<HTMLInputElement> {
  return document.querySelectorAll<HTMLInputElement>('#scan-tags-list input[data-tag]')
}

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
    renameTemplateInput.value = s.rename_template
    renameTemplateWrap.style.display = s.rename_on_save ? '' : 'none'
    updateRenamePreview()
    getScanTagCheckboxes().forEach(cb => {
      cb.checked = s.scan_tags.includes(cb.dataset.tag!)
    })
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
}

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

renameOnSaveInput.addEventListener('change', () => {
  renameTemplateWrap.style.display = renameOnSaveInput.checked ? '' : 'none'
})

renameTemplateInput.addEventListener('input', updateRenamePreview)

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
    rename_template:   renameTemplateInput.value.trim(),
    scan_tags:         scanTags,
    music_dirs:        localMusicDirs,
    scan_exclude:      scanExcludeInput.value.split('\n').map(x => x.trim()).filter(Boolean),
    auto_scan_minutes: Math.max(0, parseInt(autoScanInput.value, 10) || 0),
  }
  try {
    const saved = await api.settings.update(update)
    state.musicDirs = [saved.default_music_dir ?? '', ...(saved.music_dirs ?? [])].filter(Boolean)
    renameOnSave = saved.rename_on_save
    renameTemplate = saved.rename_template
    // Refresh lookup status after saving
    const status = await api.lookup.status()
    lookupBtn.title = status.method === 'acoustid'
      ? 'Identify via AcoustID fingerprint'
      : 'Search MusicBrainz by title/artist/album'
    toast('Settings saved', 'success')
    closeSettings()
  } catch (e) {
    toast(`Failed to save settings: ${e}`, 'error')
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
  api.settings.get().then(s => {
    state.musicDirs = [s.default_music_dir ?? '', ...s.music_dirs].filter(Boolean)
    renameOnSave = s.rename_on_save
    renameTemplate = s.rename_template
  }).catch(() => {})
  api.tags.replaygainStatus().then(s => {
    replaygainAvailable = s.available
    updateBulkBar()
  }).catch(() => {})
  await refreshUndoButton()
  await loadLibrary()
  await loadTracks()
}

init()
