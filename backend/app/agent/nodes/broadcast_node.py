"""
Broadcast Node — post-commit SDUI event dispatch.

Publishes RFC 6902 JSON Patch payloads to Redis Pub/Sub after a
successful DB commit. The WS gateway forwards these to customer clients.

Failure here is non-critical: the DB commit is already durable.
If Redis is temporarily unavailable, clients will receive the updated
state on their next topology fetch (polling fallback).
"""

from __future__ import annotations

from typing import Any

import structlog

from app.agent.state import CinemaOpsState
from app.services.sdui_publisher import publish_relocation_event

logger = structlog.get_logger(__name__)


async def broadcast_node(state: CinemaOpsState) -> dict[str, Any]:
    """
    Publish UI_STATE_PATCH events for the completed relocation.
    Non-blocking: failures are logged but do not roll back the committed state.
    """
    plan = state.get("relocation_plan")
    result = state.get("execution_result", {})

    if not plan or not result:
        return {"audit_trail": ["broadcast_node_skipped: no_plan_or_result"]}

    quarantine_ids = plan.get("quarantine_seat_ids", [])
    relocated_map = {
        r["booking_id"]: r["target_seat_ids"]
        for r in plan.get("relocations", [])
    }

    # Increment SDUI version for client deduplication
    new_version = state.get("sdui_version", 1) + 1

    try:
        await publish_relocation_event(
            show_id=state["show_id"],
            quarantine_seat_ids=quarantine_ids,
            relocated_seat_map=relocated_map,
            version=new_version,
            trace_id=state.get("thread_id"),
        )
        logger.info(
            "broadcast_success",
            show_id=state["show_id"],
            version=new_version,
            patches=len(quarantine_ids) + sum(len(v) for v in relocated_map.values()),
        )
        return {
            "sdui_version": new_version,
            "audit_trail": [f"broadcast_node_success: version={new_version}"],
        }
    except Exception as exc:
        # Non-critical: log but do not fail the graph
        logger.error("broadcast_failed", error=str(exc))
        return {
            "sdui_version": new_version,
            "audit_trail": [f"broadcast_node_error: {exc}"],
        }
