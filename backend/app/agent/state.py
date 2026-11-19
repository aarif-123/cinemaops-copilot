"""
CinemaOpsState — the single source of truth for the LangGraph pipeline.

Every node in the graph reads from and writes to this TypedDict.
The `audit_trail` field uses an `operator.add` reducer so each node
appends entries rather than overwriting — preserving the complete
execution trace for LangSmith observability.
"""

from __future__ import annotations

import operator
from typing import Annotated, Any, Optional

from typing_extensions import TypedDict

from app.models.domain import BookingRecord, RelocationPlan


class CinemaOpsState(TypedDict):
    # ── Input context ─────────────────────────────────────────────────────────
    show_id: str
    screen_id: str
    raw_prompt: str
    thread_id: str
    admin_id: str

    # ── Parsed intent ─────────────────────────────────────────────────────────
    incident_type: str               # e.g. "HVAC_FAILURE"
    affected_seat_labels: list[str]  # e.g. ["E8","E9",…,"F14"]
    target_tier: str                 # e.g. "LUXURY_RECLINER"
    compensation_type: str           # e.g. "FNB_VOUCHER_200"

    # ── Constraint evaluation results ─────────────────────────────────────────
    affected_seat_identifiers: list[str]    # UUIDs resolved from labels
    impacted_bookings: list[dict[str, Any]] # raw booking records from DB
    redis_conflicts: list[str]              # seat IDs with active checkout locks

    # ── Relocation plan (set by constraint_eval node) ─────────────────────────
    relocation_plan: Optional[dict[str, Any]]   # serialised RelocationPlan
    compiled_diff: Optional[dict[str, Any]]     # human-readable diff for HITL

    # ── HITL gate ─────────────────────────────────────────────────────────────
    admin_approval_granted: bool
    admin_signature: Optional[str]
    approval_checkpoint_id: Optional[str]

    # ── Execution results (set by commit_node) ────────────────────────────────
    execution_result: Optional[dict[str, Any]]
    sdui_version: int                           # monotonically increasing version

    # ── Error handling ────────────────────────────────────────────────────────
    error_trace: Optional[str]
    system_conflicts: list[str]

    # ── Telemetry (reducer: each node appends, never overwrites) ──────────────
    audit_trail: Annotated[list[str], operator.add]


def initial_state(
    show_id: str,
    screen_id: str,
    raw_prompt: str,
    thread_id: str,
    admin_id: str,
) -> CinemaOpsState:
    """Factory for a clean initial state. Prevents partial TypedDict construction."""
    return CinemaOpsState(
        show_id=show_id,
        screen_id=screen_id,
        raw_prompt=raw_prompt,
        thread_id=thread_id,
        admin_id=admin_id,
        incident_type="",
        affected_seat_labels=[],
        target_tier="LUXURY_RECLINER",
        compensation_type="FNB_VOUCHER_200",
        affected_seat_identifiers=[],
        impacted_bookings=[],
        redis_conflicts=[],
        relocation_plan=None,
        compiled_diff=None,
        admin_approval_granted=False,
        admin_signature=None,
        approval_checkpoint_id=None,
        execution_result=None,
        sdui_version=1,
        error_trace=None,
        system_conflicts=[],
        audit_trail=[],
    )
