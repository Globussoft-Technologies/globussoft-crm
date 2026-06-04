import {
  Banknote,
  CheckCircle2,
  XCircle,
  Unlock,
  Lock,
  ArrowDownToLine,
  ArrowUpFromLine,
} from 'lucide-react';
import { formatMoney } from '../../../utils/money';
import { formatDateTime } from '../../../utils/date';
import { inputStyle, primaryButtonStyle, secondaryButtonStyle } from './sharedStyles';

export default function ShiftPanel({
  selectedRegister,
  selectedShift,
  currentBalance,
  openingFloat,
  openingShift,
  closingTotal,
  closingNotes,
  closingShift,
  onOpeningFloatChange,
  onOpenShift,
  onClosingTotalChange,
  onClosingNotesChange,
  onCloseShift,
  onDeposit,
  onWithdrawal,
}) {
  return (
    <>
      {/* #780 — REGISTER OPEN / CLOSED status header with total balance */}
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          flexWrap: 'wrap',
          gap: '1rem',
          marginBottom: '1rem',
          paddingBottom: '0.75rem',
          borderBottom: '1px solid rgba(255,255,255,0.08)',
        }}
      >
        <div>
          <div
            style={{
              fontSize: '0.85rem',
              color: 'var(--text-secondary)',
            }}
          >
            Selected register
          </div>
          <h2
            style={{
              fontSize: '1.3rem',
              fontWeight: 600,
              display: 'flex',
              alignItems: 'center',
              gap: '0.5rem',
              marginTop: '0.2rem',
            }}
          >
            <Banknote size={18} /> {selectedRegister.name}
          </h2>
        </div>
        <div style={{ textAlign: 'right' }}>
          {selectedShift ? (
            <>
              <div
                style={{
                  fontSize: '0.95rem',
                  fontWeight: 700,
                  color: 'var(--success-color)',
                  display: 'flex',
                  alignItems: 'center',
                  gap: '0.4rem',
                  justifyContent: 'flex-end',
                }}
                data-testid="status-header"
              >
                <CheckCircle2 size={16} /> REGISTER OPEN
              </div>
              <div
                style={{
                  fontSize: '1.5rem',
                  fontWeight: 700,
                  marginTop: '0.25rem',
                }}
                data-testid="current-balance"
              >
                {formatMoney(currentBalance)}
              </div>
              <div
                style={{
                  fontSize: '0.75rem',
                  color: 'var(--text-secondary)',
                }}
              >
                drawer balance · opened{' '}
                {selectedShift.openedAt
                  ? formatDateTime(selectedShift.openedAt)
                  : '—'}
              </div>
            </>
          ) : (
            <div
              style={{
                fontSize: '0.95rem',
                fontWeight: 700,
                color: 'var(--text-secondary)',
                display: 'flex',
                alignItems: 'center',
                gap: '0.4rem',
              }}
              data-testid="status-header"
            >
              <XCircle size={16} /> REGISTER CLOSED
            </div>
          )}
        </div>
      </div>

      {/* #779 — Action bar: Open / Close / Deposit / Withdraw */}
      {!selectedShift ? (
        <form
          onSubmit={onOpenShift}
          style={{
            display: 'flex',
            gap: '0.5rem',
            flexWrap: 'wrap',
            alignItems: 'center',
            marginBottom: '1rem',
          }}
        >
          <input
            type="number"
            min="0"
            step="0.01"
            placeholder="Opening float — e.g. 500"
            value={openingFloat}
            onChange={(e) => onOpeningFloatChange(e.target.value)}
            style={{ ...inputStyle, flex: '1 1 220px' }}
            aria-label="Opening float for new shift"
          />
          <button
            type="submit"
            disabled={openingShift}
            style={{
              ...primaryButtonStyle,
              background: 'var(--success-color)',
            }}
          >
            <Unlock size={14} />
            {openingShift ? 'Opening…' : 'Open shift'}
          </button>
        </form>
      ) : (
        <div
          style={{
            display: 'flex',
            gap: '0.5rem',
            flexWrap: 'wrap',
            marginBottom: '1rem',
          }}
        >
          <button
            onClick={onDeposit}
            style={secondaryButtonStyle}
            aria-label="Deposit cash"
            title="Deposit cash into the drawer"
          >
            <ArrowDownToLine size={14} /> Deposit
          </button>
          <button
            onClick={onWithdrawal}
            style={secondaryButtonStyle}
            aria-label="Withdraw cash"
            title="Withdraw cash from the drawer"
          >
            <ArrowUpFromLine size={14} /> Withdrawal
          </button>
          <form
            onSubmit={onCloseShift}
            style={{
              display: 'flex',
              gap: '0.5rem',
              flexWrap: 'wrap',
              flex: '1 1 100%',
              marginTop: '0.5rem',
              padding: '0.75rem',
              background: 'rgba(255,255,255,0.03)',
              borderRadius: 8,
              alignItems: 'center',
            }}
          >
            <div style={{ flex: '1 1 100%', fontSize: '0.85rem', color: 'var(--text-secondary)' }}>
              Expected cash in drawer:{' '}
              <strong style={{ color: 'var(--text-primary)' }}>
                {formatMoney(currentBalance)}
              </strong>{' '}
              — leave the count blank to close at this amount.
            </div>
            <input
              type="number"
              min="0"
              step="0.01"
              placeholder="Counted cash (optional)"
              value={closingTotal}
              onChange={(e) => onClosingTotalChange(e.target.value)}
              style={{ ...inputStyle, flex: '1 1 180px' }}
              aria-label="Counted cash"
            />
            <input
              placeholder="Notes (optional)"
              value={closingNotes}
              onChange={(e) => onClosingNotesChange(e.target.value)}
              style={{ ...inputStyle, flex: '2 1 220px' }}
              aria-label="Closing notes"
            />
            <button
              type="submit"
              disabled={closingShift}
              style={primaryButtonStyle}
            >
              <Lock size={14} />
              {closingShift ? 'Closing…' : 'Close register'}
            </button>
          </form>
        </div>
      )}
    </>
  );
}
