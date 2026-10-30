"""
API request/response schemas (separate from domain models).

Keeping API schemas distinct from domain models allows the REST contract to
evolve independently from internal business objects.
"""

from __future__ import annotations

from typing import Any, Optional
from uuid import UUID

from pydantic import BaseModel, Field


# ─── Agent Chat ───────────────────────────────────────────────────────────────

class AgentChatRequest(BaseModel):
    show_id: str = Field(..., description="Show UUID the command applies to")
    message: str = Field(..., min_length=1, max_length=2000, description="Natural language command")
    thread_id: Optional[str] = Field(None, description="Existing thread to continue (optional)")


class AgentChatResponse(BaseModel):
    thread_id: str
    checkpoint_id: Optional[str] = None
    status: str  # "completed" | "awaiting_approval" | "error"
    message: str  # Human-readable agent response
    hitl_payload: Optional[dict[str, Any]] = None   # Populated when awaiting approval
    execution_result: Optional[dict[str, Any]] = None


class AgentResumeRequest(BaseModel):
    checkpoint_id: str
    admin_signature: str = Field(..., min_length=1, description="Admin JWT or explicit approval token")
    thread_id: str


class AgentResumeResponse(BaseModel):
    thread_id: str
    status: str
    execution_result: Optional[dict[str, Any]] = None
    message: str


# ─── Seat Map ────────────────────────────────────────────────────────────────

class SeatMapResponse(BaseModel):
    show_id: str
    total_seats: int
    allocated: list[dict[str, Any]]
    occupancy_pct: float


# ─── Audit Log ───────────────────────────────────────────────────────────────

class AuditLogResponse(BaseModel):
    entries: list[dict[str, Any]]
    total: int


class UndoRequest(BaseModel):
    journal_id: str = Field(..., description="UUID of the audit journal entry to undo")


# ─── WebSocket Events ─────────────────────────────────────────────────────────

class WsConnectAck(BaseModel):
    event: str = "CONNECTED"
    show_id: str
    snapshot_version: int


class UiStatePatch(BaseModel):
    """RFC 6902 JSON Patch event dispatched to clients after a mutation."""

    event: str = "UI_STATE_PATCH"
    meta: dict[str, Any]
    patches: list[dict[str, Any]]
