// Pure, dependency-free helpers shared across modules.

export function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

export function fmtDuration(sec: number | null): string {
  if (!sec) return '—'
  const m = Math.floor(sec / 60), s = Math.floor(sec % 60)
  return `${m}:${s.toString().padStart(2, '0')}`
}

export function debounce(fn: () => void, ms: number): () => void {
  let t: ReturnType<typeof setTimeout>
  return () => { clearTimeout(t); t = setTimeout(fn, ms) }
}

export function fmtBitrate(bps: number | null): string {
  return bps ? `${Math.round(bps / 1000)} kbps` : '—'
}

export function fmtSampleRate(hz: number | null): string {
  return hz ? `${(hz / 1000).toFixed(1)} kHz` : '—'
}

export function fmtChannels(n: number | null): string {
  if (!n) return '—'
  return n === 1 ? 'Mono' : n === 2 ? 'Stereo' : `${n}ch`
}
