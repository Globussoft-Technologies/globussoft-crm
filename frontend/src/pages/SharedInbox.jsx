import React, { useEffect, useState } from 'react';
import { Inbox as InboxIcon, Plus, Users, UserCheck, X, Mail, ArrowLeft, Trash2 } from 'lucide-react';
import { fetchApi } from '../utils/api';
import { useNotify } from '../utils/notify';

const AVATAR_COLORS = ['#ef4444', '#3b82f6', '#10b981', '#f59e0b', '#8b5cf6', '#ec4899', '#06b6d4', '#f97316'];

function avatarColor(id) {
  return AVATAR_COLORS[(Number(id) || 0) % AVATAR_COLORS.length];
}

function initials(nameOrEmail) {
  if (!nameOrEmail) return '?';
  const s = String(nameOrEmail).trim();
  const parts = s.split(/[\s@]+/).filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[1][0]).toUpperCase();
}

export default function SharedInbox() {
  const notify = useNotify();
  const [inboxes, setInboxes] = useState([]);
  const [staff, setStaff] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showCreate, setShowCreate] = useState(false);
  const [form, setForm] = useState({ name: '', emailAddress: '', members: [] });
  const [selected, setSelected] = useState(null); // open inbox
  const [threads, setThreads] = useState([]);
  const [threadsLoading, setThreadsLoading] = useState(false);

  useEffect(() => {
    Promise.all([
      fetchApi('/api/shared-inbox').catch(() => []),
      fetchApi('/api/staff').catch(() => []),
    ]).then(([inboxData, staffData]) => {
      setInboxes(Array.isArray(inboxData) ? inboxData : []);
      setStaff(Array.isArray(staffData) ? staffData : []);
      setLoading(false);
    });
  }, []);

  const reload = async () => {
    const data = await fetchApi('/api/shared-inbox').catch(() => []);
    setInboxes(Array.isArray(data) ? data : []);
  };

  const openInbox = async (inbox) => {
    setSelected(inbox);
    setThreadsLoading(true);
    try {
      const data = await fetchApi(`/api/shared-inbox/${inbox.id}/messages`);
      setThreads(Array.isArray(data?.threads) ? data.threads : []);
    } catch {
      setThreads([]);
    }
    setThreadsLoading(false);
  };

  const handleCreate = async (e) => {
    e.preventDefault();
    if (!form.name || !form.emailAddress) return;
    try {
      await fetchApi('/api/shared-inbox', {
        method: 'POST',
        body: JSON.stringify({
          name: form.name,
          emailAddress: form.emailAddress,
          members: form.members.map(Number),
        }),
      });
      setShowCreate(false);
      setForm({ name: '', emailAddress: '', members: [] });
      reload();
    } catch (err) {
      notify.error(err.message || 'Failed to create shared inbox.');
    }
  };

  const handleDelete = async (inbox) => {
    if (!await notify.confirm(`Delete shared inbox "${inbox.name}"? This cannot be undone.`)) return;
    await fetchApi(`/api/shared-inbox/${inbox.id}`, { method: 'DELETE' });
    if (selected && selected.id === inbox.id) {
      setSelected(null);
      setThreads([]);
    }
    reload();
  };

  const handleAssign = async (thread, userId) => {
    if (!selected || !thread.messages || thread.messages.length === 0) return;
    const messageId = thread.messages[0].id;
    try {
      await fetchApi(`/api/shared-inbox/${selected.id}/assign-message`, {
        method: 'POST',
        body: JSON.stringify({ messageId, userId: userId ? Number(userId) : null }),
      });
      // Optimistic update
      setThreads((prev) =>
        prev.map((t) => (t.threadKey === thread.threadKey ? { ...t, assignedUserId: userId ? Number(userId) : null } : t))
      );
    } catch (err) {
      notify.error('Failed to assign thread.');
    }
  };

  const toggleMember = (id) => {
    setForm((prev) => {
      const set = new Set(prev.members.map(Number));
      if (set.has(Number(id))) set.delete(Number(id));
      else set.add(Number(id));
      return { ...prev, members: Array.from(set) };
    });
  };

  const staffById = (id) => staff.find((s) => s.id === Number(id));

  // ─── Detail view ──────────────────────────────────────────────
  if (selected) {
    return (
      <div style={{ padding: '2rem', height: '100%', overflowY: 'auto', animation: 'fadeIn 0.5s ease-out' }}>
        <header style={{ display: 'flex', alignItems: 'center', gap: '1rem', marginBottom: '2rem' }}>
          <button
            onClick={() => { setSelected(null); setThreads([]); }}
            className="btn-secondary"
            style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}
          >
            <ArrowLeft size={16} /> Back
          </button>
          <div style={{ flex: 1 }}>
            <h1 style={{ fontSize: '1.75rem', fontWeight: 'bold', display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
              <InboxIcon size={28} color="var(--accent-color)" /> {selected.name}
            </h1>
            <p style={{ color: 'var(--text-secondary)', marginTop: '0.25rem', fontSize: '0.9rem' }}>
              {selected.emailAddress} · {(selected.members || []).length} members
            </p>
          </div>
        </header>

        <div className="card" style={{ padding: '1rem' }}>
          {threadsLoading ? (
            <p style={{ textAlign: 'center', padding: '2rem', color: 'var(--text-secondary)' }}>Loading conversations...</p>
          ) : threads.length === 0 ? (
            <p style={{ textAlign: 'center', padding: '2rem', color: 'var(--text-secondary)' }}>
              No conversations in this inbox yet. Forward email to <strong>{selected.emailAddress}</strong> to start.
            </p>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
              {threads.map((t) => (
                <div
                  key={t.threadKey}
                  style={{
                    padding: '1.25rem',
                    border: '1px solid var(--border-color)',
                    borderRadius: '12px',
                    background: t.unread > 0 ? 'rgba(59, 130, 246, 0.05)' : 'var(--table-header-bg)',
                    display: 'flex',
                    gap: '1rem',
                    alignItems: 'flex-start',
                  }}
                >
                  <div
                    style={{
                      width: '40px',
                      height: '40px',
                      borderRadius: '50%',
                      background: avatarColor(t.from.length),
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      color: '#fff',
                      fontWeight: 'bold',
                      fontSize: '0.85rem',
                      flexShrink: 0,
                    }}
                  >
                    {initials(t.from)}
                  </div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '0.25rem', alignItems: 'center', gap: '1rem' }}>
                      <span style={{ fontWeight: '600', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{t.from}</span>
                      <span style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', whiteSpace: 'nowrap' }}>
                        {new Date(t.lastMessageAt).toLocaleString()}
                      </span>
                    </div>
                    <h4 style={{ fontWeight: '600', marginBottom: '0.25rem', color: 'var(--text-primary)' }}>{t.subject || '(no subject)'}</h4>
                    <p style={{ color: 'var(--text-secondary)', fontSize: '0.85rem', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {t.messageCount} message{t.messageCount === 1 ? '' : 's'} · {t.unread} unread
                    </p>
                  </div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem', alignItems: 'flex-end', flexShrink: 0 }}>
                    {t.unread > 0 && (
                      <span
                        style={{
                          background: 'var(--accent-color)',
                          color: '#fff',
                          padding: '0.15rem 0.5rem',
                          borderRadius: '10px',
                          fontSize: '0.7rem',
                          fontWeight: 'bold',
                        }}
                      >
                        {t.unread} new
                      </span>
                    )}
                    <select
                      value={t.assignedUserId || ''}
                      onChange={(e) => handleAssign(t, e.target.value)}
                      className="input-field"
                      style={{ padding: '0.4rem 0.5rem', fontSize: '0.8rem', minWidth: '160px' }}
                    >
                      <option value="">Unassigned</option>
                      {staff.map((s) => (
                        <option key={s.id} value={s.id}>
                          {s.name || s.email}
                        </option>
                      ))}
                    </select>
                    {t.assignedUserId && (
                      <span style={{ fontSize: '0.7rem', color: 'var(--text-secondary)', display: 'flex', alignItems: 'center', gap: '0.25rem' }}>
                        <UserCheck size={12} /> {staffById(t.assignedUserId)?.name || staffById(t.assignedUserId)?.email || `User #${t.assignedUserId}`}
                      </span>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    );
  }

  // ─── Grid view ──────────────────────────────────────────────
  return (
    <div style={{ padding: '2rem', height: '100%', overflowY: 'auto', animation: 'fadeIn 0.5s ease-out' }}>
      <header style={{ marginBottom: '2.5rem', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div>
          <h1 style={{ fontSize: '2rem', fontWeight: 'bold', display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
            <InboxIcon size={32} color="var(--accent-color)" /> Shared Inbox
          </h1>
          <p style={{ color: 'var(--text-secondary)', marginTop: '0.25rem' }}>
            Team mailboxes for support@, sales@, and other group addresses with thread assignment.
          </p>
        </div>
        <button
          onClick={() => setShowCreate(true)}
          className="btn-primary"
          style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}
        >
          <Plus size={18} /> Create Inbox
        </button>
      </header>

      {loading ? (
        <p style={{ textAlign: 'center', padding: '2rem', color: 'var(--text-secondary)' }}>Loading shared inboxes...</p>
      ) : inboxes.length === 0 ? (
        <div className="card" style={{ padding: '4rem 2rem', textAlign: 'center' }}>
          <InboxIcon size={48} color="var(--text-secondary)" style={{ margin: '0 auto 1rem' }} />
          <h3 style={{ marginBottom: '0.5rem' }}>No shared inboxes yet</h3>
          <p style={{ color: 'var(--text-secondary)', marginBottom: '1.5rem' }}>
            Create a shared inbox like support@yourdomain.com so your team can collaborate on incoming email.
          </p>
          <button
            onClick={() => setShowCreate(true)}
            className="btn-primary"
            style={{ display: 'inline-flex', alignItems: 'center', gap: '0.5rem' }}
          >
            <Plus size={18} /> Create Your First Inbox
          </button>
        </div>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))', gap: '1.5rem' }}>
          {inboxes.map((inbox) => {
            const memberIds = Array.isArray(inbox.members) ? inbox.members : [];
            return (
              <div
                key={inbox.id}
                className="card"
                style={{
                  padding: '1.5rem',
                  cursor: 'pointer',
                  position: 'relative',
                  transition: 'var(--transition)',
                  border: '1px solid var(--border-color)',
                }}
                onClick={() => openInbox(inbox)}
              >
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '1rem' }}>
                  <div
                    style={{
                      width: '48px',
                      height: '48px',
                      borderRadius: '12px',
                      background: 'rgba(59, 130, 246, 0.1)',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      color: 'var(--accent-color)',
                    }}
                  >
                    <InboxIcon size={24} />
                  </div>
                  <button
                    onClick={(e) => { e.stopPropagation(); handleDelete(inbox); }}
                    style={{ background: 'transparent', border: 'none', color: 'var(--text-secondary)', cursor: 'pointer', padding: '0.25rem' }}
                    title="Delete"
                  >
                    <Trash2 size={16} />
                  </button>
                </div>
                <h3 style={{ fontSize: '1.15rem', fontWeight: 'bold', marginBottom: '0.25rem' }}>{inbox.name}</h3>
                <p style={{ color: 'var(--text-secondary)', fontSize: '0.85rem', marginBottom: '1rem', display: 'flex', alignItems: 'center', gap: '0.35rem' }}>
                  <Mail size={14} /> {inbox.emailAddress}
                </p>

                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderTop: '1px solid var(--border-color)', paddingTop: '1rem' }}>
                  <div style={{ display: 'flex', alignItems: 'center' }}>
                    {memberIds.slice(0, 4).map((id, idx) => {
                      const u = staffById(id);
                      return (
                        <div
                          key={id}
                          title={u ? (u.name || u.email) : `User #${id}`}
                          style={{
                            width: '28px',
                            height: '28px',
                            borderRadius: '50%',
                            background: avatarColor(id),
                            color: '#fff',
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'center',
                            fontSize: '0.7rem',
                            fontWeight: 'bold',
                            border: '2px solid var(--bg-color, #1a1a1a)',
                            marginLeft: idx === 0 ? 0 : '-8px',
                          }}
                        >
                          {initials(u ? (u.name || u.email) : String(id))}
                        </div>
                      );
                    })}
                    {memberIds.length > 4 && (
                      <span style={{ marginLeft: '0.5rem', fontSize: '0.75rem', color: 'var(--text-secondary)' }}>
                        +{memberIds.length - 4}
                      </span>
                    )}
                    {memberIds.length === 0 && (
                      <span style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', display: 'flex', alignItems: 'center', gap: '0.25rem' }}>
                        <Users size={12} /> No members
                      </span>
                    )}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* ─── Create Modal ─── */}
      {showCreate && (
        <div
          style={{
            position: 'fixed',
            inset: 0,
            background: 'var(--overlay-bg, rgba(0,0,0,0.6))',
            backdropFilter: 'blur(8px)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 100,
            animation: 'fadeIn 0.2s ease-out',
          }}
        >
          <div
            className="card"
            style={{
              padding: '2.5rem',
              width: '560px',
              maxWidth: '90vw',
              maxHeight: '90vh',
              overflowY: 'auto',
              border: '1px solid rgba(59, 130, 246, 0.3)',
              boxShadow: '0 20px 40px rgba(0,0,0,0.5)',
            }}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1.5rem' }}>
              <h3 style={{ fontSize: '1.5rem', fontWeight: 'bold', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                <InboxIcon size={24} color="var(--accent-color)" /> Create Shared Inbox
              </h3>
              <button
                onClick={() => setShowCreate(false)}
                style={{ background: 'transparent', border: 'none', color: 'var(--text-secondary)', cursor: 'pointer' }}
              >
                <X size={20} />
              </button>
            </div>

            <form onSubmit={handleCreate} style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
              <div>
                <label style={{ display: 'block', marginBottom: '0.5rem', fontSize: '0.875rem', color: 'var(--text-secondary)' }}>
                  Inbox Name
                </label>
                <input
                  required
                  className="input-field"
                  value={form.name}
                  onChange={(e) => setForm({ ...form, name: e.target.value })}
                  placeholder="Support Team"
                />
              </div>
              <div>
                <label style={{ display: 'block', marginBottom: '0.5rem', fontSize: '0.875rem', color: 'var(--text-secondary)' }}>
                  Email Address
                </label>
                <input
                  required
                  type="email"
                  className="input-field"
                  value={form.emailAddress}
                  onChange={(e) => setForm({ ...form, emailAddress: e.target.value })}
                  placeholder="support@yourdomain.com"
                />
              </div>
              <div>
                <label style={{ display: 'block', marginBottom: '0.5rem', fontSize: '0.875rem', color: 'var(--text-secondary)' }}>
                  Members ({form.members.length} selected)
                </label>
                <div
                  style={{
                    border: '1px solid var(--border-color)',
                    borderRadius: '8px',
                    maxHeight: '220px',
                    overflowY: 'auto',
                    padding: '0.5rem',
                  }}
                >
                  {staff.length === 0 ? (
                    <p style={{ color: 'var(--text-secondary)', fontSize: '0.85rem', padding: '0.5rem' }}>
                      No staff users available. Invite teammates first.
                    </p>
                  ) : (
                    staff.map((s) => {
                      const checked = form.members.map(Number).includes(Number(s.id));
                      return (
                        <label
                          key={s.id}
                          style={{
                            display: 'flex',
                            alignItems: 'center',
                            gap: '0.75rem',
                            padding: '0.5rem',
                            cursor: 'pointer',
                            borderRadius: '6px',
                            background: checked ? 'rgba(59,130,246,0.1)' : 'transparent',
                          }}
                        >
                          <input
                            type="checkbox"
                            checked={checked}
                            onChange={() => toggleMember(s.id)}
                          />
                          <div
                            style={{
                              width: '28px',
                              height: '28px',
                              borderRadius: '50%',
                              background: avatarColor(s.id),
                              color: '#fff',
                              display: 'flex',
                              alignItems: 'center',
                              justifyContent: 'center',
                              fontSize: '0.7rem',
                              fontWeight: 'bold',
                            }}
                          >
                            {initials(s.name || s.email)}
                          </div>
                          <div style={{ flex: 1 }}>
                            <div style={{ fontWeight: '500', fontSize: '0.9rem' }}>{s.name || s.email}</div>
                            <div style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>{s.email}</div>
                          </div>
                          <span style={{ fontSize: '0.7rem', color: 'var(--text-secondary)' }}>{s.role}</span>
                        </label>
                      );
                    })
                  )}
                </div>
              </div>

              <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '1rem', marginTop: '0.5rem' }}>
                <button
                  type="button"
                  onClick={() => setShowCreate(false)}
                  style={{ background: 'transparent', color: 'var(--text-secondary)', border: 'none', cursor: 'pointer', fontWeight: '500' }}
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="btn-primary"
                  style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}
                >
                  <Plus size={16} /> Create Inbox
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
