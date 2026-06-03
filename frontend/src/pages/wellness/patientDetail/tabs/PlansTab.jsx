import { useState } from 'react';
import { fetchApi } from '../../../utils/api';
import { useNotify } from '../../../utils/notify';
import { useFormAutosave } from '../../../utils/useFormAutosave';
import { formatDate } from '../../../utils/date';
import { DateRangeFilter, resolveDateRange, EMPTY_DATE_FILTER } from '../../../components/wellness/DateRangeFilter';
import { inputStyle } from '../shared/helpers';
import { RestoredBanner } from '../shared/components';

const INITIAL_PLAN = {
  name: '',
  totalSessions: 4,
  totalPrice: 0,
  serviceId: '',
};

// ── Treatment plans tab ───────────────────────────────────────────
export default function PlansTab({ patient, services, onSaved }) {
  const notify = useNotify();
  const [draft, setDraft, isDirty, clearDraft] = useFormAutosave(`plan-${patient.id}`, INITIAL_PLAN);
  const { name, totalSessions, totalPrice, serviceId } = draft;
  const setName = (v) => setDraft((s) => ({ ...s, name: v }));
  const setTotalSessions = (v) => setDraft((s) => ({ ...s, totalSessions: v }));
  const setTotalPrice = (v) => setDraft((s) => ({ ...s, totalPrice: v }));
  const setServiceId = (v) => setDraft((s) => ({ ...s, serviceId: v }));
  const [filter, setFilter] = useState(EMPTY_DATE_FILTER);
  const [rangeStart, rangeEnd] = resolveDateRange(filter);
  const allPlans = patient.treatmentPlans || [];
  const plans = (rangeStart && rangeEnd)
    ? allPlans.filter((tp) => {
        const ts = new Date(tp.createdAt).getTime();
        return ts >= rangeStart.getTime() && ts <= rangeEnd.getTime();
      })
    : allPlans;
  const [submitting, setSubmitting] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    if (submitting) return;
    setSubmitting(true);
    try {
      await fetchApi('/api/wellness/treatment-plans', {
        method: 'POST',
        body: JSON.stringify({
          patientId: patient.id,
          name, totalSessions, totalPrice, serviceId: serviceId || null,
        }),
      });
      notify.success(`Treatment plan "${name}" created`);
      clearDraft();
      onSaved();
    } catch (_err) { /* fetchApi already toasted */ } finally {
      setSubmitting(false);
    }
  };

  return (
    <div>
      {allPlans.length > 0 && (
        <div
          className="glass"
          style={{
            padding: '0.6rem 0.85rem', display: 'flex', flexWrap: 'wrap',
            alignItems: 'center', gap: '0.6rem', marginBottom: '0.75rem',
          }}
        >
          <DateRangeFilter value={filter} onChange={setFilter} label="Filter by created date" />
          <span style={{ marginLeft: 'auto', fontSize: '0.8rem', color: 'var(--text-secondary)' }}>
            {plans.length === allPlans.length
              ? `${allPlans.length} plan${allPlans.length === 1 ? '' : 's'}`
              : `${plans.length} of ${allPlans.length} plans`}
          </span>
        </div>
      )}
      <div style={{ marginBottom: '1rem', display: 'grid', gap: '0.5rem' }}>
        {allPlans.length === 0 && (
          <div className="glass" style={{ padding: '1rem', color: 'var(--text-secondary)', fontSize: '0.9rem' }}>No treatment plans yet.</div>
        )}
        {allPlans.length > 0 && plans.length === 0 && (
          <div className="glass" style={{ padding: '1rem', color: 'var(--text-secondary)', fontSize: '0.9rem' }}>No plans in the selected range.</div>
        )}
        {plans.map((tp) => (
          <div key={tp.id} className="glass" style={{ padding: '1rem', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <div>
              <div style={{ fontWeight: 500 }}>{tp.name}</div>
              <div style={{ fontSize: '0.8rem', color: 'var(--text-secondary)' }}>
                {tp.service?.name && <>{tp.service.name} • </>}
                Session {tp.completedSessions}/{tp.totalSessions}
                {tp.totalPrice > 0 && <> • ₹{Math.round(tp.totalPrice).toLocaleString('en-IN')}</>}
                {tp.createdAt && <> • Started {formatDate(tp.createdAt)}</>}
              </div>
            </div>
            <div style={{ width: 100, background: 'rgba(255,255,255,0.05)', borderRadius: 20, height: 6, overflow: 'hidden' }}>
              <div style={{ width: `${Math.round((tp.completedSessions / tp.totalSessions) * 100)}%`, background: 'var(--success-color)', height: '100%' }} />
            </div>
          </div>
        ))}
      </div>

      <form onSubmit={submit} className="glass" style={{ padding: '1.25rem' }}>
        <h4 style={{ marginBottom: '0.75rem', fontSize: '0.95rem' }}>New treatment plan</h4>
        {isDirty && <RestoredBanner onDiscard={clearDraft} />}
        <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr 1fr 1fr auto', gap: '0.5rem' }}>
          <input placeholder="Plan name (e.g. PRP 6-session package)" value={name} onChange={(e) => setName(e.target.value)} required style={inputStyle} />
          <select value={serviceId} onChange={(e) => setServiceId(e.target.value)} style={inputStyle}>
            <option value="">Service</option>
            {services.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
          <input type="number" placeholder="Sessions" min={1} value={totalSessions} onChange={(e) => setTotalSessions(parseInt(e.target.value) || 1)} style={inputStyle} />
          <input type="number" placeholder="Total price ₹" value={totalPrice} onChange={(e) => setTotalPrice(parseFloat(e.target.value) || 0)} style={inputStyle} />
          <button
            type="submit"
            disabled={submitting}
            style={{
              padding: '0.5rem 1rem',
              background: submitting ? 'rgba(107,114,128,0.3)' : 'var(--accent-color)',
              color: '#fff', border: 'none', borderRadius: 8,
              cursor: submitting ? 'not-allowed' : 'pointer',
              opacity: submitting ? 0.6 : 1,
            }}
          >
            {submitting ? 'Adding…' : 'Add'}
          </button>
        </div>
      </form>
    </div>
  );
}
