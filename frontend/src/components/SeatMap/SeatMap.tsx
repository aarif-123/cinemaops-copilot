import React, { useMemo } from 'react';
import type { SeatAllocation } from '../../types/sdui';

export type SeatViewMode = 'before' | 'changes' | 'after';

export interface SeatMapProps {
  allocations?: SeatAllocation[];
  viewMode?: SeatViewMode;
  isWorking?: boolean;
  quarantineSeatIds?: string[];
  movingOutSeatIds?: string[];
  movingInSeatIds?: string[];
  selectedSeatId?: string | null;
  selectedSeatIds?: string[];
  onSelectSeat?: (seatId: string) => void;
  onToggleSeatSelect?: (seatId: string) => void;
  highlightQuarantine?: string[];
  highlightUpgraded?: string[];
  compact?: boolean;
}

// 10 Rows (A through J), 14 columns (7 left, aisle, 7 right)
const ROWS = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J'];
const LEFT_COLS = [1, 2, 3, 4, 5, 6, 7];
const RIGHT_COLS = [8, 9, 10, 11, 12, 13, 14];

// Baseline occupied seats
const DEFAULT_OCCUPIED = new Set([
  'A1', 'A3', 'A5', 'A6', 'A8', 'A10', 'A11', 'A13',
  'B1', 'B2', 'B4', 'B6', 'B7', 'B9', 'B11', 'B12', 'B14',
  'C2', 'C3', 'C5', 'C7', 'C8', 'C10', 'C12', 'C13',
  'D1', 'D3', 'D4', 'D6', 'D8', 'D9', 'D11', 'D13', 'D14',
  'E2', 'E4', 'E5', 'E7', 'E9', 'E10', 'E12', 'E14',
  'F1', 'F3', 'F5', 'F6', 'F8', 'F10', 'F11', 'F13',
  'G1', 'G2', 'G4', 'G6', 'G7', 'G9', 'G11', 'G12', 'G14',
  'H2', 'H3', 'H5', 'H7', 'H8', 'H10', 'H12', 'H13',
  'I4', 'I9', 'I14',
  'J5', 'J10',
]);

const DEMO_QUARANTINE = new Set(['E8', 'E11', 'E13', 'F9', 'F12', 'F14']);
const DEMO_MOVING_OUT = new Set(['E9', 'E10', 'E12', 'E14', 'F8', 'F10', 'F11', 'F13']);
const DEMO_MOVING_IN = new Set(['J1', 'J2', 'J3', 'J4', 'J6', 'J7', 'J8', 'J9']);
const DEMO_TARGETED = new Set([
  'E8', 'E9', 'E10', 'E11', 'E12', 'E13', 'E14',
  'F8', 'F9', 'F10', 'F11', 'F12', 'F13', 'F14',
]);

