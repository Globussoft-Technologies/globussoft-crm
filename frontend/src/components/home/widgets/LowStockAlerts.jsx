import { Package } from 'lucide-react';
import WidgetCard from '../WidgetCard.jsx';
import { useWidgetData } from '../useWidgetData.js';

export default function LowStockAlerts({ meta }) {
  // /api/wellness/products?lowStock=true returns Product rows where
  // currentStock <= threshold. Shape: { id, name, sku, currentStock,
  // threshold, ... } — note `currentStock` (not `quantity`).
  const { data, loading, error } = useWidgetData('/api/wellness/products?lowStock=true');
  const list = Array.isArray(data) ? data : Array.isArray(data?.products) ? data.products : [];

  return (
    <WidgetCard
      title={meta?.title || 'Low-stock inventory alerts'}
      description={meta?.description}
      icon={Package}
      loading={loading}
      error={error}
      empty={!loading && !error && list.length === 0}
      emptyMessage="Inventory is healthy."
      linkTo="/wellness/inventory"
      linkLabel="Open inventory"
    >
      <div style={{ fontSize: '1.5rem', fontWeight: 700 }}>{list.length}</div>
      <ul style={{ listStyle: 'none', padding: 0, margin: 0, fontSize: '0.85rem' }}>
        {list.slice(0, 3).map((p) => (
          <li
            key={p.id}
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              padding: '0.25rem 0',
              borderTop: '1px solid var(--border-color)',
            }}
          >
            <span>{p.name || p.sku}</span>
            <span style={{ color: '#dc2626', fontWeight: 600 }}>{p.currentStock ?? p.quantity ?? 0}</span>
          </li>
        ))}
      </ul>
    </WidgetCard>
  );
}
