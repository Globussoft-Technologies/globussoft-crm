/**
 * Blocked WhatsApp Numbers — admin management page.
 *
 * Closes Zylu-Gap #800 (WA-005).
 *
 * Why this file exists
 * --------------------
 * The backend ships per-tenant opt-out rows via /api/whatsapp/opt-outs
 * (POST/GET/DELETE — routes/whatsapp.js:617-738). Until this page landed
 * there was no dedicated UI surface to manage the list — opt-outs could
 * only be created from within a thread, and re-opting a contact back in
 * (which DPDP §11 requires a written reason for) had no surface at all.
 *
 * Surface
 * -------
 *   • List of every opt-out row (phone, reason, captured-at, notes)
 *   • "Add blocked number" — modal that POSTs /opt-outs
 *   • Per-row "Unblock" — modal that collects the required ≥10-char
 *     reason and DELETEs the row. The backend returns 400
 *     REASON_REQUIRED if the reason is missing or too short — the modal
 *     pre-validates client-side so the operator gets immediate feedback.
 *
 * RBAC
 * ----
 * The POST + GET routes are open to ADMIN + MANAGER; the DELETE is
 * ADMIN-only (DPDP / TRAI compliance). The frontend route guard at
 * App.jsx:wellness/whatsapp/blocked-numbers wraps with the same
 * envelope. The Unblock action is hidden for non-admins to avoid the
 * confusing "click, get 403" round-trip.
 *
 * Pairing with Zylu-Gap #796 (All / Unread / Blocked tabs)
 * --------------------------------------------------------
 * The Blocked tab on WhatsAppThreads.jsx renders the same opt-out rows
 * inline; this page is the canonical surface for adding new entries +
 * unblocking. The thread inbox links here via the "Manage blocked
 * numbers" affordance.
 */

import { useEffect, useMemo, useState, useContext } from 'react';
import {
  Ban,
  Plus,
  Trash2,
  Search,
  RefreshCw,
  X,
  AlertTriangle,
  CheckCircle2,
} from 'lucide-react';
import { fetchApi } from '../../utils/api';
import { useNotify } from '../../utils/notify';
import { AuthContext } from '../../App';
import TopScrollSync from '../../components/TopScrollSync';

const VALID_REASONS = [
  { value: 'USER_REQUESTED', label: 'User requested' },
  { value: 'STOP_KEYWORD', label: 'STOP keyword' },
  { value: 'COMPLAINT', label: 'Complaint' },
  { value: 'UNSUBSCRIBE_LINK', label: 'Unsubscribe link' },
];

function formatDate(iso) {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return String(iso);
  }
}

