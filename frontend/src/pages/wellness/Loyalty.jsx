import React, { useEffect, useMemo, useState } from 'react';
import { Award, Trophy, Search, Plus, Minus, Users, Gift, CheckCircle2, X } from 'lucide-react';
import { fetchApi } from '../../utils/api';
import { useNotify } from '../../utils/notify';

// #298: Indian phone numbers were rendering as the raw "+919826720222" 12-digit
// stream. Group as +91 XXXXX XXXXX. Falls back to the original string for
// non-IN numbers (10-digit US, etc) so we don't mangle them.
function formatPhone(raw) {
  if (!raw) return '—';
  const digits = String(raw).replace(/\D/g, '');
  // 91-prefixed Indian (12 digits total)
  if (digits.length === 12 && digits.startsWith('91')) {
    return `+91 ${digits.slice(2, 7)} ${digits.slice(7)}`;
  }
  // 10-digit Indian (no country code) — group 5+5
  if (digits.length === 10) {
    return `${digits.slice(0, 5)} ${digits.slice(5)}`;
  }
  // 11-digit (with leading 0) — strip and format
  if (digits.length === 11 && digits.startsWith('0')) {
    return `${digits.slice(1, 6)} ${digits.slice(6)}`;
  }
  return String(raw);
}

/**
 * Loyalty + Referrals — manager view.
 * Top: current month leaderboard, referral pipeline.
 * Below: search a patient -> see balance + history + manual credit.
 */
