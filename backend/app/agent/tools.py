"""
LangGraph tool definitions — the authority matrix enforced in code.

The LLM can ONLY call functions defined here. There is no "write to database"
tool. This is the technical enforcement of the Tier 1/2/3 authority boundary:

  Tier 1 (read-only, autonomous):
    - inspect_seat_cluster
    - check_redis_locks
    - get_occupancy_telemetry

  Tier 2 (plan generation, no write):
    - solve_relocations

All tools use strict JSON Schema binding via @tool decorator.
The LLM receives only the schema — it never sees implementation code.
"""

from __future__ import annotations

import json
from typing import Any

import structlog
from langchain_core.tools import tool

from app.db.mongodb_client import (
    get_occupied_seats,
    get_occupancy_telemetry,
    get_show_topology,
)
from app.models.domain import (
    BookingRecord,
    BookingStatus,
    CompensationType,
    SeatTier,
)
from app.services.lock_manager import get_lock_manager
from app.services.spatial_solver import SpatialAdjacencySolver, build_layout_from_raw

logger = structlog.get_logger(__name__)


# ─── Tier 1 Tools (Read-only, Autonomous) ────────────────────────────────────

@tool
async def inspect_seat_cluster(
    show_id: str,
    seat_labels: list[str],
) -> str:
    """
    Inspect a cluster of seats (by row-col label e.g. 'E8', 'F14') for a show.
    Returns occupancy status, booking party info, and current tier.
    This is a READ-ONLY operation. No state is mutated.

    Args:
        show_id: UUID of the show to inspect.
        seat_labels: List of seat labels in format 'RowCol' e.g. ['E8', 'F14'].

    Returns:
        JSON string with seat occupancy data and impacted booking parties.
    """
    logger.info("tool:inspect_seat_cluster", show_id=show_id, labels=seat_labels)

    topology = await get_show_topology(show_id)
    allocations = topology.get("allocations", [])

    # Parse labels into (row, col) tuples
    def parse_label(label: str) -> tuple[str, int]:
        row = label[0].upper()
        col = int(label[1:])
        return row, col

    label_coords = {parse_label(lbl): lbl for lbl in seat_labels}

    result: dict[str, Any] = {
        "show_id": show_id,
        "inspected_count": len(seat_labels),
        "seats": [],
        "impacted_bookings": {},
        "seat_uuids": [],
    }

    for alloc in allocations:
        seat = alloc.get("seat", {})
        if not seat:
            continue
        coord = (seat["row_label"].strip(), seat["col_index"])
        if coord not in label_coords:
            continue

        entry = {
            "label": label_coords[coord],
            "seat_id": seat["id"],
            "tier": seat["tier"],
            "status": alloc["status"],
            "booking_id": alloc.get("booking_id"),
        }
        result["seats"].append(entry)
        result["seat_uuids"].append(seat["id"])

        booking = alloc.get("booking")
        if booking and alloc.get("booking_id"):
            bid = alloc["booking_id"]
            if bid not in result["impacted_bookings"]:
                result["impacted_bookings"][bid] = {
                    "booking_id": bid,
                    "party_size": booking.get("party_size", 1),
                    "status": booking.get("status"),
                    "seat_labels": [],
                    "seat_ids": [],
                }
            result["impacted_bookings"][bid]["seat_labels"].append(label_coords[coord])
            result["impacted_bookings"][bid]["seat_ids"].append(seat["id"])

    result["impacted_bookings"] = list(result["impacted_bookings"].values())
    return json.dumps(result)


@tool
async def check_redis_locks(show_id: str, seat_ids: list[str]) -> str:
    """
    Check whether any of the given seat UUIDs are currently locked by
    active customer checkout sessions in Redis.
    Returns list of conflicting seat IDs (empty = safe to plan).

    Args:
        show_id: UUID of the show.
        seat_ids: List of seat UUID strings to check.
    """
    logger.info("tool:check_redis_locks", show_id=show_id, count=len(seat_ids))
    conflicts = await get_lock_manager().check_active_locks(show_id, seat_ids)
    return json.dumps({"show_id": show_id, "conflicts": conflicts, "safe": len(conflicts) == 0})


