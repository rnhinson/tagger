from __future__ import annotations

from typing import Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from core import staging
from core.database import db
from core.tagger import TAG_FIELDS
from core.multivalue import MULTI_FIELDS, edit_values
from core.cleanup import SEPARATORS, found_separators, standardize
from core.nameparse import PatternError, compile_pattern, parse_path
from core.replaygain import rg_tool, scan as rg_scan
from api.config import _load as load_settings, get_library_roots

router = APIRouter()


def _finish(conn, step: staging.Step, ids: list[int]) -> dict:
    """Record the staging step; with staging off, write it straight away."""
    step.save()
    summary = step.summary
    if load_settings().stage_changes:
        return {"staged": True}
    res = staging.apply(conn, ids, summary)
    return {"staged": False, "applied": res["applied"], "errors": res["errors"],
            "missing": res.get("missing", 0)}


def _rows(conn, ids: list[int]) -> list:
    rows = []
    for i in range(0, len(ids), 900):  # SQLite caps bound parameters
        chunk = ids[i:i + 900]
        ph = ",".join("?" * len(chunk))
        rows += conn.execute(f"SELECT * FROM tracks WHERE id IN ({ph})", chunk).fetchall()
    return rows


class TagUpdate(BaseModel):
    title: Optional[str] = None
    artist: Optional[str] = None
    album: Optional[str] = None
    album_artist: Optional[str] = None
    year: Optional[str] = None
    genre: Optional[str] = None
    track_number: Optional[str] = None
    disc_number: Optional[str] = None
    comment: Optional[str] = None
    composer: Optional[str] = None
    bpm: Optional[str] = None
    lyrics: Optional[str] = None
    compilation: Optional[str] = None
    mb_track_id: Optional[str] = None
    mb_artist_id: Optional[str] = None
    mb_album_id: Optional[str] = None
    mb_album_artist_id: Optional[str] = None


class BulkTagUpdate(BaseModel):
    track_ids: list[int]
    tags: TagUpdate


class ReplayGainRequest(BaseModel):
    track_ids: list[int]
    album_mode: bool = False


@router.get("/replaygain/status")
def replaygain_status():
    tool = rg_tool()
    return {"available": tool is not None, "tool": tool}


@router.post("/replaygain")
def scan_replaygain(req: ReplayGainRequest):
    if not req.track_ids:
        raise HTTPException(400, "No track IDs provided")
    with db() as conn:
        placeholders = ",".join("?" * len(req.track_ids))
        rows = conn.execute(
            f"SELECT path FROM tracks WHERE id IN ({placeholders})", req.track_ids
        ).fetchall()
    paths = [r["path"] for r in rows]
    try:
        return rg_scan(paths, album_mode=req.album_mode)
    except RuntimeError as exc:
        raise HTTPException(400, str(exc))


@router.patch("/{track_id}")
def update_track_tags(track_id: int, update: TagUpdate):
    updates = update.model_dump(exclude_none=True)
    if not updates:
        raise HTTPException(400, "No fields provided")

    with db() as conn:
        row = conn.execute(
            "SELECT * FROM tracks WHERE id = ?", (track_id,)
        ).fetchone()
        if not row:
            raise HTTPException(404, "Track not found")
        title = row["title"] or row["filename"]
        step = staging.Step(conn, f"Edited {{fields}} — {title}")
        staging.stage_edit(conn, row, updates, step)
        return {"ok": True, **_finish(conn, step, [track_id])}


class AutoNumber(BaseModel):
    track_ids: list[int]


class FindReplace(BaseModel):
    track_ids: list[int]
    field: str
    find: str
    replace: str = ""


@router.post("/autonumber")
def autonumber(req: AutoNumber):
    """Assign sequential track numbers to the selection, ordered by filename."""
    if not req.track_ids:
        raise HTTPException(400, "No track IDs provided")
    with db() as conn:
        rows = sorted(_rows(conn, req.track_ids), key=lambda r: r["filename"].lower())
        step = staging.Step(conn, f"Auto-numbered {len(rows)} tracks")
        for i, row in enumerate(rows, start=1):
            staging.stage_edit(conn, row, {"track_number": str(i)}, step)
        res = _finish(conn, step, [r["id"] for r in rows])
    return {"numbered": len(rows), **res}


