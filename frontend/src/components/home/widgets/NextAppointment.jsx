import { Calendar } from 'lucide-react';
import WidgetCard from '../WidgetCard.jsx';
import { useWidgetData } from '../useWidgetData.js';

export default function NextAppointment({ meta }) {
  // Patient-portal endpoint surfaces the signed-in customer's appointments.
  const { data, loading, error } = useWidgetData('/api/wellness/portal/visits?upcoming=true');
  const list = Array.isArray(data?.visits)
    ? data.visits
    : Array.isArray(data)
      ? data
      : [];
  const next = list
    .filter((v) => v.scheduledAt && new Date(v.scheduledAt) > new Date())
    .sort((a, b) => new Date(a.scheduledAt) - new Date(b.scheduledAt))[0];

  return (
    <WidgetCard
      title={meta?.title || 'Your next appointment'}
      description={meta?.description}
      icon={Calendar}
      loading={loading}
      error={error}
      empty={!loading && !error && !next}
      emptyMessage="No upcoming appointments."
      linkTo="/portal"
      linkLabel="View details"
    >
      {next && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.3rem' }}>
          <div style={{ fontSize: '1rem', fontWeight: 600 }}>
            {new Date(next.scheduledAt).toLocaleString([], {
              weekday: 'short',
              day: 'numeric',
              month: 'short',
              hour: '2-digit',
              minute: '2-digit',
            })}
          </div>
          <div style={{ fontSize: '0.8rem', color: 'var(--text-secondary)' }}>
            {next.service?.name || next.location?.name || ''}
          </div>
        </div>
      )}
    </WidgetCard>
  );
}
