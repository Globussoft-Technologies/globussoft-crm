
import { useState } from 'react';
import {
  MessageCircle,
  Search,
  RefreshCw,
  Plus,
  Ban,
  UserCheck,
} from 'lucide-react';
import { Link } from 'react-router-dom';
import { useWhatsAppThreads } from './WhatsAppThreadsContext';
import StatusPill from './StatusPill';
import { timeAgo, STATUS_OPTIONS } from './utils';
import { openImage } from './ImageLightbox';

// Secondary line under the chat name: a real phone shows as-is; a group id
// (@g.us) shows "Group"; a privacy-id key (lid:… / @lid) is hidden (the name
// is already shown). Keeps raw ids out of the UI.
// eslint-disable-next-line react-refresh/only-export-components
export function prettyContactLine(phone) {
  const s = String(phone || '');
  if (s.includes('@g.us')) return 'Group';
  if (s.startsWith('lid:') || s.includes('@lid')) return '';
  return s;
}

// Contact avatar (DP) — shows the WhatsApp profile picture when available,
// else coloured initials (deterministic colour from the label). Mirrors
// WhatsApp Web's chat-list avatars. `size` in px.
const AVATAR_COLORS = ['#ef4444', '#f59e0b', '#10b981', '#3b82f6', '#8b5cf6', '#ec4899', '#14b8a6', '#f97316'];
export function ThreadAvatar({ url, label, size = 42, clickable = false }) {
  const [imgError, setImgError] = useState(false);
  const text = String(label || '?').trim();
  const initials = text
    .replace(/^\+?\d+$/, '#') // pure number → a neutral glyph
    .split(/\s+/).slice(0, 2).map((w) => w[0]).join('').toUpperCase() || '#';
  let hash = 0;
  for (let i = 0; i < text.length; i += 1) hash = (hash * 31 + text.charCodeAt(i)) >>> 0;
  const bg = AVATAR_COLORS[hash % AVATAR_COLORS.length];
  const common = {
    width: size, height: size, borderRadius: '50%', flexShrink: 0,
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    objectFit: 'cover',
  };
  // Clickable (header/profile) avatars with a real DP open the full image.
  const canOpen = clickable && url && !imgError;
  // Show the DP only if we have a URL and it loaded; otherwise coloured initials.
  if (url && !imgError) {
    return (
      <img
        src={url}
        alt=""
        referrerPolicy="no-referrer"
        onClick={canOpen ? () => openImage(url) : undefined}
        title={canOpen ? 'View photo' : undefined}
        style={{ ...common, background: 'var(--border-color)', cursor: canOpen ? 'pointer' : 'default' }}
        onError={() => setImgError(true)}
      />
    );
  }
  return (
    <div style={{ ...common, background: bg, color: '#fff', fontWeight: 700, fontSize: size * 0.4 }}>
      {initials}
    </div>
  );
}

export default function ThreadList() {
  const {
    threads,
    loadingList,
    selectedId,
    statusFilter,
    unreadOnly,
    q,
    isAdmin,
    setSelectedId,
    setQ,
    setStatusFilter,
    setUnreadOnly,
    loadList,
    handleSearch,
    openBlockedThread,
    setShowNewModal,
    setNewError,
    // Optional override so non-wellness hosts (the travel Wati chat) can
    // route the templates link to their own surface. Wellness's
    // WhatsAppThreads.jsx doesn't set it → default preserved.
    templatesPath,
  } = useWhatsAppThreads();

  const tplPath = templatesPath || '/wellness/whatsapp/templates';

  return (
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
                to={tplPath}
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
        ) : threads.length === 0 ? (
          <p style={{ padding: '2rem 1rem', color: 'var(--text-secondary)', textAlign: 'center', fontSize: '0.9rem' }}>
            No threads match your filters.
          </p>
        ) : (
          threads.map((t) => {
            const isSelected = t.id === selectedId;
            const displayName = t.contact?.name || t.contactName || t.patient?.name || t.contactPhone;
            return (
              <div
                key={t.id}
                onClick={() => (t._blocked ? openBlockedThread(t.contactPhone) : setSelectedId(t.id))}
                style={{
                  padding: '0.85rem 1rem',
                  borderBottom: '1px solid var(--border-color)',
                  cursor: 'pointer',
                  background: isSelected ? 'var(--card-bg-hover, rgba(59,130,246,0.08))' : 'transparent',
                  display: 'flex', alignItems: 'center', gap: 10,
                }}
              >
                <ThreadAvatar url={t.contactAvatar} label={displayName} size={42} />
                <div style={{ display: 'flex', flexDirection: 'column', gap: 4, flex: 1, minWidth: 0 }}>
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
                    {prettyContactLine(t.contactPhone)}
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
              </div>
            );
          })
        )}
      </div>
    </aside>
  );
}
