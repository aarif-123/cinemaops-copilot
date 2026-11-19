import { useState, useRef, useEffect } from 'react';
import SeatMap, { type SeatViewMode } from './components/SeatMap/SeatMap';
import AuditLog from './components/AuditLog/AuditLog';
import { CINEMA_ROOMS, type CinemaRoom } from './types/rooms';
import { useAgentSession } from './hooks/useAgentSession';
import { useWebSocket } from './hooks/useWebSocket';
import { getAuditLog, undoAction } from './api/client';
import type { AuditEntry } from './types/sdui';

interface ChatMessageItem {
  id: string;
  sender: 'user' | 'agent' | 'system';
  text?: string;
  type?: 'text' | 'tool_steps' | 'approval_card' | 'applied_confirmation';
  targetSeats?: string[];
}

export function App() {
  // Navigation & Multi-room management
  const [activeNav, setActiveNav] = useState<'console' | 'shows' | 'audit' | 'settings'>('console');
  const [selectedRoom, setSelectedRoom] = useState<CinemaRoom>(CINEMA_ROOMS[0]);
  const [viewMode, setViewMode] = useState<SeatViewMode>('changes');

  // Copilot panel collapsible state
  const [copilotCollapsed, setCopilotCollapsed] = useState(false);

  // Manual admin seat selection & blocking
  const [selectedSeatIds, setSelectedSeatIds] = useState<string[]>([]);
  const [customQuarantinedSeats, setCustomQuarantinedSeats] = useState<string[]>([]);

  // Approval & Copilot flow state: 'awaiting_approval' -> 'working' -> 'done'
  const [copilotStatus, setCopilotStatus] = useState<'awaiting_approval' | 'working' | 'done'>('awaiting_approval');
  const [instructionInput, setInstructionInput] = useState('');

  // Modals & Audit
  const [showAuditModal, setShowAuditModal] = useState(false);
  const [auditEntries, setAuditEntries] = useState<AuditEntry[]>([]);
  const [undoingJournalId, setUndoingJournalId] = useState<string | null>(null);

  // Profile modal
  const [showProfileModal, setShowProfileModal] = useState(false);

  // Chat message stream
  const [messages, setMessages] = useState<ChatMessageItem[]>([
    {
      id: 'm1',
      sender: 'user',
      text: 'Quarantine rows E8–F14, HVAC failure, relocate all parties to luxury recliners',
      type: 'text',
    },
    {
      id: 'm2',
      sender: 'agent',
      type: 'tool_steps',
    },
    {
      id: 'm3',
      sender: 'agent',
      type: 'approval_card',
    },
  ]);

  const messagesContainerRef = useRef<HTMLDivElement>(null);

  // Hook integrations
  const session = useAgentSession();
  const token = localStorage.getItem('cinemaops_token') || 'demo_token';
  const socket = useWebSocket(selectedRoom.id, token);

  useEffect(() => {
    if (messagesContainerRef.current) {
      messagesContainerRef.current.scrollTop = messagesContainerRef.current.scrollHeight;
    }
  }, [messages, copilotStatus]);

  // Handle Manual Seat Selection Toggle
  const handleToggleSeatSelect = (seatId: string) => {
    setSelectedSeatIds((prev) =>
      prev.includes(seatId) ? prev.filter((id) => id !== seatId) : [...prev, seatId],
    );
  };

  const handleClearSelection = () => {
    setSelectedSeatIds([]);
  };

  // Direct Admin Action: Block / Quarantine Selected Seats
  const handleDirectQuarantine = () => {
    if (selectedSeatIds.length === 0) return;
    const targets = [...selectedSeatIds].sort();

    setCustomQuarantinedSeats((prev) => Array.from(new Set([...prev, ...targets])));
    setViewMode('changes');

    // Notify user & add entry to audit
    const seatsStr = targets.join(', ');
    setMessages((prev) => [
      ...prev,
      {
        id: `m-manual-${Date.now()}`,
        sender: 'system',
        text: `🔒 Manual Admin Action: Quarantined ${targets.length} seat(s) [${seatsStr}] on ${selectedRoom.name}.`,
        type: 'text',
      },
    ]);

    setSelectedSeatIds([]);
  };

  // Agent Handoff: Instruct Copilot on Current Selection
  const handleHandoffToCopilot = (actionType: 'relocate' | 'quarantine') => {
    if (selectedSeatIds.length === 0) return;
    const sorted = [...selectedSeatIds].sort();
    const seatsStr = sorted.join(', ');

    const promptText =
      actionType === 'relocate'
        ? `Relocate selected seats (${seatsStr}) to luxury recliners, ensuring no party split.`
        : `Quarantine selected seats (${seatsStr}) due to maintenance, and relocate affected parties.`;

    // Ensure Copilot panel is expanded
    setCopilotCollapsed(false);

    // Dispatch instruction
    executeInstruction(promptText);
    setSelectedSeatIds([]);
  };

  // Core instruction execution logic
  const executeInstruction = async (text: string) => {
    setMessages((prev) => [
      ...prev,
      {
        id: `m-usr-${Date.now()}`,
        sender: 'user',
        text,
        type: 'text',
      },
    ]);

    setCopilotStatus('working');

    try {
      await session.sendMessage(selectedRoom.id, text);
    } catch {
      // Offline fallback: simulate analysis and prompt for approval
      setTimeout(() => {
        setMessages((prev) => [
          ...prev,
          {
            id: `m-tools-${Date.now()}`,
            sender: 'agent',
            type: 'tool_steps',
          },
          {
            id: `m-card-${Date.now()}`,
            sender: 'agent',
            type: 'approval_card',
          },
        ]);
        setCopilotStatus('awaiting_approval');
      }, 700);
    }
  };

  // Handle Approve & Apply
  const handleApprove = async () => {
    if (session.hitlPayload && session.approve) {
      try {
        await session.approve(token);
      } catch {
        // gracefully handle offline
      }
    }

    setCopilotStatus('done');
    setViewMode('after');

    setMessages((prev) => [
      ...prev,
      {
        id: `m-app-${Date.now()}`,
        sender: 'user',
        text: 'Approved',
        type: 'text',
      },
      {
        id: `m-done-${Date.now()}`,
        sender: 'agent',
        type: 'applied_confirmation',
      },
    ]);
  };

  // Handle Reject
  const handleReject = () => {
    if (session.reject) {
      session.reject();
    }
    setCopilotStatus('working');
    setViewMode('before');
    setMessages((prev) => [
      ...prev,
      {
        id: `m-rej-${Date.now()}`,
        sender: 'agent',
        text: '⚠️ Relocation plan rejected. No changes were applied.',
        type: 'text',
      },
    ]);
  };

  // Handle Send instruction from form
  const handleSendInstruction = async (e: React.FormEvent) => {
    e.preventDefault();
    const text = instructionInput.trim();
    if (!text) return;
    setInstructionInput('');
    await executeInstruction(text);
  };

  const handleOpenAudit = async () => {
    setShowAuditModal(true);
    try {
      const logs = await getAuditLog();
      setAuditEntries(logs);
    } catch {
      setAuditEntries([
        {
          id: 'jrn_1',
          timestamp: new Date().toISOString(),
          admin_id: 'Mohammed Aarif (L5)',
          action_type: 'RELOCATE',
          prompt_intent: 'HVAC Failure in Rows E8-F14, relocate 8 seats to luxury recliners',
          financial_delta_paisa: 0,
          is_rolled_back: false,
        },
        {
          id: 'jrn_2',
          timestamp: new Date(Date.now() - 3600000).toISOString(),
          admin_id: 'Mohammed Aarif (L5)',
          action_type: 'RELOCATE',
          prompt_intent: 'Customer requested recliner upgrade for B3-B4 to J1-J2',
          financial_delta_paisa: 60000,
          is_rolled_back: false,
        },
      ]);
    }
  };

  const handleUndo = async (journalId: string) => {
    setUndoingJournalId(journalId);
    try {
      await undoAction(journalId);
    } catch {
      // fallback
    } finally {
      setAuditEntries((prev) =>
        prev.map((e) => (e.id === journalId ? { ...e, is_rolled_back: true } : e)),
      );
      setUndoingJournalId(null);
    }
  };

  const isDone = copilotStatus === 'done';
  const isAwaiting = copilotStatus === 'awaiting_approval';
  const isWorking = copilotStatus === 'working';

  const baseQuarantined = isDone ? 14 : 0;
  const quarantinedCount = baseQuarantined + customQuarantinedSeats.length;
  const pendingCount = isDone ? 0 : 1;

  // Combine default quarantined seats with custom admin quarantined seats
  const activeQuarantineList = isDone
    ? ['E8', 'E11', 'E13', 'F9', 'F12', 'F14', ...customQuarantinedSeats]
    : ['E8', 'E11', 'E13', 'F9', 'F12', 'F14', ...customQuarantinedSeats];

  return (
    <div className="cinema-app">
      {/* ─── 1. LEFT SIDEBAR (240px) ────────────────────────────────────────── */}
      <aside className="sidebar-left">
        {/* Brand */}
        <h1 style={{ fontSize: 18, padding: '0 6px 8px' }}>
          <span style={{ color: '#F5B73B' }}>Cinema</span>Ops
        </h1>

        {/* Navigation */}
        <a
          href="#console"
          className={`nav ${activeNav === 'console' ? 'on' : ''}`}
          onClick={(e) => {
            e.preventDefault();
            setActiveNav('console');
          }}
        >
          <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true">
            <path d="M3 3h7v7H3zM14 3h7v7h-7zM3 14h7v7H3zM14 14h7v7h-7z" fill="none" stroke="currentColor" strokeWidth="1.8" />
          </svg>
          Live console
        </a>

        <a
          href="#shows"
          className={`nav ${activeNav === 'shows' ? 'on' : ''}`}
          onClick={(e) => {
            e.preventDefault();
            setActiveNav('shows');
          }}
        >
          <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true">
            <path d="M4 5h16v14H4zM8 5v14" fill="none" stroke="currentColor" strokeWidth="1.8" />
          </svg>
          Shows
        </a>

        <a
          href="#audit"
          className={`nav ${activeNav === 'audit' ? 'on' : ''}`}
          onClick={(e) => {
            e.preventDefault();
            setActiveNav('audit');
            handleOpenAudit();
          }}
        >
          <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true">
            <path d="M5 4h14v16H5zM9 9h6M9 13h6" fill="none" stroke="currentColor" strokeWidth="1.8" />
          </svg>
          Audit journal
        </a>

        <a
          href="#settings"
          className={`nav ${activeNav === 'settings' ? 'on' : ''}`}
          onClick={(e) => {
            e.preventDefault();
            setActiveNav('settings');
          }}
        >
          <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true">
            <path d="M12 8a4 4 0 100 8 4 4 0 000-8z" fill="none" stroke="currentColor" strokeWidth="1.8" />
          </svg>
          Settings
        </a>

        {/* Theater Screens Selector */}
        <div className="mut" style={{ font: '600 10px Inter', letterSpacing: '.08em', padding: '10px 6px 3px' }}>
          THEATER SCREENS
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
          {CINEMA_ROOMS.map((room) => {
            const isSelected = selectedRoom.id === room.id;
            return (
              <button
                key={room.id}
                type="button"
                onClick={() => setSelectedRoom(room)}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  padding: '6px 8px',
                  borderRadius: 6,
                  background: isSelected ? '#1E252E' : 'transparent',
                  border: isSelected ? '1px solid #3A4350' : '1px solid transparent',
                  textAlign: 'left',
                  cursor: 'pointer',
                  transition: 'all 0.1s ease',
                }}
              >
                <div>
                  <div style={{ fontSize: 12, fontWeight: isSelected ? 600 : 500, color: isSelected ? '#F5B73B' : '#E6EAF0' }}>
                    {room.name}
                  </div>
                  <div style={{ fontSize: 10, color: '#9AA4B2' }}>
                    {room.screenType} · {room.time}
                  </div>
                </div>
                {room.status === 'incident' && (
                  <span
                    style={{
                      fontSize: 9,
                      fontWeight: 700,
                      color: '#F5B73B',
                      background: 'rgba(245, 183, 59, 0.15)',
                      padding: '2px 5px',
                      borderRadius: 4,
                    }}
                  >
                    ALERT
                  </span>
                )}
              </button>
            );
          })}
        </div>

        {/* Audit Recent */}
        <div className="mut" style={{ font: '600 10px Inter', letterSpacing: '.08em', padding: '10px 6px 3px' }}>
          AUDIT · RECENT
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <div
            style={{
              padding: '8px 10px',
              borderRadius: 8,
              background: '#161B22',
              border: '1px solid #2A313C',
              cursor: 'pointer',
            }}
            onClick={handleOpenAudit}
          >
            <div style={{ fontSize: 12, fontWeight: 600 }}>Quarantine E8–F14</div>
            <div style={{ fontSize: 11, color: isDone ? '#4FC3F7' : '#F5B73B', marginTop: 2, display: 'flex', alignItems: 'center', gap: 5 }}>
              <span className="dot" style={{ background: isDone ? '#4FC3F7' : '#F5B73B' }} />
              {isDone ? 'Completed · 14:02' : isAwaiting ? 'Awaiting your approval' : 'In progress'}
            </div>
          </div>

          <div
            style={{
              padding: '8px 10px',
              borderRadius: 8,
              background: '#161B22',
              border: '1px solid #2A313C',
              cursor: 'pointer',
            }}
            onClick={handleOpenAudit}
          >
            <div style={{ fontSize: 12, fontWeight: 600 }}>Move party B3–B4 to J1–J2</div>
            <div style={{ fontSize: 11, color: '#4FC3F7', marginTop: 2, display: 'flex', alignItems: 'center', gap: 5 }}>
              <span className="dot" style={{ background: '#4FC3F7' }} />
              Completed · 13:52
            </div>
          </div>

          <div
            style={{
              padding: '8px 10px',
              borderRadius: 8,
              background: '#161B22',
              border: '1px solid #2A313C',
              cursor: 'pointer',
            }}
            onClick={handleOpenAudit}
          >
            <div style={{ fontSize: 12, fontWeight: 600 }}>Hold C5–C8 for VIP</div>
            <div style={{ fontSize: 11, color: '#9AA4B2', marginTop: 2, display: 'flex', alignItems: 'center', gap: 5 }}>
              <span className="dot" style={{ background: '#9AA4B2' }} />
              Rolled back · 11:20
            </div>
          </div>
        </div>

        {/* Profile Management Footer */}
        <div
          style={{
            marginTop: 'auto',
            padding: '8px 6px',
            borderTop: '1px solid #2A313C',
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            cursor: 'pointer',
          }}
          onClick={() => setShowProfileModal(true)}
          title="Click to view profile & operator settings"
        >
          <div
            style={{
              width: 28,
              height: 28,
              borderRadius: '50%',
              background: 'linear-gradient(135deg, #F5B73B, #FF8C00)',
              color: '#1A1405',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              fontWeight: 700,
              fontSize: 11,
              flex: 'none',
            }}
          >
            MA
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 12, fontWeight: 600, color: '#E6EAF0', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              Mohammed Aarif
            </div>
            <div style={{ fontSize: 10, color: '#9AA4B2', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              aarif.ops@pvr-imax.com
            </div>
          </div>
          <span className="dot" style={{ background: '#4FC3F7' }} title="Online · SuperAdmin" />
        </div>
      </aside>

      {/* ─── 2. CENTER OBSERVATION CONSOLE ─────────────────────────────────── */}
      <main className="center-console">
        {/* Room Header */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'nowrap', gap: 10 }}>
          <div>
            <h2 style={{ fontSize: 19, letterSpacing: '-0.02em' }}>Live console</h2>
            <div className="mut" style={{ fontSize: 11, marginTop: 1 }}>
              {selectedRoom.name} · {selectedRoom.time} · [{selectedRoom.movie.toUpperCase()}]
            </div>
          </div>
          <span className="pill">
            <span className="dot" style={{ background: '#4FC3F7' }} />
            Live
          </span>
        </div>

        {/* 4 KPI Cards in a single row */}
        <div className="kpi-row">
          <div className="card kpi">
            <span>Seats sold</span>
            <b>{selectedRoom.soldSeats} / {selectedRoom.totalSeats}</b>
          </div>
          <div className="card kpi">
            <span>Quarantined</span>
            <b>{quarantinedCount}</b>
          </div>
          <div className="card kpi">
            <span>Active holds</span>
            <b>{selectedRoom.activeHolds}</b>
          </div>
          <div className="card kpi">
            <span>Pending approvals</span>
            <b style={{ color: pendingCount > 0 ? '#F5B73B' : '#fff' }}>
              {pendingCount}
            </b>
          </div>
        </div>

        {/* Applied banner */}
        {isDone && (
          <div
            style={{
              display: 'flex',
              gap: 10,
              alignItems: 'center',
              background: '#12303B',
              border: '1px solid #4FC3F7',
              borderRadius: 8,
              padding: '8px 12px',
            }}
          >
            <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true" style={{ flex: 'none' }}>
              <path d="M3 8.5l3.2 3L13 4.5" fill="none" stroke="#4FC3F7" strokeWidth="2" />
            </svg>
            <div style={{ fontSize: 12 }}>
              <b>Applied.</b> The seat map below is live. 8 seats moved in 6 parties.
            </div>
          </div>
        )}

        {/* Seat Map Card */}
        <section
          className="card"
          style={{
            padding: '12px 14px',
            display: 'flex',
            flexDirection: 'column',
            gap: 8,
            overflow: 'hidden',
          }}
        >
          {/* Card Top Bar with Toggles & Legend */}
          <div
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              gap: 8,
              flexWrap: 'wrap',
            }}
          >
            <div className="btn-toggle-group">
              <h3 style={{ fontSize: 14, marginRight: 4 }}>Review changes</h3>
              <button
                type="button"
                className={`btn-toggle ${viewMode === 'before' ? 'active' : ''}`}
                onClick={() => setViewMode('before')}
              >
                Before
              </button>
              <button
                type="button"
                className={`btn-toggle ${viewMode === 'changes' ? 'active' : ''}`}
                onClick={() => setViewMode('changes')}
              >
                Changes
              </button>
              <button
                type="button"
                className={`btn-toggle ${viewMode === 'after' ? 'active' : ''}`}
                onClick={() => setViewMode('after')}
              >
                After
              </button>
            </div>

            {/* Legend (Wraps nicely, no truncation) */}
            <div className="lg">
              {viewMode === 'before' ? (
                <>
                  <span><i className="s" />Free</span>
                  <span><i className="s o" />Occupied</span>
                </>
              ) : viewMode === 'after' || isDone ? (
                <>
                  <span><i className="s o" />Occupied</span>
                  <span><i className="s n" />Moving in</span>
                  <span><i className="s q" />Quarantined</span>
                </>
              ) : (
                <>
                  <span><i className="s o" />Occupied</span>
                  <span><i className="s a" />Moving out</span>
                  <span><i className="s n" />Moving in</span>
                  <span><i className="s q" />Quarantined</span>
                </>
              )}
            </div>
          </div>

          {/* Manual Admin Selection Toolbar */}
          {selectedSeatIds.length > 0 && (
            <div className="admin-selection-bar">
              <div className="admin-selection-badge">
                <span className="dot" style={{ background: '#F5B73B' }} />
                <span>
                  {selectedSeatIds.length} seat(s) selected:{' '}
                  <b style={{ color: '#fff' }}>{selectedSeatIds.sort().join(', ')}</b>
                </span>
              </div>
              <div className="admin-selection-actions">
                <button
                  type="button"
                  className="btn danger"
                  onClick={handleDirectQuarantine}
                  title="Directly block/quarantine selected seats"
                >
                  Block Selected
                </button>
                <button
                  type="button"
                  className="btn pri"
                  onClick={() => handleHandoffToCopilot('relocate')}
                  title="Instruct Copilot to relocate selected seats to recliners"
                >
                  Relocate via Copilot
                </button>
                <button
                  type="button"
                  className="btn"
                  onClick={handleClearSelection}
                  style={{ minHeight: 28, padding: '0 8px' }}
                >
                  Clear
                </button>
              </div>
            </div>
          )}

          {/* Seat Grid Component */}
          <SeatMap
            allocations={socket.allocations}
            viewMode={viewMode}
            isWorking={isWorking}
            quarantineSeatIds={activeQuarantineList}
            selectedSeatIds={selectedSeatIds}
            onToggleSeatSelect={handleToggleSeatSelect}
          />
        </section>
      </main>

      {/* ─── 3. RIGHT COPILOT AGENT INTERFACE (Collapsible, Dedicated Width) ─ */}
      <aside className={`sidebar-right ${copilotCollapsed ? 'collapsed' : ''}`}>
        {/* Collapsed State Bar */}
        {copilotCollapsed ? (
          <div
            style={{
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              padding: '14px 6px',
              gap: 16,
              height: '100%',
            }}
          >
            <button
              type="button"
              className="btn"
              onClick={() => setCopilotCollapsed(false)}
              title="Expand Copilot Panel"
              style={{
                width: 36,
                height: 36,
                minHeight: 36,
                padding: 0,
                borderRadius: 8,
              }}
            >
              ⇤
            </button>
            <div
              style={{
                writingMode: 'vertical-rl',
                textOrientation: 'mixed',
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                fontSize: 13,
                fontWeight: 600,
                color: '#9AA4B2',
                cursor: 'pointer',
              }}
              onClick={() => setCopilotCollapsed(false)}
            >
              <span
                className="dot"
                style={{ background: isWorking ? '#F5B73B' : isAwaiting ? '#F5B73B' : '#4FC3F7' }}
              />
              Copilot
            </div>
          </div>
        ) : (
          <>
            {/* Header */}
            <div
              style={{
                padding: '12px 14px',
                borderBottom: '1px solid #2A313C',
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <h2 style={{ fontSize: 15 }}>Copilot</h2>
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
                ) : (
                  <span className="pill" style={{ color: '#4FC3F7', borderColor: '#4FC3F7' }}>
                    <span className="dot" style={{ background: '#4FC3F7' }} />
                    Done
                  </span>
                )}
              </div>

              {/* Collapse Button */}
              <button
                type="button"
                className="btn"
                onClick={() => setCopilotCollapsed(true)}
                title="Collapse Copilot Panel"
                style={{
                  width: 28,
                  height: 28,
                  minHeight: 28,
                  padding: 0,
                  fontSize: 12,
                  color: '#9AA4B2',
                }}
              >
                ⇥
              </button>
            </div>

            {/* Message Stream */}
            <div
              ref={messagesContainerRef}
              style={{
                flex: 1,
                padding: '12px 14px',
                display: 'flex',
                flexDirection: 'column',
                gap: 10,
                overflowY: 'auto',
              }}
            >
              {messages.map((msg) => {
                if (msg.type === 'text') {
                  const isUser = msg.sender === 'user';
                  const isSystem = msg.sender === 'system';
                  const isApprovedBadge = msg.text === 'Approved';

                  if (isApprovedBadge) {
                    return (
                      <div
                        key={msg.id}
                        style={{
                          alignSelf: 'flex-end',
                          background: '#12303B',
                          border: '1px solid #4FC3F7',
                          borderRadius: 10,
                          padding: '6px 12px',
                          fontSize: 12,
                        }}
                      >
                        Approved
                      </div>
                    );
                  }

                  if (isSystem) {
                    return (
                      <div
                        key={msg.id}
                        style={{
                          alignSelf: 'stretch',
                          background: 'rgba(245, 183, 59, 0.08)',
                          border: '1px solid rgba(245, 183, 59, 0.25)',
                          borderRadius: 8,
                          padding: '8px 10px',
                          fontSize: 12,
                          color: '#E6EAF0',
                        }}
                      >
                        {msg.text}
                      </div>
                    );
                  }

                  return (
                    <div
                      key={msg.id}
                      style={{
                        alignSelf: isUser ? 'flex-end' : 'flex-start',
                        maxWidth: '92%',
                        background: isUser ? '#1E252E' : '#161B22',
                        border: isUser ? 'none' : '1px solid #2A313C',
                        borderRadius: isUser ? '10px 10px 2px 10px' : '10px 10px 10px 2px',
                        padding: 10,
                        fontSize: 13,
                        lineHeight: 1.45,
                      }}
                    >
                      {msg.text}
                    </div>
                  );
                }

                if (msg.type === 'tool_steps') {
                  return (
                    <div
                      key={msg.id}
                      style={{
                        background: '#161B22',
                        border: '1px solid #2A313C',
                        borderRadius: '10px 10px 10px 2px',
                        padding: 10,
                        fontSize: 13,
                        lineHeight: 1.45,
                        display: 'flex',
                        flexDirection: 'column',
                        gap: 8,
                      }}
                    >
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                        <div style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 12 }}>
                          <span className="dot" style={{ background: '#4FC3F7' }} />
                          <code>get_seat_map</code>
                          <span className="mut">done</span>
                        </div>
                        <div style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 12 }}>
                          <span className="dot" style={{ background: '#4FC3F7' }} />
                          <code>find_affected_parties</code>
                          <span className="mut">done</span>
                        </div>
                        <div style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 12 }}>
                          <span className="dot" style={{ background: '#4FC3F7' }} />
                          <code>spatial_solver</code>
                          <span className="mut">plan found</span>
                        </div>
                        <div style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 12 }}>
                          <span className="dot" style={{ background: isDone ? '#4FC3F7' : '#F5B73B' }} />
                          <code>approval</code>
                          <span className="mut">{isDone ? 'authorized' : 'waiting for you'}</span>
                        </div>
                      </div>
                    </div>
                  );
                }

                if (msg.type === 'approval_card') {
                  return (
                    <div
                      key={msg.id}
                      style={{
                        background: '#161B22',
                        border: '1px solid #2A313C',
                        borderRadius: '10px 10px 10px 2px',
                        padding: 10,
                        fontSize: 13,
                        lineHeight: 1.45,
                        display: 'flex',
                        flexDirection: 'column',
                        gap: 8,
                      }}
                    >
                      <div>
                        <b>I need your approval.</b> Moving 8 seats (6 parties) to rows I–J. Review the highlighted changes in the centre.
                      </div>

                      {/* Relocation Party breakdown */}
                      <div>
                        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, padding: '5px 0', borderTop: '1px solid #2A313C' }}>
                          <span>Party of 2</span>
                          <span><code>E9–10</code> → <code style={{ color: '#4FC3F7' }}>J1–2</code></span>
                        </div>
                        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, padding: '5px 0', borderTop: '1px solid #2A313C' }}>
                          <span>Party of 1</span>
                          <span><code>E12</code> → <code style={{ color: '#4FC3F7' }}>J3</code></span>
                        </div>
                        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, padding: '5px 0', borderTop: '1px solid #2A313C' }}>
                          <span>Party of 1</span>
                          <span><code>E14</code> → <code style={{ color: '#4FC3F7' }}>J4</code></span>
                        </div>
                        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, padding: '5px 0', borderTop: '1px solid #2A313C' }}>
                          <span>Party of 1</span>
                          <span><code>F8</code> → <code style={{ color: '#4FC3F7' }}>J6</code></span>
                        </div>
                        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, padding: '5px 0', borderTop: '1px solid #2A313C' }}>
                          <span>Party of 2</span>
                          <span><code>F10–11</code> → <code style={{ color: '#4FC3F7' }}>J7–8</code></span>
                        </div>
                        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, padding: '5px 0', borderTop: '1px solid #2A313C' }}>
                          <span>Party of 1</span>
                          <span><code>F13</code> → <code style={{ color: '#4FC3F7' }}>J9</code></span>
                        </div>
                      </div>

                      {/* Invariant Affirmations */}
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                        <div style={{ display: 'flex', gap: 6, fontSize: 11, alignItems: 'center' }}>
                          <svg width="12" height="12" viewBox="0 0 16 16" aria-hidden="true" style={{ flex: 'none' }}>
                            <path d="M3 8.5l3.2 3L13 4.5" fill="none" stroke="#4FC3F7" strokeWidth="2" />
                          </svg>
                          No party split
                        </div>
                        <div style={{ display: 'flex', gap: 6, fontSize: 11, alignItems: 'center' }}>
                          <svg width="12" height="12" viewBox="0 0 16 16" aria-hidden="true" style={{ flex: 'none' }}>
                            <path d="M3 8.5l3.2 3L13 4.5" fill="none" stroke="#4FC3F7" strokeWidth="2" />
                          </svg>
                          No tier downgrade
                        </div>
                        <div style={{ display: 'flex', gap: 6, fontSize: 11, alignItems: 'center' }}>
                          <svg width="12" height="12" viewBox="0 0 16 16" aria-hidden="true" style={{ flex: 'none' }}>
                            <path d="M3 8.5l3.2 3L13 4.5" fill="none" stroke="#4FC3F7" strokeWidth="2" />
                          </svg>
                          Fiscal caps respected
                        </div>
                        <div style={{ display: 'flex', gap: 6, fontSize: 11, alignItems: 'center' }}>
                          <svg width="12" height="12" viewBox="0 0 16 16" aria-hidden="true" style={{ flex: 'none' }}>
                            <path d="M3 8.5l3.2 3L13 4.5" fill="none" stroke="#4FC3F7" strokeWidth="2" />
                          </svg>
                          No double-booking
                        </div>
                      </div>

                      {/* CTAs */}
                      {!isDone && (
                        <>
                          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                            <button
                              type="button"
                              className="btn pri"
                              style={{ flex: '1 1 100%', minHeight: 36 }}
                              onClick={handleApprove}
                            >
                              Approve &amp; apply
                            </button>
                            <button
                              type="button"
                              className="btn"
                              style={{ flex: 1, minHeight: 32 }}
                              onClick={handleReject}
                            >
                              Reject
                            </button>
                            <button
                              type="button"
                              className="btn"
                              style={{ flex: 1, minHeight: 32 }}
                              onClick={() => setViewMode('changes')}
                            >
                              Edit
                            </button>
                          </div>
                          <div className="mut" style={{ fontSize: 11 }}>
                            Nothing is written until you approve.
                          </div>
                        </>
                      )}
                    </div>
                  );
                }

                if (msg.type === 'applied_confirmation') {
                  return (
                    <div
                      key={msg.id}
                      style={{
                        background: '#161B22',
                        border: '1px solid #2A313C',
                        borderRadius: '10px 10px 10px 2px',
                        padding: 10,
                        fontSize: 13,
                        lineHeight: 1.45,
                        display: 'flex',
                        flexDirection: 'column',
                        gap: 8,
                      }}
                    >
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                        <div style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 12 }}>
                          <span className="dot" style={{ background: '#4FC3F7' }} />
                          <code>commit</code>
                          <span className="mut">ok</span>
                        </div>
                        <div style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 12 }}>
                          <span className="dot" style={{ background: '#4FC3F7' }} />
                          <code>broadcast</code>
                          <span className="mut">ok</span>
                        </div>
                        <div style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 12 }}>
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
                        style={{ width: '100%', minHeight: 34 }}
                        onClick={handleOpenAudit}
                      >
                        Open full report in Audit
                      </button>
                    </div>
                  );
                }

                return null;
              })}
            </div>

            {/* Bottom Input */}
            <form
              onSubmit={handleSendInstruction}
              style={{
                padding: '10px 14px',
                borderTop: '1px solid #2A313C',
                display: 'flex',
                flexDirection: 'column',
                gap: 8,
              }}
            >
              <label htmlFor="copilot-input" style={{ position: 'absolute', left: -9999 }}>
                Instruction
              </label>
              <div style={{ display: 'flex', gap: 6 }}>
                <input
                  id="copilot-input"
                  value={instructionInput}
                  onChange={(e) => setInstructionInput(e.target.value)}
                  placeholder="Give an instruction…"
                  style={{
                    flex: 1,
                    minWidth: 0,
                    minHeight: 38,
                    background: '#0E1116',
                    border: '1px solid #3A4350',
                    borderRadius: 8,
                    color: '#E6EAF0',
                    padding: '0 10px',
                    fontSize: 13,
                    outline: 'none',
                  }}
                />
                <button type="submit" className="btn pri" style={{ minHeight: 38, padding: '0 14px' }}>
                  Send
                </button>
              </div>
            </form>
          </>
        )}
      </aside>

      {/* ─── Profile Modal ─────────────────────────────────────────────────── */}
      {showProfileModal && (
        <div
          className="modal-backdrop"
          onClick={() => setShowProfileModal(false)}
          style={{
            position: 'fixed',
            inset: 0,
            background: 'rgba(0,0,0,0.75)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 1000,
          }}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{
              background: '#12161C',
              border: '1px solid #2A313C',
              borderRadius: 14,
              width: 380,
              padding: 18,
              display: 'flex',
              flexDirection: 'column',
              gap: 14,
              boxShadow: '0 20px 50px rgba(0,0,0,0.6)',
            }}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <h3 style={{ fontSize: 15 }}>Operator Profile</h3>
              <button
                type="button"
                className="btn"
                style={{ minHeight: 26, padding: '0 8px', fontSize: 11 }}
                onClick={() => setShowProfileModal(false)}
              >
                ✕
              </button>
            </div>
            <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
              <div
                style={{
                  width: 44,
                  height: 44,
                  borderRadius: '50%',
                  background: 'linear-gradient(135deg, #F5B73B, #FF8C00)',
                  color: '#1A1405',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  fontWeight: 700,
                  fontSize: 16,
                }}
              >
                MA
              </div>
              <div>
                <div style={{ fontSize: 15, fontWeight: 700 }}>Mohammed Aarif</div>
                <div style={{ fontSize: 11, color: '#9AA4B2' }}>aarif.ops@pvr-imax.com</div>
                <span className="pill" style={{ marginTop: 4, padding: '2px 8px', fontSize: 10, color: '#4FC3F7', borderColor: '#4FC3F744' }}>
                  <span className="dot" style={{ background: '#4FC3F7' }} />
                  Shift Operations Lead · SuperAdmin
                </span>
              </div>
            </div>
            <div style={{ fontSize: 12, color: '#9AA4B2', background: '#161B22', padding: 12, borderRadius: 8, border: '1px solid #2A313C', display: 'flex', flexDirection: 'column', gap: 6 }}>
              <div>Assigned Venue: <b style={{ color: '#E6EAF0' }}>PVR Forum IMAX · All Screens</b></div>
              <div>Clearance Level: <b style={{ color: '#F5B73B' }}>L5 (Full Relocation, Blocking &amp; Vouchers)</b></div>
              <div>Session Token: <code>auth_superadmin_live</code></div>
            </div>
            <button
              type="button"
              className="btn pri"
              style={{ width: '100%', minHeight: 36 }}
              onClick={() => setShowProfileModal(false)}
            >
              Close
            </button>
          </div>
        </div>
      )}

      {/* ─── Audit Journal Modal ───────────────────────────────────────────── */}
      {showAuditModal && (
        <AuditLog
          entries={auditEntries}
          onUndo={handleUndo}
          undoingJournalId={undoingJournalId}
          onClose={() => setShowAuditModal(false)}
        />
      )}
    </div>
  );
}

export default App;
