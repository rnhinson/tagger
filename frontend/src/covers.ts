// Covers…: move, copy or delete the selection's cover art between the album
// folder (cover.jpg) and the tracks, album by album. Runs a few albums per
// request so a big selection never hits the proxy's timeout. Anything removed
// goes to the trash first. Backend: /api/covers/albums (core/covers.py).
import { api, CoverAction, CoverAlbum } from './api'
import { toast } from './toast'
import { esc } from './util'
import { errText, shortPath } from './staged'

const ACTIONS: { key: CoverAction; label: string; needs: 'tracks' | 'folder' | 'either' }[] = [
  { key: 'move_to_folder', label: 'Move track art to the folder (cover.jpg)', needs: 'tracks' },
  { key: 'copy_to_folder', label: 'Copy track art to the folder (cover.jpg)', needs: 'tracks' },
  { key: 'move_to_tracks', label: 'Move the folder cover into the tracks', needs: 'folder' },
  { key: 'copy_to_tracks', label: 'Copy the folder cover into the tracks', needs: 'folder' },
  { key: 'delete_folder',  label: 'Delete the folder cover', needs: 'folder' },
  { key: 'delete_tracks',  label: 'Delete the art in the tracks', needs: 'tracks' },
  { key: 'shrink',         label: 'Shrink art larger than the size settings (folder and tracks)', needs: 'either' },
]
const BATCH = 5     // albums per request

export function openCovers(ids: number[], onDone: () => Promise<void>) {
  const overlay = document.createElement('div')
  overlay.className = 'fix-confirm-overlay'
  overlay.innerHTML = `
    <div class="fix-confirm-modal pr-modal" role="dialog" aria-label="Cover art">
      <div class="fix-confirm-header">
        <span class="fix-confirm-title">Cover art · ${ids.length.toLocaleString()} tracks</span>
        <button class="btn btn-ghost btn-icon fix-confirm-close" aria-label="Close">✕</button>
      </div>
      <div class="pr-controls">
        <label class="pr-select">Action <select id="cv-action">
          ${ACTIONS.map(a => `<option value="${a.key}">${esc(a.label)}</option>`).join('')}</select></label>
        <p class="settings-hint">Per album folder. Replaced or deleted art goes to the trash; art written is shrunk to the size settings (Settings → Writing → Cover Art).</p>
        <div id="cv-error" class="review-error" hidden></div>
      </div>
      <div class="pr-summary" id="cv-summary">Reading the selection…</div>
      <div class="fix-confirm-body pr-body"><table class="pr-table"><thead><tr><th>Album folder</th><th>Folder cover</th><th>Tracks with art</th><th></th></tr></thead>
        <tbody id="cv-rows"></tbody></table></div>
      <div class="fix-confirm-footer">
        <button class="btn btn-ghost" id="cv-cancel">Cancel</button>
        <button class="btn btn-primary" id="cv-go" disabled>Apply</button>
      </div>
    </div>`
  document.body.appendChild(overlay)

  const $ = <T extends HTMLElement>(sel: string) => overlay.querySelector<T>(sel)!
  const actionEl = $<HTMLSelectElement>('#cv-action'), rowsEl = $('#cv-rows'), sumEl = $('#cv-summary')
  const goBtn = $<HTMLButtonElement>('#cv-go'), errEl = $('#cv-error')
  let albums: CoverAlbum[] = [], running = false
  const result = new Map<string, string>()

  const close = () => { if (running) return; overlay.remove(); document.removeEventListener('keydown', onKey) }
  const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') close() }
  document.addEventListener('keydown', onKey)
  overlay.addEventListener('click', e => { if (e.target === overlay) close() })
  $('.fix-confirm-close').addEventListener('click', close)
  $('#cv-cancel').addEventListener('click', close)

  const action = () => ACTIONS.find(a => a.key === actionEl.value)!
  const applies = (a: CoverAlbum) => {
    const needs = action().needs
    return needs === 'folder' ? a.folder : needs === 'tracks' ? a.embedded > 0 : a.folder || a.embedded > 0
  }

  function render() {
    rowsEl.innerHTML = albums.map(a => `<tr${applies(a) ? '' : ' class="ma-dim"'}>
      <td title="${esc(a.directory)}">${esc(shortPath(a.directory))}</td>
      <td>${a.folder ? '✓' : '—'}</td><td>${a.embedded} of ${a.track_ids.length}</td>
      <td>${esc(result.get(a.directory) ?? (applies(a) ? '' : 'nothing to do'))}</td></tr>`).join('')
    const n = albums.filter(applies).length
    sumEl.textContent = `${n} of ${albums.length} album folder${albums.length !== 1 ? 's' : ''} affected`
    goBtn.disabled = running || !n
  }

  actionEl.addEventListener('change', () => { result.clear(); render() })

  goBtn.addEventListener('click', async () => {
    const todo = albums.filter(applies)
    running = true; goBtn.disabled = true; errEl.hidden = true
    let done = 0, failed = 0
    for (let i = 0; i < todo.length; i += BATCH) {
      const batch = todo.slice(i, i + BATCH)
      try {
        const r = await api.covers.albums(batch.flatMap(a => a.track_ids), action().key)
        for (const a of r.albums) {
          const bad = a.errors.length
          failed += bad ? 1 : 0; done += bad ? 0 : 1
          result.set(a.directory, a.note ?? (bad ? `${bad} failed: ${a.errors[0].error}` : 'done'))
        }
      } catch (e) {
        failed += batch.length
        for (const a of batch) result.set(a.directory, errText(e))
      }
      sumEl.textContent = `${Math.min(i + BATCH, todo.length)} of ${todo.length} albums…`
      render()
    }
    running = false
    render()
    goBtn.disabled = true
    toast(`Cover art: ${done} album${done !== 1 ? 's' : ''} done${failed ? `, ${failed} with errors` : ''}`, failed ? 'error' : 'success')
    await onDone()
  })

  api.covers.plan(ids)
    .then(r => { albums = r.albums; render() })
    .catch(e => { errEl.textContent = errText(e); errEl.hidden = false; sumEl.textContent = '' })
}

