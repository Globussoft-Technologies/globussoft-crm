import React, { useState, useEffect, useRef, useCallback, useContext } from 'react';
import { Bell, Check, X } from 'lucide-react';
import { io } from 'socket.io-client';
import { fetchApi } from '../utils/api';
import { AuthContext } from '../App';

const NotificationBell = () => {
  const { user } = useContext(AuthContext);
  const [notifications, setNotifications] = useState([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const [open, setOpen] = useState(false);
  const ref = useRef(null);

  const fetchUnreadCount = useCallback(async () => {
    try {
      const data = await fetchApi('/api/notifications/unread-count');
      setUnreadCount(data.count);
    } catch (err) {
      // silently fail
    }
  }, []);

  const fetchNotifications = useCallback(async () => {
    try {
      const data = await fetchApi('/api/notifications');
      // Backend returns { notifications, total, page, limit, pages }; tolerate the
      // older array shape too in case any other consumer is still on it. Crashed the
      // whole app pre-fix when state became an object and .map() was called on it (#113).
      const list = Array.isArray(data) ? data : Array.isArray(data?.notifications) ? data.notifications : [];
      setNotifications(list);
    } catch (err) {
      // silently fail
    }
  }, []);

  // #345: previously polled /api/notifications/unread-count on a setInterval
  // (originally ~800ms, later 30s) which produced a steady stream of HTTP
  // requests visible in the network tab even when nothing changed. Socket.IO
  // is already mounted via Presence; the backend emits `notification_new`
  // (notificationService.js) and `notifications_cleared` (routes/notifications.js)
  // so we can update the count locally on push.
  //
  // We keep ONE initial HTTP fetch on mount to populate the count without
  // waiting for the next push, then rely on socket events for updates. If
  // the socket fails to connect (nginx not proxying /socket.io, etc.), the
  // count stays accurate on the next page load — acceptable degradation
  // and still vastly better than 1.5x/sec polling.
  useEffect(() => {
    fetchUnreadCount();

    if (!user) return;

    const socket = io('/', { reconnection: false, timeout: 5000 });
    socket.on('connect_error', () => { /* nginx may not proxy socket.io — silent */ });
    socket.on('error', () => { /* silent */ });

    // New notification → bump the local count if it's for this user.
    // The server broadcasts globally with { userId, notification }; we filter
    // client-side so other users' notifications don't inflate our badge.
    socket.on('notification_new', (payload) => {
      if (!payload) return;
      if (payload.userId && user.id && payload.userId !== user.id) return;
      setUnreadCount((c) => c + 1);
      // If the dropdown happens to be open, prepend the new notification so
      // it shows up without a re-fetch.
      if (payload.notification) {
        setNotifications((prev) => [payload.notification, ...prev]);
      }
    });

    // Server signals all-cleared (mark-all-read, bulk delete) for a user.
    socket.on('notifications_cleared', (payload) => {
      if (payload?.userId && user.id && payload.userId !== user.id) return;
      setUnreadCount(0);
    });

    return () => {
      socket.disconnect();
    };
  }, [fetchUnreadCount, user]);

  useEffect(() => {
    if (open) fetchNotifications();
  }, [open, fetchNotifications]);

  useEffect(() => {
    const handleClickOutside = (e) => {
      if (ref.current && !ref.current.contains(e.target)) setOpen(false);
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const markAsRead = async (id) => {
    try {
      await fetchApi(`/api/notifications/${id}/read`, { method: 'PUT' });
      setNotifications((prev) => prev.map((n) => (n.id === id ? { ...n, isRead: true } : n)));
      setUnreadCount((c) => Math.max(0, c - 1));
    } catch (err) {
      // silently fail
    }
  };

  const markAllRead = async () => {
    try {
      await fetchApi('/api/notifications/read-all', { method: 'PUT' });
      setNotifications((prev) => prev.map((n) => ({ ...n, isRead: true })));
      setUnreadCount(0);
    } catch (err) {
      // silently fail
    }
  };

  const deleteNotification = async (e, id) => {
    e.stopPropagation();
    try {
      await fetchApi(`/api/notifications/${id}`, { method: 'DELETE' });
      const removed = notifications.find((n) => n.id === id);
      setNotifications((prev) => prev.filter((n) => n.id !== id));
      if (removed && !removed.isRead) setUnreadCount((c) => Math.max(0, c - 1));
    } catch (err) {
      // silently fail
    }
  };

  const timeAgo = (dateStr) => {
    const seconds = Math.floor((Date.now() - new Date(dateStr).getTime()) / 1000);
    if (seconds < 60) return 'just now';
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes}m ago`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}h ago`;
    const days = Math.floor(hours / 24);
    return `${days}d ago`;
  };

  const typeColor = (type) => {
    switch (type) {
      case 'success': return '#10b981';
      case 'warning': return '#f59e0b';
      case 'error': return '#ef4444';
      default: return 'var(--accent-color)';
    }
  };

  return (
    <div ref={ref} style={{ position: 'relative' }}>
      <button
        onClick={() => setOpen(!open)}
        aria-label={`Notifications${unreadCount > 0 ? ` (${unreadCount} unread)` : ''}`}
        aria-expanded={open}
        style={{
          background: 'none',
          border: 'none',
          cursor: 'pointer',
          position: 'relative',
          padding: '8px',
          color: 'var(--text-primary)',
          display: 'flex',
          alignItems: 'center',
        }}
      >
        <Bell size={20} />
        {unreadCount > 0 && (
          <span
            style={{
              position: 'absolute',
              top: 2,
              right: 2,
              background: '#ef4444',
              color: '#fff',
              borderRadius: '50%',
              width: 18,
              height: 18,
              fontSize: 11,
              fontWeight: 700,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              lineHeight: 1,
            }}
          >
            {unreadCount > 99 ? '99+' : unreadCount}
          </span>
        )}
      </button>

      {open && (
        <div
          style={{
            position: 'absolute',
            top: '100%',
            right: 0,
            width: 360,
            maxHeight: 460,
            overflowY: 'auto',
            background: 'var(--surface-color)',
            border: '1px solid var(--border-color)',
            borderRadius: 12,
            boxShadow: '0 8px 32px rgba(0,0,0,0.25)',
            zIndex: 9999,
          }}
        >
          {/* Header */}
          <div
            style={{
              padding: '14px 16px',
              borderBottom: '1px solid var(--border-color)',
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
            }}
          >
            <span style={{ fontWeight: 600, fontSize: 15, color: 'var(--text-primary)' }}>
              Notifications
            </span>
            {unreadCount > 0 && (
              <button
                onClick={markAllRead}
                style={{
                  background: 'none',
                  border: 'none',
                  color: 'var(--accent-color)',
                  cursor: 'pointer',
                  fontSize: 13,
                  display: 'flex',
                  alignItems: 'center',
                  gap: 4,
                }}
              >
                <Check size={14} /> Mark all as read
              </button>
            )}
          </div>

          {/* Notification List */}
          {notifications.length === 0 ? (
            <div
              style={{
                padding: '32px 16px',
                textAlign: 'center',
                color: 'var(--text-secondary)',
                fontSize: 14,
              }}
            >
              No notifications
            </div>
          ) : (
            notifications.map((n) => (
              <div
                key={n.id}
                onClick={() => !n.isRead && markAsRead(n.id)}
                style={{
                  padding: '12px 16px',
                  borderBottom: '1px solid var(--border-color)',
                  cursor: 'pointer',
                  display: 'flex',
                  alignItems: 'flex-start',
                  gap: 10,
                  background: n.isRead ? 'transparent' : 'rgba(59,130,246,0.06)',
                  transition: 'background 0.15s',
                }}
                onMouseEnter={(e) => (e.currentTarget.style.background = 'rgba(255,255,255,0.04)')}
                onMouseLeave={(e) =>
                  (e.currentTarget.style.background = n.isRead ? 'transparent' : 'rgba(59,130,246,0.06)')
                }
              >
                {/* Unread dot */}
                <div style={{ paddingTop: 5, minWidth: 10 }}>
                  {!n.isRead && (
                    <div
                      style={{
                        width: 8,
                        height: 8,
                        borderRadius: '50%',
                        background: '#3b82f6',
                      }}
                    />
                  )}
                </div>

                {/* Content */}
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div
                    style={{
                      display: 'flex',
                      justifyContent: 'space-between',
                      alignItems: 'center',
                      marginBottom: 2,
                    }}
                  >
                    <span
                      style={{
                        fontWeight: 600,
                        fontSize: 13,
                        color: 'var(--text-primary)',
                        borderLeft: `3px solid ${typeColor(n.type)}`,
                        paddingLeft: 6,
                      }}
                    >
                      {n.title}
                    </span>
                    <span style={{ fontSize: 11, color: 'var(--text-secondary)', whiteSpace: 'nowrap', marginLeft: 8 }}>
                      {timeAgo(n.createdAt)}
                    </span>
                  </div>
                  <p
                    style={{
                      margin: 0,
                      fontSize: 12,
                      color: 'var(--text-secondary)',
                      lineHeight: 1.4,
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {n.message}
                  </p>
                </div>

                {/* Delete button */}
                <button
                  onClick={(e) => deleteNotification(e, n.id)}
                  style={{
                    background: 'none',
                    border: 'none',
                    cursor: 'pointer',
                    color: 'var(--text-secondary)',
                    padding: 4,
                    opacity: 0.5,
                    transition: 'opacity 0.15s',
                  }}
                  onMouseEnter={(e) => (e.currentTarget.style.opacity = '1')}
                  onMouseLeave={(e) => (e.currentTarget.style.opacity = '0.5')}
                >
                  <X size={14} />
                </button>
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );
};

export default NotificationBell;
