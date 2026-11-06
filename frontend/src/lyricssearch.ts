// Search LRCLIB by hand for one track: start from its lyrics group's queries
// (or type your own, or free text), see every hit with its album, length and
// whether it's synced, read it, then use the synced or plain text.
// With onChosen the text goes back to the caller (the Lyrics… batch);
// otherwise it's staged on the track.
import { api, LyricsHit, LyricsPlan } from './api'
import { toast } from './toast'
import { esc, fmtDuration } from './util'
import { editToast, errText } from './staged'

export async function openLyricsSearch(trackId: number, onChosen?: (text: string) => void, onDone?: () => Promise<void>) {
  let plan: LyricsPlan
  try { plan = await api.lyrics.plan(trackId) } catch (e) { toast(`Failed: ${errText(e)}`, 'error'); return }
  const t = plan.track
  const first = plan.queries[0] ?? { title: t.title ?? '', artist: t.artist ?? '', album: '' }
  const overlay = document.createElement('div')
  overlay.className = 'fix-confirm-overlay'
  overlay.innerHTML = `
    <div class="fix-confirm-modal pr-modal" role="dialog" aria-label="Search lyrics">
      <div class="fix-confirm-header">
        <span class="fix-confirm-title">Search lyrics · ${esc(t.title ?? '')} <span class="ma-dim">· ${esc(t.artist ?? '')} · ${esc(t.album ?? '')} · ${fmtDuration(t.duration)}</span></span>
        <button class="btn btn-ghost btn-icon fix-confirm-close" aria-label="Close">✕</button>
      </div>
      <div class="pr-controls">
        <div class="ma-dim">Group: <strong>${esc(plan.group.name)}</strong>${plan.last ? ` · last lookup: ${esc(plan.last.status)} (${new Date(plan.last.at * 1000).toLocaleDateString()})` : ''}
          ${plan.queries.length ? ` · its queries: ${plan.queries.map((q, i) => `<button type="button" class="btn btn-link btn-sm" data-use-query="${i}">${esc([q.title, q.artist || '(any artist)', q.album].filter(Boolean).join(' · '))}</button>`).join(' ')}` : ''}</div>
        <div class="ls-fields">
          <label class="field-label">Title<input id="ls-title" type="text" value="${esc(first.title)}" /></label>
          <label class="field-label">Artist<input id="ls-artist" type="text" value="${esc(first.artist)}" placeholder="blank: any" /></label>
          <label class="field-label">Album<input id="ls-album" type="text" value="${esc(first.album)}" placeholder="blank: any" /></label>
          <label class="field-label">Free text<input id="ls-q" type="text" placeholder="instead of / as well as the fields" /></label>
          <button class="btn btn-primary btn-sm" id="ls-go">Search</button>
        </div>
        <div id="ls-error" class="review-error" hidden></div>
      </div>
      <div class="pr-summary" id="ls-summary"></div>
      <div class="fix-confirm-body pr-body ls-body">
        <table class="pr-table"><thead><tr><th>Title</th><th>Artist</th><th>Album</th><th>Length</th><th>Lyrics</th></tr></thead>
          <tbody id="ls-rows"></tbody></table>
        <div id="ls-preview" class="ls-preview" hidden></div>
      </div>
      <div class="fix-confirm-footer">
        <button class="btn btn-ghost" id="ls-cancel">Cancel</button>
        <button class="btn btn-ghost" id="ls-plain" disabled>Use plain</button>
        <button class="btn btn-primary" id="ls-synced" disabled>Use synced</button>
      </div>
    </div>`
  document.body.appendChild(overlay)

  const $ = <T extends HTMLElement>(sel: string) => overlay.querySelector<T>(sel)!
  const input = (id: string) => $<HTMLInputElement>(id)
  let hits: LyricsHit[] = []
  let picked: LyricsHit | null = null

  // Capture + stop: Esc closes this dialog, not the Lyrics… one underneath.
  const close = () => { overlay.remove(); document.removeEventListener('keydown', onKey, true) }
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') { e.stopPropagation(); close() }
    else if (e.key === 'Enter' && (e.target as HTMLElement).closest('.ls-fields')) { e.preventDefault(); go() }
  }
  document.addEventListener('keydown', onKey, true)
  overlay.addEventListener('click', e => { if (e.target === overlay) close() })
  $('.fix-confirm-close').addEventListener('click', close)
  $('#ls-cancel').addEventListener('click', close)

  const delta = (h: LyricsHit) => t.duration && h.duration ? Math.round(h.duration - t.duration) : null
  const render = () => {
    $('#ls-rows').innerHTML = hits.map((h, i) => {
      const d = delta(h)
      const kind = h.synced ? '<span class="mb-score mb-good">synced</span>' : h.plain ? '<span class="mb-score mb-ok">plain</span>'
        : h.instrumental ? '<span class="mb-score mb-none">instrumental</span>' : '<span class="mb-score mb-none">none</span>'
      return `<tr class="pr-row ls-hit${picked === h ? ' ls-picked' : ''}" data-hit="${i}">
        <td>${esc(h.title ?? '')}</td><td>${esc(h.artist ?? '')}</td><td>${esc(h.album ?? '')}</td>
        <td>${fmtDuration(h.duration)}${d !== null ? ` <span class="${Math.abs(d) > 3 ? 'ls-off' : 'ma-dim'}">(${d > 0 ? '+' : ''}${d}s)</span>` : ''}</td>
        <td>${kind}</td></tr>`
    }).join('')
    const pv = $('#ls-preview')
    pv.hidden = !picked
    if (picked) pv.innerHTML = `<pre>${esc(picked.synced ?? picked.plain ?? '(no text)')}</pre>`
    $<HTMLButtonElement>('#ls-synced').disabled = !picked?.synced
    $<HTMLButtonElement>('#ls-plain').disabled = !picked?.plain
  }

  async function go() {
    const q = { title: input('#ls-title').value, artist: input('#ls-artist').value, album: input('#ls-album').value, q: input('#ls-q').value }
    $('#ls-error').hidden = true
    $('#ls-summary').textContent = 'Searching LRCLIB…'
    try {
      hits = (await api.lyrics.search(q)).hits
      // Closest length first: the same recording, most likely.
      hits.sort((a, b) => Math.abs(delta(a) ?? 999) - Math.abs(delta(b) ?? 999))
      picked = null
      $('#ls-summary').textContent = hits.length ? `${hits.length} hit${hits.length !== 1 ? 's' : ''} — click one to read it` : 'No hits. Try fewer fields, or free text.'
      render()
    } catch (e) { $('#ls-summary').textContent = ''; $('#ls-error').textContent = errText(e); $('#ls-error').hidden = false }
  }

  overlay.addEventListener('click', (e) => {
    const tgt = e.target as HTMLElement
    const qb = tgt.closest<HTMLElement>('[data-use-query]')
    if (qb) {
      const q = plan.queries[Number(qb.dataset.useQuery)]
      input('#ls-title').value = q.title; input('#ls-artist').value = q.artist; input('#ls-album').value = q.album
      input('#ls-q').value = ''
      go()
      return
    }
    const row = tgt.closest<HTMLElement>('[data-hit]')
    if (row) { picked = hits[Number(row.dataset.hit)]; render() }
  })
  $('#ls-go').addEventListener('click', go)

  async function use(text: string | null) {
    if (!text) return
    if (onChosen) { onChosen(text); close(); return }
    try {
      const r = await api.lyrics.stage({ [trackId]: text })
      editToast(r, 'lyrics on 1 track')
      close()
      if (onDone) await onDone()
    } catch (e) { toast(`Failed: ${errText(e)}`, 'error') }
  }
  $('#ls-synced').addEventListener('click', () => use(picked?.synced ?? null))
  $('#ls-plain').addEventListener('click', () => use(picked?.plain ?? null))
  if (first.title) go()
}
