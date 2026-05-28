import { FileText } from 'lucide-react';
import WidgetCard from '../WidgetCard.jsx';
import { useWidgetData } from '../useWidgetData.js';

export default function MyPrescriptions({ meta }) {
  const { data, loading, error } = useWidgetData('/api/wellness/portal/prescriptions');
  const list = Array.isArray(data?.prescriptions)
    ? data.prescriptions
    : Array.isArray(data)
      ? data
      : [];
  const active = list.filter((p) => !p.endDate || new Date(p.endDate) >= new Date());

  return (
    <WidgetCard
      title={meta?.title || 'Your prescriptions'}
      description={meta?.description}
      icon={FileText}
      loading={loading}
      error={error}
      empty={!loading && !error && list.length === 0}
      emptyMessage="No prescriptions on file."
      linkTo="/portal"
      linkLabel="Open portal"
    >
      <div style={{ fontSize: '1.5rem', fontWeight: 700 }}>{active.length}</div>
      <div style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>Active prescriptions</div>
    </WidgetCard>
  );
}