// Change cover: one image for the selection, from disk, the Cover Art
// Archive (the tracks' MusicBrainz release) or a URL; written where
// Settings → Cover Art says, at its sizes.
export type CoverSrc = { file?: File; url?: string; mb_album_id?: string }

/** `pick`: choose an image for the caller (bulk covers) instead of writing it. */
export function openChangeCover(ids: number[], mbAlbumId: string | null, guess: { album: string; artist: string },
                                onDone: () => Promise<void>, pick?: (src: CoverSrc, preview: string) => void) {
  const overlay = document.createElement('div')
  overlay.className = 'fix-confirm-overlay'
  overlay.innerHTML = `
    <div class="fix-confirm-modal cc-modal" role="dialog" aria-label="Change cover">
      <div class="fix-confirm-header">
        <span class="fix-confirm-title">${pick ? `Find a cover · ${esc(guess.album || 'album')}` : `Change cover · ${ids.length.toLocaleString()} track${ids.length !== 1 ? 's' : ''}`}</span>
        <button class="btn btn-ghost btn-icon fix-confirm-close" aria-label="Close">✕</button>
      </div>
      <div class="cc-body">
        <div class="cc-sources">
          <label class="btn btn-ghost btn-sm">From disk…<input id="cc-file" type="file" accept="image/jpeg,image/png,image/webp" hidden /></label>
          <button type="button" class="btn btn-ghost btn-sm" id="cc-caa" ${mbAlbumId ? '' : 'disabled title="The selection has no MusicBrainz release — search below"'}>This album's release</button>
          <form id="cc-url-form" class="cc-url"><input id="cc-url" type="url" placeholder="https://… image URL" autocomplete="off" />
            <button class="btn btn-ghost btn-sm" type="submit">Load</button></form>
        </div>
        <form id="cc-search" class="cc-search">
          <input id="cc-album" type="text" placeholder="Album, or a MusicBrainz release id / link" autocomplete="off" />
          <input id="cc-artist" type="text" placeholder="Artist" autocomplete="off" />
          <button class="btn btn-ghost btn-sm" type="submit">Search MusicBrainz</button></form>
        <div id="cc-results" class="cc-results"></div>
        <div class="cc-preview"><img id="cc-img" alt="" hidden /><span id="cc-none" class="ma-dim">Pick an image</span></div>
        <div id="cc-where" class="settings-hint"></div>
        <div id="cc-error" class="review-error" hidden></div>
      </div>
      <div class="fix-confirm-footer">
        <button class="btn btn-ghost" id="cc-cancel">Cancel</button>
        <button class="btn btn-primary" id="cc-go" disabled>${pick ? 'Use this' : 'Apply'}</button>
      </div>
    </div>`
  document.body.appendChild(overlay)
  const $ = <T extends HTMLElement>(sel: string) => overlay.querySelector<T>(sel)!
  const img = $<HTMLImageElement>('#cc-img'), none = $('#cc-none'), goBtn = $<HTMLButtonElement>('#cc-go')
  const errEl = $('#cc-error')
  let src: CoverSrc | null = null
  let previewUrl = ''
  let objectUrl: string | null = null

  // A picked file's preview lives on in the caller's list.
  const close = () => { if (objectUrl && !(pick && src?.file)) URL.revokeObjectURL(objectUrl); overlay.remove(); document.removeEventListener('keydown', onKey) }
  const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') close() }
  document.addEventListener('keydown', onKey)
  overlay.addEventListener('click', e => { if (e.target === overlay) close() })
  $('.fix-confirm-close').addEventListener('click', close)
  $('#cc-cancel').addEventListener('click', close)

  function show(s: typeof src, preview: string) {
    src = s; previewUrl = preview; errEl.hidden = true
    img.onload = () => { img.hidden = false; none.hidden = true; goBtn.disabled = false }
    img.onerror = () => { img.hidden = true; none.hidden = false; none.textContent = 'No preview (the server may still fetch it)'; goBtn.disabled = false }
    img.src = preview
  }
  $<HTMLInputElement>('#cc-file').addEventListener('change', e => {
    const f = (e.target as HTMLInputElement).files?.[0]
    if (!f) return
    if (objectUrl) URL.revokeObjectURL(objectUrl)
    objectUrl = URL.createObjectURL(f)
    show({ file: f }, objectUrl)
  })
  $('#cc-caa').addEventListener('click', () => {
    if (mbAlbumId) show({ mb_album_id: mbAlbumId }, `https://coverartarchive.org/release/${mbAlbumId}/front-500`)
  })
  $<HTMLFormElement>('#cc-url-form').addEventListener('submit', e => {
    e.preventDefault()
    const u = $<HTMLInputElement>('#cc-url').value.trim()
    if (u) show({ url: u }, u)
  })

  const albumEl = $<HTMLInputElement>('#cc-album'), artistEl = $<HTMLInputElement>('#cc-artist'), resEl = $('#cc-results')
  albumEl.value = guess.album; artistEl.value = guess.artist
  $<HTMLFormElement>('#cc-search').addEventListener('submit', async e => {
    e.preventDefault()
    resEl.textContent = 'Searching…'
    try {
      const found = await api.covers.search(albumEl.value, artistEl.value)
      if (!found.length) { resEl.textContent = 'No releases found'; return }
      resEl.innerHTML = found.map(r => `<button type="button" class="cc-hit" data-id="${esc(r.mb_album_id)}" title="${esc(`${r.album} · ${r.artist ?? ''} · ${r.date ?? ''} ${r.country ?? ''}`)}">
        <img src="https://coverartarchive.org/release/${esc(r.mb_album_id)}/front-250" alt="" loading="lazy" />
        <span>${esc(r.album)}</span><span class="ma-dim">${esc(r.artist ?? '')}${r.date ? ` · ${esc(r.date.slice(0, 4))}` : ''}${r.country ? ` · ${esc(r.country)}` : ''}</span></button>`).join('')
        + '<div id="cc-hidden" class="ma-dim cc-hidden"></div>'
      let hidden = 0
      resEl.querySelectorAll<HTMLImageElement>('.cc-hit img').forEach(i => i.addEventListener('error', () => {
        i.closest('.cc-hit')!.remove()
        hidden++
        const left = resEl.querySelectorAll('.cc-hit').length
        $('#cc-hidden').textContent = `${hidden} release${hidden !== 1 ? 's' : ''} without art hidden${left ? '' : ' — try another release or search'}`
      }))
    } catch (err) { resEl.textContent = errText(err) }
  })
  resEl.addEventListener('click', e => {
    const b = (e.target as HTMLElement).closest<HTMLElement>('.cc-hit')
    if (!b) return
    resEl.querySelectorAll('.cc-hit').forEach(x => x.classList.toggle('cc-picked', x === b))
    show({ mb_album_id: b.dataset.id! }, `https://coverartarchive.org/release/${b.dataset.id}/front-500`)
  })
  if (!mbAlbumId && (guess.album || guess.artist)) $<HTMLFormElement>('#cc-search').requestSubmit()

  api.settings.get().then(s => {
    const where = { folder: 'the album folder (cover.jpg)', tracks: 'each track (embedded)', both: 'the album folder and each track' }[s.cover_target ?? 'folder']
    $('#cc-where').textContent = `Goes to ${where}, shrunk to the size settings (Settings → Writing → Cover Art).`
  }).catch(() => { /* hint only */ })

  goBtn.addEventListener('click', async () => {
    if (!src) return
    if (pick) { pick(src, previewUrl); close(); return }
    goBtn.disabled = true
    try {
      const r = await api.covers.set(ids, src)
      const parts = [r.folders ? `${r.folders} folder${r.folders !== 1 ? 's' : ''}` : '', r.tracks ? `${r.tracks} track${r.tracks !== 1 ? 's' : ''}` : ''].filter(Boolean)
      if (r.errors.length) toast(`Cover: ${r.errors.length} failed — ${r.errors[0].error}`, 'error')
      else toast(`Cover art written to ${parts.join(' and ')}`, 'success')
      close()
      await onDone()
    } catch (e) { errEl.textContent = errText(e); errEl.hidden = false; goBtn.disabled = false }
  })
}

