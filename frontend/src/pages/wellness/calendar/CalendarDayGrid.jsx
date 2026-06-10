import React from 'react';
import { Link } from 'react-router-dom';
import { UserIcon, Stethoscope, Plus, Car } from 'lucide-react';
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

export default function CalendarDayGrid({
  columns,
  HOURS,
  grid,
  focusId,
  focusedRef,
  onEmptyCellClick,
  onAssignClick,
}) {
  return (
    <div
      className="glass calendar-scroll"
      style={{
        padding: '1rem',
        // Clamp width to the viewport so the inner grid's minWidth
        // (~120px per practitioner × N columns) triggers horizontal
        // scroll inside this wrapper instead of pushing the page wider.
        // scrollbar-color forces the thumb to be visible on Windows
        // overlay-scrollbar setups where the default is invisible.
        maxWidth: '100%',
        overflowX: 'auto',
        overflowY: 'auto',
        scrollbarWidth: 'thin',
        scrollbarColor: 'rgba(255,255,255,0.3) transparent',
      }}
    >
      {/* #615: use minmax(0, 1fr) per the CLAUDE.md ellipsis-on-grid-children
          standing rule. Hard 120px floor at the minmax min would have
          prevented columns from collapsing past 120px and forced the
          whole grid to overflow horizontally instead of letting the
          ellipsis chain on each cell clip — see line 199 column header
          and line 230 hour cell, both have minWidth:0. */}
      <div className="calendar-grid" style={{ display: 'grid', gridTemplateColumns: `80px repeat(${columns.length}, minmax(0, 1fr))`, gap: '4px', minWidth: `${80 + columns.length * 120}px` }}>
        <div style={{ ...colHead, background: 'transparent' }}></div>
        {columns.map((c) => (
          <div key={c.id} style={{ ...colHead, opacity: c.isUnassigned ? 0.7 : 1, minWidth: 0, overflow: 'hidden' }} title={c.role ? `${c.name} · ${c.role}` : c.name}>
            {c.isUnassigned ? (
              <UserIcon size={14} style={{ verticalAlign: 'middle', marginRight: '0.4rem', opacity: 0.7, flexShrink: 0 }} />
            ) : (
              <Stethoscope size={14} style={{ verticalAlign: 'middle', marginRight: '0.4rem', opacity: 0.7, flexShrink: 0 }} />
            )}
            {/* #486: name + role row needs explicit overflow:hidden + ellipsis,
                otherwise "Sandeep Bose" (12 chars) + " DOCTOR" suffix overflows
                the 120px min column width and clips into the next column. */}
            <span style={{ display: 'inline-block', verticalAlign: 'middle', maxWidth: 'calc(100% - 22px)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {c.name}
              {c.role && (
                <span style={{ fontSize: '0.65rem', color: 'var(--text-secondary)', marginLeft: '0.4rem', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
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
              // #270: empty slots are clickable when the column belongs to a
              // real practitioner (not the synthetic Unassigned column —
              // a fresh booking should always be assigned to someone).
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
                        textDecoration: 'none', color: 'var(--text-primary)',
                        background: STATUS_COLOR[vStatus] || 'rgba(255,255,255,0.05)',
                        borderLeft: `3px solid ${STATUS_BORDER[vStatus] || '#64748b'}`,
                        padding: '0.4rem 0.5rem', borderRadius: '6px',
                        fontSize: '0.75rem', display: 'block',
                        // #486: keep the event chip clamped to its grid-cell width
                        // so long patient names + service titles ellipsis-truncate
                        // instead of overflowing into the next practitioner column.
                        minWidth: 0, maxWidth: '100%', overflow: 'hidden',
                        // Focus halo: the chip the user opened from the
                        // Appointments page gets a pulsing outline + raised
                        // shadow so they don't lose it in a busy grid.
                        outline: isFocused ? '2px solid var(--primary-color, var(--accent-color, #6366f1))' : undefined,
                        outlineOffset: isFocused ? '2px' : undefined,
                        boxShadow: isFocused ? '0 0 0 4px rgba(99,102,241,0.18), 0 6px 18px rgba(0,0,0,0.25)' : undefined,
                      }}
                      title={`${new Date(v.visitDate).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: false })} IST · ${v.patient?.name || `#${v.patientId}`}${v.service?.name ? ` — ${v.service.name}` : ''}`}
                      onClick={(e) => e.stopPropagation()}
                    >
                      <div style={{ fontWeight: 500, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                        {/* #361: explicit IST suffix — the wall time on the chip is
                            already IST-localised (toLocaleTimeString w/ en-IN +
                            +05:30 fetch window upstream), but receptionists in
                            shared workspaces couldn't tell at a glance. */}
                        {new Date(v.visitDate).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: false })} IST · {v.patient?.name || `#${v.patientId}`}
                      </div>
                      <div style={{ color: 'var(--text-secondary)', fontSize: '0.7rem', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                        {v.service?.name || '—'}
                      </div>
                      {/* Wave 7D — booking-type badge + travel-time
                          annotation. Both fields land on Visit per
                          Wave 2D; pre-Wave-2D rows have null bookingType,
                          so we treat that as CLINIC_VISIT for the badge
                          icon (matches the column default). Travel time
                          is only surfaced for IN_HOME visits where the
                          field is meaningful — staff dispatch needs to
                          know the buffer to allocate. */}
                      {(() => {
                        const bt = v.bookingType || 'CLINIC_VISIT';
                        const meta = BOOKING_TYPE_META[bt] || BOOKING_TYPE_META.CLINIC_VISIT;
                        const Icon = meta.icon;
                        return (
                          <div style={{
                            display: 'flex', alignItems: 'center', gap: 4,
                            marginTop: 3, fontSize: '0.65rem',
                            color: meta.color,
                            whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                          }}>
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
                      {isPending && (
                        <div style={{ marginTop: '0.35rem', display: 'flex', alignItems: 'center', gap: '0.3rem' }}>
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
                              // Stop the Link nav so the modal can mount.
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
                        position: 'absolute', inset: 0,
                        display: 'flex', alignItems: 'center', justifyContent: 'center',
                        color: 'var(--accent-color)', opacity: 0,
                        transition: 'opacity 0.12s',
                        pointerEvents: 'none',
                        fontSize: '0.7rem', fontWeight: 500, gap: '0.25rem',
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
  );
}
