// Wave 2 Agent JJ — Leave Management page (Google Doc audit, 8 May 2026).
//
// Layout:
//   - Top: balance summary cards per active LeavePolicy
//   - Middle: request submission form (start/end date + policy + reason)
//   - Bottom: history table with status chips. Manager+ sees Approve/Reject
//     buttons inline on PENDING rows. Owner sees a Cancel button on their
//     own PENDING rows.
//
// Uses /api/leave/* endpoints. Cross-vertical (mounted under wellness sidebar
// at /wellness/leave; the page itself doesn't gate on tenant).
import { useEffect, useState, useContext } from 'react';
import { Calendar, CheckCircle2, XCircle, Send, Clock as ClockIcon } from 'lucide-react';
import { fetchApi } from '../../utils/api';
import { useNotify } from '../../utils/notify';
import { AuthContext } from '../../App';
import { DateRangeFilter, resolveDateRange, EMPTY_DATE_FILTER } from '../../components/wellness/DateRangeFilter';

function fmtDate(s) {
  if (!s) return '—';
  return new Date(s).toLocaleDateString();
}

function statusChip(s) {
  const map = {
    PENDING:   { label: 'Pending',   color: '#a36b00', bg: '#fff5dc' },
    APPROVED:  { label: 'Approved',  color: '#0a9050', bg: '#e7f6ed' },
    REJECTED:  { label: 'Rejected',  color: '#a01a1a', bg: '#fde7e7' },
    CANCELLED: { label: 'Cancelled', color: '#666',    bg: '#eee' },
  };
  const m = map[s] || { label: s, color: '#444', bg: '#eee' };
  return (
    <span style={{ background: m.bg, color: m.color, padding: '2px 8px', borderRadius: 4, fontSize: 12, fontWeight: 600 }}>
      {m.label}
    </span>
  );
}

const EMPTY_FORM = { policyId: '', startDate: '', endDate: '', reason: '' };