@router.post("/find-replace")
def find_replace(req: FindReplace):
    """Replace text within one tag field across the selection (case-sensitive)."""
    if req.field not in TAG_FIELDS:
        raise HTTPException(400, "Invalid field")
    if not req.find:
        raise HTTPException(400, "Nothing to find")
    changed = []
    with db() as conn:
        rows = _rows(conn, req.track_ids)
        pending = staging.load(conn, [r["id"] for r in rows])
        step = staging.Step(conn, f"Find/replace “{req.find}” in {req.field}")
        for row in rows:
            # Work on the value as staged, so edits build on each other.
            val = staging.effective(row, pending.get(row["id"]))[req.field]
            if not val or req.find not in val:
                continue
            new_val = val.replace(req.find, req.replace)
            if new_val == val:
                continue
            staging.stage_edit(conn, row, {req.field: new_val}, step)
            changed.append(row["id"])
        res = _finish(conn, step, changed)
    return {"changed": len(changed), **res}


class Reorganize(BaseModel):
    track_ids: list[int]


@router.post("/reorganize")
def reorganize(req: Reorganize):
    """
    Re-file: plan a move for each selected file to its layout (its group's,
    else its library's, else the rename template -- core/layout.py), relative to its own library root (core/fileops.py),
    and stage it -- nothing moves until the staged changes are written. Uses
    the tags as staged.

    The UI offers it only as "Re-file selected" in the Quality panel's "Not in
    layout" view, for tracks chosen there. The old whole-selection Organize
    button was removed 2026-11-02: too easy to fire by accident.
    """
    from core import lyricsgroups
    from core.layout import Layouts
    if not req.track_ids:
        raise HTTPException(400, "No track IDs provided")
    layouts = Layouts()
    roots = layouts.roots
    planned: list[int] = []
    errors = []
    with db() as conn:
        rows = _rows(conn, req.track_ids)
        found = {r["id"] for r in rows}
        errors += [{"id": t, "error": "not found"} for t in req.track_ids if t not in found]
        pending = staging.load(conn, list(found))
        staged_dirs = staging.load_dirs(conn)
        assigned = lyricsgroups.assigned(conn, list(found))
        step = staging.Step(conn, f"Re-file {len(rows)} file{'s' if len(rows) != 1 else ''} to the library layout")
        for row in rows:
            if staged_dirs and staging.moved_path(row["path"], staged_dirs):
                errors.append({"id": row["id"], "error": "its folder is staged to move -- write that first"})
                continue
            try:
                dest = staging.plan_path(
                    row, staging.effective(row, pending.get(row["id"])),
                    layouts.template(row["path"], assigned.get(row["id"])), roots,
                )
            except staging.PlanError as exc:
                errors.append({"id": row["id"], "error": str(exc)})
                continue
            if dest == row["path"]:
                staging.stage(conn, row, new_path=None, step=step)
                continue
            staging.stage(conn, row, new_path=dest, step=step)
            planned.append(row["id"])
        res = _finish(conn, step, planned)
    moved = 0 if res["staged"] else res["applied"]
    return {"planned": len(planned), "moved": moved, "errors": errors + res.get("errors", []),
            "staged": res["staged"], "missing": res.get("missing", 0)}


class MoveTo(BaseModel):
    track_ids: list[int]
    folder: str


@router.post("/move-to")
def move_to_folder(req: MoveTo):
    """Stage moving the selected files into a folder (drag and drop), names kept."""
    import os
    from core.fileops import root_for

    if not req.track_ids:
        raise HTTPException(400, "No track IDs provided")
    folder = os.path.normpath(req.folder)
    roots = get_library_roots()
    root = root_for(folder, roots)
    if root is None:
        raise HTTPException(400, "destination must be inside a library root")
    if not os.path.isdir(folder):
        raise HTTPException(400, "folder not found")
    planned: list[int] = []
    errors = []
    with db() as conn:
        rows = _rows(conn, req.track_ids)
        staged_dirs = staging.load_dirs(conn)
        step = staging.Step(conn, f"Move {len(rows)} file{'s' if len(rows) != 1 else ''} → {os.path.basename(folder)}")
        for row in rows:
            if staged_dirs and staging.moved_path(row["path"], staged_dirs):
                errors.append({"id": row["id"], "error": "its folder is staged to move -- write that first"})
                continue
            dest = os.path.join(folder, row["filename"])
            if dest == row["path"]:
                continue
            staging.stage(conn, row, new_path=dest, step=step)
            planned.append(row["id"])
        res = _finish(conn, step, planned)
    moved = 0 if res["staged"] else res["applied"]
    return {"planned": len(planned), "moved": moved, "errors": errors + res.get("errors", []),
            "staged": res["staged"], "missing": res.get("missing", 0)}


