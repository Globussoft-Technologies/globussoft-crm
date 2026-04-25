import React, { useState, useEffect, useRef, useContext, useCallback } from 'react';
import { MessageSquare, Send, X, UserPlus, Star, User, Circle } from 'lucide-react';
import { io } from 'socket.io-client';
import { fetchApi } from '../utils/api';
import { useNotify } from '../utils/notify';
import { AuthContext } from '../App';

export default function LiveChat() {
  const notify = useNotify();
  const { user, tenant } = useContext(AuthContext);
  const tenantId = tenant?.id || 1;

  const [sessions, setSessions] = useState([]);
  const [activeId, setActiveId] = useState(null);
  const [activeSession, setActiveSession] = useState(null);
  const [messages, setMessages] = useState([]);
  const [draft, setDraft] = useState('');
  const [loading, setLoading] = useState(true);
  const [stats, setStats] = useState({ open: 0, assigned: 0, closedToday: 0 });
  const [showRating, setShowRating] = useState(false);
  const [rating, setRating] = useState(0);

  const socketRef = useRef(null);
  const messageBoxRef = useRef(null);
  const activeIdRef = useRef(null);

  // Keep a ref of the currently open session so socket handlers see fresh value
  useEffect(() => { activeIdRef.current = activeId; }, [activeId]);

  // Load list + stats
  const loadSessions = useCallback(async () => {
    try {
      const [list, st] = await Promise.all([
        fetchApi('/api/live-chat'),
        fetchApi('/api/live-chat/stats').catch(() => ({ open: 0, assigned: 0, closedToday: 0 })),
      ]);
      setSessions(Array.isArray(list) ? list : []);
      setStats(st || { open: 0, assigned: 0, closedToday: 0 });
    } catch (err) {
      console.error('[LiveChat] load error:', err);
    } finally {
      setLoading(false);
    }
  }, []);

  // Load thread
  const loadThread = useCallback(async (id) => {
    if (!id) return;
    try {
      const data = await fetchApi(`/api/live-chat/${id}`);
      setActiveSession(data.session);
      setMessages(Array.isArray(data.messages) ? data.messages : []);
    } catch (err) {
      console.error('[LiveChat] thread error:', err);
    }
  }, []);

  // Initial load + socket setup
  useEffect(() => {
    loadSessions();

    const socket = io(window.location.origin, { transports: ['websocket', 'polling'] });
    socketRef.current = socket;

    socket.on('connect', () => {
      socket.emit('join_room', `tenant-${tenantId}`);
    });

    socket.on('chat_new_session', () => {
      loadSessions();
    });

    socket.on('chat_assigned', ({ sessionId, session }) => {
      setSessions((prev) => prev.map((s) => (s.id === sessionId ? { ...s, ...session } : s)));
      if (activeIdRef.current === sessionId) setActiveSession(session);
    });

    socket.on('chat_message', ({ sessionId, message }) => {
      // Append to thread if open
      if (activeIdRef.current === sessionId) {
        setMessages((prev) => {
          if (prev.some((m) => m.id === message.id)) return prev;
          return [...prev, message];
        });
      }
      // Update preview in list
      setSessions((prev) => prev.map((s) => (s.id === sessionId ? { ...s, lastMessage: message } : s)));
    });

    socket.on('chat_closed', ({ sessionId, session }) => {
      setSessions((prev) => prev.filter((s) => s.id !== sessionId));
      if (activeIdRef.current === sessionId) {
        setActiveSession(session);
      }
      loadSessions();
    });

    return () => {
      socket.disconnect();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tenantId]);

  // When active session changes, join its room and fetch thread
  useEffect(() => {
    if (!activeId) {
      setActiveSession(null);
      setMessages([]);
      return;
    }
    if (socketRef.current) {
      socketRef.current.emit('join_room', `chat-${activeId}`);
    }
    loadThread(activeId);
    setShowRating(false);
    setRating(0);
  }, [activeId, loadThread]);

  // Auto-scroll
  useEffect(() => {
    if (messageBoxRef.current) {
      messageBoxRef.current.scrollTop = messageBoxRef.current.scrollHeight;
    }
  }, [messages]);

  const handleSend = async (e) => {
    e?.preventDefault();
    if (!draft.trim() || !activeId) return;
    const body = draft.trim();
    setDraft('');
    try {
      await fetchApi(`/api/live-chat/${activeId}/messages`, {
        method: 'POST',
        body: JSON.stringify({ body }),
      });
    } catch (err) {
      console.error('[LiveChat] send error:', err);
      notify.error('Failed to send message');
    }
  };

  const handleAssign = async () => {
    if (!activeId) return;
    try {
      await fetchApi(`/api/live-chat/${activeId}/assign`, {
        method: 'POST',
        body: JSON.stringify({}),
      });
      loadThread(activeId);
      loadSessions();
    } catch (err) {
      console.error('[LiveChat] assign error:', err);
    }
  };

  const handleClose = async () => {
    if (!activeId) return;
    if (!showRating) {
      setShowRating(true);
      return;
    }
    try {
      await fetchApi(`/api/live-chat/${activeId}/close`, {
        method: 'POST',
        body: JSON.stringify({ rating: rating || undefined }),
      });
      setActiveId(null);
      setShowRating(false);
      setRating(0);
      loadSessions();
    } catch (err) {
      console.error('[LiveChat] close error:', err);
    }
  };

  const formatTime = (iso) => {
    if (!iso) return '';
    const d = new Date(iso);
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  };

  const statusBadge = (status) => {
    const map = {
      OPEN: { bg: '#fef3c7', fg: '#92400e', label: 'Open' },
      ASSIGNED: { bg: '#dbeafe', fg: '#1e40af', label: 'Assigned' },
      CLOSED: { bg: '#e5e7eb', fg: '#374151', label: 'Closed' },
    };
    const s = map[status] || map.OPEN;
    return (
      <span style={{
        background: s.bg, color: s.fg, padding: '2px 8px',
        borderRadius: 12, fontSize: 11, fontWeight: 600,
      }}>{s.label}</span>
    );
  };

  return (
    <div style={{ padding: '1.5rem', color: 'var(--text-primary)', height: 'calc(100vh - 80px)', display: 'flex', flexDirection: 'column' }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '1rem' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <MessageSquare size={28} color="#3b82f6" />
          <div>
            <h2 style={{ margin: 0 }}>Live Chat</h2>
            <div style={{ fontSize: 13, color: 'var(--text-secondary, #6b7280)' }}>
              Real-time visitor conversations
            </div>
          </div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
          <span style={{
            display: 'inline-flex', alignItems: 'center', gap: 6,
            background: 'rgba(16,185,129,0.12)', color: 'var(--success-color)',
            padding: '6px 12px', borderRadius: 20, fontSize: 13, fontWeight: 600,
          }}>
            <Circle size={8} fill="#16a34a" color="#16a34a" /> Online
          </span>
          <span style={{ fontSize: 13, color: 'var(--text-secondary, #6b7280)' }}>
            <strong>{stats.open + stats.assigned}</strong> active &middot; <strong>{stats.closedToday}</strong> closed today
          </span>
        </div>
      </div>

      {/* Two-pane layout */}
      <div style={{
        display: 'grid', gridTemplateColumns: '320px 1fr', gap: 16, flex: 1, minHeight: 0,
      }}>
        {/* Session list */}
        <div style={{
          background: 'var(--surface-color)', borderRadius: 12,
          border: '1px solid var(--border-color)', overflow: 'hidden',
          display: 'flex', flexDirection: 'column',
        }}>
          <div style={{ padding: '12px 16px', borderBottom: '1px solid var(--border-color)', fontWeight: 600 }}>
            {sessions.length} open session{sessions.length === 1 ? '' : 's'}
          </div>
          <div style={{ overflowY: 'auto', flex: 1 }}>
            {loading && <div style={{ padding: 16, color: 'var(--text-secondary)' }}>Loading...</div>}
            {!loading && sessions.length === 0 && (
              <div style={{ padding: 24, textAlign: 'center', color: 'var(--text-secondary)', fontSize: 13 }}>
                No active chats. New visitor sessions will appear here.
              </div>
            )}
            {sessions.map((s) => {
              const isActive = s.id === activeId;
              return (
                <div
                  key={s.id}
                  onClick={() => setActiveId(s.id)}
                  style={{
                    padding: '12px 16px',
                    borderBottom: '1px solid var(--border-color)',
                    cursor: 'pointer',
                    background: isActive ? 'rgba(59, 130, 246, 0.08)' : 'transparent',
                    borderLeft: isActive ? '3px solid #3b82f6' : '3px solid transparent',
                  }}
                >
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
                    <div style={{ fontWeight: 600, fontSize: 14, display: 'flex', alignItems: 'center', gap: 6 }}>
                      <User size={14} /> {s.visitorName || 'Anonymous'}
                    </div>
                    {statusBadge(s.status)}
                  </div>
                  <div style={{ fontSize: 12, color: 'var(--text-secondary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {s.lastMessage?.body || 'No messages yet'}
                  </div>
                  <div style={{ fontSize: 11, color: 'var(--text-secondary)', marginTop: 2 }}>
                    {formatTime(s.lastMessage?.createdAt || s.startedAt)}
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        {/* Active chat */}
        <div style={{
          background: 'var(--surface-color)', borderRadius: 12,
          border: '1px solid var(--border-color)',
          display: 'flex', flexDirection: 'column', minHeight: 0,
        }}>
          {!activeId && (
            <div style={{
              flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center',
              flexDirection: 'column', color: 'var(--text-secondary)', gap: 8,
            }}>
              <MessageSquare size={48} color="#d1d5db" />
              <div>Select a chat to start responding</div>
            </div>
          )}

          {activeId && activeSession && (
            <>
              {/* Chat header */}
              <div style={{
                padding: '12px 16px', borderBottom: '1px solid var(--border-color)',
                display: 'flex', justifyContent: 'space-between', alignItems: 'center',
              }}>
                <div>
                  <div style={{ fontWeight: 600 }}>
                    {activeSession.visitorName || 'Anonymous Visitor'}
                  </div>
                  <div style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
                    {activeSession.visitorEmail || `Visitor #${activeSession.visitorId}`}
                    &nbsp;&middot;&nbsp; Started {formatTime(activeSession.startedAt)}
                  </div>
                </div>
                <div style={{ display: 'flex', gap: 8 }}>
                  {activeSession.status !== 'ASSIGNED' && activeSession.status !== 'CLOSED' && (
                    <button
                      onClick={handleAssign}
                      style={{
                        display: 'inline-flex', alignItems: 'center', gap: 6,
                        background: '#3b82f6', color: '#fff', border: 'none',
                        padding: '6px 12px', borderRadius: 6, cursor: 'pointer', fontSize: 13,
                      }}
                    >
                      <UserPlus size={14} /> Assign to me
                    </button>
                  )}
                  {activeSession.status !== 'CLOSED' && (
                    <button
                      onClick={handleClose}
                      style={{
                        display: 'inline-flex', alignItems: 'center', gap: 6,
                        background: '#ef4444', color: '#fff', border: 'none',
                        padding: '6px 12px', borderRadius: 6, cursor: 'pointer', fontSize: 13,
                      }}
                    >
                      <X size={14} /> Close
                    </button>
                  )}
                </div>
              </div>

              {/* Rating prompt */}
              {showRating && (
                <div style={{
                  padding: '10px 16px', background: '#fef3c7',
                  borderBottom: '1px solid #fde68a', display: 'flex',
                  alignItems: 'center', gap: 12,
                }}>
                  <span style={{ fontSize: 13, fontWeight: 600 }}>Rate this chat (optional):</span>
                  {[1, 2, 3, 4, 5].map((n) => (
                    <Star
                      key={n}
                      size={20}
                      onClick={() => setRating(n)}
                      fill={n <= rating ? '#f59e0b' : 'transparent'}
                      color="#f59e0b"
                      style={{ cursor: 'pointer' }}
                    />
                  ))}
                  <button
                    onClick={handleClose}
                    style={{
                      marginLeft: 'auto', background: '#ef4444', color: '#fff',
                      border: 'none', padding: '4px 10px', borderRadius: 4,
                      cursor: 'pointer', fontSize: 12,
                    }}
                  >
                    Confirm Close
                  </button>
                </div>
              )}

              {/* Message thread */}
              <div ref={messageBoxRef} style={{ flex: 1, overflowY: 'auto', padding: 16, background: 'var(--subtle-bg)' }}>
                {messages.map((m) => {
                  if (m.sender === 'system') {
                    return (
                      <div key={m.id} style={{ textAlign: 'center', margin: '12px 0', fontSize: 12, color: 'var(--text-secondary)' }}>
                        {m.body} &middot; {formatTime(m.createdAt)}
                      </div>
                    );
                  }
                  const isAgent = m.sender === 'agent';
                  return (
                    <div
                      key={m.id}
                      style={{
                        display: 'flex', justifyContent: isAgent ? 'flex-end' : 'flex-start',
                        marginBottom: 10,
                      }}
                    >
                      <div style={{
                        maxWidth: '70%',
                        background: isAgent ? 'var(--accent-color)' : 'var(--subtle-bg-3)',
                        color: isAgent ? '#fff' : 'var(--text-primary)',
                        padding: '8px 12px',
                        borderRadius: 12,
                        borderBottomRightRadius: isAgent ? 2 : 12,
                        borderBottomLeftRadius: isAgent ? 12 : 2,
                        fontSize: 14,
                        wordBreak: 'break-word',
                      }}>
                        <div>{m.body}</div>
                        <div style={{
                          fontSize: 10, opacity: 0.75, marginTop: 4,
                          textAlign: isAgent ? 'right' : 'left',
                        }}>
                          {formatTime(m.createdAt)}
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>

              {/* Composer */}
              {activeSession.status !== 'CLOSED' ? (
                <form onSubmit={handleSend} style={{
                  padding: 12, borderTop: '1px solid var(--border-color)',
                  display: 'flex', gap: 8,
                }}>
                  <input
                    type="text"
                    value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                    placeholder="Type your reply..."
                    style={{
                      flex: 1, padding: '10px 12px', border: '1px solid var(--border-color)',
                      borderRadius: 8, fontSize: 14, outline: 'none',
                    }}
                  />
                  <button
                    type="submit"
                    disabled={!draft.trim()}
                    style={{
                      display: 'inline-flex', alignItems: 'center', gap: 6,
                      background: '#3b82f6', color: '#fff', border: 'none',
                      padding: '0 16px', borderRadius: 8, cursor: 'pointer',
                      opacity: draft.trim() ? 1 : 0.5,
                    }}
                  >
                    <Send size={16} /> Send
                  </button>
                </form>
              ) : (
                <div style={{
                  padding: 12, borderTop: '1px solid var(--border-color)',
                  textAlign: 'center', color: 'var(--text-secondary)', fontSize: 13,
                }}>
                  This chat has been closed.
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
