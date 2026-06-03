import { useEffect, useState } from 'react';
import { Plus, Crown } from 'lucide-react';
import { fetchApi } from '../../../utils/api';
import { useNotify } from '../../../utils/notify';
import { formatDate } from '../../../utils/date';

// ── Wave 11 Agent EE: Memberships tab ──────────────────────────────
// Lists the patient's memberships (active + cancelled + expired), shows
// remaining balances per service, and offers a "Buy membership" button
// that opens the plan picker. Redemption happens from the visit-create
// flow (PHI-write gate); this tab is the patient-side surface.
export default function MembershipsTab({ patient, services }) {
  const notify = useNotify();
  const [memberships, setMemberships] = useState([]);
  const [plans, setPlans] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showBuy, setShowBuy] = useState(false);
  const [pickedPlanId, setPickedPlanId] = useState('');
  const [buying, setBuying] = useState(false);

  const load = () => {
    setLoading(true);
    Promise.all([
      fetchApi(`/api/wellness/patients/${patient.id}/memberships`).catch(() => []),
      fetchApi('/api/wellness/membership-plans').catch(() => []),
    ])
      .then(([m, p]) => {
        setMemberships(Array.isArray(m) ? m : []);
        setPlans(Array.isArray(p) ? p : []);
      })
      .finally(() => setLoading(false));
  };

  useEffect(load, [patient.id]);

  const buy = async () => {
    if (!pickedPlanId) {
      notify.error('Pick a plan first');
      return;
    }
    setBuying(true);
    try {
      await fetchApi(`/api/wellness/patients/${patient.id}/memberships`, {
        method: 'POST',
        body: JSON.stringify({ planId: parseInt(pickedPlanId, 10) }),
      });
      notify.success('Membership purchased');
      setShowBuy(false);
      setPickedPlanId('');
      load();
    } catch (_err) {
      // fetchApi toasted
    } finally {
      setBuying(false);
    }
  };

  const cancel = async (m) => {
    const ok = await notify.confirm({
      title: 'Cancel membership',
      message: `Cancel "${m.plan?.name || 'membership'}"? Remaining entitlements will be void.`,
      confirmText: 'Cancel membership',
      destructive: true,
    });
    if (!ok) return;
    try {
      await fetchApi(`/api/wellness/memberships/${m.id}/cancel`, {
        method: 'POST',
        body: JSON.stringify({ reason: 'staff cancel' }),
      });
      notify.success('Membership cancelled');
      load();
    } catch (_err) { /* toasted */ }
  };

  const serviceName = (id) => {
    const s = services.find((x) => x.id === id);
    return s ? s.name : `Service #${id}`;
  };

  if (loading) return <div className="glass" style={{ padding: '1.5rem' }}>Loading memberships…</div>;

  return (
    <div className="glass" style={{ padding: '1.5rem' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1rem' }}>
        <h2 style={{ fontSize: '1.1rem', fontWeight: 600, display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
          <Crown size={18} /> Memberships
        </h2>
        <button
          onClick={() => setShowBuy(!showBuy)}
          style={{ padding: '0.4rem 0.8rem', borderRadius: 6, background: 'var(--primary-color, var(--accent-color))', color: '#fff', border: 'none', cursor: 'pointer', fontSize: '0.85rem', display: 'flex', alignItems: 'center', gap: '0.3rem' }}
        >
          <Plus size={14} /> {showBuy ? 'Cancel' : 'Buy membership'}
        </button>
      </div>

      {showBuy && (
        <div style={{ background: 'var(--surface-color)', padding: '1rem', borderRadius: 6, marginBottom: '1rem' }}>
          <label style={{ display: 'block', fontSize: '0.85rem', marginBottom: '0.4rem', color: 'var(--text-secondary)' }}>Select a plan</label>
          <select
            value={pickedPlanId}
            onChange={(e) => setPickedPlanId(e.target.value)}
            style={{ width: '100%', padding: '0.5rem', borderRadius: 6, border: '1px solid var(--border-color)', background: 'var(--surface-color)', marginBottom: '0.75rem' }}
          >
            <option value="">— Choose a plan —</option>
            {plans.map((p) => (
              <option key={p.id} value={p.id}>{p.name} ({p.durationDays} days, {p.currency} {p.price})</option>
            ))}
          </select>
          <button onClick={buy} disabled={buying || !pickedPlanId} style={{ padding: '0.5rem 1rem', borderRadius: 6, border: 'none', background: 'var(--primary-color, var(--accent-color))', color: '#fff', cursor: buying ? 'wait' : 'pointer' }}>
            {buying ? 'Purchasing…' : 'Confirm purchase'}
          </button>
        </div>
      )}

      {memberships.length === 0 ? (
        <p style={{ color: 'var(--text-secondary)', fontStyle: 'italic' }}>This patient has no memberships yet.</p>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
          {memberships.map((m) => {
            let balance = [];
            try { balance = JSON.parse(m.balance || '[]'); } catch { balance = []; }
            const expired = m.status === 'expired' || (new Date(m.endDate) < new Date());
            const cancelled = m.status === 'cancelled';
            const statusColor = cancelled ? '#991b1b' : expired ? '#92400e' : '#065f46';
            const statusBg = cancelled ? '#fee2e2' : expired ? '#fef3c7' : '#d1fae5';
            return (
              <div key={m.id} style={{ padding: '1rem', border: '1px solid var(--border-color)', borderRadius: 8, opacity: cancelled ? 0.65 : 1 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '0.5rem' }}>
                  <div>
                    <strong>{m.plan?.name || `Plan #${m.planId}`}</strong>
                    <div style={{ fontSize: '0.8rem', color: 'var(--text-secondary)' }}>
                      {formatDate(m.startDate)} → {formatDate(m.endDate)}
                    </div>
                  </div>
                  <span style={{ fontSize: '0.75rem', padding: '0.15rem 0.5rem', borderRadius: 4, background: statusBg, color: statusColor }}>
                    {cancelled ? 'cancelled' : expired ? 'expired' : 'active'}
                  </span>
                </div>
                <div style={{ fontSize: '0.85rem' }}>
                  <strong>Remaining:</strong>
                  {balance.length === 0 ? (
                    <span style={{ color: 'var(--text-secondary)', marginLeft: '0.5rem' }}>(no balance)</span>
                  ) : (
                    <ul style={{ paddingLeft: '1.2rem', margin: '0.25rem 0' }}>
                      {balance.map((b, i) => (
                        <li key={i}>{serviceName(b.serviceId)}: {b.remaining}</li>
                      ))}
                    </ul>
                  )}
                </div>
                {!cancelled && !expired && (
                  <button
                    onClick={() => cancel(m)}
                    style={{ marginTop: '0.5rem', padding: '0.25rem 0.5rem', fontSize: '0.8rem', borderRadius: 4, border: '1px solid var(--border-color)', background: 'transparent', color: 'var(--danger-color, #ef4444)', cursor: 'pointer' }}
                  >
                    Cancel membership
                  </button>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
