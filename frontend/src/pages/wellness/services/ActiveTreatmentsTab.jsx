import { srOnly } from './shared';
import TreatmentCard from './TreatmentCard';

export default function ActiveTreatmentsTab({ treatments, loading, onChanged, onSelectTreatment }) {
  return (
    <>
      <h2 style={srOnly}>Active treatment plans</h2>
      {loading && <div>Loading treatment plans…</div>}
      {!loading && treatments.length === 0 && (
        <div style={{ textAlign: 'center', padding: '2rem', color: 'var(--text-secondary)' }}>
          No active treatment plans yet.
        </div>
      )}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: '1rem' }}>
        {treatments.map((t) => (
          <TreatmentCard key={t.id} treatment={t} onChanged={onChanged} onSelect={onSelectTreatment} />
        ))}
      </div>
    </>
  );
}