class BulkRename(BaseModel):
    track_ids: list[int]              # in list order (counters number in this order)
    find: str = ""
    replace: str = ""
    regex: bool = False
    case_sensitive: bool = False
    match_all: bool = True
    apply_to: str = "name"            # name | ext | both
    transform: str = "none"           # none | lower | upper | title | capitalize
    exclude: list[int] = []           # rows unticked in the preview


def _plan_renames(conn, req: BulkRename) -> list[dict]:
    """
    The PowerRename-style plan for each track: its current name (as staged),
    the new one, and whether it can be renamed. Raises HTTP 400 for a bad
    search or template.
    """
    import os
    from collections import Counter
    from core import powerrename as pr

    if req.apply_to not in ("name", "ext", "both"):
        raise HTTPException(400, "apply_to must be name, ext or both")
    if req.transform not in ("none", "lower", "upper", "title", "capitalize"):
        raise HTTPException(400, "unknown text formatting")
    opts = pr.Options(find=req.find, replace=req.replace, regex=req.regex,
                      case_sensitive=req.case_sensitive, match_all=req.match_all,
                      apply_to=req.apply_to, transform=req.transform)
    try:
        pattern = pr.compile_search(opts)
        tpl = pr.parse_template(req.replace, req.regex)
    except pr.RenameError as exc:
        raise HTTPException(400, str(exc))

    by_id = {r["id"]: r for r in _rows(conn, req.track_ids)}
    rows = [by_id[t] for t in dict.fromkeys(req.track_ids) if t in by_id]
    entries = staging.load(conn, [r["id"] for r in rows])
    dirs = staging.load_dirs(conn)
    items = []
    for i, row in enumerate(rows):
        cur = (entries.get(row["id"]) or {}).get("new_path") or row["path"]
        folder, name = os.path.split(cur)
        item = {"id": row["id"], "folder": folder, "old": name, "new": name, "status": "same", "message": None}
        items.append(item)
        if dirs and staging.moved_path(row["path"], dirs):
            item.update(status="error", message="its folder is staged to move -- write that first")
            continue
        try:
            new = pr.rename_one(name, opts, pattern, tpl, i)
        except pr.RenameError as exc:
            raise HTTPException(400, str(exc))
        item["new"] = new
        if new == name:
            continue
        problem = pr.check_name(new)
        if problem:
            item.update(status="error", message=problem)
            continue
        item["status"] = "rename"

    # Clashes: two files ending up with one name (case-insensitively -- the
    # share is SMB), or a name that's already taken on disk by another file.
    final = Counter((it["folder"], it["new"].lower()) for it in items if it["status"] != "error")
    moving_away = {os.path.join(it["folder"], it["old"]).lower(): it["id"]
                   for it in items if it["status"] == "rename"}
    for it in items:
        if it["status"] != "rename":
            continue
        target = os.path.join(it["folder"], it["new"])
        taker = moving_away.get(target.lower())
        if final[(it["folder"], it["new"].lower())] > 1:
            it.update(status="conflict", message="another file would get the same name")
        elif taker is not None and taker != it["id"]:
            it.update(status="conflict",
                      message="takes the name of another file being renamed -- do it in two passes")
        elif os.path.exists(target) and not _samefile(os.path.join(it["folder"], it["old"]), target):
            it.update(status="conflict", message="a file with that name already exists")
    return items


def _samefile(a: str, b: str) -> bool:
    import os
    try:
        return os.path.samefile(a, b)
    except OSError:
        return False


@router.post("/rename-preview")
def bulk_rename_preview(req: BulkRename):
    """Original and new name for each selected file -- nothing is staged."""
    from collections import Counter
    with db() as conn:
        items = _plan_renames(conn, req)
    counts = Counter(it["status"] for it in items)
    return {"items": items, "counts": dict(counts)}


