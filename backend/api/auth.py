from __future__ import annotations

import time

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel

from core.auth import (
    COOKIE_NAME, COOKIE_MAX_AGE, auth_enabled, check_password, make_token, valid_token,
)

router = APIRouter()

# Simple in-memory login throttle: N failures per client IP within a window.
_MAX_ATTEMPTS = 5
_WINDOW = 300.0
_attempts: dict[str, list[float]] = {}


def _recent_failures(ip: str) -> list[float]:
    now = time.time()
    fresh = [t for t in _attempts.get(ip, []) if now - t < _WINDOW]
    if fresh:
        _attempts[ip] = fresh
    else:
        _attempts.pop(ip, None)
    return fresh


def _rate_limited(ip: str) -> bool:
    return len(_recent_failures(ip)) >= _MAX_ATTEMPTS


class LoginRequest(BaseModel):
    password: str


@router.get("/status")
def status(request: Request):
    return {
        "required": auth_enabled(),
        "authed": not auth_enabled() or valid_token(request.cookies.get(COOKIE_NAME)),
    }


@router.post("/login")
def login(req: LoginRequest, request: Request):
    if not auth_enabled():
        return {"ok": True}
    ip = request.client.host if request.client else "unknown"
    if _rate_limited(ip):
        raise HTTPException(429, "Too many failed attempts — try again later")
    if not check_password(req.password):
        _attempts.setdefault(ip, []).append(time.time())
        raise HTTPException(401, "Incorrect password")
    _attempts.pop(ip, None)  # clear on success
    resp = JSONResponse({"ok": True})
    resp.set_cookie(
        COOKIE_NAME, make_token(),
        max_age=COOKIE_MAX_AGE, httponly=True, samesite="lax", path="/",
    )
    return resp


@router.post("/logout")
def logout():
    resp = JSONResponse({"ok": True})
    resp.delete_cookie(COOKIE_NAME, path="/")
    return resp
