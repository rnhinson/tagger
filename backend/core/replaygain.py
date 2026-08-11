"""
ReplayGain scanning via an external tool (rsgain or loudgain).

The tool writes ReplayGain tags directly into the audio files; tagger does not
store gain values in its own DB. Detection is graceful: if no tool is installed,
the feature reports itself unavailable rather than erroring.
"""
from __future__ import annotations

import shutil
import subprocess


def rg_tool() -> str | None:
    """Return the name of an available ReplayGain tool, or None."""
    for tool in ("rsgain", "loudgain"):
        if shutil.which(tool):
            return tool
    return None


def _command(tool: str, paths: list[str], album_mode: bool) -> list[str]:
    if tool == "rsgain":
        # `rsgain custom` scans an explicit file list and writes tags in place.
        cmd = ["rsgain", "custom", "-s", "i"]  # -s i: write ID3v2/Vorbis tags
        if album_mode:
            cmd.append("-a")  # also compute album gain across the given files
        return cmd + paths
    # loudgain
    cmd = ["loudgain", "-s", "e"]  # -s e: write tags (EBU R128)
    if album_mode:
        cmd.append("-a")
    return cmd + paths


def scan(paths: list[str], album_mode: bool = False) -> dict:
    """
    Run ReplayGain analysis on the given files. Returns a summary dict:
      {ok, tool, processed, error?}
    Raises RuntimeError if no tool is available.
    """
    tool = rg_tool()
    if not tool:
        raise RuntimeError("No ReplayGain tool found — install rsgain or loudgain")
    if not paths:
        return {"ok": True, "tool": tool, "processed": 0}

    try:
        proc = subprocess.run(
            _command(tool, paths, album_mode),
            capture_output=True,
            text=True,
            timeout=600,
        )
    except subprocess.TimeoutExpired:
        return {"ok": False, "tool": tool, "processed": 0, "error": "ReplayGain scan timed out"}

    if proc.returncode != 0:
        msg = (proc.stderr or proc.stdout or "unknown error").strip().splitlines()
        return {
            "ok": False,
            "tool": tool,
            "processed": 0,
            "error": msg[-1] if msg else "ReplayGain scan failed",
        }
    return {"ok": True, "tool": tool, "processed": len(paths)}
