/**
 * SeatMap — SVG-less 2D seat grid with real-time status rendering.
 *
 * Renders seats grouped by row. Status colors are driven by the SeatAllocation
 * status field. Real-time patches from the WebSocket hook flow directly into
 * the allocations prop, causing minimal targeted re-renders.
 *
 * highlight_* props support the HITL visual diff (old vs proposed state).
 */

import React, { useMemo } from 'react';
import type { SeatAllocation } from '../../types/sdui';

interface SeatMapProps {
  allocations: SeatAllocation[];
  highlightQuarantine?: string[];   // seat_ids to show as hazard
  highlightUpgraded?: string[];     // seat_ids to show as upgraded
  compact?: boolean;
}

function getSeatClass(
  alloc: SeatAllocation,
  quarantine: Set<string>,
  upgraded: Set<string>,
): string {
  const id = alloc.seat_id;
  if (quarantine.has(id)) return 'seat seat--hazard seat--highlighted-old';
  if (upgraded.has(id))  return 'seat seat--upgraded seat--highlighted-new';

  switch (alloc.status) {
    case 'AVAILABLE':            return 'seat seat--available';
    case 'BOOKED':               return 'seat seat--booked';
    case 'LOCKED_CART':          return 'seat seat--locked';
    case 'MAINTENANCE_BLOCKED':  return 'seat seat--blocked seat--hazard';
    case 'RELOCATION_HOLD':      return 'seat seat--hold';
    case 'BOOKED_UPGRADED':      return 'seat seat--upgraded';
    default:                     return 'seat seat--booked';
  }
}

function getTierLabel(tier: string): string {
  switch (tier) {
    case 'LUXURY_RECLINER': return '♦';
    case 'PRIME':           return '●';
    default:                return '·';
  }
}

const SeatMap: React.FC<SeatMapProps> = ({
  allocations,
  highlightQuarantine = [],
  highlightUpgraded = [],
  compact = false,
}) => {
  const quarantineSet = useMemo(() => new Set(highlightQuarantine), [highlightQuarantine]);
  const upgradedSet   = useMemo(() => new Set(highlightUpgraded),   [highlightUpgraded]);

  // Group allocations by row, sorted by col_index
  const rows = useMemo(() => {
    const map = new Map<string, SeatAllocation[]>();
    for (const alloc of allocations) {
      const row = alloc.seat.row_label.trim();
      if (!map.has(row)) map.set(row, []);
      map.get(row)!.push(alloc);
    }
    // Sort each row by column index
    for (const [, seats] of map) {
      seats.sort((a, b) => a.seat.col_index - b.seat.col_index);
    }
    // Sort rows alphabetically
    return Array.from(map.entries()).sort(([a], [b]) => a.localeCompare(b));
  }, [allocations]);

  const seatSize = compact ? 20 : 28;

  return (
    <div className="seat-grid" role="grid" aria-label="Seat Map">
      {/* Screen indicator */}
      <div style={{
        width: '60%',
        height: 6,
        background: 'linear-gradient(90deg, transparent, rgba(79,142,247,0.5), transparent)',
        borderRadius: 3,
        marginBottom: 12,
      }} />
      <div style={{ fontSize: '0.65rem', color: '#334155', marginBottom: 16, letterSpacing: '0.1em' }}>
        SCREEN
      </div>

      {rows.map(([rowLabel, seats]) => (
        <div key={rowLabel} className="seat-row" role="row">
          <span className="seat-row__label">{rowLabel}</span>
          {seats.map((alloc) => (
            <div
              key={alloc.id}
              className={getSeatClass(alloc, quarantineSet, upgradedSet)}
              style={{ width: seatSize, height: seatSize }}
              role="gridcell"
              aria-label={`Seat ${rowLabel}${alloc.seat.col_index} — ${alloc.status}`}
              title={`${rowLabel}${alloc.seat.col_index} | ${alloc.seat.tier} | ${alloc.status}${alloc.booking_id ? ` | BK:${alloc.booking_id.slice(0, 8)}` : ''}`}
            />
          ))}
          <span className="seat-row__label" style={{ color: '#1e293b', fontSize: '0.55rem' }}>
            {getTierLabel(seats[0]?.seat.tier ?? 'STANDARD')}
          </span>
        </div>
      ))}
    </div>
  );
};

export default SeatMap;
