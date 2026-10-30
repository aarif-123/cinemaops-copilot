"""
Supabase client wrapper.

Provides async-compatible access to Supabase PostgREST and RPC endpoints.
Business logic never imports supabase-py directly — it always goes through
this module, keeping the Supabase dependency swappable.
"""

from __future__ import annotations

import asyncio
from typing import Any
from uuid import UUID

import structlog
from supabase import Client, create_client

from app.config import get_settings

logger = structlog.get_logger(__name__)

_client: Client | None = None


def get_supabase() -> Client:
    """Return the singleton Supabase client (lazily initialised)."""
    global _client
    if _client is None:
        settings = get_settings()
        _client = create_client(settings.supabase_url, settings.supabase_service_key)
    return _client


# ─── Show & Seat Topology ────────────────────────────────────────────────────

async def get_show_topology(show_id: str) -> dict[str, Any]:
    """
    Return the full seat topology for a show including occupancy status.
    Joins: shows → screens → seats → ticket_allocations.
    """
    client = get_supabase()

    loop = asyncio.get_event_loop()

    def _fetch() -> dict:
        response = (
            client.table("ticket_allocations")
            .select(
                "id, status, price_cents, booking_id, "
                "seat:seats(id, row_label, col_index, tier, is_active), "
                "booking:bookings(id, user_id, party_size, status, voucher_code)"
            )
            .eq("show_id", show_id)
            .execute()
        )
        return {"show_id": show_id, "allocations": response.data}

    return await loop.run_in_executor(None, _fetch)


async def get_available_seats_by_tier(
    show_id: str,
    tier: str,
) -> list[dict[str, Any]]:
    """Return available seats in a specific tier for spatial solver input."""
    client = get_supabase()
    loop = asyncio.get_event_loop()

    def _fetch() -> list[dict]:
        response = (
            client.table("ticket_allocations")
            .select(
                "id, seat_id, status, price_cents, "
                "seat:seats(id, row_label, col_index, tier)"
            )
            .eq("show_id", show_id)
            .eq("status", "AVAILABLE")
            .eq("seat.tier", tier)
            .execute()
        )
        return response.data

    return await loop.run_in_executor(None, _fetch)


async def get_occupied_seats(
    show_id: str,
    seat_ids: list[str],
) -> list[dict[str, Any]]:
    """Return occupancy data for specific seat IDs within a show."""
    client = get_supabase()
    loop = asyncio.get_event_loop()

    def _fetch() -> list[dict]:
        response = (
            client.table("ticket_allocations")
            .select(
                "id, seat_id, status, booking_id, "
                "seat:seats(row_label, col_index, tier), "
                "booking:bookings(id, user_id, party_size)"
            )
            .eq("show_id", show_id)
            .in_("seat_id", seat_ids)
            .neq("status", "AVAILABLE")
            .execute()
        )
        return response.data

    return await loop.run_in_executor(None, _fetch)


async def get_occupancy_telemetry(show_id: str) -> dict[str, Any]:
    """Return aggregate occupancy stats for a show (for proactive advisory)."""
    client = get_supabase()
    loop = asyncio.get_event_loop()

    def _fetch() -> dict:
        response = (
            client.table("ticket_allocations")
            .select("status", count="exact")
            .eq("show_id", show_id)
            .execute()
        )
        total = response.count or 0
        booked = sum(1 for r in response.data if r["status"] in ("BOOKED", "LOCKED_CART"))
        return {
            "show_id": show_id,
            "total_seats": total,
            "booked": booked,
            "available": total - booked,
            "occupancy_pct": round(booked / total * 100, 2) if total else 0,
        }

    return await loop.run_in_executor(None, _fetch)


# ─── Audit Journal ────────────────────────────────────────────────────────────

async def get_audit_log(
    admin_id: str | None = None,
    limit: int = 50,
) -> list[dict[str, Any]]:
    """Retrieve the operational audit log, optionally filtered by admin."""
    client = get_supabase()
    loop = asyncio.get_event_loop()

    def _fetch() -> list[dict]:
        query = (
            client.table("operational_audit_journal")
            .select("*")
            .order("timestamp", desc=True)
            .limit(limit)
        )
        if admin_id:
            query = query.eq("admin_id", admin_id)
        return query.execute().data

    return await loop.run_in_executor(None, _fetch)


# ─── RPC: Atomic Mutations (called only by TransactionCoordinator) ────────────

async def rpc_apply_relocation(payload: dict[str, Any]) -> dict[str, Any]:
    """
    Invoke the apply_relocation_plan Postgres stored procedure.
    Runs atomically inside a single DB transaction.
    """
    client = get_supabase()
    loop = asyncio.get_event_loop()

    def _call() -> dict:
        response = client.rpc("apply_relocation_plan", payload).execute()
        if not response.data:
            raise RuntimeError("RPC apply_relocation_plan returned empty response")
        return response.data

    return await loop.run_in_executor(None, _call)


async def rpc_rollback_journal(journal_id: str, admin_id: str) -> dict[str, Any]:
    """Invoke the rollback_journal_entry Postgres stored procedure."""
    client = get_supabase()
    loop = asyncio.get_event_loop()

    def _call() -> dict:
        response = client.rpc(
            "rollback_journal_entry",
            {"p_journal_id": journal_id, "p_admin_id": admin_id},
        ).execute()
        if not response.data:
            raise RuntimeError("RPC rollback_journal_entry returned empty response")
        return response.data

    return await loop.run_in_executor(None, _call)
