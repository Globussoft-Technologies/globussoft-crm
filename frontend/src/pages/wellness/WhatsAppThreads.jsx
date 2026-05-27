// WhatsApp Threads — agent inbox for 2-way WhatsApp messaging.
//
// Wave 2 Agent KK companion to the backend's /api/whatsapp/threads + /opt-outs
// endpoints. Implements:
//   - Left rail with thread list, status filter, "show only unread" toggle,
//     search box (phone or contact name)
//   - Right pane with the selected thread's last 50 messages, reply textarea,
//     "Assign to me" / "Close" / "Snooze" / "Mark read" buttons
//   - Opt-out indicator chip + disabled reply box if the contact is opted out
//   - Unread badge in the left rail entries
//
// Lives under /wellness/whatsapp because the audit-call gap was wellness-
// vertical-shaped (clinics on Meta Cloud API), but the routes themselves
// are tenant-agnostic — adding a generic /whatsapp link later is one line.

import React, { useContext, useEffect, useMemo, useRef, useState } from 'react';
import { AuthContext } from '../../App';
import {
  MessageCircle,
  Search,
  Send,
  Check,
  CheckCheck,
  Clock,
  XCircle,
  UserCheck,
  Ban,
  RefreshCw,
  AlertTriangle,
  Plus,
  X,
  Edit2,
  Save,
} from 'lucide-react';
import { Link } from 'react-router-dom';
import { fetchApi } from '../../utils/api';
import { useNotify } from '../../utils/notify';
import WhatsAppEmbeddedSignup from '../../components/WhatsAppEmbeddedSignup';

const STATUS_OPTIONS = [
  { value: '', label: 'All' },
  { value: 'OPEN', label: 'Open' },
  { value: 'PENDING_AGENT', label: 'Pending agent' },
  { value: 'SNOOZED', label: 'Snoozed' },
  { value: 'CLOSED', label: 'Closed' },
];

