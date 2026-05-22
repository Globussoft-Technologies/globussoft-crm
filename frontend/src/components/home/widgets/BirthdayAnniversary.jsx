import { Gift } from 'lucide-react';
import WidgetCard from '../WidgetCard.jsx';
import { useWidgetData } from '../useWidgetData.js';

export default function BirthdayAnniversary({ meta }) {
  const { data, loading, error } = useWidgetData('/api/wellness/patients?birthday=today');
  const list = Array.isArray(data?.patients)
    ? data.patients
    : Array.isArray(data)
      ? data
      : [];

  return (
    <WidgetCard
      title={meta?.title || 'Birthdays + anniversaries today'}
      description={meta?.description}
      icon={Gift}
      loading={loading}
      error={error}
      empty={!loading && !error && list.length === 0}
      emptyMessage="No birthdays or anniversaries today."
      linkTo="/wellness/patients"
      linkLabel="Open patients"
    >
      <div style={{ fontSize: '1.5rem', fontWeight: 700 }}>{list.length}</div>
      <ul style={{ listStyle: 'none', padding: 0, margin: 0, fontSize: '0.85rem' }}>
        {list.slice(0, 3).map((p) => (
          <li
            key={p.id}
            style={{
              padding: '0.25rem 0',
              borderTop: '1px solid var(--border-color)',
            }}
          >
            🎂 {p.name}
          </li>
        ))}
      </ul>
    </WidgetCard>
  );
}
