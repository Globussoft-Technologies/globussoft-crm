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

import { useContext, useEffect, useMemo, useRef, useState } from 'react';
import { io as socketIO } from 'socket.io-client';
import { AuthContext } from '../../App';
import { fetchApi } from '../../utils/api';
import { useNotify } from '../../utils/notify';
// ── WhatsApp transport swap ──────────────────────────────────────────────
// The Meta Cloud API EmbeddedSignup connection panel is COMMENTED OUT (kept on
// disk, not removed) — wellness now uses the SAME WhatsApp Web (QR-scan)
// connect/send engine as the travel vertical, via WhatsAppWebConnect +
// /api/whatsapp-web/*. To revert to Meta, restore the import + the panel below.
// import WhatsAppEmbeddedSignup from '../../components/WhatsAppEmbeddedSignup';
import WhatsAppWebConnect from './whatsapp/WhatsAppWebConnect';
import { WhatsAppThreadsContext } from './whatsapp/WhatsAppThreadsContext';
import ThreadList from './whatsapp/ThreadList';
import ThreadDetail from './whatsapp/ThreadDetail';
import MessageContextMenu from './whatsapp/MessageContextMenu';
import UnblockModal from './whatsapp/UnblockModal';
import NewMessageModal from './whatsapp/NewMessageModal';

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
  // Errors are surfaced in `newError`.
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
  // Generation counters to discard stale async results (§5.5 race guard).
  const listGenRef = useRef(0);
  const detailGenRef = useRef(0);

  // ─── Older-message pagination (infinite scroll-up) ──────────
  // GET /threads/:id only ever returns the newest 50 messages. Every
  // "refresh" fetch (polling, socket events, post-action reloads) also
  // hits that same un-paginated endpoint, so a naive setDetail(fresh)
  // would silently drop any older page the user scrolled up to load.
  // mergeDetailPreservingOlder keeps those older messages stitched onto
  // the front of whatever the latest-50 refresh returns.
  const [hasMoreMessages, setHasMoreMessages] = useState(false);
  const [loadingOlderMessages, setLoadingOlderMessages] = useState(false);
  const oldestLoadedIdRef = useRef(null);

  const mergeDetailPreservingOlder = (prevDetail, fresh, forThreadId) => {
    setHasMoreMessages(!!fresh?.hasMoreMessages);
    if (!prevDetail || prevDetail.thread?.id !== forThreadId) return fresh;
    const freshMessages = Array.isArray(fresh.messages) ? fresh.messages : [];
    const freshIds = new Set(freshMessages.map((m) => m.id));
    const olderKept = (prevDetail.messages || []).filter(
      (m) => !freshIds.has(m.id) && (freshMessages.length === 0 || m.createdAt <= freshMessages[0].createdAt)
    );
    return { ...fresh, messages: [...olderKept, ...freshMessages] };
  };

  // Fetch the next page of older messages (before the oldest one currently
  // shown) and prepend them. Called when the user scrolls near the top of
  // the message pane. No-ops if there's nothing older or a fetch is already
  // in flight.
  const loadOlderMessages = async () => {
    const threadId = selectedIdRef.current;
    const oldest = oldestLoadedIdRef.current;
    if (!threadId || !oldest || loadingOlderMessages || !hasMoreMessages) return;
    setLoadingOlderMessages(true);
    try {
      const older = await fetchApi(`/api/whatsapp/threads/${threadId}?before=${oldest}`);
      if (selectedIdRef.current !== threadId) return;
      setDetail((prev) => {
        if (!prev || prev.thread?.id !== threadId) return prev;
        const existingIds = new Set((prev.messages || []).map((m) => m.id));
        const newOlder = (older.messages || []).filter((m) => !existingIds.has(m.id));
        return { ...prev, messages: [...newOlder, ...(prev.messages || [])] };
      });
      setHasMoreMessages(!!older.hasMoreMessages);
    } catch (err) {
      notify.error(err.message || 'Failed to load older messages.');
    }
    setLoadingOlderMessages(false);
  };

  // ─── Load thread list ──────────────────────────────────────
  const loadList = async () => {
    const gen = ++listGenRef.current;
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
        if (gen !== listGenRef.current) return;
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
      if (gen !== listGenRef.current) return;
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
      if (gen !== listGenRef.current) return;
      notify.error(err.message || 'Failed to load threads.');
      setThreads([]);
    }
    if (gen === listGenRef.current) setLoadingList(false);
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

  // Re-run list fetch whenever status filter, unread toggle, OR search
  // text changes. `loadList` closes over `q` so it must be in the deps.
  useEffect(() => {
    loadList();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [statusFilter, unreadOnly, q]);

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
        const gen = ++detailGenRef.current;
        fetchApi(`/api/whatsapp/threads/${selId}`)
          .then((fresh) => {
            if (gen === detailGenRef.current && selectedIdRef.current === selId) {
              setDetail((prev) => mergeDetailPreservingOlder(prev, fresh, selectedIdRef.current));
            }
          })
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
            const gen = ++detailGenRef.current;
            const fresh = await fetchApi(`/api/whatsapp/threads/${selectedIdRef.current}`);
            if (gen === detailGenRef.current && selectedIdRef.current === payload.threadId) {
              setDetail((prev) => mergeDetailPreservingOlder(prev, fresh, selectedIdRef.current));
            }
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
            const gen = ++detailGenRef.current;
            const fresh = await fetchApi(`/api/whatsapp/threads/${selectedIdRef.current}`);
            if (gen === detailGenRef.current) {
              setDetail((prev) => mergeDetailPreservingOlder(prev, fresh, selectedIdRef.current));
            }
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
            const gen = ++detailGenRef.current;
            const fresh = await fetchApi(`/api/whatsapp/threads/${selectedIdRef.current}`);
            if (gen === detailGenRef.current && selectedIdRef.current === payload.threadId) {
              setDetail((prev) => mergeDetailPreservingOlder(prev, fresh, selectedIdRef.current));
            }
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
    setHasMoreMessages(false);
    (async () => {
      try {
        const data = await fetchApi(`/api/whatsapp/threads/${selectedId}`);
        if (!cancelled) {
          setDetail(data);
          setHasMoreMessages(!!data?.hasMoreMessages);
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
    // ── Full-history backfill (fire-and-forget) ──────────────────────
    // The CRM's DB only ever has whatever the bulk import pulled (last ~25
    // messages/chat, to keep linking fast). The first time an operator opens
    // a thread, pull that ONE chat's complete WhatsApp Web history in the
    // background — same as WhatsApp Web itself lazy-loading as you scroll —
    // then refresh hasMoreMessages so scroll-up pagination can reach it.
    // Silent on failure (WA disconnected, thread already fully synced, a
    // second open already in flight) — this is a best-effort enhancement,
    // not required for the thread to be usable.
    (async () => {
      try {
        const result = await fetchApi(`/api/whatsapp-web/threads/${selectedId}/backfill-history`, {
          method: 'POST',
          silent: true,
          body: JSON.stringify({}),
        });
        if (!cancelled && result?.added > 0 && selectedIdRef.current === selectedId) {
          // New older messages landed in the DB — refresh hasMoreMessages so
          // the scroll-up pagination in ThreadDetail.jsx can reach them. Only
          // refresh the flag (not the visible messages), so the operator's
          // current scroll position + read state don't jump around.
          const fresh = await fetchApi(`/api/whatsapp/threads/${selectedId}`);
          if (!cancelled && selectedIdRef.current === selectedId) {
            setHasMoreMessages(!!fresh?.hasMoreMessages);
          }
        }
      } catch { /* best-effort — thread stays usable with whatever was already imported */ }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId]);

  // Track the oldest currently-loaded message id so loadOlderMessages knows
  // what cursor to page from. Recomputed on every detail change (initial
  // load, refresh, or an older page being prepended).
  useEffect(() => {
    const first = detail?.messages?.[0];
    oldestLoadedIdRef.current = first ? first.id : null;
  }, [detail]);

  // Auto-scroll to the newest message on initial load / new-message arrival.
  // Keyed on the LAST message's id (not the whole `detail` object) so that
  // prepending an older page — which changes detail.messages but never the
  // newest entry — doesn't re-trigger this. Using a loadingOlderMessages
  // boolean guard instead is racy: setDetail(...) and
  // setLoadingOlderMessages(false) land in the same React batch at the end
  // of loadOlderMessages, so by the time this effect re-runs the guard has
  // already flipped false and the scroll-to-bottom fires anyway, yanking the
  // view back down right after history loads.
  const newestMessageId = detail?.messages?.length
    ? detail.messages[detail.messages.length - 1].id
    : null;
  useEffect(() => {
    if (messagesEndRef.current) {
      messagesEndRef.current.scrollIntoView({ behavior: 'smooth' });
    }
  }, [newestMessageId]);

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
      // Errors bubble to the outer catch below (CONTACT_OPTED_OUT handling).
      await fetchApi('/api/whatsapp-web/send', {
        method: 'POST',
        body: JSON.stringify({ to: detail.thread.contactPhone, body: outBody }),
      });
      setReply('');
      setReplyToMsg(null);
      // Reload detail
      const fresh = await fetchApi(`/api/whatsapp/threads/${selectedId}`);
      setDetail((prev) => mergeDetailPreservingOlder(prev, fresh, selectedIdRef.current));
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
      const resp = await fetchApi('/api/whatsapp-web/send', {
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
      if (msg.includes('CONTACT_OPTED_OUT')) {
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
      setDetail((prev) => mergeDetailPreservingOlder(prev, fresh, selectedIdRef.current));
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
      setDetail((prev) => mergeDetailPreservingOlder(prev, fresh, selectedIdRef.current));
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
      setDetail((prev) => mergeDetailPreservingOlder(prev, fresh, selectedIdRef.current));
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
      setDetail((prev) => mergeDetailPreservingOlder(prev, fresh, selectedIdRef.current));
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
        setDetail((prev) => mergeDetailPreservingOlder(prev, fresh, selectedIdRef.current));
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
        setDetail((prev) => mergeDetailPreservingOlder(prev, fresh, selectedIdRef.current));
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
      const resp = await fetch('/api/whatsapp-web/send-media', {
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
        setDetail((prev) => mergeDetailPreservingOlder(prev, fresh, selectedIdRef.current));
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
      setDetail((prev) => mergeDetailPreservingOlder(prev, fresh, selectedIdRef.current));
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
      setDetail((prev) => mergeDetailPreservingOlder(prev, fresh, selectedIdRef.current));
    } catch (err) {
      notify.error(err.message || 'Failed to opt out.');
    }
  };

  // ─── Render ─────────────────────────────────────────────
  const filteredThreads = useMemo(() => threads, [threads]);

  const contextValue = {
    // Core state
    threads: filteredThreads,
    loadingList,
    statusFilter,
    unreadOnly,
    q,
    selectedId,
    detail,
    loadingDetail,
    hasMoreMessages,
    loadingOlderMessages,
    reply,
    sending,
    replyToMsg,
    isAdmin,
    staff,
    renaming,
    renameValue,
    renameSaving,
    templates,
    useTemplate,
    selectedTemplateName,
    templateParams,
    contactOptions,
    pickerOpen,
    // New message modal state
    showNewModal,
    newPhone,
    newBody,
    newSending,
    newError,
    // Unblock modal state
    unblockOpen,
    unblockReason,
    unblockSaving,
    unblockError,
    // Context menu state
    ctxMenu,
    reactPanelOpen,
    // Media upload
    uploadingMedia,
    // Refs
    messagesEndRef,
    fileInputRef,
    // Setters
    setThreads,
    setLoadingList,
    setStatusFilter,
    setUnreadOnly,
    setQ,
    setSelectedId,
    setDetail,
    setLoadingDetail,
    setReply,
    setSending,
    setReplyToMsg,
    setRenaming,
    setRenameValue,
    setRenameSaving,
    setShowNewModal,
    setNewPhone,
    setNewBody,
    setNewSending,
    setNewError,
    setUseTemplate,
    setSelectedTemplateName,
    setTemplateParams,
    setPickerOpen,
    setUnblockOpen,
    setUnblockReason,
    setUnblockSaving,
    setUnblockError,
    setCtxMenu,
    setReactPanelOpen,
    setUploadingMedia,
    // Handlers
    loadList,
    loadOlderMessages,
    handleSearch,
    openBlockedThread,
    sendReply,
    sendNewMessage,
    assignToUser,
    startRename,
    cancelRename,
    saveRename,
    closeThread,
    deleteThread,
    snoozeThread,
    replyToMessage,
    forwardMessage,
    reactToMessage,
    deleteMessage,
    openFilePicker,
    onFilePicked,
    unblockContact,
    submitUnblock,
    optOutContact,
    countPlaceholders,
  };

  return (
    <WhatsAppThreadsContext.Provider value={contextValue}>
      <div style={{
        display: 'flex', flexDirection: 'column',
        height: '100%', minHeight: 0,
        animation: 'fadeIn 0.4s ease-out',
      }}>
        {/* WhatsApp Web (QR-scan) connection bar — replaces the Meta Cloud API
            EmbeddedSignup panel (commented out above). Scan the QR from your
            phone to link a number; sends/receives then flow over WhatsApp Web.
            Legacy Meta panel preserved for reference:
            <div style={{ padding: '0.75rem 1rem 0' }}>
              <WhatsAppEmbeddedSignup compact />
            </div> */}
        <WhatsAppWebConnect
          apiBase="/api/whatsapp-web"
          tenantId={currentUser?.tenantId}
          isAdmin={isAdmin}
          onChanged={loadList}
        />

        <div style={{ display: 'flex', flex: 1, gap: 0, minHeight: 0 }}>
          <ThreadList />
          <ThreadDetail />
        </div>

        <MessageContextMenu />
        <UnblockModal />
        <NewMessageModal />
      </div>
    </WhatsAppThreadsContext.Provider>
  );
}
