-- =============================================================================
-- CinemaOps Copilot — PostgreSQL 16 Initial Schema
-- Migration: 001_initial.sql
-- Run once via: Supabase SQL Editor > New Query > paste & run
-- =============================================================================

-- ─── Extensions ──────────────────────────────────────────────────────────────
CREATE EXTENSION IF NOT EXISTS "pgcrypto";   -- gen_random_uuid()
CREATE EXTENSION IF NOT EXISTS "pg_trgm";    -- fuzzy text search on movie titles

-- ─── Custom ENUM Types ───────────────────────────────────────────────────────
DO $$ BEGIN
    CREATE TYPE seat_tier AS ENUM ('STANDARD', 'PRIME', 'LUXURY_RECLINER');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
    CREATE TYPE seat_status AS ENUM (
        'AVAILABLE',
        'LOCKED_CART',
        'BOOKED',
        'MAINTENANCE_BLOCKED',
        'RELOCATION_HOLD'       -- ephemeral hold during agent planning
    );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
    CREATE TYPE booking_status AS ENUM ('PENDING', 'CONFIRMED', 'CANCELLED', 'RELOCATED');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
    CREATE TYPE incident_type AS ENUM (
        'HVAC_FAILURE',
        'STRUCTURAL_DAMAGE',
        'EMERGENCY_EVACUATION',
        'SCREEN_MALFUNCTION',
        'MANUAL_BLOCK'
    );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- =============================================================================
-- SECTION 1: Physical Topology
-- =============================================================================

