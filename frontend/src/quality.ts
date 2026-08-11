import { Track, IssueCount } from './api'

// ─── Track quality rating ───────────────────────────────────────────────────────

export function trackQuality(t: Track): 'good' | 'fair' | 'poor' {
  if (!t.title || !t.artist) return 'poor'
  if (!t.album || !t.year || !t.track_number) return 'fair'
  return 'good'
}

export const QUALITY_TITLES = {
  good: 'All key tags present',
  fair: 'Missing some tags (album, year, or track #)',
  poor: 'Missing critical tags (title or artist)',
}

export const QUALITY_ISSUES: { key: keyof IssueCount; label: string; warn?: boolean }[] = [
  { key: 'missing_title',        label: 'Missing title'    },
  { key: 'missing_artist',       label: 'Missing artist'   },
  { key: 'missing_album',        label: 'Missing album'    },
  { key: 'missing_year',         label: 'Missing year'     },
  { key: 'missing_genre',        label: 'Missing genre'    },
  { key: 'missing_track_number', label: 'Missing track #'  },
  { key: 'duplicate_tracks',     label: 'Duplicate tracks', warn: true },
  { key: 'missing_files',        label: 'Missing files',    warn: true },
]

// ─── Case normalization ─────────────────────────────────────────────────────────

const SMALL_WORDS = new Set([
  'a', 'an', 'the', 'and', 'but', 'or', 'for', 'nor',
  'on', 'at', 'to', 'by', 'in', 'of', 'up', 'with', 'from',
])

export function toTitleCase(s: string): string {
  return s.replace(/\S+/g, (word, offset) => {
    const lower = word.toLowerCase()
    if (offset > 0 && SMALL_WORDS.has(lower)) return lower
    return lower.charAt(0).toUpperCase() + lower.slice(1)
  })
}

export function needsNormalization(s: string | null | undefined): boolean {
  if (!s || s.length < 2) return false
  if (!/[a-zA-Z]{2}/.test(s)) return false
  return s === s.toUpperCase() || s === s.toLowerCase()
}

export const NORMALIZE_FIELDS: (keyof Track)[] = ['title', 'artist', 'album', 'album_artist', 'genre']
