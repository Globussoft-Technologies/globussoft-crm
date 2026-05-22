import { BarChart3 } from 'lucide-react';
import WidgetCard from '../WidgetCard.jsx';
import { useWidgetData, todayLocalISODate } from '../useWidgetData.js';

export default function OccupancyByPractitioner({ meta }) {
  const today = todayLocalISODate();
  const { data, loading, error } = useWidgetData(
    `/api/wellness/reports/per-professional?from=${today}&to=${today}`,
    [today],
  );
  const rows = Array.isArray(data?.rows)
    ? data.rows
    : Array.isArray(data)
      ? data
      : [];
  const top = rows
    .map((r) => ({
      name: r.name || r.professional || `#${r.professionalId || r.id}`,
      pct: Number.isFinite(r.occupancy)
        ? r.occupancy
        : r.bookedMinutes && r.availableMinutes
          ? (r.bookedMinutes / r.availableMinutes) * 100
          : null,
    }))
    .filter((r) => r.pct != null)
    .sort((a, b) => b.pct - a.pct)
    .slice(0, 4);

  return (
    <WidgetCard
      title={meta?.title || 'Occupancy by practitioner'}
      description={meta?.description}
      icon={BarChart3}
      loading={loading}
      error={error}
      empty={!loading && !error && top.length === 0}
      emptyMessage="No bookings to measure today yet."
      linkTo="/wellness/reports"
      linkLabel="Open reports"
    >
      <ul style={{ listStyle: 'none', padding: 0, margin: 0, fontSize: '0.85rem' }}>
        {top.map((r) => (
          <li
            key={r.name}
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              padding: '0.25rem 0',
              borderTop: '1px solid var(--border-color)',
            }}
          >
            <span>{r.name}</span>
            <span style={{ fontWeight: 600 }}>{r.pct.toFixed(0)}%</span>
          </li>
        ))}
      </ul>
    </WidgetCard>
  );
}
