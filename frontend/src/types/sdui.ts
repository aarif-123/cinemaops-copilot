/**
 * SDUI and WebSocket event type definitions.
 * Aligned with the RFC 6902 JSON Patch wire contract defined in the backend.
 */

// ─── RFC 6902 JSON Patch ──────────────────────────────────────────────────────

export type JsonPatchOp = 'add' | 'remove' | 'replace' | 'move' | 'copy' | 'test';

export interface JsonPatch {
  op: JsonPatchOp;
  path: string;
  value?: unknown;
  from?: string;
}

// ─── Seat State ───────────────────────────────────────────────────────────────

export type SeatStatus =
  | 'AVAILABLE'
  | 'LOCKED_CART'
  | 'BOOKED'
  | 'MAINTENANCE_BLOCKED'
  | 'RELOCATION_HOLD'
  | 'BOOKED_UPGRADED';

export type SeatTier = 'STANDARD' | 'PRIME' | 'LUXURY_RECLINER';

export type RenderVariant =
  | 'SOLID_GREEN'
  | 'SOLID_SLATE'
  | 'SOLID_AMBER'
  | 'STRIPED_CRIMSON_HAZARD'
  | 'STRIPED_AMBER';

export interface SeatStyle {
  variant: RenderVariant;
  badge?: 'VIP_UPGRADE' | null;
}

export interface SeatState {
  status: SeatStatus;
  interactive: boolean;
  style: SeatStyle;
}

// ─── Seat Map Grid ────────────────────────────────────────────────────────────

export interface SeatAllocation {
  id: string;
  seat_id: string;
  status: SeatStatus;
  price_cents: number;
  booking_id?: string;
  seat: {
    id: string;
    row_label: string;
    col_index: number;
    tier: SeatTier;
    is_active: boolean;
  };
  booking?: {
    id: string;
    party_size: number;
    status: string;
  };
}

// ─── WebSocket Event Payloads ─────────────────────────────────────────────────

export interface WsInitialSnapshot {
  event: 'INITIAL_SNAPSHOT';
  show_id: string;
  data: {
    show_id: string;
    allocations: SeatAllocation[];
  };
}

export interface WsUiStatePatch {
  event: 'UI_STATE_PATCH';
  meta: {
    trace_id: string;
    timestamp: string;
    version: number;
    show_id: string;
  };
  patches: JsonPatch[];
}

export type WsEvent = WsInitialSnapshot | WsUiStatePatch;

// ─── HITL Payload ─────────────────────────────────────────────────────────────

export interface HitlImpact {
  seats_quarantined: number;
  parties_relocated: number;
  guests_total: number;
  revenue_exposure_inr: number;
}

export interface HitlRelocation {
  booking_id: string;
  party_size: number;
  from_seats: string[];
  to_seats: string[];
  tier_change: string;
  compensation_inr: number;
}

export interface HitlDiff {
  quarantine: { seat_ids: string[]; render: string };
  relocations: HitlRelocation[];
  financial_summary: {
    total_vouchers_inr: number;
    parties_affected: number;
    guests_relocated: number;
  };
}

export interface HitlPayload {
  action_required: string;
  impact_assessment: HitlImpact;
  proposed_diff: HitlDiff;
  invariant_affirmations: string[];
  checkpoint_id: string;
  thread_id: string;
}

// ─── Agent API ────────────────────────────────────────────────────────────────

export interface AgentChatResponse {
  thread_id: string;
  checkpoint_id?: string;
  status: 'completed' | 'awaiting_approval' | 'error';
  message: string;
  hitl_payload?: HitlPayload;
  execution_result?: Record<string, unknown>;
}

export interface AgentResumeResponse {
  thread_id: string;
  status: 'committed' | 'error';
  message: string;
  execution_result?: Record<string, unknown>;
}

export interface AuditEntry {
  id: string;
  timestamp: string;
  admin_id: string;
  action_type: string;
  prompt_intent: string;
  financial_delta_paisa: number;
  is_rolled_back: boolean;
}

// ─── Occupancy ────────────────────────────────────────────────────────────────

export interface OccupancyResponse {
  show_id: string;
  total_seats: number;
  booked: number;
  available: number;
  occupancy_pct: number;
}

// ─── Agent status ─────────────────────────────────────────────────────────────

export interface AgentStatusResponse {
  thread_id: string;
  next_nodes: string[];
  status: 'awaiting_approval' | 'completed';
  values: Record<string, unknown>;
}
