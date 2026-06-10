import {
  Banknote,
  MapPin,
  Lock,
  Unlock,
  Pencil,
  Power,
  PowerOff,
} from 'lucide-react';
import { formatMoney } from '../../../utils/money';
import { iconButtonStyle } from './sharedStyles';

export default function RegisterCard({
  reg,
  openShift,
  isSelected,
  isAdminOrManager,
  onSelect,
  onEdit,
  onToggleActive,
}) {
  const isOpen = !!openShift;
  return (
    <div
      className="glass"
      onClick={onSelect}
      style={{
        padding: '1.25rem',
        cursor: 'pointer',
        opacity: reg.isActive ? 1 : 0.55,
        border: isSelected
          ? '2px solid var(--primary-color, var(--accent-color))'
          : '1px solid var(--border-color)',
      }}
      data-testid={`register-card-${reg.id}`}
    >
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'flex-start',
          marginBottom: '0.5rem',
        }}
      >
        <div>
          <h3
            style={{
              fontSize: '1.05rem',
              fontWeight: 600,
              display: 'flex',
              alignItems: 'center',
              gap: '0.4rem',
            }}
          >
            <Banknote
              size={16}
              color="var(--primary-color, var(--accent-color))"
            />
            {reg.name}
          </h3>
          {reg.location && (
            <div
              style={{
                fontSize: '0.75rem',
                color: 'var(--text-secondary)',
                marginTop: '0.15rem',
                display: 'flex',
                alignItems: 'center',
                gap: '0.25rem',
              }}
            >
              <MapPin size={11} />
              {reg.location.name}
              {reg.location.city ? `, ${reg.location.city}` : ''}
            </div>
          )}
        </div>
        {isAdminOrManager && (
          <div
            style={{ display: 'flex', gap: '0.3rem' }}
            onClick={(e) => e.stopPropagation()}
          >
            <button
              onClick={onEdit}
              title="Edit register"
              style={iconButtonStyle}
              aria-label={`Edit ${reg.name}`}
            >
              <Pencil size={12} />
            </button>
            <button
              onClick={onToggleActive}
              title={reg.isActive ? 'Deactivate' : 'Activate'}
              style={{
                ...iconButtonStyle,
                color: reg.isActive
                  ? 'var(--success-color)'
                  : 'var(--text-secondary)',
              }}
              aria-label={
                reg.isActive
                  ? `Deactivate ${reg.name}`
                  : `Activate ${reg.name}`
              }
            >
              {reg.isActive ? (
                <Power size={12} />
              ) : (
                <PowerOff size={12} />
              )}
            </button>
          </div>
        )}
      </div>

      <div
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: '0.35rem',
          padding: '0.25rem 0.6rem',
          borderRadius: 999,
          fontSize: '0.75rem',
          fontWeight: 600,
          background: isOpen
            ? 'rgba(16,185,129,0.12)'
            : 'rgba(100,100,100,0.12)',
          color: isOpen
            ? 'var(--success-color)'
            : 'var(--text-secondary)',
        }}
        data-testid={`register-status-${reg.id}`}
      >
        {isOpen ? <Unlock size={11} /> : <Lock size={11} />}
        {isOpen ? 'REGISTER OPEN' : 'REGISTER CLOSED'}
        {isOpen && (
          <span style={{ marginLeft: '0.35rem', opacity: 0.85 }}>
            · float {formatMoney(openShift.openingFloat)}
          </span>
        )}
      </div>
    </div>
  );
}
