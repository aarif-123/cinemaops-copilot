"""
Agent REST router — the HTTP API for the LangGraph agent.

Endpoints:
  POST /api/v1/agent/chat    — Start or continue an agent session
  POST /api/v1/agent/resume  — Resume a paused graph after admin approval
  GET  /api/v1/agent/status/{thread_id} — Poll current graph state
  POST /api/v1/agent/undo    — Rollback a committed journal entry

Design notes:
  - Every call that modifies state MUST have a valid admin JWT.
  - The graph runs in the request's async context (no background tasks needed
    for P99 < 2.5s target with Groq LPU).
  - On NodeInterrupt, returns HTTP 202 with the interrupt payload so the admin
    portal can render the HITL visual diff.
"""

from __future__ import annotations

import uuid
from typing import Any, Optional

import structlog
from fastapi import APIRouter, Depends, HTTPException, Request, status
from langgraph.errors import NodeInterrupt

from app.agent.state import initial_state
from app.db.mongodb_client import get_audit_log, rollback_journal
from app.middleware.auth import AuthenticatedAdmin, require_admin
from app.models.api import (
    AgentChatRequest,
    AgentChatResponse,
    AgentResumeRequest,
    AgentResumeResponse,
    AuditLogResponse,
    UndoRequest,
)

logger = structlog.get_logger(__name__)
router = APIRouter(prefix="/api/v1/agent", tags=["agent"])


def _get_graph(request: Request):
    """Retrieve the compiled LangGraph instance from app state."""
    graph = getattr(request.app.state, "graph", None)
    if graph is None:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Agent graph not initialised",
        )
    return graph


@router.post("/chat", response_model=AgentChatResponse, status_code=200)
async def agent_chat(
    body: AgentChatRequest,
    request: Request,
    admin: AuthenticatedAdmin = Depends(require_admin),
) -> AgentChatResponse:
    """
    Submit a natural-language operational command to the agent.

    Returns:
      - 200 with status="completed" for informational queries.
      - 200 with status="awaiting_approval" and hitl_payload for mutations.
      - 200 with status="error" on agent failure.
    """
    graph = _get_graph(request)
    thread_id = body.thread_id or str(uuid.uuid4())

    state = initial_state(
        show_id=body.show_id,
        screen_id="",  # resolved by inspect tool from show topology
        raw_prompt=body.message,
        thread_id=thread_id,
        admin_id=admin.admin_id,
    )

    config = {"configurable": {"thread_id": thread_id}}

    try:
        result_state = await graph.ainvoke(state, config=config)

        # Check if graph paused at hitl_gate (NodeInterrupt surfaces as interrupt_value)
        checkpoint = await graph.aget_state(config)
        if checkpoint and checkpoint.next and "hitl_gate" in checkpoint.next:
            # Graph is paused — extract the interrupt payload
            interrupt_values = [
                t.interrupts for t in (checkpoint.tasks or [])
            ]
            hitl_payload = interrupt_values[0][0].value if interrupt_values and interrupt_values[0] else {}

            return AgentChatResponse(
                thread_id=thread_id,
                checkpoint_id=str(checkpoint.config.get("configurable", {}).get("checkpoint_id", "")),
                status="awaiting_approval",
                message=(
                    f"I have formulated a relocation plan for "
                    f"{hitl_payload.get('impact_assessment', {}).get('parties_relocated', 0)} parties "
                    f"({hitl_payload.get('impact_assessment', {}).get('guests_total', 0)} guests). "
                    "Review the proposed Visual Diff and approve or reject."
                ),
                hitl_payload=hitl_payload,
            )

        # Graph completed normally
        exec_result = result_state.get("execution_result", {})
        error = result_state.get("error_trace")

        return AgentChatResponse(
            thread_id=thread_id,
            status="error" if error else "completed",
            message=error or exec_result.get("agent_message", "Operation complete."),
            execution_result=exec_result if not error else None,
        )

    except Exception as exc:
        logger.exception("agent_chat_error", thread_id=thread_id)
        return AgentChatResponse(
            thread_id=thread_id,
            status="error",
            message=f"Internal agent error: {exc!s}",
        )


@router.post("/resume", response_model=AgentResumeResponse)
async def agent_resume(
    body: AgentResumeRequest,
    request: Request,
    admin: AuthenticatedAdmin = Depends(require_admin),
) -> AgentResumeResponse:
    """
    Resume a paused agent graph after admin approval.

    The admin_signature field is the admin's JWT token — using the existing
    auth infrastructure as the cryptographic approval signal.
    """
    graph = _get_graph(request)
    config = {"configurable": {"thread_id": body.thread_id}}

    # Inject approval into the persisted checkpoint state
    update = {
        "admin_approval_granted": True,
        "admin_signature": body.admin_signature,
    }

    try:
        await graph.aupdate_state(config, update)
        result_state = await graph.ainvoke(None, config=config)

        exec_result = result_state.get("execution_result", {})
        error = result_state.get("error_trace")

        return AgentResumeResponse(
            thread_id=body.thread_id,
            status="error" if error else "committed",
            message=error or (
                f"Relocation committed. {exec_result.get('parties_relocated', 0)} parties relocated, "
                f"₹{exec_result.get('financial_delta_paisa', 0) / 100:.0f} in vouchers issued. "
                f"Journal ID: {exec_result.get('journal_id', 'N/A')}"
            ),
            execution_result=exec_result if not error else None,
        )

    except Exception as exc:
        logger.exception("agent_resume_error", thread_id=body.thread_id)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Failed to resume agent: {exc!s}",
        ) from exc


@router.get("/status/{thread_id}")
async def agent_status(
    thread_id: str,
    request: Request,
    admin: AuthenticatedAdmin = Depends(require_admin),
) -> dict[str, Any]:
    """Return the current state snapshot for a graph thread."""
    graph = _get_graph(request)
    config = {"configurable": {"thread_id": thread_id}}
    checkpoint = await graph.aget_state(config)

    if not checkpoint:
        raise HTTPException(status_code=404, detail="Thread not found")

    return {
        "thread_id": thread_id,
        "next_nodes": list(checkpoint.next),
        "status": "awaiting_approval" if checkpoint.next else "completed",
        "values": {
            k: v
            for k, v in checkpoint.values.items()
            if k not in ("audit_trail",)  # avoid leaking internal trace details
        },
    }


@router.get("/audit", response_model=AuditLogResponse)
async def get_audit(
    admin: AuthenticatedAdmin = Depends(require_admin),
    limit: int = 50,
) -> AuditLogResponse:
    """Return the operational audit log."""
    entries = await get_audit_log(limit=limit)
    return AuditLogResponse(entries=entries, total=len(entries))


@router.post("/undo")
async def undo_action(
    body: UndoRequest,
    admin: AuthenticatedAdmin = Depends(require_admin),
) -> dict[str, Any]:
    """
    Rollback a previous journal entry using the immutable audit snapshot.
    Guardrail 5: Atomic State Rollback.
    """
    result = await rollback_journal(body.journal_id, admin.admin_id)
    return {"status": "rolled_back", **result}
