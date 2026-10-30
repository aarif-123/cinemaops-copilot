"""
Central configuration using pydantic-settings.

Validates ALL required environment variables at import time.
The application will refuse to start if any required variable is missing,
preventing runtime KeyErrors in production.
"""

from functools import lru_cache
from typing import Literal

from pydantic import Field, field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        case_sensitive=False,
        extra="ignore",
    )

    # ── Supabase ──────────────────────────────────────────────────────────────
    supabase_url: str = Field(..., description="Supabase project URL")
    supabase_service_key: str = Field(..., description="Supabase service-role key (bypasses RLS)")

    # ── Redis ─────────────────────────────────────────────────────────────────
    redis_url: str = Field(..., description="Redis connection URL (redis:// or rediss://)")

    # ── Groq ─────────────────────────────────────────────────────────────────
    groq_api_key: str = Field(..., description="Groq Cloud API key")
    groq_model: str = Field("llama-3.3-70b-versatile", description="Groq model identifier")

    # ── Auth ─────────────────────────────────────────────────────────────────
    jwt_secret: str = Field(..., min_length=32, description="HS256 signing secret (≥32 chars)")
    jwt_algorithm: str = Field("HS256")
    jwt_expire_minutes: int = Field(480, ge=1, le=1440)

    # ── App ───────────────────────────────────────────────────────────────────
    app_env: Literal["development", "production"] = Field("development")
    log_level: Literal["DEBUG", "INFO", "WARNING", "ERROR"] = Field("INFO")
    allowed_origins: list[str] = Field(
        default_factory=lambda: ["http://localhost:5173", "http://localhost:3000"]
    )

    # ── Agent tuning ─────────────────────────────────────────────────────────
    agent_max_iterations: int = Field(10, ge=1, le=50)
    redis_lock_ttl_seconds: int = Field(120, ge=30, le=600)

    # ── Fiscal guardrails ─────────────────────────────────────────────────────
    max_flash_discount_pct: int = Field(35, ge=0, le=50)
    max_voucher_value_paisa: int = Field(25_000, ge=0)   # ₹250
    daily_voucher_budget_paisa: int = Field(250_000, ge=0)  # ₹2,500

    @field_validator("allowed_origins", mode="before")
    @classmethod
    def parse_origins(cls, v: str | list[str]) -> list[str]:
        if isinstance(v, str):
            return [o.strip() for o in v.split(",") if o.strip()]
        return v

    @field_validator("supabase_url")
    @classmethod
    def validate_supabase_url(cls, v: str) -> str:
        if not v.startswith("https://"):
            raise ValueError("SUPABASE_URL must start with https://")
        return v.rstrip("/")

    @property
    def is_production(self) -> bool:
        return self.app_env == "production"


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    """Return the singleton Settings instance. Cached after first call."""
    return Settings()
