// WhatsApp Threads — agent inbox for 2-way WhatsApp messaging.
//
// Wave 2 Agent KK companion to the backend's /api/whatsapp/threads + /opt-outs
// endpoints. Implements:
//   - Left rail with three tabs (All / Unread / Blocked), search box (phone or
//     contact name)
//   - Right pane with the selected thread's last 50 messages, reply textarea,
//     "Assign to me" / "Close" / "Snooze" / "Mark read" buttons
//   - Opt-out indicator chip + disabled reply box if the contact is opted out
//   - Unread badge in the left rail entries
//   - Meta 24-hour send-window banner + free-form gating outside the window
//   - Template picker modal with {{variable}} substitution from active
//     thread's contact / patient
//
// Lives under /wellness/whatsapp because the audit-call gap was wellness-
// vertical-shaped (clinics on Meta Cloud API), but the routes themselves
// are tenant-agnostic — adding a generic /whatsapp link later is one line.
//
// Zylu-Gap closures
// -----------------
//   #796 WA-001 — 3-tab layout (All / Unread / Blocked) with per-tab counts.
//                 Blocked tab renders rows from /api/whatsapp/opt-outs.
//   #797 WA-002 — Template picker (button in compose toolbar) + {{var}}
//                 substitution from active thread's patient / contact name.
//   #798 WA-003 — 24-hour send-window banner — green while inside, red
//                 outside, with a hint to use a template; compose textarea
//                 disabled outside window (forces template send). Server-
//                 side already enforces this with 422 OUTSIDE_24H_WINDOW
//                 (routes/whatsapp.js:138).

import React, { useEffect, useMemo, useRef, useState } from 'react';
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
  FileText,
  X,
} from 'lucide-react';
import { fetchApi } from '../../utils/api';
import { useNotify } from '../../utils/notify';

// #796 — All / Unread / Blocked tab layout. The old STATUS_OPTIONS dropdown
// was replaced; the underlying backend filters still support per-status
// filtering, but the Zylu reference uses these three buckets as the
// primary surface. Status drill-downs (Open / Snoozed / Closed) are
// available via search + thread-detail status pill.
const TABS = [
  { value: 'all', label: 'All' },
  { value: 'unread', label: 'Unread' },
  { value: 'blocked', label: 'Blocked' },
];

const TWENTY_FOUR_HOURS_MS = 24 * 3600 * 1000;

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

// #798 — compute whether free-form sends are inside Meta's 24-hour window.
// Source of truth is the latest INBOUND message in the thread detail's
// `messages` array. Falls back to `thread.lastInboundAt` if present
// (schema.prisma:1362), otherwise null = no inbound = window CLOSED.
function compute24hWindow(detail) {
  if (!detail) return { open: false, lastInboundAt: null, msUntilClose: 0 };
  // Latest inbound from the messages window first (most accurate; the
  // /threads/:id response only returns the last 50 messages but that's
  // also Meta's hard cutoff so a 24h-old inbound is always either inside
  // the 50 or outside the window).
  let lastInboundAt = null;
  if (Array.isArray(detail.messages)) {
    for (let i = detail.messages.length - 1; i >= 0; i--) {
      const m = detail.messages[i];
      if (m && m.direction === 'INBOUND' && m.createdAt) {
        if (!lastInboundAt || new Date(m.createdAt) > new Date(lastInboundAt)) {
          lastInboundAt = m.createdAt;
        }
      }
    }
  }
  if (!lastInboundAt && detail.thread?.lastInboundAt) {
    lastInboundAt = detail.thread.lastInboundAt;
  }
  if (!lastInboundAt) {
    return { open: false, lastInboundAt: null, msUntilClose: 0 };
  }
  const elapsed = Date.now() - new Date(lastInboundAt).getTime();
  const msUntilClose = TWENTY_FOUR_HOURS_MS - elapsed;
  return {
    open: msUntilClose > 0,
    lastInboundAt,
    msUntilClose: Math.max(0, msUntilClose),
  };
}