// Bulk covers: more than one album selected. Each album folder gets its best
// Cover Art Archive match (its own release first, then a MusicBrainz search by
// its tags or folder names, the first release that has art); approve, or
// search one by hand, then write them where Settings → Cover Art says.
const PROBES = 8          // releases tried per album before giving up
export const caa = (id: string, size = 250) => `https://coverartarchive.org/release/${id}/front-${size}`

const VARIOUS = /^various( artists)?$/i
const words = (s: string) => new Set(s.toLowerCase().normalize('NFKD').replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/).filter(Boolean))

/** Shared words over the shorter name's words (0..1). */
function overlap(a: string, b: string): number {
  const x = words(a), y = words(b)
  const [small, big] = x.size <= y.size ? [x, y] : [y, x]
  return small.size ? [...small].filter(w => big.has(w)).length / small.size : 0
}

export function hasArt(url: string): Promise<boolean> {
  return new Promise(res => {
    const i = new Image()
    const t = setTimeout(() => res(false), 15000)
    i.onload = () => { clearTimeout(t); res(true) }
    i.onerror = () => { clearTimeout(t); res(false) }
    i.src = url
  })
}

interface BulkRow {
  a: CoverAlbum
  status: 'waiting' | 'searching' | 'found' | 'none' | 'error' | 'written'
  src: CoverSrc | null
  preview: string
  label: string
  on: boolean
  note: string
}

