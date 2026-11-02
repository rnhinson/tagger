// Settings page panes: Background (the running scan with progress + Cancel,
// recent scans) and About (version, build, deployed, environment).
import { api, ScanJob } from './api'
import { toast } from './toast'
import { esc } from './util'
import { shortPath, errText } from './staged'

const fmtTime = (t: number | null) => t ? new Date(t * 1000).toLocaleString() : '—'
const fmtDur = (s: number) => {
  s = Math.max(0, Math.round(s))
  return s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`
}
const STATUS_CLS: Record<string, string> = {
  done: 'mb-good', running: 'mb-ok', pending: 'mb-ok', cancelled: 'mb-none', interrupted: 'mb-bad', error: 'mb-bad',
}

function current(job: ScanJob): string {
  const now = Date.now() / 1000
  const elapsed = now - (job.started_at ?? now)
  const listing = job.phase === 'listing' || (job.status === 'running' && !job.scanned && job.phase !== 'reading')
  const pct = job.total && !listing ? Math.min(100, (job.scanned / job.total) * 100) : 0
  const rate = job.scanned && elapsed > 2 ? job.scanned / elapsed : 0
  const eta = rate && job.total > job.scanned && !listing ? (job.total - job.scanned) / rate : null
  const what = job.status === 'pending' ? 'Starting…'
    : listing ? `Finding files… ${job.total ? job.total.toLocaleString() + ' found' : ''}`
    : job.phase === 'pruning' ? 'Removing tracks whose files are gone…'
    : `Reading tags — ${job.scanned.toLocaleString()} of ${job.total.toLocaleString()} files (${pct.toFixed(1)}%)`
  return `
    <div class="bg-card">
      <div class="bg-card-head"><strong>Scanning ${job.directory ? esc(shortPath(job.directory)) : 'the whole library'}</strong>
        <button class="btn btn-ghost btn-sm" data-cancel="${esc(job.id)}">Cancel scan</button></div>
      <div class="bg-progress ${listing ? 'bg-indeterminate' : ''}"><div style="width:${listing ? 100 : pct}%"></div></div>
      <div class="ma-dim">${what}</div>
      <div class="ma-dim">Started ${fmtTime(job.started_at)} · ${fmtDur(elapsed)} elapsed${eta !== null ? ` · about ${fmtDur(eta)} left` : ''}</div>
      <div class="settings-hint">Cancel stops at the next file and keeps what was read; tracks whose files are gone are only removed by a scan that finishes.</div>
    </div>`
}

export async function renderBackground(el: HTMLElement): Promise<ScanJob | null> {
  let jobs: ScanJob[]
  try { jobs = await api.jobs.list() } catch (e) { el.innerHTML = `<div class="review-error">${esc(errText(e))}</div>`; return null }
  const active = jobs.find(j => j.status === 'running' || j.status === 'pending') ?? null
  const rows = jobs.slice(0, 15).map(j => {
    const dur = j.finished_at && j.started_at ? fmtDur(j.finished_at - j.started_at) : j.started_at ? '…' : ''
    const files = j.status === 'done' ? `${j.total.toLocaleString()} files · ${(j.changed ?? 0).toLocaleString()} changed`
      : j.total ? `${j.scanned.toLocaleString()} / ${j.total.toLocaleString()}` : ''
    return `<tr><td>${fmtTime(j.started_at)}</td><td>${j.directory ? esc(shortPath(j.directory)) : 'Whole library'}</td>
      <td><span class="mb-score ${STATUS_CLS[j.status] ?? ''}">${esc(j.status)}</span>${j.error ? `<div class="pr-msg">${esc(j.error)}</div>` : ''}</td>
      <td>${files}</td><td>${dur}</td></tr>`
  }).join('')
  el.innerHTML = `
    <div class="settings-section">
      <div class="settings-section-title">Library scan</div>
      ${active ? current(active) : '<div class="settings-hint">No scan running. <strong>Scan Library</strong> (top bar) starts one; the automatic interval is under Settings → Scan Options.</div>'}
    </div>
    <div class="settings-section">
      <div class="settings-section-title">Recent scans</div>
      ${jobs.length ? `<table class="pr-table bg-jobs"><thead><tr><th>Started</th><th>Scope</th><th>Status</th><th>Files</th><th>Took</th></tr></thead><tbody>${rows}</tbody></table>`
        : '<div class="settings-hint">None yet.</div>'}
    </div>`
  return active
}

export function wireBackground(el: HTMLElement, onCancel: () => void) {
  el.addEventListener('click', async (e) => {
    const b = (e.target as HTMLElement).closest<HTMLButtonElement>('[data-cancel]')
    if (!b) return
    b.disabled = true; b.textContent = 'Cancelling…'
    try { await api.jobs.cancel(b.dataset.cancel!); toast('Scan cancelling — it stops at the next file', 'info'); onCancel() }
    catch (err) { toast(`Cancel failed: ${errText(err)}`, 'error'); b.disabled = false; b.textContent = 'Cancel scan' }
  })
}

export async function renderAbout(el: HTMLElement) {
  try {
    const a = await api.about()
    const row = (k: string, v: string) => `<tr><th>${k}</th><td>${v}</td></tr>`
    const built = a.built ? new Date(a.built).toLocaleString() : 'unknown (local build)'
    el.innerHTML = `
      <div class="settings-section">
        <div class="about-title">Tagger <span class="ma-dim">${esc(a.image || 'v' + a.version)}</span></div>
        <table class="about-table">
          ${row('App version', esc(a.version))}
          ${row('Image', a.image ? esc(a.image) : '<span class="ma-dim">not stamped (local build)</span>')}
          ${row('Commit', a.commit ? `<a href="${esc(a.source)}/commit/${esc(a.commit)}" target="_blank" rel="noopener">${esc(a.commit.slice(0, 7))}</a>` : '<span class="ma-dim">—</span>')}
          ${row('Built', esc(built))}
          ${row('Deployed (running since)', esc(new Date(a.started * 1000).toLocaleString()))}
          ${row('Library', `${a.tracks.toLocaleString()} tracks · ${a.staged.toLocaleString()} with staged changes`)}
          ${row('Scans', a.scan_dirs.map(d => esc(shortPath(d) || d)).join('<br>') || '—')}
          ${row('Tools', Object.entries(a.tools).map(([t, ok]) => `${ok ? '✓' : '✗'} ${esc(t)}`).join(' · '))}
          ${row('Runtime', `Python ${esc(a.python)} · mutagen ${esc(a.mutagen)}`)}
          ${row('Source', `<a href="${esc(a.source)}" target="_blank" rel="noopener">${esc(a.source.replace('https://', ''))}</a>`)}
        </table>
      </div>`
  } catch (e) { el.innerHTML = `<div class="review-error">${esc(errText(e))}</div>` }
}
