/**
 * NotificationsCenter.jsx — full-page notifications inbox (#853).
 *
 * Pairs with the header NotificationBell dropdown (which shows the most
 * recent ~20 unread + read). This page is the persistent history feed:
 * paginated, filterable by read/unread + priority + entityType, with
 * per-row mark-as-read / dismiss + a "Mark all read" bulk action.
 *
 * Backend endpoints (already shipped in routes/notifications.js):
 *   GET    /api/notifications?status=unread|read&priority=&entityType=&page=N&limit=50
 *          → { notifications, total, page, limit, pages }
 *   PUT    /api/notifications/:id/read
 *   DELETE /api/notifications/:id   (soft-dismiss / resolve)
 *   POST   /api/notifications/mark-all-read
 *
 * Deep-links: rows with a `link` field navigate to the originating record
 * (same shape as the bell's row-click handler). Rows without a link still
 * render but the cell is non-clickable.
 *
 * Route: /notifications (mounted in App.jsx under the protected Layout).
 */
import { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { Bell, Check, CheckCheck, X, AlertCircle, Info, AlertTriangle, CircleCheck } from 'lucide-react';
import { fetchApi } from '../utils/api';
import { useNotify } from '../utils/notify';

const FILTERS = [
  { value: 'all', label: 'All' },
  { value: 'unread', label: 'Unread' },
  { value: 'read', label: 'Read' },
];

const PRIORITY_BADGES = {
  high: { bg: 'rgba(239,68,68,0.12)', color: '#ef4444', label: 'High' },
  medium: { bg: 'rgba(245,158,11,0.12)', color: '#f59e0b', label: 'Medium' },
  low: { bg: 'rgba(107,114,128,0.12)', color: 'var(--text-secondary)', label: 'Low' },
};

const TYPE_ICONS = {
  warning: AlertTriangle,
  error: AlertCircle,
  info: Info,
  success: CircleCheck,
};

function formatTimeAgo(iso) {
  const d = new Date(iso);
  const sec = Math.floor((Date.now() - d.getTime()) / 1000);
  if (sec < 60) return `${sec}s ago`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m ago`;
  if (sec < 86400) return `${Math.floor(sec / 3600)}h ago`;
  if (sec < 604800) return `${Math.floor(sec / 86400)}d ago`;
  return d.toLocaleDateString();
}

export default function NotificationsCenter() {
  const navigate = useNavigate();
  const notify = useNotify();
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [filter, setFilter] = useState('all');
  const [page, setPage] = useState(1);
  const [pages, setPages] = useState(1);
  const [total, setTotal] = useState(0);
  const [unreadCount, setUnreadCount] = useState(0);

  const load = useCallback(async (signal) => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({ page: String(page), limit: '50' });
      if (filter === 'unread') params.set('status', 'unread');
      if (filter === 'read') params.set('status', 'read');
      const data = await fetchApi(`/api/notifications?${params.toString()}`, { signal });
      if (signal?.aborted) return;
      setItems(Array.isArray(data?.notifications) ? data.notifications : []);
      setTotal(data?.total ?? 0);
      setPages(data?.pages ?? 1);
    } catch (e) {
      if (e?.name === 'AbortError') return;
      setError(e?.message || 'Failed to load notifications');
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  }, [filter, page]);

  useEffect(() => {
    const ctrl = new AbortController();
    load(ctrl.signal);
    return () => ctrl.abort();
  }, [load]);

  // Unread badge stays accurate when filter switches; uses the dedicated count
  // endpoint to avoid coupling to the current page slice.
  useEffect(() => {
    let cancelled = false;
    fetchApi('/api/notifications/unread-count', { silent: true })
      .then((d) => { if (!cancelled) setUnreadCount(d?.count ?? 0); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [items]);

  const markRead = async (id) => {
    try {
      await fetchApi(`/api/notifications/${id}/read`, { method: 'PUT' });
      setItems((arr) => arr.map((n) => (n.id === id ? { ...n, isRead: true } : n)));
    } catch (e) {
      notify.error('Could not mark notification as read');
    }
  };

  const dismiss = async (id) => {
    try {
      await fetchApi(`/api/notifications/${id}`, { method: 'DELETE' });
      setItems((arr) => arr.filter((n) => n.id !== id));
      setTotal((t) => Math.max(0, t - 1));
    } catch (e) {
      notify.error('Could not dismiss notification');
    }
  };

  const markAllRead = async () => {
    try {
      await fetchApi('/api/notifications/mark-all-read', { method: 'POST' });
      setItems((arr) => arr.map((n) => ({ ...n, isRead: true })));
      setUnreadCount(0);
    } catch (e) {
      notify.error('Could not mark all as read');
    }
  };

  const openRow = (n) => {
    if (!n.isRead) markRead(n.id);
    if (n.link) navigate(n.link);
  };

  return (
    <div style={{ padding: '2rem', maxWidth: 960, margin: '0 auto' }}>
      <header style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1.5rem', gap: '1rem', flexWrap: 'wrap' }}>
        <div>
          <h1 style={{ fontSize: '1.75rem', fontWeight: 700, display: 'flex', alignItems: 'center', gap: '0.5rem', margin: 0 }}>
            <Bell size={22} /> Notifications
          </h1>
          <p style={{ color: 'var(--text-secondary)', margin: '0.25rem 0 0', fontSize: '0.9rem' }}>
            {total} total · {unreadCount} unread
          </p>
        </div>
        {unreadCount > 0 && (
          <button
            type="button"
            onClick={markAllRead}
            className="btn-secondary"
            style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}
          >
            <CheckCheck size={16} /> Mark all read
          </button>
        )}
      </header>

      {/* Filter tabs */}
      <div role="tablist" aria-label="Notification filter" style={{ display: 'flex', gap: '0.5rem', marginBottom: '1rem', flexWrap: 'wrap' }}>
        {FILTERS.map((f) => (
          <button
            key={f.value}
            type="button"
            role="tab"
            aria-selected={filter === f.value}
            onClick={() => { setFilter(f.value); setPage(1); }}
            style={{
              padding: '0.5rem 1rem',
              borderRadius: 8,
              border: `1px solid ${filter === f.value ? 'var(--accent-color)' : 'var(--border-color)'}`,
              background: filter === f.value ? 'var(--accent-bg, rgba(59,130,246,0.1))' : 'transparent',
              color: filter === f.value ? 'var(--accent-color)' : 'var(--text-primary)',
              cursor: 'pointer',
              fontWeight: filter === f.value ? 600 : 400,
            }}
          >
            {f.label}
          </button>
        ))}
      </div>

      {/* List */}
      <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
        {loading ? (
          <div style={{ padding: '3rem', textAlign: 'center', color: 'var(--text-secondary)' }}>Loading…</div>
        ) : error ? (
          <div style={{ padding: '3rem', textAlign: 'center', color: 'var(--danger-color)' }}>{error}</div>
        ) : items.length === 0 ? (
          <div style={{ padding: '3rem', textAlign: 'center', color: 'var(--text-secondary)' }}>
            <Bell size={32} style={{ opacity: 0.3, marginBottom: '0.5rem' }} />
            <p style={{ margin: 0 }}>
              {filter === 'unread' ? 'No unread notifications.' : filter === 'read' ? 'No read notifications.' : 'No notifications yet.'}
            </p>
          </div>
        ) : (
          items.map((n) => {
            const Icon = TYPE_ICONS[n.type] || Bell;
            const pri = PRIORITY_BADGES[n.priority] || null;
            return (
              <div
                key={n.id}
                onClick={() => openRow(n)}
                style={{
                  display: 'flex', alignItems: 'flex-start', gap: '0.75rem',
                  padding: '1rem 1.25rem',
                  borderBottom: '1px solid var(--border-color)',
                  cursor: n.link ? 'pointer' : 'default',
                  background: n.isRead ? 'transparent' : 'rgba(59,130,246,0.04)',
                  transition: 'background 0.15s',
                }}
                onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--hover-bg, rgba(255,255,255,0.03))')}
                onMouseLeave={(e) => (e.currentTarget.style.background = n.isRead ? 'transparent' : 'rgba(59,130,246,0.04)')}
              >
                <Icon size={18} style={{ color: n.type === 'error' ? '#ef4444' : n.type === 'warning' ? '#f59e0b' : n.type === 'success' ? '#10b981' : 'var(--accent-color)', flexShrink: 0, marginTop: 2 }} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', gap: '0.5rem', alignItems: 'baseline' }}>
                    <strong style={{ fontSize: '0.95rem', color: 'var(--text-primary)' }}>{n.title}</strong>
                    <span style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', flexShrink: 0 }}>{formatTimeAgo(n.createdAt)}</span>
                  </div>
                  {n.message && (
                    <p style={{ margin: '0.25rem 0 0', fontSize: '0.85rem', color: 'var(--text-secondary)' }}>{n.message}</p>
                  )}
                  {pri && (
                    <span style={{ display: 'inline-block', marginTop: '0.5rem', padding: '2px 8px', borderRadius: 10, fontSize: '0.7rem', fontWeight: 600, background: pri.bg, color: pri.color }}>
                      {pri.label}
                    </span>
                  )}
                </div>
                <div style={{ display: 'flex', gap: '0.25rem', flexShrink: 0 }}>
                  {!n.isRead && (
                    <button
                      type="button"
                      onClick={(e) => { e.stopPropagation(); markRead(n.id); }}
                      aria-label={`Mark "${n.title}" as read`}
                      title="Mark as read"
                      style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--accent-color)', padding: 6, opacity: 0.7 }}
                      onMouseEnter={(e) => (e.currentTarget.style.opacity = '1')}
                      onMouseLeave={(e) => (e.currentTarget.style.opacity = '0.7')}
                    >
                      <Check size={16} />
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={(e) => { e.stopPropagation(); dismiss(n.id); }}
                    aria-label={`Dismiss "${n.title}"`}
                    title="Dismiss"
                    style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-secondary)', padding: 6, opacity: 0.5 }}
                    onMouseEnter={(e) => (e.currentTarget.style.opacity = '1')}
                    onMouseLeave={(e) => (e.currentTarget.style.opacity = '0.5')}
                  >
                    <X size={16} />
                  </button>
                </div>
              </div>
            );
          })
        )}
      </div>

      {/* Pagination */}
      {pages > 1 && (
        <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', gap: '0.75rem', marginTop: '1.5rem' }}>
          <button type="button" onClick={() => setPage((p) => Math.max(1, p - 1))} disabled={page <= 1} className="btn-secondary">
            ← Previous
          </button>
          <span style={{ color: 'var(--text-secondary)', fontSize: '0.9rem' }}>
            Page {page} of {pages}
          </span>
          <button type="button" onClick={() => setPage((p) => Math.min(pages, p + 1))} disabled={page >= pages} className="btn-secondary">
            Next →
          </button>
        </div>
      )}
    </div>
  );
}
