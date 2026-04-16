import React, { useState, useEffect, useMemo } from 'react';
import { Eye, Plus, Copy, ExternalLink, Clock, X, Check, FileText } from 'lucide-react';
import { fetchApi } from '../utils/api';

const VALID_TYPES = ['Quote', 'Estimate', 'Contract', 'Proposal'];

const ENDPOINT_FOR_TYPE = {
  Quote:    '/api/cpq/quotes',
  Estimate: '/api/estimates',
  Contract: '/api/contracts',
  Proposal: '/api/cpq/quotes', // Proposals are stored as Quotes in this CRM
};

const EMPTY_FORM = { documentType: 'Proposal', documentId: '', viewerEmail: '' };

function StatusPill({ viewed }) {
  const cfg = viewed
    ? { bg: 'rgba(16,185,129,0.12)',  color: '#10b981', border: 'rgba(16,185,129,0.3)', label: 'Viewed' }
    : { bg: 'rgba(245,158,11,0.12)',  color: '#f59e0b', border: 'rgba(245,158,11,0.3)', label: 'Pending' };
  return (
    <span style={{
      padding: '0.2rem 0.65rem', borderRadius: '999px', fontSize: '0.72rem',
      fontWeight: 'bold', backgroundColor: cfg.bg, color: cfg.color,
      border: `1px solid ${cfg.border}`,
    }}>
      {cfg.label}
    </span>
  );
}

function formatDuration(secs) {
  if (!secs || secs <= 0) return '—';
  if (secs < 60) return `${secs}s`;
  const m = Math.floor(secs / 60);
  const s = secs % 60;
  return s ? `${m}m ${s}s` : `${m}m`;
}

