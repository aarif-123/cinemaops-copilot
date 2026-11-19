"""
Distributed Lock Manager — Redlock-based seat lease fencing.

Prevents race conditions between the agent's relocation plan and concurrent
customer checkout sessions claiming the same target seats.

Why Redlock instead of database advisory locks:
    - Connection-agnostic: any pod can acquire/release without a shared DB conn.
    - TTL-based auto-expiry: crashed pods never leave orphan locks.
    - Sub-millisecond evaluation: Redis is in-memory, not disk-I/O bound.

The manager provides an async context-manager interface so callers can use
    `async with lock_manager.acquire(show_id, seat_ids) as bundle:`
and be guaranteed locks are always released on exit, even on exception.
"""

from __future__ import annotations

import asyncio
import contextlib
import uuid
from typing import AsyncIterator

import structlog

from app.config import get_settings
from app.models.domain import LockConflictError
from app.redis_client import get_redis

logger = structlog.get_logger(__name__)


class LockBundle:
    """Holds metadata about an active Redlock acquisition."""

    def __init__(self, keys: list[str], token: str) -> None:
        self.keys = keys
        self.token = token

    def __repr__(self) -> str:
        return f"LockBundle(keys={len(self.keys)}, token={self.token[:8]}...)"


class DistributedLockManager:
    """
    Manages ephemeral seat locks via Redis SET NX PX (Redlock-compatible).

    For production, replace with pottery.Redlock for multi-node Redis.
    Current implementation uses a single Redis instance with NX+PX,
    which is sufficient for single-node Redis (Upstash) deployments.
    """

    def __init__(self) -> None:
        self._settings = get_settings()

    def _seat_key(self, show_id: str, seat_id: str) -> str:
        return f"lock:show:{show_id}:seat:{seat_id}"

    def _reloc_key(self, show_id: str, seat_id: str) -> str:
        """Ephemeral hold key set during agent planning phase."""
        return f"reloc:show:{show_id}:seat:{seat_id}"

    async def check_active_locks(self, show_id: str, seat_ids: list[str]) -> list[str]:
        """
        Returns the subset of seat_ids that are currently locked by
        customer checkout sessions. Zero active locks → safe to plan.
        """
        redis = await get_redis()
        keys = [self._seat_key(show_id, sid) for sid in seat_ids]

        # Redis MGET is atomic — reads all keys in one round-trip
        values = await redis.mget(*keys)
        locked = [
            seat_ids[i] for i, v in enumerate(values) if v is not None
        ]

        if locked:
            logger.warning("active_checkout_locks_detected", seat_ids=locked, show_id=show_id)

        return locked

    @contextlib.asynccontextmanager
    async def acquire_relocation_holds(
        self,
        show_id: str,
        seat_ids: list[str],
    ) -> AsyncIterator[LockBundle]:
        """
        Acquire ephemeral relocation holds on target seats before the HITL gate.
        Released automatically on context exit (approval OR rejection).

        Raises:
            LockConflictError: if any seat is already locked by customer checkout.
        """
        # First, verify no active customer checkout locks
        conflicts = await self.check_active_locks(show_id, seat_ids)
        if conflicts:
            raise LockConflictError(seat_ids=conflicts)

        redis = await get_redis()
        ttl_ms = self._settings.redis_lock_ttl_seconds * 1000
        token = str(uuid.uuid4())
        acquired_keys: list[str] = []

        try:
            for seat_id in seat_ids:
                key = self._reloc_key(show_id, seat_id)
                ok = await redis.set(key, token, px=ttl_ms, nx=True)
                if not ok:
                    # Another agent pipeline claimed this seat concurrently
                    raise LockConflictError(seat_ids=[seat_id])
                acquired_keys.append(key)

            logger.info(
                "relocation_holds_acquired",
                show_id=show_id,
                count=len(acquired_keys),
                token=token[:8],
            )
            bundle = LockBundle(keys=acquired_keys, token=token)
            yield bundle

        finally:
            await self._release_keys(redis, acquired_keys, token)

    async def _release_keys(self, redis, keys: list[str], token: str) -> None:
        """Release locks only if our token still matches (prevents stale releases)."""
        release_script = """
        local function release(keys, token)
            for _, key in ipairs(keys) do
                if redis.call('GET', key) == token then
                    redis.call('DEL', key)
                end
            end
        end
        release(KEYS, ARGV[1])
        return 1
        """
        try:
            await redis.eval(release_script, len(keys), *keys, token)
            logger.debug("relocation_holds_released", count=len(keys))
        except Exception:
            logger.exception("failed_to_release_locks", keys=keys)


# Singleton — avoids recreating the manager on every request
_lock_manager: DistributedLockManager | None = None


def get_lock_manager() -> DistributedLockManager:
    global _lock_manager
    if _lock_manager is None:
        _lock_manager = DistributedLockManager()
    return _lock_manager
