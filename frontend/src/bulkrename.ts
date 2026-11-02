// Bulk rename in the style of Windows PowerRename: search/replace (regex with
// captures), counters, case formatting, a live before/after preview, and
// per-row opt-out. Staged like every other change.
import { api, BulkRenameRequest, RenameItem } from './api'
import { toast } from './toast'
import { esc, debounce } from './util'
import { errText, shortPath } from './staged'

const MAX_ROWS = 1000

const HELP = `
  <table class="pr-help">
    <tr><td><code>$1</code> <code>\${name}</code></td><td>capture group (regex)</td></tr>
    <tr><td><code>$0</code></td><td>the whole match</td></tr>
    <tr><td><code>\${}</code></td><td>counter 1, 2, 3…</td></tr>
    <tr><td><code>\${start=10,increment=5,padding=3}</code></td><td>counter options, any combination</td></tr>
    <tr><td><code>$$</code></td><td>a literal $</td></tr>
    <tr><td><code>(\\d+)</code> <code>(?P&lt;name&gt;…)</code></td><td>regex groups: numbered / named</td></tr>
  </table>`

export function openBulkRename(ids: number[], onDone: () => Promise<void>) {
  const overlay = document.createElement('div')
  overlay.className = 'fix-confirm-overlay'
  overlay.innerHTML = `
    <div class="fix-confirm-modal pr-modal" role="dialog" aria-label="Rename files">
      <div class="fix-confirm-header">
        <span class="fix-confirm-title">Rename ${ids.length.toLocaleString()} file${ids.length !== 1 ? 's' : ''}</span>
        <button class="btn btn-ghost btn-icon fix-confirm-close" aria-label="Close">✕</button>
      </div>
      <div class="pr-controls">
        <label class="field-label">Search for<input id="pr-find" type="text" autocomplete="off" spellcheck="false" /></label>
        <label class="field-label">Replace with<input id="pr-replace" type="text" autocomplete="off" spellcheck="false" /></label>
        <div class="pr-options">
          <label class="settings-toggle"><input id="pr-regex" type="checkbox" /><span>Use regular expressions</span></label>
          <label class="settings-toggle"><input id="pr-case" type="checkbox" /><span>Case sensitive</span></label>
          <label class="settings-toggle"><input id="pr-all" type="checkbox" checked /><span>Match all occurrences</span></label>
        </div>
        <div class="pr-options">
          <label class="pr-select">Apply to
            <select id="pr-apply"><option value="name">Name only</option><option value="ext">Extension only</option><option value="both">Name + extension</option></select>
          </label>
          <label class="pr-select">Text formatting
            <select id="pr-transform"><option value="none">None</option><option value="lower">lowercase</option><option value="upper">UPPERCASE</option><option value="title">Title Case</option><option value="capitalize">Capitalize Each Word</option></select>
          </label>
          <details class="pr-help-wrap"><summary>Syntax</summary>${HELP}</details>
        </div>
        <div id="pr-error" class="review-error" hidden></div>
      </div>
      <div class="pr-summary" id="pr-summary"></div>
      <div class="fix-confirm-body pr-body">
        <table class="pr-table">
          <thead><tr><th class="pr-check"><input id="pr-check-all" type="checkbox" checked title="Include all" /></th><th>Original</th><th>Renamed</th></tr></thead>
          <tbody id="pr-rows"></tbody>
        </table>
      </div>
      <div class="fix-confirm-footer">
        <button class="btn btn-ghost" id="pr-cancel">Cancel</button>
        <button class="btn btn-primary" id="pr-apply-btn" disabled>Stage renames</button>
      </div>
    </div>`
  document.body.appendChild(overlay)

  const $ = <T extends HTMLElement>(sel: string) => overlay.querySelector<T>(sel)!
  const findEl = $<HTMLInputElement>('#pr-find'), replEl = $<HTMLInputElement>('#pr-replace')
  const regexEl = $<HTMLInputElement>('#pr-regex'), caseEl = $<HTMLInputElement>('#pr-case')
  const allEl = $<HTMLInputElement>('#pr-all'), applyEl = $<HTMLSelectElement>('#pr-apply')
  const trEl = $<HTMLSelectElement>('#pr-transform'), errEl = $('#pr-error')
  const rowsEl = $('#pr-rows'), sumEl = $('#pr-summary'), goBtn = $<HTMLButtonElement>('#pr-apply-btn')
  const checkAll = $<HTMLInputElement>('#pr-check-all')

  const excluded = new Set<number>()
  let items: RenameItem[] = []
  let token = 0

  const close = () => { overlay.remove(); document.removeEventListener('keydown', onKey) }
  const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') close() }
  document.addEventListener('keydown', onKey)
  overlay.addEventListener('click', e => { if (e.target === overlay) close() })
  $('.fix-confirm-close').addEventListener('click', close)
  $('#pr-cancel').addEventListener('click', close)

  const req = (): BulkRenameRequest => ({
    track_ids: ids, find: findEl.value, replace: replEl.value,
    regex: regexEl.checked, case_sensitive: caseEl.checked, match_all: allEl.checked,
    apply_to: applyEl.value as BulkRenameRequest['apply_to'],
    transform: trEl.value as BulkRenameRequest['transform'],
  })

  const willRename = () => items.filter(it => it.status === 'rename' && !excluded.has(it.id)).length

  const renderRows = () => {
    const shown = items.slice(0, MAX_ROWS)
    let lastFolder = ''
    rowsEl.innerHTML = shown.map(it => {
      const folderRow = it.folder !== lastFolder
        ? `<tr class="pr-folder"><td></td><td colspan="2">📁 ${esc(shortPath(it.folder))}</td></tr>` : ''
      lastFolder = it.folder
      const can = it.status === 'rename'
      const cls = `pr-row pr-${it.status}${excluded.has(it.id) ? ' pr-excluded' : ''}`
      const renamed = it.status === 'same'
        ? '<span class="pr-same">unchanged</span>'
        : `${esc(it.new)}${it.message ? `<div class="pr-msg">⚠ ${esc(it.message)}</div>` : ''}`
      return `${folderRow}<tr class="${cls}">
        <td class="pr-check"><input type="checkbox" data-id="${it.id}" ${can && !excluded.has(it.id) ? 'checked' : ''} ${can ? '' : 'disabled'} /></td>
        <td class="pr-old">${esc(it.old)}</td>
        <td class="pr-new">${renamed}</td></tr>`
    }).join('')
    const c = { rename: 0, same: 0, conflict: 0, error: 0 } as Record<string, number>
    for (const it of items) c[it.status]++
    const n = willRename()
    sumEl.innerHTML = [
      `<strong>${n.toLocaleString()}</strong> will be renamed`,
      c.same ? `${c.same.toLocaleString()} unchanged` : '',
      excluded.size ? `${excluded.size} unticked` : '',
      c.conflict ? `<span class="pr-bad">${c.conflict} clash${c.conflict !== 1 ? 'es' : ''}</span>` : '',
      c.error ? `<span class="pr-bad">${c.error} invalid</span>` : '',
      items.length > MAX_ROWS ? `showing the first ${MAX_ROWS.toLocaleString()}` : '',
    ].filter(Boolean).join(' · ')
    goBtn.disabled = n === 0
    goBtn.textContent = `Stage ${n.toLocaleString()} rename${n !== 1 ? 's' : ''}`
  }

  const refresh = debounce(async () => {
    const t = ++token
    try {
      const res = await api.tags.renamePreview(req())
      if (t !== token) return
      errEl.hidden = true
      items = res.items
      renderRows()
    } catch (e) {
      if (t !== token) return
      errEl.textContent = errText(e)
      errEl.hidden = false
      goBtn.disabled = true
    }
  }, 200)

  for (const el of [findEl, replEl]) el.addEventListener('input', refresh)
  for (const el of [regexEl, caseEl, allEl, applyEl, trEl]) el.addEventListener('change', refresh)

  rowsEl.addEventListener('change', e => {
    const cb = e.target as HTMLInputElement
    if (!cb.dataset.id) return
    const id = Number(cb.dataset.id)
    cb.checked ? excluded.delete(id) : excluded.add(id)
    renderRows()
  })
  checkAll.addEventListener('change', () => {
    excluded.clear()
    if (!checkAll.checked) for (const it of items) if (it.status === 'rename') excluded.add(it.id)
    renderRows()
  })

  goBtn.addEventListener('click', async () => {
    goBtn.disabled = true
    try {
      const r = await api.tags.rename({ ...req(), exclude: [...excluded] })
      close()
      const skip = r.skipped ? ` — ${r.skipped} skipped (clash/invalid)` : ''
      if (r.staged) toast(`Staged ${r.planned} rename${r.planned !== 1 ? 's' : ''} — Review to write${skip}`, 'info')
      else toast(`Renamed ${r.moved} file${r.moved !== 1 ? 's' : ''}${skip}`, r.errors.length ? 'error' : 'success')
      await onDone()
    } catch (e) {
      errEl.textContent = errText(e)
      errEl.hidden = false
      goBtn.disabled = false
    }
  })

  refresh()
  findEl.focus()
}
