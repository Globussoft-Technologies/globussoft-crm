import { useEffect, useRef, useState, useCallback } from 'react';
import {
  Mail, RefreshCw, Plug, Trash2, Send, X, PencilLine, CornerUpLeft,
  Search, Inbox as InboxIcon, AlertTriangle, Check, Paperclip,
  Link2, List, ListOrdered,
} from 'lucide-react';
import { fetchApi } from '../utils/api';
import { useNotify } from '../utils/notify';

// Make bare URLs in a plain-text email body clickable — React-safe (renders real
// <a> nodes, never dangerouslySetInnerHTML, so injected markup stays inert).
// Splits on http(s) URLs; trailing sentence punctuation is kept outside the link.
const EMAIL_URL_RE = /(https?:\/\/[^\s<]+)/g;
function linkifyText(text) {
  if (!text) return text;
  return String(text).split(EMAIL_URL_RE).map((part, i) => {
    if (i % 2 === 0) return part; // plain-text segment
    const trail = part.match(/[.,!?;:)\]}'"]+$/);
    const url = trail ? part.slice(0, -trail[0].length) : part;
    const tail = trail ? trail[0] : '';
    return (
      <span key={i}>
        <a
          href={url}
          target="_blank"
          rel="noopener noreferrer"
          style={{ color: 'var(--primary-color, var(--accent-color))', textDecoration: 'underline', wordBreak: 'break-all' }}
        >
          {url}
        </a>
        {tail}
      </span>
    );
  });
}

// Gmail integration page (/gmail) — a Gmail-styled read/send surface over
// routes/gmail.js:
//   GET    /api/gmail/status            → { connected, emailAddress, lastSyncAt }
//   GET    /api/gmail/connect           → { authUrl }
//   DELETE /api/gmail/disconnect
//   GET    /api/gmail/messages?q&maxResults → { messages: [...] }
//   GET    /api/gmail/messages/:messageId   → full parsed message
//   POST   /api/gmail/send             → { success, gmailMessageId, ... }
// The OAuth callback bounces back here with ?connected=gmail / ?error=…

const GMAIL_RED = '#EA4335';
const GMAIL_BLUE = '#1a73e8';
const COMPOSE_HEADER = '#202124'; // Gmail's compose-window header grey

function Toast({ msg, onClose }) {
  const isError = /\b(fail|error|expired|reconnect|couldn|could not|denied|invalid|unable|not connected|not configured|not enabled)\b/i.test(msg || '');
  useEffect(() => {
    const t = setTimeout(onClose, isError ? 7000 : 3500);
    return () => clearTimeout(t);
  }, [onClose, isError]);
  return (
    <div style={{
      position: 'fixed', top: '1.5rem', right: '1.5rem', zIndex: 10000,
      background: isError ? 'rgba(239,68,68,0.96)' : 'rgba(34,197,94,0.95)', color: '#fff',
      padding: '0.75rem 1.25rem', borderRadius: '10px', boxShadow: '0 8px 24px rgba(0,0,0,0.18)',
      display: 'flex', alignItems: 'flex-start', gap: '0.5rem',
      maxWidth: '380px', lineHeight: 1.4, fontSize: '0.875rem',
    }}>
      {isError ? <AlertTriangle size={18} style={{ flexShrink: 0, marginTop: 1 }} />
        : <Check size={18} style={{ flexShrink: 0, marginTop: 1 }} />}
      <span>{msg}</span>
    </div>
  );
}

// Short relative-ish date like Gmail: "10:42 AM" today, "Jun 17" same year, else "6/11/25".
function fmtListDate(iso) {
  if (!iso) return '';
  try {
    const d = new Date(iso);
    const now = new Date();
    const sameDay = d.toDateString() === now.toDateString();
    if (sameDay) return d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
    if (d.getFullYear() === now.getFullYear()) return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
    return d.toLocaleDateString(undefined, { month: 'numeric', day: 'numeric', year: '2-digit' });
  } catch { return iso; }
}

function fmtFull(iso) {
  if (!iso) return '';
  try {
    return new Date(iso).toLocaleString(undefined, {
      weekday: 'short', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
    });
  } catch { return iso; }
}

// "Display Name <addr@host>" → display name (or the address). For the avatar + row.
function senderName(from) {
  if (!from) return '(unknown)';
  const m = from.match(/^\s*"?([^"<]*?)"?\s*<[^>]+>\s*$/);
  const name = m && m[1].trim();
  return name || from.replace(/<|>/g, '').trim();
}
function senderEmail(from) {
  if (!from) return '';
  const m = from.match(/<([^>]+)>/);
  return (m ? m[1] : from).trim();
}

