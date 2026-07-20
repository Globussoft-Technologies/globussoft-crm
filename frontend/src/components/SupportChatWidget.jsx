import React, { useContext, useEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { X, SendHorizonal, Loader2 } from 'lucide-react';
import { AuthContext } from '../App';
import { fetchApi } from '../utils/api';

// ─── Wellness Admin Support Chatbot ─────────────────────────────────────────
//
// Floating help widget for WELLNESS-vertical staff only (mounted in
// Layout.jsx next to the Softphone; both the mount site and this component
// check tenant.vertical === 'wellness'). Talks to:
//   POST /api/support-chat/message  — AI turns (RAG over the tenant KB +
//                                     wellness PRD/docs + page-info deep links)
//
// Behaviour contract (pinned by __tests__/SupportChatWidget.test.jsx):
//   - 48px floating button, default bottom-right, friendly robot icon.
//   - Draggable with a 5px movement threshold distinguishing drag from
//     click; clamped to the main content area — never over the left
//     sidebar (#app-sidebar, 250px) and never outside the viewport.
//   - Position persists per user: localStorage
//     wellness_support_chat_pos_<userId> = { x, y } (viewport left/top).
//   - Session persists per user: localStorage
//     wellness_support_chat_session_<userId> = [{ role, content, ... }].
//   - Every turn sends the current page (useLocation) as pageContext.
//   - When the panel is open the FAB is hidden; close only via the panel X.

const BUTTON_SIZE = 48;
const DRAG_THRESHOLD_PX = 5;
const VIEWPORT_MARGIN = 8;
const PANEL_WIDTH = 360;
const PANEL_HEIGHT = 470;
// The widget replays prior turns as history; cap it the same way the
// backend does so a long session can't blow the prompt budget.
const MAX_HISTORY_TURNS = 20;
const MAX_STORED_MESSAGES = 100;

function posKey(userId) {
  return `wellness_support_chat_pos_${userId}`;
}
function sessionKey(userId) {
  return `wellness_support_chat_session_${userId}`;
}

function defaultPos() {
  if (typeof window === 'undefined') return { x: 0, y: 0 };
  return {
    x: window.innerWidth - BUTTON_SIZE - 32,
    y: window.innerHeight - BUTTON_SIZE - 32,
  };
}

function loadPos(userId) {
  try {
    const raw = localStorage.getItem(posKey(userId));
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (Number.isFinite(parsed?.x) && Number.isFinite(parsed?.y)) return parsed;
  } catch {
    /* ignore corrupt payloads */
  }
  return null;
}

function loadSession(userId) {
  try {
    const raw = localStorage.getItem(sessionKey(userId));
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed;
  } catch {
    /* ignore corrupt payloads */
  }
  return [];
}

// Left boundary of the draggable area: the sidebar's right edge when it's
// visible (desktop), otherwise the plain viewport margin. On mobile the
// sidebar is an off-canvas drawer (rect.right <= 0), so it naturally
// drops out of the constraint.
function minX() {
  if (typeof document === 'undefined') return VIEWPORT_MARGIN;
  const sidebar = document.getElementById('app-sidebar');
  const right = sidebar ? sidebar.getBoundingClientRect().right : 0;
  return Math.max(VIEWPORT_MARGIN, right > 0 ? right + VIEWPORT_MARGIN : VIEWPORT_MARGIN);
}

function clampPos(pos) {
  const maxX = window.innerWidth - BUTTON_SIZE - VIEWPORT_MARGIN;
  const maxY = window.innerHeight - BUTTON_SIZE - VIEWPORT_MARGIN;
  return {
    x: Math.min(Math.max(pos.x, minX()), Math.max(minX(), maxX)),
    y: Math.min(Math.max(pos.y, VIEWPORT_MARGIN), Math.max(VIEWPORT_MARGIN, maxY)),
  };
}

// Derive a human page name from the SPA route for the LLM's page context.
function pageNameFor(pathname) {
  const seg = String(pathname || '').split('/').filter(Boolean).pop() || 'dashboard';
  return seg
    .split('-')
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

// Friendly inline robot face for the FAB and panel header. No external
// image dependency, theme-agnostic white on the brand accent.
function RobotIcon({ size = 22 }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect x="3" y="8" width="18" height="12" rx="4" />
      <circle cx="9" cy="13" r="1.5" fill="currentColor" stroke="none" />
      <circle cx="15" cy="13" r="1.5" fill="currentColor" stroke="none" />
      <path d="M10 17h4" />
      <path d="M12 8V5" />
      <circle cx="12" cy="4" r="1" fill="currentColor" stroke="none" />
    </svg>
  );
}

export default function SupportChatWidget() {
  const { user, tenant } = useContext(AuthContext);
  const location = useLocation();
  const navigate = useNavigate();

  const isWellness = tenant?.vertical === 'wellness';
  const userId = user?.id || user?.userId || 'anon';

  const [pos, setPos] = useState(null); // null until mounted (SSR-safe)
  const [open, setOpen] = useState(false);
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);

  const dragRef = useRef({ startX: 0, startY: 0, originX: 0, originY: 0, dragging: false });
  const messagesEndRef = useRef(null);

  // Hydrate position + session from localStorage once (client-only).
  useEffect(() => {
    setPos(clampPos(loadPos(userId) || defaultPos()));
    setMessages(loadSession(userId));
  }, [userId]);

  // Persist position + session.
  useEffect(() => {
    if (!pos) return;
    try {
      localStorage.setItem(posKey(userId), JSON.stringify(pos));
    } catch {
      /* storage may be unavailable */
    }
  }, [pos, userId]);

  useEffect(() => {
    try {
      localStorage.setItem(
        sessionKey(userId),
        JSON.stringify(messages.slice(-MAX_STORED_MESSAGES)),
      );
    } catch {
      /* storage may be unavailable */
    }
    // Auto-scroll to the newest message.
    if (messagesEndRef.current) {
      messagesEndRef.current.scrollIntoView({ block: 'end' });
    }
  }, [messages, userId]);

  // Re-clamp on viewport resize so the button never ends up off-screen.
  useEffect(() => {
    const onResize = () => setPos((p) => (p ? clampPos(p) : p));
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  const pageContext = useMemo(
    () => ({ path: location.pathname, pageName: pageNameFor(location.pathname) }),
    [location.pathname],
  );

  if (!isWellness || !user || !pos) return null;

  // ─── Drag handling (5px threshold: below = click, above = drag) ─────
  // Move/up listeners live on window while pressed so the drag survives
  // the pointer leaving the button mid-gesture.
  const onPointerDown = (e) => {
    dragRef.current = {
      active: true,
      startX: e.clientX,
      startY: e.clientY,
      originX: pos.x,
      originY: pos.y,
      dragging: false,
    };

    const onMove = (ev) => {
      const d = dragRef.current;
      if (!d.active) return;
      const dx = ev.clientX - d.startX;
      const dy = ev.clientY - d.startY;
      if (!d.dragging) {
        if (Math.hypot(dx, dy) < DRAG_THRESHOLD_PX) return;
        d.dragging = true;
      }
      setPos(clampPos({ x: d.originX + dx, y: d.originY + dy }));
    };
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      const wasDrag = dragRef.current.dragging;
      dragRef.current = { active: false, startX: 0, startY: 0, originX: 0, originY: 0, dragging: false };
      if (!wasDrag) setOpen((o) => !o); // below threshold → treat as click
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  };

  // ─── Chat turns ──────────────────────────────────────────────────────
  const sendMessage = async (e) => {
    e && e.preventDefault();
    const text = input.trim();
    if (!text || sending) return;
    setInput('');
    setSending(true);

    const history = messages
      .filter((m) => m.role === 'user' || m.role === 'assistant')
      .slice(-MAX_HISTORY_TURNS)
      .map((m) => ({ role: m.role, content: m.content }));

    setMessages((prev) => [...prev, { role: 'user', content: text }]);
    try {
      const resp = await fetchApi('/api/support-chat/message', {
        method: 'POST',
        body: JSON.stringify({ message: text, history, pageContext }),
        silent: true, // errors surface as chat bubbles, not toasts
      });
      setMessages((prev) => [
        ...prev,
        {
          role: 'assistant',
          content: resp.reply || '(no answer)',
          links: Array.isArray(resp.links) ? resp.links : [],
        },
      ]);
    } catch (err) {
      const friendly =
        err?.code === 'AI_PROVIDER_NOT_CONFIGURED'
          ? 'The AI provider is not configured yet. An administrator can add one under Settings → AI Provider (Support Chatbot).'
          : 'Sorry — I could not get an answer right now. Please try again in a moment.';
      setMessages((prev) => [...prev, { role: 'assistant', content: friendly, isError: true }]);
    } finally {
      setSending(false);
    }
  };

  const openLink = (path) => {
    setOpen(false);
    navigate(path);
  };

  // Panel anchors above-left of the button, clamped into the viewport.
  const panelStyle = {
    left: Math.min(Math.max(pos.x + BUTTON_SIZE - PANEL_WIDTH, minX()), Math.max(minX(), window.innerWidth - PANEL_WIDTH - VIEWPORT_MARGIN)),
    top: Math.min(Math.max(pos.y - PANEL_HEIGHT - 12, VIEWPORT_MARGIN), Math.max(VIEWPORT_MARGIN, window.innerHeight - PANEL_HEIGHT - VIEWPORT_MARGIN)),
    width: PANEL_WIDTH,
    height: PANEL_HEIGHT,
  };

  return (
    <>
      {open && (
        <div
          data-testid="support-chat-panel"
          role="dialog"
          aria-label="Support chat"
          style={{
            position: 'fixed',
            ...panelStyle,
            zIndex: 1100,
            display: 'flex',
            flexDirection: 'column',
            background: 'var(--modal-bg, var(--surface-color))',
            border: '1px solid var(--border-color)',
            borderRadius: 14,
            boxShadow: '0 20px 50px rgba(0,0,0,0.45)',
            overflow: 'hidden',
          }}
        >
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              padding: '10px 12px',
              borderBottom: '1px solid var(--border-color)',
              background: '#111827',
              color: '#ffffff',
            }}
          >
            <RobotIcon size={18} />
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontWeight: 600, fontSize: '0.9rem', lineHeight: 1.2 }}>Support Assistant</div>
              <div style={{ fontSize: '0.68rem', opacity: 0.9 }}>Help with {pageContext.pageName}</div>
            </div>
            <button
              type="button"
              onClick={() => setOpen(false)}
              aria-label="Close support chat"
              style={{ background: 'none', border: 'none', color: '#ffffff', cursor: 'pointer', padding: 4 }}
            >
              <X size={18} />
            </button>
          </div>

          <div
            data-testid="support-chat-messages"
            style={{ flex: 1, overflowY: 'auto', padding: '12px', display: 'flex', flexDirection: 'column', gap: 10 }}
          >
            {messages.length === 0 && (
              <div style={{ color: 'var(--text-secondary)', fontSize: '0.82rem', textAlign: 'center', marginTop: 24 }}>
                Ask anything about using the CRM — appointments, patients, billing, packages, reports and more.
              </div>
            )}
            {messages.map((m, i) => (
              <div
                key={i}
                style={{
                  alignSelf: m.role === 'user' ? 'flex-end' : 'flex-start',
                  maxWidth: '85%',
                  background:
                    m.role === 'user'
                      ? '#0ea5e9'
                      : m.isError
                        ? '#fee2e2'
                        : 'var(--modal-bg)',
                  color: m.role === 'user' ? '#ffffff' : m.isError ? '#991b1b' : 'var(--text-primary)',
                  border: m.role === 'user' ? 'none' : '1px solid var(--border-color)',
                  borderRadius: 12,
                  borderBottomRightRadius: m.role === 'user' ? 4 : 12,
                  borderBottomLeftRadius: m.role === 'user' ? 12 : 4,
                  padding: '10px 12px',
                  fontSize: '0.85rem',
                  lineHeight: 1.45,
                  whiteSpace: 'pre-wrap',
                  wordBreak: 'break-word',
                }}
              >
                <div>{m.content}</div>
                {Array.isArray(m.links) && m.links.length > 0 && (
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 8 }}>
                    {m.links.map((l) => (
                      <button
                        key={l.path}
                        type="button"
                        onClick={() => openLink(l.path)}
                        style={{
                          background: '#0ea5e9',
                          color: '#ffffff',
                          border: 'none',
                          borderRadius: 999,
                          padding: '5px 11px',
                          fontSize: '0.75rem',
                          fontWeight: 500,
                          cursor: 'pointer',
                        }}
                      >
                        {l.label} →
                      </button>
                    ))}
                  </div>
                )}
              </div>
            ))}
            {sending && (
              <div style={{ alignSelf: 'flex-start', color: 'var(--text-secondary)', fontSize: '0.8rem' }}>
                <Loader2 size={14} className="spin" style={{ verticalAlign: '-2px' }} /> Thinking…
              </div>
            )}
            <div ref={messagesEndRef} />
          </div>

          <form
            onSubmit={sendMessage}
            style={{ display: 'flex', gap: 6, padding: '10px', borderTop: '1px solid var(--border-color)' }}
          >
            <input
              type="text"
              data-testid="support-chat-input"
              className="input-field"
              placeholder="Ask for help…"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              disabled={sending}
              style={{ flex: 1, minWidth: 0, fontSize: '0.85rem' }}
            />
            <button
              type="submit"
              data-testid="support-chat-send"
              disabled={sending || !input.trim()}
              aria-label="Send message"
              style={{
                padding: '0 12px',
                background: '#0ea5e9',
                color: '#ffffff',
                border: 'none',
                borderRadius: 8,
                cursor: sending || !input.trim() ? 'not-allowed' : 'pointer',
                opacity: sending || !input.trim() ? 0.6 : 1,
              }}
            >
              <SendHorizonal size={16} />
            </button>
          </form>
        </div>
      )}

      {!open && (
        <button
          type="button"
          data-testid="support-chat-fab"
          aria-label="Open support chat"
          aria-expanded={open}
          onPointerDown={onPointerDown}
          style={{
            position: 'fixed',
            left: pos.x,
            top: pos.y,
            width: BUTTON_SIZE,
            height: BUTTON_SIZE,
            borderRadius: '50%',
            background: '#0ea5e9',
            color: '#ffffff',
            border: 'none',
            cursor: 'grab',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            boxShadow: '0 8px 20px rgba(0,0,0,0.45)',
            zIndex: 1100,
            touchAction: 'none', // required so pointermove fires on touch drags
          }}
        >
          <RobotIcon size={22} />
        </button>
      )}
    </>
  );
}
