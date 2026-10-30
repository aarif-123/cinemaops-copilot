/**
 * HitlModal — Human-in-the-Loop visual diff approval gate.
 *
 * Shows a side-by-side old/new state comparison of the proposed relocation:
 *   - LEFT: Current seat state (hazard stripes on quarantined seats)
 *   - RIGHT: Proposed new state (upgraded seats highlighted with glow)
 *
 * Financial exposure summary and invariant affirmation checklist are shown
 * below the diff before the admin's APPROVE / MODIFY / ABORT CTAs.
 *
 * The modal intentionally blocks all background interaction — this is a
 * high-stakes, focused decision. The backdrop blur reinforces this.
 */

import React, { useState } from 'react';
import SeatMap from '../SeatMap/SeatMap';
import type { HitlPayload, SeatAllocation } from '../../types/sdui';
import type { UseAgentSessionResult } from '../../hooks/useAgentSession';

interface HitlModalProps {
  payload: HitlPayload;
  allocations: SeatAllocation[];
  session: UseAgentSessionResult;
  adminToken: string;
}

const HitlModal: React.FC<HitlModalProps> = ({ payload, allocations, session, adminToken }) => {
  const [confirming, setConfirming] = useState(false);
  const impact = payload.impact_assessment;
  const diff = payload.proposed_diff;

  const allQuarantineIds = diff?.quarantine?.seat_ids ?? [];
  const allUpgradedIds = diff?.relocations?.flatMap((r) => r.to_seats) ?? [];

  const handleApprove = async () => {
    setConfirming(true);
    await session.approve(adminToken);
  };

  const handleAbort = () => {
    session.reject();
  };

  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true" aria-labelledby="hitl-title">
      <div className="modal">
        {/* Header */}
        <div className="modal__header">
          <div className="modal__title" id="hitl-title">
            <span style={{
              background: 'linear-gradient(135deg, #f59e0b, #dc2626)',
              borderRadius: '6px',
              padding: '4px 8px',
              fontSize: '1rem',
            }}>⚠️</span>
            Operational Approval Required
          </div>
          <div className="modal__subtitle">
            Review the proposed seat relocation plan carefully before authorizing execution.
            This action will modify live customer allocations.
          </div>
        </div>

        <div className="modal__body">
          {/* Impact stats */}
          <div className="impact-grid">
            <div className="impact-stat">
              <div className="impact-stat__value" style={{ color: 'var(--color-danger)' }}>
                {impact.seats_quarantined}
              </div>
              <div className="impact-stat__label">Seats Blocked</div>
            </div>
            <div className="impact-stat">
              <div className="impact-stat__value" style={{ color: 'var(--color-accent)' }}>
                {impact.parties_relocated}
              </div>
              <div className="impact-stat__label">Parties Relocated</div>
            </div>
            <div className="impact-stat">
              <div className="impact-stat__value" style={{ color: 'var(--color-warning)' }}>
                ₹{impact.revenue_exposure_inr.toLocaleString('en-IN')}
              </div>
              <div className="impact-stat__label">Voucher Exposure</div>
            </div>
          </div>

          {/* Side-by-side diff */}
          <div className="diff-grid">
            <div className="diff-panel diff-panel--old">
              <div className="diff-panel__header">
                <span>🔴</span> Current State — Blocked Seats
              </div>
              <div className="diff-panel__body" style={{ maxHeight: 200, overflow: 'auto' }}>
                <SeatMap
                  allocations={allocations}
                  highlightQuarantine={allQuarantineIds}
                  compact
                />
              </div>
            </div>
            <div className="diff-panel diff-panel--new">
              <div className="diff-panel__header">
                <span>✨</span> Proposed State — After Relocation
              </div>
              <div className="diff-panel__body" style={{ maxHeight: 200, overflow: 'auto' }}>
                <SeatMap
                  allocations={allocations}
                  highlightUpgraded={allUpgradedIds}
                  compact
                />
              </div>
            </div>
          </div>

          {/* Relocation details */}
          {diff?.relocations?.length > 0 && (
            <div>
              <div style={{ fontSize: '0.78rem', fontWeight: 700, color: '#94a3b8',
                textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: '10px' }}>
                Party Assignments
              </div>
              {diff.relocations.map((r, i) => (
                <div key={r.booking_id} className="relocation-item">
                  <div>
                    <div className="relocation-item__party">
                      Party #{i + 1} · {r.party_size} guests · BK:{r.booking_id.slice(0, 8)}
                    </div>
                    <div className="relocation-item__detail">
                      {r.tier_change}
                    </div>
                  </div>
                  <div style={{ textAlign: 'right' }}>
                    <div style={{ fontSize: '0.75rem', color: 'var(--color-success)' }}>
                      ₹{r.compensation_inr.toLocaleString('en-IN')} voucher
                    </div>
                    <div className="relocation-item__detail">
                      → {r.to_seats.slice(0, 3).join(', ')}{r.to_seats.length > 3 ? '…' : ''}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}

          {/* Invariant affirmations */}
          <div>
            <div style={{ fontSize: '0.78rem', fontWeight: 700, color: '#94a3b8',
              textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: '10px' }}>
              Guardrail Verification
            </div>
            <ul className="invariant-list">
              {payload.invariant_affirmations.map((aff, i) => (
                <li key={i}>
                  <span style={{ fontSize: '1rem' }}>✓</span>
                  {aff}
                </li>
              ))}
            </ul>
          </div>
        </div>

        {/* Footer CTAs */}
        <div className="modal__footer">
          <button
            id="hitl-abort-btn"
            className="btn btn--danger"
            onClick={handleAbort}
            disabled={confirming}
          >
            ✕ Abort
          </button>
          <button
            id="hitl-approve-btn"
            className="btn btn--success"
            onClick={void handleApprove}
            disabled={confirming}
            style={{ minWidth: 200 }}
          >
            {confirming ? (
              <><div className="spinner" style={{ width: 14, height: 14, borderColor: 'rgba(0,0,0,0.3)', borderTopColor: '#052e16' }} /> Committing…</>
            ) : (
              '✓ Sign & Authorize Mutation'
            )}
          </button>
        </div>
      </div>
    </div>
  );
};

export default HitlModal;
