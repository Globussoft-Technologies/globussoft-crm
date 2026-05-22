import { Receipt } from 'lucide-react';
import WidgetCard from '../WidgetCard.jsx';
import { useWidgetData } from '../useWidgetData.js';

export default function PendingPayments({ meta }) {
  const { data, loading, error } = useWidgetData('/api/billing?status=unpaid&limit=50');
  const list = Array.isArray(data?.invoices)
    ? data.invoices
    : Array.isArray(data)
      ? data
      : [];
  const total = list.reduce((sum, inv) => sum + (Number(inv.amount) || 0), 0);

  return (
    <WidgetCard
      title={meta?.title || 'Pending payments at POS'}
      description={meta?.description}
      icon={Receipt}
      loading={loading}
      error={error}
      empty={!loading && !error && list.length === 0}
      emptyMessage="Nothing pending at the front desk."
      linkTo="/invoices"
      linkLabel="Open POS"
    >
      <div style={{ fontSize: '1.4rem', fontWeight: 700 }}>
        {list.length}{' '}
        <span style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', fontWeight: 400 }}>
          invoices
        </span>
      </div>
      <div style={{ fontSize: '0.85rem', color: 'var(--text-secondary)' }}>
        Total {total.toLocaleString()}
      </div>
    </WidgetCard>
  );
}
