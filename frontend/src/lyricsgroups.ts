// Groups: the editor in Settings → Groups (name, Skip, lyrics queries tried
// in order), their layouts in Settings → Layouts, and "Group…" for a
// selection. Backend: core/lyricsgroups.py, core/layout.py.
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
      <input type="text" class="lyrics-group-name" value="${esc(g.name)}" placeholder="Group name" ${BUILT_IN.has(g.id) ? 'readonly title="Built in"' : ''} />
      <label class="settings-toggle"><input type="checkbox" data-skip ${g.skip ? 'checked' : ''} ${g.id === 'none' ? 'disabled' : ''} /><span>Skip</span></label>
      ${g.assigned ? `<span class="ma-dim">${g.assigned.toLocaleString()} tracks</span>` : ''}
      ${BUILT_IN.has(g.id) ? '' : '<button type="button" class="btn btn-ghost btn-sm" data-group-remove title="Delete this group (its tracks go back to their library\'s group)">Delete</button>'}
    </div>
    <div class="lyrics-queries" ${g.skip ? 'hidden' : ''}>${g.queries.map(queryRow).join('')}
      <button type="button" class="btn btn-link btn-sm" data-q-add>+ query</button></div>
  </div>`
}

export function renderLyricsGroups(el: HTMLElement, groups: LyricsGroup[]) {
  el.innerHTML = groups.map(groupCard).join('')
}

function layoutRow(g: LyricsGroup, i: number): string {
  return `<tr data-group-layout="${i}"><td class="group-layout-name">${esc(g.name) || '<span class="ma-dim">(new group)</span>'}</td>
    <td><input type="text" spellcheck="false" data-layout-input value="${esc(g.layout ?? '')}" placeholder="library's layout" /></td></tr>`
}

/** Settings → Layouts: one row per group card, in the same order. */
export function renderGroupLayouts(layoutsEl: HTMLElement, groups: LyricsGroup[]) {
  layoutsEl.innerHTML = groups.map(layoutRow).join('')
}

export function wireLyricsGroups(el: HTMLElement, addBtn: HTMLElement, layoutsEl: HTMLElement) {
  // Layout rows follow the cards by position: added, renamed and deleted with them.
  const rows = () => [...layoutsEl.querySelectorAll<HTMLElement>('[data-group-layout]')]
  const cards = () => [...el.querySelectorAll<HTMLElement>('.lyrics-group')]
  addBtn.addEventListener('click', () => {
    el.insertAdjacentHTML('beforeend', groupCard({ id: '', name: '', skip: false,
      queries: [{ title: '{title_base}', artist: '{artist_first}', album: '' }] }))
    layoutsEl.insertAdjacentHTML('beforeend', layoutRow({ id: '', name: '', skip: false, queries: [] }, rows().length))
    el.querySelector<HTMLInputElement>('.lyrics-group:last-child .lyrics-group-name')!.focus()
  })
  el.addEventListener('input', (e) => {
    const name = (e.target as HTMLElement).closest<HTMLInputElement>('.lyrics-group-name')
    if (!name) return
    const row = rows()[cards().indexOf(name.closest('.lyrics-group')!)]
    if (row) row.querySelector('.group-layout-name')!.innerHTML = esc(name.value.trim()) || '<span class="ma-dim">(new group)</span>'
  })
  el.addEventListener('click', (e) => {
    const t = e.target as HTMLElement
    const card = t.closest<HTMLElement>('.lyrics-group')
    if (!card) return
    if (t.closest('[data-q-add]')) t.closest('[data-q-add]')!.insertAdjacentHTML('beforebegin', queryRow({ title: '{title}', artist: '', album: '' }))
    else if (t.closest('[data-q-remove]')) t.closest('.lyrics-query')!.remove()
    else if (t.closest('[data-group-remove]')) { rows()[cards().indexOf(card)]?.remove(); card.remove() }
  })
  el.addEventListener('change', (e) => {
    const cb = e.target as HTMLInputElement
    if (cb.dataset.skip !== undefined) cb.closest('.lyrics-group')!.querySelector<HTMLElement>('.lyrics-queries')!.hidden = cb.checked
  })
}

/** The groups as edited, with their layouts, or null when the list never loaded (leave them as they are). */
export function readLyricsGroups(el: HTMLElement, layoutsEl: HTMLElement): LyricsGroup[] | null {
  const cards = [...el.querySelectorAll<HTMLElement>('.lyrics-group')]
  if (!cards.length) return null
  const layouts = [...layoutsEl.querySelectorAll<HTMLInputElement>('[data-group-layout] [data-layout-input]')].map(i => i.value.trim())
  return cards.map((c, i) => ({
    id: c.dataset.id ?? '',
    name: c.querySelector<HTMLInputElement>('.lyrics-group-name')!.value.trim(),
    skip: c.querySelector<HTMLInputElement>('[data-skip]')!.checked,
    queries: [...c.querySelectorAll<HTMLElement>('.lyrics-query')].map(r => {
      const v = (k: string) => r.querySelector<HTMLInputElement>(`[data-q="${k}"]`)!.value.trim()
      return { title: v('title'), artist: v('artist'), album: v('album') }
    }).filter(q => q.title),
    layout: layouts[i] ?? '',
  }))
}

/** A library's default group, as a <select> for its row under Libraries. */
export function libraryGroupSelect(groups: LyricsGroup[], path: string, current: string): string {
  return `<select data-lyrics-path="${esc(path)}" aria-label="Group">
    ${groups.map(g => `<option value="${g.id === 'standard' ? '' : esc(g.id)}" ${(current || 'standard') === g.id ? 'selected' : ''}>${esc(g.name)}</option>`).join('')}
  </select>`
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
      <div class="modal-title">Group for ${n}</div>
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
