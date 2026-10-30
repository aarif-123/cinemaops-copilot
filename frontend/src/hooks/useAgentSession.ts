/**
 * useAgentSession — manages the full agent interaction lifecycle.
 *
 * States:
 *   idle → loading → awaiting_approval → (approved → committing → done)
 *                                      → (rejected → idle)
 *
 * The HITL state machine mirrors the LangGraph graph on the backend.
 */

import { useCallback, useState } from 'react';
import { resumeAgent, sendAgentMessage } from '../api/client';
import type { AgentChatResponse, HitlPayload } from '../types/sdui';

export type SessionStatus = 'idle' | 'loading' | 'awaiting_approval' | 'committing' | 'done' | 'error';

export interface AgentMessage {
  role: 'user' | 'agent';
  content: string;
  timestamp: Date;
}

export interface UseAgentSessionResult {
  messages: AgentMessage[];
  status: SessionStatus;
  hitlPayload: HitlPayload | null;
  threadId: string | null;
  latencyMs: number | null;
  sendMessage: (showId: string, text: string) => Promise<void>;
  approve: (adminSignature: string) => Promise<void>;
  reject: () => void;
  reset: () => void;
}

export function useAgentSession(): UseAgentSessionResult {
  const [messages, setMessages] = useState<AgentMessage[]>([]);
  const [status, setStatus] = useState<SessionStatus>('idle');
  const [hitlPayload, setHitlPayload] = useState<HitlPayload | null>(null);
  const [threadId, setThreadId] = useState<string | null>(null);
  const [checkpointId, setCheckpointId] = useState<string | null>(null);
  const [latencyMs, setLatencyMs] = useState<number | null>(null);

  const pushMessage = (role: AgentMessage['role'], content: string) => {
    setMessages((prev) => [...prev, { role, content, timestamp: new Date() }]);
  };

  const sendMessage = useCallback(
    async (showId: string, text: string) => {
      pushMessage('user', text);
      setStatus('loading');
      const start = performance.now();

      try {
        const response: AgentChatResponse = await sendAgentMessage(showId, text, threadId ?? undefined);
        setLatencyMs(Math.round(performance.now() - start));
        setThreadId(response.thread_id);

        if (response.status === 'awaiting_approval' && response.hitl_payload) {
          setHitlPayload(response.hitl_payload);
          setCheckpointId(response.checkpoint_id ?? null);
          setStatus('awaiting_approval');
          pushMessage('agent', response.message);
        } else if (response.status === 'error') {
          setStatus('error');
          pushMessage('agent', `❌ ${response.message}`);
        } else {
          setStatus('done');
          pushMessage('agent', response.message);
          setTimeout(() => setStatus('idle'), 2000);
        }
      } catch (err) {
        setStatus('error');
        pushMessage('agent', `❌ Request failed: ${String(err)}`);
      }
    },
    [threadId],
  );

  const approve = useCallback(
    async (adminSignature: string) => {
      if (!threadId || !checkpointId) return;
      setStatus('committing');

      try {
        const response = await resumeAgent(threadId, checkpointId, adminSignature);
        setHitlPayload(null);

        if (response.status === 'error') {
          setStatus('error');
          pushMessage('agent', `❌ Commit failed: ${response.message}`);
        } else {
          setStatus('done');
          pushMessage('agent', `✅ ${response.message}`);
          setTimeout(() => setStatus('idle'), 3000);
        }
      } catch (err) {
        setStatus('error');
        pushMessage('agent', `❌ Resume failed: ${String(err)}`);
      }
    },
    [threadId, checkpointId],
  );

  const reject = useCallback(() => {
    setHitlPayload(null);
    setStatus('idle');
    pushMessage('agent', '⚠️ Operation aborted. No changes were made.');
  }, []);

  const reset = useCallback(() => {
    setMessages([]);
    setStatus('idle');
    setHitlPayload(null);
    setThreadId(null);
    setCheckpointId(null);
    setLatencyMs(null);
  }, []);

  return { messages, status, hitlPayload, threadId, latencyMs, sendMessage, approve, reject, reset };
}
