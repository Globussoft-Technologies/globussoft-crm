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
import { io as socketIO } from 'socket.io-client';
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
  Trash2,
  Reply,
  Forward,
  Smile,
  Paperclip,
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
  // Not a thread status — selecting this lists blocked numbers (opt-outs)
  // from /api/whatsapp/opt-outs instead of filtering threads. Handled
  // specially in loadList + the row renderer.
  { value: 'BLOCKED', label: 'Blocked' },
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

// Small context-menu row used by the right-click message menu.
function CtxMenuItem({ icon, label, color, onClick }) {
  return (
    <button
      onClick={onClick}
      style={{
        display: 'flex', alignItems: 'center', gap: 8,
        width: '100%', padding: '0.5rem 0.75rem',
        background: 'transparent', border: 'none',
        cursor: 'pointer', textAlign: 'left',
        color: color || 'var(--text-primary)',
        fontSize: '0.85rem', borderRadius: 4,
      }}
      onMouseEnter={(e) => e.currentTarget.style.background = 'var(--hover-bg)'}
      onMouseLeave={(e) => e.currentTarget.style.background = 'transparent'}
    >
      {icon}
      {label}
    </button>
  );
}

// Render an inline preview for media messages. The backend (cron/
// whatsappMediaEngine.js) downloads Meta media → uploads to S3 →
// stores the S3 URL on WhatsAppMessage.mediaUrl. Until the cron
// processes the job, mediaUrl is `meta:<id>` (placeholder); we
// show "Loading media…" for those.
function MessageMedia({ message }) {
  const url = message.mediaUrl || '';
  const type = (message.mediaType || message.metaType || '').toLowerCase();
  if (url.startsWith('meta:')) {
    return <em style={{ opacity: 0.6, fontSize: '0.8rem' }}>Loading media…</em>;
  }
  if (!url) return <em style={{ opacity: 0.6 }}>(media)</em>;
  if (type.startsWith('image')) {
    return (
      <a href={url} target="_blank" rel="noreferrer">
        <img
          src={url}
          alt="media"
          style={{ maxWidth: '100%', maxHeight: 300, borderRadius: 8, display: 'block' }}
        />
      </a>
    );
  }
  if (type.startsWith('video')) {
    return (
      <video controls preload="metadata" style={{ maxWidth: '100%', maxHeight: 320, borderRadius: 8 }}>
        <source src={url} type={message.mediaType || undefined} />
        Your browser cannot play this video. <a href={url} target="_blank" rel="noreferrer">Download</a>
      </video>
    );
  }
  if (type.startsWith('audio') || type === 'voice') {
    return (
      <audio controls preload="metadata" style={{ maxWidth: '100%' }}>
        <source src={url} type={message.mediaType || undefined} />
        Your browser cannot play this audio. <a href={url} target="_blank" rel="noreferrer">Download</a>
      </audio>
    );
  }
  // Document / generic — download link
  const filename = url.split('/').pop() || 'attachment';
  return (
    <a
      href={url}
      target="_blank"
      rel="noreferrer"
      style={{
        display: 'inline-flex', alignItems: 'center', gap: 6,
        padding: '0.4rem 0.6rem', borderRadius: 6,
        background: 'var(--surface-color)',
        color: 'var(--text-primary)',
        textDecoration: 'none',
        fontSize: '0.82rem',
      }}
    >
      📎 {filename}
    </a>
  );
}

