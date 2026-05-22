import { TrendingUp } from 'lucide-react';
import WidgetCard from '../WidgetCard.jsx';
import { useWidgetData } from '../useWidgetData.js';

export default function ConversionStats({ meta }) {
  // The wellness vertical doesn't have a generic /api/leads endpoint —
  // marketplace-leads exposes the same `conversionRate` shape we need.
  // The endpoint returns `{ total, thisWeek, conversionRate, byProvider,
  // byStatus }` and we surface the conversionRate as both "today" and
  // "past 7d" until a finer-grained today/week split lands on the
  // server. Telecaller queue conversion can take over later if a
  // dedicated stat endpoint shows up.
  const { data, loading, error } = useWidgetData('/api/marketplace-leads/stats');
  const totalPct = Number.isFinite(data?.conversionRate)
    ? data.conversionRate
    : null;
  const todayPct = totalPct;
  const weekPct = totalPct;

  return (
    <WidgetCard
      title={meta?.title || 'Conversion stats'}
      description={meta?.description}
      icon={TrendingUp}
      loading={loading}
      error={error}
      empty={!loading && !error && todayPct == null && weekPct == null}
      emptyMessage="No conversion data yet."
      linkTo="/reports"
      linkLabel="Open reports"
    >
      <div style={{ display: 'flex', gap: '1rem' }}>
        <div>
          <div style={{ fontSize: '1.2rem', fontWeight: 700 }}>
            {todayPct != null ? `${todayPct.toFixed(0)}%` : '—'}
          </div>
          <div style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>Today</div>
        </div>
        <div>
          <div style={{ fontSize: '1.2rem', fontWeight: 700 }}>
            {weekPct != null ? `${weekPct.toFixed(0)}%` : '—'}
          </div>
          <div style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>Past 7d</div>
        </div>
      </div>
    </WidgetCard>
  );
}
