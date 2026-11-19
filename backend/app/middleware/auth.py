"""
JWT authentication middleware.

Validates admin JWTs on protected routes. Uses python-jose for
HS256 verification against the application's JWT_SECRET.

Admin routes require role='admin' in the token claims.
WebSocket connections are verified via a query-param token.
"""

from __future__ import annotations

import hashlib
import hmac
import secrets
from typing import Optional

import structlog
from fastapi import Depends, HTTPException, Query, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from jose import JWTError, jwt

from app.config import get_settings

logger = structlog.get_logger(__name__)

_bearer = HTTPBearer(auto_error=False)


def hash_password(password: str) -> str:
    """Create a portable PBKDF2-SHA256 password hash for environment storage."""
    iterations = 310_000
    salt = secrets.token_bytes(16)
    digest = hashlib.pbkdf2_hmac("sha256", password.encode(), salt, iterations)
    return f"pbkdf2_sha256${iterations}${salt.hex()}${digest.hex()}"


def verify_password(password: str, encoded_hash: str) -> bool:
    """Verify a PBKDF2-SHA256 password hash without revealing timing information."""
    try:
        algorithm, iterations_text, salt_hex, digest_hex = encoded_hash.split("$")
        if algorithm != "pbkdf2_sha256":
            return False
        iterations = int(iterations_text)
        expected = bytes.fromhex(digest_hex)
        actual = hashlib.pbkdf2_hmac(
            "sha256", password.encode(), bytes.fromhex(salt_hex), iterations
        )
    except (ValueError, TypeError):
        return False
    return hmac.compare_digest(actual, expected)


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
