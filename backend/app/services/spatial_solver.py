"""
Spatial Adjacency Solver — deterministic group-preserving seat placement.

The LLM never performs seat arithmetic. This module is the sole authority on
whether a contiguous block exists in the target tier.

Algorithm: Bin-Packing + 1D Sliding Window + Center-Alignment Heuristic.
  1. Sort parties descending by size (largest first) to reduce fragmentation.
  2. For each party, scan rows in the target tier using a sliding window of
     width == party_size over column-sorted available seats.
  3. Among all valid contiguous windows, choose the one closest to the row
     midpoint (center-alignment heuristic: better sight lines for customers).
  4. If no tier has enough contiguous seats, try the next permitted tier
     (only upward — no downgrades, per Guardrail 1).

Complexity: O(P × R × C) where P = parties, R = rows, C = columns per row.
At 200 seats, this is negligible (<1 ms).
"""

from __future__ import annotations

import structlog

from app.models.domain import (
    BookingRecord,
    BookingRelocation,
    CompensationType,
    InvariantViolationError,
    RelocationPlan,
    SeatNode,
    SeatStatus,
    SeatTier,
)

logger = structlog.get_logger(__name__)

# Tier escalation chain: if primary tier is exhausted, try the next one up.
_TIER_ESCALATION: dict[SeatTier, list[SeatTier]] = {
    SeatTier.STANDARD: [SeatTier.STANDARD, SeatTier.PRIME, SeatTier.LUXURY_RECLINER],
    SeatTier.PRIME: [SeatTier.PRIME, SeatTier.LUXURY_RECLINER],
    SeatTier.LUXURY_RECLINER: [SeatTier.LUXURY_RECLINER],
}

# Compensation value per displaced guest (paisa). Must respect fiscal guardrail.
_COMPENSATION_PAISA: dict[CompensationType, int] = {
    CompensationType.FNB_VOUCHER_200: 20_000,
    CompensationType.FNB_VOUCHER_250: 25_000,
    CompensationType.FULL_REFUND: 0,          # handled separately
    CompensationType.TIER_UPGRADE_ONLY: 0,
}