CREATE TABLE IF NOT EXISTS theaters (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name            VARCHAR(255) NOT NULL,
    city            VARCHAR(100) NOT NULL,
    created_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS screens (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    theater_id      UUID NOT NULL REFERENCES theaters(id) ON DELETE CASCADE,
    screen_number   VARCHAR(10) NOT NULL,
    total_rows      INT NOT NULL CHECK (total_rows > 0),
    total_cols      INT NOT NULL CHECK (total_cols > 0),
    created_at      TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(theater_id, screen_number)
);

CREATE TABLE IF NOT EXISTS seats (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    screen_id       UUID NOT NULL REFERENCES screens(id) ON DELETE CASCADE,
    row_label       CHAR(2) NOT NULL,          -- e.g. 'A ', 'M '
    col_index       INT NOT NULL CHECK (col_index > 0),
    tier            seat_tier NOT NULL DEFAULT 'STANDARD',
    is_active       BOOLEAN NOT NULL DEFAULT TRUE,
    UNIQUE(screen_id, row_label, col_index)
);

CREATE INDEX IF NOT EXISTS idx_seats_spatial
    ON seats (screen_id, row_label, col_index);

CREATE INDEX IF NOT EXISTS idx_seats_tier
    ON seats (screen_id, tier) WHERE is_active = TRUE;

-- =============================================================================
-- SECTION 2: Shows & Real-Time Allocations
-- =============================================================================

CREATE TABLE IF NOT EXISTS shows (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    screen_id       UUID NOT NULL REFERENCES screens(id),
    movie_title     VARCHAR(255) NOT NULL,
    start_time      TIMESTAMPTZ NOT NULL,
    base_price_cents INT NOT NULL CHECK (base_price_cents > 0),
    version         INT NOT NULL DEFAULT 1,
    created_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_shows_screen_time
    ON shows (screen_id, start_time);

CREATE TABLE IF NOT EXISTS bookings (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    show_id         UUID NOT NULL REFERENCES shows(id),
    user_id         UUID NOT NULL,
    party_size      INT NOT NULL CHECK (party_size > 0),
    status          booking_status NOT NULL DEFAULT 'CONFIRMED',
    voucher_code    VARCHAR(50),
    version         INT NOT NULL DEFAULT 1,      -- optimistic concurrency control
    created_at      TIMESTAMPTZ DEFAULT NOW(),
    updated_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_bookings_show
    ON bookings (show_id, status);

CREATE TABLE IF NOT EXISTS ticket_allocations (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    show_id         UUID NOT NULL REFERENCES shows(id),
    seat_id         UUID NOT NULL REFERENCES seats(id),
    booking_id      UUID REFERENCES bookings(id),
    status          seat_status NOT NULL DEFAULT 'AVAILABLE',
    price_cents     INT NOT NULL CHECK (price_cents >= 0),
    version         INT NOT NULL DEFAULT 1,
    updated_at      TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(show_id, seat_id)                     -- zero double-booking invariant
);

CREATE INDEX IF NOT EXISTS idx_allocations_show_status
    ON ticket_allocations (show_id, status);

CREATE INDEX IF NOT EXISTS idx_allocations_booking
    ON ticket_allocations (booking_id) WHERE booking_id IS NOT NULL;

-- =============================================================================
-- SECTION 3: Agent Infrastructure Tables
-- =============================================================================

-- LangGraph checkpoint storage (PostgresSaver compatible schema)
CREATE TABLE IF NOT EXISTS agent_checkpoints (
    thread_id       VARCHAR(128) NOT NULL,
    checkpoint_ns   VARCHAR(128) NOT NULL DEFAULT '',
    checkpoint_id   VARCHAR(128) NOT NULL,
    parent_checkpoint_id VARCHAR(128),
    type            VARCHAR(32),
    checkpoint      BYTEA NOT NULL,
    metadata        JSONB,
    created_at      TIMESTAMPTZ DEFAULT NOW(),
    PRIMARY KEY (thread_id, checkpoint_ns, checkpoint_id)
);

CREATE TABLE IF NOT EXISTS agent_checkpoint_blobs (
    thread_id       VARCHAR(128) NOT NULL,
    checkpoint_ns   VARCHAR(128) NOT NULL DEFAULT '',
    channel         VARCHAR(128) NOT NULL,
    version         VARCHAR(128) NOT NULL,
    type            VARCHAR(32) NOT NULL,
    blob            BYTEA,
    PRIMARY KEY (thread_id, checkpoint_ns, channel, version)
);

CREATE TABLE IF NOT EXISTS agent_checkpoint_writes (
    thread_id       VARCHAR(128) NOT NULL,
    checkpoint_ns   VARCHAR(128) NOT NULL DEFAULT '',
    checkpoint_id   VARCHAR(128) NOT NULL,
    task_id         VARCHAR(128) NOT NULL,
    idx             SERIAL,
    channel         VARCHAR(128) NOT NULL,
    type            VARCHAR(32),
    blob            BYTEA,
    PRIMARY KEY (thread_id, checkpoint_ns, checkpoint_id, task_id, idx)
);

-- Immutable audit journal (append-only via RLS or trigger)
CREATE TABLE IF NOT EXISTS operational_audit_journal (
    id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    timestamp               TIMESTAMPTZ DEFAULT NOW(),
    admin_id                UUID NOT NULL,
    thread_id               VARCHAR(128) NOT NULL,
    action_type             VARCHAR(64) NOT NULL,
    incident_category       incident_type,
    prompt_intent           TEXT NOT NULL,
    initial_state_snapshot  JSONB NOT NULL,
    mutated_state_snapshot  JSONB NOT NULL,
    relocation_plan         JSONB,                -- structured plan for undo support
    financial_delta_paisa   INT NOT NULL DEFAULT 0,
    digital_signature       TEXT NOT NULL,
    is_rolled_back          BOOLEAN NOT NULL DEFAULT FALSE,
    rolled_back_by_journal_id UUID REFERENCES operational_audit_journal(id)
);

CREATE INDEX IF NOT EXISTS idx_audit_thread
    ON operational_audit_journal (thread_id, timestamp DESC);

CREATE INDEX IF NOT EXISTS idx_audit_admin
    ON operational_audit_journal (admin_id, timestamp DESC);

-- Prevent UPDATE on audit rows except for rollback flag (enforce immutability)
CREATE OR REPLACE RULE audit_journal_no_delete AS
    ON DELETE TO operational_audit_journal DO INSTEAD NOTHING;

-- =============================================================================
-- SECTION 4: Stored Procedures (called by TransactionCoordinator via RPC)
-- =============================================================================

-- Atomically quarantine seats + relocate bookings + issue vouchers
-- Returns: JSONB with success status and financial delta
CREATE OR REPLACE FUNCTION apply_relocation_plan(
    p_show_id           UUID,
    p_quarantine_ids    UUID[],                  -- seat IDs to block
    p_relocations       JSONB,                   -- [{booking_id, old_seat_ids[], new_seat_ids[]}]
    p_voucher_code      TEXT,
    p_admin_id          UUID,
    p_thread_id         TEXT,
    p_prompt_intent     TEXT,
    p_financial_delta   INT
) RETURNS JSONB
LANGUAGE plpgsql
AS $$
DECLARE
    v_rel           JSONB;
    v_booking_id    UUID;
    v_old_ids       UUID[];
    v_new_ids       UUID[];
    v_seats_updated INT := 0;
    v_journal_id    UUID;
    v_initial_snap  JSONB;
    v_mutated_snap  JSONB;
BEGIN
    -- ── Snapshot initial state ────────────────────────────────────────────────
    SELECT jsonb_agg(ta)
    INTO v_initial_snap
    FROM ticket_allocations ta
    WHERE ta.show_id = p_show_id
      AND (
          ta.seat_id = ANY(p_quarantine_ids)
          OR ta.booking_id::TEXT IN (
              SELECT jsonb_array_elements(p_relocations)->>'booking_id'
          )
      );

    -- ── 1. Quarantine damaged seats ───────────────────────────────────────────
    UPDATE ticket_allocations
    SET    status     = 'MAINTENANCE_BLOCKED',
           updated_at = NOW()
    WHERE  show_id  = p_show_id
      AND  seat_id  = ANY(p_quarantine_ids)
      AND  status   IN ('AVAILABLE', 'RELOCATION_HOLD');

    -- ── 2. Process each booking relocation ────────────────────────────────────
    FOR v_rel IN SELECT * FROM jsonb_array_elements(p_relocations)
    LOOP
        v_booking_id := (v_rel->>'booking_id')::UUID;

        SELECT array_agg(u::UUID)
        INTO v_old_ids
        FROM jsonb_array_elements_text(v_rel->'old_seat_ids') u;

        SELECT array_agg(u::UUID)
        INTO v_new_ids
        FROM jsonb_array_elements_text(v_rel->'new_seat_ids') u;

        -- Block old seats as maintenance
        UPDATE ticket_allocations
        SET    status     = 'MAINTENANCE_BLOCKED',
               booking_id = NULL,
               updated_at = NOW()
        WHERE  show_id    = p_show_id
          AND  seat_id    = ANY(v_old_ids);

        -- Assign new recliner seats to booking
        UPDATE ticket_allocations
        SET    status     = 'BOOKED',
               booking_id = v_booking_id,
               updated_at = NOW()
        WHERE  show_id    = p_show_id
          AND  seat_id    = ANY(v_new_ids)
          AND  status     IN ('AVAILABLE', 'RELOCATION_HOLD');

        GET DIAGNOSTICS v_seats_updated = ROW_COUNT;

        -- Guard: if new seats weren't available, rollback the whole tx
        IF v_seats_updated != array_length(v_new_ids, 1) THEN
            RAISE EXCEPTION 'SEAT_CONFLICT: Not all target seats available for booking %', v_booking_id;
        END IF;

        -- Issue voucher code on booking
        UPDATE bookings
        SET    voucher_code = p_voucher_code,
               status       = 'RELOCATED',
               version      = version + 1,
               updated_at   = NOW()
        WHERE  id = v_booking_id;
    END LOOP;

    -- ── 3. Snapshot mutated state ─────────────────────────────────────────────
    SELECT jsonb_agg(ta)
    INTO v_mutated_snap
    FROM ticket_allocations ta
    WHERE ta.show_id = p_show_id
      AND (
          ta.seat_id = ANY(p_quarantine_ids)
          OR ta.booking_id::TEXT IN (
              SELECT jsonb_array_elements(p_relocations)->>'booking_id'
          )
      );

    -- ── 4. Write immutable audit record ──────────────────────────────────────
    INSERT INTO operational_audit_journal (
        admin_id, thread_id, action_type, incident_category,
        prompt_intent, initial_state_snapshot, mutated_state_snapshot,
        relocation_plan, financial_delta_paisa, digital_signature
    ) VALUES (
        p_admin_id, p_thread_id, 'QUARANTINE_AND_RELOCATE', 'HVAC_FAILURE',
        p_prompt_intent, v_initial_snap, v_mutated_snap,
        p_relocations, p_financial_delta, 'AGENT_SIGNED:' || p_thread_id
    ) RETURNING id INTO v_journal_id;

    RETURN jsonb_build_object(
        'success',       TRUE,
        'journal_id',    v_journal_id,
        'seats_blocked', array_length(p_quarantine_ids, 1)
    );

EXCEPTION WHEN OTHERS THEN
    -- The entire function runs in the caller's transaction; RAISE rolls it all back
    RAISE;
END;
$$;

-- Rollback a previous journal entry
CREATE OR REPLACE FUNCTION rollback_journal_entry(
    p_journal_id    UUID,
    p_admin_id      UUID
) RETURNS JSONB
LANGUAGE plpgsql
AS $$
DECLARE
    v_entry operational_audit_journal%ROWTYPE;
    v_seat  JSONB;
    v_undo_id UUID;
BEGIN
    SELECT * INTO v_entry
    FROM operational_audit_journal
    WHERE id = p_journal_id AND is_rolled_back = FALSE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'JOURNAL_NOT_FOUND: % or already rolled back', p_journal_id;
    END IF;

    -- Restore each seat allocation to initial state
    FOR v_seat IN SELECT * FROM jsonb_array_elements(v_entry.initial_state_snapshot)
    LOOP
        UPDATE ticket_allocations
        SET    status     = (v_seat->>'status')::seat_status,
               booking_id = (v_seat->>'booking_id')::UUID,
               updated_at = NOW()
        WHERE  id = (v_seat->>'id')::UUID;
    END LOOP;

    -- Restore booking statuses
    UPDATE bookings b
    SET    status  = 'CONFIRMED',
           version = version + 1
    FROM   jsonb_array_elements(v_entry.relocation_plan) rel
    WHERE  b.id = (rel->>'booking_id')::UUID;

    -- Write undo audit record
    INSERT INTO operational_audit_journal (
        admin_id, thread_id, action_type, prompt_intent,
        initial_state_snapshot, mutated_state_snapshot,
        financial_delta_paisa, digital_signature
    ) VALUES (
        p_admin_id, v_entry.thread_id, 'ROLLBACK',
        'Undo of journal entry ' || p_journal_id::TEXT,
        v_entry.mutated_state_snapshot, v_entry.initial_state_snapshot,
        -v_entry.financial_delta_paisa, 'ROLLBACK_SIGNED:' || p_admin_id::TEXT
    ) RETURNING id INTO v_undo_id;

    -- Mark original as rolled back
    UPDATE operational_audit_journal
    SET    is_rolled_back          = TRUE,
           rolled_back_by_journal_id = v_undo_id
    WHERE  id = p_journal_id;

    RETURN jsonb_build_object('success', TRUE, 'undo_journal_id', v_undo_id);
END;
$$;

-- =============================================================================
-- SECTION 5: Seed Data (for development / demo)
-- =============================================================================

DO $$
DECLARE
    v_theater_id  UUID;
    v_screen2_id  UUID;
    v_screen4_id  UUID;
    v_show2_id    UUID;
    v_show4_id    UUID;
    row_labels    TEXT[] := ARRAY['A','B','C','D','E','F','G','H','M','N'];
    row_label     TEXT;
    col_i         INT;
    tier_val      seat_tier;
    new_seat_id   UUID;
BEGIN
    -- Theater
    INSERT INTO theaters (name, city) VALUES ('Central Cinemas', 'Mumbai')
    RETURNING id INTO v_theater_id;

    -- Screen 2 (200 seats, 10 rows × 20 cols)
    INSERT INTO screens (theater_id, screen_number, total_rows, total_cols)
    VALUES (v_theater_id, '2', 10, 20) RETURNING id INTO v_screen2_id;

    -- Screen 4 (180 seats, 9 rows × 20 cols)
    INSERT INTO screens (theater_id, screen_number, total_rows, total_cols)
    VALUES (v_theater_id, '4', 9, 20) RETURNING id INTO v_screen4_id;

    -- Seat topology for Screen 2
    FOREACH row_label IN ARRAY row_labels LOOP
        tier_val := CASE
            WHEN row_label IN ('M','N') THEN 'LUXURY_RECLINER'
            WHEN row_label IN ('E','F','G','H') THEN 'PRIME'
            ELSE 'STANDARD'
        END;
        FOR col_i IN 1..20 LOOP
            INSERT INTO seats (screen_id, row_label, col_index, tier)
            VALUES (v_screen2_id, row_label, col_i, tier_val);
        END LOOP;
    END LOOP;

    -- Shows
    INSERT INTO shows (screen_id, movie_title, start_time, base_price_cents)
    VALUES (v_screen2_id, 'Dune: Part Three', NOW() + INTERVAL '30 minutes', 50000)
    RETURNING id INTO v_show2_id;

    INSERT INTO shows (screen_id, movie_title, start_time, base_price_cents)
    VALUES (v_screen4_id, 'Re-Release Classic', NOW() + INTERVAL '45 minutes', 30000)
    RETURNING id INTO v_show4_id;

    -- Initialize all Screen 2 seat allocations as AVAILABLE
    INSERT INTO ticket_allocations (show_id, seat_id, status, price_cents)
    SELECT v_show2_id, s.id, 'AVAILABLE', 50000
    FROM seats s WHERE s.screen_id = v_screen2_id;

END $$;
