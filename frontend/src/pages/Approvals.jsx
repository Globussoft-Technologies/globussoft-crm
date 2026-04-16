import React, { useState, useEffect, useContext, useMemo } from 'react';
import { fetchApi } from '../utils/api';
import { AuthContext } from '../App';
import { CheckSquare, Check, X, Clock, Plus, Eye, Filter } from 'lucide-react';

const STATUS_CONFIG = {
  PENDING:  { color: '#f59e0b', bg: 'rgba(245,158,11,0.12)', icon: Clock },
  APPROVED: { color: '#10b981', bg: 'rgba(16,185,129,0.12)', icon: Check },
  REJECTED: { color: '#ef4444', bg: 'rgba(239,68,68,0.12)', icon: X },
};

function StatusBadge({ status }) {
  const cfg = STATUS_CONFIG[status] || STATUS_CONFIG.PENDING;
  const Icon = cfg.icon;
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: '0.35rem',
      padding: '0.25rem 0.65rem', borderRadius: '999px',
      fontSize: '0.7rem', fontWeight: 700,
      backgroundColor: cfg.bg, color: cfg.color,
      border: `1px solid ${cfg.color}55`, whiteSpace: 'nowrap',
    }}>
      <Icon size={11} /> {status}
    </span>
  );
}

const EMPTY_NEW = { entity: 'Deal', entityId: '', reason: '' };

