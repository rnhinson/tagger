// Album-level MusicBrainz match: search releases for the selection, pick
// one, review the proposed track-by-track pairing (reassign any row), choose
// the fields, and stage it as one step. Backend: /api/lookup/album/*.
import { api, MbCandidate, MbMatch, MbReleaseTrack } from './api'
import { toast } from './toast'
import { esc, fmtDuration } from './util'
import { editToast, errText } from './staged'
import { state } from './state'

const FIELDS: { key: string; label: string; on: boolean }[] = [
  { key: 'title', label: 'Title', on: true }, { key: 'artist', label: 'Artist', on: true },
  { key: 'album', label: 'Album', on: true }, { key: 'album_artist', label: 'Album artist', on: true },
  { key: 'year', label: 'Year', on: true }, { key: 'track_number', label: 'Track #', on: true },
  { key: 'disc_number', label: 'Disc #', on: true }, { key: 'mb', label: 'MusicBrainz IDs', on: true },
]
const MB_IDS = ['mb_track_id', 'mb_artist_id', 'mb_album_id', 'mb_album_artist_id']

export function openMbAlbum(ids: number[], onDone: () => Promise<void>) {
  const overlay = document.createElement('div')
  overlay.className = 'fix-confirm-overlay'
  overlay.innerHTML = `
    <div class="fix-confirm-modal pr-modal mb-modal" role="dialog" aria-label="Match album on MusicBrainz">
      <div class="fix-confirm-header">
        <span class="fix-confirm-title">Match album on MusicBrainz · ${ids.length.toLocaleString()} tracks</span>
        <button class="btn btn-ghost btn-icon fix-confirm-close" aria-label="Close">✕</button>
      </div>
      <div class="pr-controls">
        <form class="mb-search" id="mb-search">
          <label class="field-label">From<select id="mb-source" title="Where the album, artist and track titles come from">
            <option value="auto" selected>Tags, else folder names</option><option value="names">Folder names</option><option value="tags">Tags only</option></select></label>
          <label class="field-label">Album<span class="mb-q-row"><input id="mb-album" type="text" autocomplete="off" />
            <button type="button" class="btn btn-ghost btn-sm mb-q" data-by="album" title="Releases with this album title (and artist)">🔍</button></span></label>
          <label class="field-label">Artist<span class="mb-q-row"><input id="mb-artist" type="text" autocomplete="off" />
            <button type="button" class="btn btn-ghost btn-sm mb-q" data-by="artist" title="Releases by this artist">🔍</button></span></label>
          <label class="field-label">Track<span class="mb-q-row"><input id="mb-track" type="text" autocomplete="off" list="mb-track-list" />
            <button type="button" class="btn btn-ghost btn-sm mb-q" data-by="track" title="Releases that contain this track (by this artist)">🔍</button></span>
            <datalist id="mb-track-list"></datalist></label>
          <button type="submit" hidden></button>
        </form>
        <div id="mb-context" class="ma-dim mb-context"></div>
        <div id="mb-error" class="review-error" hidden></div>
      </div>
      <div class="fix-confirm-body pr-body">
        <div id="mb-candidates" class="mb-candidates">Searching…</div>
        <div id="mb-match" hidden>
          <div class="mb-release" id="mb-release"></div>
          <div class="pr-options mb-fields" id="mb-fields">
            ${FIELDS.map(f => `<label class="settings-toggle"><input type="checkbox" data-field="${f.key}" ${f.on ? 'checked' : ''} /><span>${f.label}</span></label>`).join('')}
            <label class="settings-toggle"><input type="checkbox" id="mb-orig" checked /><span>Original year</span></label>
            <label class="settings-toggle"><input type="checkbox" id="mb-cover" /><span>Cover art (written now)</span></label>
          </div>
          <table class="pr-table mb-table"><thead><tr><th class="pr-check"></th><th>Your track</th><th class="mb-link">Match</th><th>MusicBrainz track</th></tr></thead>
            <tbody id="mb-rows"></tbody></table>
          <div id="mb-unmatched" class="mb-unmatched"></div>
        </div>
      </div>
      <div class="fix-confirm-footer">
        <span class="pr-summary" id="mb-summary"></span>
        <button class="btn btn-ghost" id="mb-cancel">Cancel</button>
        <button class="btn btn-primary" id="mb-apply" disabled>Stage</button>
      </div>
    </div>`
  document.body.appendChild(overlay)

  const $ = <T extends HTMLElement>(sel: string) => overlay.querySelector<T>(sel)!
  const albumEl = $<HTMLInputElement>('#mb-album'), artistEl = $<HTMLInputElement>('#mb-artist')
  const trackEl = $<HTMLInputElement>('#mb-track'), contextEl = $('#mb-context')
  const sourceEl = $<HTMLSelectElement>('#mb-source')
  const candEl = $('#mb-candidates'), matchEl = $('#mb-match'), rowsEl = $('#mb-rows')
  const errEl = $('#mb-error'), sumEl = $('#mb-summary'), goBtn = $<HTMLButtonElement>('#mb-apply')
  let localCount = ids.length, match: MbMatch | null = null
  let cands: MbCandidate[] = [], openId: string | null = null, searchToken = 0
  const quality = new Map<string, { quality: number; matched: number; local: number }>()
  const chosen = new Map<number, string | null>()     // track id -> release track key
  const skip = new Set<number>()

  const close = () => { overlay.remove(); document.removeEventListener('keydown', onKey) }
  const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') close() }
  document.addEventListener('keydown', onKey)
  overlay.addEventListener('click', e => { if (e.target === overlay) close() })
  $('.fix-confirm-close').addEventListener('click', close)
  $('#mb-cancel').addEventListener('click', close)
  const fail = (e: unknown) => { errEl.textContent = errText(e); errEl.hidden = false }

  async function search(first = false, by: 'album' | 'artist' | 'track' = 'album') {
    const t = ++searchToken
    errEl.hidden = true; parkMatch(); openId = null; quality.clear()
    goBtn.disabled = true; sumEl.textContent = ''
    candEl.textContent = 'Searching MusicBrainz…'; contextEl.textContent = ''
    try {
      const r = await api.lookup.albumSearch(ids, first ? undefined : albumEl.value, first ? undefined : artistEl.value,
                                              by, by === 'track' ? trackEl.value : undefined,
                                              sourceEl.value as 'auto' | 'names' | 'tags')
      if (t !== searchToken) return
      albumEl.value = r.album ?? ''; artistEl.value = r.artist ?? ''; localCount = r.local_tracks
      contextEl.textContent = r.by === 'artist' ? `Releases by ${r.artist} — ranked by how well they fit your ${localCount} tracks`
        : r.by === 'track' ? `Releases containing “${r.track}”${r.artist ? ` by ${r.artist}` : ''} — ranked by fit`
        : `Releases named “${r.album}”${r.artist ? ` by ${r.artist}` : ''} — ranked by fit`
      cands = r.candidates
      renderCandidates()
      scoreAll(t)
    } catch (e) { candEl.textContent = ''; fail(e) }
  }

  /** Score the top candidates one at a time (MusicBrainz allows ~1 request/s), re-sorting as each lands. */
  async function scoreAll(t: number) {
    for (const c of cands.slice(0, 12)) {
      if (t !== searchToken) return
      try {
        const q = await api.lookup.albumScore(ids, c.mb_album_id)
        if (t !== searchToken) return
        quality.set(c.mb_album_id, q)
      } catch { quality.set(c.mb_album_id, { quality: -1, matched: 0, local: localCount }) }
      renderCandidates()
    }
  }

  const rank = (c: MbCandidate) => quality.get(c.mb_album_id)?.quality ?? -2

  function badge(c: MbCandidate): string {
    const q = quality.get(c.mb_album_id)
    if (!q) return cands.indexOf(c) < 12 ? '<span class="mb-score mb-none">scoring…</span>' : ''
    if (q.quality < 0) return '<span class="mb-score mb-bad">failed</span>'
    const cls = q.quality >= 0.75 ? 'mb-good' : q.quality >= 0.5 ? 'mb-ok' : 'mb-bad'
    return `<span class="mb-score ${cls}" title="Average match over your ${q.local} tracks">${Math.round(q.quality * 100)}% · ${q.matched}/${q.local} matched</span>`
  }

  function renderCandidates() {
    if (!cands.length) { candEl.innerHTML = '<div class="cleanup-none">No releases found — adjust the album or artist and search again.</div>'; return }
    parkMatch()
    // Best first; unscored keep MusicBrainz's order after the scored ones.
    // Ties (common: every edition fits a few tracks equally): the edition whose
    // track count is closest to yours, then MusicBrainz's order.
    const gap = (c: MbCandidate) => Math.abs((c.tracks ?? 999) - localCount)
    const sorted = [...cands].sort((a, b) => rank(b) - rank(a) || gap(a) - gap(b) || cands.indexOf(a) - cands.indexOf(b))
    candEl.innerHTML = sorted.map(c => `
      <div class="mb-cand-wrap${c.mb_album_id === openId ? ' mb-open' : ''}" data-id="${esc(c.mb_album_id)}">
        <button type="button" class="mb-cand${c.mb_album_id === openId ? ' mb-picked' : ''}" data-id="${esc(c.mb_album_id)}">
          <span class="mb-cand-title">${c.mb_album_id === openId ? '▾' : '▸'} ${esc(c.album)} <span class="ma-dim">· ${esc(c.artist ?? '')}</span>
            ${c.tagged ? '<span class="mb-badge">tagged</span>' : ''}</span>
          <span class="ma-dim">${[c.date, c.country, (c.formats ?? []).join(', '), c.type, c.discs && c.discs > 1 ? `${c.discs} discs` : '']
            .filter(Boolean).map(x => esc(String(x))).join(' · ')}</span>
          <span class="mb-cand-tracks">${badge(c)}<span class="${c.tracks === localCount ? 'mb-fit' : ''}">${c.tracks ?? '?'} tracks</span></span>
        </button>
        <div class="mb-cand-detail"></div>
      </div>`).join('')
    if (openId) candEl.querySelector(`.mb-cand-wrap[data-id="${CSS.escape(openId)}"] .mb-cand-detail`)?.appendChild(matchEl)
    matchEl.hidden = !openId || !match
  }

  /** Keep the match panel alive across list re-renders (it holds the field ticks). */
  function parkMatch() { if (matchEl.parentElement !== overlay.querySelector('.pr-body')) overlay.querySelector('.pr-body')!.appendChild(matchEl); matchEl.hidden = true }

  candEl.addEventListener('click', async (e) => {
    const b = (e.target as HTMLElement).closest<HTMLElement>('.mb-cand')
    if (!b) return
    const id = b.dataset.id!
    errEl.hidden = true
    if (openId === id) { openId = null; match = null; goBtn.disabled = true; sumEl.textContent = ''; renderCandidates(); return }
    openId = id; match = null; renderCandidates()
    const detail = candEl.querySelector(`.mb-cand-wrap[data-id="${CSS.escape(id)}"] .mb-cand-detail`)
    if (detail) detail.innerHTML = '<div class="cleanup-none">Matching track by track…</div>'
    try {
      const m = await api.lookup.albumMatch(ids, id)
      if (openId !== id) return
      match = m
      chosen.clear(); skip.clear()
      for (const it of m.items) chosen.set(it.id, it.key)
      renderCandidates()
      renderMatch()
    } catch (err) { fail(err); openId = null; renderCandidates() }
  })

  function renderMatch() {
    if (!match) return
    const m = match, rel = m.release
    $('#mb-release').innerHTML = `<strong>${esc(rel.album)}</strong> · ${esc(rel.album_artist ?? '')} ·
      ${esc(rel.date ?? '')}${rel.original_year && rel.original_year !== rel.year ? ` (original ${esc(rel.original_year)})` : ''} · ${m.release_tracks.length} tracks`
    const byKey = new Map(m.release_tracks.map(t => [t.key, t]))
    const counts = new Map<string, number>()
    for (const [id, k] of chosen) if (k && !skip.has(id)) counts.set(k, (counts.get(k) ?? 0) + 1)
    const opts = (sel: string | null) => `<option value="">— no match —</option>` + m.release_tracks.map(t =>
      `<option value="${esc(t.key)}" ${t.key === sel ? 'selected' : ''}>${m.release_tracks.some(x => x.disc > 1) ? `${t.disc}-` : ''}${t.position}. ${esc(t.title)} (${fmtDuration(t.duration ?? 0)})</option>`).join('')
    // Two sides, in the release's order: every release track gets a row (with
    // whichever of your tracks is paired to it, or none), then your tracks that
    // aren't paired to anything. Nothing on either side is ever hidden.
    const num = (t: MbReleaseTrack) => `${m.release_tracks.some(x => x.disc > 1) ? `${t.disc}-` : ''}${t.position}`
    const yours = (it: MbMatch['items'][number]) => `
      <div class="mb-side-title">${esc([it.disc_number && it.disc_number !== '1' ? it.disc_number + '-' : '', it.track_number ?? ''].join(''))} ${esc(it.title || '(no title)')}
        ${it.title ? `<button type="button" class="mb-q-inline" data-find-track="${esc(it.title)}" title="Find releases containing this track">🔍</button>` : ''}</div>
      <div class="ma-dim">${esc(it.artist ?? '')}${it.artist ? ' · ' : ''}${fmtDuration(it.duration ?? 0)} · ${esc(it.filename)}</div>`
    const theirs = (t: MbReleaseTrack) => `
      <div class="mb-side-title">${num(t)}. ${esc(t.title)}</div>
      <div class="ma-dim">${esc(t.artist ?? '')} · ${fmtDuration(t.duration ?? 0)}</div>`
    const badgeFor = (it: MbMatch['items'][number], k: string, dup: boolean) => {
      if (dup) return '<span class="mb-score mb-bad">used twice</span>'
      if (k !== it.key) return '<span class="mb-score">manual</span>'
      const sc = it.score
      const title = it.title_similarity != null ? ` title ${Math.round(it.title_similarity * 100)}%` : ''
      return `<span class="mb-score ${sc >= 0.75 ? 'mb-good' : sc >= 0.5 ? 'mb-ok' : 'mb-bad'}" title="Overall ${Math.round(sc * 100)}% —${title}">${Math.round(sc * 100)}%</span>`
    }
    const pickRelease = (it: MbMatch['items'][number], k: string | null) =>
      `<select data-id="${it.id}" class="mb-pick"><option value="">— no match —</option>${m.release_tracks.map(t =>
        `<option value="${esc(t.key)}" ${t.key === k ? 'selected' : ''}>${num(t)}. ${esc(t.title)} (${fmtDuration(t.duration ?? 0)})</option>`).join('')}</select>`
    const free = m.items.filter(it => !chosen.get(it.id))
    const pickYours = (t: MbReleaseTrack) => free.length
      ? `<select data-key="${esc(t.key)}" class="mb-pick"><option value="">— assign one of your tracks —</option>${free.map(it =>
          `<option value="${it.id}">${esc(it.track_number ?? '')} ${esc(it.title || it.filename)}</option>`).join('')}</select>` : ''
    const row = (it: MbMatch['items'][number] | null, t: MbReleaseTrack | null) => {
      const k = it ? chosen.get(it.id) ?? null : null
      const dup = !!(it && k && (counts.get(k) ?? 0) > 1 && !skip.has(it.id))
      const dur = it?.duration && t?.duration ? Math.abs(it.duration - t.duration) : null
      return `<tr class="pr-row${it && skip.has(it.id) ? ' pr-excluded' : ''}${dup ? ' mb-dup' : ''}${!it || !t ? ' mb-half' : ''}">
        <td class="pr-check">${it && t ? `<input type="checkbox" data-id="${it.id}" ${skip.has(it.id) ? '' : 'checked'} />` : ''}</td>
        <td class="mb-side">${it ? yours(it) : '<span class="mb-none-side">none of your tracks</span>'}</td>
        <td class="mb-link">${it && t ? badgeFor(it, t.key, dup) : '<span class="mb-score mb-none">—</span>'}</td>
        <td class="mb-side">${t ? theirs(t) : '<span class="mb-none-side">no match on this release</span>'}
          ${t && dur !== null && dur > 10 ? `<div class="pr-msg">length differs by ${Math.round(dur)}s</div>` : ''}
          <div class="mb-pick-row">${it ? pickRelease(it, k) : t ? pickYours(t) : ''}</div></td></tr>`
    }
    const rows: string[] = []
    for (const t of m.release_tracks) {
      const paired = m.items.filter(it => chosen.get(it.id) === t.key)
      if (paired.length) for (const it of paired) rows.push(row(it, t))
      else rows.push(row(null, t))
    }
    for (const it of free) rows.push(row(it, null))
    rowsEl.innerHTML = rows.join('')
    const used = new Set([...chosen.values()].filter(Boolean))
    const left = m.release_tracks.filter(t => !used.has(t.key))
    $('#mb-unmatched').innerHTML = left.length ? `<span class="ma-dim">${left.length} release track${left.length !== 1 ? 's' : ''} without one of yours · ${free.length} of yours without a match</span>` : ''
    const n = m.items.filter(it => chosen.get(it.id) && !skip.has(it.id)).length
    const dups = [...counts.values()].some(c => c > 1)
    sumEl.innerHTML = dups ? '<span class="pr-bad">Two tracks point at the same release track</span>' : `${n} of ${m.items.length} tracks`
    goBtn.disabled = !n || dups
    goBtn.textContent = `Stage ${n} track${n !== 1 ? 's' : ''}`
  }

  rowsEl.addEventListener('change', (e) => {
    const el = e.target as HTMLInputElement | HTMLSelectElement
    const id = Number(el.dataset.id)
    if (el instanceof HTMLSelectElement && el.dataset.key) { if (el.value) chosen.set(Number(el.value), el.dataset.key) }
    else if (el instanceof HTMLSelectElement) chosen.set(id, el.value || null)
    else if (el.checked) skip.delete(id); else skip.add(id)
    renderMatch()
  })

  goBtn.addEventListener('click', async () => {
    if (!match) return
    const fields: string[] = []
    overlay.querySelectorAll<HTMLInputElement>('#mb-fields input[data-field]').forEach(cb => {
      if (!cb.checked) return
      if (cb.dataset.field === 'mb') fields.push(...MB_IDS); else fields.push(cb.dataset.field!)
    })
    const pairs: Record<number, string> = {}
    for (const [id, k] of chosen) if (k && !skip.has(id)) pairs[id] = k
    goBtn.disabled = true
    try {
      const r = await api.lookup.albumApply({
        mb_album_id: match.release.mb_album_id, pairs, fields,
        original_year: $<HTMLInputElement>('#mb-orig').checked, cover: $<HTMLInputElement>('#mb-cover').checked,
      })
      editToast(r, `MusicBrainz tags on ${r.changed} track${r.changed !== 1 ? 's' : ''}${r.covers ? ` (cover art on ${r.covers})` : ''}`)
      close()
      await onDone()
    } catch (e) { toast(`Failed: ${errText(e)}`, 'error'); goBtn.disabled = false }
  })

  $<HTMLFormElement>('#mb-search').addEventListener('submit', (e) => {
    e.preventDefault()
    search(false, document.activeElement === trackEl ? 'track' : document.activeElement === artistEl && !albumEl.value ? 'artist' : 'album')
  })
  sourceEl.addEventListener('change', () => { fillTitles(); search(true) })
  overlay.querySelectorAll<HTMLButtonElement>('.mb-q').forEach(b =>
    b.addEventListener('click', () => search(false, b.dataset.by as 'album' | 'artist' | 'track')))
  overlay.addEventListener('click', (e) => {
    const b = (e.target as HTMLElement).closest<HTMLElement>('[data-find-track]')
    if (!b) return
    e.stopPropagation()
    trackEl.value = b.dataset.findTrack!
    search(false, 'track')
  })
  // Track field: your selection's titles (or file names) to pick from.
  function fillTitles() {
    const sel = state.tracks.filter(t => ids.includes(t.id))
    const fromName = (t: { filename: string }) => t.filename.replace(/\.[^.]+$/, '').replace(/^\s*(\d+[\s.\-_]*)+/, '').replace(/[\s_]+/g, ' ').trim()
    const placeholder = (s?: string | null) => !s || /^(unknown( (artist|album|title|track))?|untitled|(audio ?)?track ?\d+)$/i.test(s.replace(/[\s_]+/g, ' ').trim())
    const titles = [...new Set(sel.map(t => sourceEl.value === 'names' || (sourceEl.value === 'auto' && placeholder(t.title))
      ? fromName(t) : t.title).filter(t => !placeholder(t)) as string[])]
    $('#mb-track-list').innerHTML = titles.map(t => `<option value="${esc(t)}"></option>`).join('')
    trackEl.value = titles[0] ?? ''
  }
  fillTitles()
  search(true)
}
