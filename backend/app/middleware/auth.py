"""
JWT authentication middleware.

Validates admin JWTs on protected routes. Uses python-jose for
HS256 verification against the application's JWT_SECRET.

Admin routes require role='admin' in the token claims.
WebSocket connections are verified via a query-param token.
"""

from __future__ import annotations

from typing import Optional

import structlog
from fastapi import Depends, HTTPException, Query, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from jose import JWTError, jwt

from app.config import get_settings

logger = structlog.get_logger(__name__)

_bearer = HTTPBearer(auto_error=False)


class AuthenticatedAdmin:
    """Dependency-injected admin identity extracted from a valid JWT."""

    def __init__(self, admin_id: str, role: str, raw_token: str) -> None:
        self.admin_id = admin_id
        self.role = role
        self.raw_token = raw_token

    @property
    def is_admin(self) -> bool:
        return self.role == "admin"


def _decode_token(token: str) -> dict:
    settings = get_settings()
    try:
        payload = jwt.decode(token, settings.jwt_secret, algorithms=[settings.jwt_algorithm])
        return payload
    except JWTError as exc:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid or expired token",
            headers={"WWW-Authenticate": "Bearer"},
        ) from exc


async def require_admin(
    credentials: Optional[HTTPAuthorizationCredentials] = Depends(_bearer),
) -> AuthenticatedAdmin:
    """FastAPI dependency: validates Bearer token and asserts admin role."""
    if not credentials:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Authorization header required",
        )
    payload = _decode_token(credentials.credentials)
    role = payload.get("role", "user")
    if role != "admin":
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Admin role required")

    return AuthenticatedAdmin(
        admin_id=payload.get("sub", ""),
        role=role,
        raw_token=credentials.credentials,
    )


async def ws_auth(token: str = Query(..., description="Admin JWT for WS auth")) -> AuthenticatedAdmin:
    """WebSocket auth dependency — token passed as query param."""
    payload = _decode_token(token)
    return AuthenticatedAdmin(
        admin_id=payload.get("sub", ""),
        role=payload.get("role", "user"),
        raw_token=token,
    )
