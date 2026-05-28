import { PhoneOff } from 'lucide-react';
import WidgetCard from '../WidgetCard.jsx';
import { useWidgetData } from '../useWidgetData.js';

export default function MissedCalls({ meta }) {
  // Canonical call-log endpoint is /api/communications/calls (returns all
  // CallLog rows in tenant scope, no server-side status filter). Client-
  // side filters for missed so the count reflects "unanswered inbound".
  const { data, loading, error } = useWidgetData('/api/communications/calls');
  const rows = Array.isArray(data)
    ? data
    : Array.isArray(data?.calls)
      ? data.calls
      : [];
  // CallLog.status conventions vary by provider; accept the common spellings.
  const list = rows.filter((c) => {
    const s = (c.status || '').toLowerCase();
    return s === 'missed' || s === 'no-answer' || s === 'noanswer';
  });

  return (
    <WidgetCard
      title={meta?.title || 'Missed calls'}
      description={meta?.description}
      icon={PhoneOff}
      loading={loading}
      error={error}
      empty={!loading && !error && list.length === 0}
      emptyMessage="No missed calls."
      linkTo="/channels"
      linkLabel="View call log"
    >
      <div style={{ fontSize: '1.5rem', fontWeight: 700 }}>{list.length}</div>
      <div style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>
        Inbound calls to return
      </div>
    </WidgetCard>
  );
}
