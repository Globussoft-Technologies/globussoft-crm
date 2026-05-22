import { Clock } from 'lucide-react';
import WidgetCard from '../WidgetCard.jsx';
import { useWidgetData } from '../useWidgetData.js';

export default function Waitlist({ meta }) {
  // /api/wellness/waitlist is the canonical endpoint (used by the wellness
  // Calendar page). Returns the queue of patients waiting for an open slot.
  const { data, loading, error } = useWidgetData(
    '/api/wellness/waitlist?status=waiting',
  );
  const list = Array.isArray(data?.entries)
    ? data.entries
    : Array.isArray(data?.waitlist)
      ? data.waitlist
      : Array.isArray(data)
        ? data
        : [];

  return (
    <WidgetCard
      title={meta?.title || 'Waitlist + walk-ins'}
      description={meta?.description}
      icon={Clock}
      loading={loading}
      error={error}
      empty={!loading && !error && list.length === 0}
      emptyMessage="No walk-ins waiting."
      linkTo="/wellness/waitlist"
      linkLabel="Open queue"
    >
      <div style={{ fontSize: '1.5rem', fontWeight: 700 }}>{list.length}</div>
      <div style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>
        Open walk-ins or new leads
      </div>
    </WidgetCard>
  );
}