export default function Loyalty() {
  const [tab, setTab] = useState('overview'); // overview | search | referrals
  const [leaderboard, setLeaderboard] = useState([]);
  const [referrals, setReferrals] = useState([]);
  const [loadingTop, setLoadingTop] = useState(true);

  const refresh = () => {
    setLoadingTop(true);
    Promise.all([
      fetchApi('/api/wellness/loyalty/leaderboard/month').catch(() => []),
      fetchApi('/api/wellness/referrals?limit=100').catch(() => ({ referrals: [] })),
    ]).then(([lb, refs]) => {
      setLeaderboard(Array.isArray(lb) ? lb : []);
      setReferrals(refs?.referrals || []);
    }).finally(() => setLoadingTop(false));
  };

  useEffect(refresh, []);

  return (
    <div style={{ padding: '2rem', animation: 'fadeIn 0.5s ease-out' }}>
      <header style={{ marginBottom: '1.25rem' }}>
        <h1 style={{ fontSize: '1.75rem', fontWeight: 600, display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
          <Award size={24} /> Loyalty + Referrals
        </h1>
        <p style={{ color: 'var(--text-secondary)', marginTop: '0.25rem' }}>
          Track patient points, redeem rewards, and reward word-of-mouth referrals.
        </p>
      </header>

      <div style={{ display: 'flex', gap: '0.5rem', marginBottom: '1.5rem', borderBottom: '1px solid var(--border-color)' }}>
        <TabBtn active={tab === 'overview'} onClick={() => setTab('overview')} icon={Trophy} label="Overview" />
        <TabBtn active={tab === 'search'} onClick={() => setTab('search')} icon={Search} label="Patient lookup" />
        <TabBtn active={tab === 'referrals'} onClick={() => setTab('referrals')} icon={Users} label="Referrals" />
      </div>

      {tab === 'overview' && (
        <OverviewTab leaderboard={leaderboard} referrals={referrals} loading={loadingTop} />
      )}
      {tab === 'search' && <SearchTab onCreditChange={refresh} />}
      {tab === 'referrals' && <ReferralsTab referrals={referrals} onChanged={refresh} />}
    </div>
  );
}

function TabBtn({ active, onClick, icon: Icon, label }) {
  return (
    <button
      onClick={onClick}
      style={{
        display: 'flex', alignItems: 'center', gap: '0.35rem',
        padding: '0.6rem 1rem',
        background: 'transparent',
        border: 'none',
        borderBottom: active ? '2px solid var(--accent-color)' : '2px solid transparent',
        color: active ? 'var(--text-primary)' : 'var(--text-secondary)',
        cursor: 'pointer', fontSize: '0.9rem', fontWeight: 500,
      }}
    >
      <Icon size={15} /> {label}
    </button>
  );
}

// ── Overview tab ──────────────────────────────────────────────────

function OverviewTab({ leaderboard, referrals, loading }) {
  // #379: pipeline cards now expose per-stage count + total reward value so
  // the manager can see "10 pending · ₹0 reward locked" vs "5 rewarded ·
  // ₹2,500 paid out" at a glance instead of just bare counts.
  const stageStats = (status) => {
    const rows = referrals.filter((r) => r.status === status);
    const totalValue = rows.reduce((sum, r) => sum + (Number(r.rewardPoints) || 0), 0);
    return { count: rows.length, totalValue };
  };
  const pending = stageStats('pending');
  const signed = stageStats('signed_up');
  const rewardedStats = stageStats('rewarded');
  const pendingReferrals = pending.count;
  const signedUp = signed.count;
  const rewarded = rewardedStats.count;

  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', gap: '1.25rem' }}>
      <div className="glass" style={{ padding: '1.5rem' }}>
        <h2 style={{ fontSize: '1rem', fontWeight: 600, marginBottom: '1rem', display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
          <Trophy size={16} /> This month — top earners
        </h2>
        {loading && <div style={{ color: 'var(--text-secondary)' }}>Loading…</div>}
        {!loading && leaderboard.length === 0 && (
          <div style={{ color: 'var(--text-secondary)', fontSize: '0.9rem' }}>No points earned yet this month.</div>
        )}
        {!loading && leaderboard.length > 0 && (
          <ol style={{ listStyle: 'none', padding: 0, margin: 0, display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
            {leaderboard.map((row, idx) => (
              <li key={row.patient.id} style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', padding: '0.5rem 0.75rem', borderRadius: 8, background: idx < 3 ? 'rgba(205,148,129,0.08)' : 'transparent' }}>
                <span style={{ fontSize: '0.95rem', fontWeight: 600, width: 24, color: idx < 3 ? 'var(--accent-color)' : 'var(--text-secondary)' }}>#{idx + 1}</span>
                <span style={{ flex: 1, fontSize: '0.9rem' }}>{row.patient.name}</span>
                <strong style={{ color: 'var(--success-color)' }}>+{row.earned} pts</strong>
              </li>
            ))}
          </ol>
        )}
      </div>

      <div className="glass" style={{ padding: '1.5rem' }}>
        <h2 style={{ fontSize: '1rem', fontWeight: 600, marginBottom: '1rem', display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
          <Users size={16} /> Referral pipeline
        </h2>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '0.75rem' }}>
          <Stat label="Pending" value={pendingReferrals} color="var(--warning-color)" sub={`${pending.count} referrals · ₹${pending.totalValue.toLocaleString('en-IN')} total`} />
          <Stat label="Signed up" value={signedUp} color="var(--accent-color)" sub={`${signed.count} referrals · ₹${signed.totalValue.toLocaleString('en-IN')} total`} />
          <Stat label="Rewarded" value={rewarded} color="var(--success-color)" sub={`${rewardedStats.count} referrals · ₹${rewardedStats.totalValue.toLocaleString('en-IN')} total`} />
        </div>
        <p style={{ color: 'var(--text-secondary)', fontSize: '0.8rem', marginTop: '1rem' }}>
          Switch to <strong>Referrals</strong> tab to manage individual rows.
        </p>
      </div>
    </div>
  );
}

function Stat({ label, value, color, sub }) {
  return (
    <div style={{ padding: '0.75rem', background: 'rgba(38,88,85,0.04)', borderRadius: 8, textAlign: 'center' }}>
      <div style={{ fontSize: '1.5rem', fontWeight: 700, color }}>{value}</div>
      <div style={{ fontSize: '0.7rem', color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '0.05em', marginTop: '0.2rem' }}>{label}</div>
      {sub && (
        <div style={{ fontSize: '0.65rem', color: 'var(--text-secondary)', marginTop: '0.25rem' }}>{sub}</div>
      )}
    </div>
  );
}

// ── Search / lookup tab ───────────────────────────────────────────

function SearchTab({ onCreditChange }) {
  const notify = useNotify();
  const [q, setQ] = useState('');
  const [results, setResults] = useState([]);
  const [searching, setSearching] = useState(false);
  const [selected, setSelected] = useState(null);
  const [loyalty, setLoyalty] = useState(null);

  // Manual credit form
  const [creditPoints, setCreditPoints] = useState(50);
  const [creditReason, setCreditReason] = useState('');
  // Redeem form
  const [redeemPoints, setRedeemPoints] = useState(50);
  const [redeemReason, setRedeemReason] = useState('');

  const search = async (e) => {
    e?.preventDefault?.();
    if (!q.trim()) return;
    setSearching(true);
    try {
      const r = await fetchApi(`/api/wellness/patients?q=${encodeURIComponent(q)}&limit=20`);
      setResults(r.patients || []);
    } catch { setResults([]); }
    setSearching(false);
  };

  const loadLoyalty = async (p) => {
    setSelected(p);
    setLoyalty(null);
    try {
      const r = await fetchApi(`/api/wellness/loyalty/${p.id}`);
      setLoyalty(r);
    } catch (_err) { /* fetchApi already toasted */ }
  };

  const credit = async (e) => {
    e.preventDefault();
    try {
      await fetchApi(`/api/wellness/loyalty/${selected.id}/credit`, {
        method: 'POST',
        body: JSON.stringify({ points: creditPoints, reason: creditReason || 'Manual credit' }),
      });
      setCreditReason('');
      await loadLoyalty(selected);
      onCreditChange && onCreditChange();
    } catch (err) { notify.error(`Credit failed: ${err.message}`); }
  };

  const redeem = async (e) => {
    e.preventDefault();
    try {
      await fetchApi(`/api/wellness/loyalty/${selected.id}/redeem`, {
        method: 'POST',
        body: JSON.stringify({ points: redeemPoints, reason: redeemReason || 'Redemption' }),
      });
      setRedeemReason('');
      await loadLoyalty(selected);
      onCreditChange && onCreditChange();
    } catch (err) { notify.error(`Redeem failed: ${err.message}`); }
  };

  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'minmax(260px, 1fr) 2fr', gap: '1.25rem' }}>
      <div className="glass" style={{ padding: '1.25rem' }}>
        <form onSubmit={search} style={{ display: 'flex', gap: '0.4rem', marginBottom: '1rem' }}>
          <input
            placeholder="Search patient by name/phone…"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            style={inputStyle}
          />
          <button type="submit" style={{ padding: '0.5rem 0.75rem', background: 'var(--accent-color)', color: '#fff', border: 'none', borderRadius: 8, cursor: 'pointer', display: 'flex', alignItems: 'center' }}>
            <Search size={14} />
          </button>
        </form>
        {searching && <div style={{ color: 'var(--text-secondary)' }}>Searching…</div>}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.4rem' }}>
          {results.map((p) => (
            <button
              key={p.id}
              onClick={() => loadLoyalty(p)}
              style={{
                textAlign: 'left',
                padding: '0.55rem 0.75rem',
                background: selected?.id === p.id ? 'rgba(205,148,129,0.15)' : 'transparent',
                border: '1px solid var(--border-color)',
                borderRadius: 8,
                cursor: 'pointer',
                color: 'var(--text-primary)',
                fontSize: '0.85rem',
              }}
            >
              <div style={{ fontWeight: 500 }}>{p.name}</div>
              <div style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>{formatPhone(p.phone)}</div>
            </button>
          ))}
        </div>
      </div>

      <div className="glass" style={{ padding: '1.5rem', minHeight: 320 }}>
        {!selected && (
          <div style={{ color: 'var(--text-secondary)', textAlign: 'center', padding: '3rem 1rem' }}>
            Search and pick a patient to view their loyalty balance and history.
          </div>
        )}
        {selected && !loyalty && <div>Loading loyalty…</div>}
        {selected && loyalty && (
          <>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1rem' }}>
              <h2 style={{ fontSize: '1.1rem', fontWeight: 600 }}>{loyalty.patient.name}</h2>
              <div style={{ textAlign: 'right' }}>
                <div style={{ fontSize: '1.6rem', fontWeight: 700, color: 'var(--accent-color)' }}>{loyalty.balance} pts</div>
                <div style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>+{loyalty.earnedThisMonth} this month</div>
              </div>
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.75rem', marginBottom: '1.25rem' }}>
              <form onSubmit={credit} style={{ padding: '0.75rem', border: '1px solid var(--border-color)', borderRadius: 8 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', marginBottom: '0.5rem' }}>
                  <Plus size={14} color="var(--success-color)" />
                  <strong style={{ fontSize: '0.85rem' }}>Manual credit</strong>
                </div>
                <input type="number" min={1} value={creditPoints} onChange={(e) => setCreditPoints(parseInt(e.target.value) || 0)} style={inputStyle} />
                <input placeholder="Reason (optional)" value={creditReason} onChange={(e) => setCreditReason(e.target.value)} style={{ ...inputStyle, marginTop: '0.4rem' }} />
                <button type="submit" style={{ marginTop: '0.5rem', width: '100%', padding: '0.45rem', background: 'var(--success-color)', color: '#fff', border: 'none', borderRadius: 6, cursor: 'pointer' }}>Credit</button>
              </form>

              <form onSubmit={redeem} style={{ padding: '0.75rem', border: '1px solid var(--border-color)', borderRadius: 8 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', marginBottom: '0.5rem' }}>
                  <Minus size={14} color="var(--warning-color)" />
                  <strong style={{ fontSize: '0.85rem' }}>Redeem</strong>
                </div>
                <input type="number" min={1} max={loyalty.balance} value={redeemPoints} onChange={(e) => setRedeemPoints(parseInt(e.target.value) || 0)} style={inputStyle} />
                <input placeholder="Reason (e.g. ₹500 service discount)" value={redeemReason} onChange={(e) => setRedeemReason(e.target.value)} style={{ ...inputStyle, marginTop: '0.4rem' }} />
                <button type="submit" disabled={loyalty.balance < redeemPoints} style={{ marginTop: '0.5rem', width: '100%', padding: '0.45rem', background: loyalty.balance < redeemPoints ? 'var(--text-tertiary)' : 'var(--warning-color)', color: '#fff', border: 'none', borderRadius: 6, cursor: loyalty.balance < redeemPoints ? 'not-allowed' : 'pointer' }}>Redeem</button>
              </form>
            </div>

            <h3 style={{ fontSize: '0.9rem', fontWeight: 600, marginBottom: '0.5rem' }}>Recent transactions</h3>
            {loyalty.transactions.length === 0 && (
              <div style={{ color: 'var(--text-secondary)', fontSize: '0.85rem' }}>No transactions yet.</div>
            )}
            {loyalty.transactions.length > 0 && (
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.85rem' }}>
                <thead>
                  <tr><th style={th}>Date</th><th style={th}>Type</th><th style={{ ...th, textAlign: 'right' }}>Pts</th><th style={th}>Reason</th></tr>
                </thead>
                <tbody>
                  {loyalty.transactions.map((tx) => (
                    <tr key={tx.id} style={{ borderTop: '1px solid var(--border-color)' }}>
                      <td style={td}>{new Date(tx.createdAt).toLocaleDateString('en-IN')}</td>
                      <td style={td}>{tx.type}</td>
                      <td style={{ ...td, textAlign: 'right', color: tx.points >= 0 ? 'var(--success-color)' : 'var(--warning-color)', fontWeight: 600 }}>{tx.points >= 0 ? '+' : ''}{tx.points}</td>
                      <td style={{ ...td, color: 'var(--text-secondary)' }}>{tx.reason || '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </>
        )}
      </div>
    </div>
  );
}

// ── Referrals tab ─────────────────────────────────────────────────

function ReferralsTab({ referrals, onChanged }) {
  const notify = useNotify();
  const [filter, setFilter] = useState('all');
  const [showAdd, setShowAdd] = useState(false);
  const [form, setForm] = useState({ referrerPatientId: '', referredName: '', referredPhone: '', referredEmail: '' });

  const filtered = useMemo(() => {
    if (filter === 'all') return referrals;
    return referrals.filter((r) => r.status === filter);
  }, [referrals, filter]);

  const reward = async (id) => {
    const ptsStr = await notify.prompt('Reward points (default 100):', '100');
    if (!ptsStr) return;
    const pts = parseInt(ptsStr, 10);
    if (Number.isNaN(pts) || pts <= 0) { notify.error('Invalid points'); return; }
    try {
      await fetchApi(`/api/wellness/referrals/${id}/reward`, {
        method: 'PUT',
        body: JSON.stringify({ rewardPoints: pts }),
      });
      notify.success(`Rewarded ${pts} points`);
      onChanged();
    } catch (_err) { /* fetchApi already toasted */ }
  };

  const submit = async (e) => {
    e.preventDefault();
    if (!form.referrerPatientId || !form.referredName || !form.referredPhone) return;
    try {
      await fetchApi('/api/wellness/referrals', {
        method: 'POST',
        body: JSON.stringify({
          referrerPatientId: parseInt(form.referrerPatientId, 10),
          referredName: form.referredName,
          referredPhone: form.referredPhone,
          referredEmail: form.referredEmail || undefined,
        }),
      });
      notify.success(`Referral logged for ${form.referredName}`);
      setForm({ referrerPatientId: '', referredName: '', referredPhone: '', referredEmail: '' });
      setShowAdd(false);
      onChanged();
    } catch (_err) { /* fetchApi already toasted */ }
  };

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '1rem', flexWrap: 'wrap' }}>
        {['all', 'pending', 'signed_up', 'first_visit', 'rewarded'].map((s) => (
          <button
            key={s}
            onClick={() => setFilter(s)}
            style={{
              padding: '0.35rem 0.75rem',
              background: filter === s ? 'var(--accent-color)' : 'transparent',
              color: filter === s ? '#fff' : 'var(--text-secondary)',
              border: '1px solid var(--border-color)',
              borderRadius: 16,
              cursor: 'pointer', fontSize: '0.8rem',
            }}
          >
            {s.replace('_', ' ')}
          </button>
        ))}
        <div style={{ flex: 1 }} />
        <button onClick={() => setShowAdd(!showAdd)} style={{ padding: '0.45rem 0.9rem', background: 'var(--accent-color)', color: '#fff', border: 'none', borderRadius: 8, cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '0.3rem' }}>
          {showAdd ? <X size={14} /> : <Plus size={14} />} {showAdd ? 'Cancel' : 'New referral'}
        </button>
      </div>

      {showAdd && (
        <form onSubmit={submit} className="glass" style={{ padding: '1rem', marginBottom: '1rem', display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: '0.5rem' }}>
          <input placeholder="Referrer patient ID" required value={form.referrerPatientId} onChange={(e) => setForm({ ...form, referrerPatientId: e.target.value })} style={inputStyle} />
          <input placeholder="New person's name" required value={form.referredName} onChange={(e) => setForm({ ...form, referredName: e.target.value })} style={inputStyle} />
          <input placeholder="Phone (10-digit)" required value={form.referredPhone} onChange={(e) => setForm({ ...form, referredPhone: e.target.value })} style={inputStyle} />
          <input placeholder="Email (optional)" value={form.referredEmail} onChange={(e) => setForm({ ...form, referredEmail: e.target.value })} style={inputStyle} />
          <button type="submit" style={{ padding: '0.45rem 0.9rem', background: 'var(--success-color)', color: '#fff', border: 'none', borderRadius: 8, cursor: 'pointer' }}>Save</button>
        </form>
      )}

      <div className="glass" style={{ padding: 0, overflow: 'hidden' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.85rem' }}>
          <thead>
            <tr>
              <th style={th}>Referrer</th>
              <th style={th}>Referred</th>
              <th style={th}>Phone</th>
              <th style={th}>Status</th>
              <th style={th}>Created</th>
              <th style={{ ...th, textAlign: 'right' }}>Reward</th>
            </tr>
          </thead>
          <tbody>
            {filtered.length === 0 && (
              <tr><td colSpan={6} style={{ padding: '2rem', textAlign: 'center', color: 'var(--text-secondary)' }}>No referrals.</td></tr>
            )}
            {filtered.map((r) => (
              <tr key={r.id} style={{ borderTop: '1px solid var(--border-color)' }}>
                <td style={td}>{r.referrer?.name || `#${r.referrerPatientId}`}</td>
                <td style={td}>{r.referredName}</td>
                <td style={{ ...td, color: 'var(--text-secondary)' }}>{formatPhone(r.referredPhone)}</td>
                <td style={td}>
                  <span style={{
                    padding: '0.15rem 0.5rem',
                    fontSize: '0.7rem',
                    background: statusColor(r.status),
                    color: '#fff',
                    borderRadius: 4,
                    textTransform: 'uppercase',
                    fontWeight: 600,
                  }}>
                    {r.status.replace('_', ' ')}
                  </span>
                </td>
                <td style={{ ...td, color: 'var(--text-secondary)' }}>{new Date(r.createdAt).toLocaleDateString('en-IN')}</td>
                <td style={{ ...td, textAlign: 'right' }}>
                  {r.status === 'rewarded' ? (
                    <span style={{ color: 'var(--success-color)', display: 'inline-flex', alignItems: 'center', gap: '0.25rem' }}>
                      <CheckCircle2 size={12} /> {r.rewardPoints} pts
                    </span>
                  ) : (
                    <button onClick={() => reward(r.id)} style={{ padding: '0.3rem 0.6rem', background: 'var(--accent-color)', color: '#fff', border: 'none', borderRadius: 4, cursor: 'pointer', fontSize: '0.75rem', display: 'inline-flex', alignItems: 'center', gap: '0.25rem' }}>
                      <Gift size={11} /> Reward
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function statusColor(s) {
  return ({
    pending: 'var(--text-tertiary)',
    signed_up: 'var(--accent-color)',
    first_visit: 'var(--primary-color)',
    rewarded: 'var(--success-color)',
  })[s] || 'var(--text-tertiary)';
}

const inputStyle = {
  width: '100%',
  padding: '0.5rem 0.75rem',
  background: 'var(--surface-color)',
  border: '1px solid var(--border-color)',
  borderRadius: 8,
  color: 'var(--text-primary)',
  fontSize: '0.9rem',
  outline: 'none',
  boxSizing: 'border-box',
};

const th = {
  padding: '0.6rem 1rem',
  textAlign: 'left',
  fontSize: '0.7rem',
  fontWeight: 600,
  textTransform: 'uppercase',
  letterSpacing: '0.05em',
  color: 'var(--text-secondary)',
  background: 'rgba(38,88,85,0.05)',
};

const td = {
  padding: '0.55rem 1rem',
  fontSize: '0.85rem',
};
