"""MongoDB persistence boundary for CinemaOps.

Collections are intentionally shaped around the application's access patterns:
seat allocations contain the small seat and booking projections needed by the
live map and agent tools, while audit records retain immutable snapshots.
"""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any
from uuid import uuid4

import structlog
from motor.motor_asyncio import AsyncIOMotorClient, AsyncIOMotorDatabase
from pymongo import ASCENDING, DESCENDING, ReturnDocument

from app.config import get_settings

logger = structlog.get_logger(__name__)

_client: AsyncIOMotorClient | None = None


async def get_database() -> AsyncIOMotorDatabase:
    global _client
    settings = get_settings()
    if _client is None:
        _client = AsyncIOMotorClient(settings.mongodb_uri, serverSelectionTimeoutMS=10_000)
        await _client.admin.command("ping")
        logger.info("mongodb_connected", database=settings.mongodb_database)
    return _client[settings.mongodb_database]


async def close_mongodb() -> None:
    global _client
    if _client is not None:
        _client.close()
        _client = None


async def ensure_indexes() -> None:
    db = await get_database()
    await db.seat_allocations.create_index(
        [("show_id", ASCENDING), ("seat_id", ASCENDING)], unique=True
    )
    await db.seat_allocations.create_index([("show_id", ASCENDING), ("status", ASCENDING)])
    await db.seat_allocations.create_index([("show_id", ASCENDING), ("booking_id", ASCENDING)])
    await db.audit_journal.create_index([("timestamp", DESCENDING)])
    await db.audit_journal.create_index([("thread_id", ASCENDING), ("timestamp", DESCENDING)])


def _allocation_projection(document: dict[str, Any]) -> dict[str, Any]:
    result = {key: value for key, value in document.items() if not key.startswith("_")}
    return result


async def get_show_topology(show_id: str) -> dict[str, Any]:
    db = await get_database()
    allocations = [
        _allocation_projection(doc)
        async for doc in db.seat_allocations.find({"show_id": show_id}, {"_id": 0})
    ]
    return {"show_id": show_id, "allocations": allocations}


async def get_available_seats_by_tier(show_id: str, tier: str) -> list[dict[str, Any]]:
    db = await get_database()
    cursor = db.seat_allocations.find(
        {"show_id": show_id, "status": "AVAILABLE", "seat.tier": tier}, {"_id": 0}
    )
    return [_allocation_projection(doc) async for doc in cursor]


async def get_occupied_seats(show_id: str, seat_ids: list[str]) -> list[dict[str, Any]]:
    db = await get_database()
    cursor = db.seat_allocations.find(
        {"show_id": show_id, "seat_id": {"$in": seat_ids}, "status": {"$ne": "AVAILABLE"}},
        {"_id": 0},
    )
    return [_allocation_projection(doc) async for doc in cursor]


async def get_occupancy_telemetry(show_id: str) -> dict[str, Any]:
    db = await get_database()
    total = await db.seat_allocations.count_documents({"show_id": show_id})
    booked = await db.seat_allocations.count_documents(
        {"show_id": show_id, "status": {"$in": ["BOOKED", "BOOKED_UPGRADED", "LOCKED_CART"]}}
    )
    return {
        "show_id": show_id,
        "total_seats": total,
        "booked": booked,
        "available": total - booked,
        "occupancy_pct": round(booked / total * 100, 2) if total else 0,
    }


async def get_audit_log(admin_id: str | None = None, limit: int = 50) -> list[dict[str, Any]]:
    db = await get_database()
    query = {"admin_id": admin_id} if admin_id else {}
    cursor = db.audit_journal.find(query, {"_id": 0}).sort("timestamp", DESCENDING).limit(limit)
    return [_allocation_projection(doc) async for doc in cursor]