@router.post("/rename")
def bulk_rename(req: BulkRename):
    """Stage the planned renames (minus excluded rows and anything flagged)."""
    import os
    skip = set(req.exclude)
    with db() as conn:
        items = _plan_renames(conn, req)
        todo = [it for it in items if it["status"] == "rename" and it["id"] not in skip]
        rows = {r["id"]: r for r in _rows(conn, [it["id"] for it in todo])}
        step = staging.Step(conn, f"Rename {len(todo)} file{'s' if len(todo) != 1 else ''}")
        for it in todo:
            staging.stage(conn, rows[it["id"]], new_path=os.path.join(it["folder"], it["new"]), step=step)
        res = _finish(conn, step, [it["id"] for it in todo])
    blocked = [it for it in items if it["status"] in ("conflict", "error")]
    return {"planned": len(todo), "skipped": len(blocked), "staged": res["staged"], "missing": res.get("missing", 0),
            "moved": 0 if res["staged"] else res["applied"], "errors": res.get("errors", [])}


@router.post("/bulk")
def bulk_update_tags(update: BulkTagUpdate):
    updates = update.tags.model_dump(exclude_none=True)
    if not updates:
        raise HTTPException(400, "No fields provided")

    with db() as conn:
        rows = _rows(conn, update.track_ids)
        found = {r["id"] for r in rows}
        errors = [{"id": t, "error": "not found"} for t in update.track_ids if t not in found]
        step = staging.Step(conn, f"Set {{fields}} on {len(rows)} tracks")
        for row in rows:
            staging.stage_edit(conn, row, updates, step)
        res = _finish(conn, step, list(found))
    return {"ok": True, **res, "errors": errors + res.get("errors", [])}


class ValueEdit(BaseModel):
    track_ids: list[int]
    field: str
    add: list[str] = []
    remove: list[str] = []


@router.post("/values")
def edit_tag_values(req: ValueEdit):
    """
    Add/remove values of a multi-value tag ("Folk; Celtic") per track, from
    each track's own (staged) value: adding puts it on every track that lacks
    it, removing takes it off wherever it is. Other values are kept.
    """
    if req.field not in MULTI_FIELDS:
        raise HTTPException(400, "Invalid field")
    add = [a.strip() for a in req.add if a.strip()]
    remove = [r.strip() for r in req.remove if r.strip()]
    if not add and not remove:
        raise HTTPException(400, "Nothing to add or remove")
    label = req.field.replace("_", " ").capitalize()
    changes = ", ".join([f"+{a}" for a in add] + [f"\u2212{r}" for r in remove])
    with db() as conn:
        rows = _rows(conn, req.track_ids)
        entries = staging.load(conn, [r["id"] for r in rows])
        todo = []
        for row in rows:
            old = staging.effective(row, entries.get(row["id"])).get(req.field) or ""
            new = edit_values(old, add, remove)
            if new != old:
                todo.append((row, new))
        if not todo:
            return {"ok": True, "changed": 0, "staged": load_settings().stage_changes, "errors": []}
        step = staging.Step(conn, f"{label} {changes} on {len(todo)} tracks")
        for row, new in todo:
            staging.stage_edit(conn, row, {req.field: new}, step)
        res = _finish(conn, step, [r["id"] for r, _ in todo])
    return {"ok": True, "changed": len(todo), **res, "errors": res.get("errors", [])}


class CleanupScope(BaseModel):
    field: str
    track_ids: Optional[list[int]] = None   # None = the whole library


class Standardize(CleanupScope):
    separators: list[str]
    keep: list[str] = []
    preview: bool = True


def _scope(conn, req: CleanupScope) -> list[tuple]:
    """(row, effective value) for every track in scope (as staged)."""
    if req.field not in MULTI_FIELDS:
        raise HTTPException(400, "Invalid field")
    rows = (_rows(conn, req.track_ids) if req.track_ids is not None
            else conn.execute("SELECT * FROM tracks").fetchall())
    entries = staging.load(conn, [r["id"] for r in rows])
    return [(r, staging.effective(r, entries.get(r["id"])).get(req.field) or "") for r in rows]


@router.post("/separators")
def find_separators(req: CleanupScope):
    """Which separators other than ';' the field's values use, with counts."""
    with db() as conn:
        counts: dict[str, int] = {}
        for _row, value in _scope(conn, req):
            if value:
                counts[value] = counts.get(value, 0) + 1
    return {"separators": found_separators(counts)}


