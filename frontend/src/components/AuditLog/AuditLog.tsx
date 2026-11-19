import React, { useCallback } from 'react';
import type { AuditEntry } from '../../types/sdui';

interface AuditLogProps {
  entries: AuditEntry[];
  onUndo: (journalId: string) => Promise<void>;
  undoingJournalId: string | null;
  onClose: () => void;
}

export const AuditLog: React.FC<AuditLogProps> = ({
  entries,
  onUndo,
  undoingJournalId,
  onClose,
}) => {
  const formatInr = useCallback((paisa: number) => {
    const inr = paisa / 100;
    return new Intl.NumberFormat('en-IN', {
      style: 'currency',
      currency: 'INR',
      minimumFractionDigits: 0,
    }).format(inr);
  }, []);

  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true" onClick={onClose}>
      <div
        className="modal-dialog"
        onClick={(e) => e.stopPropagation()}
        style={{
          background: '#12161C',
          border: '1px solid #2A313C',
          borderRadius: 16,
          width: 'min(720px, 94vw)',
          maxHeight: '85vh',
          display: 'flex',
          flexDirection: 'column',
          boxShadow: '0 24px 64px rgba(0,0,0,0.7)',
        }}
      >
        {/* Header */}
        <div
          style={{
            padding: '16px 20px',
            borderBottom: '1px solid #2A313C',
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ fontSize: 18 }}>📋</span>
            <h2 style={{ fontSize: 18 }}>Operational Audit Journal</h2>
          </div>
          <button
            type="button"
            className="btn"
            style={{ minHeight: 32, padding: '0 12px', fontSize: 13 }}
            onClick={onClose}
          >
            ✕ Close
          </button>
        </div>

        {/* Body */}
        <div style={{ flex: 1, overflowY: 'auto', padding: '16px 20px' }}>
          <div
            className="mut"
            style={{
              fontSize: 12,
              fontWeight: 600,
              letterSpacing: '.06em',
              marginBottom: 12,
              textTransform: 'uppercase',
            }}
          >
            {entries.length} record{entries.length === 1 ? '' : 's'} in ledger
          </div>

          {entries.length === 0 ? (
            <div
              style={{
                padding: '32px 16px',
                textAlign: 'center',
                color: '#9AA4B2',
                border: '1px dashed #2A313C',
                borderRadius: 12,
              }}
            >
              No audit entries found.
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {entries.map((entry) => (
                <div
                  key={entry.id}
                  style={{
                    background: '#161B22',
                    border: '1px solid #2A313C',
                    borderRadius: 12,
                    padding: 12,
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                    gap: 12,
                  }}
                >
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 4 }}>
                      <span style={{ fontWeight: 600, fontSize: 14 }}>{entry.action_type}</span>
                      <span className="mut" style={{ fontSize: 12 }}>
                        {new Date(entry.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                      </span>
                      {entry.is_rolled_back && (
                        <span
                          style={{
                            fontSize: 11,
                            background: 'rgba(255, 107, 107, 0.15)',
                            color: '#FF6B6B',
                            padding: '2px 6px',
                            borderRadius: 4,
                          }}
                        >
                          Rolled back
                        </span>
                      )}
                    </div>
                    <div className="mut" style={{ fontSize: 13 }}>
                      {entry.prompt_intent}
                    </div>
                    <div className="mut" style={{ fontSize: 11, marginTop: 4 }}>
                      Operator: <code>{entry.admin_id}</code>
                    </div>
                  </div>

                  <div style={{ textAlign: 'right', flex: 'none' }}>
                    <div style={{ fontSize: 13, color: '#F5B73B', fontWeight: 600 }}>
                      {formatInr(entry.financial_delta_paisa)}
                    </div>
                    {!entry.is_rolled_back && (
                      <button
                        type="button"
                        className="btn"
                        style={{
                          minHeight: 28,
                          padding: '0 10px',
                          fontSize: 12,
                          marginTop: 6,
                          borderColor: '#FF6B6B44',
                          color: '#FF6B6B',
                        }}
                        onClick={() => onUndo(entry.id)}
                        disabled={undoingJournalId === entry.id}
                      >
                        {undoingJournalId === entry.id ? 'Undoing…' : 'Undo'}
                      </button>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Footer */}
        <div
          style={{
            padding: '14px 20px',
            borderTop: '1px solid #2A313C',
            display: 'flex',
            justifyContent: 'flex-end',
          }}
        >
          <button type="button" className="btn pri" onClick={onClose}>
            Done
          </button>
        </div>
      </div>
    </div>
  );
};

export default AuditLog;