async def apply_relocation(payload: dict[str, Any]) -> dict[str, Any]:
    db = await get_database()
    quarantine_ids = payload["p_quarantine_ids"]
    relocations = payload["p_relocations"]
    show_id = payload["p_show_id"]
    seat_ids = quarantine_ids + [
        seat_id for relocation in relocations for seat_id in relocation["new_seat_ids"]
    ]
    async with await _client.start_session() as session:  # type: ignore[union-attr]
        async with session.start_transaction():
            before = [
                doc async for doc in db.seat_allocations.find(
                    {"show_id": show_id, "seat_id": {"$in": seat_ids}}, {"_id": 0}, session=session
                )
            ]
            if len(before) != len(set(seat_ids)):
                raise RuntimeError("Relocation references seats missing from the show")
            for seat_id in quarantine_ids:
                result = await db.seat_allocations.update_one(
                    {"show_id": show_id, "seat_id": seat_id, "status": {"$ne": "BOOKED_UPGRADED"}},
                    {"$set": {"status": "MAINTENANCE_BLOCKED", "updated_at": datetime.now(timezone.utc)}},
                    session=session,
                )
                if result.matched_count != 1:
                    raise RuntimeError(f"Unable to quarantine seat {seat_id}")
            for relocation in relocations:
                result = await db.seat_allocations.update_many(
                    {
                        "show_id": show_id,
                        "seat_id": {"$in": relocation["new_seat_ids"]},
                        "status": "AVAILABLE",
                    },
                    {
                        "$set": {
                            "status": "BOOKED_UPGRADED",
                            "booking_id": relocation["booking_id"],
                            "updated_at": datetime.now(timezone.utc),
                        }
                    },
                    session=session,
                )
                if result.modified_count != len(relocation["new_seat_ids"]):
                    raise RuntimeError("One or more destination seats are no longer available")
                await db.seat_allocations.update_many(
                    {"show_id": show_id, "seat_id": {"$in": relocation["old_seat_ids"]}},
                    {"$set": {"status": "MAINTENANCE_BLOCKED", "updated_at": datetime.now(timezone.utc)}},
                    session=session,
                )
            journal_id = str(uuid4())
            await db.audit_journal.insert_one(
                {
                    "id": journal_id,
                    "timestamp": datetime.now(timezone.utc).isoformat(),
                    "admin_id": payload["p_admin_id"],
                    "thread_id": payload["p_thread_id"],
                    "action_type": "RELOCATION",
                    "prompt_intent": payload["p_prompt_intent"],
                    "financial_delta_paisa": payload["p_financial_delta"],
                    "is_rolled_back": False,
                    "relocation_plan": {"show_id": show_id, "relocations": relocations},
                    "before_allocations": before,
                },
                session=session,
            )
    return {
        "journal_id": journal_id,
        "seats_blocked": len(quarantine_ids),
        "financial_delta_paisa": payload["p_financial_delta"],
    }


async def rollback_journal(journal_id: str, admin_id: str) -> dict[str, Any]:
    db = await get_database()
    async with await _client.start_session() as session:  # type: ignore[union-attr]
        async with session.start_transaction():
            journal = await db.audit_journal.find_one(
                {"id": journal_id, "is_rolled_back": False}, session=session
            )
            if not journal:
                raise RuntimeError("Journal entry not found or already rolled back")
            for allocation in journal["before_allocations"]:
                await db.seat_allocations.replace_one(
                    {"show_id": allocation["show_id"], "seat_id": allocation["seat_id"]},
                    allocation,
                    session=session,
                )
            await db.audit_journal.update_one(
                {"id": journal_id}, {"$set": {"is_rolled_back": True}}, session=session
            )
            undo_id = str(uuid4())
            await db.audit_journal.insert_one(
                {
                    "id": undo_id,
                    "timestamp": datetime.now(timezone.utc).isoformat(),
                    "admin_id": admin_id,
                    "thread_id": journal["thread_id"],
                    "action_type": "ROLLBACK",
                    "prompt_intent": f"Rollback of {journal_id}",
                    "financial_delta_paisa": -journal["financial_delta_paisa"],
                    "is_rolled_back": False,
                    "rolled_back_journal_id": journal_id,
                },
                session=session,
            )
    return {"status": "rolled_back", "undo_journal_id": undo_id}
