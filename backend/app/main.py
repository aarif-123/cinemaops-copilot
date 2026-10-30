"""
FastAPI application entry point.

Startup sequence:
  1. Validate all settings (fail-fast on missing env vars)
  2. Verify Redis connectivity
  3. Compile the LangGraph StateGraph with PostgresSaver
  4. Mount all routers

Shutdown sequence:
  1. Close async PostgresSaver connection
  2. Close Redis async connection
"""

from __future__ import annotations

import logging
from contextlib import asynccontextmanager
from typing import AsyncIterator

import structlog
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.agent.graph import get_compiled_graph
from app.config import get_settings
from app.redis_client import close_redis, get_redis
from app.routers import agent, seats, ws

# Configure structured logging
structlog.configure(
    wrapper_class=structlog.make_filtering_bound_logger(logging.INFO),
)
logger = structlog.get_logger(__name__)


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
    """Application lifespan: initialise and teardown shared resources."""
    settings = get_settings()
    logger.info("startup_begin", env=settings.app_env)

    # 1. Verify Redis
    await get_redis()
    logger.info("redis_ready")

    # 2. Compile LangGraph graph with Postgres checkpointer
    # Build connection string from Supabase URL + service key
    # Supabase provides a direct Postgres connection via the project URL
    pg_conn = (
        f"postgresql+asyncpg://postgres:{settings.supabase_service_key}"
        f"@db.{settings.supabase_url.replace('https://', '').split('.')[0]}"
        f".supabase.co:5432/postgres"
    )

    graph, checkpointer = await get_compiled_graph(pg_conn)
    app.state.graph = graph
    app.state.checkpointer = checkpointer
    logger.info("langgraph_ready")

    logger.info("startup_complete", env=settings.app_env)
    yield

    # Teardown
    logger.info("shutdown_begin")
    await close_redis()
    if hasattr(app.state, "checkpointer") and app.state.checkpointer:
        await app.state.checkpointer.conn.close()
    logger.info("shutdown_complete")


def create_app() -> FastAPI:
    settings = get_settings()

    app = FastAPI(
        title="CinemaOps Copilot API",
        description=(
            "Agentic Theater Control & Yield Engine. "
            "Deterministic State Machine with Natural Language Intelligence."
        ),
        version="1.0.0",
        docs_url="/docs" if not settings.is_production else None,
        redoc_url="/redoc" if not settings.is_production else None,
        lifespan=lifespan,
    )

    # CORS — allow the admin portal origin
    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.allowed_origins,
        allow_credentials=True,
        allow_methods=["GET", "POST", "PUT", "DELETE", "OPTIONS"],
        allow_headers=["Authorization", "Content-Type"],
    )

    # Mount routers
    app.include_router(agent.router)
    app.include_router(seats.router)
    app.include_router(ws.router)

    @app.get("/health", tags=["ops"])
    async def health() -> dict:
        return {"status": "ok", "service": "cinemaops-backend"}

    return app


app = create_app()
