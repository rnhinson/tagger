/**
 * Clean up tags: rewrite other separators ("Folk/Celtic", "Ann & Bob") in a
 * multi-value tag as "; " (backend core/cleanup.py). Per separator found you
 * pick whether it applies; per value, untick to keep it as is ("AC/DC").
 * The preview is the server's, so it always matches what Apply stages.
 */
import { api } from './api'
import { editToast } from './staged'
import { toast } from './toast'
import { esc } from './util'

const FIELDS = [
  { key: 'genre', label: 'Genre' }, { key: 'artist', label: 'Artist' },
  { key: 'album_artist', label: 'Album Artist' }, { key: 'composer', label: 'Composer' },
]
const LABEL: Record<string, string> = {
  '/': 'Slash', '\\': 'Backslash', '|': 'Pipe', ',': 'Comma', '&': 'Ampersand', '+': 'Plus',
}
// Usually separators; comma/& are often part of a name, so start unticked.
const DEFAULT_ON = new Set(['/', '\\', '|'])

export function openCleanup(selected: number[], onDone: () => Promise<void>) {
  const overlay = document.createElement('div')
  overlay.className = 'modal-overlay'
  overlay.innerHTML = `
    <div class="modal-card modal-cleanup">
      <div class="modal-title">Clean up tag separators</div>
      <div class="cleanup-row">
        <label class="field-label">Field
          <select id="cu-field">${FIELDS.map(f => `<option value="${f.key}">${f.label}</option>`).join('')}</select>
        </label>
        <label class="field-label">Scope
          <select id="cu-scope">
            <option value="all">Whole library</option>
            ${selected.length ? `<option value="sel" selected>Selected tracks (${selected.length.toLocaleString()})</option>` : ''}
          </select>
        </label>
      </div>
      <div class="cleanup-hint">Values using these separators become <code>A; B</code>. Untick a value to keep it as is.</div>
      <div id="cu-found" class="cleanup-found">Looking…</div>
      <div class="cleanup-subtitle">Preview</div>
      <div id="cu-preview" class="cleanup-preview"></div>
      <div class="modal-actions">
        <button type="button" class="btn btn-ghost" id="cu-cancel">Close</button>
        <button type="button" class="btn btn-primary" id="cu-apply" disabled>Stage changes</button>
      </div>
    </div>`
  document.body.appendChild(overlay)
  const $ = <T extends HTMLElement>(sel: string) => overlay.querySelector<T>(sel)!
  const fieldEl = $<HTMLSelectElement>('#cu-field'), scopeEl = $<HTMLSelectElement>('#cu-scope')
  const foundEl = $('#cu-found'), previewEl = $('#cu-preview'), applyBtn = $<HTMLButtonElement>('#cu-apply')
  const close = () => overlay.remove()
  overlay.addEventListener('click', e => { if (e.target === overlay) close() })
  $('#cu-cancel').addEventListener('click', close)

  const seps = new Set<string>()
  const keep = new Set<string>()
  let token = 0
  const body = () => ({
    field: fieldEl.value,
    track_ids: scopeEl.value === 'sel' ? selected : null,
    separators: [...seps], keep: [...keep],
  })

  async function scan() {
    const t = ++token
    foundEl.textContent = 'Looking…'; previewEl.innerHTML = ''; applyBtn.disabled = true
    seps.clear(); keep.clear()
    try {
      const { separators } = await api.tags.separators(fieldEl.value, body().track_ids)
      if (t !== token) return
      if (!separators.length) { foundEl.innerHTML = '<div class="cleanup-none">Nothing to clean up: every value uses <code>;</code> or none.</div>'; return }
      for (const s of separators) if (DEFAULT_ON.has(s.sep)) seps.add(s.sep)
      foundEl.innerHTML = separators.map(s => `
        <details class="cleanup-sep" ${DEFAULT_ON.has(s.sep) ? 'open' : ''}>
          <summary><label><input type="checkbox" data-sep="${esc(s.sep)}" ${seps.has(s.sep) ? 'checked' : ''} /><span>${esc(LABEL[s.sep] ?? s.sep)}</span><code class="cleanup-sym">${esc(s.sep)}</code></label>
            <span class="cleanup-count">${s.values.length} value${s.values.length !== 1 ? 's' : ''} · ${s.tracks.toLocaleString()} tracks</span></summary>
          <div class="cleanup-values">${s.values.map(v => `
            <label class="cleanup-value"><input type="checkbox" data-value="${esc(v.value)}" checked />
              <span>${esc(v.value)}</span><span class="cleanup-count">${v.tracks.toLocaleString()}</span></label>`).join('')}
          </div>
        </details>`).join('')
      await preview()
    } catch (e) { foundEl.textContent = `Failed: ${e}` }
  }

  async function preview() {
    const t = ++token
    if (!seps.size) { previewEl.innerHTML = '<div class="cleanup-none">Tick a separator.</div>'; applyBtn.disabled = true; return }
    try {
      const r = await api.tags.standardize({ ...body(), preview: true })
      if (t !== token) return
      previewEl.innerHTML = r.changes.length
        ? r.changes.slice(0, 300).map(c => `<div class="cleanup-change"><span class="cleanup-old">${esc(c.old)}</span>
            <span class="cleanup-arrow">→</span><span class="cleanup-new">${esc(c.new)}</span>
            <span class="cleanup-count">${c.tracks.toLocaleString()}</span></div>`).join('')
          + (r.changes.length > 300 ? `<div class="cleanup-none">…and ${r.changes.length - 300} more</div>` : '')
        : '<div class="cleanup-none">No changes.</div>'
      applyBtn.disabled = !r.tracks
      applyBtn.textContent = r.tracks ? `Stage ${r.tracks.toLocaleString()} track${r.tracks !== 1 ? 's' : ''}` : 'Stage changes'
    } catch (e) { previewEl.textContent = `Preview failed: ${e}` }
  }

  foundEl.addEventListener('change', (e) => {
    const el = e.target as HTMLInputElement
    if (el.dataset.sep !== undefined) {
      if (el.checked) seps.add(el.dataset.sep); else seps.delete(el.dataset.sep)
      el.closest('details')!.open = el.checked
    } else if (el.dataset.value !== undefined) {
      if (el.checked) keep.delete(el.dataset.value); else keep.add(el.dataset.value)
    }
    preview()
  })
  // A click on the summary's checkbox shouldn't also toggle the <details>.
  foundEl.addEventListener('click', (e) => {
    if ((e.target as HTMLElement).matches('summary input')) e.stopPropagation()
  })
  fieldEl.addEventListener('change', scan)
  scopeEl.addEventListener('change', scan)

  applyBtn.addEventListener('click', async () => {
    applyBtn.disabled = true
    try {
      const r = await api.tags.standardize({ ...body(), preview: false })
      editToast(r, `separators on ${r.tracks.toLocaleString()} track${r.tracks !== 1 ? 's' : ''}`)
      close()
      await onDone()
    } catch (e) {
      toast(`Clean up failed: ${e}`, 'error'); applyBtn.disabled = false
    }
  })
  scan()
}
