import { PhoneCall } from 'lucide-react';
import WidgetCard from '../WidgetCard.jsx';
import { useWidgetData } from '../useWidgetData.js';

export default function TelecallerQueue({ meta }) {
  const { data, loading, error } = useWidgetData(
    '/api/wellness/telecaller/queue?limit=50',
  );
  const list = Array.isArray(data?.queue)
    ? data.queue
    : Array.isArray(data)
      ? data
      : [];
  const hot = list.filter((l) => (l.score || l.priority) === 'hot' || l.priority === 'HIGH');

  return (
    <WidgetCard
      title={meta?.title || 'Telecaller queue'}
      description={meta?.description}
      icon={PhoneCall}
      loading={loading}
      error={error}
      empty={!loading && !error && list.length === 0}
      emptyMessage="Queue clear."
      linkTo="/wellness/telecaller"
      linkLabel="Open queue"
    >
      <div style={{ fontSize: '1.5rem', fontWeight: 700 }}>
        {list.length}{' '}
        <span style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', fontWeight: 400 }}>
          in queue · {hot.length} hot
        </span>
      </div>
    </WidgetCard>
  );
}