export const SeatMap: React.FC<SeatMapProps> = ({
  allocations,
  viewMode = 'changes',
  isWorking = false,
  quarantineSeatIds,
  movingOutSeatIds,
  movingInSeatIds,
  selectedSeatId,
  selectedSeatIds,
  onSelectSeat,
  onToggleSeatSelect,
  highlightQuarantine,
  highlightUpgraded,
}) => {
  const selectedSet = useMemo(() => {
    const set = new Set<string>();
    if (selectedSeatIds) {
      selectedSeatIds.forEach((id) => set.add(id));
    }
    if (selectedSeatId) {
      set.add(selectedSeatId);
    }
    return set;
  }, [selectedSeatIds, selectedSeatId]);

  const quarantineSet = useMemo(() => {
    if (quarantineSeatIds) return new Set(quarantineSeatIds);
    if (highlightQuarantine) return new Set(highlightQuarantine);
    return DEMO_QUARANTINE;
  }, [quarantineSeatIds, highlightQuarantine]);

  const movingOutSet = useMemo(() => {
    if (movingOutSeatIds) return new Set(movingOutSeatIds);
    return DEMO_MOVING_OUT;
  }, [movingOutSeatIds]);

  const movingInSet = useMemo(() => {
    if (movingInSeatIds) return new Set(movingInSeatIds);
    if (highlightUpgraded) return new Set(highlightUpgraded);
    return DEMO_MOVING_IN;
  }, [movingInSeatIds, highlightUpgraded]);

  const targetedSet = useMemo(() => {
    if (quarantineSeatIds || movingOutSeatIds) {
      return new Set([...(quarantineSeatIds || []), ...(movingOutSeatIds || [])]);
    }
    return DEMO_TARGETED;
  }, [quarantineSeatIds, movingOutSeatIds]);

  const allocationMap = useMemo(() => {
    if (!allocations || allocations.length === 0) return null;
    const map = new Map<string, SeatAllocation>();
    for (const alloc of allocations) {
      const key = `${alloc.seat.row_label.trim()}${alloc.seat.col_index}`;
      map.set(key, alloc);
    }
    return map;
  }, [allocations]);

  const getSeatState = (seatId: string): { classes: string; statusDesc: string } => {
    let classes = 's';
    let statusDesc = 'Free';

    const isBaselineOccupied = allocationMap
      ? Boolean(allocationMap.get(seatId) && ['BOOKED', 'BOOKED_UPGRADED', 'LOCKED_CART'].includes(allocationMap.get(seatId)!.status))
      : DEFAULT_OCCUPIED.has(seatId);

    if (isBaselineOccupied) {
      statusDesc = 'Occupied';
    }

    if (isWorking) {
      if (targetedSet.has(seatId)) {
        classes += ' p';
        statusDesc = 'Targeted for Relocation';
      }
      if (isBaselineOccupied) classes += ' o';
      return { classes, statusDesc };
    }

    if (viewMode === 'before') {
      if (isBaselineOccupied) {
        classes += ' o';
        statusDesc = 'Occupied';
      }
      return { classes, statusDesc };
    }

    if (viewMode === 'changes') {
      if (quarantineSet.has(seatId)) {
        return { classes: 's q', statusDesc: 'Quarantined (HVAC failure)' };
      }
      if (movingOutSet.has(seatId)) {
        return { classes: 's a', statusDesc: 'Moving out (Relocating)' };
      }
      if (movingInSet.has(seatId)) {
        return { classes: 's n', statusDesc: 'Moving in (Upgraded to Recliner)' };
      }
      if (isBaselineOccupied) classes += ' o';
      return { classes, statusDesc };
    }

    if (viewMode === 'after') {
      if (targetedSet.has(seatId) || quarantineSet.has(seatId)) {
        return { classes: 's q', statusDesc: 'Quarantined (Locked)' };
      }
      if (movingInSet.has(seatId)) {
        return { classes: 's n', statusDesc: 'Relocated Party' };
      }
      if (isBaselineOccupied) classes += ' o';
      return { classes, statusDesc };
    }

    return { classes, statusDesc };
  };

  const getTierInfo = (row: string): { label: string; price: string } => {
    if (row >= 'A' && row <= 'D') return { label: 'Standard', price: '₹250' };
    if (row >= 'E' && row <= 'H') return { label: 'Premium', price: '₹450' };
    return { label: 'Luxury recliner', price: '₹750' };
  };

  const handleSeatClick = (seatId: string) => {
    if (onToggleSeatSelect) {
      onToggleSeatSelect(seatId);
    } else if (onSelectSeat) {
      onSelectSeat(seatId);
    }
  };

  return (
    <div className="seat-map-wrapper">
      {/* Screen Indicator */}
      <div className="seat-screen-indicator">
        SCREEN
      </div>

      {/* Grid Container */}
      <div className="seat-grid-container">
        {/* Column Numbers Header (1–14 with aisle) */}
        <div className="row col-header-row">
          <b className="col-header-spacer"></b>
          {LEFT_COLS.map((col) => (
            <span key={`col-h-${col}`} className="col-num">
              {col}
            </span>
          ))}
          <u className="aisle-spacer" />
          {RIGHT_COLS.map((col) => (
            <span key={`col-h-${col}`} className="col-num">
              {col}
            </span>
          ))}
          <em className="tier-header-spacer"></em>
        </div>

        {/* Rows with Tier Dividers */}
        {ROWS.map((row) => {
          const tierInfo = getTierInfo(row);
          const isStandardHeader = row === 'A';
          const isPremiumHeader = row === 'E';
          const isReclinerHeader = row === 'I';
          const showTierDivider = row === 'E' || row === 'I';

          return (
            <React.Fragment key={row}>
              {showTierDivider && <div className="tier-divider" />}
              <div className="row">
                <b>{row}</b>

                {/* Left 7 seats */}
                {LEFT_COLS.map((col) => {
                  const seatId = `${row}${col}`;
                  const isSelected = selectedSet.has(seatId);
                  const { classes, statusDesc } = getSeatState(seatId);
                  const tooltip = `Seat ${seatId} · ${tierInfo.label} (${tierInfo.price}) · ${statusDesc}${isSelected ? ' · [Selected]' : ''}`;

                  return (
                    <button
                      key={seatId}
                      type="button"
                      className={`${classes}${isSelected ? ' selected-seat' : ''}`}
                      onClick={() => handleSeatClick(seatId)}
                      title={tooltip}
                      aria-label={tooltip}
                    />
                  );
                })}

                {/* Aisle spacer */}
                <u className="aisle-spacer" />

                {/* Right 7 seats */}
                {RIGHT_COLS.map((col) => {
                  const seatId = `${row}${col}`;
                  const isSelected = selectedSet.has(seatId);
                  const { classes, statusDesc } = getSeatState(seatId);
                  const tooltip = `Seat ${seatId} · ${tierInfo.label} (${tierInfo.price}) · ${statusDesc}${isSelected ? ' · [Selected]' : ''}`;

                  return (
                    <button
                      key={seatId}
                      type="button"
                      className={`${classes}${isSelected ? ' selected-seat' : ''}`}
                      onClick={() => handleSeatClick(seatId)}
                      title={tooltip}
                      aria-label={tooltip}
                    />
                  );
                })}

                {/* Tier label on right */}
                <em>
                  {isStandardHeader && 'Standard'}
                  {isPremiumHeader && 'Premium'}
                  {isReclinerHeader && 'Luxury recliner'}
                </em>
              </div>
            </React.Fragment>
          );
        })}
      </div>
    </div>
  );
};

export default SeatMap;
