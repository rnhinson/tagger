from __future__ import annotations

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel

from core.auth import (
    COOKIE_NAME, COOKIE_MAX_AGE, auth_enabled, check_password, make_token, valid_token,
)

router = APIRouter()


class LoginRequest(BaseModel):
    password: str


@router.get("/status")
def status(request: Request):
    return {
        "required": auth_enabled(),
        "authed": not auth_enabled() or valid_token(request.cookies.get(COOKIE_NAME)),
    }


@router.post("/login")
def login(req: LoginRequest):
    if not auth_enabled():
        return {"ok": True}
    if not check_password(req.password):
        raise HTTPException(401, "Incorrect password")
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