function timeAgo(isoOrDate) {
  if (!isoOrDate) return '';
  const d = isoOrDate instanceof Date ? isoOrDate : new Date(isoOrDate);
  const diffMs = Date.now() - d.getTime();
  const mins = Math.round(diffMs / 60_000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.round(hours / 24);
  if (days < 7) return `${days}d`;
  return d.toLocaleDateString();
}

// Wave 7D — PRD Gap §7 item 3 — delivery-tick icon per WhatsAppMessage.status.
// Icons are familiar to anyone who's used WhatsApp on a phone:
//   QUEUED → small clock (still being dispatched)
//   SENT   → single grey check
//   DELIVERED → double grey check
//   READ   → double blue check
//   FAILED → red triangle/exclamation
// QUEUED is treated as "no checkmark yet" — the row's status text alongside
// already says it. Returns null for inbound messages (we never emit these
// statuses for INBOUND rows; they're stored as 'RECEIVED').
function DeliveryTicks({ status, direction }) {
  if (direction !== 'OUTBOUND') return null;
  if (status === 'READ') {
    return <CheckCheck size={14} color="#3b82f6" aria-label="Read" data-testid="delivery-tick-read" />;
  }
  if (status === 'DELIVERED') {
    return <CheckCheck size={14} color="rgba(255,255,255,0.7)" aria-label="Delivered" data-testid="delivery-tick-delivered" />;
  }
  if (status === 'SENT') {
    return <Check size={14} color="rgba(255,255,255,0.7)" aria-label="Sent" data-testid="delivery-tick-sent" />;
  }
  if (status === 'FAILED') {
    return <AlertTriangle size={14} color="#ef4444" aria-label="Failed" data-testid="delivery-tick-failed" />;
  }
  if (status === 'QUEUED') {
    return <Clock size={12} color="rgba(255,255,255,0.5)" aria-label="Queued" data-testid="delivery-tick-queued" />;
  }
  return null;
}

function StatusPill({ status }) {
  const map = {
    OPEN: { bg: 'rgba(16,185,129,0.15)', fg: '#10b981', label: 'Open' },
    PENDING_AGENT: { bg: 'rgba(245,158,11,0.15)', fg: '#f59e0b', label: 'Pending' },
    SNOOZED: { bg: 'rgba(99,102,241,0.15)', fg: '#6366f1', label: 'Snoozed' },
    CLOSED: { bg: 'rgba(107,114,128,0.15)', fg: '#6b7280', label: 'Closed' },
  };
  const cfg = map[status] || map.OPEN;
  return (
    <span style={{
      background: cfg.bg, color: cfg.fg, padding: '2px 8px', borderRadius: 10,
      fontSize: '0.7rem', fontWeight: 600,
    }}>{cfg.label}</span>
  );
}

export default function WhatsAppThreads() {
  const notify = useNotify();
  // Tenant ADMIN can: edit the assign dropdown, see Manage / Disconnect
  // buttons in the status bar, see the "+ New" composer button, and access
  // the Templates page. MANAGER + below see read-only state. Backend RBAC
  // gates the destructive routes too — this is the cosmetic mirror.
  const { user: currentUser } = useContext(AuthContext) || {};
  const isAdmin = currentUser?.role === 'ADMIN';
  const [threads, setThreads] = useState([]);
  const [loadingList, setLoadingList] = useState(true);
  const [statusFilter, setStatusFilter] = useState('');
  const [unreadOnly, setUnreadOnly] = useState(false);
  const [q, setQ] = useState('');
  const [selectedId, setSelectedId] = useState(null);
  const [detail, setDetail] = useState(null);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [reply, setReply] = useState('');
  const [sending, setSending] = useState(false);
  const messagesEndRef = useRef(null);

  // ─── "New message" composer state ──────────────────────────
  // Modal-driven outbound-first send. Hits POST /api/whatsapp/send
  // with { to, body }. If the recipient hasn't messaged in 24h the
  // backend returns 422 OUTSIDE_24H_WINDOW — surfaced in `newError`
  // with hint about templates so the user knows the path forward.
  const [showNewModal, setShowNewModal] = useState(false);
  const [newPhone, setNewPhone] = useState('');
  const [newBody, setNewBody] = useState('');
  const [newSending, setNewSending] = useState(false);
  const [newError, setNewError] = useState(null);

  // Staff list (for the assign dropdown) — fetched once on mount.
  // Renders as a dropdown that replaces the single-purpose "Assign to me"
  // button, so the operator can hand a thread off to any teammate.
  const [staff, setStaff] = useState([]);

  // Inline rename state — when the user clicks the pencil next to the contact
  // name, this flips on and a small input box appears. Save → POST to the
  // rename-contact route → re-fetch detail.
  const [renaming, setRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState('');
  const [renameSaving, setRenameSaving] = useState(false);

  // Approved-template picker used inside the New Message modal so the user
  // can bypass the 24-hour window for cold outreach. Fetched once on mount.
  const [templates, setTemplates] = useState([]);
  const [useTemplate, setUseTemplate] = useState(false);
  const [selectedTemplateName, setSelectedTemplateName] = useState('');
  const [templateParams, setTemplateParams] = useState([]); // string[]

  // ─── Load thread list ──────────────────────────────────────
  const loadList = async () => {
    setLoadingList(true);
    try {
      const params = new URLSearchParams({ limit: '50' });
      if (statusFilter) params.set('status', statusFilter);
      if (unreadOnly) params.set('unread', 'true');
      if (q.trim()) params.set('q', q.trim());
      const data = await fetchApi(`/api/whatsapp/threads?${params.toString()}`);
      setThreads(Array.isArray(data?.threads) ? data.threads : []);
    } catch (err) {
      notify.error(err.message || 'Failed to load threads.');
      setThreads([]);
    }
    setLoadingList(false);
  };

  useEffect(() => {
    loadList();
    // re-run on filter changes
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [statusFilter, unreadOnly]);

  // ─── Load staff list for assign dropdown (once on mount) ───
  useEffect(() => {
    (async () => {
      try {
        const data = await fetchApi('/api/staff');
        const list = Array.isArray(data) ? data : Array.isArray(data?.users) ? data.users : [];
        setStaff(list);
      } catch {
        /* non-fatal — dropdown just stays empty */
      }
    })();
  }, []);

  // ─── Load APPROVED templates for the picker ─────────────────
  // Only APPROVED templates can be sent. PENDING/REJECTED are filtered out.
  useEffect(() => {
    (async () => {
      try {
        const data = await fetchApi('/api/whatsapp/templates');
        const list = Array.isArray(data) ? data : Array.isArray(data?.templates) ? data.templates : [];
        setTemplates(list.filter((t) => t.status === 'APPROVED'));
      } catch {
        /* non-fatal — picker just stays empty */
      }
    })();
  }, []);

  // Detect placeholder count in a template body — used to render the
  // right number of param inputs. {{1}}, {{2}} … {{N}}.
  const countPlaceholders = (body) => {
    if (!body) return 0;
    const matches = body.match(/\{\{\d+\}\}/g) || [];
    return new Set(matches).size;
  };

  // Whenever the selected template changes, reset the param array to match.
  useEffect(() => {
    if (!selectedTemplateName) {
      setTemplateParams([]);
      return;
    }
    const tpl = templates.find((t) => t.name === selectedTemplateName);
    const n = countPlaceholders(tpl?.body || '');
    setTemplateParams(Array(n).fill(''));
  }, [selectedTemplateName, templates]);

  // ─── Load detail when selection changes ────────────────────
  useEffect(() => {
    // Reset inline rename state whenever the user picks a different
    // thread — stale rename input shouldn't bleed into the new selection.
    setRenaming(false);
    setRenameValue('');
    if (!selectedId) {
      setDetail(null);
      return;
    }
    let cancelled = false;
    setLoadingDetail(true);
    (async () => {
      try {
        const data = await fetchApi(`/api/whatsapp/threads/${selectedId}`);
        if (!cancelled) {
          setDetail(data);
          // Mark as read if it had unread messages.
          if (data?.thread?.unreadCount > 0) {
            try {
              await fetchApi(`/api/whatsapp/threads/${selectedId}/mark-read`, {
                method: 'POST',
                body: JSON.stringify({}),
              });
              setThreads((prev) =>
                prev.map((t) => (t.id === selectedId ? { ...t, unreadCount: 0 } : t))
              );
            } catch {
              /* best-effort */
            }
          }
        }
      } catch (err) {
        if (!cancelled) {
          notify.error(err.message || 'Failed to load thread.');
          setDetail(null);
        }
      }
      if (!cancelled) setLoadingDetail(false);
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId]);

  useEffect(() => {
    if (messagesEndRef.current) {
      messagesEndRef.current.scrollIntoView({ behavior: 'smooth' });
    }
  }, [detail]);

  // ─── Actions ──────────────────────────────────────────────
  const handleSearch = (e) => {
    e.preventDefault();
    loadList();
  };

  const sendReply = async () => {
    if (!detail?.thread || !reply.trim() || sending) return;
    if (detail.optedOut) {
      notify.error('Contact has opted out — replies are blocked.');
      return;
    }
    setSending(true);
    try {
      await fetchApi('/api/whatsapp/send', {
        method: 'POST',
        body: JSON.stringify({ to: detail.thread.contactPhone, body: reply.trim() }),
      });
      setReply('');
      // Reload detail
      const fresh = await fetchApi(`/api/whatsapp/threads/${selectedId}`);
      setDetail(fresh);
      loadList();
    } catch (err) {
      const msg = err?.message || '';
      if (msg.includes('CONTACT_OPTED_OUT')) {
        notify.error('Contact has opted out — replies are blocked.');
      } else {
        notify.error(msg || 'Failed to send.');
      }
    }
    setSending(false);
  };

  // ─── Outbound-first send (modal) ───────────────────────────
  //
  // Two paths: free-form text (24h-window rule) OR approved template
  // (works any time, any number). useTemplate toggle switches between them.
  const sendNewMessage = async () => {
    setNewError(null);
    const phoneTrim = newPhone.trim();
    if (!phoneTrim) {
      setNewError('Phone is required.');
      return;
    }

    let payload;
    if (useTemplate) {
      if (!selectedTemplateName) {
        setNewError('Pick a template to send.');
        return;
      }
      // Require all placeholders filled
      if (templateParams.some((p) => !p.trim())) {
        setNewError('Fill in every template variable before sending.');
        return;
      }
      const tpl = templates.find((t) => t.name === selectedTemplateName);
      payload = {
        to: phoneTrim,
        templateName: selectedTemplateName,
        language: tpl?.language || 'en_US',
        parameters: templateParams,
      };
    } else {
      const bodyTrim = newBody.trim();
      if (!bodyTrim) {
        setNewError('Message body is required.');
        return;
      }
      payload = { to: phoneTrim, body: bodyTrim };
    }

    setNewSending(true);
    try {
      const resp = await fetchApi('/api/whatsapp/send', {
        method: 'POST',
        body: JSON.stringify(payload),
      });
      notify.info(useTemplate ? 'Template message sent.' : 'Message sent.');
      setShowNewModal(false);
      setNewPhone('');
      setNewBody('');
      setSelectedTemplateName('');
      setTemplateParams([]);
      setUseTemplate(false);
      await loadList();
      if (resp?.thread?.id) setSelectedId(resp.thread.id);
    } catch (err) {
      const msg = err?.message || 'Failed to send.';
      if (msg.includes('OUTSIDE_24H_WINDOW')) {
        setNewError(
          'This number has not messaged you in the last 24 hours. ' +
          'Toggle "Use Template" above and pick an approved template instead.'
        );
      } else if (msg.includes('CONTACT_OPTED_OUT')) {
        setNewError('This contact has opted out of WhatsApp messages.');
      } else {
        setNewError(msg);
      }
    }
    setNewSending(false);
  };

  // Generic assignment — works for self-assign AND cross-assign (backend
  // RBAC-gates cross-assign to ADMIN/MANAGER; self-assign open to all roles).
  // Pass null to unassign.
  //
  // NOTE per CLAUDE.md "Standing rules" + backend route comment: the global
  // stripDangerous middleware deletes req.body.userId on every request, so
  // the field MUST be `targetUserId` — `userId` is silently dropped to null
  // and the backend would unassign instead of rejecting bad input.
  const assignToUser = async (targetUserId) => {
    if (!detail?.thread) return;
    try {
      await fetchApi(`/api/whatsapp/threads/${detail.thread.id}/assign`, {
        method: 'POST',
        body: JSON.stringify({ targetUserId: targetUserId == null ? null : Number(targetUserId) }),
      });
      const fresh = await fetchApi(`/api/whatsapp/threads/${selectedId}`);
      setDetail(fresh);
      loadList();
    } catch (err) {
      notify.error(err.message || 'Failed to assign.');
    }
  };

  // Rename contact — adds a friendly name to the phone number. Creates a new
  // Contact row if none exists, otherwise updates the existing one.
  const startRename = () => {
    const currentName =
      detail?.thread?.contact?.name ||
      detail?.thread?.patient?.name ||
      '';
    setRenameValue(currentName);
    setRenaming(true);
  };
  const cancelRename = () => {
    setRenaming(false);
    setRenameValue('');
  };
  const saveRename = async () => {
    if (!detail?.thread || renameSaving) return;
    const name = renameValue.trim();
    if (!name) {
      notify.error('Name cannot be empty.');
      return;
    }
    setRenameSaving(true);
    try {
      await fetchApi(`/api/whatsapp/threads/${detail.thread.id}/rename-contact`, {
        method: 'POST',
        body: JSON.stringify({ name }),
      });
      const fresh = await fetchApi(`/api/whatsapp/threads/${selectedId}`);
      setDetail(fresh);
      loadList();
      setRenaming(false);
      setRenameValue('');
      notify.info('Contact name saved.');
    } catch (err) {
      notify.error(err.message || 'Failed to save name.');
    }
    setRenameSaving(false);
  };

  const closeThread = async () => {
    if (!detail?.thread) return;
    if (!await notify.confirm('Close this thread?')) return;
    try {
      await fetchApi(`/api/whatsapp/threads/${detail.thread.id}/close`, {
        method: 'POST',
        body: JSON.stringify({}),
      });
      const fresh = await fetchApi(`/api/whatsapp/threads/${selectedId}`);
      setDetail(fresh);
      loadList();
    } catch (err) {
      notify.error(err.message || 'Failed to close.');
    }
  };

  const snoozeThread = async () => {
    if (!detail?.thread) return;
    const hours = await notify.prompt?.('Snooze for how many hours?', '4') || '4';
    const numHours = parseFloat(hours);
    if (!Number.isFinite(numHours) || numHours <= 0) return;
    const until = new Date(Date.now() + numHours * 3_600_000).toISOString();
    try {
      await fetchApi(`/api/whatsapp/threads/${detail.thread.id}/snooze`, {
        method: 'POST',
        body: JSON.stringify({ until }),
      });
      const fresh = await fetchApi(`/api/whatsapp/threads/${selectedId}`);
      setDetail(fresh);
      loadList();
    } catch (err) {
      notify.error(err.message || 'Failed to snooze.');
    }
  };

  const optOutContact = async () => {
    if (!detail?.thread) return;
    if (!await notify.confirm(`Opt out ${detail.thread.contactPhone} from all WhatsApp messages? This is a DPDP/TRAI compliance action.`)) return;
    try {
      await fetchApi('/api/whatsapp/opt-outs', {
        method: 'POST',
        body: JSON.stringify({ contactPhone: detail.thread.contactPhone, reason: 'USER_REQUESTED' }),
      });
      const fresh = await fetchApi(`/api/whatsapp/threads/${selectedId}`);
      setDetail(fresh);
    } catch (err) {
      notify.error(err.message || 'Failed to opt out.');
    }
  };

  // ─── Render ─────────────────────────────────────────────
  const filteredThreads = useMemo(() => threads, [threads]);

  return (
    <div style={{
      display: 'flex', flexDirection: 'column',
      height: 'calc(100vh - var(--top-nav-height, 0px))',
      animation: 'fadeIn 0.4s ease-out',
    }}>
      {/* P2: WhatsApp connection panel — embedded above the threads grid.
          Compact mode = slim status bar when CONNECTED, auto-expand on
          any issue. Admin-only actions (Connect / Reconnect / Disconnect)
          are RBAC-gated server-side; the UI surfaces buttons for everyone
          but the API rejects non-admins. */}
      <div style={{ padding: '0.75rem 1rem 0' }}>
        <WhatsAppEmbeddedSignup compact />
      </div>

      <div style={{ display: 'flex', flex: 1, gap: 0, minHeight: 0 }}>
      {/* ─── Left rail ─── */}
      <aside style={{
        width: 360, borderRight: '1px solid var(--border-color)',
        display: 'flex', flexDirection: 'column', minWidth: 0,
      }}>
        <header style={{ padding: '1rem', borderBottom: '1px solid var(--border-color)' }}>
          <div style={{
            display: 'flex', alignItems: 'center', justifyContent: 'space-between',
            gap: 8, marginBottom: '0.75rem',
          }}>
            <h2 style={{
              display: 'flex', alignItems: 'center', gap: 8,
              fontSize: '1.15rem', fontWeight: 700, margin: 0,
            }}>
              <MessageCircle size={20} color="var(--primary-color, var(--accent-color))" />
              WhatsApp Threads
            </h2>
            {isAdmin && (
              <div style={{ display: 'flex', gap: 6 }}>
                <Link
                  to="/wellness/whatsapp/templates"
                  title="Manage WhatsApp Templates"
                  style={{
                    display: 'flex', alignItems: 'center', gap: 4,
                    padding: '0.4rem 0.7rem',
                    background: 'transparent',
                    color: 'var(--text-primary)',
                    border: '1px solid var(--border-color)',
                    borderRadius: 6,
                    fontSize: '0.8rem', fontWeight: 500, textDecoration: 'none',
                  }}
                >
                  Templates
                </Link>
                <button
                  onClick={() => { setShowNewModal(true); setNewError(null); }}
                  title="New conversation"
                  style={{
                    display: 'flex', alignItems: 'center', gap: 4,
                    padding: '0.4rem 0.75rem',
                    background: 'var(--primary-color, #25D366)',
                    color: '#fff', border: 'none', borderRadius: 6,
                    fontSize: '0.8rem', fontWeight: 600, cursor: 'pointer',
                  }}
                >
                  <Plus size={14} /> New
                </button>
              </div>
            )}
          </div>
          <form onSubmit={handleSearch} style={{ display: 'flex', gap: 6, marginBottom: '0.5rem' }}>
            <div style={{ flex: 1, position: 'relative' }}>
              <Search size={14} style={{
                position: 'absolute', left: 8, top: '50%', transform: 'translateY(-50%)',
                color: 'var(--text-secondary)',
              }} />
              <input
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder="Phone or contact name"
                className="input-field"
                style={{ paddingLeft: 26, fontSize: '0.85rem' }}
              />
            </div>
            <button type="submit" className="btn-secondary" style={{ padding: '0.4rem 0.75rem' }}>Go</button>
          </form>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <select
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value)}
              className="input-field"
              style={{ flex: 1, fontSize: '0.8rem', padding: '0.35rem 0.5rem' }}
            >
              {STATUS_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>{opt.label}</option>
              ))}
            </select>
            <label style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: '0.8rem', color: 'var(--text-secondary)' }}>
              <input
                type="checkbox"
                checked={unreadOnly}
                onChange={(e) => setUnreadOnly(e.target.checked)}
              />
              Unread
            </label>
            <button
              onClick={loadList}
              className="btn-secondary"
              style={{ padding: '0.35rem', display: 'flex' }}
              title="Refresh"
            >
              <RefreshCw size={14} />
            </button>
          </div>
        </header>

        <div style={{ flex: 1, overflowY: 'auto' }}>
          {loadingList ? (
            <p style={{ padding: '1rem', color: 'var(--text-secondary)', textAlign: 'center' }}>Loading…</p>
          ) : filteredThreads.length === 0 ? (
            <p style={{ padding: '2rem 1rem', color: 'var(--text-secondary)', textAlign: 'center', fontSize: '0.9rem' }}>
              No threads match your filters.
            </p>
          ) : (
            filteredThreads.map((t) => {
              const isSelected = t.id === selectedId;
              const displayName = t.contact?.name || t.patient?.name || t.contactPhone;
              return (
                <div
                  key={t.id}
                  onClick={() => setSelectedId(t.id)}
                  style={{
                    padding: '0.85rem 1rem',
                    borderBottom: '1px solid var(--border-color)',
                    cursor: 'pointer',
                    background: isSelected ? 'var(--card-bg-hover, rgba(59,130,246,0.08))' : 'transparent',
                    display: 'flex', flexDirection: 'column', gap: 4,
                  }}
                >
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 6 }}>
                    <span style={{
                      fontWeight: t.unreadCount > 0 ? 700 : 500,
                      fontSize: '0.9rem',
                      overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1, minWidth: 0,
                    }}>{displayName}</span>
                    {t.unreadCount > 0 && (
                      <span style={{
                        background: 'var(--primary-color, var(--accent-color))', color: '#fff',
                        padding: '1px 7px', borderRadius: 10, fontSize: '0.7rem', fontWeight: 700,
                      }}>{t.unreadCount}</span>
                    )}
                  </div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 6 }}>
                    <span style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>
                      {t.contactPhone}
                    </span>
                    <span style={{ fontSize: '0.7rem', color: 'var(--text-secondary)' }}>
                      {timeAgo(t.lastMessageAt)}
                    </span>
                  </div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 6 }}>
                    <StatusPill status={t.status} />
                    {t.assignedTo && (
                      <span style={{ fontSize: '0.7rem', color: 'var(--text-secondary)', display: 'flex', alignItems: 'center', gap: 3 }}>
                        <UserCheck size={11} /> {t.assignedTo.name || t.assignedTo.email}
                      </span>
                    )}
                  </div>
                </div>
              );
            })
          )}
        </div>
      </aside>

      {/* ─── Right pane ─── */}
      <main style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0, minHeight: 0 }}>
        {!selectedId ? (
          <div style={{
            flex: 1, display: 'flex', flexDirection: 'column',
            alignItems: 'center', justifyContent: 'center',
            color: 'var(--text-secondary)', gap: 8, padding: '2rem',
          }}>
            <MessageCircle size={48} color="var(--text-secondary)" />
            <p>Select a thread to start replying.</p>
          </div>
        ) : loadingDetail || !detail?.thread ? (
          <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <p style={{ color: 'var(--text-secondary)' }}>Loading thread…</p>
          </div>
        ) : (
          <>
            {/* Header — two rows so the Status pill never overlaps the
                contact name + the action buttons sit on their own line. */}
            <header style={{
              padding: '0.9rem 1.5rem', borderBottom: '1px solid var(--border-color)',
              display: 'flex', flexDirection: 'column', gap: 8,
            }}>
              {/* Row 1 — name (or phone) + Edit pencil + Status pill on the right */}
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 }}>
                {renaming ? (
                  <>
                    <input
                      value={renameValue}
                      onChange={(e) => setRenameValue(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') saveRename();
                        if (e.key === 'Escape') cancelRename();
                      }}
                      placeholder="Save as…"
                      autoFocus
                      className="input-field"
                      style={{ fontSize: '0.95rem', fontWeight: 600, padding: '0.35rem 0.6rem', maxWidth: 280 }}
                      disabled={renameSaving}
                    />
                    <button
                      onClick={saveRename}
                      disabled={renameSaving || !renameValue.trim()}
                      title="Save name"
                      style={{
                        background: 'var(--primary-color, #25D366)', color: '#fff',
                        border: 'none', borderRadius: 6, padding: '0.35rem 0.6rem',
                        display: 'flex', alignItems: 'center', gap: 4, fontSize: '0.8rem',
                        cursor: renameSaving ? 'not-allowed' : 'pointer',
                      }}
                    >
                      <Save size={14} />
                      {renameSaving ? 'Saving…' : 'Save'}
                    </button>
                    <button
                      onClick={cancelRename}
                      disabled={renameSaving}
                      className="btn-secondary"
                      style={{ fontSize: '0.8rem', padding: '0.35rem 0.6rem' }}
                    >
                      Cancel
                    </button>
                  </>
                ) : (
                  <>
                    <h2 style={{
                      fontSize: '1.05rem', fontWeight: 700, margin: 0,
                      overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0,
                    }}>
                      {detail.thread.contact?.name || detail.thread.patient?.name || detail.thread.contactPhone}
                    </h2>
                    {isAdmin && (
                      <button
                        onClick={startRename}
                        title="Save contact name"
                        style={{
                          background: 'transparent', border: 'none', cursor: 'pointer',
                          color: 'var(--text-secondary)', padding: 4, display: 'flex',
                        }}
                      >
                        <Edit2 size={14} />
                      </button>
                    )}
                  </>
                )}
                <div style={{ marginLeft: 'auto', flexShrink: 0 }}>
                  <StatusPill status={detail.thread.status} />
                </div>
              </div>

              {/* Row 2 — phone + assignment + snooze info */}
              <p style={{ fontSize: '0.78rem', color: 'var(--text-secondary)', margin: 0 }}>
                {detail.thread.contactPhone}
                {detail.thread.assignedTo && (
                  <> · Assigned to {detail.thread.assignedTo.name || detail.thread.assignedTo.email}</>
                )}
                {detail.thread.snoozedUntil && (
                  <> · Snoozed until {new Date(detail.thread.snoozedUntil).toLocaleString()}</>
                )}
              </p>

              {detail.optedOut && (
                <p style={{
                  background: 'rgba(239,68,68,0.12)', color: '#dc2626',
                  padding: '4px 10px', borderRadius: 8, fontSize: '0.75rem',
                  margin: 0, display: 'inline-flex', alignItems: 'center', gap: 5,
                  alignSelf: 'flex-start',
                }}>
                  <Ban size={12} /> Opted out ({detail.optedOut.reason})
                  on {new Date(detail.optedOut.capturedAt).toLocaleDateString()}
                </p>
              )}

              {/* Row 3 — action bar (assign dropdown + Snooze + Close + Opt out) */}
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
                {isAdmin ? (
                  <label style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: '0.8rem', color: 'var(--text-secondary)' }}>
                    <UserCheck size={14} />
                    <select
                      value={detail.thread.assignedToId || ''}
                      onChange={(e) => assignToUser(e.target.value || null)}
                      className="input-field"
                      style={{ fontSize: '0.8rem', padding: '0.35rem 0.5rem', minWidth: 160 }}
                      title="Assign to a teammate"
                    >
                      <option value="">Unassigned</option>
                      {staff.map((u) => (
                        <option key={u.id} value={u.id}>
                          {u.name || u.email}
                        </option>
                      ))}
                    </select>
                  </label>
                ) : (
                  // Read-only badge for non-admins / non-managers
                  <span style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: '0.8rem', color: 'var(--text-secondary)', padding: '0.35rem 0.5rem', border: '1px solid var(--border-color)', borderRadius: 6 }}>
                    <UserCheck size={14} />
                    {detail.thread.assignedTo
                      ? (detail.thread.assignedTo.name || detail.thread.assignedTo.email)
                      : 'Unassigned'}
                  </span>
                )}
                <button onClick={snoozeThread} className="btn-secondary" style={{ fontSize: '0.8rem', padding: '0.4rem 0.75rem', display: 'flex', alignItems: 'center', gap: 4 }}>
                  <Clock size={14} /> Snooze
                </button>
                <button onClick={closeThread} className="btn-secondary" style={{ fontSize: '0.8rem', padding: '0.4rem 0.75rem', display: 'flex', alignItems: 'center', gap: 4 }}>
                  <CheckCheck size={14} /> Close
                </button>
                {!detail.optedOut && (
                  <button onClick={optOutContact} className="btn-secondary" style={{ fontSize: '0.8rem', padding: '0.4rem 0.75rem', display: 'flex', alignItems: 'center', gap: 4, color: '#dc2626' }}>
                    <XCircle size={14} /> Opt out
                  </button>
                )}
              </div>
            </header>

            {/* Messages — uses the chat-specific theme vars added to
                src/index.css (--chat-bg, --chat-bubble-in, --chat-bubble-out)
                which are SOLID colors that adapt per theme. WhatsApp-style:
                light mode = cream backdrop + white inbound + pale-green
                outbound. Dark mode = near-black backdrop + dark-gray inbound
                + muted-teal outbound. Always solid (not translucent) so
                the bubble never blends into the backdrop. */}
            <div style={{
              flex: 1, overflowY: 'auto', padding: '1.5rem',
              display: 'flex', flexDirection: 'column', gap: 10,
              background: 'var(--chat-bg)',
            }}>
              {(detail.messages || []).map((m) => {
                const isOutbound = m.direction === 'OUTBOUND';
                return (
                  <div
                    key={m.id}
                    style={{
                      maxWidth: '70%',
                      alignSelf: isOutbound ? 'flex-end' : 'flex-start',
                      background: isOutbound ? 'var(--chat-bubble-out)' : 'var(--chat-bubble-in)',
                      color: 'var(--text-primary)',
                      padding: '0.6rem 0.85rem', borderRadius: 12,
                      fontSize: '0.9rem', lineHeight: 1.4,
                      wordBreak: 'break-word',
                      boxShadow: '0 1px 1px rgba(0,0,0,0.13)',
                    }}
                  >
                    <div>{m.body || <em style={{ opacity: 0.6 }}>(media)</em>}</div>
                    <div style={{
                      fontSize: '0.65rem', opacity: 0.65, marginTop: 4,
                      textAlign: isOutbound ? 'right' : 'left',
                      display: 'flex',
                      gap: 4,
                      alignItems: 'center',
                      justifyContent: isOutbound ? 'flex-end' : 'flex-start',
                    }}>
                      <span>{new Date(m.createdAt).toLocaleString()}</span>
                      {/* Wave 7D delivery-ticks — outbound only. Status fed
                          from Meta webhook (see backend/routes/whatsapp.js
                          POST /webhook statuses[] handler). */}
                      <DeliveryTicks status={m.status} direction={m.direction} />
                    </div>
                  </div>
                );
              })}
              <div ref={messagesEndRef} />
            </div>

            {/* Reply box */}
            <footer style={{ padding: '1rem 1.5rem', borderTop: '1px solid var(--border-color)' }}>
              {detail.optedOut ? (
                <p style={{ color: 'var(--text-secondary)', fontSize: '0.85rem', textAlign: 'center', padding: '0.75rem' }}>
                  Reply box disabled — contact has opted out (DPDP/TRAI compliance).
                </p>
              ) : (
                <div style={{ display: 'flex', gap: 8 }}>
                  <textarea
                    value={reply}
                    onChange={(e) => setReply(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                        e.preventDefault();
                        sendReply();
                      }
                    }}
                    placeholder="Type a reply… (Ctrl+Enter to send)"
                    className="input-field"
                    style={{ flex: 1, minHeight: 44, resize: 'vertical', fontSize: '0.9rem' }}
                  />
                  <button
                    onClick={sendReply}
                    disabled={sending || !reply.trim()}
                    className="btn-primary"
                    style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '0 1rem' }}
                  >
                    <Send size={16} /> {sending ? 'Sending…' : 'Send'}
                  </button>
                </div>
              )}
            </footer>
          </>
        )}
      </main>
      </div>

      {/* ─── New conversation modal ─── */}
      {showNewModal && (
        <div
          onClick={(e) => { if (e.target === e.currentTarget) setShowNewModal(false); }}
          style={{
            position: 'fixed', inset: 0,
            background: 'rgba(0,0,0,0.55)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            zIndex: 9999, padding: '1rem',
          }}
        >
          <div
            className="glass-card"
            style={{
              width: '100%', maxWidth: 480,
              padding: '1.5rem', borderRadius: 12,
              background: 'var(--surface-color)',
              backdropFilter: 'blur(20px)',
              WebkitBackdropFilter: 'blur(20px)',
              color: 'var(--text-primary)',
              border: '1px solid var(--border-color)',
            }}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1rem' }}>
              <h3 style={{ margin: 0, fontSize: '1.1rem', display: 'flex', alignItems: 'center', gap: 8 }}>
                <MessageCircle size={18} color="var(--primary-color, #25D366)" />
                New WhatsApp Message
              </h3>
              <button
                onClick={() => setShowNewModal(false)}
                style={{
                  background: 'transparent', border: 'none', cursor: 'pointer',
                  color: 'var(--text-secondary)', padding: 4, display: 'flex',
                }}
                title="Close"
              >
                <X size={18} />
              </button>
            </div>

            <p style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', marginBottom: '1rem', lineHeight: 1.5 }}>
              Send a message to a new number. Free-form text only works if the recipient
              has messaged you in the last 24 hours — otherwise use an approved template.
            </p>

            <label style={{ display: 'block', marginBottom: '0.75rem' }}>
              <span style={{ fontSize: '0.8rem', fontWeight: 600, color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '0.04em', display: 'block', marginBottom: 4 }}>
                Phone (with country code)
              </span>
              <input
                type="tel"
                value={newPhone}
                onChange={(e) => setNewPhone(e.target.value)}
                placeholder="+919876543210"
                className="input-field"
                style={{ width: '100%', fontSize: '0.9rem' }}
                disabled={newSending}
              />
            </label>

            {/* Use Template toggle */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: '0.75rem' }}>
              <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: '0.85rem', cursor: 'pointer' }}>
                <input
                  type="checkbox"
                  checked={useTemplate}
                  onChange={(e) => setUseTemplate(e.target.checked)}
                  disabled={newSending}
                />
                Use Template (required to message cold numbers)
              </label>
              {templates.length === 0 && useTemplate && (
                <Link to="/wellness/whatsapp/templates" style={{ fontSize: '0.75rem', color: 'var(--primary-color, #25D366)' }}>
                  Create one →
                </Link>
              )}
            </div>

            {useTemplate ? (
              <>
                <label style={{ display: 'block', marginBottom: '0.75rem' }}>
                  <span style={{ fontSize: '0.8rem', fontWeight: 600, color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '0.04em', display: 'block', marginBottom: 4 }}>
                    Approved Template
                  </span>
                  <select
                    value={selectedTemplateName}
                    onChange={(e) => setSelectedTemplateName(e.target.value)}
                    className="input-field"
                    style={{ width: '100%', fontSize: '0.9rem' }}
                    disabled={newSending}
                  >
                    <option value="">— Select a template —</option>
                    {templates.map((t) => (
                      <option key={t.id} value={t.name}>
                        {t.name} ({t.category} · {t.language})
                      </option>
                    ))}
                  </select>
                  {templates.length === 0 && (
                    <span style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>
                      No approved templates yet. <Link to="/wellness/whatsapp/templates" style={{ color: 'var(--primary-color, #25D366)' }}>Create one</Link> first.
                    </span>
                  )}
                </label>

                {selectedTemplateName && (() => {
                  const tpl = templates.find((t) => t.name === selectedTemplateName);
                  return (
                    <>
                      <div style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid var(--border-color)', borderRadius: 6, padding: '0.6rem 0.8rem', marginBottom: '0.75rem', fontSize: '0.82rem', whiteSpace: 'pre-wrap' }}>
                        {tpl.body}
                      </div>
                      {templateParams.map((val, idx) => (
                        <label key={idx} style={{ display: 'block', marginBottom: '0.5rem' }}>
                          <span style={{ fontSize: '0.78rem', fontWeight: 600, color: 'var(--text-secondary)', display: 'block', marginBottom: 4 }}>
                            Variable {`{{${idx + 1}}}`}
                          </span>
                          <input
                            value={val}
                            onChange={(e) => {
                              const next = [...templateParams];
                              next[idx] = e.target.value;
                              setTemplateParams(next);
                            }}
                            className="input-field"
                            style={{ width: '100%', fontSize: '0.88rem' }}
                            disabled={newSending}
                          />
                        </label>
                      ))}
                    </>
                  );
                })()}
              </>
            ) : (
              <label style={{ display: 'block', marginBottom: '0.75rem' }}>
                <span style={{ fontSize: '0.8rem', fontWeight: 600, color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '0.04em', display: 'block', marginBottom: 4 }}>
                  Message
                </span>
                <textarea
                  value={newBody}
                  onChange={(e) => setNewBody(e.target.value)}
                  rows={4}
                  placeholder="Hi! Just checking in…"
                  className="input-field"
                  style={{ width: '100%', fontSize: '0.9rem', fontFamily: 'inherit', resize: 'vertical' }}
                  disabled={newSending}
                />
              </label>
            )}

            {newError && (
              <div style={{
                background: 'rgba(220,38,38,0.1)', color: '#dc2626',
                border: '1px solid rgba(220,38,38,0.3)',
                padding: '0.6rem 0.8rem', borderRadius: 6,
                fontSize: '0.8rem', marginBottom: '0.75rem', lineHeight: 1.5,
              }}>
                {newError}
              </div>
            )}

            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '0.5rem' }}>
              <button
                onClick={() => setShowNewModal(false)}
                disabled={newSending}
                className="btn-secondary"
                style={{ padding: '0.5rem 1rem', fontSize: '0.85rem' }}
              >
                Cancel
              </button>
              <button
                onClick={sendNewMessage}
                disabled={newSending || !newPhone.trim() || !newBody.trim()}
                style={{
                  padding: '0.5rem 1rem', fontSize: '0.85rem',
                  background: 'var(--primary-color, #25D366)', color: '#fff',
                  border: 'none', borderRadius: 6, fontWeight: 600,
                  cursor: newSending ? 'not-allowed' : 'pointer',
                  opacity: newSending ? 0.6 : 1,
                  display: 'flex', alignItems: 'center', gap: 6,
                }}
              >
                <Send size={14} />
                {newSending ? 'Sending…' : 'Send'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
