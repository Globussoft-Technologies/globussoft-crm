import { PenTool } from 'lucide-react';
import WidgetCard, { Metric } from '../WidgetCard.jsx';
import { useWidgetData } from '../useWidgetData.js';

export default function PendingPrescriptions({ meta }) {
  const { data, loading, error } = useWidgetData(
    '/api/wellness/prescriptions?status=draft',
  );
  const list = Array.isArray(data)
    ? data
    : Array.isArray(data?.items)
      ? data.items
      : Array.isArray(data?.prescriptions)
        ? data.prescriptions
        : [];

  return (
    <WidgetCard
      title={meta?.title || 'Pending prescriptions'}
      description={meta?.description}
      icon={PenTool}
      loading={loading}
      error={error}
      empty={!loading && !error && list.length === 0}
      emptyMessage="No pending prescriptions."
      emptyHint="Drafts waiting on you to finalise will appear here."
      linkTo="/wellness/prescriptions"
      linkLabel="Review all"
    >
      <Metric
        value={list.length}
        label={list.length === 1 ? 'draft' : 'drafts'}
        sub="To finalise from prior visits"
      />
    </WidgetCard>
  );
}