class SpatialAdjacencySolver:
    """
    Finds contiguous seat blocks in the target tier for each booking party.

    Inputs:
        layout: All SeatNodes for the target show (including status & tier).
    """

    def __init__(self, layout: list[SeatNode]) -> None:
        # Build row-keyed index. Row keys are stripped strings (e.g. "M", "E").
        self._grid: dict[str, list[SeatNode]] = {}
        for node in layout:
            self._grid.setdefault(node.row, []).append(node)
        for row in self._grid:
            self._grid[row].sort(key=lambda s: s.col)

        # Estimate auditorium midpoint from max column index seen
        all_cols = [s.col for nodes in self._grid.values() for s in nodes]
        self._mid_col: float = (min(all_cols) + max(all_cols)) / 2 if all_cols else 10.0

    # ─── Public API ───────────────────────────────────────────────────────────

    def solve(
        self,
        bookings: list[BookingRecord],
        target_tier: SeatTier,
        compensation_type: CompensationType = CompensationType.FNB_VOUCHER_200,
        voucher_code: str = "AGENT-COMP",
        quarantine_seat_ids: list[str] | None = None,
    ) -> RelocationPlan:
        """
        Produce a RelocationPlan for all affected bookings.

        Args:
            bookings: Confirmed bookings whose seats are being quarantined.
            target_tier: Desired destination tier (must be ≥ source tier).
            compensation_type: Voucher type per displaced guest.
            voucher_code: Voucher identifier attached to booking records.
            quarantine_seat_ids: All seat IDs to block (may include empty ones).

        Returns:
            RelocationPlan with per-party assignments and total financial exposure.

        Raises:
            InvariantViolationError: No contiguous block available in any allowed tier.
        """
        quarantine_seat_ids = quarantine_seat_ids or []

        # Sort largest party first (bin-packing heuristic)
        sorted_bookings = sorted(bookings, key=lambda b: b.party_size, reverse=True)

        reserved_ids: set[str] = set()
        relocations: list[BookingRelocation] = []
        total_paisa: int = 0

        tier_candidates = _TIER_ESCALATION.get(target_tier, [target_tier])

        for booking in sorted_bookings:
            assigned, actual_tier = self._find_contiguous_block(
                party_size=booking.party_size,
                tier_candidates=tier_candidates,
                reserved_ids=reserved_ids,
            )

            if actual_tier.rank < target_tier.rank:
                raise InvariantViolationError(
                    rule="PAID_TICKET_IMMUTABILITY",
                    detail=(
                        f"Booking {booking.booking_id}: target tier {target_tier.value} "
                        f"has no contiguous block of size {booking.party_size}. "
                        "Cannot downgrade. Escalate manually."
                    ),
                )

            comp_paisa = _COMPENSATION_PAISA[compensation_type] * booking.party_size
            total_paisa += comp_paisa

            relocations.append(
                BookingRelocation(
                    booking_id=booking.booking_id,
                    party_size=booking.party_size,
                    source_seat_ids=booking.seat_ids,
                    target_seat_ids=[s.seat_id for s in assigned],
                    source_tier=SeatTier(
                        next(
                            (n.tier for n in self._all_nodes() if n.seat_id in booking.seat_ids),
                            SeatTier.STANDARD,
                        )
                    ),
                    target_tier=actual_tier,
                    compensation_type=compensation_type,
                    compensation_value_paisa=comp_paisa,
                )
            )

            reserved_ids.update(s.seat_id for s in assigned)
            logger.info(
                "party_allocated",
                booking_id=booking.booking_id,
                party_size=booking.party_size,
                target_row=assigned[0].row,
                cols=[s.col for s in assigned],
            )

        return RelocationPlan(
            show_id=sorted_bookings[0].show_id if sorted_bookings else "",
            quarantine_seat_ids=quarantine_seat_ids,
            relocations=relocations,
            voucher_code=voucher_code,
            total_compensation_paisa=total_paisa,
        )

    # ─── Internal helpers ────────────────────────────────────────────────────

    def _find_contiguous_block(
        self,
        party_size: int,
        tier_candidates: list[SeatTier],
        reserved_ids: set[str],
    ) -> tuple[list[SeatNode], SeatTier]:
        """
        Sliding-window search for a contiguous column block in candidate tiers.
        Returns the best window (centre-aligned) and the tier it was found in.
        """
        for tier in tier_candidates:
            result = self._search_tier(party_size, tier, reserved_ids)
            if result:
                return result, tier

        raise InvariantViolationError(
            rule="CONTIGUOUS_SEAT_UNAVAILABLE",
            detail=(
                f"No contiguous block of size {party_size} found in tiers "
                f"{[t.value for t in tier_candidates]}. "
                "All permissible tiers exhausted."
            ),
        )

    def _search_tier(
        self,
        party_size: int,
        tier: SeatTier,
        reserved_ids: set[str],
    ) -> list[SeatNode] | None:
        """
        Scan all rows in the given tier for the best contiguous window.
        Returns the closest-to-centre window, or None if none found.
        """
        best_window: list[SeatNode] | None = None
        best_deviation: float = float("inf")

        for row, nodes in self._grid.items():
            candidates = [
                n
                for n in nodes
                if n.tier == tier
                and n.status == SeatStatus.AVAILABLE
                and n.seat_id not in reserved_ids
            ]

            if len(candidates) < party_size:
                continue

            for i in range(len(candidates) - party_size + 1):
                window = candidates[i : i + party_size]

                # Strict column contiguity check
                if not all(
                    window[j].col == window[j - 1].col + 1 for j in range(1, party_size)
                ):
                    continue

                avg_col = sum(s.col for s in window) / party_size
                deviation = abs(avg_col - self._mid_col)

                if deviation < best_deviation:
                    best_deviation = deviation
                    best_window = window

        return best_window

    def _all_nodes(self) -> list[SeatNode]:
        return [n for nodes in self._grid.values() for n in nodes]


def build_layout_from_raw(raw_allocations: list[dict]) -> list[SeatNode]:
    """
    Convert raw Supabase allocation records into SeatNode objects.
    Filters out inactive seats silently (they should never appear in allocations).
    """
    nodes: list[SeatNode] = []
    for alloc in raw_allocations:
        seat = alloc.get("seat")
        if not seat or not seat.get("is_active", True):
            continue
        nodes.append(
            SeatNode(
                seat_id=seat["id"],
                allocation_id=alloc["id"],
                row=seat["row_label"].strip(),
                col=seat["col_index"],
                tier=SeatTier(seat["tier"]),
                status=SeatStatus(alloc["status"]),
                price_cents=alloc["price_cents"],
            )
        )
    return nodes