export default function Approvals() {
  const { user: ctxUser } = useContext(AuthContext) || {};
  const [me, setMe] = useState(ctxUser || null);
  const [tab, setTab] = useState('my'); // my | toApprove | all
  const [requests, setRequests] = useState([]);
  const [loading, setLoading] = useState(true);
  const [filterStatus, setFilterStatus] = useState('');
  const [filterEntity, setFilterEntity] = useState('');

  // Modals
  const [createOpen, setCreateOpen] = useState(false);
  const [newReq, setNewReq] = useState(EMPTY_NEW);
  const [approveTarget, setApproveTarget] = useState(null);
  const [rejectTarget, setRejectTarget] = useState(null);
  const [viewTarget, setViewTarget] = useState(null);
  const [comment, setComment] = useState('');
  const [submitting, setSubmitting] = useState(false);

  // Fetch profile if not in context (e.g. fresh page load with token only)
  useEffect(() => {
    if (me && me.role) return;
    fetchApi('/api/auth/me').then(setMe).catch(() => {});
  }, [me]);

  const role = me?.role || ctxUser?.role || 'USER';
  const canApprove = role === 'ADMIN' || role === 'MANAGER';
  const isAdmin = role === 'ADMIN';

  // Default tab for non-managers must be "my"
  useEffect(() => {
    if (!canApprove && tab !== 'my') setTab('my');
    if (!isAdmin && tab === 'all') setTab(canApprove ? 'toApprove' : 'my');
  }, [canApprove, isAdmin, tab]);

  const endpointForTab = (t) => {
    if (t === 'toApprove') return '/api/approvals/to-approve';
    if (t === 'my') return '/api/approvals/my-requests';
    return '/api/approvals';
  };

  const loadData = async () => {
    try {
      setLoading(true);
      const params = new URLSearchParams();
      if (filterStatus) params.set('status', filterStatus);
      if (filterEntity) params.set('entity', filterEntity);
      const qs = params.toString();
      const url = endpointForTab(tab) + (qs ? `?${qs}` : '');
      const data = await fetchApi(url);
      setRequests(Array.isArray(data) ? data : []);
    } catch (err) {
      console.error('Failed to load approvals:', err);
      setRequests([]);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { loadData(); /* eslint-disable-next-line */ }, [tab, filterStatus, filterEntity]);

  const submitCreate = async (e) => {
    e.preventDefault();
    if (!newReq.entity.trim() || !newReq.entityId) {
      alert('Entity and Entity ID are required.');
      return;
    }
    try {
      setSubmitting(true);
      await fetchApi('/api/approvals', {
        method: 'POST',
        body: JSON.stringify({
          entity: newReq.entity.trim(),
          entityId: parseInt(newReq.entityId, 10),
          reason: newReq.reason || null,
        }),
      });
      setCreateOpen(false);
      setNewReq(EMPTY_NEW);
      if (tab !== 'my') setTab('my'); else loadData();
    } catch (err) {
      alert(err.message || 'Failed to create request.');
    } finally {
      setSubmitting(false);
    }
  };

  const submitApprove = async () => {
    if (!approveTarget) return;
    try {
      setSubmitting(true);
      await fetchApi(`/api/approvals/${approveTarget.id}/approve`, {
        method: 'POST',
        body: JSON.stringify({ comment: comment || null }),
      });
      setApproveTarget(null);
      setComment('');
      loadData();
    } catch (err) {
      alert(err.message || 'Failed to approve.');
    } finally {
      setSubmitting(false);
    }
  };

  const submitReject = async () => {
    if (!rejectTarget) return;
    if (!comment.trim()) {
      alert('A rejection comment is required.');
      return;
    }
    try {
      setSubmitting(true);
      await fetchApi(`/api/approvals/${rejectTarget.id}/reject`, {
        method: 'POST',
        body: JSON.stringify({ comment }),
      });
      setRejectTarget(null);
      setComment('');
      loadData();
    } catch (err) {
      alert(err.message || 'Failed to reject.');
    } finally {
      setSubmitting(false);
    }
  };

  const entityOptions = useMemo(() => {
    const set = new Set(requests.map((r) => r.entity).filter(Boolean));
    ['Deal', 'Quote', 'Discount', 'Expense'].forEach((e) => set.add(e));
    return Array.from(set).sort();
  }, [requests]);

  const tabBtnStyle = (active) => ({
    padding: '0.55rem 1.1rem',
    borderRadius: '8px 8px 0 0',
    background: active ? 'var(--card-bg, rgba(255,255,255,0.05))' : 'transparent',
    color: active ? 'var(--text-primary)' : 'var(--text-secondary)',
    border: 'none',
    borderBottom: active ? '2px solid var(--accent-color, #6366f1)' : '2px solid transparent',
    fontWeight: active ? 700 : 500,
    fontSize: '0.875rem',
    cursor: 'pointer',
    transition: 'all 0.2s',
  });

  return (
    <div style={{ padding: '2rem', height: '100%', overflowY: 'auto', animation: 'fadeIn 0.4s ease-out' }}>
      {/* ── Header ──────────────────────────────────────────── */}
      <header style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '1.75rem', flexWrap: 'wrap', gap: '1rem' }}>
        <div>
          <h1 style={{ fontSize: '2rem', fontWeight: 'bold', display: 'flex', alignItems: 'center', gap: '0.75rem', margin: 0 }}>
            <CheckSquare size={26} color="var(--accent-color, #6366f1)" /> Approval Requests
          </h1>
          <p style={{ color: 'var(--text-secondary)', marginTop: '0.35rem', margin: '0.35rem 0 0' }}>
            Submit and review approval requests for deals, discounts, quotes, and more.
          </p>
        </div>
        <button
          onClick={() => { setNewReq(EMPTY_NEW); setCreateOpen(true); }}
          className="btn-primary"
          style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}
        >
          <Plus size={16} /> New Request
        </button>
      </header>

      {/* ── Tabs ────────────────────────────────────────────── */}
      <div style={{ display: 'flex', gap: '0.25rem', borderBottom: '1px solid var(--border-color, rgba(255,255,255,0.1))', marginBottom: '1.5rem' }}>
        <button onClick={() => setTab('my')} style={tabBtnStyle(tab === 'my')}>My Requests</button>
        {canApprove && (
          <button onClick={() => setTab('toApprove')} style={tabBtnStyle(tab === 'toApprove')}>
            To Approve
          </button>
        )}
        {isAdmin && (
          <button onClick={() => setTab('all')} style={tabBtnStyle(tab === 'all')}>All</button>
        )}
      </div>

      {/* ── Filters ─────────────────────────────────────────── */}
      <div className="card" style={{ padding: '0.85rem 1rem', marginBottom: '1.25rem', display: 'flex', alignItems: 'center', gap: '1rem', flexWrap: 'wrap' }}>
        <span style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', color: 'var(--text-secondary)', fontSize: '0.8rem' }}>
          <Filter size={14} /> Filters:
        </span>
        <select
          className="input-field"
          value={filterStatus}
          onChange={(e) => setFilterStatus(e.target.value)}
          style={{ padding: '0.4rem 0.6rem', fontSize: '0.8rem', minWidth: '140px' }}
        >
          <option value="">All Statuses</option>
          <option value="PENDING">Pending</option>
          <option value="APPROVED">Approved</option>
          <option value="REJECTED">Rejected</option>
        </select>
        <select
          className="input-field"
          value={filterEntity}
          onChange={(e) => setFilterEntity(e.target.value)}
          style={{ padding: '0.4rem 0.6rem', fontSize: '0.8rem', minWidth: '140px' }}
        >
          <option value="">All Entities</option>
          {entityOptions.map((e) => <option key={e} value={e}>{e}</option>)}
        </select>
        {(filterStatus || filterEntity) && (
          <button
            onClick={() => { setFilterStatus(''); setFilterEntity(''); }}
            className="btn-secondary"
            style={{ padding: '0.35rem 0.75rem', fontSize: '0.75rem' }}
          >
            Clear
          </button>
        )}
        <span style={{ marginLeft: 'auto', color: 'var(--text-secondary)', fontSize: '0.8rem' }}>
          {requests.length} request{requests.length === 1 ? '' : 's'}
        </span>
      </div>

      {/* ── Table ───────────────────────────────────────────── */}
      <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
        {loading ? (
          <div style={{ padding: '3rem', textAlign: 'center', color: 'var(--text-secondary)' }}>Loading approvals...</div>
        ) : requests.length === 0 ? (
          <div style={{ padding: '3rem', textAlign: 'center', color: 'var(--text-secondary)' }}>
            <CheckSquare size={32} style={{ opacity: 0.4, marginBottom: '0.75rem' }} />
            <div>No approval requests found.</div>
          </div>
        ) : (
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.875rem' }}>
            <thead style={{ background: 'rgba(255,255,255,0.03)' }}>
              <tr style={{ textAlign: 'left' }}>
                <Th>Entity</Th>
                <Th>Reason</Th>
                <Th>Requested By</Th>
                <Th>Requested At</Th>
                <Th>Status</Th>
                <Th style={{ textAlign: 'right' }}>Actions</Th>
              </tr>
            </thead>
            <tbody>
              {requests.map((r) => (
                <tr key={r.id} style={{ borderTop: '1px solid var(--border-color, rgba(255,255,255,0.06))' }}>
                  <Td>
                    <span style={{ fontWeight: 600 }}>{r.entity}</span>
                    <span style={{ color: 'var(--text-secondary)' }}> #{r.entityId}</span>
                  </Td>
                  <Td style={{ maxWidth: '320px' }}>
                    <div style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={r.reason || ''}>
                      {r.reason || <span style={{ color: 'var(--text-secondary)' }}>—</span>}
                    </div>
                  </Td>
                  <Td>
                    {r.requester
                      ? (r.requester.name || r.requester.email)
                      : <span style={{ color: 'var(--text-secondary)' }}>User #{r.requestedBy}</span>}
                  </Td>
                  <Td style={{ color: 'var(--text-secondary)', whiteSpace: 'nowrap' }}>
                    {new Date(r.requestedAt).toLocaleString()}
                  </Td>
                  <Td><StatusBadge status={r.status} /></Td>
                  <Td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                    <button
                      onClick={() => setViewTarget(r)}
                      className="btn-secondary"
                      style={{ padding: '0.3rem 0.6rem', fontSize: '0.75rem', marginRight: '0.4rem', display: 'inline-flex', alignItems: 'center', gap: '0.3rem' }}
                    >
                      <Eye size={12} /> View
                    </button>
                    {canApprove && r.status === 'PENDING' && (
                      <>
                        <button
                          onClick={() => { setComment(''); setApproveTarget(r); }}
                          style={{ padding: '0.3rem 0.6rem', fontSize: '0.75rem', marginRight: '0.4rem', display: 'inline-flex', alignItems: 'center', gap: '0.3rem', background: '#10b981', color: '#fff', border: 'none', borderRadius: '6px', cursor: 'pointer' }}
                        >
                          <Check size={12} /> Approve
                        </button>
                        <button
                          onClick={() => { setComment(''); setRejectTarget(r); }}
                          style={{ padding: '0.3rem 0.6rem', fontSize: '0.75rem', display: 'inline-flex', alignItems: 'center', gap: '0.3rem', background: '#ef4444', color: '#fff', border: 'none', borderRadius: '6px', cursor: 'pointer' }}
                        >
                          <X size={12} /> Reject
                        </button>
                      </>
                    )}
                  </Td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* ── Create modal ────────────────────────────────────── */}
      {createOpen && (
        <Modal title="New Approval Request" onClose={() => setCreateOpen(false)}>
          <form onSubmit={submitCreate} style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
            <Field label="Entity Type">
              <select
                className="input-field"
                value={newReq.entity}
                onChange={(e) => setNewReq({ ...newReq, entity: e.target.value })}
                required
              >
                <option value="Deal">Deal</option>
                <option value="Quote">Quote</option>
                <option value="Discount">Discount</option>
                <option value="Expense">Expense</option>
                <option value="Contract">Contract</option>
                <option value="Other">Other</option>
              </select>
            </Field>
            <Field label="Entity ID">
              <input
                type="number"
                min="1"
                className="input-field"
                value={newReq.entityId}
                onChange={(e) => setNewReq({ ...newReq, entityId: e.target.value })}
                placeholder="e.g. 123"
                required
              />
            </Field>
            <Field label="Reason">
              <textarea
                className="input-field"
                rows="4"
                value={newReq.reason}
                onChange={(e) => setNewReq({ ...newReq, reason: e.target.value })}
                placeholder="e.g. 25% discount for enterprise customer"
              />
            </Field>
            <ModalFooter>
              <button type="button" className="btn-secondary" onClick={() => setCreateOpen(false)} disabled={submitting}>Cancel</button>
              <button type="submit" className="btn-primary" disabled={submitting}>
                {submitting ? 'Submitting...' : 'Submit Request'}
              </button>
            </ModalFooter>
          </form>
        </Modal>
      )}

      {/* ── Approve modal ───────────────────────────────────── */}
      {approveTarget && (
        <Modal title={`Approve ${approveTarget.entity} #${approveTarget.entityId}`} onClose={() => setApproveTarget(null)}>
          <p style={{ color: 'var(--text-secondary)', fontSize: '0.875rem', marginTop: 0 }}>
            <strong>Reason:</strong> {approveTarget.reason || '(none)'}
          </p>
          <Field label="Comment (optional)">
            <textarea
              className="input-field"
              rows="4"
              value={comment}
              onChange={(e) => setComment(e.target.value)}
              placeholder="Add an approval note..."
            />
          </Field>
          <ModalFooter>
            <button type="button" className="btn-secondary" onClick={() => setApproveTarget(null)} disabled={submitting}>Cancel</button>
            <button
              onClick={submitApprove}
              disabled={submitting}
              style={{ background: '#10b981', color: '#fff', border: 'none', padding: '0.55rem 1.1rem', borderRadius: '6px', fontWeight: 600, cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: '0.4rem' }}
            >
              <Check size={14} /> {submitting ? 'Approving...' : 'Approve'}
            </button>
          </ModalFooter>
        </Modal>
      )}

      {/* ── Reject modal ────────────────────────────────────── */}
      {rejectTarget && (
        <Modal title={`Reject ${rejectTarget.entity} #${rejectTarget.entityId}`} onClose={() => setRejectTarget(null)}>
          <p style={{ color: 'var(--text-secondary)', fontSize: '0.875rem', marginTop: 0 }}>
            <strong>Reason:</strong> {rejectTarget.reason || '(none)'}
          </p>
          <Field label="Comment (required)">
            <textarea
              className="input-field"
              rows="4"
              value={comment}
              onChange={(e) => setComment(e.target.value)}
              placeholder="Explain why this is being rejected..."
              required
            />
          </Field>
          <ModalFooter>
            <button type="button" className="btn-secondary" onClick={() => setRejectTarget(null)} disabled={submitting}>Cancel</button>
            <button
              onClick={submitReject}
              disabled={submitting || !comment.trim()}
              style={{ background: '#ef4444', color: '#fff', border: 'none', padding: '0.55rem 1.1rem', borderRadius: '6px', fontWeight: 600, cursor: comment.trim() ? 'pointer' : 'not-allowed', opacity: comment.trim() ? 1 : 0.6, display: 'inline-flex', alignItems: 'center', gap: '0.4rem' }}
            >
              <X size={14} /> {submitting ? 'Rejecting...' : 'Reject'}
            </button>
          </ModalFooter>
        </Modal>
      )}

      {/* ── View modal ──────────────────────────────────────── */}
      {viewTarget && (
        <Modal title={`${viewTarget.entity} #${viewTarget.entityId}`} onClose={() => setViewTarget(null)}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.85rem', fontSize: '0.875rem' }}>
            <DetailRow label="Status" value={<StatusBadge status={viewTarget.status} />} />
            <DetailRow label="Reason" value={viewTarget.reason || '—'} />
            <DetailRow
              label="Requested By"
              value={viewTarget.requester ? `${viewTarget.requester.name || viewTarget.requester.email} (${viewTarget.requester.role || 'USER'})` : `User #${viewTarget.requestedBy}`}
            />
            <DetailRow label="Requested At" value={new Date(viewTarget.requestedAt).toLocaleString()} />
            {viewTarget.approvedBy && (
              <>
                <DetailRow
                  label={viewTarget.status === 'APPROVED' ? 'Approved By' : 'Rejected By'}
                  value={viewTarget.approver ? `${viewTarget.approver.name || viewTarget.approver.email}` : `User #${viewTarget.approvedBy}`}
                />
                <DetailRow
                  label={viewTarget.status === 'APPROVED' ? 'Approved At' : 'Rejected At'}
                  value={viewTarget.approvedAt ? new Date(viewTarget.approvedAt).toLocaleString() : '—'}
                />
              </>
            )}
            {viewTarget.comment && <DetailRow label="Comment" value={viewTarget.comment} />}
          </div>
          <ModalFooter>
            <button className="btn-secondary" onClick={() => setViewTarget(null)}>Close</button>
            {canApprove && viewTarget.status === 'PENDING' && (
              <>
                <button
                  onClick={() => { setComment(''); setApproveTarget(viewTarget); setViewTarget(null); }}
                  style={{ background: '#10b981', color: '#fff', border: 'none', padding: '0.55rem 1.1rem', borderRadius: '6px', fontWeight: 600, cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: '0.4rem' }}
                >
                  <Check size={14} /> Approve
                </button>
                <button
                  onClick={() => { setComment(''); setRejectTarget(viewTarget); setViewTarget(null); }}
                  style={{ background: '#ef4444', color: '#fff', border: 'none', padding: '0.55rem 1.1rem', borderRadius: '6px', fontWeight: 600, cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: '0.4rem' }}
                >
                  <X size={14} /> Reject
                </button>
              </>
            )}
          </ModalFooter>
        </Modal>
      )}

      <style>{`
        @keyframes fadeIn { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: none; } }
        @keyframes modalIn { from { opacity: 0; transform: scale(0.96); } to { opacity: 1; transform: scale(1); } }
      `}</style>
    </div>
  );
}

// ── Small presentational helpers ──────────────────────────────────

function Th({ children, style }) {
  return (
    <th style={{
      padding: '0.85rem 1rem',
      fontSize: '0.72rem',
      textTransform: 'uppercase',
      letterSpacing: '0.05em',
      color: 'var(--text-secondary)',
      fontWeight: 600,
      ...(style || {}),
    }}>
      {children}
    </th>
  );
}

function Td({ children, style }) {
  return (
    <td style={{ padding: '0.85rem 1rem', verticalAlign: 'middle', ...(style || {}) }}>
      {children}
    </td>
  );
}

function Field({ label, children }) {
  return (
    <div>
      <label style={{ display: 'block', fontSize: '0.8rem', marginBottom: '0.4rem', color: 'var(--text-secondary)', fontWeight: 500 }}>
        {label}
      </label>
      {children}
    </div>
  );
}

function DetailRow({ label, value }) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '140px 1fr', gap: '1rem', alignItems: 'start' }}>
      <span style={{ color: 'var(--text-secondary)', fontWeight: 500 }}>{label}</span>
      <span style={{ wordBreak: 'break-word' }}>{value}</span>
    </div>
  );
}

function ModalFooter({ children }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '0.6rem', marginTop: '1.5rem' }}>
      {children}
    </div>
  );
}

function Modal({ title, children, onClose }) {
  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed', inset: 0, zIndex: 1000,
        background: 'rgba(0,0,0,0.55)',
        backdropFilter: 'blur(6px)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        padding: '1rem',
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="card"
        style={{
          maxWidth: '520px', width: '100%',
          padding: '1.5rem 1.75rem',
          animation: 'modalIn 0.18s ease-out',
          background: 'var(--card-bg, rgba(20,22,32,0.92))',
          border: '1px solid var(--border-color, rgba(255,255,255,0.1))',
          borderRadius: '12px',
          boxShadow: '0 25px 50px -12px rgba(0,0,0,0.5)',
          maxHeight: '90vh', overflowY: 'auto',
        }}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1.25rem' }}>
          <h3 style={{ margin: 0, fontSize: '1.1rem', fontWeight: 700 }}>{title}</h3>
          <button
            onClick={onClose}
            style={{ background: 'transparent', border: 'none', color: 'var(--text-secondary)', cursor: 'pointer', padding: '0.25rem' }}
            aria-label="Close"
          >
            <X size={18} />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}