@tool
async def get_occupancy_telemetry(show_id: str) -> str:
    """
    Get real-time occupancy statistics for a show.
    Used for proactive yield-optimization advisory.

    Args:
        show_id: UUID of the show.

    Returns:
        JSON with total seats, booked count, available count, occupancy_pct.
    """
    logger.info("tool:get_occupancy_telemetry", show_id=show_id)
    data = await get_occupancy_telemetry(show_id)
    return json.dumps(data)


# ─── Tier 2 Tools (Plan generation — no write) ───────────────────────────────

@tool
async def solve_relocations(
    show_id: str,
    quarantine_seat_ids: list[str],
    impacted_booking_data: list[dict],
    target_tier: str,
    compensation_type: str,
) -> str:
    """
    Given a set of seat UUIDs to quarantine and their impacted bookings,
    compute a zero-split contiguous relocation plan to the target tier.
    This is a PLANNING-ONLY operation. Nothing is written to the database.

    Args:
        show_id: UUID of the show.
        quarantine_seat_ids: Seat UUIDs to block.
        impacted_booking_data: List of dicts with booking_id, party_size,
                               seat_ids, show_id, user_id, status, version.
        target_tier: Destination tier: STANDARD | PRIME | LUXURY_RECLINER.
        compensation_type: FNB_VOUCHER_200 | FNB_VOUCHER_250 | FULL_REFUND.

    Returns:
        JSON with the relocation plan or an error if constraints cannot be met.
    """
    logger.info(
        "tool:solve_relocations",
        show_id=show_id,
        quarantine_count=len(quarantine_seat_ids),
        target_tier=target_tier,
    )

    try:
        tier = SeatTier(target_tier)
        comp = CompensationType(compensation_type)
    except ValueError as exc:
        return json.dumps({"error": str(exc)})

    # Load full topology for spatial solver
    topology = await get_show_topology(show_id)
    layout = build_layout_from_raw(topology.get("allocations", []))

    # Build BookingRecord objects from agent-supplied data
    bookings = [
        BookingRecord(
            booking_id=b["booking_id"],
            show_id=show_id,
            user_id=b.get("user_id", ""),
            party_size=b["party_size"],
            status=BookingStatus(b.get("status", "CONFIRMED")),
            seat_ids=b.get("seat_ids", []),
            version=b.get("version", 1),
        )
        for b in impacted_booking_data
    ]

    try:
        solver = SpatialAdjacencySolver(layout)
        plan = solver.solve(
            bookings=bookings,
            target_tier=tier,
            compensation_type=comp,
            quarantine_seat_ids=quarantine_seat_ids,
        )
    except Exception as exc:
        logger.warning("solver_failed", error=str(exc))
        return json.dumps({"error": str(exc)})

    # Serialise plan for state storage
    plan_dict = {
        "show_id": plan.show_id,
        "quarantine_seat_ids": plan.quarantine_seat_ids,
        "total_compensation_paisa": plan.total_compensation_paisa,
        "affected_parties": plan.affected_parties,
        "total_guests": plan.total_guests_relocated,
        "voucher_code": plan.voucher_code,
        "relocations": [
            {
                "booking_id": r.booking_id,
                "party_size": r.party_size,
                "source_seat_ids": r.source_seat_ids,
                "target_seat_ids": r.target_seat_ids,
                "source_tier": r.source_tier.value,
                "target_tier": r.target_tier.value,
                "is_upgrade": r.is_tier_upgrade,
                "compensation_paisa": r.compensation_value_paisa,
            }
            for r in plan.relocations
        ],
    }

    return json.dumps({"plan": plan_dict})


# Registry for use in the LangGraph agent node
ALL_TOOLS = [inspect_seat_cluster, check_redis_locks, get_occupancy_telemetry, solve_relocations]