export default function BlockedNumbers() {
  const notify = useNotify();
  const { user } = useContext(AuthContext) || {};
  const isAdmin = user && user.role === 'ADMIN';

  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [q, setQ] = useState('');

  // Add-modal state.
  const [showAdd, setShowAdd] = useState(false);
  const [addPhone, setAddPhone] = useState('');
  const [addReason, setAddReason] = useState('USER_REQUESTED');
  const [addNotes, setAddNotes] = useState('');
  const [submitting, setSubmitting] = useState(false);

  // Unblock-modal state — DPDP §11 requires a written reason.
  const [unblockId, setUnblockId] = useState(null);
  const [unblockReason, setUnblockReason] = useState('');
  const [unblocking, setUnblocking] = useState(false);

  const load = async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({ limit: '100' });
      if (q.trim()) params.set('phone', q.trim());
      const data = await fetchApi(`/api/whatsapp/opt-outs?${params.toString()}`);
      setRows(Array.isArray(data?.optOuts) ? data.optOuts : []);
    } catch (err) {
      notify.error(err.message || 'Failed to load blocked numbers.');
      setRows([]);
    }
    setLoading(false);
  };

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleSearch = (e) => {
    e.preventDefault();
    load();
  };

  const resetAddForm = () => {
    setAddPhone('');
    setAddReason('USER_REQUESTED');
    setAddNotes('');
  };

  const submitAdd = async () => {
    const phone = addPhone.trim();
    if (!phone) {
      notify.error('Phone number is required.');
      return;
    }
    // Light client-side hint — backend uses normalizeToE164 and rejects
    // non-E.164 with a 400, so we don't replicate the full regex here.
    if (!/^[+\d\s()-]{6,}$/.test(phone)) {
      notify.error('Phone number must be a valid E.164 format (e.g. +919876543210).');
      return;
    }
    setSubmitting(true);
    try {
      await fetchApi('/api/whatsapp/opt-outs', {
        method: 'POST',
        body: JSON.stringify({
          contactPhone: phone,
          reason: addReason,
          notes: addNotes.trim() || undefined,
        }),
      });
      notify.success?.(`${phone} added to blocked list.`);
      setShowAdd(false);
      resetAddForm();
      load();
    } catch (err) {
      notify.error(err.message || 'Failed to add blocked number.');
    }
    setSubmitting(false);
  };

  const submitUnblock = async () => {
    if (!unblockId) return;
    const reason = unblockReason.trim();
    if (reason.length < 10) {
      notify.error('Unblock reason must be at least 10 characters (DPDP §11 requirement).');
      return;
    }
    setUnblocking(true);
    try {
      await fetchApi(`/api/whatsapp/opt-outs/${unblockId}`, {
        method: 'DELETE',
        body: JSON.stringify({ reason }),
      });
      notify.success?.('Number unblocked.');
      setUnblockId(null);
      setUnblockReason('');
      load();
    } catch (err) {
      const msg = err?.message || '';
      if (msg.includes('REASON_REQUIRED')) {
        notify.error('Reason is required (min 10 characters).');
      } else {
        notify.error(msg || 'Failed to unblock number.');
      }
    }
    setUnblocking(false);
  };

  const filteredRows = useMemo(() => rows, [rows]);

  return (
    <div style={{ padding: '1.5rem', animation: 'fadeIn 0.4s ease-out' }}>
      <header style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        marginBottom: '1.25rem', gap: 12, flexWrap: 'wrap',
      }}>
        <div>
          <h1 style={{ fontSize: '1.4rem', fontWeight: 700, display: 'flex', alignItems: 'center', gap: 8, margin: 0 }}>
            <Ban size={22} color="var(--primary-color, var(--accent-color))" />
            Blocked WhatsApp Numbers
          </h1>
          <p style={{ color: 'var(--text-secondary)', fontSize: '0.85rem', margin: '4px 0 0' }}>
            Phone numbers that have opted out of WhatsApp messages. Outbound sends to these numbers are
            rejected by the backend (DPDP / TRAI compliance).
          </p>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button
            type="button"
            onClick={load}
            className="btn-secondary"
            style={{ padding: '0.45rem 0.7rem', display: 'flex', alignItems: 'center', gap: 4 }}
            title="Refresh"
          >
            <RefreshCw size={14} /> Refresh
          </button>
          <button
            type="button"
            onClick={() => setShowAdd(true)}
            className="btn-primary"
            data-testid="blocked-add-button"
            style={{ padding: '0.45rem 0.9rem', display: 'flex', alignItems: 'center', gap: 4 }}
          >
            <Plus size={14} /> Add blocked number
          </button>
        </div>
      </header>

      <form onSubmit={handleSearch} style={{ display: 'flex', gap: 8, marginBottom: '1rem', maxWidth: 420 }}>
        <div style={{ flex: 1, position: 'relative' }}>
          <Search size={14} style={{
            position: 'absolute', left: 8, top: '50%', transform: 'translateY(-50%)',
            color: 'var(--text-secondary)',
          }} />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search by phone (E.164 prefix)"
            className="input-field"
            style={{ paddingLeft: 26, fontSize: '0.85rem' }}
            aria-label="Search blocked numbers"
          />
        </div>
        <button type="submit" className="btn-secondary" style={{ padding: '0.45rem 0.9rem' }}>Go</button>
      </form>

      <div style={{ border: '1px solid var(--border-color)', borderRadius: 8, overflow: 'visible' }}>
        {loading ? (
          <p style={{ padding: '2rem', textAlign: 'center', color: 'var(--text-secondary)' }}>Loading…</p>
        ) : filteredRows.length === 0 ? (
          <div style={{ padding: '2.5rem', textAlign: 'center', color: 'var(--text-secondary)' }}>
            <CheckCircle2 size={36} color="#10b981" />
            <p style={{ margin: '0.5rem 0 0', fontSize: '0.9rem' }}>
              No blocked numbers. All contacts can receive WhatsApp messages.
            </p>
          </div>
        ) : (
          <TopScrollSync>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.85rem' }}>
            <thead style={{ background: 'rgba(107,114,128,0.08)' }}>
              <tr>
                <th style={{ padding: '0.6rem 0.8rem', textAlign: 'left', fontWeight: 600 }}>Phone</th>
                <th style={{ padding: '0.6rem 0.8rem', textAlign: 'left', fontWeight: 600 }}>Reason</th>
                <th style={{ padding: '0.6rem 0.8rem', textAlign: 'left', fontWeight: 600 }}>Blocked at</th>
                <th style={{ padding: '0.6rem 0.8rem', textAlign: 'left', fontWeight: 600 }}>Notes</th>
                <th style={{ padding: '0.6rem 0.8rem', textAlign: 'right', fontWeight: 600 }}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {filteredRows.map((r) => (
                <tr
                  key={r.id}
                  data-testid={`blocked-row-${r.id}`}
                  style={{ borderTop: '1px solid var(--border-color)' }}
                >
                  <td style={{ padding: '0.55rem 0.8rem', fontWeight: 600 }}>{r.contactPhone}</td>
                  <td style={{ padding: '0.55rem 0.8rem' }}>
                    <span style={{
                      background: 'rgba(239,68,68,0.10)',
                      color: '#dc2626',
                      padding: '1px 7px',
                      borderRadius: 10,
                      fontSize: '0.7rem',
                      fontWeight: 700,
                    }}>{r.reason || 'BLOCKED'}</span>
                  </td>
                  <td style={{ padding: '0.55rem 0.8rem', color: 'var(--text-secondary)' }}>{formatDate(r.capturedAt)}</td>
                  <td style={{ padding: '0.55rem 0.8rem', color: 'var(--text-secondary)', maxWidth: 240, overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    {r.notes || '—'}
                  </td>
                  <td style={{ padding: '0.55rem 0.8rem', textAlign: 'right' }}>
                    {isAdmin ? (
                      <button
                        type="button"
                        onClick={() => { setUnblockId(r.id); setUnblockReason(''); }}
                        data-testid={`blocked-unblock-${r.id}`}
                        className="btn-secondary"
                        style={{
                          padding: '0.3rem 0.6rem',
                          fontSize: '0.75rem',
                          display: 'inline-flex',
                          alignItems: 'center',
                          gap: 4,
                          color: '#dc2626',
                        }}
                      >
                        <Trash2 size={12} /> Unblock
                      </button>
                    ) : (
                      <span style={{ fontSize: '0.7rem', color: 'var(--text-secondary)' }}>Admin-only</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          </TopScrollSync>
        )}
      </div>

      {/* Add modal */}
      {showAdd && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Add blocked number"
          data-testid="blocked-add-modal"
          style={{
            position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)', zIndex: 1000,
            display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '2rem',
          }}
          onClick={(e) => { if (e.target === e.currentTarget) { setShowAdd(false); resetAddForm(); } }}
        >
          <div style={{
            background: 'var(--card-bg, #1a1a1a)', color: 'var(--text-primary)',
            borderRadius: 12, width: 'min(480px, 100%)',
            border: '1px solid var(--border-color)', overflow: 'hidden',
            display: 'flex', flexDirection: 'column',
          }}>
            <header style={{
              padding: '1rem 1.25rem', borderBottom: '1px solid var(--border-color)',
              display: 'flex', alignItems: 'center', justifyContent: 'space-between',
            }}>
              <h3 style={{ margin: 0, fontSize: '1rem', fontWeight: 700, display: 'flex', alignItems: 'center', gap: 6 }}>
                <Ban size={16} /> Add blocked number
              </h3>
              <button
                onClick={() => { setShowAdd(false); resetAddForm(); }}
                aria-label="Close add modal"
                style={{ background: 'transparent', border: 'none', color: 'var(--text-secondary)', cursor: 'pointer' }}
              >
                <X size={18} />
              </button>
            </header>
            <div style={{ padding: '1rem 1.25rem', display: 'flex', flexDirection: 'column', gap: 12 }}>
              <label style={{ fontSize: '0.8rem', display: 'flex', flexDirection: 'column', gap: 4 }}>
                <span>Phone (E.164)</span>
                <input
                  type="tel"
                  value={addPhone}
                  onChange={(e) => setAddPhone(e.target.value)}
                  placeholder="+919876543210"
                  className="input-field"
                  data-testid="blocked-add-phone"
                  autoFocus
                />
              </label>
              <label style={{ fontSize: '0.8rem', display: 'flex', flexDirection: 'column', gap: 4 }}>
                <span>Reason</span>
                <select
                  value={addReason}
                  onChange={(e) => setAddReason(e.target.value)}
                  className="input-field"
                  data-testid="blocked-add-reason"
                >
                  {VALID_REASONS.map((r) => (
                    <option key={r.value} value={r.value}>{r.label}</option>
                  ))}
                </select>
              </label>
              <label style={{ fontSize: '0.8rem', display: 'flex', flexDirection: 'column', gap: 4 }}>
                <span>Notes (optional)</span>
                <textarea
                  value={addNotes}
                  onChange={(e) => setAddNotes(e.target.value)}
                  rows={2}
                  className="input-field"
                  style={{ resize: 'vertical' }}
                />
              </label>
            </div>
            <footer style={{
              padding: '0.75rem 1.25rem', borderTop: '1px solid var(--border-color)',
              display: 'flex', justifyContent: 'flex-end', gap: 8,
            }}>
              <button
                type="button"
                onClick={() => { setShowAdd(false); resetAddForm(); }}
                className="btn-secondary"
                style={{ padding: '0.4rem 0.9rem' }}
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={submitAdd}
                disabled={submitting || !addPhone.trim()}
                className="btn-primary"
                data-testid="blocked-add-submit"
                style={{ padding: '0.4rem 0.9rem' }}
              >
                {submitting ? 'Adding…' : 'Block number'}
              </button>
            </footer>
          </div>
        </div>
      )}

      {/* Unblock modal — DPDP §11 reason capture. */}
      {unblockId && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Unblock number"
          data-testid="blocked-unblock-modal"
          style={{
            position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)', zIndex: 1000,
            display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '2rem',
          }}
          onClick={(e) => { if (e.target === e.currentTarget) { setUnblockId(null); setUnblockReason(''); } }}
        >
          <div style={{
            background: 'var(--card-bg, #1a1a1a)', color: 'var(--text-primary)',
            borderRadius: 12, width: 'min(520px, 100%)',
            border: '1px solid var(--border-color)', overflow: 'hidden',
            display: 'flex', flexDirection: 'column',
          }}>
            <header style={{
              padding: '1rem 1.25rem', borderBottom: '1px solid var(--border-color)',
              display: 'flex', alignItems: 'center', justifyContent: 'space-between',
            }}>
              <h3 style={{ margin: 0, fontSize: '1rem', fontWeight: 700, display: 'flex', alignItems: 'center', gap: 6 }}>
                <AlertTriangle size={16} color="#f59e0b" /> Unblock number
              </h3>
              <button
                onClick={() => { setUnblockId(null); setUnblockReason(''); }}
                aria-label="Close unblock modal"
                style={{ background: 'transparent', border: 'none', color: 'var(--text-secondary)', cursor: 'pointer' }}
              >
                <X size={18} />
              </button>
            </header>
            <div style={{ padding: '1rem 1.25rem', display: 'flex', flexDirection: 'column', gap: 10 }}>
              <p style={{ fontSize: '0.82rem', color: 'var(--text-secondary)', margin: 0 }}>
                Re-opting a contact silently re-enables WhatsApp messaging. DPDP §11 requires a written
                reason in the audit trail. Minimum 10 characters.
              </p>
              <label style={{ fontSize: '0.8rem', display: 'flex', flexDirection: 'column', gap: 4 }}>
                <span>Reason</span>
                <textarea
                  value={unblockReason}
                  onChange={(e) => setUnblockReason(e.target.value)}
                  rows={3}
                  className="input-field"
                  data-testid="blocked-unblock-reason"
                  placeholder="e.g. Customer called and requested re-opt-in on 2026-05-17"
                  style={{ resize: 'vertical' }}
                />
              </label>
            </div>
            <footer style={{
              padding: '0.75rem 1.25rem', borderTop: '1px solid var(--border-color)',
              display: 'flex', justifyContent: 'flex-end', gap: 8,
            }}>
              <button
                type="button"
                onClick={() => { setUnblockId(null); setUnblockReason(''); }}
                className="btn-secondary"
                style={{ padding: '0.4rem 0.9rem' }}
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={submitUnblock}
                disabled={unblocking || unblockReason.trim().length < 10}
                className="btn-primary"
                data-testid="blocked-unblock-submit"
                style={{ padding: '0.4rem 0.9rem' }}
              >
                {unblocking ? 'Unblocking…' : 'Confirm unblock'}
              </button>
            </footer>
          </div>
        </div>
      )}
    </div>
  );
}
