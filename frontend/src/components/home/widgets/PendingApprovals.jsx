import { CheckSquare } from 'lucide-react';
import WidgetCard from '../WidgetCard.jsx';
import { useWidgetData } from '../useWidgetData.js';

export default function PendingApprovals({ meta }) {
  const { data, loading, error } = useWidgetData('/api/approvals?status=pending&limit=20');
  const list = Array.isArray(data?.approvals)
    ? data.approvals
    : Array.isArray(data)
      ? data
      : [];

  return (
    <WidgetCard
      title={meta?.title || 'Pending approvals'}
      description={meta?.description}
      icon={CheckSquare}
      loading={loading}
      error={error}
      empty={!loading && !error && list.length === 0}
      emptyMessage="Nothing awaiting your sign-off."
      linkTo="/approvals"
      linkLabel="Review"
    >
      <div style={{ fontSize: '1.5rem', fontWeight: 700 }}>{list.length}</div>
      <div style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>
        Awaiting your sign-off
      </div>
    </WidgetCard>
  );
}
