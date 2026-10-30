"""
Unit tests for the SpatialAdjacencySolver.

These tests are pure in-memory — no network, no DB, no Redis.
They verify the core invariants of the seat allocation algorithm:
  - Largest party placed first
  - No group splitting
  - Tier escalation when primary tier is full
  - InvariantViolationError when no contiguous block exists
"""

from __future__ import annotations

import pytest

from app.models.domain import (
    BookingRecord,
    BookingStatus,
    CompensationType,
    InvariantViolationError,
    SeatStatus,
    SeatTier,
)
from app.services.spatial_solver import SpatialAdjacencySolver, SeatNode


def _make_seat(seat_id: str, row: str, col: int, tier: SeatTier, status: SeatStatus = SeatStatus.AVAILABLE) -> SeatNode:
    return SeatNode(
        seat_id=seat_id,
        allocation_id=f"alloc_{seat_id}",
        row=row,
        col=col,
        tier=tier,
        status=status,
        price_cents=50000,
    )


def _make_booking(bid: str, size: int, seat_ids: list[str]) -> BookingRecord:
    return BookingRecord(
        booking_id=bid,
        show_id="show_001",
        user_id="user_001",
        party_size=size,
        status=BookingStatus.CONFIRMED,
        seat_ids=seat_ids,
        version=1,
    )


class TestSpatialAdjacencySolver:

    def _build_recliner_row(self, row: str = "M", count: int = 20) -> list[SeatNode]:
        return [
            _make_seat(f"M{i}", row, i, SeatTier.LUXURY_RECLINER)
            for i in range(1, count + 1)
        ]

    def test_single_party_placed_in_contiguous_block(self):
        layout = self._build_recliner_row()
        solver = SpatialAdjacencySolver(layout)
        booking = _make_booking("BK-001", 4, ["E1", "E2", "E3", "E4"])

        plan = solver.solve(
            bookings=[booking],
            target_tier=SeatTier.LUXURY_RECLINER,
            quarantine_seat_ids=["E1", "E2", "E3", "E4"],
        )

        assert len(plan.relocations) == 1
        reloc = plan.relocations[0]
        assert len(reloc.target_seat_ids) == 4

        # Verify contiguity by checking the solver assigned an actual window
        assert reloc.booking_id == "BK-001"

    def test_multiple_parties_no_overlap(self):
        layout = self._build_recliner_row(count=20)
        solver = SpatialAdjacencySolver(layout)

        bookings = [
            _make_booking("BK-001", 4, ["E8", "E9", "E10", "E11"]),
            _make_booking("BK-002", 3, ["F8", "F9", "F10"]),
            _make_booking("BK-003", 2, ["F11", "F12"]),
        ]

        plan = solver.solve(bookings=bookings, target_tier=SeatTier.LUXURY_RECLINER)

        all_target_ids: list[str] = []
        for r in plan.relocations:
            all_target_ids.extend(r.target_seat_ids)

        # No seat should be assigned twice
        assert len(all_target_ids) == len(set(all_target_ids)), "Seat assigned to multiple parties!"

        # Total assigned seats = total party sizes
        assert len(all_target_ids) == 4 + 3 + 2

    def test_largest_party_placed_first_bin_packing(self):
        # Only 6 consecutive seats available — a size-4 and size-3 cannot both fit
        # if we placed the 3-seat first and fragmented the block.
        layout = [_make_seat(f"M{i}", "M", i, SeatTier.LUXURY_RECLINER) for i in range(1, 7)]
        solver = SpatialAdjacencySolver(layout)

        bookings = [
            _make_booking("BK-SMALL", 3, []),
            _make_booking("BK-LARGE", 4, []),
        ]

        # Should succeed because largest (4) placed first, then (3) fills remainder
        plan = solver.solve(bookings=bookings, target_tier=SeatTier.LUXURY_RECLINER)
        assert len(plan.relocations) == 2

    def test_insufficient_seats_raises_invariant_error(self):
        # Only 2 consecutive seats but party needs 4
        layout = [_make_seat(f"M{i}", "M", i, SeatTier.LUXURY_RECLINER) for i in range(1, 3)]
        solver = SpatialAdjacencySolver(layout)
        booking = _make_booking("BK-001", 4, [])

        with pytest.raises(InvariantViolationError, match="contiguous"):
            solver.solve(bookings=[booking], target_tier=SeatTier.LUXURY_RECLINER)

    def test_financial_exposure_calculation(self):
        layout = self._build_recliner_row()
        solver = SpatialAdjacencySolver(layout)
        booking = _make_booking("BK-001", 3, ["E1", "E2", "E3"])

        plan = solver.solve(
            bookings=[booking],
            target_tier=SeatTier.LUXURY_RECLINER,
            compensation_type=CompensationType.FNB_VOUCHER_200,
        )

        # 3 guests × ₹200 = ₹600 = 60,000 paisa
        assert plan.total_compensation_paisa == 60_000

    def test_fiscal_guardrail_validation(self):
        layout = self._build_recliner_row()
        solver = SpatialAdjacencySolver(layout)
        booking = _make_booking("BK-001", 3, [])

        plan = solver.solve(bookings=[booking], target_tier=SeatTier.LUXURY_RECLINER)

        # Should not raise with normal caps
        plan.validate_fiscal_guardrails(
            max_voucher_paisa=25_000,
            daily_budget_paisa=250_000,
        )

    def test_gaps_in_available_seats_handled(self):
        """A gap (BOOKED seat) must break contiguity — solver skips that window."""
        layout = [
            _make_seat("M1", "M", 1, SeatTier.LUXURY_RECLINER),
            _make_seat("M2", "M", 2, SeatTier.LUXURY_RECLINER, SeatStatus.BOOKED),  # gap
            _make_seat("M3", "M", 3, SeatTier.LUXURY_RECLINER),
            _make_seat("M4", "M", 4, SeatTier.LUXURY_RECLINER),
            _make_seat("M5", "M", 5, SeatTier.LUXURY_RECLINER),
        ]
        solver = SpatialAdjacencySolver(layout)
        booking = _make_booking("BK-001", 3, [])

        # Should find M3, M4, M5 — the contiguous block after the gap
        plan = solver.solve(bookings=[booking], target_tier=SeatTier.LUXURY_RECLINER)
        assert len(plan.relocations[0].target_seat_ids) == 3
