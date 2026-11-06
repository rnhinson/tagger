// Lyrics groups: the editor in Settings (name, Skip, queries tried in order)
// and "Lyrics group…" for a selection. Backend: core/lyricsgroups.py.
import { api, LyricsGroup, LyricsQuery } from './api'
import { toast } from './toast'
import { esc } from './util'
import { errText } from './staged'

const BUILT_IN = new Set(['standard', 'none'])

function queryRow(q: LyricsQuery): string {
  const f = (k: keyof LyricsQuery, ph: string) =>
    `<input type="text" spellcheck="false" data-q="${k}" value="${esc(q[k])}" placeholder="${ph}" />`
  return `<div class="lyrics-query">${f('title', 'title')}${f('artist', 'artist (blank: by album)')}${f('album', 'album')}
    <button type="button" class="btn btn-ghost btn-sm" data-q-remove title="Remove this query">✕</button></div>`
}

function groupCard(g: LyricsGroup): string {
  return `<div class="lyrics-group" data-id="${esc(g.id)}">
    <div class="lyrics-group-head">
      <input type="text" class="lyrics-group-name" value="${esc(g.name)}" placeholder="Group name" ${BUILT_IN.has(g.id) ? 'readonly' : ''} />
      <label class="settings-toggle"><input type="checkbox" data-skip ${g.skip ? 'checked' : ''} ${g.id === 'none' ? 'disabled' : ''} /><span>Skip</span></label>
      ${g.assigned ? `<span class="ma-dim">${g.assigned.toLocaleString()} tracks</span>` : ''}
      ${BUILT_IN.has(g.id) ? '' : '<button type="button" class="btn btn-ghost btn-sm" data-group-remove title="Delete this group (its tracks go back to their library\'s group)">Delete</button>'}
    </div>
    <div class="lyrics-queries" ${g.skip ? 'hidden' : ''}>${g.queries.map(queryRow).join('')}
      <button type="button" class="btn btn-link btn-sm" data-q-add>+ query</button></div>
  </div>`
}

export async function renderLyricsGroups(el: HTMLElement) {
  try {
    el.innerHTML = (await api.lyrics.groups()).map(groupCard).join('')
  } catch (e) { el.innerHTML = `<div class="settings-hint">Failed to load lyrics groups: ${esc(errText(e))}</div>` }
}

export function wireLyricsGroups(el: HTMLElement, addBtn: HTMLElement) {
  addBtn.addEventListener('click', () => {
    el.insertAdjacentHTML('beforeend', groupCard({ id: '', name: '', skip: false,
      queries: [{ title: '{title_base}', artist: '{artist_first}', album: '' }] }))
    el.querySelector<HTMLInputElement>('.lyrics-group:last-child .lyrics-group-name')!.focus()
  })
  el.addEventListener('click', (e) => {
    const t = e.target as HTMLElement
    const card = t.closest<HTMLElement>('.lyrics-group')
    if (!card) return
    if (t.closest('[data-q-add]')) t.closest('[data-q-add]')!.insertAdjacentHTML('beforebegin', queryRow({ title: '{title}', artist: '', album: '' }))
    else if (t.closest('[data-q-remove]')) t.closest('.lyrics-query')!.remove()
    else if (t.closest('[data-group-remove]')) card.remove()
  })
  el.addEventListener('change', (e) => {
    const cb = e.target as HTMLInputElement
    if (cb.dataset.skip !== undefined) cb.closest('.lyrics-group')!.querySelector<HTMLElement>('.lyrics-queries')!.hidden = cb.checked
  })
}

/** The groups as edited, or null when the list never loaded (leave them as they are). */
export function readLyricsGroups(el: HTMLElement): LyricsGroup[] | null {
  const cards = [...el.querySelectorAll<HTMLElement>('.lyrics-group')]
  if (!cards.length) return null
  return cards.map(c => ({
    id: c.dataset.id ?? '',
    name: c.querySelector<HTMLInputElement>('.lyrics-group-name')!.value.trim(),
    skip: c.querySelector<HTMLInputElement>('[data-skip]')!.checked,
    queries: [...c.querySelectorAll<HTMLElement>('.lyrics-query')].map(r => {
      const v = (k: string) => r.querySelector<HTMLInputElement>(`[data-q="${k}"]`)!.value.trim()
      return { title: v('title'), artist: v('artist'), album: v('album') }
    }).filter(q => q.title),
  }))
}

/** A library's default group, as a <select> for its row under Libraries. */
export function libraryGroupSelect(groups: LyricsGroup[], path: string, current: string): string {
  return `<label class="library-lyrics">Lyrics <select data-lyrics-path="${esc(path)}">
    ${groups.map(g => `<option value="${g.id === 'standard' ? '' : esc(g.id)}" ${(current || 'standard') === g.id ? 'selected' : ''}>${esc(g.name)}</option>`).join('')}
  </select></label>`
}

/** "Lyrics group…": put the selection in a group, or back to its library's. */
export async function openAssignGroup(ids: number[], onDone: () => Promise<void>) {
  let groups: LyricsGroup[]
  try { groups = await api.lyrics.groups() } catch (e) { toast(`Failed: ${errText(e)}`, 'error'); return }
  const overlay = document.createElement('div')
  overlay.className = 'modal-overlay'
  const n = `${ids.length.toLocaleString()} track${ids.length !== 1 ? 's' : ''}`
  overlay.innerHTML = `
    <div class="modal-card">
      <div class="modal-title">Lyrics group for ${n}</div>
      <div class="lyrics-assign">
        <label class="settings-toggle"><input type="radio" name="lg" value="" checked /><span>Library's group <span class="ma-dim">(as set under Settings → Libraries)</span></span></label>
        ${groups.map(g => `<label class="settings-toggle"><input type="radio" name="lg" value="${esc(g.id)}" /><span>${esc(g.name)}${g.skip ? ' <span class="ma-dim">— never looked up, not "missing"</span>' : ''}</span></label>`).join('')}
      </div>
      <div class="modal-actions"><button class="btn btn-ghost" data-cancel>Cancel</button><button class="btn btn-primary" data-ok>Set group</button></div>
    </div>`
  document.body.appendChild(overlay)
  const close = () => overlay.remove()
  overlay.addEventListener('click', e => { if (e.target === overlay) close() })
  overlay.querySelector('[data-cancel]')!.addEventListener('click', close)
  overlay.querySelector<HTMLButtonElement>('[data-ok]')!.addEventListener('click', async (e) => {
    const id = overlay.querySelector<HTMLInputElement>('input[name="lg"]:checked')!.value || null
    ;(e.target as HTMLButtonElement).disabled = true
    try {
      await api.lyrics.assign(ids, id)
      toast(`${n} → ${id ? groups.find(g => g.id === id)!.name : "library's group"}`, 'success')
      close()
      await onDone()
    } catch (err) { toast(`Failed: ${errText(err)}`, 'error'); (e.target as HTMLButtonElement).disabled = false }
  })
}
