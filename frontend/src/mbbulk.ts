// Match albums: more than one album folder selected. Each folder gets its best
// MusicBrainz release (searched by its tags, else its folder names; the top
// few scored track by track) and the album-level tags it would get are listed
// for approval. Review… opens the full Match album for one folder (titles,
// numbers, pairing). Staged per album, like any edit. Backend: /api/lookup/album/*.
import { api, CoverAlbum, MbMatch } from './api'
import { toast } from './toast'
import { esc } from './util'
import { errText, shortPath } from './staged'
import { openMbAlbum, KEEP } from './mbalbum'

const TRIES = 4           // candidates scored per album
const GOOD = 0.8          // share of your tracks paired with the release (titles agree) at or above: ticked

const FIELDS: { key: string; label: string }[] = [
  { key: 'album', label: 'Album' }, { key: 'album_artist', label: 'Album artist' }, { key: 'year', label: 'Year' },
  { key: 'genre', label: 'Genre' }, { key: 'composer', label: 'Composer' }, { key: 'mb', label: 'MusicBrainz IDs' },
]
const MB_IDS = ['mb_track_id', 'mb_artist_id', 'mb_album_id', 'mb_album_artist_id']

interface Row {
  a: CoverAlbum
  status: 'waiting' | 'searching' | 'found' | 'none' | 'error' | 'staged'
  match: MbMatch | null
  quality: number
  paired: number           // share of the folder's tracks paired with a release track
  on: boolean
  off: Set<string>         // tags left out for this album (the switches above still apply to all)
  note: string
}

