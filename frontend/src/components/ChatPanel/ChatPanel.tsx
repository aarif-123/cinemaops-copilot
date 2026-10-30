/**
 * ChatPanel — natural-language command input and agent response stream.
 *
 * Shows the full message history, a latency badge, and a loading spinner
 * during agent inference. Uses the useAgentSession hook for all state.
 */

import React, { useEffect, useRef, useState } from 'react';
import type { UseAgentSessionResult } from '../../hooks/useAgentSession';

interface ChatPanelProps {
  showId: string;
  session: UseAgentSessionResult;
}

const QUICK_COMMANDS = [
  'AC leaking on E8 through F14. Block and relocate to recliners.',
  'Check occupancy for this show.',
  'Undo previous action.',
];

const ChatPanel: React.FC<ChatPanelProps> = ({ showId, session }) => {
  const [input, setInput] = useState('');
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [session.messages]);

  const handleSend = async () => {
    const text = input.trim();
    if (!text || session.status === 'loading' || session.status === 'committing') return;
    setInput('');
    await session.sendMessage(showId, text);
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void handleSend();
    }
  };

  const isLoading = session.status === 'loading' || session.status === 'committing';

  return (
    <div className="chat-panel">
      {/* Header */}
      <div className="chat-panel__header">
        <div>
          <div className="chat-panel__title">🤖 CinemaOps Copilot</div>
          <div className="text-xs text-muted mt-2">Groq · Llama 3.3 70B · HITL-Safe</div>
        </div>
        <div className="flex items-center gap-2">
          {session.latencyMs !== null && (
            <span className="latency-badge">⚡ {session.latencyMs}ms</span>
          )}
          {session.status !== 'idle' && (
            <span className={`badge badge--${
              session.status === 'awaiting_approval' ? 'warning' :
              session.status === 'error' ? 'danger' :
              session.status === 'done' ? 'success' : 'info'
            }`}>
              {session.status.replace('_', ' ')}
            </span>
          )}
        </div>
      </div>

      {/* Messages */}
      <div className="chat-panel__messages" id="chat-messages">
        {session.messages.length === 0 && (
          <div style={{ padding: '24px', textAlign: 'center' }}>
            <div style={{ fontSize: '2rem', marginBottom: '12px' }}>🎬</div>
            <div style={{ color: '#475569', fontSize: '0.85rem' }}>
              Describe an operational situation and I'll analyze and plan a response.
            </div>
            <div style={{ marginTop: '16px', display: 'flex', flexDirection: 'column', gap: '8px' }}>
              {QUICK_COMMANDS.map((cmd) => (
                <button
                  key={cmd}
                  className="btn btn--ghost btn--sm"
                  onClick={() => setInput(cmd)}
                  style={{ justifyContent: 'flex-start', textAlign: 'left', fontSize: '0.75rem' }}
                >
                  {cmd}
                </button>
              ))}
            </div>
          </div>
        )}

        {session.messages.map((msg, i) => (
          <div
            key={i}
            className={`chat-message chat-message--${msg.role}`}
          >
            <div style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{msg.content}</div>
            <div style={{ marginTop: '6px', fontSize: '0.65rem', opacity: 0.5 }}>
              {msg.timestamp.toLocaleTimeString()}
            </div>
          </div>
        ))}

        {isLoading && (
          <div className="chat-message chat-message--agent">
            <div className="flex items-center gap-2">
              <div className="spinner" />
              <span style={{ fontSize: '0.8rem', color: '#64748b' }}>
                {session.status === 'committing' ? 'Committing transaction…' : 'Analyzing…'}
              </span>
            </div>
          </div>
        )}
        <div ref={messagesEndRef} />
      </div>

      {/* Input */}
      <div className="chat-panel__input-area">
        <textarea
          ref={inputRef}
          id="chat-input"
          className="input"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Describe the operational situation…"
          disabled={isLoading}
          rows={2}
          style={{ resize: 'none', flex: 1 }}
        />
        <button
          id="chat-send-btn"
          className="btn btn--primary"
          onClick={void handleSend}
          disabled={!input.trim() || isLoading}
          style={{ alignSelf: 'flex-end', height: '42px' }}
        >
          {isLoading ? <div className="spinner" style={{ width: 14, height: 14 }} /> : '↑'}
        </button>
      </div>
    </div>
  );
};

export default ChatPanel;
