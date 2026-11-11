// Find & replace in one tag across the selection: plain text or a regex with
// capture groups and counters (the same template as Rename files…), with a
// live preview of what changes. Staged like every other edit.
import { api, EditResult, FindReplaceRequest } from './api'
import { HELP } from './bulkrename'
import { editToast, errText } from './staged'
import { esc, debounce } from './util'

const MAX_ROWS = 500

const FIELDS: { key: string; label: string }[] = [
  { key: 'title', label: 'Title' }, { key: 'artist', label: 'Artist' },
  { key: 'album', label: 'Album' }, { key: 'album_artist', label: 'Album Artist' },
  { key: 'year', label: 'Year' }, { key: 'track_number', label: 'Track #' },
  { key: 'disc_number', label: 'Disc #' }, { key: 'genre', label: 'Genre' },
  { key: 'composer', label: 'Composer' }, { key: 'bpm', label: 'BPM' },
  { key: 'comment', label: 'Comment' }, { key: 'lyrics', label: 'Lyrics' },
]

export function openFindReplace(ids: number[], onDone: (res: EditResult) => Promise<void>) {
  const overlay = document.createElement('div')
  overlay.className = 'fix-confirm-overlay'
  overlay.innerHTML = `
    <div class="fix-confirm-modal pr-modal" role="dialog" aria-label="Find and replace">
      <div class="fix-confirm-header">
        <span class="fix-confirm-title">Find &amp; replace in ${ids.length.toLocaleString()} track${ids.length !== 1 ? 's' : ''}</span>
        <button class="btn btn-ghost btn-icon fix-confirm-close" aria-label="Close">✕</button>
      </div>
      <div class="pr-controls">
        <label class="pr-select">Tag
          <select id="fr-field">${FIELDS.map(f => `<option value="${f.key}">${f.label}</option>`).join('')}</select>
        </label>
        <label class="field-label">Find<input id="fr-find" type="text" autocomplete="off" spellcheck="false" /></label>
        <label class="field-label">Replace with<input id="fr-replace" type="text" autocomplete="off" spellcheck="false" /></label>
        <div class="pr-options">
          <button type="button" class="tog" id="fr-regex" aria-pressed="false" title="Find is a regular expression; the replacement can use $1, \${name}, $0">Regex</button>
          <button type="button" class="tog" id="fr-case" aria-pressed="true" title="Upper and lower case must match">Match case</button>
          <details class="pr-help-wrap"><summary>Syntax</summary>${HELP}</details>
        </div>
        <div id="fr-error" class="review-error" hidden></div>
      </div>
      <div class="pr-summary" id="fr-summary"></div>
      <div class="fix-confirm-body pr-body">
        <table class="pr-table">
          <thead><tr><th>File</th><th>Now</th><th>Becomes</th></tr></thead>
          <tbody id="fr-rows"></tbody>
        </table>
      </div>
      <div class="fix-confirm-footer">
        <button class="btn btn-ghost" id="fr-cancel">Cancel</button>
        <button class="btn btn-primary" id="fr-go" disabled>Replace</button>
      </div>
    </div>`
  document.body.appendChild(overlay)

  const $ = <T extends HTMLElement>(sel: string) => overlay.querySelector<T>(sel)!
  const fieldEl = $<HTMLSelectElement>('#fr-field'), findEl = $<HTMLInputElement>('#fr-find')
  const replEl = $<HTMLInputElement>('#fr-replace'), regexEl = $<HTMLButtonElement>('#fr-regex')
  const caseEl = $<HTMLButtonElement>('#fr-case'), errEl = $('#fr-error'), rowsEl = $('#fr-rows')
  const sumEl = $('#fr-summary'), goBtn = $<HTMLButtonElement>('#fr-go')
  const on = (b: HTMLElement) => b.getAttribute('aria-pressed') === 'true'
  let token = 0, changed = 0

  const close = () => { overlay.remove(); document.removeEventListener('keydown', onKey) }
  const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') close() }
  document.addEventListener('keydown', onKey)
  overlay.addEventListener('click', e => { if (e.target === overlay) close() })
  $('.fix-confirm-close').addEventListener('click', close)
  $('#fr-cancel').addEventListener('click', close)

  const req = (): FindReplaceRequest => ({
    track_ids: ids, field: fieldEl.value, find: findEl.value, replace: replEl.value,
    regex: on(regexEl), case_sensitive: on(caseEl),
  })

  const show = (rows: { name: string; before: string; after: string }[], n: number) => {
    changed = n
    rowsEl.innerHTML = rows.slice(0, MAX_ROWS).map(r =>
      `<tr><td class="pr-old">${esc(r.name)}</td><td class="pr-old">${esc(r.before)}</td><td class="pr-new">${esc(r.after) || '<span class="pr-same">(empty)</span>'}</td></tr>`).join('')
    sumEl.innerHTML = !findEl.value ? 'Type what to find'
      : [`<strong>${n.toLocaleString()}</strong> of ${ids.length.toLocaleString()} change`,
         n > MAX_ROWS ? `showing the first ${MAX_ROWS.toLocaleString()}` : ''].filter(Boolean).join(' · ')
    goBtn.disabled = n === 0
    goBtn.textContent = n ? `Replace in ${n.toLocaleString()}` : 'Replace'
  }

  const refresh = debounce(async () => {
    const t = ++token
    if (!findEl.value) { errEl.hidden = true; show([], 0); return }
    try {
      const res = await api.tags.findReplacePreview(req())
      if (t !== token) return
      errEl.hidden = true
      show(res.changes, res.changed)
    } catch (e) {
      if (t !== token) return
      errEl.textContent = errText(e)
      errEl.hidden = false
      show([], 0)
    }
  }, 200)

  for (const el of [findEl, replEl]) el.addEventListener('input', refresh)
  fieldEl.addEventListener('change', refresh)
  for (const b of [regexEl, caseEl]) b.addEventListener('click', () => {
    b.setAttribute('aria-pressed', String(!on(b)))
    refresh()
  })
  for (const el of [findEl, replEl]) el.addEventListener('keydown', e => {
    if (e.key === 'Enter' && !goBtn.disabled) { e.preventDefault(); goBtn.click() }
  })

  goBtn.addEventListener('click', async () => {
    goBtn.disabled = true
    try {
      const res = await api.tags.findReplace(req())
      close()
      editToast(res, `replacements in ${res.changed} track${res.changed !== 1 ? 's' : ''}`)
      await onDone(res)
    } catch (e) {
      errEl.textContent = errText(e)
      errEl.hidden = false
      goBtn.disabled = changed === 0
    }
  })

  show([], 0)
  findEl.focus()
}