export function openBulkCovers(albums: CoverAlbum[], onDone: () => Promise<void>) {
  const rows: BulkRow[] = albums.map(a => ({ a, status: 'waiting', src: null, preview: '', label: '', on: false, note: '' }))
  let closed = false, busy = false, wrote = false
  const overlay = document.createElement('div')
  overlay.className = 'fix-confirm-overlay'
  overlay.innerHTML = `
    <div class="fix-confirm-modal bc-modal" role="dialog" aria-label="Find covers">
      <div class="fix-confirm-header">
        <span class="fix-confirm-title">Find covers · ${albums.length} albums</span>
        <button class="btn btn-ghost btn-icon fix-confirm-close" aria-label="Close">✕</button>
      </div>
      <div class="bc-body"><table class="track-table bc-table"><thead><tr>
        <th class="bc-check"><input type="checkbox" id="bc-all" title="All found covers" /></th><th>Now</th><th>New</th><th>Album</th><th></th>
      </tr></thead><tbody></tbody></table></div>
      <div id="bc-where" class="settings-hint bc-where"></div>
      <div class="fix-confirm-footer">
        <span id="bc-sum" class="ma-dim bc-sum"></span>
        <button class="btn btn-ghost" id="bc-cancel">Cancel</button>
        <button class="btn btn-primary" id="bc-go" disabled>Apply</button>
      </div>
    </div>`
  document.body.appendChild(overlay)
  const $ = <T extends HTMLElement>(sel: string) => overlay.querySelector<T>(sel)!
  const tbody = $('tbody'), goBtn = $<HTMLButtonElement>('#bc-go'), sumEl = $('#bc-sum'), allEl = $<HTMLInputElement>('#bc-all')

  const close = async () => {
    if (busy) return
    closed = true
    for (const r of rows) if (r.src?.file) URL.revokeObjectURL(r.preview)
    overlay.remove(); document.removeEventListener('keydown', onKey)
    if (wrote) await onDone()
  }
  // Escape closes the topmost dialog only (a row's search sits above this one).
  const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && document.body.lastElementChild === overlay) close() }
  document.addEventListener('keydown', onKey)
  overlay.addEventListener('click', e => { if (e.target === overlay) close() })
  $('.fix-confirm-close').addEventListener('click', close)
  $('#bc-cancel').addEventListener('click', close)

  function renderRow(i: number) {
    const r = rows[i], a = r.a
    const tr = tbody.querySelector<HTMLElement>(`tr[data-i="${i}"]`) ?? tbody.appendChild(document.createElement('tr'))
    tr.dataset.i = String(i)
    const status = {
      waiting: '<span class="ma-dim">Waiting…</span>', searching: '<span class="ma-dim">Searching…</span>',
      none: '<span class="ma-dim">No art found</span>', error: `<span class="review-error">${esc(r.note)}</span>`,
      found: '', written: '',
    }[r.status]
    tr.innerHTML = `
      <td class="bc-check"><input type="checkbox" ${r.on ? 'checked' : ''} ${r.src && r.status !== 'written' ? '' : 'disabled'} /></td>
      <td class="bc-img"><img src="/api/covers/${a.track_ids[0]}" alt="" onerror="this.style.visibility='hidden'" /></td>
      <td class="bc-img">${r.preview ? `<img src="${esc(r.preview)}" alt="" />` : status}</td>
      <td class="bc-album"><div>${esc(a.album || '(no album)')}${a.artist ? ` <span class="ma-dim">· ${esc(a.artist)}</span>` : ''}</div>
        <div class="ma-dim bc-folder" title="${esc(a.directory)}">${esc(shortPath(a.directory))} · ${a.track_ids.length} track${a.track_ids.length !== 1 ? 's' : ''}</div>
        ${r.label ? `<div class="bc-label">${esc(r.label)}</div>` : ''}
        ${r.status === 'written' ? '<div class="bc-done">✓ Written</div>' : r.preview && r.status === 'error' ? status : ''}</td>
      <td><button type="button" class="btn btn-ghost btn-sm" data-search ${r.status === 'written' ? 'disabled' : ''}>Search…</button></td>`
  }
  function summary() {
    const n = rows.filter(r => r.on && r.src && r.status !== 'written').length
    const pending = rows.filter(r => r.status === 'waiting' || r.status === 'searching').length
    sumEl.textContent = (pending ? `Searching… ${rows.length - pending} of ${rows.length} done · ` : '') + `${n} cover${n !== 1 ? 's' : ''} to write`
    goBtn.disabled = busy || !n
    goBtn.textContent = n ? `Apply ${n}` : 'Apply'
    const can = rows.filter(r => r.src && r.status !== 'written')
    allEl.checked = can.length > 0 && can.every(r => r.on)
    allEl.indeterminate = !allEl.checked && can.some(r => r.on)
  }
  rows.forEach((_, i) => renderRow(i))
  summary()

  tbody.addEventListener('change', e => {
    const cb = e.target as HTMLInputElement
    const i = Number(cb.closest<HTMLElement>('tr')!.dataset.i)
    rows[i].on = cb.checked
    summary()
  })
  allEl.addEventListener('change', () => {
    rows.forEach((r, i) => { if (r.src && r.status !== 'written') { r.on = allEl.checked; renderRow(i) } })
    summary()
  })
  tbody.addEventListener('click', e => {
    const b = (e.target as HTMLElement).closest<HTMLElement>('[data-search]')
    if (!b) return
    const i = Number(b.closest<HTMLElement>('tr')!.dataset.i), r = rows[i]
    openChangeCover(r.a.track_ids, r.a.mb_album_id, { album: r.a.album, artist: r.a.artist }, async () => {}, (src, preview) => {
      if (r.src?.file) URL.revokeObjectURL(r.preview)
      Object.assign(r, { src, preview, on: true, status: 'found', note: '',
                         label: src.file ? `From disk: ${src.file.name}` : src.url ? `From ${src.url}` : 'Picked by hand' })
      renderRow(i); summary()
    })
  })

  // The best release with art: its own first, then the search, best score first
  // (less when the title or artist doesn't match ours); ties go to the same
  // track count, then CD.
  async function find(r: BulkRow) {
    const a = r.a, n = a.track_ids.length
    type Cand = { id: string; label: string; score: number }
    const cands: Cand[] = a.mb_album_id ? [{ id: a.mb_album_id, label: 'Its MusicBrainz release', score: 2 }] : []
    if (a.album || a.artist) {
      const found = await api.covers.search(a.album, a.artist)
      for (const c of found) {
        if (c.mb_album_id === a.mb_album_id) continue
        const score = (c.score ?? 0) + (c.tracks === n ? 0.02 : 0) + (c.formats?.includes('CD') ? 0.01 : 0)
          - (overlap(a.album, c.album) < 0.5 ? 0.3 : 0)
          - (a.artist && !VARIOUS.test(a.artist) && !overlap(a.artist, c.artist ?? '') ? 0.3 : 0)
        cands.push({ id: c.mb_album_id, score,
                     label: [c.album, c.artist, c.date?.slice(0, 4), c.country, c.tracks ? `${c.tracks} tracks` : ''].filter(Boolean).join(' · ') })
      }
    }
    cands.sort((x, y) => y.score - x.score)
    for (const c of cands.slice(0, PROBES)) {
      if (closed || r.src) return
      if (await hasArt(caa(c.id))) {
        if (r.src) return      // picked by hand meanwhile
        const weak = c.score < 0.9
        Object.assign(r, { src: { mb_album_id: c.id }, preview: caa(c.id), status: 'found', on: !weak,
                           label: c.label + (weak ? ' — weak match, check it' : '') })
        return
      }
    }
    if (!r.src) r.status = 'none'
  }

  ;(async () => {
    // Two at a time: MusicBrainz is throttled server side; the art probes overlap.
    let next = 0
    const worker = async () => {
      while (!closed && next < rows.length) {
        const i = next++, r = rows[i]
        if (r.src) continue
        r.status = 'searching'; renderRow(i); summary()
        try { await find(r) } catch (e) { if (!r.src) { r.status = 'error'; r.note = errText(e) } }
        if (closed) return
        renderRow(i); summary()
      }
    }
    await Promise.all([worker(), worker()])
  })()

  api.settings.get().then(s => {
    const where = { folder: 'each album folder (cover.jpg)', tracks: "each album's selected tracks (embedded)", both: 'each album folder and its selected tracks' }[s.cover_target ?? 'folder']
    $('#bc-where').textContent = `Goes to ${where}, shrunk to the size settings (Settings → Writing → Cover Art).`
  }).catch(() => { /* hint only */ })

  goBtn.addEventListener('click', async () => {
    busy = true; summary()
    let folders = 0, tracks = 0, failed = 0
    for (const [i, r] of rows.entries()) {
      if (!r.on || !r.src || r.status === 'written') continue
      sumEl.textContent = `Writing ${r.a.album || shortPath(r.a.directory)}…`
      try {
        const res = await api.covers.set(r.a.track_ids, r.src)
        folders += res.folders; tracks += res.tracks
        if (res.errors.length) { failed++; r.status = 'error'; r.note = res.errors[0].error }
        else { r.status = 'written'; r.on = false }
      } catch (e) { failed++; r.status = 'error'; r.note = errText(e) }
      wrote = true
      renderRow(i)
    }
    busy = false; summary()
    const parts = [folders ? `${folders} folder${folders !== 1 ? 's' : ''}` : '', tracks ? `${tracks} track${tracks !== 1 ? 's' : ''}` : ''].filter(Boolean)
    if (parts.length) toast(`Cover art written to ${parts.join(' and ')}${failed ? ` · ${failed} album${failed !== 1 ? 's' : ''} failed` : ''}`, failed ? 'error' : 'success')
    else if (failed) toast(`Covers: ${failed} album${failed !== 1 ? 's' : ''} failed`, 'error')
    if (!failed) close()
  })
}
