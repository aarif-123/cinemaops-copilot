"""
WebSocket router — real-time seat map updates via Redis Pub/Sub.

Each WebSocket connection subscribes to a show-specific Redis channel.
When the broadcast_node publishes a UI_STATE_PATCH event, this gateway
forwards it to all active WS clients for that show.

Connection lifecycle:
  1. Client connects with a valid JWT query param.
  2. Server sends full seat map snapshot (HTTP-level data, not WS-level).
  3. Server subscribes to Redis channel for the show.
  4. Redis messages are forwarded verbatim to the client.
  5. On disconnect, Redis subscription is cancelled.

Why FastAPI WS + Redis Pub/Sub (not SSE):
  - Full-duplex: client can send heartbeats or cancel requests.
  - Single Redis Pub/Sub call fans out to all pods subscribed to the channel.
  - The client only needs to apply RFC 6902 patches — no polling.
"""

from __future__ import annotations

import asyncio
import json

import structlog
from fastapi import APIRouter, Depends, WebSocket, WebSocketDisconnect

from app.db.mongodb_client import get_show_topology
from app.middleware.auth import AuthenticatedAdmin, ws_auth
from app.redis_client import get_redis

logger = structlog.get_logger(__name__)
router = APIRouter(tags=["websocket"])


@router.websocket("/ws/show/{show_id}")
async def show_websocket(
    websocket: WebSocket,
    show_id: str,
    admin: AuthenticatedAdmin = Depends(ws_auth),
) -> None:
    """
    WebSocket endpoint for real-time seat map updates.

    Connects to Redis Pub/Sub for show:{show_id}:events and forwards
    UI_STATE_PATCH payloads to the client as JSON text frames.
    """
    await websocket.accept()
    logger.info("ws_connected", show_id=show_id, admin_id=admin.admin_id)

    # Send initial seat map snapshot
    try:
        topology = await get_show_topology(show_id)
        await websocket.send_json({
            "event": "INITIAL_SNAPSHOT",
            "show_id": show_id,
            "data": topology,
        })
    except Exception as exc:
        logger.warning("ws_snapshot_failed", show_id=show_id, error=str(exc))

    # Subscribe to Redis channel for this show
    redis = await get_redis()
    pubsub = redis.pubsub()
    channel = f"channel:show:{show_id}:events"
    await pubsub.subscribe(channel)

    # Concurrent: forward Redis messages to WS + listen for WS close
    async def redis_forwarder() -> None:
        async for message in pubsub.listen():
            if message["type"] != "message":
                continue
            try:
                await websocket.send_text(message["data"])
            except WebSocketDisconnect:
                break
            except Exception as exc:
                logger.warning("ws_send_failed", error=str(exc))
                break

    forwarder_task = asyncio.create_task(redis_forwarder())

    try:
        # Wait for client to disconnect (or send a ping frame)
        while True:
            data = await websocket.receive_text()
            if data == "ping":
                await websocket.send_text(json.dumps({"event": "pong"}))
    except WebSocketDisconnect:
        logger.info("ws_disconnected", show_id=show_id)
    finally:
        forwarder_task.cancel()
        await pubsub.unsubscribe(channel)
        await pubsub.close()