export default function Leave() {
  const notify = useNotify();
  const { user } = useContext(AuthContext) || {};
  const isManager = user?.role === 'ADMIN' || user?.role === 'MANAGER';

  const [policies, setPolicies] = useState([]);
  const [balances, setBalances] = useState([]);
  const [requests, setRequests] = useState([]);
  const [dateFilter, setDateFilter] = useState(EMPTY_DATE_FILTER);
  const [rangeStart, rangeEnd] = resolveDateRange(dateFilter);
  // Filter by leave start date — matches the natural mental model "show me
  // leaves that begin in this window."
  const visibleRequests = (rangeStart && rangeEnd)
    ? requests.filter((r) => {
        if (!r.startDate) return false;
        const ts = new Date(r.startDate).getTime();
        return ts >= rangeStart.getTime() && ts <= rangeEnd.getTime();
      })
    : requests;
  const [form, setForm] = useState(EMPTY_FORM);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);

  const load = () => {
    setLoading(true);
    Promise.all([
      fetchApi('/api/leave/policies').catch(() => []),
      fetchApi('/api/leave/balances/me').catch(() => []),
      fetchApi('/api/leave/requests').catch(() => []),
    ])
      .then(([pol, bal, req]) => {
        setPolicies(Array.isArray(pol) ? pol : []);
        setBalances(Array.isArray(bal) ? bal : []);
        setRequests(Array.isArray(req) ? req : []);
      })
      .finally(() => setLoading(false));
  };
  useEffect(load, []);

  const onSubmit = async (e) => {
    e.preventDefault();
    if (!form.policyId || !form.startDate || !form.endDate) {
      notify.error('Policy, start date, and end date are required');
      return;
    }
    setBusy(true);
    try {
      await fetchApi('/api/leave/requests', {
        method: 'POST',
        body: JSON.stringify({
          policyId: parseInt(form.policyId),
          startDate: form.startDate,
          endDate: form.endDate,
          reason: form.reason || null,
        }),
      });
      notify.success('Leave request submitted');
      setForm(EMPTY_FORM);
      load();
    } catch (err) {
      const msg = err && err.body && err.body.error;
      notify.error(msg || 'Submit failed');
    } finally {
      setBusy(false);
    }
  };

  const onApprove = async (id) => {
    if (!confirm('Approve this leave request?')) return;
    try {
      await fetchApi(`/api/leave/requests/${id}/approve`, { method: 'POST', body: JSON.stringify({}) });
      notify.success('Approved');
      load();
    } catch (err) {
      notify.error((err && err.body && err.body.error) || 'Approve failed');
    }
  };

  const onReject = async (id) => {
    const notes = prompt('Reason for rejection?') || '';
    try {
      await fetchApi(`/api/leave/requests/${id}/reject`, { method: 'POST', body: JSON.stringify({ notes }) });
      notify.success('Rejected');
      load();
    } catch (err) {
      notify.error((err && err.body && err.body.error) || 'Reject failed');
    }
  };

  const onCancel = async (id) => {
    if (!confirm('Cancel this leave request?')) return;
    try {
      await fetchApi(`/api/leave/requests/${id}/cancel`, { method: 'POST', body: JSON.stringify({}) });
      notify.success('Cancelled');
      load();
    } catch (err) {
      notify.error((err && err.body && err.body.error) || 'Cancel failed');
    }
  };

  return (
    <div style={{ padding: 24, maxWidth: 1100, margin: '0 auto' }}>
      <h1 style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 20 }}>
        <Calendar size={28} aria-hidden /> Leave Management
      </h1>

      {/* Balances */}
      <section style={{ marginBottom: 24 }}>
        <h2 style={{ marginTop: 0 }}>My Balances</h2>
        {loading ? (
          <div>Loading&hellip;</div>
        ) : balances.length === 0 ? (
          <div style={{ color: 'var(--text-secondary, #888)' }}>No active leave policies. Ask your admin to set one up.</div>
        ) : (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 220px), 1fr))', gap: 12 }}>
            {balances.map((b) => (
              <div key={b.policy.id} style={{ background: 'var(--surface-color, #fff)', borderRadius: 12, padding: 16, boxShadow: '0 1px 4px rgba(0,0,0,0.06)' }}>
                <div style={{ fontSize: 14, fontWeight: 600 }}>{b.policy.name}</div>
                <div style={{ fontSize: 11, color: 'var(--text-secondary, #888)', marginBottom: 8 }}>{b.policy.leaveType}</div>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13 }}>
                  <span>Available</span>
                  <strong>{b.balance.available} d</strong>
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13 }}>
                  <span>Used</span>
                  <strong>{b.balance.used} d</strong>
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13 }}>
                  <span>Pending</span>
                  <strong>{b.balance.pending} d</strong>
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, color: 'var(--text-secondary, #888)' }}>
                  <span>Entitled</span>
                  <span>{b.balance.entitled} d / yr</span>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* Request form */}
      <section style={{ background: 'var(--surface-color, #fff)', borderRadius: 12, padding: 24, boxShadow: '0 1px 4px rgba(0,0,0,0.06)', marginBottom: 24 }}>
        <h2 style={{ marginTop: 0, display: 'flex', alignItems: 'center', gap: 8 }}>
          <Send size={20} aria-hidden /> Request Leave
        </h2>
        <form onSubmit={onSubmit}>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 200px), 1fr))', gap: 12 }}>
            <div>
              <label style={{ fontSize: 12, color: 'var(--text-secondary, #888)' }}>Policy</label>
              <select
                value={form.policyId}
                onChange={(e) => setForm({ ...form, policyId: e.target.value })}
                style={{ width: '100%', padding: 8 }}
                aria-label="Leave policy"
              >
                <option value="">— select —</option>
                {policies.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name} ({p.leaveType})
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label style={{ fontSize: 12, color: 'var(--text-secondary, #888)' }}>Start date</label>
              <input
                type="date"
                value={form.startDate}
                onChange={(e) => setForm({ ...form, startDate: e.target.value })}
                style={{ width: '100%', padding: 8 }}
                aria-label="Start date"
              />
            </div>
            <div>
              <label style={{ fontSize: 12, color: 'var(--text-secondary, #888)' }}>End date</label>
              <input
                type="date"
                value={form.endDate}
                onChange={(e) => setForm({ ...form, endDate: e.target.value })}
                style={{ width: '100%', padding: 8 }}
                aria-label="End date"
              />
            </div>
          </div>
          <div style={{ marginTop: 12 }}>
            <label style={{ fontSize: 12, color: 'var(--text-secondary, #888)' }}>Reason (optional)</label>
            <textarea
              value={form.reason}
              onChange={(e) => setForm({ ...form, reason: e.target.value })}
              rows={3}
              style={{ width: '100%', padding: 8 }}
              aria-label="Reason"
            />
          </div>
          <button
            type="submit"
            disabled={busy}
            style={{
              marginTop: 12, padding: '10px 24px', fontSize: 14, fontWeight: 600,
              background: 'var(--primary-color, var(--accent-color))', color: '#fff',
              border: 'none', borderRadius: 6, cursor: busy ? 'not-allowed' : 'pointer',
            }}
            aria-label="Submit leave request"
          >
            {busy ? 'Submitting…' : 'Submit Request'}
          </button>
        </form>
      </section>

      {/* History */}
      <section style={{ background: 'var(--surface-color, #fff)', borderRadius: 12, padding: 24, boxShadow: '0 1px 4px rgba(0,0,0,0.06)' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '0.5rem', marginBottom: 12 }}>
          <h2 style={{ margin: 0, display: 'flex', alignItems: 'center', gap: 8 }}>
            <ClockIcon size={20} aria-hidden /> {isManager ? 'All Leave Requests' : 'My Leave Requests'}
          </h2>
          {requests.length > 0 && (
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap' }}>
              <DateRangeFilter value={dateFilter} onChange={setDateFilter} label="Filter by start date" />
              {visibleRequests.length !== requests.length && (
                <span style={{ fontSize: '0.75rem', color: 'var(--text-secondary, #888)' }}>
                  {visibleRequests.length} of {requests.length}
                </span>
              )}
            </div>
          )}
        </div>
        {requests.length === 0 ? (
          <div style={{ color: 'var(--text-secondary, #888)' }}>No requests yet.</div>
        ) : visibleRequests.length === 0 ? (
          <div style={{ color: 'var(--text-secondary, #888)' }}>No requests in the selected range.</div>
        ) : (
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr>
                {isManager && <th style={{ textAlign: 'left', padding: 8, borderBottom: '1px solid var(--border-color, #eee)' }}>User</th>}
                <th style={{ textAlign: 'left', padding: 8, borderBottom: '1px solid var(--border-color, #eee)' }}>Policy</th>
                <th style={{ textAlign: 'left', padding: 8, borderBottom: '1px solid var(--border-color, #eee)' }}>Start</th>
                <th style={{ textAlign: 'left', padding: 8, borderBottom: '1px solid var(--border-color, #eee)' }}>End</th>
                <th style={{ textAlign: 'left', padding: 8, borderBottom: '1px solid var(--border-color, #eee)' }}>Days</th>
                <th style={{ textAlign: 'left', padding: 8, borderBottom: '1px solid var(--border-color, #eee)' }}>Status</th>
                <th style={{ textAlign: 'left', padding: 8, borderBottom: '1px solid var(--border-color, #eee)' }}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {visibleRequests.map((r) => (
                <tr key={r.id}>
                  {isManager && <td style={{ padding: 8, borderBottom: '1px solid var(--border-light, #f5f5f5)' }}>User #{r.userId}</td>}
                  <td style={{ padding: 8, borderBottom: '1px solid var(--border-light, #f5f5f5)' }}>{r.policy?.name || `#${r.policyId}`}</td>
                  <td style={{ padding: 8, borderBottom: '1px solid var(--border-light, #f5f5f5)' }}>{fmtDate(r.startDate)}</td>
                  <td style={{ padding: 8, borderBottom: '1px solid var(--border-light, #f5f5f5)' }}>{fmtDate(r.endDate)}</td>
                  <td style={{ padding: 8, borderBottom: '1px solid var(--border-light, #f5f5f5)' }}>{r.days}</td>
                  <td style={{ padding: 8, borderBottom: '1px solid var(--border-light, #f5f5f5)' }}>{statusChip(r.status)}</td>
                  <td style={{ padding: 8, borderBottom: '1px solid var(--border-light, #f5f5f5)' }}>
                    {r.status === 'PENDING' && isManager && (
                      <>
                        <button
                          type="button"
                          onClick={() => onApprove(r.id)}
                          aria-label="Approve request"
                          style={{ background: '#0a9050', color: '#fff', border: 'none', borderRadius: 4, padding: '4px 10px', marginRight: 6, cursor: 'pointer' }}
                        >
                          <CheckCircle2 size={14} aria-hidden /> Approve
                        </button>
                        <button
                          type="button"
                          onClick={() => onReject(r.id)}
                          aria-label="Reject request"
                          style={{ background: '#a01a1a', color: '#fff', border: 'none', borderRadius: 4, padding: '4px 10px', cursor: 'pointer' }}
                        >
                          <XCircle size={14} aria-hidden /> Reject
                        </button>
                      </>
                    )}
                    {r.status === 'PENDING' && r.userId === user?.id && (
                      <button
                        type="button"
                        onClick={() => onCancel(r.id)}
                        aria-label="Cancel request"
                        style={{ background: '#666', color: '#fff', border: 'none', borderRadius: 4, padding: '4px 10px', cursor: 'pointer' }}
                      >
                        Cancel
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}
