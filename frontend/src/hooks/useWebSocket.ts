/**
 * useWebSocket — managed WebSocket connection with RFC 6902 JSON Patch application.
 *
 * Handles:
 *  - Initial snapshot delivery
 *  - Incremental UI_STATE_PATCH application via immer-style state merging
 *  - Automatic reconnection with exponential backoff
 *  - Ping/pong keepalive every 30s
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { SeatAllocation, WsEvent, WsInitialSnapshot, WsUiStatePatch } from '../types/sdui';

const WS_BASE = import.meta.env.VITE_WS_URL ?? 'ws://localhost:8000';
const RECONNECT_BASE_MS = 1000;
const MAX_RECONNECT_MS = 30_000;
const PING_INTERVAL_MS = 30_000;

export interface UseWebSocketResult {
  allocations: SeatAllocation[];
  connected: boolean;
  version: number;
  error: string | null;
}

export function useWebSocket(showId: string, token: string): UseWebSocketResult {
  const [allocations, setAllocations] = useState<SeatAllocation[]>([]);
  const [connected, setConnected] = useState(false);
  const [version, setVersion] = useState(0);
  const [error, setError] = useState<string | null>(null);

  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pingTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const attemptRef = useRef(0);

  const connect = useCallback(() => {
    if (!showId || !token) return;

    const url = `${WS_BASE}/ws/show/${showId}?token=${encodeURIComponent(token)}`;
    const ws = new WebSocket(url);
    wsRef.current = ws;

    ws.onopen = () => {
      setConnected(true);
      setError(null);
      attemptRef.current = 0;

      // Keepalive ping
      pingTimerRef.current = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) ws.send('ping');
      }, PING_INTERVAL_MS);
    };

    ws.onmessage = (evt) => {
      let msg: WsEvent;
      try {
        msg = JSON.parse(evt.data as string) as WsEvent;
      } catch {
        return;
      }

      if (msg.event === 'INITIAL_SNAPSHOT') {
        const snap = msg as WsInitialSnapshot;
        setAllocations(snap.data.allocations ?? []);
      } else if (msg.event === 'UI_STATE_PATCH') {
        const patch = msg as WsUiStatePatch;
        setVersion(patch.meta.version);
        applyPatches(patch.patches);
      }
    };

    ws.onclose = () => {
      setConnected(false);
      if (pingTimerRef.current) clearInterval(pingTimerRef.current);
      scheduleReconnect();
    };

    ws.onerror = () => {
      setError('WebSocket connection error. Reconnecting…');
    };
  }, [showId, token]);

  const applyPatches = useCallback((patches: WsUiStatePatch['patches']) => {
    setAllocations((prev) => {
      let next = [...prev];
      for (const patch of patches) {
        if (patch.op === 'replace' && typeof patch.path === 'string') {
          // path: /seats/{seat_id}
          const seatId = patch.path.split('/seats/')[1];
          if (!seatId) continue;
          next = next.map((alloc) =>
            alloc.seat_id === seatId
              ? { ...alloc, ...(patch.value as Partial<SeatAllocation>) }
              : alloc,
          );
        }
      }
      return next;
    });
  }, []);

  const scheduleReconnect = useCallback(() => {
    const delay = Math.min(
      RECONNECT_BASE_MS * Math.pow(2, attemptRef.current),
      MAX_RECONNECT_MS,
    );
    attemptRef.current += 1;
    reconnectTimerRef.current = setTimeout(() => connect(), delay);
  }, [connect]);

  useEffect(() => {
    connect();
    return () => {
      wsRef.current?.close();
      if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
      if (pingTimerRef.current) clearInterval(pingTimerRef.current);
    };
  }, [connect]);

  return { allocations, connected, version, error };
}
