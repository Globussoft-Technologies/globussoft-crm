import { STATUS_BORDER, BOOKING_TYPE_META, BOOKING_TYPE_ORDER } from './constants';

export default function CalendarLegends() {
  return (
    <>
      <div style={{ marginTop: '1rem', display: 'flex', flexWrap: 'wrap', gap: '0.5rem', fontSize: '0.75rem' }}>
        {Object.entries(STATUS_BORDER).map(([s, color]) => (
          <span key={s} style={{ display: 'inline-flex', alignItems: 'center', gap: '0.3rem', color: 'var(--text-secondary)' }}>
            <span style={{ width: 10, height: 10, borderRadius: 2, background: color }} />{s}
          </span>
        ))}
      </div>

      {/* Wave 7D — booking-type legend chip. Same icons used on the
          PublicBooking.jsx widget + on each event card above, so the
          receptionist can match an at-home Home icon to "AT HOME" at a
          glance. Rendered as a separate row below the status legend. */}
      <div
        data-testid="booking-type-legend"
        style={{
          marginTop: '0.5rem',
          display: 'flex', flexWrap: 'wrap', gap: '0.75rem',
          fontSize: '0.75rem',
        }}
      >
        <span style={{ color: 'var(--text-secondary)', fontWeight: 600, marginRight: '0.25rem' }}>Booking type:</span>
        {BOOKING_TYPE_ORDER.map((bt) => {
          const meta = BOOKING_TYPE_META[bt];
          const Icon = meta.icon;
          return (
            <span key={bt} style={{ display: 'inline-flex', alignItems: 'center', gap: '0.3rem', color: meta.color }}>
              <Icon size={12} aria-hidden="true" /> {meta.label}
            </span>
          );
        })}
      </div>
    </>
  );
}
