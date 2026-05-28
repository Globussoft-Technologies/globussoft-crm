import { FileSignature } from 'lucide-react';
import WidgetCard, { Metric } from '../WidgetCard.jsx';
import { useWidgetData } from '../useWidgetData.js';

export default function ConsentInbox({ meta }) {
  const { data, loading, error } = useWidgetData(
    '/api/wellness/consents?status=pending',
  );
  const list = Array.isArray(data)
    ? data
    : Array.isArray(data?.consents)
      ? data.consents
      : [];

  return (
    <WidgetCard
      title={meta?.title || 'Consent forms awaiting signature'}
      description={meta?.description}
      icon={FileSignature}
      loading={loading}
      error={error}
      empty={!loading && !error && list.length === 0}
      emptyMessage="No consent forms pending."
      emptyHint="Forms requiring a patient signature will show up here."
      linkTo="/signatures"
      linkLabel="Open"
    >
      <Metric
        value={list.length}
        label="awaiting"
        sub="Awaiting patient signature"
      />
    </WidgetCard>
  );
}
