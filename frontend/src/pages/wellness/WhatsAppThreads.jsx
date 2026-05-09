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

import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  MessageCircle,
  Search,
  Send,
  CheckCheck,
  Clock,
  XCircle,
  UserCheck,
  Ban,
  RefreshCw,
} from 'lucide-react';
import { fetchApi } from '../../utils/api';
import { useNotify } from '../../utils/notify';

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

  // ─── Load detail when selection changes ────────────────────
  useEffect(() => {
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

  const assignToMe = async () => {
    if (!detail?.thread) return;
    try {
      // Backend RBAC check: self-assign (targetUserId === req.user.userId)
      // is open to all roles. Send the current user's id so the route can
      // gate cross-assign vs self-assign.
      //
      // NOTE per CLAUDE.md "Standing rules" + backend route comment: the
      // global stripDangerous middleware deletes req.body.userId on every
      // request, so the field MUST be `targetUserId` — `userId` is silently
      // dropped to undefined and the backend would unassign instead.
      const me = JSON.parse(localStorage.getItem('user') || 'null');
      if (!me?.id) {
        notify.error('Cannot determine your user id. Re-login.');
        return;
      }
      await fetchApi(`/api/whatsapp/threads/${detail.thread.id}/assign`, {
        method: 'POST',
        body: JSON.stringify({ targetUserId: me.id }),
      });
      const fresh = await fetchApi(`/api/whatsapp/threads/${selectedId}`);
      setDetail(fresh);
      loadList();
    } catch (err) {
      notify.error(err.message || 'Failed to assign.');
    }
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
      display: 'flex', height: 'calc(100vh - var(--top-nav-height, 0px))',
      gap: 0, animation: 'fadeIn 0.4s ease-out',
    }}>
      {/* ─── Left rail ─── */}
      <aside style={{
        width: 360, borderRight: '1px solid var(--border-color)',
        display: 'flex', flexDirection: 'column', minWidth: 0,
      }}>
        <header style={{ padding: '1rem', borderBottom: '1px solid var(--border-color)' }}>
          <h2 style={{
            display: 'flex', alignItems: 'center', gap: 8,
            fontSize: '1.15rem', fontWeight: 700, marginBottom: '0.75rem',
          }}>
            <MessageCircle size={20} color="var(--primary-color, var(--accent-color))" />
            WhatsApp Threads
          </h2>
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
            {/* Header */}
            <header style={{
              padding: '1rem 1.5rem', borderBottom: '1px solid var(--border-color)',
              display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap',
            }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <h2 style={{
                  fontSize: '1.05rem', fontWeight: 700, display: 'flex',
                  alignItems: 'center', gap: 6, marginBottom: 2,
                }}>
                  {detail.thread.contact?.name || detail.thread.patient?.name || detail.thread.contactPhone}
                  <StatusPill status={detail.thread.status} />
                </h2>
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
                    marginTop: 6, display: 'inline-flex', alignItems: 'center', gap: 5,
                  }}>
                    <Ban size={12} /> Opted out ({detail.optedOut.reason})
                    on {new Date(detail.optedOut.capturedAt).toLocaleDateString()}
                  </p>
                )}
              </div>
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                <button onClick={assignToMe} className="btn-secondary" style={{ fontSize: '0.8rem', padding: '0.4rem 0.75rem', display: 'flex', alignItems: 'center', gap: 4 }}>
                  <UserCheck size={14} /> Assign to me
                </button>
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

            {/* Messages */}
            <div style={{
              flex: 1, overflowY: 'auto', padding: '1.5rem',
              display: 'flex', flexDirection: 'column', gap: 10,
              background: 'var(--bg-color, #0a0a0a)',
            }}>
              {(detail.messages || []).map((m) => {
                const isOutbound = m.direction === 'OUTBOUND';
                return (
                  <div
                    key={m.id}
                    style={{
                      maxWidth: '70%',
                      alignSelf: isOutbound ? 'flex-end' : 'flex-start',
                      background: isOutbound
                        ? 'var(--primary-color, var(--accent-color))'
                        : 'var(--card-bg, #1a1a1a)',
                      color: isOutbound ? '#fff' : 'var(--text-primary)',
                      padding: '0.6rem 0.85rem', borderRadius: 12,
                      fontSize: '0.9rem', lineHeight: 1.4,
                      wordBreak: 'break-word',
                    }}
                  >
                    <div>{m.body || <em style={{ opacity: 0.6 }}>(media)</em>}</div>
                    <div style={{
                      fontSize: '0.65rem', opacity: 0.65, marginTop: 4,
                      textAlign: isOutbound ? 'right' : 'left',
                    }}>
                      {new Date(m.createdAt).toLocaleString()} · {m.status}
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
  );
}
