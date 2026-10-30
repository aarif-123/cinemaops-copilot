"""
Async Redis client factory.

Provides a singleton aioredis connection shared across all async code paths.
Using a shared connection pool avoids per-request TCP handshake overhead.
"""

from __future__ import annotations

import redis.asyncio as aioredis
import structlog

from app.config import get_settings

logger = structlog.get_logger(__name__)

_redis: aioredis.Redis | None = None


async def get_redis() -> aioredis.Redis:
    """Return the singleton async Redis client, initialised on first call."""
    global _redis
    if _redis is None:
        settings = get_settings()
        _redis = aioredis.from_url(
            settings.redis_url,
            encoding="utf-8",
            decode_responses=True,
            socket_connect_timeout=5,
            socket_keepalive=True,
        )
        # Verify connectivity at startup
        await _redis.ping()
        logger.info("redis_connected", url=settings.redis_url.split("@")[-1])
    return _redis


async def close_redis() -> None:
    """Gracefully close the Redis connection on app shutdown."""
    global _redis
    if _redis is not None:
        await _redis.aclose()
        _redis = None
        logger.info("redis_connection_closed")
