"""Shared JWT verification helper used by all STAR FastAPI backends.

Import and call verify_session() in your auth middleware.
The JWT_SECRET env var must match the value used by the auth service.
"""

import os
from typing import Optional

import jwt


_JWT_SECRET: Optional[str] = None


def _secret() -> str:
    global _JWT_SECRET
    if _JWT_SECRET is None:
        _JWT_SECRET = os.environ.get("JWT_SECRET", "")
    return _JWT_SECRET


def verify_session(cookie_value: str) -> Optional[dict]:
    """
    Decode and validate a session JWT.

    Returns the decoded payload dict on success, or None if the token is
    missing, expired, or invalid.
    """
    if not cookie_value or not _secret():
        return None
    try:
        return jwt.decode(cookie_value, _secret(), algorithms=["HS256"])
    except jwt.PyJWTError:
        return None
