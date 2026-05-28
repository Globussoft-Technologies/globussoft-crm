import { Calendar } from 'lucide-react';
import WidgetCard from '../WidgetCard.jsx';
import { useWidgetData, todayLocalDayWindow } from '../useWidgetData.js';

export default function FullClinicCalendar({ meta }) {
  const { from, to } = todayLocalDayWindow();
  // For reception / admin users, /api/wellness/visits returns the full
  // clinic feed (server scopes to doctor's own only when wellnessRole=
  // doctor — receptionists + managers see everything). 500 should cover
  // a clinic day comfortably.
  const { data, loading, error } = useWidgetData(
    `/api/wellness/visits?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}&limit=500`,
    [from, to],
  );
  const list = Array.isArray(data)
    ? data
    : Array.isArray(data?.visits)
      ? data.visits
      : [];

  // Group by practitioner
  const byDoctor = list.reduce((acc, v) => {
    const key = v.doctor?.name || `Doctor #${v.doctorId || '?'}`;
    acc[key] = (acc[key] || 0) + 1;
    return acc;
  }, {});

  const rows = Object.entries(byDoctor)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5);

  return (
    <WidgetCard
      title={meta?.title || 'Full clinic calendar'}
      description={meta?.description}
      icon={Calendar}
      loading={loading}
      error={error}
      empty={!loading && !error && list.length === 0}
      emptyMessage="No bookings today across the clinic."
      linkTo="/wellness/calendar"
      linkLabel="View calendar"
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: '0.4rem' }}>
        <div style={{ fontSize: '1.5rem', fontWeight: 700 }}>
          {list.length}{' '}
          <span style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', fontWeight: 400 }}>
            bookings · {Object.keys(byDoctor).length} practitioners
          </span>
        </div>
        <ul style={{ listStyle: 'none', padding: 0, margin: 0, fontSize: '0.85rem' }}>
          {rows.map(([name, count]) => (
            <li
              key={name}
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                padding: '0.25rem 0',
                borderTop: '1px solid var(--border-color)',
              }}
            >
              <span>{name}</span>
              <span style={{ color: 'var(--text-secondary)' }}>{count}</span>
            </li>
          ))}
        </ul>
      </div>
    </WidgetCard>
  );
}
