import { IndianRupee } from 'lucide-react';
import WidgetCard from '../WidgetCard.jsx';
import { useWidgetData, todayLocalISODate } from '../useWidgetData.js';

export default function RevenueVsTarget({ meta }) {
  const today = todayLocalISODate();
  const { data, loading, error } = useWidgetData(
    `/api/wellness/reports/pnl-by-service?from=${today}&to=${today}`,
    [today],
  );

  // P&L endpoint returns rows; sum revenue. Fallback if endpoint shape differs.
  const rows = Array.isArray(data?.rows)
    ? data.rows
    : Array.isArray(data)
      ? data
      : [];
  const revenue = rows.reduce((sum, r) => sum + (Number(r.revenue) || 0), 0);
  // Target: per-tenant config not yet exposed; treat as informational only.
  const target = data?.target || null;

  return (
    <WidgetCard
      title={meta?.title || 'Revenue vs target'}
      description={meta?.description}
      icon={IndianRupee}
      loading={loading}
      error={error}
      empty={!loading && !error && revenue === 0 && !target}
      emptyMessage="No revenue captured today yet."
      linkTo="/wellness/reports"
      linkLabel="Open reports"
    >
      <div style={{ fontSize: '1.5rem', fontWeight: 700 }}>
        {revenue.toLocaleString()}
      </div>
      <div style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>
        {target ? `Target ${Number(target).toLocaleString()}` : 'Daily total'}
      </div>
    </WidgetCard>
  );
}
