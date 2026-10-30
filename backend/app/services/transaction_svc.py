"""
Transaction Coordinator — atomic mutation orchestrator.

Wraps the Postgres stored procedure calls so that:
  1. Redlock holds are acquired before the DB write.
  2. The DB write is atomic (entire relocation or nothing).
  3. Locks are always released in the `finally` block.
  4. The audit journal is written inside the same DB transaction.

The agent graph's commit_node calls ONLY this module — it has no direct
Supabase client import, preserving the I/O boundary.
"""

from __future__ import annotations

import asyncio
import uuid
from typing import Any

import structlog

from app.config import get_settings
from app.db.supabase_client import rpc_apply_relocation, rpc_rollback_journal
from app.models.domain import RelocationPlan
from app.services.lock_manager import get_lock_manager

logger = structlog.get_logger(__name__)


class TransactionCoordinator:
    """Orchestrates lock acquisition → atomic DB write → lock release."""

    def __init__(self) -> None:
        self._settings = get_settings()
        self._lock_mgr = get_lock_manager()

    async def apply_relocation(
        self,
        plan: RelocationPlan,
        show_id: str,
        admin_id: str,
        thread_id: str,
        prompt_intent: str,
    ) -> dict[str, Any]:
        """
        Execute the relocation plan atomically.

        Flow:
          1. Collect all target seat IDs across all relocations.
          2. Acquire Redlock holds on target seats.
          3. Call Postgres RPC (atomic: quarantine + relocate + audit).
          4. Release locks (always, even on error).

        Returns: dict with journal_id and financial summary.
        Raises: RuntimeError on DB failure (triggers LangGraph error edge).
        """
        # Validate fiscal guardrails BEFORE touching any infrastructure
        plan.validate_fiscal_guardrails(
            max_voucher_paisa=self._settings.max_voucher_value_paisa,
            daily_budget_paisa=self._settings.daily_voucher_budget_paisa,
        )

        all_target_ids = [
            sid
            for reloc in plan.relocations
            for sid in reloc.target_seat_ids
        ]

        # Generate a deterministic voucher code from thread_id
        voucher = f"AGENT-{thread_id[:8].upper()}-COMP"

        async with self._lock_mgr.acquire_relocation_holds(show_id, all_target_ids):
            logger.info(
                "applying_relocation_plan",
                show_id=show_id,
                parties=plan.affected_parties,
                guests=plan.total_guests_relocated,
                financial_delta_paisa=plan.total_compensation_paisa,
            )

            rpc_payload = {
                "p_show_id": show_id,
                "p_quarantine_ids": plan.quarantine_seat_ids,
                "p_relocations": [r.to_rpc_dict() for r in plan.relocations],
                "p_voucher_code": voucher,
                "p_admin_id": admin_id,
                "p_thread_id": thread_id,
                "p_prompt_intent": prompt_intent,
                "p_financial_delta": plan.total_compensation_paisa,
            }

            result = await rpc_apply_relocation(rpc_payload)

            logger.info(
                "relocation_committed",
                journal_id=result.get("journal_id"),
                seats_blocked=result.get("seats_blocked"),
            )

            return {
                "journal_id": str(result.get("journal_id", "")),
                "voucher_code": voucher,
                "seats_blocked": result.get("seats_blocked", 0),
                "parties_relocated": plan.affected_parties,
                "total_guests": plan.total_guests_relocated,
                "financial_delta_paisa": plan.total_compensation_paisa,
            }

    async def rollback(self, journal_id: str, admin_id: str) -> dict[str, Any]:
        """
        Reverse a previous relocation using the immutable audit snapshot.
        Guardrail 5 (Atomic State Rollback).
        """
        logger.info("rollback_initiated", journal_id=journal_id, admin_id=admin_id)
        result = await rpc_rollback_journal(journal_id, admin_id)
        logger.info("rollback_committed", undo_journal_id=result.get("undo_journal_id"))
        return result


_coordinator: TransactionCoordinator | None = None


def get_transaction_coordinator() -> TransactionCoordinator:
    global _coordinator
    if _coordinator is None:
        _coordinator = TransactionCoordinator()
    return _coordinator
