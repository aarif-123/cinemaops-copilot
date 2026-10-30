"""
Intent Parser Node — the LLM reasoning layer.

Groq Llama 3.3 70B processes the admin's natural language command and:
  1. Classifies the incident type.
  2. Extracts seat coordinate ranges.
  3. Selects the appropriate Tier 1/2 tool.
  4. Parses tool responses and updates state.

The node runs iteratively until all tool calls are resolved (ReAct loop),
up to a configurable max_iterations limit to prevent infinite loops.
"""

from __future__ import annotations

import json
from typing import Any

import structlog
from langchain_core.messages import AIMessage, HumanMessage, SystemMessage, ToolMessage
from langchain_groq import ChatGroq

from app.agent.state import CinemaOpsState
from app.agent.tools import ALL_TOOLS
from app.config import get_settings

logger = structlog.get_logger(__name__)

SYSTEM_PROMPT = """You are CinemaOps Copilot, an enterprise-grade theater operations assistant.

Your role is to PARSE operational commands, INSPECT seat data using tools, and PLAN relocations.
You NEVER write to any database directly — you only call planning tools.

AUTHORITY MATRIX:
- inspect_seat_cluster: Read seat occupancy (always safe, use first)
- check_redis_locks: Verify no checkout conflicts on target seats
- get_occupancy_telemetry: Get show-level stats for advisory
- solve_relocations: Compute a zero-split contiguous relocation plan (planning only)

WORKFLOW for a quarantine/relocation command:
1. Call inspect_seat_cluster to identify impacted bookings and seat UUIDs
2. Call check_redis_locks on the seat UUIDs to verify no conflicts
3. Call solve_relocations with the booking data to produce a contiguous relocation plan
4. Summarize your findings clearly for the admin

GUARDRAILS (never violate):
- Never suggest downgrading a customer to a lower tier
- Never split a booking party across non-adjacent seats
- If fiscal cap would be exceeded, state it explicitly and halt
- If contiguous seats are unavailable, say so clearly — do not fabricate seat assignments

Be concise. Format responses as clear operational summaries for theater managers.
Always end with: the number of parties affected, total guests, and financial exposure.
"""


async def intent_parser_node(state: CinemaOpsState) -> dict[str, Any]:
    """
    ReAct loop: call Groq, execute tools iteratively until a final answer is produced.
    Returns state updates with parsed intent and relocation plan.
    """
    settings = get_settings()
    llm = ChatGroq(
        api_key=settings.groq_api_key,
        model=settings.groq_model,
        temperature=0,           # deterministic responses for operational context
        max_tokens=4096,
    ).bind_tools(ALL_TOOLS)

    messages = [
        SystemMessage(content=SYSTEM_PROMPT),
        HumanMessage(content=f"Show ID: {state['show_id']}\n\n{state['raw_prompt']}"),
    ]

    state_updates: dict[str, Any] = {
        "audit_trail": [f"intent_parser_started: {state['raw_prompt'][:80]}"],
    }

    for iteration in range(settings.agent_max_iterations):
        logger.info("llm_iteration", iteration=iteration, show_id=state["show_id"])

        response: AIMessage = await llm.ainvoke(messages)
        messages.append(response)

        # No tool calls → LLM has produced a final answer
        if not response.tool_calls:
            state_updates["audit_trail"] = [
                f"intent_parser_completed: {len(messages)} messages, {iteration + 1} iterations"
            ]

            # Extract plan from last solve_relocations tool response if available
            plan = _extract_plan_from_messages(messages)
            if plan:
                state_updates["relocation_plan"] = plan
                state_updates["compiled_diff"] = _build_diff(plan)
                state_updates["affected_seat_identifiers"] = plan.get("quarantine_seat_ids", [])

                # Extract impacted_bookings from inspect result
                impacted = _extract_impacted_bookings(messages)
                if impacted:
                    state_updates["impacted_bookings"] = impacted

            # Surface the LLM's text response for the admin UI
            state_updates["execution_result"] = {
                "agent_message": response.content,
                "status": "plan_ready" if plan else "informational",
            }
            return state_updates

        # Execute tool calls and append results
        for tool_call in response.tool_calls:
            tool_result = await _execute_tool(tool_call)
            messages.append(
                ToolMessage(
                    content=tool_result,
                    tool_call_id=tool_call["id"],
                )
            )
            state_updates["audit_trail"] = [
                f"tool_executed: {tool_call['name']} → {tool_result[:100]}"
            ]

    # Max iterations reached — surface a safe fallback
    logger.warning("max_iterations_reached", show_id=state["show_id"])
    return {
        "error_trace": "Agent reached maximum iterations without completing plan.",
        "audit_trail": ["intent_parser_max_iterations_reached"],
    }


async def _execute_tool(tool_call: dict[str, Any]) -> str:
    """Dispatch a tool call to the correct function and return its string result."""
    tool_map = {t.name: t for t in ALL_TOOLS}
    tool_name = tool_call["name"]

    if tool_name not in tool_map:
        return json.dumps({"error": f"Unknown tool: {tool_name}"})

    try:
        result = await tool_map[tool_name].ainvoke(tool_call["args"])
        return result if isinstance(result, str) else json.dumps(result)
    except Exception as exc:
        logger.exception("tool_execution_error", tool=tool_name)
        return json.dumps({"error": str(exc)})


def _extract_plan_from_messages(messages: list) -> dict | None:
    """Scan ToolMessages for the last solve_relocations result."""
    for msg in reversed(messages):
        if isinstance(msg, ToolMessage):
            try:
                data = json.loads(msg.content)
                if "plan" in data:
                    return data["plan"]
            except (json.JSONDecodeError, TypeError):
                continue
    return None


def _extract_impacted_bookings(messages: list) -> list[dict] | None:
    """Scan ToolMessages for the inspect_seat_cluster impacted_bookings list."""
    for msg in reversed(messages):
        if isinstance(msg, ToolMessage):
            try:
                data = json.loads(msg.content)
                if "impacted_bookings" in data:
                    return data["impacted_bookings"]
            except (json.JSONDecodeError, TypeError):
                continue
    return None


def _build_diff(plan: dict) -> dict:
    """Construct a structured visual diff payload for the HITL modal."""
    return {
        "quarantine": {
            "seat_ids": plan.get("quarantine_seat_ids", []),
            "render": "STRIPED_CRIMSON_HAZARD",
        },
        "relocations": [
            {
                "booking_id": r["booking_id"],
                "party_size": r["party_size"],
                "from_seats": r["source_seat_ids"],
                "to_seats": r["target_seat_ids"],
                "tier_change": f"{r['source_tier']} → {r['target_tier']}",
                "compensation_inr": r["compensation_paisa"] / 100,
            }
            for r in plan.get("relocations", [])
        ],
        "financial_summary": {
            "total_vouchers_inr": plan.get("total_compensation_paisa", 0) / 100,
            "parties_affected": plan.get("affected_parties", 0),
            "guests_relocated": plan.get("total_guests", 0),
        },
    }
