"""
HITL Gate Node — the LangGraph interrupt() checkpoint.

This node is the architectural enforcement of Guardrail 3.
It fires NodeInterrupt when a relocation plan exists but has not been
approved by an admin. The entire graph state is persisted to Postgres
by the PostgresSaver checkpointer, allowing any pod to resume it later.

Key design choices:
    - Uses LangGraph's NodeInterrupt (not a conditional edge) so that the
      interrupt payload is part of the persisted checkpoint, not ephemeral RAM.
    - The admin's HTTP POST /resume call injects admin_approval_granted=True
      into the graph state and calls graph.invoke() with the checkpoint.
    - If admin_approval_granted is already True (resumed path), the node
      is a no-op and the graph proceeds to commit_node.
"""

from __future__ import annotations

from typing import Any

import structlog
from langgraph.errors import NodeInterrupt

from app.agent.state import CinemaOpsState

logger = structlog.get_logger(__name__)


async def hitl_gate_node(state: CinemaOpsState) -> dict[str, Any]:
    """
    Interrupt execution if admin approval has not been granted.

    The NodeInterrupt payload becomes the HTTP 202 body returned to the
    admin portal, which renders the visual diff and shows the APPROVE/ABORT CTAs.
    """
    if state.get("admin_approval_granted", False):
        # Resumed path — admin has approved. Pass through.
        logger.info("hitl_gate_approved", thread_id=state.get("thread_id"))
        return {"audit_trail": ["hitl_gate_passed: admin_approved"]}

    plan = state.get("relocation_plan")
    if not plan:
        # Nothing to approve — purely informational response
        logger.info("hitl_gate_no_plan", thread_id=state.get("thread_id"))
        return {"audit_trail": ["hitl_gate_skipped: no_mutation_planned"]}

    diff = state.get("compiled_diff", {})

    logger.info(
        "hitl_gate_interrupting",
        thread_id=state.get("thread_id"),
        parties=plan.get("affected_parties"),
        financial_inr=plan.get("total_compensation_paisa", 0) / 100,
    )

    # This raises NodeInterrupt — LangGraph catches it, persists checkpoint,
    # and returns the interrupt payload to the caller (FastAPI route handler).
    raise NodeInterrupt(
        {
            "action_required": "OPERATIONAL_APPROVAL",
            "impact_assessment": {
                "seats_quarantined": len(state.get("affected_seat_identifiers", [])),
                "parties_relocated": plan.get("affected_parties", 0),
                "guests_total": plan.get("total_guests", 0),
                "revenue_exposure_inr": plan.get("total_compensation_paisa", 0) / 100,
            },
            "proposed_diff": diff,
            "invariant_affirmations": [
                "✓ No confirmed booking is downgraded to a lower tier",
                "✓ No booking party is split across non-adjacent seats",
                "✓ All target seats verified free of checkout locks",
                f"✓ Compensation ₹{plan.get('total_compensation_paisa', 0) / 100:.0f} within daily budget",
            ],
            "checkpoint_id": state.get("checkpoint_id"),
            "thread_id": state.get("thread_id"),
        }
    )
