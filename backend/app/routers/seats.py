"""
Seat topology and show management router.
Provides read-only endpoints for seat map data, occupancy stats, and show lists.
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException

from app.db.supabase_client import get_occupancy_telemetry, get_show_topology
from app.middleware.auth import AuthenticatedAdmin, require_admin
from app.models.api import SeatMapResponse

router = APIRouter(prefix="/api/v1/shows", tags=["shows"])


@router.get("/{show_id}/topology", response_model=SeatMapResponse)
async def get_topology(
    show_id: str,
    admin: AuthenticatedAdmin = Depends(require_admin),
) -> SeatMapResponse:
    """Return the full seat topology and occupancy for a show."""
    data = await get_show_topology(show_id)
    allocations = data.get("allocations", [])
    booked = sum(1 for a in allocations if a["status"] in ("BOOKED", "LOCKED_CART"))
    total = len(allocations)

    return SeatMapResponse(
        show_id=show_id,
        total_seats=total,
        allocated=allocations,
        occupancy_pct=round(booked / total * 100, 2) if total else 0,
    )


@router.get("/{show_id}/occupancy")
async def get_occupancy(
    show_id: str,
    admin: AuthenticatedAdmin = Depends(require_admin),
):
    """Return aggregate occupancy telemetry for a show."""
    return await get_occupancy_telemetry(show_id)