function StatusPill({ status }) {
  const map = {
    OPEN: { bg: 'rgba(16,185,129,0.15)', fg: '#10b981', label: 'Open' },
    PENDING_AGENT: { bg: 'rgba(245,158,11,0.15)', fg: '#f59e0b', label: 'Pending' },
    SNOOZED: { bg: 'rgba(99,102,241,0.15)', fg: '#6366f1', label: 'Snoozed' },
    CLOSED: { bg: 'rgba(107,114,128,0.15)', fg: '#6b7280', label: 'Closed' },
    BLOCKED: { bg: 'rgba(239,68,68,0.15)', fg: '#dc2626', label: 'Blocked' },
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
  // The message being replied-to (set by Reply in the right-click menu).
  // Renders as a WhatsApp-style quoted preview above the composer; nulled
  // when sent or when the user dismisses via the X button.
  const [replyToMsg, setReplyToMsg] = useState(null);
  // Unblock reason modal state — replaces the browser-native window.prompt
  // which looked off-theme. The modal collects the DPDP §11 audit reason
  // (min 10 chars) before calling DELETE /opt-outs/:id.
  const [unblockOpen, setUnblockOpen] = useState(false);
  const [unblockReason, setUnblockReason] = useState('');
  const [unblockSaving, setUnblockSaving] = useState(false);
  const [unblockError, setUnblockError] = useState(null);
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

  // ─── Contacts + Patients with phone numbers — for the contact picker
  //     in the New Message modal. Fetched once on mount so the dropdown
  //     can filter client-side as the user types. Combines two sources
  //     so a wellness operator picks from both lead/customer contacts
  //     AND existing patients without two separate inputs.
  const [contactOptions, setContactOptions] = useState([]);
  // Whether the typed-phone input's dropdown is showing
  const [pickerOpen, setPickerOpen] = useState(false);

  // Track the lastMessageAt of the currently-selected thread between
  // loadList calls so we can detect "a new message arrived on the open
  // thread" purely from polling — without depending on the socket event.
  // This is the safety net that makes real-time work even when the
  // socket is dropped / the backend hasn't been restarted with the fix.
  const lastSelectedMessageAtRef = useRef(null);
  // Mirror selectedId in a ref so callbacks (loadList, socket handlers)
  // see the latest value without recreating themselves. Declared up here
  // because both loadList AND the socket effect need to read it.
  const selectedIdRef = useRef(null);

  // ─── Load thread list ──────────────────────────────────────
  const loadList = async () => {
    setLoadingList(true);
    try {
      // "Blocked" isn't a thread status — it lists the tenant's opt-out
      // (blocked) numbers. Fetch from /opt-outs and map each row into the
      // thread-shaped object the left rail already knows how to render. The
      // `_blocked` marker drives the red pill + click-to-open behaviour.
      if (statusFilter === 'BLOCKED') {
        const params = new URLSearchParams({ limit: '100' });
        if (q.trim()) params.set('phone', q.trim());
        const data = await fetchApi(`/api/whatsapp/opt-outs?${params.toString()}`);
        const optOuts = Array.isArray(data?.optOuts) ? data.optOuts : [];
        setThreads(optOuts.map((o) => ({
          id: `optout-${o.id}`,
          contactPhone: o.contactPhone,
          status: 'BLOCKED',
          lastMessageAt: o.capturedAt,
          unreadCount: 0,
          _blocked: o,
        })));
        setLoadingList(false);
        return;
      }

      const params = new URLSearchParams({ limit: '50' });
      if (statusFilter) params.set('status', statusFilter);
      if (unreadOnly) params.set('unread', 'true');
      if (q.trim()) params.set('q', q.trim());
      const data = await fetchApi(`/api/whatsapp/threads?${params.toString()}`);
      const fresh = Array.isArray(data?.threads) ? data.threads : [];
      setThreads(fresh);

      // ── Detect new message on the open thread ──────────────
      // If the lastMessageAt on the open thread advanced since the
      // last poll, a new message landed — show a toast so the user
      // notices even before scrolling. The detail refetch itself
      // happens in the parallel 10s polling effect.
      const selId = selectedIdRef.current;
      if (selId) {
        const selThread = fresh.find((t) => t.id === selId);
        if (selThread) {
          const newest = selThread.lastMessageAt ? new Date(selThread.lastMessageAt).getTime() : 0;
          const prev = lastSelectedMessageAtRef.current;
          if (prev != null && newest > prev) {
            try {
              notify.info(`New WhatsApp from ${selThread.contact?.name || selThread.contactPhone}`);
            } catch { /* ignore */ }
          }
          lastSelectedMessageAtRef.current = newest;
        }
      }
    } catch (err) {
      notify.error(err.message || 'Failed to load threads.');
      setThreads([]);
    }
    setLoadingList(false);
  };

  // Open the conversation behind a blocked number (rows in the Blocked list
  // are opt-out records, not threads, so their id can't be loaded directly).
  // Look the thread up by phone and select it if one exists — that opens the
  // right pane where an admin can Unblock. If the number was blocked without
  // ever messaging, there's no thread to show.
  const openBlockedThread = async (phone) => {
    try {
      const data = await fetchApi(`/api/whatsapp/threads?q=${encodeURIComponent(phone)}&limit=1`);
      const t = Array.isArray(data?.threads) ? data.threads[0] : null;
      if (t) setSelectedId(t.id);
      else notify.info('No conversation thread exists for this blocked number.');
    } catch (err) {
      notify.error(err.message || 'Failed to open thread.');
    }
  };

  useEffect(() => {
    loadList();
    // re-run on filter changes
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [statusFilter, unreadOnly]);

  // ─── Tick state for live "just now / 1m / 2m" timestamp updates ───
  // The `timeAgo()` helper reads Date.now() at render time. Without a
  // periodic re-render the thread badge would freeze on whatever value
  // it had when the list was last fetched. A cheap 30-second tick keeps
  // the relative timestamps current without needing to refetch the list.
  const [, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick((n) => n + 1), 30_000);
    return () => clearInterval(id);
  }, []);

  // ─── Browser desktop-notification permission ────────────────
  // Asked once on mount. The user must explicitly grant; we never nag.
  // Used in the socket handler below to alert when a message arrives
  // even if the operator is on another tab or another app.
  useEffect(() => {
    if (typeof window === 'undefined' || !('Notification' in window)) return;
    if (Notification.permission === 'default') {
      Notification.requestPermission().catch(() => { /* ignore — user denied */ });
    }
  }, []);

  // ─── Aggressive safety-net polling ──────────────────────────
  // The socket is the IDEAL real-time channel, but it depends on the
  // backend mount order being correct + the network being stable. To
  // make the UX bulletproof — even if the socket is completely broken
  // — we poll BOTH the list AND the open detail every 10 seconds.
  // Worst-case lag for a new message becoming visible: ~10 seconds.
  // Cost: two lightweight GETs per user per 10s — negligible.
  useEffect(() => {
    const id = setInterval(() => {
      loadList();
      // Also refetch the currently-open detail so new bubbles appear
      // even without the socket event firing. The detail-fetch is
      // cheap (one thread + last 50 messages).
      const selId = selectedIdRef.current;
      if (selId) {
        fetchApi(`/api/whatsapp/threads/${selId}`)
          .then((fresh) => setDetail(fresh))
          .catch(() => { /* swallow — next tick retries */ });
      }
    }, 10_000);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [statusFilter, unreadOnly, q]);

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

  // ─── Load contacts + patients with phones (for the New Message
  //     contact picker). Two parallel fetches; combine + dedupe by
  //     phone. We tag the source so the dropdown can show whether a
  //     row is a contact or a patient (helpful in wellness mode).
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const opts = [];
      try {
        const contacts = await fetchApi('/api/contacts?limit=200');
        const list = Array.isArray(contacts) ? contacts : Array.isArray(contacts?.contacts) ? contacts.contacts : [];
        for (const c of list) {
          if (c.phone && c.name) opts.push({ id: `c-${c.id}`, name: c.name, phone: c.phone, source: 'contact' });
        }
      } catch { /* non-fatal */ }
      try {
        const patients = await fetchApi('/api/wellness/patients?limit=200');
        const list = Array.isArray(patients) ? patients : Array.isArray(patients?.patients) ? patients.patients : [];
        for (const p of list) {
          if (p.phone && p.name) opts.push({ id: `p-${p.id}`, name: p.name, phone: p.phone, source: 'patient' });
        }
      } catch { /* non-fatal — generic CRM tenants don't have patients */ }
      // Dedupe by phone — if same number exists in both contacts + patients,
      // prefer the patient label since wellness is the primary context here.
      const seen = new Map();
      for (const o of opts) {
        if (!seen.has(o.phone) || o.source === 'patient') seen.set(o.phone, o);
      }
      if (!cancelled) setContactOptions(Array.from(seen.values()));
    })();
    return () => { cancelled = true; };
  }, []);

  // ─── Real-time Socket.IO push for inbound messages + delivery
  //     status updates. The backend's whatsapp_webhook handler emits to
  //     room `tenant:<tenantId>` on every new inbound + status change;
  //     this hook joins the room and refreshes the list / detail when
  //     events fire. Falls back to manual refresh if the socket fails.
  //
  //     We deliberately use `selectedIdRef` instead of `selectedId` in
  //     the event handlers — closures over React state capture the value
  //     at subscribe time, so a stale `selectedId` would always be 0/null
  //     in the listener. The ref reads the latest value on every fire.
  //     (The ref itself is declared higher up so loadList can use it too.)
  useEffect(() => { selectedIdRef.current = selectedId; }, [selectedId]);

  useEffect(() => {
    const tenantId = currentUser?.tenantId;
    if (!tenantId) return undefined;

    // socket.io-client defaults to same-origin when no URL is passed —
    // works for both local dev (Vite proxy) and prod (same domain).
    const socket = socketIO({
      // withCredentials lets cookie-based session info travel if used;
      // harmless if absent. Path defaults to /socket.io.
      withCredentials: true,
      transports: ['websocket', 'polling'],
    });

    const joinRoom = () => socket.emit('join_room', `tenant:${tenantId}`);
    socket.on('connect', joinRoom);
    // Reconnects re-fire `connect` → room is re-joined automatically.

    socket.on('whatsapp:received', (payload) => {
      if (!payload || payload.tenantId !== tenantId) return;
      // Refresh thread list so the new (or bumped) thread surfaces.
      loadList();
      // If the operator is currently viewing the thread that just got
      // a new inbound message, refresh the detail view too so the
      // bubble appears without a manual click.
      if (selectedIdRef.current && selectedIdRef.current === payload.threadId) {
        (async () => {
          try {
            const fresh = await fetchApi(`/api/whatsapp/threads/${selectedIdRef.current}`);
            setDetail(fresh);
          } catch { /* swallow — manual refresh still works */ }
        })();
      }

      // ── User-visible alert layer ──────────────────────────────
      // In-app toast — useful even when the WhatsApp tab IS focused
      // so the operator notices the new message without scanning the
      // thread list. Capped at first 80 chars of body so a long inbound
      // doesn't blow up the toast container.
      const senderLabel = payload.contactPhone || payload.from || 'Unknown';
      const bodyPreview = (payload.body || '(media)').slice(0, 80);
      try {
        notify.info(`New WhatsApp from ${senderLabel}: ${bodyPreview}`);
      } catch { /* notify can throw on early-unmount; swallow */ }

      // Browser desktop notification — fires even when the tab isn't
      // focused / on another app. Only attempts if the user previously
      // granted permission (the mount-time request); we never re-ask.
      // Skip if the page is already visible to avoid double-notification
      // (toast already covers the foreground case).
      if (
        typeof window !== 'undefined' &&
        'Notification' in window &&
        Notification.permission === 'granted' &&
        document.visibilityState !== 'visible'
      ) {
        try {
          const n = new Notification(`WhatsApp · ${senderLabel}`, {
            body: bodyPreview,
            // Tag groups multiple notifications from the same sender so
            // a burst of 5 messages doesn't stack into 5 system alerts.
            tag: `wa-thread-${payload.threadId || payload.contactPhone}`,
            renotify: false,
          });
          // Clicking the notification focuses the browser tab so the
          // operator lands directly on the WhatsApp page.
          n.onclick = () => { window.focus(); n.close(); };
        } catch { /* some browsers throw if backgrounded; safe to ignore */ }
      }
    });

    socket.on('whatsapp:status', (payload) => {
      if (!payload || payload.tenantId !== tenantId) return;
      // A delivery / read receipt landed. Only need to refresh detail
      // if the operator is looking at the relevant thread.
      if (selectedIdRef.current) {
        (async () => {
          try {
            const fresh = await fetchApi(`/api/whatsapp/threads/${selectedIdRef.current}`);
            setDetail(fresh);
          } catch { /* swallow */ }
        })();
      }
    });

    socket.on('whatsapp:reaction', (payload) => {
      if (!payload || payload.tenantId !== tenantId) return;
      // Customer reacted to a message — refresh the open detail so
      // the new reaction pill renders without a manual refresh.
      if (selectedIdRef.current && selectedIdRef.current === payload.threadId) {
        (async () => {
          try {
            const fresh = await fetchApi(`/api/whatsapp/threads/${selectedIdRef.current}`);
            setDetail(fresh);
          } catch { /* swallow */ }
        })();
      }
    });

    socket.on('connect_error', (err) => {
      // Visible enough to debug if the socket falls over, but quiet
      // enough not to clutter the console during normal disconnects.
      console.warn('[whatsapp-socket] connect error:', err?.message);
    });

    return () => {
      socket.off('connect', joinRoom);
      socket.off('whatsapp:received');
      socket.off('whatsapp:status');
      socket.disconnect();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentUser?.tenantId]);

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
      // If this is a reply to another message, prefix the body with a
      // quoted block so the recipient sees the context (Meta's true
      // threaded reply via context.message_id is a future enhancement).
      let outBody = reply.trim();
      if (replyToMsg) {
        const quote = (replyToMsg.body || '(media)')
          .split('\n')
          .map((l) => `> ${l}`)
          .join('\n');
        outBody = `${quote}\n${outBody}`;
      }
      try {
        await fetchApi('/api/whatsapp/send', {
          method: 'POST',
          body: JSON.stringify({ to: detail.thread.contactPhone, body: outBody }),
        });
      } catch (sendErr) {
        const msg = sendErr?.message || '';
        // Meta 24h-window rejection — automatically open the template
        // picker with this thread's phone pre-filled instead of just
        // showing a toast. The operator can pick an approved template
        // and send without leaving the chat.
        if (msg.includes('OUTSIDE_24H_WINDOW')) {
          notify.error(
            'Last inbound from this contact was >24 hours ago. ' +
            'WhatsApp policy requires you to send an approved template — picker opening now.'
          );
          setNewPhone(detail.thread.contactPhone);
          setNewBody(outBody);
          setUseTemplate(true);
          setNewError(null);
          setShowNewModal(true);
          setSending(false);
          return;
        }
        throw sendErr;
      }
      setReply('');
      setReplyToMsg(null);
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

  // Delete the whole conversation (thread + all messages). Irreversible —
  // backend is ADMIN-only. After delete we drop the selection so the right
  // pane returns to the empty-state and refresh the list.
  const deleteThread = async () => {
    if (!detail?.thread) return;
    const who = detail.thread.contact?.name || detail.thread.patient?.name || detail.thread.contactPhone;
    if (!await notify.confirm(
      `Delete the entire conversation with ${who}? This permanently removes all messages from your CRM and cannot be undone. It does not delete messages on the recipient's phone.`
    )) return;
    try {
      await fetchApi(`/api/whatsapp/threads/${detail.thread.id}`, { method: 'DELETE' });
      notify.info('Conversation deleted.');
      setSelectedId(null);
      setDetail(null);
      loadList();
    } catch (err) {
      notify.error(err.message || 'Failed to delete conversation.');
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

  // ─── Right-click context menu on message bubbles ────────────
  // Stores { x, y, message } when open; null when closed. Closed on
  // outside-click / Escape / after any action. Replaces the previous
  // hover-button which was fragile (cursor leaving the bubble closed
  // the hover before the click registered).
  const [ctxMenu, setCtxMenu] = useState(null);
  // Emoji-react sub-panel visibility within the context menu.
  const [reactPanelOpen, setReactPanelOpen] = useState(false);

  // Close the menu on outside click + Escape.
  useEffect(() => {
    if (!ctxMenu) return undefined;
    const onClick = () => { setCtxMenu(null); setReactPanelOpen(false); };
    const onKey = (e) => {
      if (e.key === 'Escape') { setCtxMenu(null); setReactPanelOpen(false); }
    };
    window.addEventListener('click', onClick);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('click', onClick);
      window.removeEventListener('keydown', onKey);
    };
  }, [ctxMenu]);

  // Reply — WhatsApp-style. The replied-to message renders as a small
  // bordered preview ABOVE the textarea, with an X to dismiss. When
  // the reply sends, the quote is prepended to the body so the customer
  // sees the context. (True Meta threaded reply via `context.message_id`
  // is a backend extension we can add later.)
  const replyToMessage = (msg) => {
    if (!msg) return;
    setReplyToMsg(msg);
  };

  // Forward — open the New Message modal pre-filled with the message body.
  // Operator picks a recipient and sends.
  const forwardMessage = (msg) => {
    if (!msg) return;
    setNewPhone('');
    setNewBody(msg.body || '');
    setUseTemplate(false);
    setNewError(null);
    setShowNewModal(true);
  };

  // React — emoji reactions via Meta Cloud API
  // (POST /messages with type: "reaction"). Backend exposes this as
  // POST /api/whatsapp/messages/:id/react with body { emoji }.
  const reactToMessage = async (msg, emoji) => {
    if (!msg || !emoji) return;
    try {
      await fetchApi(`/api/whatsapp/messages/${msg.id}/react`, {
        method: 'POST',
        body: JSON.stringify({ emoji }),
      });
      notify.info(`Reacted with ${emoji}`);
      // Refresh detail so the reaction status is visible if the
      // backend tracks it in the message status / metadata.
      if (selectedIdRef.current) {
        const fresh = await fetchApi(`/api/whatsapp/threads/${selectedIdRef.current}`);
        setDetail(fresh);
      }
    } catch (err) {
      notify.error(err.message || 'Failed to react.');
    }
  };

  // ─── Delete message (soft-delete, "Delete for me") ──────────
  const deleteMessage = async (messageId) => {
    if (!messageId) return;
    const ok = await notify.confirm('Delete this message from your side?');
    if (!ok) return;
    try {
      await fetchApi(`/api/whatsapp/messages/${messageId}`, { method: 'DELETE' });
      // Refresh the open thread so the bubble disappears immediately.
      if (selectedIdRef.current) {
        const fresh = await fetchApi(`/api/whatsapp/threads/${selectedIdRef.current}`);
        setDetail(fresh);
      }
      notify.info('Message hidden from your CRM view.');
    } catch (err) {
      notify.error(err.message || 'Failed to delete message.');
    }
  };

  // ─── Send media (paperclip in composer) ─────────────────────
  // Uploads the file via multipart/form-data to the backend, which
  // stores it in S3 and forwards to Meta as image/video/audio/document
  // based on MIME type. We use a hidden file input + a paperclip
  // button that triggers it.
  const fileInputRef = useRef(null);
  const [uploadingMedia, setUploadingMedia] = useState(false);
  const openFilePicker = () => fileInputRef.current?.click();
  const onFilePicked = async (e) => {
    const file = e.target.files?.[0];
    e.target.value = ''; // reset so picking the same file twice still fires onChange
    if (!file || !detail?.thread) return;
    if (detail.optedOut) {
      notify.error('Contact has opted out — cannot send media.');
      return;
    }
    if (file.size > 16 * 1024 * 1024) {
      notify.error('File too large — Meta WhatsApp limit is 16 MB.');
      return;
    }
    setUploadingMedia(true);
    try {
      const form = new FormData();
      form.append('file', file);
      form.append('to', detail.thread.contactPhone);
      if (reply.trim()) form.append('caption', reply.trim());
      // fetchApi adds 'Content-Type: application/json' by default; we
      // need to use plain fetch here so the browser sets the multipart
      // boundary automatically.
      const token = localStorage.getItem('token');
      const resp = await fetch('/api/whatsapp/send-media', {
        method: 'POST',
        headers: token ? { Authorization: `Bearer ${token}` } : {},
        body: form,
      });
      if (!resp.ok) {
        const errBody = await resp.json().catch(() => ({}));
        throw new Error(errBody.error || `Upload failed (${resp.status})`);
      }
      notify.info('Media sent.');
      setReply('');
      // Refresh detail so the new bubble (with S3-hosted media) appears
      if (selectedIdRef.current) {
        const fresh = await fetchApi(`/api/whatsapp/threads/${selectedIdRef.current}`);
        setDetail(fresh);
      }
      loadList();
    } catch (err) {
      notify.error(err.message || 'Failed to send media.');
    }
    setUploadingMedia(false);
  };

  // Unblock — opens a themed modal that collects the DPDP §11 audit
  // reason (min 10 chars) before calling DELETE /api/whatsapp/opt-outs/:id.
  // Backend RBAC: admin-only. Submit handler lives in `submitUnblock`.
  const unblockContact = () => {
    if (!detail?.optedOut?.id) {
      notify.error('Cannot find opt-out record. Refresh the page and try again.');
      return;
    }
    setUnblockReason('');
    setUnblockError(null);
    setUnblockOpen(true);
  };

  const submitUnblock = async () => {
    setUnblockError(null);
    const trimmed = unblockReason.trim();
    if (trimmed.length < 10) {
      setUnblockError('Reason must be at least 10 characters (DPDP §11 audit requirement).');
      return;
    }
    if (!detail?.optedOut?.id) {
      setUnblockError('Cannot find opt-out record. Refresh and try again.');
      return;
    }
    setUnblockSaving(true);
    try {
      await fetchApi(`/api/whatsapp/opt-outs/${detail.optedOut.id}`, {
        method: 'DELETE',
        body: JSON.stringify({ reason: trimmed }),
      });
      const fresh = await fetchApi(`/api/whatsapp/threads/${selectedIdRef.current}`);
      setDetail(fresh);
      notify.info('Contact unblocked.');
      setUnblockOpen(false);
      setUnblockReason('');
    } catch (err) {
      setUnblockError(err.message || 'Failed to unblock.');
    }
    setUnblockSaving(false);
  };

  const optOutContact = async () => {
    if (!detail?.thread) return;
    if (!await notify.confirm(
      `Block ${detail.thread.contactPhone}? This prevents your tenant from sending any further WhatsApp messages to this number, and the recipient cannot reach you either. Treated as a DPDP/TRAI compliance opt-out — captured in audit log. You can unblock from WhatsApp → Blocked Numbers later.`
    )) return;
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
      // Fill the Layout's scrollable <main> exactly (its height is already
      // 100vh minus the top nav / footer / banners). Using 100vh here made
      // the page taller than its parent, so Layout's <main> scrolled the
      // whole page — dragging the composer out of view. height:100% keeps
      // the page bounded so only the inner messages list scrolls and the
      // reply bar stays pinned to the bottom.
      height: '100%', minHeight: 0,
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
                  onClick={() => (t._blocked ? openBlockedThread(t.contactPhone) : setSelectedId(t.id))}
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
                    {t._blocked ? (
                      <span style={{ fontSize: '0.7rem', color: 'var(--text-secondary)', display: 'flex', alignItems: 'center', gap: 3 }}>
                        <Ban size={11} /> {t._blocked.reason || 'Blocked'}
                      </span>
                    ) : t.assignedTo && (
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
                {!detail.optedOut ? (
                  <button
                    onClick={optOutContact}
                    className="btn-secondary"
                    title="Block this number (blocks both inbound + outbound)"
                    style={{ fontSize: '0.8rem', padding: '0.4rem 0.75rem', display: 'flex', alignItems: 'center', gap: 4, color: '#dc2626' }}
                  >
                    <Ban size={14} /> Block
                  </button>
                ) : isAdmin && (
                  <button
                    onClick={unblockContact}
                    className="btn-secondary"
                    title="Unblock this number — re-enables WhatsApp messaging"
                    style={{ fontSize: '0.8rem', padding: '0.4rem 0.75rem', display: 'flex', alignItems: 'center', gap: 4, color: '#16a34a' }}
                  >
                    <CheckCheck size={14} /> Unblock
                  </button>
                )}
                {isAdmin && (
                  <button
                    onClick={deleteThread}
                    className="btn-secondary"
                    title="Delete this conversation (removes all messages from the CRM)"
                    style={{ fontSize: '0.8rem', padding: '0.4rem 0.75rem', display: 'flex', alignItems: 'center', gap: 4, color: '#dc2626' }}
                  >
                    <Trash2 size={14} /> Delete chat
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
              display: 'flex', flexDirection: 'column', gap: 18,
              background: 'var(--chat-bg)',
            }}>
              {(detail.messages || [])
                // Hide Meta "reaction" events from the chat view — they
                // arrive as full inbound messages with body=null and were
                // previously rendering as "(media)" placeholders. Future
                // work: stash them on the original message and render as
                // a small emoji pill. For now, just hide.
                .filter((m) => (m.metaType || '').toLowerCase() !== 'reaction')
                .map((m) => {
                const isOutbound = m.direction === 'OUTBOUND';
                const hasMedia = !!m.mediaUrl;
                return (
                  <div
                    key={m.id}
                    onContextMenu={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      setReactPanelOpen(false);
                      setCtxMenu({ x: e.clientX, y: e.clientY, message: m });
                    }}
                    style={{
                      maxWidth: '70%',
                      alignSelf: isOutbound ? 'flex-end' : 'flex-start',
                      background: isOutbound ? 'var(--chat-bubble-out)' : 'var(--chat-bubble-in)',
                      color: 'var(--text-primary)',
                      padding: '0.6rem 0.85rem', borderRadius: 12,
                      fontSize: '0.9rem', lineHeight: 1.4,
                      wordBreak: 'break-word',
                      boxShadow: '0 1px 1px rgba(0,0,0,0.13)',
                      position: 'relative',
                      cursor: 'context-menu',
                    }}
                  >
                    <div>
                      {hasMedia && <MessageMedia message={m} />}
                      {m.body && <div style={{ marginTop: hasMedia ? 6 : 0 }}>{m.body}</div>}
                      {!hasMedia && !m.body && <em style={{ opacity: 0.6 }}>(empty)</em>}
                    </div>
                    {/* Reactions pill — shows emojis from both sides
                        (customer's reactions arrive via webhook, the
                        operator's reactions are mirrored locally by the
                        /react endpoint). Grouped + counted so "👍👍❤️"
                        renders as "👍 2 · ❤️ 1". */}
                    {(() => {
                      let arr = [];
                      try { arr = JSON.parse(m.reactionsJson || '[]'); } catch { arr = []; }
                      if (!Array.isArray(arr) || arr.length === 0) return null;
                      const counts = arr.reduce((acc, r) => {
                        const e = r?.emoji || '';
                        if (!e) return acc;
                        acc[e] = (acc[e] || 0) + 1;
                        return acc;
                      }, {});
                      const entries = Object.entries(counts);
                      if (entries.length === 0) return null;
                      return (
                        <div style={{
                          position: 'absolute',
                          bottom: -10,
                          [isOutbound ? 'right' : 'left']: 8,
                          background: 'var(--bg-color)',
                          border: '1px solid var(--border-color)',
                          borderRadius: 999,
                          padding: '1px 6px',
                          fontSize: '0.78rem',
                          display: 'flex', gap: 4, alignItems: 'center',
                          boxShadow: '0 1px 3px rgba(0,0,0,0.2)',
                          whiteSpace: 'nowrap',
                          lineHeight: 1.4,
                        }}>
                          {entries.map(([emoji, count]) => (
                            <span key={emoji}>
                              {emoji}{count > 1 ? ` ${count}` : ''}
                            </span>
                          ))}
                        </div>
                      );
                    })()}
                    <div style={{
                      fontSize: '0.65rem', opacity: 0.65, marginTop: 4,
                      textAlign: isOutbound ? 'right' : 'left',
                      display: 'flex',
                      gap: 4,
                      alignItems: 'center',
                      justifyContent: isOutbound ? 'flex-end' : 'flex-start',
                    }}>
                      <span>{new Date(m.createdAt).toLocaleString()}</span>
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
              ) : (() => {
                // ── 24-hour window check ────────────────────────────
                // WhatsApp Business policy: free-form text can only be
                // sent within 24h of the customer's last INBOUND msg.
                // We compute the freshest inbound time from the loaded
                // messages and show a yellow banner if it's stale, so
                // operators don't waste keystrokes on a doomed send.
                const inbounds = (detail.messages || []).filter((m) => m.direction === 'INBOUND' && (m.metaType || '').toLowerCase() !== 'reaction');
                const newestInbound = inbounds.length > 0
                  ? Math.max(...inbounds.map((m) => new Date(m.createdAt).getTime()))
                  : 0;
                const windowExpired = newestInbound === 0 || (Date.now() - newestInbound) > 24 * 3600 * 1000;
                return (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  {windowExpired && (
                    <div style={{
                      background: 'rgba(245,158,11,0.12)',
                      border: '1px solid rgba(245,158,11,0.35)',
                      borderRadius: 8,
                      padding: '0.55rem 0.8rem',
                      fontSize: '0.78rem',
                      display: 'flex', alignItems: 'center', gap: 8, justifyContent: 'space-between',
                      color: 'var(--text-primary)',
                    }}>
                      <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                        <AlertTriangle size={14} color="#d97706" />
                        24-hour window expired — free-form messages will be rejected by Meta. Use an approved template.
                      </span>
                      <button
                        onClick={() => {
                          setNewPhone(detail.thread.contactPhone);
                          setUseTemplate(true);
                          setNewBody('');
                          setNewError(null);
                          setShowNewModal(true);
                        }}
                        style={{
                          padding: '0.3rem 0.7rem', fontSize: '0.75rem', fontWeight: 600,
                          background: '#d97706', color: '#fff', border: 'none',
                          borderRadius: 6, cursor: 'pointer', whiteSpace: 'nowrap',
                        }}
                      >
                        Send template →
                      </button>
                    </div>
                  )}
                  {/* WhatsApp-style replying-to preview: shows the quoted
                      message in a green-bordered bar above the textarea
                      with an X to dismiss. Replaces the old text-quote
                      approach which polluted the textarea. */}
                  {replyToMsg && (
                    <div style={{
                      display: 'flex', alignItems: 'stretch', gap: 8,
                      background: 'var(--surface-color)',
                      borderRadius: 6,
                      borderLeft: '3px solid var(--primary-color, #25D366)',
                      padding: '0.5rem 0.7rem',
                      fontSize: '0.82rem',
                    }}>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{
                          color: 'var(--primary-color, #25D366)',
                          fontSize: '0.72rem', fontWeight: 600, marginBottom: 2,
                        }}>
                          Replying to {replyToMsg.direction === 'OUTBOUND' ? 'yourself' : (detail.thread.contact?.name || detail.thread.contactPhone)}
                        </div>
                        <div style={{
                          color: 'var(--text-secondary)',
                          overflow: 'hidden', textOverflow: 'ellipsis',
                          display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical',
                        }}>
                          {replyToMsg.body || '(media)'}
                        </div>
                      </div>
                      <button
                        onClick={() => setReplyToMsg(null)}
                        title="Cancel reply"
                        style={{
                          background: 'transparent', border: 'none', cursor: 'pointer',
                          color: 'var(--text-secondary)', padding: 4, display: 'flex',
                          alignItems: 'flex-start',
                        }}
                      >
                        <X size={14} />
                      </button>
                    </div>
                  )}
                  <div style={{
                    display: 'flex',
                    gap: 8,
                    alignItems: 'flex-end',
                    background: 'var(--surface-color)',
                    border: '1px solid var(--border-color)',
                    borderRadius: 24,
                    padding: 6,
                    backdropFilter: 'blur(8px)',
                    WebkitBackdropFilter: 'blur(8px)',
                  }}>
                  {/* Paperclip — opens hidden file input. The textarea
                      content (if any) becomes the media caption. */}
                  <input
                    ref={fileInputRef}
                    type="file"
                    onChange={onFilePicked}
                    style={{ display: 'none' }}
                    accept="image/*,video/*,audio/*,.pdf,.doc,.docx,.xls,.xlsx,.txt"
                  />
                  <button
                    type="button"
                    onClick={openFilePicker}
                    disabled={uploadingMedia}
                    title="Attach a file (image / video / audio / document, max 16 MB)"
                    style={{
                      width: 36, height: 36,
                      flexShrink: 0,
                      background: 'transparent',
                      border: 'none',
                      borderRadius: '50%',
                      color: 'var(--text-secondary)',
                      cursor: uploadingMedia ? 'not-allowed' : 'pointer',
                      display: 'flex', alignItems: 'center', justifyContent: 'center',
                      opacity: uploadingMedia ? 0.5 : 1,
                      transition: 'background 0.15s',
                    }}
                    onMouseEnter={(e) => { if (!uploadingMedia) e.currentTarget.style.background = 'var(--hover-bg)'; }}
                    onMouseLeave={(e) => e.currentTarget.style.background = 'transparent'}
                  >
                    <Paperclip size={18} />
                  </button>
                  <textarea
                    value={reply}
                    onChange={(e) => setReply(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                        e.preventDefault();
                        sendReply();
                      }
                      if (e.key === 'Escape' && replyToMsg) {
                        setReplyToMsg(null);
                      }
                    }}
                    placeholder={uploadingMedia ? 'Uploading…' : (replyToMsg ? 'Type your reply…' : 'Type a message…')}
                    rows={1}
                    style={{
                      flex: 1,
                      minHeight: 24,
                      maxHeight: 140,
                      resize: 'none',
                      fontSize: '0.92rem',
                      border: 'none',
                      outline: 'none',
                      background: 'transparent',
                      color: 'var(--text-primary)',
                      fontFamily: 'inherit',
                      padding: '7px 4px',
                      lineHeight: 1.4,
                    }}
                    disabled={uploadingMedia}
                  />
                  <button
                    onClick={sendReply}
                    disabled={sending || !reply.trim()}
                    title="Send (Ctrl+Enter)"
                    style={{
                      width: 36, height: 36,
                      flexShrink: 0,
                      background: (sending || !reply.trim()) ? 'transparent' : 'var(--primary-color, #25D366)',
                      border: 'none',
                      borderRadius: '50%',
                      color: (sending || !reply.trim()) ? 'var(--text-secondary)' : '#fff',
                      cursor: (sending || !reply.trim()) ? 'not-allowed' : 'pointer',
                      display: 'flex', alignItems: 'center', justifyContent: 'center',
                      transition: 'background 0.15s',
                    }}
                  >
                    <Send size={16} />
                  </button>
                </div>
                </div>
                );
              })()}
            </footer>
          </>
        )}
      </main>
      </div>

      {/* ─── Right-click message context menu ─── */}
      {ctxMenu && (() => {
        // Smart positioning:
        //   • If click X is in the right half → anchor menu's RIGHT edge to click
        //     (subtract estimated width from x) so the menu opens LEFTWARD
        //   • Same for vertical: if in bottom half → anchor BOTTOM edge,
        //     opens UPWARD
        // This matches how WhatsApp / Slack / most native menus behave.
        const MENU_W = reactPanelOpen ? 220 : 200;
        const MENU_H = reactPanelOpen ? 290 : 200;
        const vw = typeof window !== 'undefined' ? window.innerWidth : 1200;
        const vh = typeof window !== 'undefined' ? window.innerHeight : 800;
        // Default: anchor top-left of menu at click
        let left = ctxMenu.x;
        let top = ctxMenu.y;
        // Flip horizontally if click is past the midpoint OR menu would overflow
        if (ctxMenu.x > vw / 2 || ctxMenu.x + MENU_W > vw - 8) {
          left = Math.max(8, ctxMenu.x - MENU_W);
        }
        // Flip vertically if click is past the midpoint OR menu would overflow
        if (ctxMenu.y > vh / 2 || ctxMenu.y + MENU_H > vh - 8) {
          top = Math.max(8, ctxMenu.y - MENU_H);
        }
        return (
        <div
          onClick={(e) => e.stopPropagation()}
          onContextMenu={(e) => e.preventDefault()}
          style={{
            position: 'fixed',
            left,
            top,
            zIndex: 10001,
            background: 'var(--surface-color)',
            backdropFilter: 'blur(20px)',
            WebkitBackdropFilter: 'blur(20px)',
            border: '1px solid var(--border-color)',
            borderRadius: 8,
            boxShadow: '0 10px 28px rgba(0,0,0,0.3)',
            minWidth: 180,
            padding: 4,
            color: 'var(--text-primary)',
          }}
        >
          <CtxMenuItem
            icon={<Reply size={14} />}
            label="Reply"
            onClick={() => { replyToMessage(ctxMenu.message); setCtxMenu(null); }}
          />
          <CtxMenuItem
            icon={<Forward size={14} />}
            label="Forward"
            onClick={() => { forwardMessage(ctxMenu.message); setCtxMenu(null); }}
          />
          <CtxMenuItem
            icon={<Smile size={14} />}
            label={reactPanelOpen ? 'React →' : 'React'}
            onClick={() => setReactPanelOpen((v) => !v)}
          />
          {reactPanelOpen && (
            <div style={{
              display: 'flex', gap: 4, padding: '4px 8px',
              borderTop: '1px solid var(--border-color)',
              borderBottom: '1px solid var(--border-color)',
              marginBottom: 4,
            }}>
              {['👍', '❤️', '😂', '😮', '😢', '🙏'].map((e) => (
                <button
                  key={e}
                  onClick={() => { reactToMessage(ctxMenu.message, e); setCtxMenu(null); }}
                  style={{
                    background: 'transparent', border: 'none', cursor: 'pointer',
                    fontSize: '1.2rem', padding: '4px 6px', borderRadius: 4,
                  }}
                  title={`React ${e}`}
                  onMouseEnter={(ev) => ev.currentTarget.style.background = 'var(--hover-bg)'}
                  onMouseLeave={(ev) => ev.currentTarget.style.background = 'transparent'}
                >
                  {e}
                </button>
              ))}
            </div>
          )}
          <CtxMenuItem
            icon={<Trash2 size={14} />}
            label="Delete for me"
            color="#dc2626"
            onClick={() => { deleteMessage(ctxMenu.message.id); setCtxMenu(null); }}
          />
        </div>
        );
      })()}

      {/* ─── Unblock reason modal ─── */}
      {unblockOpen && (
        <div
          onClick={(e) => { if (e.target === e.currentTarget && !unblockSaving) setUnblockOpen(false); }}
          style={{
            position: 'fixed', inset: 0,
            background: 'rgba(0,0,0,0.55)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            zIndex: 10002, padding: '1rem',
          }}
        >
          <div style={{
            width: '100%', maxWidth: 460, padding: '1.5rem', borderRadius: 12,
            background: 'var(--surface-color)',
            backdropFilter: 'blur(20px)',
            WebkitBackdropFilter: 'blur(20px)',
            color: 'var(--text-primary)',
            border: '1px solid var(--border-color)',
            boxShadow: '0 16px 40px rgba(0,0,0,0.3)',
          }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.5rem' }}>
              <h3 style={{ margin: 0, fontSize: '1.05rem', display: 'flex', alignItems: 'center', gap: 8 }}>
                <CheckCheck size={18} color="#16a34a" />
                Unblock contact
              </h3>
              <button
                onClick={() => !unblockSaving && setUnblockOpen(false)}
                style={{ background: 'transparent', border: 'none', cursor: 'pointer', color: 'var(--text-secondary)', padding: 4, display: 'flex' }}
                title="Close"
              >
                <X size={18} />
              </button>
            </div>
            <p style={{ fontSize: '0.85rem', color: 'var(--text-secondary)', margin: '0 0 1rem' }}>
              Unblocking <strong>{detail?.thread?.contactPhone}</strong> re-enables
              outbound WhatsApp messages to this number. The reason below is
              recorded in the audit log (DPDP §11 compliance).
            </p>
            <label style={{ display: 'block', marginBottom: '0.75rem' }}>
              <span style={{ fontSize: '0.78rem', fontWeight: 600, color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '0.04em', display: 'block', marginBottom: 4 }}>
                Reason (minimum 10 characters)
              </span>
              <textarea
                value={unblockReason}
                onChange={(e) => setUnblockReason(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                    e.preventDefault();
                    submitUnblock();
                  }
                }}
                rows={3}
                placeholder="e.g. Customer requested re-engagement after billing dispute resolved"
                className="input-field"
                style={{ width: '100%', fontSize: '0.9rem', fontFamily: 'inherit', resize: 'vertical' }}
                disabled={unblockSaving}
                autoFocus
              />
              <span style={{ fontSize: '0.72rem', color: 'var(--text-secondary)' }}>
                {unblockReason.trim().length}/10 characters minimum
              </span>
            </label>
            {unblockError && (
              <div style={{
                background: 'rgba(220,38,38,0.1)', color: '#dc2626',
                border: '1px solid rgba(220,38,38,0.3)',
                padding: '0.55rem 0.75rem', borderRadius: 6,
                fontSize: '0.8rem', marginBottom: '0.75rem',
              }}>
                {unblockError}
              </div>
            )}
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
              <button
                onClick={() => setUnblockOpen(false)}
                disabled={unblockSaving}
                className="btn-secondary"
                style={{ padding: '0.5rem 1rem', fontSize: '0.85rem' }}
              >
                Cancel
              </button>
              <button
                onClick={submitUnblock}
                disabled={unblockSaving || unblockReason.trim().length < 10}
                style={{
                  padding: '0.5rem 1rem', fontSize: '0.85rem',
                  background: '#16a34a', color: '#fff',
                  border: 'none', borderRadius: 6, fontWeight: 600,
                  cursor: unblockSaving ? 'not-allowed' : 'pointer',
                  opacity: unblockSaving || unblockReason.trim().length < 10 ? 0.6 : 1,
                  display: 'flex', alignItems: 'center', gap: 6,
                }}
              >
                <CheckCheck size={14} />
                {unblockSaving ? 'Unblocking…' : 'Unblock'}
              </button>
            </div>
          </div>
        </div>
      )}

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

            <label style={{ display: 'block', marginBottom: '0.75rem', position: 'relative' }}>
              <span style={{ fontSize: '0.8rem', fontWeight: 600, color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '0.04em', display: 'block', marginBottom: 4 }}>
                Phone or pick a contact
              </span>
              <input
                type="text"
                value={newPhone}
                onChange={(e) => { setNewPhone(e.target.value); setPickerOpen(true); }}
                onFocus={() => setPickerOpen(true)}
                onBlur={() => setTimeout(() => setPickerOpen(false), 150)}
                placeholder="Type a name or phone…"
                className="input-field"
                style={{ width: '100%', fontSize: '0.9rem' }}
                disabled={newSending}
                autoComplete="off"
              />
              {pickerOpen && contactOptions.length > 0 && (() => {
                const q = newPhone.trim().toLowerCase();
                // Filter: empty query → show first 20; otherwise match
                // name OR phone, case-insensitive.
                const filtered = q
                  ? contactOptions.filter((o) =>
                      o.name.toLowerCase().includes(q) || o.phone.toLowerCase().includes(q)
                    ).slice(0, 30)
                  : contactOptions.slice(0, 20);
                if (filtered.length === 0) return null;
                return (
                  <div style={{
                    position: 'absolute', top: '100%', left: 0, right: 0,
                    background: 'var(--bg-color)', border: '1px solid var(--border-color)',
                    borderRadius: 8, marginTop: 4, maxHeight: 220, overflowY: 'auto',
                    zIndex: 10000, boxShadow: '0 8px 24px rgba(0,0,0,0.2)',
                  }}>
                    {filtered.map((o) => (
                      <div
                        key={o.id}
                        onMouseDown={(e) => {
                          e.preventDefault(); // prevent blur before click registers
                          setNewPhone(o.phone);
                          setPickerOpen(false);
                        }}
                        style={{
                          padding: '0.55rem 0.8rem',
                          cursor: 'pointer',
                          borderBottom: '1px solid var(--border-color)',
                          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                          gap: 8,
                        }}
                        onMouseEnter={(e) => e.currentTarget.style.background = 'var(--hover-bg, rgba(127,127,127,0.08))'}
                        onMouseLeave={(e) => e.currentTarget.style.background = 'transparent'}
                      >
                        <div style={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}>
                          <span style={{ fontSize: '0.88rem', fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                            {o.name}
                          </span>
                          <span style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>
                            {o.phone}
                          </span>
                        </div>
                        <span style={{
                          fontSize: '0.65rem', fontWeight: 600,
                          padding: '2px 6px', borderRadius: 4,
                          background: o.source === 'patient' ? 'rgba(16,185,129,0.15)' : 'rgba(59,130,246,0.15)',
                          color: o.source === 'patient' ? '#10b981' : '#3b82f6',
                          textTransform: 'uppercase', letterSpacing: '0.04em',
                        }}>
                          {o.source}
                        </span>
                      </div>
                    ))}
                  </div>
                );
              })()}
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
                disabled={
                  newSending ||
                  !newPhone.trim() ||
                  // Template mode validates the picked template + every
                  // {{n}} variable; free-form mode validates the body. Mirrors
                  // the same checks in sendNewMessage. The old condition always
                  // required newBody, so template sends (body empty by design)
                  // left the button permanently disabled.
                  (useTemplate
                    ? (!selectedTemplateName || templateParams.some((p) => !p.trim()))
                    : !newBody.trim())
                }
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
