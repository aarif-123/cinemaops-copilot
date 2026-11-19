"""
Commit Node — atomic database mutation (post-HITL approval only).

This node only executes after admin_approval_granted=True.
It delegates entirely to TransactionCoordinator, which:
  1. Validates fiscal guardrails
  2. Acquires Redlock holds on target seats
  3. Calls the MongoDB transaction (atomic)
  4. Releases locks
  5. Returns journal_id for the audit trail

On any failure, the exception propagates to the LangGraph error edge,
which logs it and returns an error state — no partial writes occur.
"""

from __future__ import annotations

import json
from typing import Any

import structlog

from app.agent.state import CinemaOpsState
from app.models.domain import (
    BookingRecord,
    BookingStatus,
    CompensationType,
    RelocationPlan,
    BookingRelocation,
    SeatTier,
)
from app.services.transaction_svc import get_transaction_coordinator

logger = structlog.get_logger(__name__)


async def commit_node(state: CinemaOpsState) -> dict[str, Any]:
    """
    Execute the relocation plan atomically.
    Returns execution_result with journal_id and financial summary.
    """
    plan_dict = state.get("relocation_plan")
    if not plan_dict:
        return {
            "error_trace": "commit_node: no relocation plan in state",
            "audit_trail": ["commit_node_aborted: no_plan"],
        }

    # Reconstruct typed RelocationPlan from the serialised dict
    plan = _deserialise_plan(plan_dict)

    coordinator = get_transaction_coordinator()
    try:
        result = await coordinator.apply_relocation(
            plan=plan,
            show_id=state["show_id"],
            admin_id=state["admin_id"],
            thread_id=state["thread_id"],
            prompt_intent=state["raw_prompt"],
        )
        logger.info("commit_successful", journal_id=result.get("journal_id"))
        return {
            "execution_result": result,
            "audit_trail": [f"commit_node_success: journal={result.get('journal_id')}"],
        }
    except Exception as exc:
        logger.exception("commit_failed")
        return {
            "error_trace": f"Commit failed: {exc}",
            "audit_trail": ["commit_node_failed"],
        }


def _deserialise_plan(plan_dict: dict) -> RelocationPlan:
    """Reconstruct a RelocationPlan from the JSON-serialisable dict stored in state."""
    relocations = [
        BookingRelocation(
            booking_id=r["booking_id"],
            party_size=r["party_size"],
            source_seat_ids=r["source_seat_ids"],
            target_seat_ids=r["target_seat_ids"],
            source_tier=SeatTier(r["source_tier"]),
            target_tier=SeatTier(r["target_tier"]),
            compensation_value_paisa=r.get("compensation_paisa", 0),
        )
        for r in plan_dict.get("relocations", [])
    ]
    return RelocationPlan(
        show_id=plan_dict["show_id"],
        quarantine_seat_ids=plan_dict.get("quarantine_seat_ids", []),
        relocations=relocations,
        voucher_code=plan_dict.get("voucher_code", "AGENT-COMP"),
        total_compensation_paisa=plan_dict.get("total_compensation_paisa", 0),
    )
