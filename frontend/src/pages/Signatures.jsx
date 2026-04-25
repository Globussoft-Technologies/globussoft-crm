import React, { useState, useEffect } from 'react';
import { FileSignature, Plus, Send, Eye, X, Check } from 'lucide-react';
import { fetchApi } from '../utils/api';
import { useNotify } from '../utils/notify';

const STATUS_STYLES = {
  PENDING:  { bg: 'rgba(245,158,11,0.12)', color: '#f59e0b', border: 'rgba(245,158,11,0.3)' },
  SIGNED:   { bg: 'rgba(16,185,129,0.12)', color: '#10b981', border: 'rgba(16,185,129,0.3)' },
  DECLINED: { bg: 'rgba(239,68,68,0.12)',  color: '#ef4444', border: 'rgba(239,68,68,0.3)' },
  EXPIRED:  { bg: 'rgba(100,116,139,0.12)', color: '#94a3b8', border: 'rgba(100,116,139,0.3)' },
};

function StatusBadge({ status }) {
  const cfg = STATUS_STYLES[status] || STATUS_STYLES.PENDING;
  return (
    <span style={{
      padding: '0.2rem 0.65rem', borderRadius: '999px', fontSize: '0.72rem',
      fontWeight: 'bold', backgroundColor: cfg.bg, color: cfg.color,
      border: `1px solid ${cfg.border}`,
    }}>
      {status}
    </span>
  );
}

const EMPTY_FORM = {
  documentType: 'Contract',
  documentId: '',
  signerName: '',
  signerEmail: '',
  expiresInDays: 7,
};

const ENDPOINT_FOR_TYPE = {
  Contract: '/api/contracts',
  Estimate: '/api/estimates',
  Quote: '/api/quotes',
};