function formatHoursMins(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return '0m';
  const totalMins = Math.round(ms / 60_000);
  const h = Math.floor(totalMins / 60);
  const m = totalMins % 60;
  if (h <= 0) return `${m}m`;
  return `${h}h ${m}m`;
}

// #797 — apply {{variable}} substitution to a template body, sourcing values
// from the active thread's contact + patient. Unknown variables are left
// in-place (so the user can still see them and supply manually).
//
// Supported variables (case-insensitive, also matches snake/space variants):
//   name / customer_name / contact_name / patient_name   → contact or patient name
//   first_name                                            → first whitespace-token of name
//   phone                                                 → contact phone
function substituteTemplateVars(body, ctx) {
  if (!body) return '';
  // `ctx` is the thread-detail envelope { thread, messages, optedOut }; the
  // contact/patient live under `thread`. Accept either shape so the helper
  // is also usable on a bare thread object.
  const thread = ctx?.thread || ctx || {};
  const name = thread?.contact?.name || thread?.patient?.name || '';
  const phone = thread?.contactPhone || '';
  const firstName = name ? String(name).trim().split(/\s+/)[0] : '';
  return String(body).replace(/\{\{\s*([^}]+?)\s*\}\}/g, (full, raw) => {
    const key = String(raw).toLowerCase().replace(/[\s_-]+/g, '');
    if (key === 'name' || key === 'customername' || key === 'contactname' || key === 'patientname') {
      return name || full;
    }
    if (key === 'firstname') {
      return firstName || full;
    }
    if (key === 'phone' || key === 'mobile') {
      return phone || full;
    }
    return full;
  });
}

// #797 — return the list of unresolved {{variables}} after substitution, so
// the picker can flag the operator if they need to fill blanks before send.
function unresolvedVars(text) {
  const out = [];
  const re = /\{\{\s*([^}]+?)\s*\}\}/g;
  let m;
  while ((m = re.exec(text || '')) !== null) {
    out.push(m[1].trim());
  }
  return out;
}

