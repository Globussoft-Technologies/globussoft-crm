import React from 'react';
import { Link } from 'react-router-dom';
import { UserIcon, Stethoscope, Plus, Car } from 'lucide-react';
import TopScrollSync from '../../../components/TopScrollSync';
import {
  STATUS_COLOR,
  STATUS_BORDER,
  displayStatus,
  BOOKING_TYPE_META,
  fmtHour,
  colHead,
  hourLabel,
  hourCell,
} from './constants';

const COLUMN_MIN_WIDTH = 160;

export default function CalendarDayGrid({
  columns,
  HOURS,
  grid,
  focusId,
  focusedRef,
  canAssignDoctor,
  onEmptyCellClick,
  onAssignClick,
}) {
  const gridMinWidth = 80 + columns.length * COLUMN_MIN_WIDTH;

  return (
    <div
      className="glass"
      style={{
        padding: '1rem',
        width: '100%',
        minWidth: 0,
        maxWidth: '100%',
        boxSizing: 'border-box',
      }}
    >
      <TopScrollSync forceScrollbar scrollWidth={gridMinWidth}>
        <div
          className="calendar-scroll"
          style={{
            width: `${gridMinWidth}px`,
            minWidth: '100%',
            boxSizing: 'border-box',
            overflowY: 'auto',
            scrollbarWidth: 'thin',
            scrollbarColor: 'rgba(255,255,255,0.3) transparent',
          }}
        >
          <div
            className="calendar-grid"
            style={{
              display: 'grid',
              gridTemplateColumns: `80px repeat(${columns.length}, minmax(${COLUMN_MIN_WIDTH}px, 1fr))`,
              gap: '4px',
              minWidth: `${gridMinWidth}px`,
            }}
          >
            <div style={{ ...colHead, background: 'transparent' }}></div>
            {columns.map((c) => (
              <div
                key={c.id}
                style={{ ...colHead, opacity: c.isUnassigned ? 0.7 : 1, minWidth: 0, overflow: 'hidden' }}
                title={c.role ? `${c.name} · ${c.role}` : c.name}
              >
                {c.isUnassigned ? (
                  <UserIcon size={14} style={{ verticalAlign: 'middle', marginRight: '0.4rem', opacity: 0.7, flexShrink: 0 }} />
                ) : (
                  <Stethoscope size={14} style={{ verticalAlign: 'middle', marginRight: '0.4rem', opacity: 0.7, flexShrink: 0 }} />
                )}
                <span
                  style={{
                    display: 'inline-block',
                    verticalAlign: 'middle',
                    maxWidth: 'calc(100% - 22px)',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  }}
                >
                  {c.name}
                  {c.role && (
                    <span
                      style={{
                        fontSize: '0.65rem',
                        color: 'var(--text-secondary)',
                        marginLeft: '0.4rem',
                        textTransform: 'uppercase',
                        letterSpacing: '0.05em',
                      }}
                    >
                      {c.role}
                    </span>
                  )}
                </span>
              </div>
            ))}

            {HOURS.map((h) => (
              <React.Fragment key={h}>
                <div style={hourLabel}>{fmtHour(h)}</div>
                {columns.map((c) => {
                  const cell = grid[c.id]?.[h] || [];
                  const isCreatable = !c.isUnassigned && cell.length === 0;
                  return (
                    <div
                      key={`${c.id}-${h}`}
                      style={{
                        ...hourCell,
                        cursor: isCreatable ? 'pointer' : 'default',
                        position: 'relative',
                        minWidth: 0,
                        overflow: 'hidden',
                      }}
                      onClick={isCreatable ? () => onEmptyCellClick(c.id, h) : undefined}
                      title={isCreatable ? `Book ${fmtHour(h)} with ${c.name}` : undefined}
                      onMouseEnter={isCreatable ? (e) => { e.currentTarget.querySelector('[data-empty-affordance]')?.style.setProperty('opacity', '0.8'); } : undefined}
                      onMouseLeave={isCreatable ? (e) => { e.currentTarget.querySelector('[data-empty-affordance]')?.style.setProperty('opacity', '0'); } : undefined}
                    >
                      {cell.map((v) => {
                        const isFocused = focusId && String(v.id) === String(focusId);
                        const vStatus = displayStatus(v);
                        const isPending = vStatus === 'pending';
                        return (
                          <Link
                            to={`/wellness/patients/${v.patient?.id || v.patientId}`}
                            key={v.id}
                            ref={isFocused ? focusedRef : undefined}
                            data-testid={isFocused ? 'focused-visit' : `visit-chip-${v.id}`}
                            style={{
                              textDecoration: 'none',
                              color: 'var(--text-primary)',
                              background: STATUS_COLOR[vStatus] || 'rgba(255,255,255,0.05)',
                              borderLeft: `3px solid ${STATUS_BORDER[vStatus] || '#64748b'}`,
                              padding: '0.4rem 0.5rem',
                              borderRadius: '6px',
                              fontSize: '0.75rem',
                              display: 'block',
                              minWidth: 0,
                              maxWidth: '100%',
                              overflow: 'hidden',
                              outline: isFocused ? '2px solid var(--primary-color, var(--accent-color, #6366f1))' : undefined,
                              outlineOffset: isFocused ? '2px' : undefined,
                              boxShadow: isFocused ? '0 0 0 4px rgba(99,102,241,0.18), 0 6px 18px rgba(0,0,0,0.25)' : undefined,
                            }}
                            title={`${new Date(v.visitDate).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: false })} IST · ${v.patient?.name || `#${v.patientId}`}${v.service?.name ? ` — ${v.service.name}` : ''}`}
                            onClick={(e) => e.stopPropagation()}
                          >
                            <div style={{ fontWeight: 500, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                              {new Date(v.visitDate).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: false })} IST · {v.patient?.name || `#${v.patientId}`}
                            </div>
                            <div style={{ color: 'var(--text-secondary)', fontSize: '0.7rem', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                              {v.service?.name || '—'}
                            </div>
                            {(() => {
                              const bt = v.bookingType || 'CLINIC_VISIT';
                              const meta = BOOKING_TYPE_META[bt] || BOOKING_TYPE_META.CLINIC_VISIT;
                              const Icon = meta.icon;
                              return (
                                <div
                                  style={{
                                    display: 'flex',
                                    alignItems: 'center',
                                    gap: 4,
                                    marginTop: 3,
                                    fontSize: '0.65rem',
                                    color: meta.color,
                                    whiteSpace: 'nowrap',
                                    overflow: 'hidden',
                                    textOverflow: 'ellipsis',
                                  }}
                                >
                                  <Icon size={11} aria-hidden="true" />
                                  <span data-testid={`booking-type-${bt}`}>{meta.label}</span>
                                  {bt === 'IN_HOME' && Number.isFinite(v.travelTimeMinutes) && v.travelTimeMinutes > 0 && (
                                    <span data-testid="travel-time" style={{ color: 'var(--text-secondary)', display: 'inline-flex', alignItems: 'center', gap: 2 }}>
                                      <Car size={10} aria-hidden="true" /> Travel: {v.travelTimeMinutes} min
                                    </span>
                                  )}
                                </div>
                              );
                            })()}
                            {isPending && canAssignDoctor && (
                              <div
                                style={{
                                  marginTop: '0.35rem',
                                  display: 'flex',
                                  alignItems: 'flex-start',
                                  gap: '0.3rem',
                                  flexWrap: 'wrap',
                                }}
                              >
                                <span
                                  data-testid={`pending-badge-${v.id}`}
                                  style={{
                                    padding: '0.1rem 0.4rem',
                                    borderRadius: 999,
                                    fontSize: '0.6rem',
                                    fontWeight: 600,
                                    textTransform: 'uppercase',
                                    letterSpacing: '0.04em',
                                    background: 'rgba(245,158,11,0.18)',
                                    color: '#f59e0b',
                                    border: '1px solid rgba(245,158,11,0.4)',
                                  }}
                                >
                                  Pending
                                </span>
                                <button
                                  type="button"
                                  onClick={(e) => {
                                    e.preventDefault();
                                    e.stopPropagation();
                                    onAssignClick(v);
                                  }}
                                  data-testid={`assign-doctor-${v.id}`}
                                  style={{
                                    padding: '0.15rem 0.5rem',
                                    borderRadius: 6,
                                    fontSize: '0.65rem',
                                    fontWeight: 500,
                                    background: 'var(--primary-color, var(--accent-color, #6366f1))',
                                    color: '#fff',
                                    border: 'none',
                                    cursor: 'pointer',
                                    maxWidth: '100%',
                                    whiteSpace: 'normal',
                                    textAlign: 'left',
                                  }}
                                >
                                  Assign doctor
                                </button>
                              </div>
                            )}
                          </Link>
                        );
                      })}
                      {isCreatable && (
                        <span
                          data-empty-affordance
                          style={{
                            position: 'absolute',
                            inset: 0,
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'center',
                            color: 'var(--accent-color)',
                            opacity: 0,
                            transition: 'opacity 0.12s',
                            pointerEvents: 'none',
                            fontSize: '0.7rem',
                            fontWeight: 500,
                            gap: '0.25rem',
                          }}
                        >
                          <Plus size={12} /> Book
                        </span>
                      )}
                    </div>
                  );
                })}
              </React.Fragment>
            ))}
          </div>
        </div>
      </TopScrollSync>
    </div>
  );
}
