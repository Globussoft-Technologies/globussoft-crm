import React, { useState, useEffect } from 'react';
import { fetchApi } from '../utils/api';
import {
  Database, Camera, Download, Trash2, AlertTriangle, RotateCcw, X, Plus, ShieldAlert,
} from 'lucide-react';

const RED = '#ef4444';
const RED_BG = 'rgba(239,68,68,0.1)';
const RED_BORDER = 'rgba(239,68,68,0.35)';

function formatBytes(n) {
  if (!n && n !== 0) return '—';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(2)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function formatDate(d) {
  if (!d) return '—';
  try {
    return new Date(d).toLocaleString();
  } catch {
    return String(d);
  }
}

function getRole() {
  try {
    const token = localStorage.getItem('token');
    if (!token) return 'USER';
    const payload = JSON.parse(atob(token.split('.')[1]));
    return payload.role || 'USER';
  } catch {
    return 'USER';
  }
}

export default function Sandbox() {
  const role = getRole();
  const isAdmin = role === 'ADMIN';

  const [snapshots, setSnapshots] = useState([]);
  const [loading, setLoading] = useState(false);
  const [showCreate, setShowCreate] = useState(false);
  const [createForm, setCreateForm] = useState({ name: '', description: '' });
  const [creating, setCreating] = useState(false);

  const [restoreTarget, setRestoreTarget] = useState(null); // snapshot obj
  const [restoreConfirmText, setRestoreConfirmText] = useState('');
  const [restoring, setRestoring] = useState(false);

  const [showReset, setShowReset] = useState(false);
  const [resetConfirmText, setResetConfirmText] = useState('');
  const [resetting, setResetting] = useState(false);

  useEffect(() => { load(); }, []);

  const load = async () => {
    setLoading(true);
    try {
      const data = await fetchApi('/api/sandbox');
      setSnapshots(Array.isArray(data) ? data : []);
    } catch (err) {
      console.error(err);
      setSnapshots([]);
    } finally {
      setLoading(false);
    }
  };

  const submitCreate = async (e) => {
    e.preventDefault();
    if (!createForm.name.trim()) return;
    setCreating(true);
    try {
      await fetchApi('/api/sandbox', {
        method: 'POST',
        body: JSON.stringify(createForm),
      });
      setCreateForm({ name: '', description: '' });
      setShowCreate(false);
      await load();
    } catch (err) {
      alert('Failed to create snapshot: ' + (err.message || 'unknown'));
    } finally {
      setCreating(false);
    }
  };

  const handleDownload = async (snap) => {
    try {
      const token = localStorage.getItem('token');
      const resp = await fetch(`/api/sandbox/${snap.id}/download`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!resp.ok) throw new Error('Download failed');
      const blob = await resp.blob();
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `sandbox_${(snap.name || 'snapshot').replace(/[^a-z0-9_\-]/gi, '_')}_${snap.id}.json`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      window.URL.revokeObjectURL(url);
    } catch (err) {
      alert('Download failed: ' + (err.message || 'unknown'));
    }
  };

  const handleDelete = async (snap) => {
    if (!window.confirm(`Permanently delete snapshot "${snap.name}"? This cannot be undone.`)) return;
    try {
      await fetchApi(`/api/sandbox/${snap.id}`, { method: 'DELETE' });
      await load();
    } catch (err) {
      alert('Delete failed: ' + (err.message || 'unknown'));
    }
  };

  const handleRestore = async () => {
    if (restoreConfirmText !== 'RESTORE') {
      alert('You must type RESTORE exactly to confirm.');
      return;
    }
    setRestoring(true);
    try {
      const result = await fetchApi(`/api/sandbox/${restoreTarget.id}/restore`, {
        method: 'POST',
      });
      const counts = result.restored || {};
      const summary = Object.entries(counts)
        .map(([k, v]) => `  ${k}: ${v}`)
        .join('\n');
      alert(`Restore complete.\n\nRestored:\n${summary}`);
      setRestoreTarget(null);
      setRestoreConfirmText('');
      await load();
    } catch (err) {
      alert('Restore failed: ' + (err.message || 'unknown'));
    } finally {
      setRestoring(false);
    }
  };

  const handleReset = async () => {
    if (resetConfirmText !== 'DELETE_EVERYTHING') {
      alert('You must type DELETE_EVERYTHING exactly to confirm.');
      return;
    }
    setResetting(true);
    try {
      await fetchApi('/api/sandbox/reset', {
        method: 'POST',
        body: JSON.stringify({ confirm: 'DELETE_EVERYTHING' }),
      });
      alert('All tenant data has been wiped.');
      setShowReset(false);
      setResetConfirmText('');
      await load();
    } catch (err) {
      alert('Reset failed: ' + (err.message || 'unknown'));
    } finally {
      setResetting(false);
    }
  };

  return (
    <div style={{ padding: '2rem', height: '100%', overflowY: 'auto', animation: 'fadeIn 0.5s ease-out' }}>

      {/* Header */}
      <header style={{ marginBottom: '1.5rem', display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '1rem', flexWrap: 'wrap' }}>
        <div>
          <h1 style={{ fontSize: '2rem', fontWeight: 'bold', display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
            <Database size={26} color="var(--accent-color)" /> Sandbox &amp; Snapshots
          </h1>
          <p style={{ color: 'var(--text-secondary)', marginTop: '0.25rem' }}>
            Capture, restore, and reset tenant data safely.
          </p>
        </div>
        <div style={{ display: 'flex', gap: '0.6rem', flexWrap: 'wrap' }}>
          <button
            onClick={() => setShowCreate(true)}
            style={{
              padding: '0.6rem 1.1rem', borderRadius: '8px', cursor: 'pointer',
              background: 'var(--accent-color)', color: '#fff', border: 'none',
              display: 'flex', alignItems: 'center', gap: '0.4rem', fontWeight: 600,
            }}
          >
            <Camera size={16} /> Create Snapshot
          </button>
          {isAdmin && (
            <button
              onClick={() => setShowReset(true)}
              style={{
                padding: '0.6rem 1.1rem', borderRadius: '8px', cursor: 'pointer',
                background: RED, color: '#fff', border: `1px solid ${RED}`,
                display: 'flex', alignItems: 'center', gap: '0.4rem', fontWeight: 600,
              }}
            >
              <ShieldAlert size={16} /> Reset Tenant
            </button>
          )}
        </div>
      </header>

      {/* DANGER warning banner */}
      <div style={{
        padding: '1rem 1.25rem', borderRadius: '12px', marginBottom: '1.5rem',
        background: RED_BG, border: `1px solid ${RED_BORDER}`,
        display: 'flex', gap: '0.75rem', alignItems: 'flex-start',
      }}>
        <AlertTriangle size={22} color={RED} style={{ flexShrink: 0, marginTop: '2px' }} />
        <div>
          <div style={{ color: RED, fontWeight: 700, marginBottom: '0.25rem', fontSize: '0.95rem' }}>
            DANGER: Restoring or resetting will permanently delete current data
          </div>
          <div style={{ color: 'var(--text-secondary)', fontSize: '0.85rem' }}>
            Snapshots capture Contacts, Deals, Activities, Tasks, Invoices, Estimates, Contracts, Quotes,
            Pipelines, and recent Email Messages. Restoring wipes all current tenant data and replaces it
            with the snapshot. Always export important data before performing destructive actions.
          </div>
        </div>
      </div>

      {/* Snapshots Table */}
      <div className="card" style={{ padding: '0', overflow: 'hidden' }}>
        <div style={{
          padding: '1rem 1.25rem', borderBottom: '1px solid var(--border-color)',
          display: 'flex', justifyContent: 'space-between', alignItems: 'center',
        }}>
          <h3 style={{ fontSize: '1.05rem', fontWeight: 600, margin: 0 }}>
            Saved Snapshots ({snapshots.length})
          </h3>
          {!isAdmin && (
            <span style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>
              Restore &amp; delete require ADMIN
            </span>
          )}
        </div>

        {loading ? (
          <div style={{ padding: '2rem', textAlign: 'center', color: 'var(--text-secondary)' }}>
            Loading snapshots...
          </div>
        ) : snapshots.length === 0 ? (
          <div style={{ padding: '3rem 2rem', textAlign: 'center', color: 'var(--text-secondary)' }}>
            <Database size={36} style={{ opacity: 0.4, marginBottom: '0.75rem' }} />
            <div style={{ marginBottom: '0.5rem' }}>No snapshots yet.</div>
            <div style={{ fontSize: '0.85rem' }}>Click <strong>Create Snapshot</strong> above to capture your current tenant data.</div>
          </div>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead>
                <tr style={{ background: 'var(--subtle-bg-4)', textAlign: 'left' }}>
                  <th style={th}>Name</th>
                  <th style={th}>Description</th>
                  <th style={th}>Created</th>
                  <th style={th}>Size</th>
                  <th style={{ ...th, textAlign: 'right' }}>Actions</th>
                </tr>
              </thead>
              <tbody>
                {snapshots.map((s) => (
                  <tr key={s.id} style={{ borderTop: '1px solid var(--border-color)' }}>
                    <td style={td}>
                      <div style={{ fontWeight: 600 }}>{s.name}</div>
                      <div style={{ fontSize: '0.7rem', color: 'var(--text-secondary)' }}>#{s.id}</div>
                    </td>
                    <td style={{ ...td, color: 'var(--text-secondary)', fontSize: '0.85rem', maxWidth: '320px' }}>
                      {s.description || <em style={{ opacity: 0.6 }}>No description</em>}
                    </td>
                    <td style={td}>{formatDate(s.createdAt)}</td>
                    <td style={td}>{formatBytes(s.sizeBytes)}</td>
                    <td style={{ ...td, textAlign: 'right' }}>
                      <div style={{ display: 'flex', gap: '0.4rem', justifyContent: 'flex-end', flexWrap: 'wrap' }}>
                        <button onClick={() => handleDownload(s)} style={btnGhost} title="Download JSON">
                          <Download size={14} /> Download
                        </button>
                        {isAdmin && (
                          <button
                            onClick={() => { setRestoreTarget(s); setRestoreConfirmText(''); }}
                            style={{ ...btnGhost, color: '#f59e0b', borderColor: 'rgba(245,158,11,0.3)' }}
                            title="Restore (DESTRUCTIVE)"
                          >
                            <RotateCcw size={14} /> Restore
                          </button>
                        )}
                        {isAdmin && (
                          <button
                            onClick={() => handleDelete(s)}
                            style={{ ...btnGhost, color: RED, borderColor: RED_BORDER }}
                            title="Delete"
                          >
                            <Trash2 size={14} /> Delete
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

      {/* Create Snapshot Modal */}
      {showCreate && (
        <Modal onClose={() => setShowCreate(false)} title="Create Snapshot" icon={<Camera size={18} color="var(--accent-color)" />}>
          <form onSubmit={submitCreate} style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
            <p style={{ color: 'var(--text-secondary)', fontSize: '0.85rem', margin: 0 }}>
              This will capture a JSON snapshot of your current tenant data: contacts, deals, activities,
              tasks, invoices, estimates, contracts, quotes, pipelines, and recent emails.
            </p>
            <div>
              <label style={label}>Name</label>
              <input
                type="text"
                required
                className="input-field"
                placeholder="e.g. Pre-migration baseline"
                value={createForm.name}
                onChange={(e) => setCreateForm({ ...createForm, name: e.target.value })}
                autoFocus
              />
            </div>
            <div>
              <label style={label}>Description (optional)</label>
              <textarea
                className="input-field"
                rows={3}
                placeholder="What is this snapshot for?"
                value={createForm.description}
                onChange={(e) => setCreateForm({ ...createForm, description: e.target.value })}
              />
            </div>
            <div style={{ display: 'flex', gap: '0.5rem', justifyContent: 'flex-end', marginTop: '0.5rem' }}>
              <button type="button" onClick={() => setShowCreate(false)} style={btnGhost}>Cancel</button>
              <button
                type="submit"
                disabled={creating}
                style={{
                  padding: '0.55rem 1.1rem', borderRadius: '8px', cursor: creating ? 'wait' : 'pointer',
                  background: 'var(--accent-color)', color: '#fff', border: 'none', fontWeight: 600,
                  display: 'flex', alignItems: 'center', gap: '0.4rem',
                }}
              >
                <Plus size={14} /> {creating ? 'Capturing...' : 'Create Snapshot'}
              </button>
            </div>
          </form>
        </Modal>
      )}

      {/* Restore Confirmation Modal */}
      {restoreTarget && (
        <Modal
          onClose={() => { setRestoreTarget(null); setRestoreConfirmText(''); }}
          title="Restore Snapshot"
          icon={<RotateCcw size={18} color={RED} />}
        >
          <div style={{
            padding: '1rem', borderRadius: '8px', background: RED_BG, border: `1px solid ${RED_BORDER}`,
            marginBottom: '1rem',
          }}>
            <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'flex-start' }}>
              <AlertTriangle size={18} color={RED} style={{ flexShrink: 0, marginTop: '2px' }} />
              <div style={{ color: RED, fontSize: '0.85rem', fontWeight: 600 }}>
                This action is DESTRUCTIVE and IRREVERSIBLE.
              </div>
            </div>
            <ul style={{ color: 'var(--text-secondary)', fontSize: '0.8rem', marginTop: '0.5rem', paddingLeft: '1.25rem' }}>
              <li>All current Contacts, Deals, Activities, Tasks, Invoices, Estimates, Contracts, Quotes, Pipelines, and Email Messages for this tenant will be PERMANENTLY DELETED.</li>
              <li>They will be replaced with the data in snapshot <strong>"{restoreTarget.name}"</strong> (#{restoreTarget.id}).</li>
              <li>Other data (users, settings, integrations) is unaffected.</li>
            </ul>
          </div>
          <label style={label}>Type <code style={code}>RESTORE</code> to confirm</label>
          <input
            type="text"
            className="input-field"
            value={restoreConfirmText}
            onChange={(e) => setRestoreConfirmText(e.target.value)}
            placeholder="RESTORE"
            autoFocus
          />
          <div style={{ display: 'flex', gap: '0.5rem', justifyContent: 'flex-end', marginTop: '1.25rem' }}>
            <button onClick={() => { setRestoreTarget(null); setRestoreConfirmText(''); }} style={btnGhost}>Cancel</button>
            <button
              onClick={handleRestore}
              disabled={restoreConfirmText !== 'RESTORE' || restoring}
              style={{
                padding: '0.55rem 1.1rem', borderRadius: '8px',
                cursor: (restoreConfirmText !== 'RESTORE' || restoring) ? 'not-allowed' : 'pointer',
                background: restoreConfirmText === 'RESTORE' ? RED : 'var(--subtle-bg-4)',
                color: '#fff', border: 'none', fontWeight: 600,
                opacity: restoreConfirmText === 'RESTORE' ? 1 : 0.5,
                display: 'flex', alignItems: 'center', gap: '0.4rem',
              }}
            >
              <RotateCcw size={14} /> {restoring ? 'Restoring...' : 'Confirm Restore'}
            </button>
          </div>
        </Modal>
      )}

      {/* Reset Tenant Modal */}
      {showReset && (
        <Modal
          onClose={() => { setShowReset(false); setResetConfirmText(''); }}
          title="Reset Tenant — DELETE ALL DATA"
          icon={<ShieldAlert size={18} color={RED} />}
        >
          <div style={{
            padding: '1rem', borderRadius: '8px', background: RED_BG, border: `1px solid ${RED_BORDER}`,
            marginBottom: '1rem',
          }}>
            <div style={{ color: RED, fontWeight: 700, marginBottom: '0.5rem' }}>
              This will permanently wipe ALL tenant data with NO restore.
            </div>
            <div style={{ color: 'var(--text-secondary)', fontSize: '0.85rem' }}>
              Contacts, Deals, Activities, Tasks, Invoices, Estimates, Contracts, Quotes, Pipelines, and
              Pipeline Stages will be deleted. Snapshots themselves are preserved. Consider creating a
              snapshot first if you may need to recover.
            </div>
          </div>
          <label style={label}>Type <code style={code}>DELETE_EVERYTHING</code> to confirm</label>
          <input
            type="text"
            className="input-field"
            value={resetConfirmText}
            onChange={(e) => setResetConfirmText(e.target.value)}
            placeholder="DELETE_EVERYTHING"
            autoFocus
          />
          <div style={{ display: 'flex', gap: '0.5rem', justifyContent: 'flex-end', marginTop: '1.25rem' }}>
            <button onClick={() => { setShowReset(false); setResetConfirmText(''); }} style={btnGhost}>Cancel</button>
            <button
              onClick={handleReset}
              disabled={resetConfirmText !== 'DELETE_EVERYTHING' || resetting}
              style={{
                padding: '0.55rem 1.1rem', borderRadius: '8px',
                cursor: (resetConfirmText !== 'DELETE_EVERYTHING' || resetting) ? 'not-allowed' : 'pointer',
                background: resetConfirmText === 'DELETE_EVERYTHING' ? RED : 'var(--subtle-bg-4)',
                color: '#fff', border: 'none', fontWeight: 600,
                opacity: resetConfirmText === 'DELETE_EVERYTHING' ? 1 : 0.5,
                display: 'flex', alignItems: 'center', gap: '0.4rem',
              }}
            >
              <Trash2 size={14} /> {resetting ? 'Wiping...' : 'Wipe All Data'}
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}

// ── Reusable Modal ─────────────────────────────────────────────────
function Modal({ children, onClose, title, icon }) {
  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)',
        backdropFilter: 'blur(4px)', display: 'flex', alignItems: 'center',
        justifyContent: 'center', zIndex: 1000, padding: '1rem',
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="card"
        style={{
          width: '100%', maxWidth: '520px', padding: '1.5rem',
          borderRadius: '14px', maxHeight: '90vh', overflowY: 'auto',
        }}
      >
        <div style={{
          display: 'flex', justifyContent: 'space-between', alignItems: 'center',
          marginBottom: '1rem',
        }}>
          <h3 style={{ margin: 0, fontSize: '1.1rem', fontWeight: 600, display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            {icon} {title}
          </h3>
          <button
            onClick={onClose}
            style={{
              background: 'transparent', border: 'none', cursor: 'pointer',
              color: 'var(--text-secondary)', padding: '0.25rem',
            }}
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

// ── Inline styles ──────────────────────────────────────────────────
const th = { padding: '0.75rem 1rem', fontSize: '0.75rem', textTransform: 'uppercase', color: 'var(--text-secondary)', fontWeight: 600 };
const td = { padding: '0.85rem 1rem', fontSize: '0.875rem', color: 'var(--text-primary)' };
const label = { display: 'block', fontSize: '0.8rem', marginBottom: '0.4rem', color: 'var(--text-secondary)', fontWeight: 600 };
const btnGhost = {
  padding: '0.45rem 0.85rem', borderRadius: '6px', cursor: 'pointer',
  background: 'transparent', color: 'var(--text-primary)',
  border: '1px solid var(--border-color)', fontSize: '0.8rem',
  display: 'inline-flex', alignItems: 'center', gap: '0.35rem',
};
const code = {
  padding: '0.1rem 0.4rem', borderRadius: '4px',
  background: 'var(--subtle-bg-4)', fontFamily: 'monospace', fontSize: '0.85rem',
};
