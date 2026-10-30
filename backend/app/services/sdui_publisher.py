"""
SDUI Publisher — real-time WebSocket fanout via Redis Pub/Sub.

After a successful DB commit, the broadcast_node calls this service to publish
RFC 6902 JSON Patch payloads to the Redis channel for a show. The WS gateway
(router/ws.py) subscribes to this channel and forwards patches to clients.

Why decouple publish from commit:
    The DB write and the WS push are on different failure domains.
    If the WS gateway is down, the DB write is already durable.
    The WS gateway reconnects to Redis and resumes — no data loss.
"""

from __future__ import annotations

import json
import time
from typing import Any
from uuid import uuid4

import structlog

from app.redis_client import get_redis

logger = structlog.get_logger(__name__)


def _channel(show_id: str) -> str:
    return f"channel:show:{show_id}:events"


def _build_seat_patch(seat_id: str, status: str, render_variant: str, interactive: bool, badge: str | None = None) -> dict[str, Any]:
    return {
        "op": "replace",
        "path": f"/seats/{seat_id}",
        "value": {
            "status": status,
            "interactive": interactive,
            "style": {
                "variant": render_variant,
                "badge": badge,
            },
        },
    }


async def publish_relocation_event(
    show_id: str,
    quarantine_seat_ids: list[str],
    relocated_seat_map: dict[str, list[str]],  # booking_id → new seat IDs
    version: int,
    trace_id: str | None = None,
) -> None:
    """
    Publish a UI_STATE_PATCH event for a completed relocation.

    Args:
        show_id: Identifies the Redis channel and client subscriptions.
        quarantine_seat_ids: Seats to render as MAINTENANCE_BLOCKED (red stripes).
        relocated_seat_map: New seat IDs per booking (rendered as BOOKED_UPGRADED).
        version: Monotonically increasing version for client deduplication.
        trace_id: Agent trace ID for observability cross-referencing.
    """
    redis = await get_redis()

    patches: list[dict[str, Any]] = []

    # Mark quarantined seats
    for seat_id in quarantine_seat_ids:
        patches.append(
            _build_seat_patch(
                seat_id=seat_id,
                status="MAINTENANCE_BLOCKED",
                render_variant="STRIPED_CRIMSON_HAZARD",
                interactive=False,
            )
        )

    # Mark upgraded seats
    for _booking_id, new_seat_ids in relocated_seat_map.items():
        for seat_id in new_seat_ids:
            patches.append(
                _build_seat_patch(
                    seat_id=seat_id,
                    status="BOOKED_UPGRADED",
                    render_variant="SOLID_SLATE",
                    interactive=False,
                    badge="VIP_UPGRADE",
                )
            )

    payload: dict[str, Any] = {
        "event": "UI_STATE_PATCH",
        "meta": {
            "trace_id": trace_id or f"tr_{uuid4().hex[:8]}",
            "timestamp": _iso_now(),
            "version": version,
            "show_id": show_id,
        },
        "patches": patches,
    }

    channel = _channel(show_id)
    await redis.publish(channel, json.dumps(payload))

    logger.info(
        "sdui_patch_published",
        show_id=show_id,
        channel=channel,
        patches=len(patches),
        version=version,
    )


async def publish_demand_alert(
    show_id: str,
    message: str,
    action_type: str,
    action_target: str,
    version: int,
) -> None:
    """
    Inject a PROMO_SNACK_BAR overlay into all active client viewports.
    Used by the proactive yield-optimization advisory node.
    """
    redis = await get_redis()

    payload: dict[str, Any] = {
        "event": "UI_STATE_PATCH",
        "meta": {
            "trace_id": f"tr_{uuid4().hex[:8]}",
            "timestamp": _iso_now(),
            "version": version,
            "show_id": show_id,
        },
        "patches": [
            {
                "op": "add",
                "path": "/injected_overlays/0",
                "value": {
                    "type": "BANNER_NOTIFICATION",
                    "variant": "EMERALD",
                    "text": message,
                    "action": {
                        "type": action_type,
                        "target_id": action_target,
                    },
                },
            }
        ],
    }

    channel = _channel(show_id)
    await redis.publish(channel, json.dumps(payload))
    logger.info("demand_alert_published", show_id=show_id, message=message)


def _iso_now() -> str:
    import datetime
    return datetime.datetime.now(datetime.timezone.utc).isoformat()
