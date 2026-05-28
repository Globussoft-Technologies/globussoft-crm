import { Users } from 'lucide-react';
import WidgetCard, { Metric } from '../WidgetCard.jsx';
import { useWidgetData, todayLocalDayWindow } from '../useWidgetData.js';

export default function WaitingRoom({ meta }) {
  const { from, to } = todayLocalDayWindow();
  // Visit.status values used in the wellness module: 'scheduled', 'checked-in',
  // 'in-progress', 'completed', 'no-show', 'cancelled'. "Waiting now" = the
  // ones that have arrived but haven't been seen yet.
  const { data, loading, error } = useWidgetData(
    `/api/wellness/visits?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}&limit=200`,
    [from, to],
  );

  const list = Array.isArray(data)
    ? data
    : Array.isArray(data?.visits)
      ? data.visits
      : [];
  // Filter client-side so we can render BOTH the total + the waiting subset
  // from a single fetch.
  const waiting = list.filter(
    (v) => v.status === 'checked-in' || v.status === 'in-progress',
  );

  return (
    <WidgetCard
      title={meta?.title || 'Patients waiting now'}
      description={meta?.description}
      icon={Users}
      loading={loading}
      error={error}
      empty={!loading && !error && waiting.length === 0}
      emptyMessage="No patients in the waiting room."
      emptyHint="Checked-in patients appear here in real time."
      linkTo="/wellness/calendar"
      linkLabel="Open calendar"
    >
      <Metric
        value={waiting.length}
        label="waiting"
        sub={`${list.length} total today`}
      />
    </WidgetCard>
  );
}
