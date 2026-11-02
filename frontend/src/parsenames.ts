// Tags from file names (Mp3tag's "Filename - Tag"): a %field% pattern matched
// against the end of each path, a live preview of what it would set, per-row
// opt-out, then one staged step. Pattern syntax: backend core/nameparse.py.
import { api } from './api'
import { toast } from './toast'
import { esc, debounce } from './util'
import { editToast, errText, shortPath } from './staged'

const FIELDS = ['title', 'artist', 'album', 'album_artist', 'year', 'track', 'disc', 'genre', 'composer', 'dummy']
const PRESETS = [
  '%track% - %title%',
  '%track% %title%',
  '%artist% - %title%',
  '%track% - %artist% - %title%',
  '%album%/%track% - %title%',
  '%artist%/%album%/%track% - %title%',
  '%artist%/%album% (%year%)/%track% - %title%',
  '%artist% - %album%/%disc%-%track% %title%',
]
const COL: Record<string, string> = {
  title: 'Title', artist: 'Artist', album: 'Album', album_artist: 'Album artist', year: 'Year',
  track_number: 'Track', disc_number: 'Disc', genre: 'Genre', composer: 'Composer',
}
const FIELD_OF: Record<string, string> = { track: 'track_number', disc: 'disc_number', albumartist: 'album_artist' }
const KEY = 'tagger.parsePattern'

interface Item { id: number; path: string; matched: boolean; tags: Record<string, string>; changes: Record<string, string> }

