// Merge albums: the selection's tracks become one album. Pick the target
// album (its folder is where files move; its tags pre-fill the fields), the
// disc order, and whether to renumber discs / move files. The server plans
// and previews; Apply stages it all as one step (backend: /api/tags/merge-albums).
import { api, MergeAlbumsRequest, MergeGroup } from './api'
import { toast } from './toast'
import { esc, debounce } from './util'
import { editToast, errText, shortPath } from './staged'

export function openMergeAlbums(ids: number[], onDone: () => Promise<void>) {
  const overlay = document.createElement('div')
  overlay.className = 'fix-confirm-overlay'
  overlay.innerHTML = `
    <div class="fix-confirm-modal pr-modal" role="dialog" aria-label="Merge albums">
      <div class="fix-confirm-header">
        <span class="fix-confirm-title">Merge albums · ${ids.length.toLocaleString()} tracks</span>
        <button class="btn btn-ghost btn-icon fix-confirm-close" aria-label="Close">✕</button>
      </div>
      <div class="pr-controls">
        <div class="ma-fields">
          <label class="field-label">Album<input id="ma-album" type="text" autocomplete="off" /></label>
          <label class="field-label">Album artist<input id="ma-aa" type="text" autocomplete="off" /></label>
          <label class="field-label ma-year">Year<input id="ma-year" type="text" autocomplete="off" maxlength="4" /></label>
        </div>
        <div class="pr-options">
          <label class="pr-select">Discs
            <select id="ma-discs"><option value="keep">Keep disc numbers</option>
              <option value="per_album">Number by album (1, 2, … in this order)</option></select>
          </label>
          <label class="settings-toggle"><input id="ma-move" type="checkbox" /><span>Move files into the target album's folder</span></label>
        </div>
        <div id="ma-error" class="review-error" hidden></div>
      </div>
      <div class="pr-summary" id="ma-summary"></div>
      <div class="fix-confirm-body pr-body"><ol id="ma-groups" class="ma-groups"></ol>
        <div id="ma-clashes" class="ma-clashes"></div></div>
      <div class="fix-confirm-footer">
        <button class="btn btn-ghost" id="ma-cancel">Cancel</button>
        <button class="btn btn-primary" id="ma-apply" disabled>Stage merge</button>
      </div>
    </div>`
  document.body.appendChild(overlay)

  const $ = <T extends HTMLElement>(sel: string) => overlay.querySelector<T>(sel)!
  const albumEl = $<HTMLInputElement>('#ma-album'), aaEl = $<HTMLInputElement>('#ma-aa'), yearEl = $<HTMLInputElement>('#ma-year')
  const discsEl = $<HTMLSelectElement>('#ma-discs'), moveEl = $<HTMLInputElement>('#ma-move')
  const groupsEl = $('#ma-groups'), clashEl = $('#ma-clashes'), sumEl = $('#ma-summary')
  const errEl = $('#ma-error'), goBtn = $<HTMLButtonElement>('#ma-apply')
  let groups: MergeGroup[] = [], order: string[] = [], target: string | null = null
  let edited = false, token = 0

  const close = () => { overlay.remove(); document.removeEventListener('keydown', onKey) }
  const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') close() }
  document.addEventListener('keydown', onKey)
  overlay.addEventListener('click', e => { if (e.target === overlay) close() })
  $('.fix-confirm-close').addEventListener('click', close)
  $('#ma-cancel').addEventListener('click', close)

  const req = (preview: boolean): MergeAlbumsRequest => ({
    track_ids: ids, target, order, preview,
    album: albumEl.value, album_artist: aaEl.value, year: yearEl.value,
    discs: discsEl.value as 'keep' | 'per_album', move: moveEl.checked,
  })

  /** The target's own values fill the fields until the user types in them. */
  const prefill = () => {
    const t = groups.find(g => g.key === target)
    if (!t || edited) return
    albumEl.value = t.album; aaEl.value = t.album_artist; yearEl.value = t.year
  }

  const render = (r: { groups: MergeGroup[]; target: string; tracks: number; moves: number;
                       clashes: { id: number; filename: string; error: string }[] }) => {
    groups = r.groups; order = r.groups.map(g => g.key); target = r.target
    const perAlbum = discsEl.value === 'per_album'
    groupsEl.innerHTML = groups.map((g, i) => `
      <li class="ma-group${g.key === target ? ' ma-target' : ''}" data-key="${esc(g.key)}">
        <label class="ma-pick" title="Target: files move into its folder; its tags fill the fields">
          <input type="radio" name="ma-target" ${g.key === target ? 'checked' : ''} /></label>
        <div class="ma-info">
          <div class="ma-title">${esc(g.album || '(no album)')} <span class="ma-dim">· ${esc(g.album_artist || g.artists.join(', ') || '(no artist)')}${g.year ? ' · ' + esc(g.year) : ''}</span></div>
          <div class="ma-dim">${esc(shortPath(g.directory))} · ${g.tracks} track${g.tracks !== 1 ? 's' : ''}
            · disc${g.discs.length !== 1 ? 's' : ''} ${g.discs.join(', ')}${perAlbum ? ` → ${g.new_discs.join(', ')}` : ''}</div>
        </div>
        <div class="ma-move">
          <button type="button" class="btn btn-ghost btn-sm" data-dir="-1" ${i === 0 ? 'disabled' : ''} aria-label="Move up">↑</button>
          <button type="button" class="btn btn-ghost btn-sm" data-dir="1" ${i === groups.length - 1 ? 'disabled' : ''} aria-label="Move down">↓</button>
        </div>
      </li>`).join('')
    clashEl.innerHTML = r.clashes.length
      ? `<div class="pr-bad">Not moved (${r.clashes.length}) — tags still change:</div>` +
        r.clashes.slice(0, 50).map(c => `<div class="pr-msg">${esc(c.filename)}: ${esc(c.error)}</div>`).join('')
      : ''
    sumEl.innerHTML = [`<strong>${r.tracks.toLocaleString()}</strong> track${r.tracks !== 1 ? 's' : ''} change`,
      moveEl.checked ? `${r.moves.toLocaleString()} file${r.moves !== 1 ? 's' : ''} move` : '',
      r.clashes.length ? `<span class="pr-bad">${r.clashes.length} can't move</span>` : ''].filter(Boolean).join(' · ')
    goBtn.disabled = r.tracks === 0
    goBtn.textContent = `Stage merge (${r.tracks.toLocaleString()} tracks)`
  }

  const refresh = debounce(async () => {
    const t = ++token
    try {
      const r = await api.tags.mergeAlbums(req(true))
      if (t !== token) return
      errEl.hidden = true
      const first = !groups.length
      render(r)
      if (first) { prefill(); refresh() }   // fields now hold the target's values
    } catch (e) {
      if (t !== token) return
      errEl.textContent = errText(e); errEl.hidden = false; goBtn.disabled = true
    }
  }, 200)

  groupsEl.addEventListener('click', (e) => {
    const el = e.target as HTMLElement
    const li = el.closest<HTMLElement>('.ma-group')
    if (!li) return
    const key = li.dataset.key!
    const dir = el.closest<HTMLElement>('[data-dir]')?.dataset.dir
    if (dir) {
      const i = order.indexOf(key), j = i + Number(dir)
      ;[order[i], order[j]] = [order[j], order[i]]
    } else if (el.closest('.ma-pick')) {
      target = key; prefill()
    } else return
    refresh()
  })
  for (const el of [albumEl, aaEl, yearEl]) el.addEventListener('input', () => { edited = true; refresh() })
  for (const el of [discsEl, moveEl]) el.addEventListener('change', refresh)

  goBtn.addEventListener('click', async () => {
    goBtn.disabled = true
    try {
      const r = await api.tags.mergeAlbums(req(false))
      editToast(r, `merge of ${r.groups.length} albums (${r.tracks.toLocaleString()} tracks)`)
      close()
      await onDone()
    } catch (e) {
      toast(`Merge failed: ${errText(e)}`, 'error'); goBtn.disabled = false
    }
  })
  refresh()
}