export default function Signatures() {
  const notify = useNotify();
  const [requests, setRequests] = useState([]);
  const [docOptions, setDocOptions] = useState([]);
  const [form, setForm] = useState(EMPTY_FORM);
  const [showCreate, setShowCreate] = useState(false);
  const [viewing, setViewing] = useState(null);
  const [details, setDetails] = useState(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => { loadRequests(); }, []);
  useEffect(() => { loadDocOptions(form.documentType); }, [form.documentType]);

  const loadRequests = async () => {
    try {
      const data = await fetchApi('/api/signatures');
      setRequests(Array.isArray(data) ? data : []);
    } catch (err) { console.error(err); }
  };

  const loadDocOptions = async (docType) => {
    const endpoint = ENDPOINT_FOR_TYPE[docType];
    if (!endpoint) { setDocOptions([]); return; }
    try {
      const data = await fetchApi(endpoint);
      setDocOptions(Array.isArray(data) ? data : []);
    } catch (err) { setDocOptions([]); }
  };

  const docLabel = (d, type) => {
    if (!d) return `#${d?.id ?? ''}`;
    if (type === 'Quote')    return d.title || `Quote #${d.id}`;
    if (type === 'Estimate') return d.title || d.estimateNum || `Estimate #${d.id}`;
    return d.title || `Contract #${d.id}`;
  };

  const submitCreate = async (e) => {
    e.preventDefault();
    if (!form.documentId) return notify.error('Pick a document to send for signature');
    setLoading(true);
    try {
      await fetchApi('/api/signatures', {
        method: 'POST',
        body: JSON.stringify({
          ...form,
          documentId: parseInt(form.documentId),
          expiresInDays: parseInt(form.expiresInDays) || 7,
        }),
      });
      setForm(EMPTY_FORM);
      setShowCreate(false);
      loadRequests();
    } catch (err) {
      notify.error('Failed to create signature request');
    } finally {
      setLoading(false);
    }
  };

  const resend = async (id) => {
    try {
      await fetchApi(`/api/signatures/${id}/resend`, { method: 'POST' });
      notify.success('Reminder email sent');
    } catch (err) {
      notify.error('Failed to resend signature request');
    }
  };

  const cancel = async (id) => {
    if (!await notify.confirm('Cancel this signature request? This cannot be undone.')) return;
    try {
      await fetchApi(`/api/signatures/${id}`, { method: 'DELETE' });
      loadRequests();
    } catch (err) {
      notify.error('Failed to cancel request');
    }
  };

  const view = async (req) => {
    setViewing(req);
    setDetails(null);
    try {
      const data = await fetchApi(`/api/signatures/${req.id}`);
      setDetails(data);
    } catch (err) { /* swallow */ }
  };

  const counts = {
    pending:  requests.filter(r => r.status === 'PENDING').length,
    signed:   requests.filter(r => r.status === 'SIGNED').length,
    declined: requests.filter(r => r.status === 'DECLINED').length,
    expired:  requests.filter(r => r.status === 'EXPIRED').length,
  };

  return (
    <div style={{ padding: '2rem', height: '100%', overflowY: 'auto', animation: 'fadeIn 0.5s ease-out' }}>
      <header style={{ marginBottom: '2rem', display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: '1rem', flexWrap: 'wrap' }}>
        <div>
          <h1 style={{ fontSize: '2rem', fontWeight: 'bold', display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
            <FileSignature size={26} color="var(--accent-color)" /> E-Signature Requests
          </h1>
          <p style={{ color: 'var(--text-secondary)', marginTop: '0.25rem' }}>
            Send documents for secure electronic signature with tokenized email links.
          </p>
        </div>
        <button
          onClick={() => setShowCreate(true)}
          className="btn-primary"
          style={{ padding: '0.7rem 1.2rem', display: 'flex', alignItems: 'center', gap: '0.5rem' }}
        >
          <Plus size={16} /> Request Signature
        </button>
      </header>

      {/* Stats */}
      <div style={{ display: 'flex', gap: '0.75rem', marginBottom: '1.75rem', flexWrap: 'wrap' }}>
        {[
          ['PENDING',  counts.pending],
          ['SIGNED',   counts.signed],
          ['DECLINED', counts.declined],
          ['EXPIRED',  counts.expired],
        ].map(([label, n]) => {
          const cfg = STATUS_STYLES[label];
          return (
            <span key={label} style={{
              padding: '0.4rem 1rem', borderRadius: '999px', fontSize: '0.8rem', fontWeight: '600',
              background: cfg.bg, color: cfg.color, border: `1px solid ${cfg.border}`,
            }}>
              {n} {label}
            </span>
          );
        })}
      </div>

      {/* Requests Table */}
      <div className="card" style={{ padding: '2rem' }}>
        <h3 style={{ fontSize: '1.15rem', fontWeight: '600', marginBottom: '1.5rem', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
          <FileSignature size={20} color="var(--accent-color)" /> All Signature Requests
        </h3>

        {requests.length === 0 ? (
          <div style={{ textAlign: 'center', padding: '4rem 2rem', background: 'var(--subtle-bg-2)', border: '1px dashed var(--border-color)', borderRadius: '8px' }}>
            <FileSignature size={48} style={{ opacity: 0.2, margin: '0 auto 1rem', color: 'var(--accent-color)' }} />
            <p style={{ color: 'var(--text-secondary)' }}>No signature requests yet. Send your first one to get started.</p>
          </div>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.875rem' }}>
              <thead>
                <tr style={{ borderBottom: '1px solid var(--border-color)', textAlign: 'left' }}>
                  <th style={{ padding: '0.75rem 0.5rem', color: 'var(--text-secondary)', fontWeight: '600' }}>Document</th>
                  <th style={{ padding: '0.75rem 0.5rem', color: 'var(--text-secondary)', fontWeight: '600' }}>Signer</th>
                  <th style={{ padding: '0.75rem 0.5rem', color: 'var(--text-secondary)', fontWeight: '600' }}>Email</th>
                  <th style={{ padding: '0.75rem 0.5rem', color: 'var(--text-secondary)', fontWeight: '600' }}>Status</th>
                  <th style={{ padding: '0.75rem 0.5rem', color: 'var(--text-secondary)', fontWeight: '600' }}>Sent</th>
                  <th style={{ padding: '0.75rem 0.5rem', color: 'var(--text-secondary)', fontWeight: '600' }}>Signed</th>
                  <th style={{ padding: '0.75rem 0.5rem', color: 'var(--text-secondary)', fontWeight: '600' }}>Actions</th>
                </tr>
              </thead>
              <tbody>
                {requests.map(r => (
                  <tr key={r.id} style={{ borderBottom: '1px solid var(--border-color)' }}
                    onMouseOver={e => e.currentTarget.style.background = 'var(--subtle-bg-2)'}
                    onMouseOut={e => e.currentTarget.style.background = 'transparent'}
                  >
                    <td style={{ padding: '0.85rem 0.5rem', fontWeight: '600' }}>
                      {r.documentType} #{r.documentId}
                    </td>
                    <td style={{ padding: '0.85rem 0.5rem' }}>{r.signerName}</td>
                    <td style={{ padding: '0.85rem 0.5rem', color: 'var(--text-secondary)' }}>{r.signerEmail}</td>
                    <td style={{ padding: '0.85rem 0.5rem' }}><StatusBadge status={r.status} /></td>
                    <td style={{ padding: '0.85rem 0.5rem', color: 'var(--text-secondary)', fontSize: '0.8rem' }}>
                      {r.createdAt ? new Date(r.createdAt).toLocaleDateString() : '—'}
                    </td>
                    <td style={{ padding: '0.85rem 0.5rem', color: 'var(--text-secondary)', fontSize: '0.8rem' }}>
                      {r.signedAt ? new Date(r.signedAt).toLocaleDateString() : '—'}
                    </td>
                    <td style={{ padding: '0.85rem 0.5rem' }}>
                      <div style={{ display: 'flex', gap: '0.4rem', flexWrap: 'wrap' }}>
                        <button
                          onClick={() => view(r)}
                          style={{
                            padding: '0.35rem 0.65rem', fontSize: '0.75rem',
                            background: 'transparent', color: 'var(--accent-color)',
                            border: '1px solid var(--border-color)', borderRadius: '6px',
                            cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '0.25rem',
                          }}
                        >
                          <Eye size={12} /> View
                        </button>
                        {r.status === 'PENDING' && (
                          <button
                            onClick={() => resend(r.id)}
                            style={{
                              padding: '0.35rem 0.65rem', fontSize: '0.75rem',
                              background: 'transparent', color: '#3b82f6',
                              border: '1px solid rgba(59,130,246,0.3)', borderRadius: '6px',
                              cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '0.25rem',
                            }}
                          >
                            <Send size={12} /> Resend
                          </button>
                        )}
                        {r.status !== 'SIGNED' && (
                          <button
                            onClick={() => cancel(r.id)}
                            style={{
                              padding: '0.35rem 0.65rem', fontSize: '0.75rem',
                              background: 'transparent', color: '#ef4444',
                              border: '1px solid rgba(239,68,68,0.3)', borderRadius: '6px',
                              cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '0.25rem',
                            }}
                          >
                            <X size={12} /> Cancel
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Create Modal */}
      {showCreate && (
        <Modal onClose={() => setShowCreate(false)} title="Request Signature" icon={<Plus size={20} color="var(--accent-color)" />}>
          <form onSubmit={submitCreate} style={{ display: 'flex', flexDirection: 'column', gap: '1.1rem' }}>
            <Field label="Document Type">
              <select
                className="input-field"
                value={form.documentType}
                onChange={e => setForm({ ...form, documentType: e.target.value, documentId: '' })}
                style={{ background: 'var(--input-bg)' }}
              >
                <option value="Contract">Contract</option>
                <option value="Estimate">Estimate</option>
                <option value="Quote">Quote</option>
              </select>
            </Field>

            <Field label="Document">
              <select
                required
                className="input-field"
                value={form.documentId}
                onChange={e => setForm({ ...form, documentId: e.target.value })}
                style={{ background: 'var(--input-bg)' }}
              >
                <option value="">-- Select {form.documentType} --</option>
                {docOptions.map(d => (
                  <option key={d.id} value={d.id}>{docLabel(d, form.documentType)}</option>
                ))}
              </select>
            </Field>

            <Field label="Signer Name">
              <input
                type="text" required className="input-field" placeholder="Jane Doe"
                value={form.signerName}
                onChange={e => setForm({ ...form, signerName: e.target.value })}
              />
            </Field>

            <Field label="Signer Email">
              <input
                type="email" required className="input-field" placeholder="jane@example.com"
                value={form.signerEmail}
                onChange={e => setForm({ ...form, signerEmail: e.target.value })}
              />
            </Field>

            <Field label="Expires In (days)">
              <input
                type="number" min="1" max="365" className="input-field"
                value={form.expiresInDays}
                onChange={e => setForm({ ...form, expiresInDays: e.target.value })}
              />
            </Field>

            <button
              type="submit" className="btn-primary"
              disabled={loading}
              style={{ padding: '0.85rem', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '0.5rem' }}
            >
              <Send size={16} /> {loading ? 'Sending...' : 'Send Signature Request'}
            </button>
          </form>
        </Modal>
      )}

      {/* View Modal */}
      {viewing && (
        <Modal onClose={() => { setViewing(null); setDetails(null); }} title={`${viewing.documentType} #${viewing.documentId}`} icon={<Eye size={20} color="var(--accent-color)" />}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem', fontSize: '0.9rem' }}>
            <Row k="Signer" v={viewing.signerName} />
            <Row k="Email" v={viewing.signerEmail} />
            <Row k="Status" v={<StatusBadge status={viewing.status} />} />
            <Row k="Sent" v={viewing.createdAt ? new Date(viewing.createdAt).toLocaleString() : '—'} />
            <Row k="Expires" v={viewing.expiresAt ? new Date(viewing.expiresAt).toLocaleString() : '—'} />
            <Row k="Signed" v={viewing.signedAt ? new Date(viewing.signedAt).toLocaleString() : '—'} />

            {viewing.status === 'SIGNED' && (details?.signature || viewing.signature) && (
              <div style={{ marginTop: '1rem' }}>
                <div style={{ color: 'var(--text-secondary)', fontSize: '0.8rem', marginBottom: '0.4rem', display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
                  <Check size={14} color="#10b981" /> Captured Signature
                </div>
                <div style={{ background: 'var(--surface-color)', borderRadius: '8px', padding: '0.75rem', border: '1px solid var(--border-color)' }}>
                  <img
                    src={details?.signature || viewing.signature}
                    alt="Signature"
                    style={{ maxWidth: '100%', display: 'block', margin: '0 auto' }}
                  />
                </div>
              </div>
            )}
          </div>
        </Modal>
      )}

      <style>{`@keyframes fadeIn { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: none; } }`}</style>
    </div>
  );
}

function Field({ label, children }) {
  return (
    <div>
      <label style={{ display: 'block', fontSize: '0.875rem', marginBottom: '0.4rem', color: 'var(--text-secondary)' }}>
        {label}
      </label>
      {children}
    </div>
  );
}

function Row({ k, v }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', gap: '1rem', padding: '0.4rem 0', borderBottom: '1px solid var(--border-color)' }}>
      <span style={{ color: 'var(--text-secondary)' }}>{k}</span>
      <span style={{ fontWeight: 600, textAlign: 'right' }}>{v}</span>
    </div>
  );
}

function Modal({ onClose, title, icon, children }) {
  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)', backdropFilter: 'blur(6px)',
        display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000, padding: '1rem',
      }}
    >
      <div
        onClick={e => e.stopPropagation()}
        className="card"
        style={{ padding: '2rem', width: '100%', maxWidth: '520px', maxHeight: '90vh', overflowY: 'auto' }}
      >
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '1.25rem' }}>
          <h3 style={{ fontSize: '1.15rem', fontWeight: 600, display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            {icon} {title}
          </h3>
          <button
            onClick={onClose}
            style={{ background: 'transparent', border: 'none', cursor: 'pointer', color: 'var(--text-secondary)' }}
          >
            <X size={20} />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}
