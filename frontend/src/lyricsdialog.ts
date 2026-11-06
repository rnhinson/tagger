// Lyrics from LRCLIB for the selection: fetch, see what was found per track
// (synced / plain / instrumental / not found / already has), preview, and
// stage the ticked ones into the lyrics tag as one step. Each track is looked
// up through its lyrics group's queries; Search… on a row picks one by hand.
// Backend: /api/lyrics.
import { api, LyricsItem } from './api'
import { toast } from './toast'
import { esc } from './util'
import { editToast, errText } from './staged'
import { openLyricsSearch } from './lyricssearch'

const STATUS: Record<string, { label: string; cls: string }> = {
  synced: { label: 'synced', cls: 'mb-good' }, plain: { label: 'plain', cls: 'mb-ok' },
  instrumental: { label: 'instrumental', cls: 'mb-none' }, missing: { label: 'not found', cls: 'mb-none' },
  has: { label: 'has lyrics', cls: 'mb-none' }, untagged: { label: 'needs title + artist', cls: 'mb-bad' },
  error: { label: 'error', cls: 'mb-bad' }, skipped: { label: 'group: no lyrics', cls: 'mb-none' },
  manual: { label: 'picked by hand', cls: 'mb-good' },
}

export function openLyrics(ids: number[], onDone: () => Promise<void>) {
  const overlay = document.createElement('div')
  overlay.className = 'fix-confirm-overlay'
  overlay.innerHTML = `
    <div class="fix-confirm-modal pr-modal" role="dialog" aria-label="Lyrics">
      <div class="fix-confirm-header">
        <span class="fix-confirm-title">Lyrics from LRCLIB · ${ids.length.toLocaleString()} track${ids.length !== 1 ? 's' : ''}</span>
        <button class="btn btn-ghost btn-icon fix-confirm-close" aria-label="Close">✕</button>
      </div>
      <div class="pr-controls">
        <div class="pr-options">
          <label class="pr-select">Prefer
            <select id="ly-prefer"><option value="synced">Synced (timestamped) when available</option><option value="plain">Plain text</option></select></label>
          <label class="settings-toggle"><input id="ly-overwrite" type="checkbox" /><span>Replace lyrics tracks already have</span></label>
          <button class="btn btn-ghost btn-sm" id="ly-fetch">Fetch again</button>
        </div>
        <div id="ly-error" class="review-error" hidden></div>
      </div>
      <div class="pr-summary" id="ly-summary">Fetching…</div>
      <div class="fix-confirm-body pr-body">
        <table class="pr-table"><thead><tr><th class="pr-check"></th><th>Track</th><th>Found</th><th></th></tr></thead>
          <tbody id="ly-rows"></tbody></table>
      </div>
      <div class="fix-confirm-footer">
        <button class="btn btn-ghost" id="ly-cancel">Cancel</button>
        <button class="btn btn-primary" id="ly-apply" disabled>Stage lyrics</button>
      </div>
    </div>`
  document.body.appendChild(overlay)

  const $ = <T extends HTMLElement>(sel: string) => overlay.querySelector<T>(sel)!
  const rowsEl = $('#ly-rows'), sumEl = $('#ly-summary'), errEl = $('#ly-error'), goBtn = $<HTMLButtonElement>('#ly-apply')
  let items: LyricsItem[] = []
  const skip = new Set<number>(), open = new Set<number>()
  let token = 0

  const close = () => { overlay.remove(); document.removeEventListener('keydown', onKey) }
  const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') close() }
  document.addEventListener('keydown', onKey)
  overlay.addEventListener('click', e => { if (e.target === overlay) close() })
  $('.fix-confirm-close').addEventListener('click', close)
  $('#ly-cancel').addEventListener('click', close)

  const render = () => {
    rowsEl.innerHTML = items.map(i => {
      const s = STATUS[i.status] ?? STATUS.error
      const can = !!i.lyrics
      return `<tr class="pr-row${skip.has(i.id) ? ' pr-excluded' : ''}">
        <td class="pr-check"><input type="checkbox" data-id="${i.id}" ${can && !skip.has(i.id) ? 'checked' : ''} ${can ? '' : 'disabled'} /></td>
        <td>${esc(i.title)} <span class="ma-dim">· ${esc(i.artist ?? '')}${i.group ? ` · ${esc(i.group)}` : ''}</span>${i.error ? `<div class="pr-msg">${esc(i.error)}</div>` : ''}
          ${i.query ? `<div class="ma-dim ly-query">via ${esc([i.query.title, i.query.artist || '(any artist)', i.query.album].filter(Boolean).join(' · '))}</div>` : ''}</td>
        <td><span class="mb-score ${s.cls}">${s.label}</span></td>
        <td>${can ? `<button type="button" class="btn btn-ghost btn-sm" data-preview="${i.id}">${open.has(i.id) ? 'Hide' : 'Preview'}</button>` : ''}
          ${i.status !== 'has' ? `<button type="button" class="btn btn-ghost btn-sm" data-search="${i.id}" title="Search LRCLIB for this track by hand">Search…</button>` : ''}</td></tr>
        ${can && open.has(i.id) ? `<tr class="ly-preview"><td></td><td colspan="3"><pre>${esc(i.lyrics!)}</pre></td></tr>` : ''}`
    }).join('')
    const n = items.filter(i => i.lyrics && !skip.has(i.id)).length
    const c = (st: string) => items.filter(i => i.status === st).length
    sumEl.innerHTML = [`<strong>${n}</strong> to write`, c('synced') ? `${c('synced')} synced` : '', c('plain') ? `${c('plain')} plain` : '',
      c('missing') ? `${c('missing')} not found` : '', c('instrumental') ? `${c('instrumental')} instrumental` : '',
      c('has') ? `${c('has')} already have lyrics` : ''].filter(Boolean).join(' · ')
    goBtn.disabled = n === 0
    goBtn.textContent = `Stage lyrics on ${n} track${n !== 1 ? 's' : ''}`
  }

  async function fetchAll() {
    const t = ++token
    errEl.hidden = true; sumEl.textContent = 'Fetching from LRCLIB…'; goBtn.disabled = true
    try {
      const r = await api.lyrics.fetch(ids, $<HTMLSelectElement>('#ly-prefer').value, $<HTMLInputElement>('#ly-overwrite').checked)
      if (t !== token) return
      items = r.items; skip.clear(); render()
    } catch (e) { if (t === token) { errEl.textContent = errText(e); errEl.hidden = false } }
  }

  rowsEl.addEventListener('change', (e) => {
    const cb = e.target as HTMLInputElement
    const id = Number(cb.dataset.id)
    if (cb.checked) skip.delete(id); else skip.add(id)
    render()
  })
  rowsEl.addEventListener('click', (e) => {
    const sid = Number((e.target as HTMLElement).dataset.search)
    if (sid) {
      openLyricsSearch(sid, (text) => {
        const it = items.find(i => i.id === sid)!
        it.lyrics = text; it.status = 'manual'; it.query = null
        skip.delete(sid); render()
      })
      return
    }
    const id = Number((e.target as HTMLElement).dataset.preview)
    if (!id) return
    if (open.has(id)) open.delete(id); else open.add(id)
    render()
  })
  for (const sel of ['#ly-prefer', '#ly-overwrite']) $(sel).addEventListener('change', fetchAll)
  $('#ly-fetch').addEventListener('click', fetchAll)

  goBtn.addEventListener('click', async () => {
    const chosen: Record<number, string> = {}
    for (const i of items) if (i.lyrics && !skip.has(i.id)) chosen[i.id] = i.lyrics
    goBtn.disabled = true
    try {
      const r = await api.lyrics.stage(chosen)
      editToast(r, `lyrics on ${r.changed} track${r.changed !== 1 ? 's' : ''}`)
      close()
      await onDone()
    } catch (e) { toast(`Failed: ${errText(e)}`, 'error'); goBtn.disabled = false }
  })
  fetchAll()
}
