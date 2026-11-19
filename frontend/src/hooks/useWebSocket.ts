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
  reconnect: () => void;
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
  const shouldReconnectRef = useRef(true);

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
      if (shouldReconnectRef.current) scheduleReconnect();
    };

    ws.onerror = () => {
      setError('WebSocket connection error. Reconnecting…');
    };
  }, [showId, token]);

  const applyPatches = useCallback((patches: WsUiStatePatch['patches']) => {
    setAllocations((prev) => {
      let next = [...prev];
      for (const patch of patches) {
        if (typeof patch.path !== 'string' || !patch.path.startsWith('/seats/')) continue;
        const seatId = patch.path.slice('/seats/'.length);
        if (!seatId || seatId.includes('/')) continue;

        switch (patch.op) {
          case 'replace':
            next = next.map((alloc) =>
              alloc.seat_id === seatId
                ? { ...alloc, ...(patch.value as Partial<SeatAllocation>) }
                : alloc,
            );
            break;
          case 'add':
            if (!next.some((alloc) => alloc.seat_id === seatId)) {
              next.push(
                patch.value as unknown as SeatAllocation,
              );
            }
            break;
          case 'remove':
            next = next.filter((alloc) => alloc.seat_id !== seatId);
            break;
          default:
            // move, copy, test are not used by the seat map stream
            break;
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

  // Manual reconnect — clears backoff and reconnects immediately
  const reconnect = useCallback(() => {
    attemptRef.current = 0;
    if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
    if (wsRef.current) {
      wsRef.current.close();
    }
    connect();
  }, [connect]);

  useEffect(() => {
    shouldReconnectRef.current = true;
    setAllocations([]);
    setVersion(0);
    setError(null);
    connect();
    return () => {
      shouldReconnectRef.current = false;
      wsRef.current?.close();
      if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
      if (pingTimerRef.current) clearInterval(pingTimerRef.current);
    };
  }, [connect]);

  return { allocations, connected, version, error, reconnect };
}
