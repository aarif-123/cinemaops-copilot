"""
Domain models — the shared data contracts for the entire system.

All types are Pydantic BaseModel (not just type aliases) so that they are
runtime-validated at every service boundary, not just at the type-checker level.
"""

from __future__ import annotations

from enum import Enum
from typing import Any, Optional
from uuid import UUID

from pydantic import BaseModel, Field, field_validator


# ─── Enumerations ─────────────────────────────────────────────────────────────

class SeatTier(str, Enum):
    STANDARD = "STANDARD"
    PRIME = "PRIME"
    LUXURY_RECLINER = "LUXURY_RECLINER"

    @property
    def rank(self) -> int:
        """Numeric rank for tier comparison (higher = better)."""
        return {"STANDARD": 1, "PRIME": 2, "LUXURY_RECLINER": 3}[self.value]


class SeatStatus(str, Enum):
    AVAILABLE = "AVAILABLE"
    LOCKED_CART = "LOCKED_CART"
    BOOKED = "BOOKED"
    MAINTENANCE_BLOCKED = "MAINTENANCE_BLOCKED"
    RELOCATION_HOLD = "RELOCATION_HOLD"


class BookingStatus(str, Enum):
    PENDING = "PENDING"
    CONFIRMED = "CONFIRMED"
    CANCELLED = "CANCELLED"
    RELOCATED = "RELOCATED"


class CompensationType(str, Enum):
    FNB_VOUCHER_200 = "FNB_VOUCHER_200"   # ₹200 food & beverage voucher
    FNB_VOUCHER_250 = "FNB_VOUCHER_250"   # ₹250 food & beverage voucher
    FULL_REFUND = "FULL_REFUND"
    TIER_UPGRADE_ONLY = "TIER_UPGRADE_ONLY"


# ─── Core Entities ────────────────────────────────────────────────────────────

class SeatNode(BaseModel):
    """Represents a single seat cell in the auditorium matrix."""

    seat_id: str
    allocation_id: str
    row: str
    col: int
    tier: SeatTier
    status: SeatStatus
    price_cents: int = Field(ge=0)

    @field_validator("row")
    @classmethod
    def strip_row(cls, v: str) -> str:
        return v.strip()

    @property
    def is_available(self) -> bool:
        return self.status == SeatStatus.AVAILABLE

    @property
    def coordinates(self) -> tuple[str, int]:
        return (self.row, self.col)


class BookingRecord(BaseModel):
    """A confirmed customer booking and its current seat allocations."""

    booking_id: str
    show_id: str
    user_id: str
    party_size: int = Field(ge=1)
    status: BookingStatus
    seat_ids: list[str] = Field(default_factory=list)
    voucher_code: Optional[str] = None
    version: int = Field(ge=1)


class BookingRelocation(BaseModel):
    """A proposed move for a single booking party."""

    booking_id: str
    party_size: int = Field(ge=1)
    source_seat_ids: list[str]
    target_seat_ids: list[str]
    source_tier: SeatTier
    target_tier: SeatTier
    compensation_type: Optional[CompensationType] = None
    compensation_value_paisa: int = Field(default=0, ge=0)

    @property
    def is_tier_upgrade(self) -> bool:
        return self.target_tier.rank >= self.source_tier.rank

    def to_rpc_dict(self) -> dict[str, Any]:
        """Serialise for the Postgres RPC payload."""
        return {
            "booking_id": self.booking_id,
            "old_seat_ids": self.source_seat_ids,
            "new_seat_ids": self.target_seat_ids,
        }


class RelocationPlan(BaseModel):
    """The full relocation plan produced by the SpatialAdjacencySolver."""

    show_id: str
    quarantine_seat_ids: list[str]
    relocations: list[BookingRelocation]
    voucher_code: str
    total_compensation_paisa: int = Field(ge=0)
    solver_confidence: float = Field(default=1.0, ge=0.0, le=1.0)

    @property
    def affected_parties(self) -> int:
        return len(self.relocations)

    @property
    def total_guests_relocated(self) -> int:
        return sum(r.party_size for r in self.relocations)

    def validate_fiscal_guardrails(self, max_voucher_paisa: int, daily_budget_paisa: int) -> None:
        """Raise ValueError if the plan exceeds fiscal guardrails."""
        for r in self.relocations:
            if r.compensation_value_paisa > max_voucher_paisa:
                raise ValueError(
                    f"Voucher ₹{r.compensation_value_paisa / 100:.0f} exceeds cap "
                    f"₹{max_voucher_paisa / 100:.0f}. Escalate to Regional Director."
                )
        if self.total_compensation_paisa > daily_budget_paisa:
            raise ValueError(
                f"Total voucher outlay ₹{self.total_compensation_paisa / 100:.0f} "
                f"exceeds daily budget ₹{daily_budget_paisa / 100:.0f}. "
                "Escalate to Regional Director."
            )


class AuditRecord(BaseModel):
    """An entry in the operational audit journal."""

    id: str
    timestamp: str
    admin_id: str
    thread_id: str
    action_type: str
    prompt_intent: str
    financial_delta_paisa: int
    is_rolled_back: bool = False
    relocation_plan: Optional[dict[str, Any]] = None


class OccupancyTelemetry(BaseModel):
    """Show occupancy snapshot for the proactive advisory engine."""

    show_id: str
    total_seats: int
    booked: int
    available: int
    occupancy_pct: float

    @property
    def is_sold_out(self) -> bool:
        return self.available == 0

    @property
    def is_low_demand(self) -> bool:
        return self.occupancy_pct < 10.0


# ─── Error Types ─────────────────────────────────────────────────────────────

class InvariantViolationError(Exception):
    """
    Raised when a deterministic guardrail is breached.
    Distinguishable from generic RuntimeError so LangGraph error edges can
    route specifically: InvariantViolation → advisory fallback,
    RuntimeError → hard abort with admin alert.
    """

    def __init__(self, rule: str, detail: str) -> None:
        self.rule = rule
        self.detail = detail
        super().__init__(f"[{rule}] {detail}")


class LockConflictError(Exception):
    """Raised when a required Redlock cannot be acquired within timeout."""

    def __init__(self, seat_ids: list[str]) -> None:
        self.seat_ids = seat_ids
        super().__init__(f"Cannot acquire locks for seats: {seat_ids}")


class FiscalCapExceededError(Exception):
    """Raised when a proposed action breaches financial guardrails."""