@router.post("/standardize")
def standardize_separators(req: Standardize):
    """Rewrite the chosen separators as ';' -- preview, or stage as one step."""
    seps = [s for s in req.separators if s in SEPARATORS]
    if not seps:
        raise HTTPException(400, "No separators chosen")
    keep = set(req.keep)
    with db() as conn:
        todo, changes = [], {}
        for row, old in _scope(conn, req):
            new = standardize(old, seps, keep)
            if new != old:
                todo.append((row, new))
                c = changes.setdefault(old, {"old": old, "new": new, "tracks": 0})
                c["tracks"] += 1
        listed = sorted(changes.values(), key=lambda c: (-c["tracks"], c["old"].casefold()))
        if req.preview or not todo:
            return {"tracks": len(todo), "changes": listed}
        label = req.field.replace("_", " ")
        step = staging.Step(conn, f"Standardize {label} separators ({' '.join(seps)}) on {len(todo)} tracks")
        for row, new in todo:
            staging.stage_edit(conn, row, {req.field: new}, step)
        res = _finish(conn, step, [r["id"] for r, _ in todo])
    return {"tracks": len(todo), "changes": listed, **res, "errors": res.get("errors", [])}
class NameParse(BaseModel):
    track_ids: list[int]
    pattern: str
    exclude: list[int] = []     # opted out in the preview


def _parse_names(conn, req: NameParse) -> tuple[list, list[dict]]:
    try:
        compiled = compile_pattern(req.pattern)
    except PatternError as exc:
        raise HTTPException(400, str(exc))
    rows = sorted(_rows(conn, req.track_ids), key=lambda r: r["path"])
    entries = staging.load(conn, [r["id"] for r in rows])
    out = []
    for row in rows:
        eff = staging.effective(row, entries.get(row["id"]))
        tags = parse_path(row["path"], compiled)
        changes = {k: v for k, v in (tags or {}).items() if (eff.get(k) or "") != v}
        out.append({"id": row["id"], "path": row["path"], "matched": tags is not None,
                    "tags": tags or {}, "changes": changes})
    return rows, out


@router.post("/parse-preview")
def parse_names_preview(req: NameParse):
    """What a file-name pattern would set on each track (current values alongside)."""
    with db() as conn:
        _rows_, items = _parse_names(conn, req)
    return {"items": items[:1000], "total": len(items),
            "matched": sum(i["matched"] for i in items),
            "changing": sum(bool(i["changes"]) for i in items)}


@router.post("/parse")
def parse_names(req: NameParse):
    """Stage the tags a file-name pattern reads, as one step."""
    skip = set(req.exclude)
    with db() as conn:
        rows, items = _parse_names(conn, req)
        by_id = {r["id"]: r for r in rows}
        todo = [i for i in items if i["changes"] and i["id"] not in skip]
        if not todo:
            return {"ok": True, "changed": 0, "staged": load_settings().stage_changes, "errors": []}
        step = staging.Step(conn, f"Tags from file names ({req.pattern.strip()}) on {len(todo)} tracks")
        for i in todo:
            staging.stage_edit(conn, by_id[i["id"]], i["changes"], step)
        res = _finish(conn, step, [i["id"] for i in todo])
    return {"ok": True, "changed": len(todo), **res, "errors": res.get("errors", [])}


class AlbumMerge(BaseModel):
    track_ids: list[int]
    target: Optional[str] = None        # group key whose folder files move into (default: the biggest)
    order: list[str] = []               # group keys in disc order (default: as listed)
    album: Optional[str] = None         # the merged album's tags; None/"" = leave as is
    album_artist: Optional[str] = None
    year: Optional[str] = None
    discs: str = "keep"                 # keep | per_album
    move: bool = False
    preview: bool = True


