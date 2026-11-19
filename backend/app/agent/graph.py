"""
CinemaOps LangGraph StateGraph — the compiled agent workflow.

Node topology:
    intent_parser ──> hitl_gate ──┬──(approved)──> commit ──> broadcast ──> END
                                  └──(rejected)──> END

The graph uses MongoDBSaver for checkpoint persistence.
This allows:
  - Any pod to resume a paused graph after admin approval.
  - Full replay audit of every execution step.
  - Automatic state recovery after pod restarts.

Why compile()? LangGraph validates the full edge topology at startup,
catching missing node wires before a user request ever arrives.
"""

from __future__ import annotations

from functools import lru_cache

import structlog
from langgraph.checkpoint.mongodb.aio import AsyncMongoDBSaver
from langgraph.graph import END, StateGraph

from app.agent.nodes.broadcast_node import broadcast_node
from app.agent.nodes.commit_node import commit_node
from app.agent.nodes.hitl_gate import hitl_gate_node
from app.agent.nodes.intent_parser import intent_parser_node
from app.agent.state import CinemaOpsState
from app.config import get_settings

logger = structlog.get_logger(__name__)


def _has_plan(state: CinemaOpsState) -> str:
    """Conditional edge: route based on whether there is a plan awaiting approval."""
    if state.get("error_trace"):
        return "end_with_error"
    if state.get("relocation_plan") and state.get("admin_approval_granted"):
        return "commit"
    if state.get("relocation_plan") and not state.get("admin_approval_granted"):
        return "hitl"
    # Purely informational response — no mutation planned
    return "end_informational"


def _post_commit_route(state: CinemaOpsState) -> str:
    """Route to broadcast on success, or END on commit error."""
    if state.get("error_trace"):
        return "end_with_error"
    return "broadcast"


def build_graph() -> StateGraph:
    """Construct the LangGraph StateGraph (not yet compiled — no checkpointer needed)."""
    builder = StateGraph(CinemaOpsState)

    builder.add_node("intent_parser", intent_parser_node)
    builder.add_node("hitl_gate", hitl_gate_node)
    builder.add_node("commit", commit_node)
    builder.add_node("broadcast", broadcast_node)

    builder.set_entry_point("intent_parser")

    builder.add_conditional_edges(
        "intent_parser",
        _has_plan,
        {
            "hitl": "hitl_gate",
            "commit": "commit",            # resume path (admin already approved)
            "end_informational": END,
            "end_with_error": END,
        },
    )

    # hitl_gate either raises NodeInterrupt (pauses graph) or passes through
    builder.add_conditional_edges(
        "hitl_gate",
        _has_plan,
        {
            "commit": "commit",
            "hitl": END,                   # Should not reach here; interrupt fires
            "end_informational": END,
            "end_with_error": END,
        },
    )

    builder.add_conditional_edges(
        "commit",
        _post_commit_route,
        {
            "broadcast": "broadcast",
            "end_with_error": END,
        },
    )

    builder.add_edge("broadcast", END)

    return builder


async def get_compiled_graph(conn_string: str, database_name: str):
    """
    Compile the graph with AsyncMongoDBSaver for checkpoint persistence.
    Called once during application startup lifespan.
    """
    checkpointer_context = AsyncMongoDBSaver.from_conn_string(conn_string, database_name)
    checkpointer = await checkpointer_context.__aenter__()

    graph = build_graph().compile(checkpointer=checkpointer, interrupt_before=["hitl_gate"])

    logger.info("langgraph_compiled", nodes=list(graph.nodes.keys()))
    return graph, checkpointer_context