export default function WhatsAppThreads() {
  const notify = useNotify();
  const [threads, setThreads] = useState([]);
  const [loadingList, setLoadingList] = useState(true);
  // #796 — replaces statusFilter + unreadOnly with a single tab selector.
  const [tab, setTab] = useState('all');
  const [q, setQ] = useState('');
  const [selectedId, setSelectedId] = useState(null);
  const [detail, setDetail] = useState(null);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [reply, setReply] = useState('');
  const [sending, setSending] = useState(false);
  const messagesEndRef = useRef(null);

  // #796 — Blocked-tab data (rows from /api/whatsapp/opt-outs). Kept separate
  // from `threads` because the shape is different (opt-out rows have no
  // status / unreadCount / lastMessageAt).
  const [blocked, setBlocked] = useState([]);
  const [loadingBlocked, setLoadingBlocked] = useState(false);
  // Lightweight counters for the tab strip — refreshed on every list reload
  // so badges stay honest after sends / mark-reads / opt-outs.
  const [counts, setCounts] = useState({ all: 0, unread: 0, blocked: 0 });

  // #797 — Template picker modal state.
  const [showTemplatePicker, setShowTemplatePicker] = useState(false);
  const [templates, setTemplates] = useState([]);
  const [loadingTemplates, setLoadingTemplates] = useState(false);
  const [templatesLoaded, setTemplatesLoaded] = useState(false);

  // ─── Load thread list ──────────────────────────────────────
  const loadList = async () => {
    setLoadingList(true);
    try {
      const params = new URLSearchParams({ limit: '50' });
      if (tab === 'unread') params.set('unread', 'true');
      if (q.trim()) params.set('q', q.trim());
      const data = await fetchApi(`/api/whatsapp/threads?${params.toString()}`);
      const rows = Array.isArray(data?.threads) ? data.threads : [];
      setThreads(rows);
      // Maintain counts off whichever rows we just fetched. The unread tab
      // already filtered to unread > 0 so its count is the row total;
      // the all tab carries the same set with all statuses.
      setCounts((prev) => ({
        ...prev,
        all: tab === 'all' ? rows.length : prev.all,
        unread: tab === 'unread' ? rows.length : prev.unread,
      }));
    } catch (err) {
      notify.error(err.message || 'Failed to load threads.');
      setThreads([]);
    }
    setLoadingList(false);
  };

  // #796 — load opt-outs when the Blocked tab is active. Also refreshes
  // the badge count so the chip stays accurate.
  const loadBlocked = async () => {
    setLoadingBlocked(true);
    try {
      const data = await fetchApi('/api/whatsapp/opt-outs?limit=100');
      const rows = Array.isArray(data?.optOuts) ? data.optOuts : [];
      setBlocked(rows);
      setCounts((prev) => ({ ...prev, blocked: rows.length }));
    } catch (err) {
      notify.error(err.message || 'Failed to load blocked numbers.');
      setBlocked([]);
    }
    setLoadingBlocked(false);
  };

  useEffect(() => {
    if (tab === 'blocked') {
      loadBlocked();
    } else {
      loadList();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab]);

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

  // #798 — 24h send-window state for the currently-open thread.
  const sendWindow = useMemo(() => compute24hWindow(detail), [detail]);

  // ─── Actions ──────────────────────────────────────────────
  const handleSearch = (e) => {
    e.preventDefault();
    if (tab === 'blocked') {
      loadBlocked();
    } else {
      loadList();
    }
  };

  const sendReply = async () => {
    if (!detail?.thread || !reply.trim() || sending) return;
    if (detail.optedOut) {
      notify.error('Contact has opted out — replies are blocked.');
      return;
    }
    // #798 — client-side guard mirrors backend's 24h enforcement so the
    // operator sees a clear error before paying a round-trip to Meta. The
    // backend still returns 422 OUTSIDE_24H_WINDOW as the authoritative
    // gate (routes/whatsapp.js:145).
    if (!sendWindow.open) {
      notify.error('24-hour window closed — pick an approved template to send.');
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
      } else if (msg.includes('OUTSIDE_24H_WINDOW')) {
        notify.error('24-hour window closed — pick an approved template to send.');
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

  // #797 — open template picker. Lazy-fetch templates on first open so the
  // page isn't paying the round-trip every load.
  const openTemplatePicker = async () => {
    setShowTemplatePicker(true);
    if (templatesLoaded || loadingTemplates) return;
    setLoadingTemplates(true);
    try {
      const data = await fetchApi('/api/whatsapp/templates');
      const rows = Array.isArray(data) ? data : (Array.isArray(data?.templates) ? data.templates : []);
      setTemplates(rows);
      setTemplatesLoaded(true);
    } catch (err) {
      notify.error(err.message || 'Failed to load templates.');
      setTemplates([]);
    }
    setLoadingTemplates(false);
  };

  // #797 — apply the chosen template to the reply box. Substitutes any
  // known variables from the active thread; leaves unknowns as-is so the
  // operator can fill them. If the 24h window is closed, send via the
  // template-name path (backend recognises templateName + parameters);
  // otherwise just dump the substituted body into the textarea so the
  // operator can edit before Send.
  // Renamed from `useTemplate` (which tripped react-hooks/rules-of-hooks
  // because the eslint rule treats any `use*` name as a hook call site).
  const applyTemplate = (tpl) => {
    if (!tpl) return;
    const substituted = substituteTemplateVars(tpl.body || '', detail);
    setReply(substituted);
    setShowTemplatePicker(false);
    const remaining = unresolvedVars(substituted);
    if (remaining.length > 0) {
      notify.info?.(`Fill remaining variables: ${remaining.map((v) => `{{${v}}}`).join(', ')}`);
    }
  };

  // ─── Render ─────────────────────────────────────────────
  // Threads in the All tab include opted-out contacts; the Unread tab is
  // unreadCount > 0; the Blocked tab renders opt-out rows directly.
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
          {/* #796 — All / Unread / Blocked tab strip. */}
          <div
            role="tablist"
            aria-label="Thread filter"
            data-testid="whatsapp-thread-tabs"
            style={{ display: 'flex', gap: 4, marginBottom: '0.75rem', borderBottom: '1px solid var(--border-color)' }}
          >
            {TABS.map((t) => {
              const isActive = t.value === tab;
              const count = counts[t.value] ?? 0;
              return (
                <button
                  key={t.value}
                  role="tab"
                  aria-selected={isActive}
                  data-testid={`whatsapp-tab-${t.value}`}
                  onClick={() => setTab(t.value)}
                  style={{
                    flex: 1,
                    padding: '0.5rem 0.25rem',
                    background: 'transparent',
                    border: 'none',
                    borderBottom: isActive
                      ? '2px solid var(--primary-color, var(--accent-color))'
                      : '2px solid transparent',
                    color: isActive ? 'var(--primary-color, var(--accent-color))' : 'var(--text-secondary)',
                    fontWeight: isActive ? 700 : 500,
                    fontSize: '0.85rem',
                    cursor: 'pointer',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    gap: 6,
                  }}
                >
                  {t.label}
                  <span
                    style={{
                      background: isActive
                        ? 'var(--primary-color, var(--accent-color))'
                        : 'rgba(107,114,128,0.2)',
                      color: isActive ? '#fff' : 'var(--text-secondary)',
                      padding: '1px 7px',
                      borderRadius: 10,
                      fontSize: '0.65rem',
                      fontWeight: 700,
                      minWidth: 18,
                      textAlign: 'center',
                    }}
                  >
                    {count}
                  </span>
                </button>
              );
            })}
          </div>
          <form onSubmit={handleSearch} style={{ display: 'flex', gap: 6, marginBottom: '0.25rem' }}>
            <div style={{ flex: 1, position: 'relative' }}>
              <Search size={14} style={{
                position: 'absolute', left: 8, top: '50%', transform: 'translateY(-50%)',
                color: 'var(--text-secondary)',
              }} />
              <input
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder={tab === 'blocked' ? 'Phone prefix' : 'Phone or contact name'}
                className="input-field"
                style={{ paddingLeft: 26, fontSize: '0.85rem' }}
              />
            </div>
            <button type="submit" className="btn-secondary" style={{ padding: '0.4rem 0.75rem' }}>Go</button>
            <button
              onClick={() => (tab === 'blocked' ? loadBlocked() : loadList())}
              type="button"
              className="btn-secondary"
              style={{ padding: '0.35rem', display: 'flex' }}
              title="Refresh"
            >
              <RefreshCw size={14} />
            </button>
          </form>
        </header>

        <div style={{ flex: 1, overflowY: 'auto' }}>
          {tab === 'blocked' ? (
            loadingBlocked ? (
              <p style={{ padding: '1rem', color: 'var(--text-secondary)', textAlign: 'center' }}>Loading…</p>
            ) : blocked.length === 0 ? (
              <p style={{ padding: '2rem 1rem', color: 'var(--text-secondary)', textAlign: 'center', fontSize: '0.9rem' }}>
                No blocked numbers.
              </p>
            ) : (
              blocked.map((b) => (
                <div
                  key={b.id}
                  data-testid={`whatsapp-blocked-row-${b.id}`}
                  style={{
                    padding: '0.85rem 1rem',
                    borderBottom: '1px solid var(--border-color)',
                    display: 'flex', flexDirection: 'column', gap: 4,
                  }}
                >
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 6 }}>
                    <span style={{ fontWeight: 600, fontSize: '0.9rem' }}>{b.contactPhone}</span>
                    <span style={{
                      background: 'rgba(239,68,68,0.12)', color: '#dc2626',
                      padding: '1px 7px', borderRadius: 10, fontSize: '0.7rem', fontWeight: 700,
                    }}>
                      <Ban size={11} style={{ verticalAlign: 'middle', marginRight: 3 }} />
                      {b.reason || 'BLOCKED'}
                    </span>
                  </div>
                  <span style={{ fontSize: '0.7rem', color: 'var(--text-secondary)' }}>
                    Blocked {timeAgo(b.capturedAt)}
                  </span>
                </div>
              ))
            )
          ) : loadingList ? (
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
        {tab === 'blocked' && !selectedId ? (
          <div style={{
            flex: 1, display: 'flex', flexDirection: 'column',
            alignItems: 'center', justifyContent: 'center',
            color: 'var(--text-secondary)', gap: 8, padding: '2rem',
          }}>
            <Ban size={48} color="var(--text-secondary)" />
            <p>Blocked numbers cannot be replied to. Use the Manage page to remove.</p>
          </div>
        ) : !selectedId ? (
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

            {/* #798 — Meta 24h window banner. Only shown when no opt-out
                gate is already active (opt-out is the harder stop). */}
            {!detail.optedOut && (
              <div
                role="status"
                data-testid="whatsapp-24h-banner"
                data-window-open={sendWindow.open ? 'true' : 'false'}
                style={{
                  padding: '0.55rem 1.5rem',
                  background: sendWindow.open
                    ? 'rgba(16,185,129,0.10)'
                    : 'rgba(239,68,68,0.10)',
                  color: sendWindow.open ? '#10b981' : '#dc2626',
                  borderBottom: '1px solid var(--border-color)',
                  fontSize: '0.78rem',
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  flexWrap: 'wrap',
                }}
              >
                {sendWindow.open ? (
                  <>
                    <CheckCheck size={14} />
                    <strong>24-hour window open</strong>
                    <span>
                      — free-form replies allowed for another {formatHoursMins(sendWindow.msUntilClose)}
                      {sendWindow.lastInboundAt && (
                        <> (closes {new Date(new Date(sendWindow.lastInboundAt).getTime() + TWENTY_FOUR_HOURS_MS).toLocaleString()})</>
                      )}
                    </span>
                  </>
                ) : (
                  <>
                    <AlertTriangle size={14} />
                    <strong>24-hour window closed</strong>
                    <span>— only approved templates can be sent outside the window. Pick a template to re-engage.</span>
                  </>
                )}
              </div>
            )}

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
                <>
                  {/* #797 — compose toolbar: Templates picker button. */}
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
                    <button
                      type="button"
                      onClick={openTemplatePicker}
                      data-testid="whatsapp-pick-template"
                      className="btn-secondary"
                      style={{ fontSize: '0.75rem', padding: '0.3rem 0.6rem', display: 'flex', alignItems: 'center', gap: 4 }}
                      title="Pick a pre-approved template"
                    >
                      <FileText size={13} /> Templates
                    </button>
                    {!sendWindow.open && (
                      <span style={{ fontSize: '0.7rem', color: '#dc2626' }}>
                        Outside 24h window — template required.
                      </span>
                    )}
                  </div>
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
                      placeholder={sendWindow.open
                        ? 'Type a reply… (Ctrl+Enter to send)'
                        : '24-hour window closed — pick a template to re-engage'}
                      className="input-field"
                      disabled={!sendWindow.open}
                      data-testid="whatsapp-reply-textarea"
                      style={{
                        flex: 1, minHeight: 44, resize: 'vertical', fontSize: '0.9rem',
                        opacity: sendWindow.open ? 1 : 0.6,
                      }}
                    />
                    <button
                      onClick={sendReply}
                      disabled={sending || !reply.trim() || !sendWindow.open}
                      className="btn-primary"
                      style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '0 1rem' }}
                    >
                      <Send size={16} /> {sending ? 'Sending…' : 'Send'}
                    </button>
                  </div>
                </>
              )}
            </footer>
          </>
        )}
      </main>

      {/* #797 — Template picker modal. Lists Meta-approved templates and lets
          the operator preview the substituted body before applying. */}
      {showTemplatePicker && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Pick WhatsApp template"
          data-testid="whatsapp-template-modal"
          style={{
            position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)',
            zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center',
            padding: '2rem',
          }}
          onClick={(e) => { if (e.target === e.currentTarget) setShowTemplatePicker(false); }}
        >
          <div style={{
            background: 'var(--card-bg, #1a1a1a)', color: 'var(--text-primary)',
            borderRadius: 12, width: 'min(560px, 100%)', maxHeight: '80vh',
            display: 'flex', flexDirection: 'column', overflow: 'hidden',
            border: '1px solid var(--border-color)',
          }}>
            <header style={{
              padding: '1rem 1.25rem', borderBottom: '1px solid var(--border-color)',
              display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8,
            }}>
              <h3 style={{ fontSize: '1rem', fontWeight: 700, margin: 0, display: 'flex', alignItems: 'center', gap: 6 }}>
                <FileText size={16} /> Pick template
              </h3>
              <button
                onClick={() => setShowTemplatePicker(false)}
                aria-label="Close template picker"
                style={{ background: 'transparent', border: 'none', color: 'var(--text-secondary)', cursor: 'pointer' }}
              >
                <X size={18} />
              </button>
            </header>
            <div style={{ flex: 1, overflowY: 'auto', padding: '0.75rem 1.25rem' }}>
              {loadingTemplates ? (
                <p style={{ textAlign: 'center', padding: '2rem', color: 'var(--text-secondary)' }}>Loading templates…</p>
              ) : templates.length === 0 ? (
                <p style={{ textAlign: 'center', padding: '2rem', color: 'var(--text-secondary)', fontSize: '0.85rem' }}>
                  No templates configured. Add one under Settings → WhatsApp Templates.
                </p>
              ) : (
                templates.map((tpl) => {
                  const preview = substituteTemplateVars(tpl.body || '', detail);
                  const remaining = unresolvedVars(preview);
                  const approved = (tpl.status || '').toUpperCase() === 'APPROVED';
                  return (
                    <div
                      key={tpl.id}
                      data-testid={`whatsapp-template-row-${tpl.id}`}
                      style={{
                        padding: '0.75rem',
                        border: '1px solid var(--border-color)',
                        borderRadius: 8,
                        marginBottom: 8,
                        display: 'flex',
                        flexDirection: 'column',
                        gap: 6,
                      }}
                    >
                      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
                        <strong style={{ fontSize: '0.9rem' }}>{tpl.name}</strong>
                        <span
                          style={{
                            background: approved ? 'rgba(16,185,129,0.15)' : 'rgba(245,158,11,0.15)',
                            color: approved ? '#10b981' : '#f59e0b',
                            padding: '1px 7px', borderRadius: 10, fontSize: '0.65rem', fontWeight: 700,
                          }}
                        >
                          {tpl.status || 'PENDING'}
                        </span>
                      </div>
                      <p style={{
                        fontSize: '0.8rem', color: 'var(--text-secondary)', margin: 0,
                        whiteSpace: 'pre-wrap', wordBreak: 'break-word',
                      }}>
                        {preview}
                      </p>
                      {remaining.length > 0 && (
                        <p style={{ fontSize: '0.7rem', color: '#f59e0b', margin: 0 }}>
                          Unresolved variables: {remaining.map((v) => `{{${v}}}`).join(', ')}
                        </p>
                      )}
                      <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
                        <button
                          type="button"
                          onClick={() => applyTemplate(tpl)}
                          data-testid={`whatsapp-template-use-${tpl.id}`}
                          className="btn-primary"
                          style={{ fontSize: '0.75rem', padding: '0.3rem 0.75rem' }}
                        >
                          Use this template
                        </button>
                      </div>
                    </div>
                  );
                })
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
