// Duplicate tracks, reviewed: each group with its suggested keeper (lossless,
// then bitrate, sample rate, size) picked; change the pick, untick a group to
// leave it alone, then remove the rest from the library or move their files
// to the trash. Both are undoable from History. Sound matching needs
// fingerprints, started from here. Backend: core/duplicates.py.
import { api, DuplicateGroup } from './api'
import { toast } from './toast'
import { esc, fmtBitrate, fmtDuration, fmtSampleRate } from './util'
import { errText, shortPath } from './staged'

const fmtSize = (b: number | null) => b ? `${(b / 1048576).toFixed(1)} MB` : ''

export async function openDuplicates(onDone: () => Promise<void>) {
  let groups: DuplicateGroup[], total: number
  let fp: { tracks: number; fingerprinted: number; available: boolean }
  try {
    [{ groups, total }, fp] = await Promise.all([api.library.duplicates(), api.library.fingerprints()])
  } catch (e) { toast(`Failed: ${errText(e)}`, 'error'); return }
  if (!groups.length) { toast('No duplicates found', 'info'); return }

  const keep = groups.map(g => g.tracks.find(t => !t.read_only)?.id ?? g.tracks[0].id)
  const skip = new Set<number>()      // group indexes left alone
  const overlay = document.createElement('div')
  overlay.className = 'fix-confirm-overlay'
  const fpLine = !fp.available ? 'Sound matching needs fpcalc.'
    : fp.fingerprinted < fp.tracks
      ? `Sound matching: ${fp.fingerprinted.toLocaleString()} of ${fp.tracks.toLocaleString()} tracks fingerprinted. <button type="button" class="btn btn-link btn-sm" id="dup-fp">Fingerprint the rest</button> <span class="ma-dim">(background; reopen this when it's done)</span>`
      : 'Sound matching: every track is fingerprinted.'
  overlay.innerHTML = `
    <div class="fix-confirm-modal pr-modal" role="dialog" aria-label="Duplicate tracks">
      <div class="fix-confirm-header">
        <span class="fix-confirm-title">Duplicate tracks · ${total.toLocaleString()} group${total !== 1 ? 's' : ''}${groups.length < total ? ` (first ${groups.length})` : ''}</span>
        <button class="btn btn-ghost btn-icon fix-confirm-close" aria-label="Close">✕</button>
      </div>
      <div class="pr-controls dup-controls">
        <div class="ma-dim">Same cleaned-up title and artist with lengths within 2 s, or the same sound. The suggested keeper is picked: lossless first, then bitrate, sample rate, size.</div>
        <div class="ma-dim">${fpLine}</div>
        <label class="pr-select">The others
          <select id="dup-mode"><option value="remove">Remove from the library (files stay; a rescan adds them back)</option><option value="trash">Move their files to the trash</option></select></label>
      </div>
      <div class="fix-confirm-body pr-body">
        <table class="pr-table dup-table"><thead><tr><th class="pr-check"></th><th>Keep</th><th>Track</th><th>Folder</th><th>Format</th><th>Length</th><th>Size</th></tr></thead>
          <tbody id="dup-rows"></tbody></table>
      </div>
      <div class="fix-confirm-footer">
        <button class="btn btn-ghost" id="dup-cancel">Cancel</button>
        <button class="btn btn-danger" id="dup-go"></button>
      </div>
    </div>`
  document.body.appendChild(overlay)
  const $ = <T extends HTMLElement>(sel: string) => overlay.querySelector<T>(sel)!
  const close = () => { overlay.remove(); document.removeEventListener('keydown', onKey) }
  const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') close() }
  document.addEventListener('keydown', onKey)
  overlay.addEventListener('click', e => { if (e.target === overlay) close() })
  $('.fix-confirm-close').addEventListener('click', close)
  $('#dup-cancel').addEventListener('click', close)

  const losers = () => groups.flatMap((g, i) => skip.has(i) ? [] : g.tracks.filter(t => t.id !== keep[i] && !t.read_only).map(t => t.id))
  const render = () => {
    $('#dup-rows').innerHTML = groups.map((g, i) => {
      const off = skip.has(i)
      const head = g.tracks[0]
      return `<tr class="pr-folder${off ? ' pr-excluded' : ''}"><td class="pr-check"><input type="checkbox" data-group="${i}" ${off ? '' : 'checked'} title="Untick to leave this group alone" /></td>
          <td colspan="6">${esc(head.title ?? '')} <span class="ma-dim">· ${esc(head.artist ?? '')} · ${g.tracks.length} copies</span></td></tr>
        ${g.tracks.map(t => {
          const kept = t.id === keep[i]
          const fate = off || kept ? '' : ' dup-loser'
          return `<tr class="dup-row${fate}">
            <td></td>
            <td><input type="radio" name="dup-${i}" data-keep="${i}:${t.id}" ${kept ? 'checked' : ''} ${off ? 'disabled' : ''} /></td>
            <td>${esc(t.title ?? '')} <span class="ma-dim">· ${esc(t.album ?? '')}</span>${t.read_only ? ' <span class="ma-dim">🔒 read-only</span>' : ''}</td>
            <td class="dup-path" title="${esc(t.path)}">${esc(shortPath(t.directory))}</td>
            <td>${esc(t.format.toUpperCase())} ${fmtBitrate(t.bitrate)} ${t.sample_rate ? `<span class="ma-dim">${fmtSampleRate(t.sample_rate)}</span>` : ''}</td>
            <td>${fmtDuration(t.duration)}</td><td>${fmtSize(t.size)}</td></tr>`
        }).join('')}`
    }).join('')
    const n = losers().length
    const btn = $<HTMLButtonElement>('#dup-go')
    btn.disabled = n === 0
    btn.textContent = $<HTMLSelectElement>('#dup-mode').value === 'trash'
      ? `Move ${n.toLocaleString()} file${n !== 1 ? 's' : ''} to trash` : `Remove ${n.toLocaleString()} from library`
  }

  $('#dup-rows').addEventListener('change', (e) => {
    const el = e.target as HTMLInputElement
    if (el.dataset.group !== undefined) {
      const i = Number(el.dataset.group)
      if (el.checked) skip.delete(i); else skip.add(i)
    } else if (el.dataset.keep) {
      const [i, id] = el.dataset.keep.split(':').map(Number)
      keep[i] = id
    }
    render()
  })
  $('#dup-mode').addEventListener('change', render)
  overlay.querySelector('#dup-fp')?.addEventListener('click', async (e) => {
    const b = e.target as HTMLButtonElement
    b.disabled = true
    try {
      const r = await api.library.fingerprintAll()
      toast(r.job_id ? `Fingerprinting ${r.tracks.toLocaleString()} tracks — progress under Settings → Background` : 'Nothing left to fingerprint', 'info')
    } catch (err) { toast(`Failed: ${errText(err)}`, 'error'); b.disabled = false }
  })
  $('#dup-go').addEventListener('click', async () => {
    const ids = losers()
    const trash = $<HTMLSelectElement>('#dup-mode').value === 'trash'
    if (trash && !confirm(`Move ${ids.length} files to Tagger's trash? Undo from History puts them back until the trash is emptied.`)) return
    $<HTMLButtonElement>('#dup-go').disabled = true
    try {
      if (trash) { const r = await api.library.deleteFiles(ids); toast(`Moved ${r.deleted} duplicate files to trash — undo from History`, 'success') }
      else { const r = await api.library.removeTracks(ids); toast(`Removed ${r.removed} duplicates from the library — undo from History`, 'success') }
      close()
      await onDone()
    } catch (e) { toast(`Failed: ${errText(e)}`, 'error'); render() }
  })
  render()
}