export function openParseNames(ids: number[], onDone: () => Promise<void>) {
  let saved = PRESETS[5]
  try { saved = localStorage.getItem(KEY) || saved } catch { /* storage blocked */ }
  const overlay = document.createElement('div')
  overlay.className = 'fix-confirm-overlay'
  overlay.innerHTML = `
    <div class="fix-confirm-modal pr-modal" role="dialog" aria-label="Tags from file names">
      <div class="fix-confirm-header">
        <span class="fix-confirm-title">Tags from file names · ${ids.length.toLocaleString()} track${ids.length !== 1 ? 's' : ''}</span>
        <button class="btn btn-ghost btn-icon fix-confirm-close" aria-label="Close">✕</button>
      </div>
      <div class="pr-controls">
        <label class="field-label">Pattern (matched against the end of the path; each / is one folder)
          <input id="pn-pattern" type="text" autocomplete="off" spellcheck="false" value="${esc(saved)}" list="pn-presets" />
          <datalist id="pn-presets">${PRESETS.map(p => `<option value="${esc(p)}"></option>`).join('')}</datalist>
        </label>
        <div class="pn-fields">${FIELDS.map(f => `<button type="button" class="btn btn-ghost btn-sm" data-field="${f}">%${f}%</button>`).join('')}</div>
        <div id="pn-error" class="review-error" hidden></div>
      </div>
      <div class="pr-summary" id="pn-summary"></div>
      <div class="fix-confirm-body pr-body">
        <table class="pr-table pn-table"><thead id="pn-head"></thead><tbody id="pn-rows"></tbody></table>
      </div>
      <div class="fix-confirm-footer">
        <button class="btn btn-ghost" id="pn-cancel">Cancel</button>
        <button class="btn btn-primary" id="pn-apply" disabled>Stage tags</button>
      </div>
    </div>`
  document.body.appendChild(overlay)

  const $ = <T extends HTMLElement>(sel: string) => overlay.querySelector<T>(sel)!
  const patEl = $<HTMLInputElement>('#pn-pattern'), errEl = $('#pn-error'), sumEl = $('#pn-summary')
  const headEl = $('#pn-head'), rowsEl = $('#pn-rows'), goBtn = $<HTMLButtonElement>('#pn-apply')
  const excluded = new Set<number>()
  let items: Item[] = [], total = 0, cols: string[] = [], token = 0

  const close = () => { overlay.remove(); document.removeEventListener('keydown', onKey) }
  const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') close() }
  document.addEventListener('keydown', onKey)
  overlay.addEventListener('click', e => { if (e.target === overlay) close() })
  $('.fix-confirm-close').addEventListener('click', close)
  $('#pn-cancel').addEventListener('click', close)

  const fieldsIn = (pattern: string) => [...new Set(
    [...pattern.matchAll(/%(\w+)%/g)].map(m => m[1].toLowerCase()).filter(f => f !== 'dummy').map(f => FIELD_OF[f] ?? f))]
  const willSet = () => items.filter(i => Object.keys(i.changes).length && !excluded.has(i.id)).length

  const render = () => {
    headEl.innerHTML = `<tr><th class="pr-check"></th><th>File</th>${cols.map(c => `<th>${esc(COL[c] ?? c)}</th>`).join('')}</tr>`
    rowsEl.innerHTML = items.map(i => {
      const can = Object.keys(i.changes).length > 0
      const cells = cols.map(c => {
        if (!i.matched) return '<td></td>'
        const v = i.tags[c] ?? ''
        return `<td class="${c in i.changes ? 'pn-change' : 'pn-same'}">${esc(v)}</td>`
      }).join('')
      return `<tr class="pr-row ${i.matched ? '' : 'pn-nomatch'}${excluded.has(i.id) ? ' pr-excluded' : ''}">
        <td class="pr-check"><input type="checkbox" data-id="${i.id}" ${can && !excluded.has(i.id) ? 'checked' : ''} ${can ? '' : 'disabled'} /></td>
        <td class="pn-file" title="${esc(i.path)}">${esc(shortPath(i.path))}${i.matched ? '' : '<div class="pr-msg">no match</div>'}</td>${cells}</tr>`
    }).join('')
    const n = willSet(), miss = items.filter(i => !i.matched).length
    sumEl.innerHTML = [
      `<strong>${n.toLocaleString()}</strong> will change`,
      miss ? `<span class="pr-bad">${miss} don't match</span>` : '',
      excluded.size ? `${excluded.size} unticked` : '',
      total > items.length ? `showing the first ${items.length.toLocaleString()}` : '',
    ].filter(Boolean).join(' · ')
    goBtn.disabled = n === 0
    goBtn.textContent = `Stage tags on ${n.toLocaleString()} track${n !== 1 ? 's' : ''}`
  }

  const refresh = debounce(async () => {
    const t = ++token
    try {
      const res = await api.tags.parsePreview(ids, patEl.value)
      if (t !== token) return
      errEl.hidden = true
      items = res.items; total = res.total; cols = fieldsIn(patEl.value)
      render()
    } catch (e) {
      if (t !== token) return
      errEl.textContent = errText(e); errEl.hidden = false; goBtn.disabled = true
    }
  }, 200)

  patEl.addEventListener('input', refresh)
  $('.pn-fields').addEventListener('click', (e) => {
    const f = (e.target as HTMLElement).dataset.field
    if (!f) return
    const at = patEl.selectionStart ?? patEl.value.length
    patEl.setRangeText(`%${f}%`, at, patEl.selectionEnd ?? at, 'end')
    patEl.focus(); refresh()
  })
  rowsEl.addEventListener('change', (e) => {
    const cb = e.target as HTMLInputElement
    const id = Number(cb.dataset.id)
    if (cb.checked) excluded.delete(id); else excluded.add(id)
    render()
  })
  goBtn.addEventListener('click', async () => {
    goBtn.disabled = true
    try {
      const res = await api.tags.parseNames(ids, patEl.value, [...excluded])
      try { localStorage.setItem(KEY, patEl.value) } catch { /* storage blocked */ }
      editToast(res, `tags from file names on ${res.changed.toLocaleString()} track${res.changed !== 1 ? 's' : ''}`)
      close()
      await onDone()
    } catch (e) {
      toast(`Failed: ${errText(e)}`, 'error'); goBtn.disabled = false
    }
  })
  refresh()
  patEl.focus()
}
