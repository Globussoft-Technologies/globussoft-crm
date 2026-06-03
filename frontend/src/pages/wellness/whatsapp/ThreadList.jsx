
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
  } = useWhatsAppThreads();

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
        ) : threads.length === 0 ? (
          <p style={{ padding: '2rem 1rem', color: 'var(--text-secondary)', textAlign: 'center', fontSize: '0.9rem' }}>
            No threads match your filters.
          </p>
        ) : (
          threads.map((t) => {
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
  );
}