export default function DocumentTracking() {
  const [views, setViews] = useState([]);
  const [stats, setStats] = useState({ documentsTracked: 0, totalViews: 0, uniqueViewers: 0, avgViewDuration: 0 });
  const [loading, setLoading] = useState(true);
  const [showCreate, setShowCreate] = useState(false);
  const [form, setForm] = useState(EMPTY_FORM);
  const [docOptions, setDocOptions] = useState([]);
  const [creating, setCreating] = useState(false);
  const [generated, setGenerated] = useState(null); // { trackingId, trackingUrl }
  const [copied, setCopied] = useState(false);

  const loadAll = async () => {
    setLoading(true);
    try {
      const [list, st] = await Promise.all([
        fetchApi('/api/document-views'),
        fetchApi('/api/document-views/stats'),
      ]);
      setViews(Array.isArray(list) ? list : []);
      setStats(st || stats);
    } catch (err) {
      console.error('[DocumentTracking] load error:', err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { loadAll(); }, []);

  useEffect(() => {
    if (!showCreate) return;
    const ep = ENDPOINT_FOR_TYPE[form.documentType];
    if (!ep) { setDocOptions([]); return; }
    fetchApi(ep)
      .then(d => setDocOptions(Array.isArray(d) ? d : []))
      .catch(() => setDocOptions([]));
  }, [form.documentType, showCreate]);

  // Group views by document so the table shows one row per document
  const grouped = useMemo(() => {
    const map = new Map();
    for (const v of views) {
      const key = `${v.documentType}:${v.documentId}`;
      if (!map.has(key)) {
        map.set(key, {
          key,
          documentType: v.documentType,
          documentId: v.documentId,
          viewerEmail: v.viewerEmail,
          recipients: 0,
          viewCount: 0,
          firstViewed: null,
          lastViewed: null,
          totalDuration: 0,
          viewers: new Set(),
          createdAt: v.createdAt,
        });
      }
      const row = map.get(key);
      row.recipients += 1;
      if (v.viewedAt) {
        row.viewCount += 1;
        const t = new Date(v.viewedAt).getTime();
        if (!row.firstViewed || t < row.firstViewed) row.firstViewed = t;
        if (!row.lastViewed  || t > row.lastViewed)  row.lastViewed  = t;
        if (v.viewerEmail) row.viewers.add(v.viewerEmail);
        row.totalDuration += v.duration || 0;
      }
      // Carry the most-recent viewerEmail forward
      if (v.viewerEmail && !row.viewerEmail) row.viewerEmail = v.viewerEmail;
    }
    return Array.from(map.values()).sort((a, b) =>
      new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
    );
  }, [views]);

  const docLabel = (d, type) => {
    if (!d) return '';
    if (type === 'Estimate') return d.title || d.estimateNum || `Estimate #${d.id}`;
    if (type === 'Contract') return d.title || `Contract #${d.id}`;
    return d.title || d.name || `${type} #${d.id}`;
  };

  const submitCreate = async (e) => {
    e.preventDefault();
    if (!form.documentId) return alert('Pick a document to track');
    setCreating(true);
    try {
      const result = await fetchApi('/api/document-views/create', {
        method: 'POST',
        body: JSON.stringify({
          documentType: form.documentType,
          documentId: parseInt(form.documentId, 10),
          viewerEmail: form.viewerEmail || null,
        }),
      });
      setGenerated(result);
      loadAll();
    } catch (err) {
      alert('Failed to create tracking link');
    } finally {
      setCreating(false);
    }
  };

  const copyUrl = async (url) => {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      alert('Copy failed — please copy the URL manually.');
    }
  };

  const closeCreate = () => {
    setShowCreate(false);
    setForm(EMPTY_FORM);
    setGenerated(null);
    setCopied(false);
  };

  return (
    <div style={{ padding: '2rem', height: '100%', overflowY: 'auto', animation: 'fadeIn 0.5s ease-out' }}>
      <header style={{ marginBottom: '2rem', display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: '1rem', flexWrap: 'wrap' }}>
        <div>
          <h1 style={{ fontSize: '2rem', fontWeight: 'bold', display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
            <Eye size={26} color="var(--accent-color)" /> Document Tracking
          </h1>
          <p style={{ color: 'var(--text-secondary)', marginTop: '0.25rem' }}>
            Get notified when proposals, quotes, estimates, and contracts are opened by recipients.
          </p>
        </div>
        <button
          onClick={() => setShowCreate(true)}
          className="btn-primary"
          style={{ padding: '0.7rem 1.2rem', display: 'flex', alignItems: 'center', gap: '0.5rem' }}
        >
          <Plus size={16} /> Track New Document
        </button>
      </header>

      {/* Stats Row */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '1rem', marginBottom: '1.75rem' }}>
        <StatCard
          icon={<FileText size={18} />}
          label="Tracked Documents"
          value={stats.documentsTracked}
          color="#3b82f6"
        />
        <StatCard
          icon={<Eye size={18} />}
          label="Total Views"
          value={stats.totalViews}
          color="#10b981"
        />
        <StatCard
          icon={<ExternalLink size={18} />}
          label="Unique Viewers"
          value={stats.uniqueViewers}
          color="#8b5cf6"
        />
        <StatCard
          icon={<Clock size={18} />}
          label="Avg View Duration"
          value={formatDuration(stats.avgViewDuration)}
          color="#f59e0b"
        />
      </div>

      {/* Tracked Documents Table */}
      <div className="card" style={{ padding: '2rem' }}>
        <h3 style={{ fontSize: '1.15rem', fontWeight: '600', marginBottom: '1.5rem', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
          <Eye size={20} color="var(--accent-color)" /> Tracked Documents
        </h3>

        {loading ? (
          <p style={{ textAlign: 'center', padding: '3rem', color: 'var(--text-secondary)' }}>Loading...</p>
        ) : grouped.length === 0 ? (
          <div style={{ textAlign: 'center', padding: '4rem 2rem', background: 'var(--subtle-bg-2)', border: '1px dashed var(--border-color)', borderRadius: '8px' }}>
            <Eye size={48} style={{ opacity: 0.2, margin: '0 auto 1rem', color: 'var(--accent-color)' }} />
            <p style={{ color: 'var(--text-secondary)', marginBottom: '1rem' }}>No tracked documents yet.</p>
            <p style={{ color: 'var(--text-secondary)', fontSize: '0.85rem' }}>
              Click "Track New Document" to generate a unique URL you can paste into proposal emails.
            </p>
          </div>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.875rem' }}>
              <thead>
                <tr style={{ borderBottom: '1px solid var(--border-color)', textAlign: 'left' }}>
                  <Th>Document</Th>
                  <Th>Viewer</Th>
                  <Th>Views</Th>
                  <Th>First Viewed</Th>
                  <Th>Last Viewed</Th>
                  <Th>Duration</Th>
                  <Th>Status</Th>
                </tr>
              </thead>
              <tbody>
                {grouped.map(row => (
                  <tr key={row.key} style={{ borderBottom: '1px solid var(--border-color)' }}
                    onMouseOver={e => e.currentTarget.style.background = 'var(--subtle-bg-2)'}
                    onMouseOut={e => e.currentTarget.style.background = 'transparent'}
                  >
                    <td style={{ padding: '0.85rem 0.5rem', fontWeight: '600' }}>
                      {row.documentType} #{row.documentId}
                    </td>
                    <td style={{ padding: '0.85rem 0.5rem', color: 'var(--text-secondary)' }}>
                      {row.viewerEmail || <span style={{ opacity: 0.5 }}>—</span>}
                    </td>
                    <td style={{ padding: '0.85rem 0.5rem' }}>
                      <span style={{ fontWeight: 600, color: row.viewCount ? '#10b981' : 'var(--text-secondary)' }}>
                        {row.viewCount}
                      </span>
                      <span style={{ color: 'var(--text-secondary)', fontSize: '0.78rem' }}>
                        {' '}/ {row.recipients}
                      </span>
                    </td>
                    <td style={{ padding: '0.85rem 0.5rem', color: 'var(--text-secondary)', fontSize: '0.8rem' }}>
                      {row.firstViewed ? new Date(row.firstViewed).toLocaleString() : '—'}
                    </td>
                    <td style={{ padding: '0.85rem 0.5rem', color: 'var(--text-secondary)', fontSize: '0.8rem' }}>
                      {row.lastViewed ? new Date(row.lastViewed).toLocaleString() : '—'}
                    </td>
                    <td style={{ padding: '0.85rem 0.5rem', color: 'var(--text-secondary)' }}>
                      {formatDuration(row.totalDuration)}
                    </td>
                    <td style={{ padding: '0.85rem 0.5rem' }}>
                      <StatusPill viewed={row.viewCount > 0} />
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
        <Modal onClose={closeCreate} title="Track New Document" icon={<Plus size={20} color="var(--accent-color)" />}>
          {!generated ? (
            <form onSubmit={submitCreate} style={{ display: 'flex', flexDirection: 'column', gap: '1.1rem' }}>
              <Field label="Document Type">
                <select
                  className="input-field"
                  value={form.documentType}
                  onChange={e => setForm({ ...form, documentType: e.target.value, documentId: '' })}
                  style={{ background: 'var(--input-bg)' }}
                >
                  {VALID_TYPES.map(t => <option key={t} value={t}>{t}</option>)}
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
                {docOptions.length === 0 && (
                  <p style={{ fontSize: '0.78rem', color: 'var(--text-secondary)', marginTop: '0.4rem' }}>
                    No {form.documentType.toLowerCase()}s available. You can still enter a numeric ID below.
                  </p>
                )}
              </Field>

              {docOptions.length === 0 && (
                <Field label="Document ID (manual)">
                  <input
                    type="number" min="1" className="input-field"
                    value={form.documentId}
                    onChange={e => setForm({ ...form, documentId: e.target.value })}
                  />
                </Field>
              )}

              <Field label="Recipient Email (optional)">
                <input
                  type="email" className="input-field" placeholder="recipient@example.com"
                  value={form.viewerEmail}
                  onChange={e => setForm({ ...form, viewerEmail: e.target.value })}
                />
              </Field>

              <button
                type="submit" className="btn-primary"
                disabled={creating}
                style={{ padding: '0.85rem', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '0.5rem' }}
              >
                <ExternalLink size={16} /> {creating ? 'Generating...' : 'Generate Tracking URL'}
              </button>
            </form>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
              <div style={{
                padding: '0.75rem 1rem', borderRadius: '8px',
                background: 'rgba(16,185,129,0.08)', border: '1px solid rgba(16,185,129,0.25)',
                color: '#10b981', display: 'flex', alignItems: 'center', gap: '0.5rem', fontSize: '0.875rem',
              }}>
                <Check size={16} /> Tracking URL generated. Paste this into your email.
              </div>

              <div>
                <label style={{ display: 'block', fontSize: '0.875rem', marginBottom: '0.4rem', color: 'var(--text-secondary)' }}>
                  Tracking URL
                </label>
                <div style={{ display: 'flex', gap: '0.5rem' }}>
                  <input
                    readOnly
                    className="input-field"
                    value={generated.trackingUrl}
                    onFocus={e => e.target.select()}
                    style={{ flex: 1, fontFamily: 'monospace', fontSize: '0.8rem' }}
                  />
                  <button
                    type="button"
                    onClick={() => copyUrl(generated.trackingUrl)}
                    className="btn-primary"
                    style={{ padding: '0.6rem 1rem', display: 'flex', alignItems: 'center', gap: '0.4rem', whiteSpace: 'nowrap' }}
                  >
                    {copied ? <Check size={14} /> : <Copy size={14} />}
                    {copied ? 'Copied' : 'Copy URL'}
                  </button>
                </div>
                <p style={{ fontSize: '0.78rem', color: 'var(--text-secondary)', marginTop: '0.5rem' }}>
                  When the recipient opens this link, the view will be recorded along with their IP, user agent, and time spent.
                </p>
              </div>

              <button
                type="button"
                onClick={closeCreate}
                style={{
                  padding: '0.7rem', background: 'transparent', color: 'var(--text-primary)',
                  border: '1px solid var(--border-color)', borderRadius: '8px', cursor: 'pointer',
                }}
              >
                Done
              </button>
            </div>
          )}
        </Modal>
      )}

      <style>{`@keyframes fadeIn { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: none; } }`}</style>
    </div>
  );
}

function StatCard({ icon, label, value, color }) {
  return (
    <div className="card" style={{ padding: '1.25rem', display: 'flex', alignItems: 'center', gap: '1rem' }}>
      <div style={{
        width: 40, height: 40, borderRadius: '10px',
        background: `${color}1f`, color, display: 'flex',
        alignItems: 'center', justifyContent: 'center',
      }}>
        {icon}
      </div>
      <div>
        <div style={{ fontSize: '0.78rem', color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '0.5px' }}>
          {label}
        </div>
        <div style={{ fontSize: '1.5rem', fontWeight: 700 }}>{value}</div>
      </div>
    </div>
  );
}

function Th({ children }) {
  return (
    <th style={{ padding: '0.75rem 0.5rem', color: 'var(--text-secondary)', fontWeight: '600' }}>
      {children}
    </th>
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
        style={{ padding: '2rem', width: '100%', maxWidth: '560px', maxHeight: '90vh', overflowY: 'auto' }}
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
