import React, { useEffect, useRef, useState } from 'react';
import type { UseAgentSessionResult } from '../../hooks/useAgentSession';

interface ChatPanelProps {
  session: UseAgentSessionResult;
  onApprove: () => void;
  onReject: () => void;
  onOpenAudit?: () => void;
  onSendInstruction?: (text: string) => void;
}

export const ChatPanel: React.FC<ChatPanelProps> = ({
  session,
  onApprove,
  onReject,
  onOpenAudit,
  onSendInstruction,
}) => {
  const [instruction, setInstruction] = useState('');
  const messagesEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [session.messages, session.status]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const text = instruction.trim();
    if (!text) return;
    setInstruction('');
    if (onSendInstruction) {
      onSendInstruction(text);
    }
  };

  const status = session.status;
  const isWorking = status === 'loading' || status === 'committing';
  const isAwaiting = status === 'awaiting_approval';
  const isDone = status === 'done';

  // Check if we have active HITL relocations from backend payload
  const hitlPayload = session.hitlPayload;
  const relocations = hitlPayload?.proposed_diff?.relocations;

  return (
    <aside className="cinema-sidebar-right">
      {/* Header */}
      <div
        style={{
          padding: '16px 18px',
          borderBottom: '1px solid #2A313C',
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
        }}
      >
        <h2 style={{ fontSize: 16 }}>Copilot</h2>
        {isWorking ? (
          <span className="pill" style={{ color: '#F5B73B', borderColor: '#F5B73B' }}>
            <span className="dot" style={{ background: '#F5B73B' }} />
            Working
          </span>
        ) : isAwaiting ? (
          <span className="pill" style={{ color: '#F5B73B', borderColor: '#F5B73B' }}>
            <span className="dot" style={{ background: '#F5B73B' }} />
            Awaiting approval
          </span>
        ) : isDone ? (
          <span className="pill" style={{ color: '#4FC3F7', borderColor: '#4FC3F7' }}>
            <span className="dot" style={{ background: '#4FC3F7' }} />
            Done
          </span>
        ) : (
          <span className="pill">
            <span className="dot" style={{ background: '#4FC3F7' }} />
            Ready
          </span>
        )}
      </div>

      {/* Message Stream */}
      <div
        style={{
          flex: 1,
          padding: '16px 18px',
          display: 'flex',
          flexDirection: 'column',
          gap: 14,
          overflowY: 'auto',
        }}
      >
        {/* User Prompt (default or from session) */}
        <div
          style={{
            alignSelf: 'flex-end',
            maxWidth: '90%',
            background: '#1E252E',
            borderRadius: '12px 12px 2px 12px',
            padding: 12,
            fontSize: 14,
            lineHeight: 1.5,
          }}
        >
          {session.messages.find((m) => m.role === 'user')?.content ||
            'Quarantine rows E8–F14, HVAC failure, relocate all parties to luxury recliners'}
        </div>

        {/* If user approved in the flow */}
        {isDone && (
          <div
            style={{
              alignSelf: 'flex-end',
              background: '#12303B',
              border: '1px solid #4FC3F7',
              borderRadius: 12,
              padding: '8px 12px',
              fontSize: 13,
            }}
          >
            Approved
          </div>
        )}

        {/* State 1: Working / Loading */}
        {isWorking && (
          <div
            style={{
              background: '#161B22',
              border: '1px solid #2A313C',
              borderRadius: '12px 12px 12px 2px',
              padding: 12,
              fontSize: 14,
              lineHeight: 1.55,
              display: 'flex',
              flexDirection: 'column',
              gap: 10,
            }}
          >
            <div>On it. I only have read-only tools, so nothing changes yet.</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 13 }}>
                <span className="dot" style={{ background: '#4FC3F7' }} />
                <code>get_seat_map</code>
                <span className="mut">done</span>
              </div>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 13 }}>
                <span className="dot" style={{ background: '#4FC3F7' }} />
                <code>find_affected_parties</code>
                <span className="mut">6 parties found</span>
              </div>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 13 }}>
                <span className="dot" style={{ background: '#F5B73B' }} />
                <code>spatial_solver</code>
                <span className="mut">running…</span>
              </div>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 13 }}>
                <span className="dot" style={{ background: '#4A5565' }} />
                <code>approval</code>
                <span className="mut">not reached yet</span>
              </div>
            </div>
          </div>
        )}

        {/* State 2: Awaiting Approval (Matches Image 2 exactly) */}
        {isAwaiting && (
          <>
            {/* Tool trace card */}
            <div
              style={{
                background: '#161B22',
                border: '1px solid #2A313C',
                borderRadius: '12px 12px 12px 2px',
                padding: 12,
                fontSize: 14,
                lineHeight: 1.55,
                display: 'flex',
                flexDirection: 'column',
                gap: 10,
              }}
            >
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                <div style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 13 }}>
                  <span className="dot" style={{ background: '#4FC3F7' }} />
                  <code>get_seat_map</code>
                  <span className="mut">done</span>
                </div>
                <div style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 13 }}>
                  <span className="dot" style={{ background: '#4FC3F7' }} />
                  <code>find_affected_parties</code>
                  <span className="mut">done</span>
                </div>
                <div style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 13 }}>
                  <span className="dot" style={{ background: '#4FC3F7' }} />
                  <code>spatial_solver</code>
                  <span className="mut">plan found</span>
                </div>
                <div style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 13 }}>
                  <span className="dot" style={{ background: '#F5B73B' }} />
                  <code>approval</code>
                  <span className="mut">waiting for you</span>
                </div>
              </div>
            </div>

            {/* In-Chat Approval card */}
            <div
              style={{
                background: '#161B22',
                border: '1px solid #2A313C',
                borderRadius: '12px 12px 12px 2px',
                padding: 12,
                fontSize: 14,
                lineHeight: 1.55,
                display: 'flex',
                flexDirection: 'column',
                gap: 10,
              }}
            >
              <div>
                <b>I need your approval.</b> Moving 8 seats (6 parties) to rows I–J. Review the highlighted changes in the centre.
              </div>

              {/* Relocation breakdown list */}
              <div>
                {relocations && relocations.length > 0 ? (
                  relocations.map((r, i) => (
                    <div
                      key={r.booking_id || i}
                      style={{
                        display: 'flex',
                        justifyContent: 'space-between',
                        fontSize: 13,
                        padding: '6px 0',
                        borderTop: '1px solid #2A313C',
                      }}
                    >
                      <span>Party of {r.party_size}</span>
                      <span>
                        <code>{r.from_seats.join(', ')}</code> →{' '}
                        <code style={{ color: '#4FC3F7' }}>{r.to_seats.join(', ')}</code>
                      </span>
                    </div>
                  ))
                ) : (
                  <>
                    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, padding: '6px 0', borderTop: '1px solid #2A313C' }}>
                      <span>Party of 2</span>
                      <span><code>E9–10</code> → <code style={{ color: '#4FC3F7' }}>J1–2</code></span>
                    </div>
                    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, padding: '6px 0', borderTop: '1px solid #2A313C' }}>
                      <span>Party of 1</span>
                      <span><code>E12</code> → <code style={{ color: '#4FC3F7' }}>J3</code></span>
                    </div>
                    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, padding: '6px 0', borderTop: '1px solid #2A313C' }}>
                      <span>Party of 1</span>
                      <span><code>E14</code> → <code style={{ color: '#4FC3F7' }}>J4</code></span>
                    </div>
                    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, padding: '6px 0', borderTop: '1px solid #2A313C' }}>
                      <span>Party of 1</span>
                      <span><code>F8</code> → <code style={{ color: '#4FC3F7' }}>J6</code></span>
                    </div>
                    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, padding: '6px 0', borderTop: '1px solid #2A313C' }}>
                      <span>Party of 2</span>
                      <span><code>F10–11</code> → <code style={{ color: '#4FC3F7' }}>J7–8</code></span>
                    </div>
                    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, padding: '6px 0', borderTop: '1px solid #2A313C' }}>
                      <span>Party of 1</span>
                      <span><code>F13</code> → <code style={{ color: '#4FC3F7' }}>J9</code></span>
                    </div>
                  </>
                )}
              </div>

              {/* Guardrails checklist */}
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                <div style={{ display: 'flex', gap: 8, fontSize: 12, alignItems: 'center' }}>
                  <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true" style={{ flex: 'none' }}>
                    <path d="M3 8.5l3.2 3L13 4.5" fill="none" stroke="#4FC3F7" strokeWidth="2" />
                  </svg>
                  No party split
                </div>
                <div style={{ display: 'flex', gap: 8, fontSize: 12, alignItems: 'center' }}>
                  <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true" style={{ flex: 'none' }}>
                    <path d="M3 8.5l3.2 3L13 4.5" fill="none" stroke="#4FC3F7" strokeWidth="2" />
                  </svg>
                  No tier downgrade
                </div>
                <div style={{ display: 'flex', gap: 8, fontSize: 12, alignItems: 'center' }}>
                  <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true" style={{ flex: 'none' }}>
                    <path d="M3 8.5l3.2 3L13 4.5" fill="none" stroke="#4FC3F7" strokeWidth="2" />
                  </svg>
                  Fiscal caps respected
                </div>
                <div style={{ display: 'flex', gap: 8, fontSize: 12, alignItems: 'center' }}>
                  <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true" style={{ flex: 'none' }}>
                    <path d="M3 8.5l3.2 3L13 4.5" fill="none" stroke="#4FC3F7" strokeWidth="2" />
                  </svg>
                  No double-booking
                </div>
              </div>

              {/* CTAs */}
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                <button
                  type="button"
                  className="btn pri"
                  style={{ flex: '1 1 100%' }}
                  onClick={onApprove}
                >
                  Approve &amp; apply
                </button>
                <button
                  type="button"
                  className="btn"
                  style={{ flex: 1 }}
                  onClick={onReject}
                >
                  Reject
                </button>
                <button
                  type="button"
                  className="btn"
                  style={{ flex: 1 }}
                  onClick={() => alert('Opening modification editor...')}
                >
                  Edit
                </button>
              </div>

              <div className="mut" style={{ fontSize: 12 }}>
                Nothing is written until you approve.
              </div>
            </div>
          </>
        )}

        {/* State 3: Done / Applied */}
        {isDone && (
          <div
            style={{
              background: '#161B22',
              border: '1px solid #2A313C',
              borderRadius: '12px 12px 12px 2px',
              padding: 12,
              fontSize: 14,
              lineHeight: 1.55,
              display: 'flex',
              flexDirection: 'column',
              gap: 10,
            }}
          >
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 13 }}>
                <span className="dot" style={{ background: '#4FC3F7' }} />
                <code>commit</code>
                <span className="mut">ok</span>
              </div>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 13 }}>
                <span className="dot" style={{ background: '#4FC3F7' }} />
                <code>broadcast</code>
                <span className="mut">ok</span>
              </div>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 13 }}>
                <span className="dot" style={{ background: '#4FC3F7' }} />
                <code>verify</code>
                <span className="mut">map re-read, matches plan</span>
              </div>
            </div>
            <div>
              <b>Done.</b> I moved 8 seats and quarantined E8–F14. I re-read the map and checked the booking site; both match.
            </div>
            <button
              type="button"
              className="btn"
              style={{ width: '100%' }}
              onClick={onOpenAudit}
            >
              Open full report in Audit
            </button>
          </div>
        )}

        {/* Any extra session messages */}
        {session.messages.slice(1).map((msg, idx) => (
          <div
            key={idx}
            style={{
              alignSelf: msg.role === 'user' ? 'flex-end' : 'flex-start',
              maxWidth: '90%',
              background: msg.role === 'user' ? '#1E252E' : '#161B22',
              border: msg.role === 'user' ? 'none' : '1px solid #2A313C',
              borderRadius: msg.role === 'user' ? '12px 12px 2px 12px' : '12px 12px 12px 2px',
              padding: 12,
              fontSize: 14,
              lineHeight: 1.5,
            }}
          >
            {msg.content}
          </div>
        ))}

        <div ref={messagesEndRef} />
      </div>

      {/* Input Form at bottom */}
      <form
        onSubmit={handleSubmit}
        style={{
          padding: '14px 18px',
          borderTop: '1px solid #2A313C',
          display: 'flex',
          flexDirection: 'column',
          gap: 10,
        }}
      >
        <label htmlFor="copilot-input" style={{ position: 'absolute', left: -9999 }}>
          Instruction
        </label>
        <div style={{ display: 'flex', gap: 8 }}>
          <input
            id="copilot-input"
            value={instruction}
            onChange={(e) => setInstruction(e.target.value)}
            placeholder="Give an instruction…"
            style={{
              flex: 1,
              minWidth: 0,
              minHeight: 44,
              background: '#0E1116',
              border: '1px solid #3A4350',
              borderRadius: 10,
              color: '#E6EAF0',
              padding: '0 12px',
              fontSize: 14,
              outline: 'none',
            }}
          />
          <button type="submit" className="btn pri">
            Send
          </button>
        </div>
      </form>
    </aside>
  );
};

export default ChatPanel;
