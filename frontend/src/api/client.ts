/**
 * Typed Axios API client for the CinemaOps backend.
 * All requests include the admin JWT from localStorage.
 */

import axios from 'axios';
import type { AgentChatResponse, AuditEntry, SeatAllocation } from '../types/sdui';

const BASE_URL = import.meta.env.VITE_API_URL ?? 'http://localhost:8000';

const client = axios.create({
  baseURL: BASE_URL,
  timeout: 30_000,
  headers: { 'Content-Type': 'application/json' },
});

// Inject admin JWT on every request
client.interceptors.request.use((config) => {
  const token = localStorage.getItem('cinemaops_token');
  if (token) {
    config.headers.Authorization = `Bearer ${token}`;
  }
  return config;
});

// ─── Agent endpoints ──────────────────────────────────────────────────────────

export async function sendAgentMessage(
  showId: string,
  message: string,
  threadId?: string,
): Promise<AgentChatResponse> {
  const { data } = await client.post<AgentChatResponse>('/api/v1/agent/chat', {
    show_id: showId,
    message,
    thread_id: threadId,
  });
  return data;
}

export async function resumeAgent(
  threadId: string,
  checkpointId: string,
  adminSignature: string,
): Promise<AgentChatResponse> {
  const { data } = await client.post<AgentChatResponse>('/api/v1/agent/resume', {
    thread_id: threadId,
    checkpoint_id: checkpointId,
    admin_signature: adminSignature,
  });
  return data;
}

export async function undoAction(journalId: string): Promise<{ status: string }> {
  const { data } = await client.post('/api/v1/agent/undo', { journal_id: journalId });
  return data;
}

export async function getAuditLog(): Promise<AuditEntry[]> {
  const { data } = await client.get<{ entries: AuditEntry[] }>('/api/v1/agent/audit');
  return data.entries;
}

// ─── Show endpoints ───────────────────────────────────────────────────────────

export async function getShowTopology(
  showId: string,
): Promise<{ show_id: string; total_seats: number; allocated: SeatAllocation[]; occupancy_pct: number }> {
  const { data } = await client.get(`/api/v1/shows/${showId}/topology`);
  return data;
}