def _merge_plan(conn, req: AlbumMerge) -> dict:
    """Group the selection into albums and plan each track's tags and path."""
    import os

    rows = _rows(conn, req.track_ids)
    entries = staging.load(conn, [r["id"] for r in rows])
    staged_dirs = staging.load_dirs(conn)
    groups: dict[str, dict] = {}
    for row in rows:
        eff = staging.effective(row, entries.get(row["id"]))
        album, aa = eff.get("album") or "", eff.get("album_artist") or ""
        key = "\n".join((row["directory"], album, aa))
        g = groups.setdefault(key, {"key": key, "directory": row["directory"], "album": album,
                                    "album_artist": aa, "artists": set(), "years": set(),
                                    "discs": set(), "rows": []})
        g["artists"].add(eff.get("artist") or "")
        g["years"].add(eff.get("year") or "")
        g["discs"].add(_disc(eff.get("disc_number")))
        g["rows"].append((row, eff))
    listed = sorted(groups.values(), key=lambda g: (g["directory"].casefold(), g["album"].casefold()))
    order = [groups[k] for k in req.order if k in groups] + [g for g in listed if g["key"] not in req.order]
    if len(order) < 2:
        raise HTTPException(400, "Select tracks from at least two albums")
    # Default target: the album with the most tracks (ties: the first listed).
    target = groups.get(req.target) or max(order, key=lambda g: len(g["rows"]))

    disc_map, nxt = {}, 1
    for g in order:
        for d in sorted(g["discs"]):
            disc_map[(g["key"], d)] = str(nxt)
            nxt += 1

    tags_set = {k: v.strip() for k, v in (("album", req.album), ("album_artist", req.album_artist),
                                          ("year", req.year)) if v and v.strip()}
    plan, clashes, taken = [], [], set()
    for g in order:
        for row, eff in sorted(g["rows"], key=lambda re_: (_disc(re_[1].get("disc_number")),
                                                          _num(re_[1].get("track_number")), re_[0]["filename"])):
            tags = {k: v for k, v in tags_set.items() if (eff.get(k) or "") != v}
            if req.discs == "per_album":
                d = disc_map[(g["key"], _disc(eff.get("disc_number")))]
                if (eff.get("disc_number") or "") != d:
                    tags["disc_number"] = d
            new_path = None
            if req.move and g["directory"] != target["directory"]:
                dest = os.path.join(target["directory"], row["filename"])
                why = None
                if staged_dirs and staging.moved_path(row["path"], staged_dirs):
                    why = "its folder is staged to move"
                elif dest in taken or (os.path.exists(dest) and not _samefile(dest, row["path"])):
                    why = "a file with this name is already there"
                if why:
                    clashes.append({"id": row["id"], "filename": row["filename"], "error": why})
                else:
                    new_path = dest
                    taken.add(dest)
            if tags or new_path:
                plan.append({"row": row, "tags": tags, "new_path": new_path, "group": g["key"]})

    def summary(g):
        return {"key": g["key"], "directory": g["directory"], "album": g["album"],
                "album_artist": g["album_artist"], "tracks": len(g["rows"]),
                "artists": sorted(a for a in g["artists"] if a)[:5],
                "year": next((y for y in sorted(g["years"]) if y), ""),
                "discs": sorted(g["discs"]),
                "new_discs": [disc_map[(g["key"], d)] for d in sorted(g["discs"])]}
    return {"groups": [summary(g) for g in order], "target": target["key"], "plan": plan,
            "clashes": clashes}


def _disc(v) -> int:
    n = _num(v)
    return n if n > 0 else 1


def _num(v) -> int:
    try:
        return int(str(v or "").split("/")[0])
    except ValueError:
        return 0


@router.post("/merge-albums")
def merge_albums(req: AlbumMerge):
    """
    Make the selected tracks one album: the chosen album / album artist / year
    on every track, discs optionally renumbered album by album (1..n in the
    order given), files optionally moved into the target album's folder.
    Preview, or stage it all as one step.
    """
    if req.discs not in ("keep", "per_album"):
        raise HTTPException(400, "discs must be keep or per_album")
    with db() as conn:
        p = _merge_plan(conn, req)
        out = {"groups": p["groups"], "target": p["target"], "clashes": p["clashes"],
               "tracks": len(p["plan"]), "moves": sum(1 for x in p["plan"] if x["new_path"])}
        if req.preview or not p["plan"]:
            return out
        name = (req.album or "").strip() or next(g["album"] for g in p["groups"] if g["key"] == p["target"])
        step = staging.Step(conn, f"Merge {len(p['groups'])} albums into {name or '(no album)'} ({len(p['plan'])} tracks)")
        for x in p["plan"]:
            if x["tags"]:
                staging.stage_edit(conn, x["row"], x["tags"], step)
            if x["new_path"]:
                staging.stage(conn, x["row"], new_path=x["new_path"], step=step)
        res = _finish(conn, step, [x["row"]["id"] for x in p["plan"]])
    return {**out, **res, "errors": res.get("errors", [])}
