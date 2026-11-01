"""Rename templates -> sanitized relative paths."""
from __future__ import annotations

import re
from pathlib import Path

_UNSAFE = re.compile(r'[<>:"/\\|?*\x00-\x1f]')


def _safe(part: str) -> str:
    """Sanitize a single path component."""
    part = _UNSAFE.sub('_', part).strip('. ')
    return part or '_'


def render_template(template: str, tags: dict, ext: str) -> str:
    """
    Render a rename template into a sanitized path relative to the track's library root,
    with the given extension. Raises ValueError/KeyError on a bad template.
    """
    fields = {
        'title':        tags.get('title') or '',
        'artist':       tags.get('artist') or '',
        'album':        tags.get('album') or '',
        'album_artist': tags.get('album_artist') or tags.get('artist') or '',
        'year':         tags.get('year') or '',
        'genre':        tags.get('genre') or '',
        'track_number': tags.get('track_number') or '0',
        'disc_number':  tags.get('disc_number') or '0',
    }
    track_num = int(re.sub(r'\D.*', '', fields['track_number']) or '0')
    disc_num  = int(re.sub(r'\D.*', '', fields['disc_number'])  or '0')
    rel = template.format(
        track_number=track_num,
        disc_number=disc_num,
        **{k: fields[k] for k in ('title', 'artist', 'album', 'album_artist', 'year', 'genre')},
    )
    parts = [_safe(p) for p in rel.replace('\\', '/').split('/') if p]
    if not parts:
        raise ValueError("template produced an empty path")
    return str(Path(*parts).with_suffix(ext))