// Stable per-sender avatar colour (Gmail tints each correspondent).
const AVATAR_COLORS = ['#1a73e8', '#ea4335', '#188038', '#e37400', '#9334e6', '#129eaf', '#d01884', '#c5221f'];
function avatarColor(seed) {
  let h = 0;
  for (let i = 0; i < (seed || '').length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  return AVATAR_COLORS[h % AVATAR_COLORS.length];
}

function Avatar({ from, size = 38 }) {
  const name = senderName(from);
  const letter = (name || '?').trim().charAt(0).toUpperCase() || '?';
  return (
    <div style={{
      width: size, height: size, borderRadius: '50%', flexShrink: 0,
      background: avatarColor(senderEmail(from) || name), color: '#fff',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      fontWeight: 600, fontSize: size * 0.42,
    }}>
      {letter}
    </div>
  );
}

const FOLDERS = [
  { key: 'inbox', label: 'Inbox', icon: InboxIcon, q: 'in:inbox' },
  { key: 'sent', label: 'Sent', icon: Send, q: 'in:sent' },
  { key: 'all', label: 'All', icon: Mail, q: '' },
];

export default function GmailInbox() {
  const notify = useNotify();
  const [status, setStatus] = useState({ connected: false, emailAddress: null, lastSyncAt: null });
  const [loadingStatus, setLoadingStatus] = useState(true);
  const [messages, setMessages] = useState([]);
  const [loadingMsgs, setLoadingMsgs] = useState(false);
  const [selected, setSelected] = useState(null);
  const [loadingSelected, setLoadingSelected] = useState(false);
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState('');
  const [folder, setFolder] = useState('inbox');
  const [search, setSearch] = useState('');
  const [showCompose, setShowCompose] = useState(false);
  const [form, setForm] = useState({ to: '', subject: '', cc: '', bcc: '' });
  const [showCc, setShowCc] = useState(false);
  const [showBcc, setShowBcc] = useState(false);
  const [attachments, setAttachments] = useState([]);
  const [sending, setSending] = useState(false);
  const fileInputRef = useRef(null);
  const bodyRef = useRef(null);

  // ?connected / ?error from the OAuth callback redirect.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get('connected') === 'gmail') {
      setToast('Gmail connected!');
      window.history.replaceState({}, '', window.location.pathname);
    } else if (params.get('error')) {
      setToast(`Connection failed: ${params.get('error')}`);
      window.history.replaceState({}, '', window.location.pathname);
    }
  }, []);

  const loadMessages = useCallback(async (folderKey = folder, searchTerm = search) => {
    setLoadingMsgs(true);
    try {
      const base = (FOLDERS.find((f) => f.key === folderKey) || {}).q || '';
      const q = [base, (searchTerm || '').trim()].filter(Boolean).join(' ');
      const qs = q ? `&q=${encodeURIComponent(q)}` : '';
      const res = await fetchApi(`/api/gmail/messages?maxResults=25${qs}`, { silent: true });
      setMessages(Array.isArray(res?.messages) ? res.messages : []);
    } catch (e) {
      if (/reconnect|expired/i.test(e.message || '')) setToast('Your Gmail connection expired. Please reconnect.');
      else setToast(e.message || 'Failed to load messages');
    } finally {
      setLoadingMsgs(false);
    }
  }, [folder, search]);

  const loadStatus = useCallback(async () => {
    setLoadingStatus(true);
    try {
      const s = await fetchApi('/api/gmail/status', { silent: true });
      setStatus(s || { connected: false });
      if (s && s.connected) loadMessages('inbox', '');
    } catch {
      setStatus({ connected: false });
    } finally {
      setLoadingStatus(false);
    }
  }, [loadMessages]);

  useEffect(() => { loadStatus(); }, [loadStatus]);

  const switchFolder = (key) => {
    setFolder(key);
    setSelected(null);
    loadMessages(key, search);
  };

  const handleConnect = async () => {
    setBusy(true);
    try {
      const res = await fetchApi('/api/gmail/connect', { silent: true });
      if (res && res.authUrl) window.location.href = res.authUrl;
      else setToast('Failed to start Gmail OAuth');
    } catch (e) {
      setToast(/not configured/i.test(e.message || '')
        ? 'Gmail is not configured on the server yet. Add the Google OAuth keys.'
        : (e.message || 'Unable to connect'));
    } finally {
      setBusy(false);
    }
  };

  const handleDisconnect = async () => {
    if (!(await notify.confirm('Disconnect Gmail? Emails already logged to the CRM stay.'))) return;
    setBusy(true);
    try {
      await fetchApi('/api/gmail/disconnect', { method: 'DELETE', silent: true });
      setToast('Gmail disconnected');
      setMessages([]);
      setSelected(null);
      await loadStatus();
    } catch (e) {
      setToast(e.message || 'Disconnect failed');
    } finally {
      setBusy(false);
    }
  };

  const openMessage = async (id) => {
    setLoadingSelected(true);
    setSelected({ id });
    try {
      const full = await fetchApi(`/api/gmail/messages/${id}`, { silent: true });
      setSelected(full);
      // Optimistically clear the unread emphasis in the list.
      setMessages((prev) => prev.map((m) => (m.id === id ? { ...m, unread: false } : m)));
    } catch (e) {
      setToast(e.message || 'Failed to open message');
      setSelected(null);
    } finally {
      setLoadingSelected(false);
    }
  };

  const openCompose = (prefill = {}) => {
    setForm({ to: prefill.to || '', subject: prefill.subject || '', cc: '', bcc: '' });
    setAttachments([]);
    setShowCc(false);
    setShowBcc(false);
    setShowCompose(true);
  };

  // Focus the contentEditable body when compose opens.
  useEffect(() => {
    if (showCompose && bodyRef.current) {
      bodyRef.current.innerHTML = '';
      requestAnimationFrame(() => bodyRef.current?.focus());
    }
  }, [showCompose]);

  const handleFiles = (files) => {
    const MAX = 25 * 1024 * 1024;
    const valid = Array.from(files).filter((f) => {
      if (f.size > MAX) { setToast(`${f.name} exceeds the 25 MB limit`); return false; }
      return true;
    });
    setAttachments((prev) => [...prev, ...valid]);
  };

  const removeAttachment = (idx) => setAttachments((prev) => prev.filter((_, i) => i !== idx));

  const replyTo = (msg) => {
    const subject = msg.subject ? (/^re:/i.test(msg.subject) ? msg.subject : `Re: ${msg.subject}`) : '';
    openCompose({ to: senderEmail(msg.from), subject });
    setSelected(null);
  };

  const handleSend = async (e) => {
    e.preventDefault();
    const bodyHtml = bodyRef.current?.innerHTML?.trim() || '';
    // innerText is unavailable in jsdom; textContent is the reliable fallback.
    const bodyText = (bodyRef.current?.innerText || bodyRef.current?.textContent || '').trim();
    if (!form.to.trim() || !bodyText) {
      setToast('Recipient and a message body are required');
      return;
    }
    setSending(true);
    try {
      const payload = {
        to: form.to.trim(),
        subject: form.subject,
        text: bodyText,
        html: bodyHtml,
        ...(form.cc.trim() ? { cc: form.cc.trim() } : {}),
        ...(form.bcc.trim() ? { bcc: form.bcc.trim() } : {}),
      };
      if (attachments.length > 0) {
        const fd = new FormData();
        Object.entries(payload).forEach(([k, v]) => fd.append(k, v));
        attachments.forEach((f) => fd.append('attachments', f, f.name));
        await fetchApi('/api/gmail/send', { method: 'POST', body: fd, silent: true });
      } else {
        await fetchApi('/api/gmail/send', {
          method: 'POST', body: JSON.stringify(payload), silent: true,
        });
      }
      setToast('Email sent');
      setShowCompose(false);
      setForm({ to: '', subject: '', cc: '', bcc: '' });
      setAttachments([]);
      setShowCc(false);
      setShowBcc(false);
      // Gmail indexes a just-sent message after a short beat — ~2.5s before refresh.
      setTimeout(() => loadMessages(folder, search), 2500);
    } catch (err) {
      setToast(/reconnect|expired/i.test(err.message || '')
        ? 'Your Gmail connection expired. Please reconnect.'
        : (err.message || "Couldn't send the email"));
    } finally {
      setSending(false);
    }
  };

  // ── Initial status check ─────────────────────────────────────────
  if (loadingStatus) {
    return (
      <div style={{ padding: '2rem', color: 'var(--text-secondary)', display: 'flex', alignItems: 'center', gap: '0.6rem' }}>
        <RefreshCw size={16} className="spin" /> Checking Gmail connection…
      </div>
    );
  }

  // ── Not connected ────────────────────────────────────────────────
  if (!status.connected) {
    return (
      <div style={{ padding: '2rem', animation: 'fadeIn 0.3s ease' }}>
        {toast && <Toast msg={toast} onClose={() => setToast('')} />}
        <div style={{
          maxWidth: 460, margin: '8vh auto 0', textAlign: 'center',
          background: 'var(--card-bg, rgba(255,255,255,0.04))',
          border: '1px solid var(--border-color)', borderRadius: 16, padding: '2.5rem 2rem',
        }}>
          <div style={{
            width: 64, height: 64, borderRadius: '50%', margin: '0 auto 1rem',
            background: 'rgba(234,67,53,0.12)', color: GMAIL_RED,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}>
            <Mail size={30} />
          </div>
          <h2 style={{ margin: '0 0 0.4rem', fontSize: '1.4rem' }}>Connect your Gmail</h2>
          <p style={{ color: 'var(--text-secondary)', margin: '0 0 1.5rem', fontSize: '0.9rem', lineHeight: 1.5 }}>
            Read and send email from inside the CRM. Each person connects their own account — your
            mailbox stays private to you. <strong>Not connected.</strong>
          </p>
          <button
            onClick={handleConnect}
            disabled={busy}
            style={{
              padding: '0.7rem 1.5rem', borderRadius: 999, border: 'none',
              background: GMAIL_BLUE, color: '#fff', cursor: 'pointer', fontWeight: 600, fontSize: '0.95rem',
              display: 'inline-flex', alignItems: 'center', gap: '0.5rem', opacity: busy ? 0.7 : 1,
            }}
          >
            <Plug size={16} /> {busy ? 'Connecting…' : 'Connect Gmail'}
          </button>
        </div>
      </div>
    );
  }

  // ── Connected ────────────────────────────────────────────────────
  return (
    <div style={{ padding: '1.5rem 2rem', animation: 'fadeIn 0.3s ease' }}>
      {toast && <Toast msg={toast} onClose={() => setToast('')} />}

      {/* Top bar: brand + search + account/actions */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '1rem', marginBottom: '1rem', flexWrap: 'wrap' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem' }}>
          <Mail size={24} style={{ color: GMAIL_RED }} />
          <span style={{ fontSize: '1.35rem', fontWeight: 700 }}>Gmail</span>
        </div>

        {/* Gmail-style rounded search bar */}
        <form
          onSubmit={(e) => { e.preventDefault(); loadMessages(folder, search); }}
          style={{ flex: 1, minWidth: 220, maxWidth: 560, display: 'flex', alignItems: 'center', gap: '0.5rem',
            background: 'var(--input-bg, rgba(255,255,255,0.06))', border: '1px solid var(--border-color)',
            borderRadius: 999, padding: '0.5rem 1rem' }}
        >
          <Search size={17} style={{ color: 'var(--text-secondary)', flexShrink: 0 }} />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search mail"
            aria-label="Search mail"
            style={{ flex: 1, background: 'transparent', border: 'none', outline: 'none',
              color: 'var(--text-primary)', fontSize: '0.9rem' }}
          />
          {search && (
            <button type="button" onClick={() => { setSearch(''); loadMessages(folder, ''); }}
              aria-label="Clear search"
              style={{ background: 'none', border: 'none', color: 'var(--text-secondary)', cursor: 'pointer', padding: 0 }}>
              <X size={16} />
            </button>
          )}
        </form>

        <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem', marginLeft: 'auto' }}>
          <span style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', display: 'inline-flex', alignItems: 'center', gap: '0.35rem' }}>
            <span style={{ width: 8, height: 8, borderRadius: '50%', background: '#22c55e', display: 'inline-block' }} />
            Connected as {status.emailAddress || '—'}
          </span>
          <button onClick={handleDisconnect} disabled={busy} title="Disconnect"
            style={{ background: 'none', border: '1px solid rgba(239,68,68,0.4)', color: '#ef4444',
              borderRadius: 8, padding: '0.35rem 0.6rem', cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: '0.3rem', fontSize: '0.8rem' }}>
            <Trash2 size={14} /> Disconnect
          </button>
        </div>
      </div>

      {/* Mailbox panel */}
      <div style={{
        background: 'var(--card-bg, rgba(255,255,255,0.04))',
        border: '1px solid var(--border-color)', borderRadius: 14, overflow: 'hidden',
      }}>
        {/* Toolbar: Compose + folders + refresh */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', padding: '0.85rem 1rem',
          borderBottom: '1px solid var(--border-color)', flexWrap: 'wrap' }}>
          <button
            onClick={() => openCompose()}
            style={{ padding: '0.6rem 1.1rem', borderRadius: 999, border: 'none', background: GMAIL_BLUE,
              color: '#fff', cursor: 'pointer', fontWeight: 600, fontSize: '0.88rem',
              display: 'inline-flex', alignItems: 'center', gap: '0.45rem', boxShadow: '0 1px 3px rgba(0,0,0,0.25)' }}
          >
            <PencilLine size={16} /> Compose
          </button>

          <div style={{ display: 'flex', gap: '0.25rem', background: 'var(--input-bg, rgba(255,255,255,0.05))', borderRadius: 999, padding: 3 }}>
            {FOLDERS.map((f) => {
              const active = folder === f.key;
              const Icon = f.icon;
              return (
                <button key={f.key} onClick={() => switchFolder(f.key)}
                  style={{ padding: '0.35rem 0.85rem', borderRadius: 999, border: 'none', cursor: 'pointer',
                    fontSize: '0.82rem', fontWeight: active ? 700 : 500,
                    background: active ? 'var(--primary-color, ' + GMAIL_BLUE + ')' : 'transparent',
                    color: active ? '#fff' : 'var(--text-secondary)',
                    display: 'inline-flex', alignItems: 'center', gap: '0.35rem' }}>
                  <Icon size={14} /> {f.label}
                </button>
              );
            })}
          </div>

          <button onClick={() => loadMessages(folder, search)} disabled={loadingMsgs} title="Refresh"
            style={{ marginLeft: 'auto', background: 'none', border: '1px solid var(--border-color)',
              color: 'var(--text-primary)', borderRadius: 8, padding: '0.4rem 0.55rem', cursor: 'pointer',
              display: 'inline-flex', alignItems: 'center' }}>
            <RefreshCw size={15} className={loadingMsgs ? 'spin' : ''} />
          </button>
        </div>

        {/* Message rows */}
        {loadingMsgs ? (
          <div style={{ padding: '3rem', textAlign: 'center', color: 'var(--text-secondary)' }}>Loading…</div>
        ) : messages.length === 0 ? (
          <div style={{ padding: '3rem', textAlign: 'center', color: 'var(--text-secondary)' }}>
            Nothing here. Try another folder, search, or Compose a new email.
          </div>
        ) : (
          <div>
            {messages.map((m) => (
              <button
                key={m.id}
                onClick={() => openMessage(m.id)}
                style={{
                  width: '100%', textAlign: 'left', cursor: 'pointer', border: 'none',
                  borderBottom: '1px solid var(--border-color)',
                  background: m.unread ? 'var(--hover-bg, rgba(255,255,255,0.04))' : 'transparent',
                  display: 'flex', alignItems: 'center', gap: '0.85rem', padding: '0.7rem 1rem',
                  transition: 'background 0.12s ease',
                }}
                onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--surface-hover, rgba(255,255,255,0.07))'; }}
                onMouseLeave={(e) => { e.currentTarget.style.background = m.unread ? 'var(--hover-bg, rgba(255,255,255,0.04))' : 'transparent'; }}
              >
                <Avatar from={m.from} />
                <span style={{
                  width: 180, flexShrink: 0, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                  fontSize: '0.88rem', fontWeight: m.unread ? 700 : 500, color: 'var(--text-primary)',
                }}>
                  {senderName(m.from)}
                </span>
                <span style={{ flex: 1, minWidth: 0, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', fontSize: '0.88rem' }}>
                  <span style={{ fontWeight: m.unread ? 700 : 500, color: 'var(--text-primary)' }}>
                    {m.subject || '(no subject)'}
                  </span>
                  {m.snippet && (
                    <span style={{ color: 'var(--text-secondary)' }}> — {m.snippet}</span>
                  )}
                </span>
                {m.unread && (
                  <span style={{ width: 8, height: 8, borderRadius: '50%', background: GMAIL_RED, flexShrink: 0 }} />
                )}
                <span style={{ fontSize: '0.78rem', color: 'var(--text-secondary)', flexShrink: 0, width: 70, textAlign: 'right',
                  fontWeight: m.unread ? 700 : 400 }}>
                  {fmtListDate(m.date)}
                </span>
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Reading view */}
      {selected && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.45)', zIndex: 9998,
          display: 'flex', alignItems: 'center', justifyContent: 'center' }}
          onClick={() => setSelected(null)}>
          <div onClick={(e) => e.stopPropagation()} style={{
            background: 'var(--bg-color)', border: '1px solid var(--border-color)', borderRadius: 14,
            boxShadow: '0 16px 48px rgba(0,0,0,0.3)', width: '92%', maxWidth: 680, maxHeight: '86vh', overflowY: 'auto' }}>
            {/* Subject header bar */}
            <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: '1rem',
              padding: '1.25rem 1.5rem 0.75rem' }}>
              <h2 style={{ margin: 0, fontSize: '1.35rem', fontWeight: 400, color: 'var(--text-primary)', lineHeight: 1.3 }}>
                {loadingSelected ? 'Loading…' : (selected.subject || '(no subject)')}
              </h2>
              <button onClick={() => setSelected(null)} aria-label="Close"
                style={{ background: 'none', border: 'none', color: 'var(--text-secondary)', cursor: 'pointer', padding: 0, flexShrink: 0 }}>
                <X size={20} />
              </button>
            </div>
            {!loadingSelected && (
              <>
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', padding: '0.25rem 1.5rem 1rem' }}>
                  <Avatar from={selected.from} size={40} />
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <div style={{ fontSize: '0.92rem', fontWeight: 600, color: 'var(--text-primary)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                      {senderName(selected.from)}
                      <span style={{ fontWeight: 400, color: 'var(--text-secondary)', marginLeft: 6, fontSize: '0.82rem' }}>
                        &lt;{senderEmail(selected.from)}&gt;
                      </span>
                    </div>
                    <div style={{ fontSize: '0.78rem', color: 'var(--text-secondary)' }}>
                      to {selected.to || 'me'} · {fmtFull(selected.date)}
                    </div>
                  </div>
                  <button onClick={() => replyTo(selected)} title="Reply"
                    style={{ background: 'none', border: '1px solid var(--border-color)', color: 'var(--text-primary)',
                      borderRadius: 999, padding: '0.4rem 0.85rem', cursor: 'pointer', fontSize: '0.82rem',
                      display: 'inline-flex', alignItems: 'center', gap: '0.35rem', flexShrink: 0 }}>
                    <CornerUpLeft size={14} /> Reply
                  </button>
                </div>
                {/* Plain-text body (NOT raw HTML) — safe against injected markup. */}
                <div style={{ padding: '1.25rem 1.5rem', borderTop: '1px solid var(--border-color)',
                  fontSize: '0.92rem', color: 'var(--text-primary)', whiteSpace: 'pre-wrap', lineHeight: 1.55 }}>
                  {linkifyText(selected.text || selected.snippet || '(no preview available)')}
                </div>
              </>
            )}
          </div>
        </div>
      )}

      {/* Gmail-style docked compose window (bottom-right) */}
      {showCompose && (
        <form onSubmit={handleSend} style={{
          position: 'fixed', bottom: 0, right: 24, zIndex: 9999, width: 560, maxWidth: 'calc(100vw - 48px)',
          background: 'var(--bg-color)', border: '1px solid var(--border-color)',
          borderRadius: '12px 12px 0 0', boxShadow: '0 -4px 32px rgba(0,0,0,0.35)',
          display: 'flex', flexDirection: 'column', maxHeight: '82vh',
        }}>
          {/* ── Dark header bar ── */}
          <div style={{
            background: COMPOSE_HEADER, color: '#fff', padding: '0.6rem 1rem',
            borderRadius: '12px 12px 0 0', display: 'flex', alignItems: 'center',
            justifyContent: 'space-between', userSelect: 'none',
          }}>
            <span style={{ fontSize: '0.9rem', fontWeight: 600 }}>New Message</span>
            <button type="button" onClick={() => setShowCompose(false)} aria-label="Close compose"
              style={{ background: 'none', border: 'none', color: '#aaa', cursor: 'pointer', padding: '0.1rem', lineHeight: 1 }}>
              <X size={16} />
            </button>
          </div>

          {/* ── To ── */}
          <div style={{ display: 'flex', alignItems: 'center', borderBottom: '1px solid var(--border-color)' }}>
            <span style={{ padding: '0.6rem 0.75rem 0.6rem 1rem', color: 'var(--text-secondary)', fontSize: '0.82rem', flexShrink: 0, minWidth: 38 }}>To</span>
            <input
              type="email" value={form.to} aria-label="To"
              onChange={(e) => setForm({ ...form, to: e.target.value })}
              style={{ flex: 1, border: 'none', padding: '0.6rem 0.25rem', background: 'transparent',
                color: 'var(--text-primary)', outline: 'none', fontSize: '0.9rem' }}
            />
            <button type="button" onClick={() => setShowCc((v) => !v)}
              style={{ padding: '0.2rem 0.55rem', fontSize: '0.76rem', color: showCc ? GMAIL_BLUE : 'var(--text-secondary)',
                background: 'none', border: 'none', cursor: 'pointer', flexShrink: 0, fontWeight: showCc ? 600 : 400 }}>
              Cc
            </button>
            <button type="button" onClick={() => setShowBcc((v) => !v)}
              style={{ padding: '0.2rem 0.65rem 0.2rem 0.25rem', fontSize: '0.76rem', color: showBcc ? GMAIL_BLUE : 'var(--text-secondary)',
                background: 'none', border: 'none', cursor: 'pointer', flexShrink: 0, fontWeight: showBcc ? 600 : 400 }}>
              Bcc
            </button>
          </div>

          {/* ── CC ── */}
          {showCc && (
            <div style={{ display: 'flex', alignItems: 'center', borderBottom: '1px solid var(--border-color)' }}>
              <span style={{ padding: '0.55rem 0.75rem 0.55rem 1rem', color: 'var(--text-secondary)', fontSize: '0.82rem', flexShrink: 0, minWidth: 38 }}>Cc</span>
              <input
                type="text" placeholder="Add recipients" value={form.cc} aria-label="CC"
                onChange={(e) => setForm({ ...form, cc: e.target.value })}
                style={{ flex: 1, border: 'none', padding: '0.55rem 0.25rem', background: 'transparent',
                  color: 'var(--text-primary)', outline: 'none', fontSize: '0.9rem' }}
              />
            </div>
          )}

          {/* ── BCC ── */}
          {showBcc && (
            <div style={{ display: 'flex', alignItems: 'center', borderBottom: '1px solid var(--border-color)' }}>
              <span style={{ padding: '0.55rem 0.75rem 0.55rem 1rem', color: 'var(--text-secondary)', fontSize: '0.82rem', flexShrink: 0, minWidth: 38 }}>Bcc</span>
              <input
                type="text" placeholder="Add recipients" value={form.bcc} aria-label="BCC"
                onChange={(e) => setForm({ ...form, bcc: e.target.value })}
                style={{ flex: 1, border: 'none', padding: '0.55rem 0.25rem', background: 'transparent',
                  color: 'var(--text-primary)', outline: 'none', fontSize: '0.9rem' }}
              />
            </div>
          )}

          {/* ── Subject ── */}
          <input
            type="text" placeholder="Subject" value={form.subject} aria-label="Subject"
            onChange={(e) => setForm({ ...form, subject: e.target.value })}
            style={{ border: 'none', borderBottom: '1px solid var(--border-color)', padding: '0.65rem 1rem',
              background: 'transparent', color: 'var(--text-primary)', outline: 'none', fontSize: '0.9rem' }}
          />

          {/* ── Formatting toolbar ── */}
          <div style={{
            display: 'flex', alignItems: 'center', gap: '0.1rem', padding: '0.3rem 0.6rem',
            borderBottom: '1px solid var(--border-color)',
            background: 'var(--input-bg, rgba(255,255,255,0.025))',
          }}>
            {[
              { cmd: 'bold',      label: <strong style={{ fontFamily: 'Georgia, serif', fontSize: '0.85rem', letterSpacing: '-0.3px' }}>B</strong>, title: 'Bold (Ctrl+B)' },
              { cmd: 'italic',    label: <em style={{ fontFamily: 'Georgia, serif', fontSize: '0.85rem' }}>I</em>,    title: 'Italic (Ctrl+I)' },
              { cmd: 'underline', label: <span style={{ textDecoration: 'underline', fontSize: '0.8rem' }}>U</span>, title: 'Underline (Ctrl+U)' },
            ].map(({ cmd, label, title }) => (
              <button key={cmd} type="button" title={title}
                onMouseDown={(e) => { e.preventDefault(); document.execCommand(cmd, false, null); }}
                style={{ padding: '0.28rem 0.5rem', borderRadius: 4, border: '1px solid transparent',
                  background: 'none', cursor: 'pointer', color: 'var(--text-primary)', lineHeight: 1 }}
                onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--hover-bg,rgba(255,255,255,0.09))'; e.currentTarget.style.borderColor = 'var(--border-color)'; }}
                onMouseLeave={(e) => { e.currentTarget.style.background = 'none'; e.currentTarget.style.borderColor = 'transparent'; }}
              >{label}</button>
            ))}
            <div style={{ width: 1, height: 14, background: 'var(--border-color)', margin: '0 0.25rem', flexShrink: 0 }} />
            <button type="button" title="Insert link"
              onMouseDown={(e) => {
                e.preventDefault();
                const url = window.prompt('URL');
                if (url) document.execCommand('createLink', false, url);
              }}
              style={{ padding: '0.28rem 0.45rem', borderRadius: 4, border: '1px solid transparent',
                background: 'none', cursor: 'pointer', color: 'var(--text-secondary)', lineHeight: 1 }}
              onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--hover-bg,rgba(255,255,255,0.09))'; e.currentTarget.style.borderColor = 'var(--border-color)'; }}
              onMouseLeave={(e) => { e.currentTarget.style.background = 'none'; e.currentTarget.style.borderColor = 'transparent'; }}
            >
              <Link2 size={13} />
            </button>
            <button type="button" title="Ordered list"
              onMouseDown={(e) => { e.preventDefault(); document.execCommand('insertOrderedList', false, null); }}
              style={{ padding: '0.28rem 0.45rem', borderRadius: 4, border: '1px solid transparent',
                background: 'none', cursor: 'pointer', color: 'var(--text-secondary)', lineHeight: 1 }}
              onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--hover-bg,rgba(255,255,255,0.09))'; e.currentTarget.style.borderColor = 'var(--border-color)'; }}
              onMouseLeave={(e) => { e.currentTarget.style.background = 'none'; e.currentTarget.style.borderColor = 'transparent'; }}
            >
              <ListOrdered size={13} />
            </button>
            <button type="button" title="Bullet list"
              onMouseDown={(e) => { e.preventDefault(); document.execCommand('insertUnorderedList', false, null); }}
              style={{ padding: '0.28rem 0.45rem', borderRadius: 4, border: '1px solid transparent',
                background: 'none', cursor: 'pointer', color: 'var(--text-secondary)', lineHeight: 1 }}
              onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--hover-bg,rgba(255,255,255,0.09))'; e.currentTarget.style.borderColor = 'var(--border-color)'; }}
              onMouseLeave={(e) => { e.currentTarget.style.background = 'none'; e.currentTarget.style.borderColor = 'transparent'; }}
            >
              <List size={13} />
            </button>
          </div>

          {/* ── Compose body (contentEditable) ── */}
          {/* Placeholder via CSS injected once */}
          <style>{`.gcb:empty::before{content:attr(data-placeholder);color:rgba(128,128,128,0.55);pointer-events:none;display:block}`}</style>
          <div
            ref={bodyRef}
            contentEditable="true"
            role="textbox"
            aria-label="Message body"
            aria-multiline="true"
            data-placeholder="Compose your message…"
            className="gcb"
            suppressContentEditableWarning
            style={{
              border: 'none', padding: '0.9rem 1rem', background: 'transparent',
              color: 'var(--text-primary)', outline: 'none', fontSize: '0.92rem',
              minHeight: 180, fontFamily: 'inherit', flex: 1, overflowY: 'auto',
              lineHeight: 1.6, wordBreak: 'break-word',
            }}
          />

          {/* ── Attachment chips ── */}
          {attachments.length > 0 && (
            <div style={{ padding: '0.45rem 0.85rem', borderTop: '1px solid var(--border-color)',
              display: 'flex', flexWrap: 'wrap', gap: '0.45rem' }}>
              {attachments.map((f, i) => (
                <div key={i} style={{
                  display: 'flex', alignItems: 'center', gap: '0.35rem',
                  background: 'var(--input-bg, rgba(255,255,255,0.07))',
                  borderRadius: 6, padding: '0.28rem 0.6rem',
                  fontSize: '0.78rem', color: 'var(--text-primary)',
                  border: '1px solid var(--border-color)',
                }}>
                  <Paperclip size={11} style={{ flexShrink: 0 }} />
                  <span style={{ maxWidth: 150, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{f.name}</span>
                  <span style={{ color: 'var(--text-secondary)', fontSize: '0.7rem', flexShrink: 0 }}>
                    ({f.size < 1024 * 1024 ? `${(f.size / 1024).toFixed(0)} KB` : `${(f.size / (1024 * 1024)).toFixed(1)} MB`})
                  </span>
                  <button type="button" onClick={() => removeAttachment(i)}
                    style={{ background: 'none', border: 'none', color: 'var(--text-secondary)', cursor: 'pointer', padding: 0, lineHeight: 1, flexShrink: 0 }}>
                    <X size={11} />
                  </button>
                </div>
              ))}
            </div>
          )}

          {/* ── Footer: Send + attach + discard ── */}
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', padding: '0.6rem 0.85rem',
            borderTop: '1px solid var(--border-color)' }}>
            <button type="submit" disabled={sending}
              style={{ padding: '0.52rem 1.4rem', borderRadius: 999, border: 'none', background: GMAIL_BLUE,
                color: '#fff', cursor: sending ? 'wait' : 'pointer', fontWeight: 600, fontSize: '0.9rem',
                display: 'inline-flex', alignItems: 'center', gap: '0.4rem',
                boxShadow: '0 1px 3px rgba(26,115,232,0.4)' }}>
              <Send size={14} /> {sending ? 'Sending…' : 'Send'}
            </button>

            {/* Hidden file input */}
            <input
              ref={fileInputRef}
              type="file"
              multiple
              style={{ display: 'none' }}
              onChange={(e) => { handleFiles(e.target.files); e.target.value = ''; }}
            />
            <button type="button" title="Attach files" onClick={() => fileInputRef.current?.click()}
              style={{ padding: '0.44rem 0.5rem', borderRadius: 8, border: '1px solid transparent',
                background: 'none', cursor: 'pointer', color: 'var(--text-secondary)',
                display: 'inline-flex', alignItems: 'center' }}
              onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--hover-bg,rgba(255,255,255,0.09))'; e.currentTarget.style.borderColor = 'var(--border-color)'; }}
              onMouseLeave={(e) => { e.currentTarget.style.background = 'none'; e.currentTarget.style.borderColor = 'transparent'; }}
            >
              <Paperclip size={17} />
            </button>

            <button type="button" onClick={() => setShowCompose(false)} disabled={sending}
              title="Discard draft"
              style={{ marginLeft: 'auto', background: 'none', border: 'none',
                color: 'var(--text-secondary)', cursor: 'pointer', padding: '0.3rem',
                display: 'inline-flex', alignItems: 'center' }}>
              <Trash2 size={17} />
            </button>
          </div>
        </form>
      )}
    </div>
  );
}
