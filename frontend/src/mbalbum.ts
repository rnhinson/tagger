// Album-level MusicBrainz match: search releases for the selection, pick
// one, review the proposed track-by-track pairing (reassign any row), choose
// the fields, and stage it as one step. Backend: /api/lookup/album/*.
import { api, MbCandidate, MbMatch } from './api'
import { toast } from './toast'
import { esc, fmtDuration } from './util'
import { editToast, errText } from './staged'

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
          <label class="field-label">Album<input id="mb-album" type="text" autocomplete="off" /></label>
          <label class="field-label">Artist<input id="mb-artist" type="text" autocomplete="off" /></label>
          <button class="btn btn-ghost" type="submit">Search</button>
        </form>
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
          <table class="pr-table mb-table"><thead><tr><th class="pr-check"></th><th>Your track</th><th>MusicBrainz track</th><th>Match</th></tr></thead>
            <tbody id="mb-rows"></tbody></table>
          <div id="mb-unmatched" class="mb-unmatched"></div>
        </div>
      </div>
      <div class="fix-confirm-footer">
        <button class="btn btn-ghost" id="mb-back" hidden>← Other releases</button>
        <span class="pr-summary" id="mb-summary"></span>
        <button class="btn btn-ghost" id="mb-cancel">Cancel</button>
        <button class="btn btn-primary" id="mb-apply" disabled>Stage</button>
      </div>
    </div>`
  document.body.appendChild(overlay)

  const $ = <T extends HTMLElement>(sel: string) => overlay.querySelector<T>(sel)!
  const albumEl = $<HTMLInputElement>('#mb-album'), artistEl = $<HTMLInputElement>('#mb-artist')
  const candEl = $('#mb-candidates'), matchEl = $('#mb-match'), rowsEl = $('#mb-rows')
  const errEl = $('#mb-error'), sumEl = $('#mb-summary'), goBtn = $<HTMLButtonElement>('#mb-apply'), backBtn = $('#mb-back')
  let localCount = ids.length, match: MbMatch | null = null
  const chosen = new Map<number, string | null>()     // track id -> release track key
  const skip = new Set<number>()

  const close = () => { overlay.remove(); document.removeEventListener('keydown', onKey) }
  const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') close() }
  document.addEventListener('keydown', onKey)
  overlay.addEventListener('click', e => { if (e.target === overlay) close() })
  $('.fix-confirm-close').addEventListener('click', close)
  $('#mb-cancel').addEventListener('click', close)
  const fail = (e: unknown) => { errEl.textContent = errText(e); errEl.hidden = false }

  async function search(first = false) {
    errEl.hidden = true; candEl.hidden = false; matchEl.hidden = true; backBtn.hidden = true
    goBtn.disabled = true; sumEl.textContent = ''
    candEl.textContent = 'Searching MusicBrainz…'
    try {
      const r = await api.lookup.albumSearch(ids, first ? undefined : albumEl.value, first ? undefined : artistEl.value)
      albumEl.value = r.album ?? ''; artistEl.value = r.artist ?? ''; localCount = r.local_tracks
      renderCandidates(r.candidates)
    } catch (e) { candEl.textContent = ''; fail(e) }
  }

  function renderCandidates(cands: MbCandidate[]) {
    if (!cands.length) { candEl.innerHTML = '<div class="cleanup-none">No releases found — adjust the album or artist and search again.</div>'; return }
    candEl.innerHTML = cands.map(c => `
      <button type="button" class="mb-cand" data-id="${esc(c.mb_album_id)}">
        <span class="mb-cand-title">${esc(c.album)} <span class="ma-dim">· ${esc(c.artist ?? '')}</span>
          ${c.tagged ? '<span class="mb-badge">tagged</span>' : ''}</span>
        <span class="ma-dim">${[c.date, c.country, (c.formats ?? []).join(', '), c.type, c.discs && c.discs > 1 ? `${c.discs} discs` : '']
          .filter(Boolean).map(x => esc(String(x))).join(' · ')}</span>
        <span class="mb-cand-tracks ${c.tracks === localCount ? 'mb-fit' : ''}">${c.tracks ?? '?'} tracks${c.tracks === localCount ? ' ✓' : ''}</span>
      </button>`).join('')
  }

  candEl.addEventListener('click', async (e) => {
    const b = (e.target as HTMLElement).closest<HTMLElement>('.mb-cand')
    if (!b) return
    candEl.querySelectorAll('.mb-cand').forEach(x => x.classList.toggle('mb-picked', x === b))
    errEl.hidden = true
    try {
      match = await api.lookup.albumMatch(ids, b.dataset.id!)
      chosen.clear(); skip.clear()
      for (const it of match.items) chosen.set(it.id, it.key)
      candEl.hidden = true; matchEl.hidden = false; backBtn.hidden = false
      renderMatch()
    } catch (err) { fail(err) }
  })
  backBtn.addEventListener('click', () => { candEl.hidden = false; matchEl.hidden = true; backBtn.hidden = true; goBtn.disabled = true; sumEl.textContent = '' })

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
    rowsEl.innerHTML = m.items.map(it => {
      const k = chosen.get(it.id) ?? null, t = k ? byKey.get(k) : undefined
      const dup = k && (counts.get(k) ?? 0) > 1 && !skip.has(it.id)
      const proposed = k === it.key
      const sc = proposed ? it.score : null
      const badge = !k ? '<span class="mb-score mb-none">none</span>'
        : dup ? '<span class="mb-score mb-bad">used twice</span>'
        : sc === null ? '<span class="mb-score">manual</span>'
        : `<span class="mb-score ${sc >= 0.75 ? 'mb-good' : sc >= 0.5 ? 'mb-ok' : 'mb-bad'}">${Math.round(sc * 100)}%</span>`
      const dur = it.duration && t?.duration ? Math.abs(it.duration - t.duration) : null
      return `<tr class="pr-row${skip.has(it.id) ? ' pr-excluded' : ''}${dup ? ' mb-dup' : ''}">
        <td class="pr-check"><input type="checkbox" data-id="${it.id}" ${skip.has(it.id) || !k ? '' : 'checked'} ${k ? '' : 'disabled'} /></td>
        <td><div>${esc([it.disc_number && it.disc_number !== '1' ? it.disc_number + '-' : '', it.track_number ?? ''].join(''))} ${esc(it.title || it.filename)}</div>
          <div class="ma-dim">${esc(it.filename)} · ${fmtDuration(it.duration ?? 0)}</div></td>
        <td><select data-id="${it.id}" class="mb-pick">${opts(k)}</select>
          ${t && dur !== null && dur > 10 ? `<div class="pr-msg">length differs by ${Math.round(dur)}s</div>` : ''}</td>
        <td>${badge}</td></tr>`
    }).join('')
    const used = new Set([...chosen.values()].filter(Boolean))
    const left = m.release_tracks.filter(t => !used.has(t.key))
    $('#mb-unmatched').innerHTML = left.length
      ? `<span class="ma-dim">Not matched on the release (${left.length}): ${left.slice(0, 12).map(t => esc(t.title)).join(', ')}${left.length > 12 ? '…' : ''}</span>` : ''
    const n = m.items.filter(it => chosen.get(it.id) && !skip.has(it.id)).length
    const dups = [...counts.values()].some(c => c > 1)
    sumEl.innerHTML = dups ? '<span class="pr-bad">Two tracks point at the same release track</span>' : `${n} of ${m.items.length} tracks`
    goBtn.disabled = !n || dups
    goBtn.textContent = `Stage ${n} track${n !== 1 ? 's' : ''}`
  }

  rowsEl.addEventListener('change', (e) => {
    const el = e.target as HTMLInputElement | HTMLSelectElement
    const id = Number(el.dataset.id)
    if (el instanceof HTMLSelectElement) chosen.set(id, el.value || null)
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

  $<HTMLFormElement>('#mb-search').addEventListener('submit', (e) => { e.preventDefault(); search() })
  search(true)
}