export function openMbAlbums(albums: CoverAlbum[], onDone: () => Promise<void>) {
  const rows: Row[] = albums.map(a => ({ a, status: 'waiting', match: null, quality: 0, paired: 0, on: false, off: new Set(), note: '' }))
  let closed = false, busy = false, staged = false
  const overlay = document.createElement('div')
  overlay.className = 'fix-confirm-overlay'
  overlay.innerHTML = `
    <div class="fix-confirm-modal bc-modal mbb-modal" role="dialog" aria-label="Match albums on MusicBrainz">
      <div class="fix-confirm-header">
        <span class="fix-confirm-title">Match albums on MusicBrainz · ${albums.length} albums</span>
        <button class="btn btn-ghost btn-icon fix-confirm-close" aria-label="Close">✕</button>
      </div>
      <div class="pr-options mbb-fields" id="mbb-fields">
        ${FIELDS.map(f => `<label class="settings-toggle"><input type="checkbox" data-field="${f.key}" checked /><span>${f.label}</span></label>`).join('')}
        <label class="settings-toggle"><input type="checkbox" id="mbb-orig" checked /><span>Original year</span></label>
        <label class="settings-toggle" title="Off: replace the genre and composer tracks already have"><input type="checkbox" id="mbb-keep" checked /><span>Keep existing genre &amp; composer</span></label>
      </div>
      <div class="bc-body"><table class="track-table bc-table mbb-table"><thead><tr>
        <th class="bc-check"><input type="checkbox" id="mbb-all" title="All found matches" /></th><th>Now</th><th>MusicBrainz</th><th></th>
      </tr></thead><tbody></tbody></table></div>
      <div class="settings-hint bc-where">Click a tag to leave it out for that album. Album-level tags only (composer goes to the tracks that pair with the release); titles and track numbers: Review… one album.</div>
      <div class="fix-confirm-footer">
        <span id="mbb-sum" class="ma-dim bc-sum"></span>
        <button class="btn btn-ghost" id="mbb-cancel">Cancel</button>
        <button class="btn btn-primary" id="mbb-go" disabled>Stage</button>
      </div>
    </div>`
  document.body.appendChild(overlay)
  const $ = <T extends HTMLElement>(sel: string) => overlay.querySelector<T>(sel)!
  const tbody = $('tbody'), goBtn = $<HTMLButtonElement>('#mbb-go'), sumEl = $('#mbb-sum'), allEl = $<HTMLInputElement>('#mbb-all')
  const origEl = $<HTMLInputElement>('#mbb-orig')
  const fieldOn = (f: string) => overlay.querySelector<HTMLInputElement>(`#mbb-fields input[data-field="${f}"]`)!.checked

  const close = async () => {
    if (busy) return
    closed = true
    overlay.remove(); document.removeEventListener('keydown', onKey)
    if (staged) await onDone()
  }
  // Escape closes the topmost dialog only (Review… sits above this one).
  const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && document.body.lastElementChild === overlay) close() }
  document.addEventListener('keydown', onKey)
  overlay.addEventListener('click', e => { if (e.target === overlay) close() })
  $('.fix-confirm-close').addEventListener('click', close)
  $('#mbb-cancel').addEventListener('click', close)

  const usable = (r: Row) => !!r.match && r.status === 'found'

  function renderRow(i: number) {
    const r = rows[i], a = r.a, m = r.match
    const tr = tbody.querySelector<HTMLElement>(`tr[data-i="${i}"]`) ?? tbody.appendChild(document.createElement('tr'))
    tr.dataset.i = String(i)
    const cur = m?.current ?? { album: a.album, album_artist: a.artist, year: null, genre: null }
    const now = [cur.album || '(no album)', cur.album_artist, cur.year, cur.genre].filter(Boolean)
    let theirs = ''
    if (m) {
      const rel = m.release
      const year = (origEl.checked ? rel.original_year : null) || rel.year
      // Each tag is a chip: click to leave it out for this album. A value that
      // would change is highlighted (genre: only where the tracks have none, when kept).
      const keeping = $<HTMLInputElement>('#mbb-keep').checked
      const chip = (f: string, v: string | null | undefined, had: string | null | undefined, title: string) => {
        if (!v) return ''
        const kept = keeping && (f === 'genre' && had)
        const off = !fieldOn(f) || r.off.has(f)
        const cls = off || kept ? 'mbb-off' : had !== undefined && v === had ? '' : 'mbb-new'
        const why = !fieldOn(f) ? 'Off for every album (the switches above)' : kept ? 'Kept: the tracks already have one'
          : `${title} — click to ${r.off.has(f) ? 'include it' : 'leave it out'} for this album`
        return `<button type="button" class="mbb-chip ${cls}" data-chip="${f}" title="${esc(why)}" ${fieldOn(f) && !busy ? '' : 'disabled'}>${esc(v)}</button>`
      }
      const paired = m.items.filter(it => it.key)
      const writers = new Set(paired.map(it => m.release_tracks.find(t => t.key === it.key)?.composer).filter(Boolean))
      const matched = paired.length
      theirs = `<div class="mbb-chips">${[chip('album', rel.album, cur.album, 'Album'), chip('album_artist', rel.album_artist, cur.album_artist, 'Album artist'),
                        chip('year', year, cur.year, 'Year'), chip('genre', rel.genre, cur.genre, 'Genre') || '<span class="ma-dim">no genre</span>',
                        chip('composer', writers.size ? `✎ ${[...writers].slice(0, 2).join(', ')}${writers.size > 2 ? ` +${writers.size - 2}` : ''}` : '', undefined, 'Composers of the paired tracks'),
                        chip('mb', 'MB IDs', undefined, 'MusicBrainz IDs')]
                       .filter(Boolean).join('')}</div>
        <div class="ma-dim bc-folder">${[rel.date, rel.country, `${m.release_tracks.length} tracks`].filter(Boolean).map(x => esc(String(x))).join(' · ')}
          · <span class="mb-score ${r.paired >= GOOD ? 'mb-good' : r.paired >= 0.5 ? 'mb-ok' : 'mb-bad'}" title="Your tracks whose title (or number and length) pairs with one of its tracks · overall fit ${Math.round(r.quality * 100)}%">${matched} of your ${m.items.length} tracks on it</span>
          ${r.paired < GOOD ? ' — weak match, check it' : ''}</div>`
    }
    const status = {
      waiting: '<span class="ma-dim">Waiting…</span>', searching: '<span class="ma-dim">Searching…</span>',
      none: '<span class="ma-dim">No release found — Review… to search by hand</span>',
      error: `<span class="review-error">${esc(r.note)}</span>`, found: '', staged: '',
    }[r.status]
    tr.innerHTML = `
      <td class="bc-check"><input type="checkbox" ${r.on ? 'checked' : ''} ${usable(r) ? '' : 'disabled'} /></td>
      <td class="bc-album"><div>${now.map(x => esc(String(x))).join(' · ')}</div>
        <div class="ma-dim bc-folder" title="${esc(a.directory)}">${esc(shortPath(a.directory))} · ${a.track_ids.length} track${a.track_ids.length !== 1 ? 's' : ''}</div></td>
      <td class="bc-album">${theirs}${status ? `<div>${status}</div>` : ''}${r.status === 'staged' ? `<div class="bc-done">✓ ${esc(r.note || 'Staged')}</div>` : ''}</td>
      <td><button type="button" class="btn btn-ghost btn-sm" data-review ${r.status === 'staged' || busy ? 'disabled' : ''}>Review…</button></td>`
  }
  function summary() {
    const n = rows.filter(r => r.on && usable(r) && FIELDS.some(f => fieldOn(f.key) && !r.off.has(f.key))).length
    const pending = rows.filter(r => r.status === 'waiting' || r.status === 'searching').length
    sumEl.textContent = (pending ? `Searching… ${rows.length - pending} of ${rows.length} done · ` : '') + `${n} album${n !== 1 ? 's' : ''} to stage`
    const anyField = FIELDS.some(f => fieldOn(f.key))
    goBtn.disabled = busy || !n || !anyField
    goBtn.textContent = n ? `Stage ${n} album${n !== 1 ? 's' : ''}` : 'Stage'
    const can = rows.filter(usable)
    allEl.checked = can.length > 0 && can.every(r => r.on)
    allEl.indeterminate = !allEl.checked && can.some(r => r.on)
  }
  const renderAll = () => { rows.forEach((_, i) => renderRow(i)); summary() }
  renderAll()

  $('#mbb-fields').addEventListener('change', renderAll)
  tbody.addEventListener('change', e => {
    const cb = e.target as HTMLInputElement
    rows[Number(cb.closest<HTMLElement>('tr')!.dataset.i)].on = cb.checked
    summary()
  })
  allEl.addEventListener('change', () => {
    rows.forEach(r => { if (usable(r)) r.on = allEl.checked })
    renderAll()
  })
  tbody.addEventListener('click', e => {
    const c = (e.target as HTMLElement).closest<HTMLElement>('[data-chip]')
    if (c) {
      const i = Number(c.closest<HTMLElement>('tr')!.dataset.i), f = c.dataset.chip!
      if (!rows[i].off.delete(f)) rows[i].off.add(f)
      renderRow(i); summary()
      return
    }
    const b = (e.target as HTMLElement).closest<HTMLElement>('[data-review]')
    if (!b) return
    const i = Number(b.closest<HTMLElement>('tr')!.dataset.i), r = rows[i]
    openMbAlbum(r.a.track_ids, async () => {
      Object.assign(r, { status: 'staged', on: false, note: 'Staged from Review' })
      staged = true
      renderRow(i); summary()
    })
  })

  // The best of the first few candidates, scored track by track; stop early on a near-perfect one.
  async function find(r: Row) {
    const s = await api.lookup.albumSearch(r.a.track_ids)
    let best: { id: string; quality: number } | null = null, failed: unknown = null
    for (const c of s.candidates.slice(0, TRIES)) {
      if (closed) return
      let q
      try { q = await api.lookup.albumScore(r.a.track_ids, c.mb_album_id) } catch (e) { failed = e; continue }   // try the next one
      if (!best || q.quality > best.quality) best = { id: c.mb_album_id, quality: q.quality }
      if (q.quality >= 0.9) break
    }
    if (!best && failed) throw failed
    if (!best || closed) { r.status = 'none'; return }
    const m = r.match = await api.lookup.albumMatch(r.a.track_ids, best.id)
    const paired = m.items.length ? m.items.filter(it => it.key).length / m.items.length : 0
    Object.assign(r, { quality: best.quality, paired, status: 'found', on: paired >= GOOD })
  }

  ;(async () => {
    // Two at a time: MusicBrainz is throttled server side, one request a second.
    let next = 0
    const worker = async () => {
      while (!closed && next < rows.length) {
        const i = next++, r = rows[i]
        if (r.status === 'staged') continue
        r.status = 'searching'; renderRow(i); summary()
        try { await find(r) } catch (e) { r.status = 'error'; r.note = errText(e) }
        if (closed) return
        renderRow(i); summary()
      }
    }
    await Promise.all([worker(), worker()])
  })()

  goBtn.addEventListener('click', async () => {
    const fieldsFor = (r: Row) => FIELDS.filter(f => fieldOn(f.key) && !r.off.has(f.key))
      .flatMap(f => f.key === 'mb' ? MB_IDS : [f.key])
    busy = true; renderAll()
    let albumsDone = 0, tracks = 0, failed = 0, direct = false
    for (const [i, r] of rows.entries()) {
      if (!r.on || !usable(r)) continue
      const fields = fieldsFor(r)
      if (!fields.length) continue
      const m = r.match!
      sumEl.textContent = `Staging ${m.release.album}…`
      const pairs: Record<number, string> = {}
      for (const it of m.items) if (it.key) pairs[it.id] = it.key
      try {
        const res = await api.lookup.albumApply({
          mb_album_id: m.release.mb_album_id, pairs, fields, original_year: origEl.checked, cover: false,
          keep: $<HTMLInputElement>('#mbb-keep').checked ? KEEP : [],
          unpaired: m.items.filter(it => !it.key).map(it => it.id),
        })
        tracks += res.changed; albumsDone++
        direct ||= res.changed > 0 && !res.staged     // staging off in Settings: written now
        Object.assign(r, { status: 'staged', on: false, note: res.changed ? `${res.staged ? 'Staged' : 'Written to'} ${res.changed} track${res.changed !== 1 ? 's' : ''}` : 'Already matches' })
      } catch (e) { failed++; r.status = 'error'; r.note = errText(e) }
      staged = true
      renderRow(i)
    }
    busy = false; renderAll()
    if (albumsDone) toast(`MusicBrainz tags ${direct ? 'written to' : 'staged on'} ${tracks} track${tracks !== 1 ? 's' : ''} in ${albumsDone} album${albumsDone !== 1 ? 's' : ''}${direct ? '' : ' — Review to write them'}${failed ? ` · ${failed} failed` : ''}`, failed ? 'error' : 'success')
    else if (failed) toast(`Match albums: ${failed} failed`, 'error')
    if (!failed) close()
  })
}
