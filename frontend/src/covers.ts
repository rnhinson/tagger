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
export function openChangeCover(ids: number[], mbAlbumId: string | null, onDone: () => Promise<void>) {
  const overlay = document.createElement('div')
  overlay.className = 'fix-confirm-overlay'
  overlay.innerHTML = `
    <div class="fix-confirm-modal cc-modal" role="dialog" aria-label="Change cover">
      <div class="fix-confirm-header">
        <span class="fix-confirm-title">Change cover · ${ids.length.toLocaleString()} track${ids.length !== 1 ? 's' : ''}</span>
        <button class="btn btn-ghost btn-icon fix-confirm-close" aria-label="Close">✕</button>
      </div>
      <div class="cc-body">
        <div class="cc-sources">
          <label class="btn btn-ghost btn-sm">From disk…<input id="cc-file" type="file" accept="image/jpeg,image/png,image/webp" hidden /></label>
          <button type="button" class="btn btn-ghost btn-sm" id="cc-caa" ${mbAlbumId ? '' : 'disabled title="The selection has no MusicBrainz release — use Match album… first"'}>Cover Art Archive</button>
          <form id="cc-url-form" class="cc-url"><input id="cc-url" type="url" placeholder="https://… image URL" autocomplete="off" />
            <button class="btn btn-ghost btn-sm" type="submit">Load</button></form>
        </div>
        <div class="cc-preview"><img id="cc-img" alt="" hidden /><span id="cc-none" class="ma-dim">Pick an image</span></div>
        <div id="cc-where" class="settings-hint"></div>
        <div id="cc-error" class="review-error" hidden></div>
      </div>
      <div class="fix-confirm-footer">
        <button class="btn btn-ghost" id="cc-cancel">Cancel</button>
        <button class="btn btn-primary" id="cc-go" disabled>Apply</button>
      </div>
    </div>`
  document.body.appendChild(overlay)
  const $ = <T extends HTMLElement>(sel: string) => overlay.querySelector<T>(sel)!
  const img = $<HTMLImageElement>('#cc-img'), none = $('#cc-none'), goBtn = $<HTMLButtonElement>('#cc-go')
  const errEl = $('#cc-error')
  let src: { file?: File; url?: string; mb_album_id?: string } | null = null
  let objectUrl: string | null = null

  const close = () => { if (objectUrl) URL.revokeObjectURL(objectUrl); overlay.remove(); document.removeEventListener('keydown', onKey) }
  const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') close() }
  document.addEventListener('keydown', onKey)
  overlay.addEventListener('click', e => { if (e.target === overlay) close() })
  $('.fix-confirm-close').addEventListener('click', close)
  $('#cc-cancel').addEventListener('click', close)

  function show(s: typeof src, preview: string) {
    src = s; errEl.hidden = true
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

  api.settings.get().then(s => {
    const where = { folder: 'the album folder (cover.jpg)', tracks: 'each track (embedded)', both: 'the album folder and each track' }[s.cover_target ?? 'folder']
    $('#cc-where').textContent = `Goes to ${where}, shrunk to the size settings (Settings → Writing → Cover Art).`
  }).catch(() => { /* hint only */ })

  goBtn.addEventListener('click', async () => {
    if (!src) return
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
