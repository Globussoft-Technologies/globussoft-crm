import { Calendar } from 'lucide-react';
import WidgetCard from '../WidgetCard.jsx';
import { useWidgetData } from '../useWidgetData.js';

// Terminal statuses the patient should NOT see in their next-appointment
// card. Excluding by terminal set (rather than enumerating active) stays
// forward-compatible with statuses like 'confirmed' / 'checked-in' that
// the Calendar grid uses but the canonical validator does not list.
const TERMINAL_STATUSES = new Set(['cancelled', 'completed', 'no-show']);

export default function NextAppointment({ meta }) {
  // Patient-portal endpoint surfaces the signed-in customer's appointments.
  // /portal/visits returns the canonical Visit shape (`visitDate`, not
  // `scheduledAt`). Server already applies the upcoming + status filter
  // when `?upcoming=true` is passed; we apply the same predicate client-side
  // as a defensive belt for older backend deploys.
  const { data, loading, error } = useWidgetData('/api/wellness/portal/visits?upcoming=true');
  const list = Array.isArray(data?.visits)
    ? data.visits
    : Array.isArray(data)
      ? data
      : [];
  const now = Date.now();
  const next = list
    .filter((v) => v.visitDate && new Date(v.visitDate).getTime() > now)
    .filter((v) => !v.status || !TERMINAL_STATUSES.has(v.status))
    .sort((a, b) => new Date(a.visitDate) - new Date(b.visitDate))[0];

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
            {new Date(next.visitDate).toLocaleString([], {
              weekday: 'short',
              day: 'numeric',
              month: 'short',
              hour: '2-digit',
              minute: '2-digit',
            })}
          </div>
          <div style={{ fontSize: '0.8rem', color: 'var(--text-secondary)' }}>
            {next.service?.name || next.doctor?.name || next.location?.name || ''}
          </div>
        </div>
      )}
    </WidgetCard>
  );
}
