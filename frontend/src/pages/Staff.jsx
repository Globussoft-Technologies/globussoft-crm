import React, { useState, useEffect, useContext } from 'react';
import { fetchApi } from '../utils/api';
import { useNotify } from '../utils/notify';
import { UsersRound, Trash2, Shield, Edit3, UserX, UserCheck, Key, MailPlus, X } from 'lucide-react';
import { AuthContext } from '../App';
import { formatDate } from '../utils/date';

const ROLE_CONFIG = {
  ADMIN:   { color: '#a855f7', bg: 'rgba(168,85,247,0.1)' },
  MANAGER: { color: '#3b82f6', bg: 'rgba(59,130,246,0.1)' },
  USER:    { color: '#6b7280', bg: 'rgba(107,114,128,0.1)' },
};

// #236: wellness verticals don't want to see "USER" for every doctor — show
// their wellnessRole (doctor / professional / stylist / helper / telecaller)
// as the primary label. Falls through to RBAC role for generic tenants.
function displayRole(member) {
  if (member.wellnessRole) {
    return member.wellnessRole.charAt(0).toUpperCase() + member.wellnessRole.slice(1);
  }
  return member.role;
}

// #618 — palette for the per-row action buttons. Each kind picks a hue
// that matches the action's intent (edit=neutral, deactivate=amber,
// reset=blue, invite=teal, delete=red).
const ACTION_PALETTE = {
  edit:       { fg: 'var(--text-primary)', bg: 'var(--subtle-bg-3)', bd: 'var(--border-color)' },
  deactivate: { fg: '#f59e0b', bg: 'rgba(245,158,11,0.1)', bd: 'rgba(245,158,11,0.25)' },
  reactivate: { fg: '#10b981', bg: 'rgba(16,185,129,0.1)', bd: 'rgba(16,185,129,0.25)' },
  reset:      { fg: '#3b82f6', bg: 'rgba(59,130,246,0.1)', bd: 'rgba(59,130,246,0.25)' },
  invite:     { fg: '#0ea5e9', bg: 'rgba(14,165,233,0.1)', bd: 'rgba(14,165,233,0.25)' },
  delete:     { fg: '#ef4444', bg: 'rgba(239,68,68,0.1)', bd: 'rgba(239,68,68,0.25)' },
};
function actionButtonStyle(kind) {
  const p = ACTION_PALETTE[kind] || ACTION_PALETTE.edit;
  return {
    background: p.bg,
    color: p.fg,
    border: `1px solid ${p.bd}`,
    borderRadius: '6px',
    padding: '0.3rem 0.55rem',
    cursor: 'pointer',
    display: 'inline-flex',
    alignItems: 'center',
    gap: '0.3rem',
    fontSize: '0.72rem',
    fontWeight: 500,
    whiteSpace: 'nowrap',
  };
}

function RoleBadge({ role }) {
  const cfg = ROLE_CONFIG[role] || ROLE_CONFIG.USER;
  return (
    <span style={{
      padding: '0.2rem 0.6rem', borderRadius: '999px', fontSize: '0.7rem',
      fontWeight: 'bold', backgroundColor: cfg.bg, color: cfg.color,
      border: `1px solid ${cfg.color}33`, whiteSpace: 'nowrap',
    }}>
      {role}
    </span>
  );
}

export default function Staff() {
  const notify = useNotify();
  // #323: a clinic Manager (role=MANAGER) was seeing Delete buttons on
  // every staff row — including the Owner and other Admins. The DELETE
  // /api/staff/:id endpoint is already gated by verifyRole(["ADMIN"]),
  // so the click would 403, but the UI shouldn't dangle the button at
  // all. Hide both the Delete control and the inline RBAC role select
  // unless the viewer is an actual ADMIN.
  const { user } = useContext(AuthContext) || {};
  const canManageStaff = user?.role === 'ADMIN';
  const [staff, setStaff] = useState([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState(null);
  // #618 — edit-modal state. null when closed; { id, name, email, role,
  // wellnessRole } when an admin clicked Edit on a row.
  const [editing, setEditing] = useState(null);
  const [savingEdit, setSavingEdit] = useState(false);

  useEffect(() => { loadStaff(); }, []);

  const loadStaff = async () => {
    try {
      setLoading(true);
      const data = await fetchApi('/api/staff');
      setStaff(Array.isArray(data) ? data : []);
    } catch (err) {
      console.error('Failed to load staff:', err);
    } finally {
      setLoading(false);
    }
  };

  const updateRole = async (id, role) => {
    try {
      await fetchApi(`/api/staff/${id}/role`, { method: 'PUT', body: JSON.stringify({ role }) });
      loadStaff();
    } catch (err) {
      notify.error(err.message || 'Failed to update role.');
    }
  };

  // #618 — Edit / Deactivate / Reset Password / Resend Invite handlers.
  const openEdit = (member) => {
    setEditing({
      id: member.id,
      name: member.name || '',
      email: member.email || '',
      role: member.role || 'USER',
      wellnessRole: member.wellnessRole || '',
    });
  };

  const saveEdit = async () => {
    if (!editing) return;
    setSavingEdit(true);
    try {
      await fetchApi(`/api/staff/${editing.id}`, {
        method: 'PUT',
        body: JSON.stringify({
          name: editing.name,
          email: editing.email,
          role: editing.role,
          // Send null (not '') when wellnessRole is cleared so the backend
          // can clear the column rather than reject an empty string.
          wellnessRole: editing.wellnessRole || null,
        }),
      });
      notify.success('Staff member updated.');
      setEditing(null);
      loadStaff();
    } catch (err) {
      notify.error(err.message || 'Failed to update staff member.');
    } finally {
      setSavingEdit(false);
    }
  };

  const toggleActive = async (member) => {
    const goingInactive = !member.deactivatedAt;
    const verb = goingInactive ? 'Deactivate' : 'Reactivate';
    const target = member.name || member.email || 'this user';
    if (!await notify.confirm({
      title: `${verb} staff member`,
      message: goingInactive
        ? `Deactivate ${target}? They will lose access until you reactivate them. This is reversible.`
        : `Reactivate ${target}? They will regain access immediately.`,
      confirmText: verb,
      cancelText: 'Cancel',
      destructive: goingInactive,
    })) return;
    try {
      await fetchApi(`/api/staff/${member.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ active: !goingInactive }),
      });
      notify.success(`${target} ${goingInactive ? 'deactivated' : 'reactivated'}.`);
      loadStaff();
    } catch (err) {
      notify.error(err.message || `Failed to ${verb.toLowerCase()} user.`);
    }
  };

  const resetPassword = async (member) => {
    const target = member.name || member.email || 'this user';
    if (!await notify.confirm({
      title: 'Reset password',
      message: `Send a password-reset link to ${member.email}? The link is valid for 1 hour.`,
      confirmText: 'Send reset link',
      cancelText: 'Cancel',
    })) return;
    try {
      await fetchApi(`/api/staff/${member.id}/reset-password`, { method: 'POST', body: JSON.stringify({}) });
      notify.success(`Password reset link sent to ${target}.`);
    } catch (err) {
      notify.error(err.message || 'Failed to send password reset.');
    }
  };

  const resendInvite = async (member) => {
    const target = member.name || member.email || 'this user';
    if (!await notify.confirm({
      title: 'Resend invite',
      message: `Re-send the welcome invite email to ${member.email}? The link is valid for 24 hours.`,
      confirmText: 'Resend invite',
      cancelText: 'Cancel',
    })) return;
    try {
      await fetchApi(`/api/staff/${member.id}/resend-invite`, { method: 'POST', body: JSON.stringify({}) });
      notify.success(`Invite resent to ${target}.`);
    } catch (err) {
      notify.error(err.message || 'Failed to resend invite.');
    }
  };

  const deleteUser = async (id, name) => {
    // #340: this used to be a string-form notify.confirm, which renders as a
    // generic modal with a neutral "Confirm" button. The Staff Delete control
    // is genuinely destructive (hard delete on the User row + cascading
    // ownership reassignments), so we use the structured form so the modal:
    //   1. has a clear destructive title
    //   2. shows a red "Delete" button (notify.confirm honours `destructive`)
    //   3. echoes the staff member's name back to the operator so they can
    //      sanity-check who they're about to remove before clicking
    const target = name || 'this user';
    if (!await notify.confirm({
      title: 'Delete staff member',
      message: `Permanently delete ${target}? This cannot be undone.`,
      confirmText: 'Delete',
      cancelText: 'Keep',
      destructive: true,
    })) return;
    try {
      await fetchApi(`/api/staff/${id}`, { method: 'DELETE' });
      loadStaff();
    } catch (err) {
      notify.error(err.message || 'Failed to delete user.');
    }
  };

  const adminCount = staff.filter(s => s.role === 'ADMIN').length;
  const managerCount = staff.filter(s => s.role === 'MANAGER').length;
  const userCount = staff.filter(s => s.role === 'USER').length;

  const filteredStaff = filter ? staff.filter(s => s.role === filter) : staff;

  return (
    <div style={{ padding: '2rem', height: '100%', overflowY: 'auto', animation: 'fadeIn 0.5s ease-out' }}>
      <header style={{ marginBottom: '2rem' }}>
        <h1 style={{ fontSize: '2rem', fontWeight: 'bold', display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
          <UsersRound size={26} color="var(--accent-color)" /> Staff Directory
        </h1>
        <p style={{ color: 'var(--text-secondary)', marginTop: '0.25rem' }}>
          Manage team members, roles, and access levels.
        </p>
      </header>

      {/* Stats bar */}
      {staff.length > 0 && (
        <div style={{ display: 'flex', gap: '0.75rem', marginBottom: '1.75rem', flexWrap: 'wrap' }}>
          <button
            onClick={() => setFilter(filter === 'ADMIN' ? null : 'ADMIN')}
            style={{
              padding: '0.4rem 1rem', borderRadius: '999px', background: filter === 'ADMIN' ? 'rgba(168,85,247,0.2)' : 'rgba(168,85,247,0.1)',
              color: '#a855f7', fontSize: '0.8rem', fontWeight: '600', border: '1px solid rgba(168,85,247,0.3)',
              display: 'flex', alignItems: 'center', gap: '0.3rem', cursor: 'pointer', transition: 'all 0.2s',
            }}
          >
            <Shield size={12} /> {adminCount} Admins
          </button>
          <button
            onClick={() => setFilter(filter === 'MANAGER' ? null : 'MANAGER')}
            style={{
              padding: '0.4rem 1rem', borderRadius: '999px', background: filter === 'MANAGER' ? 'rgba(59,130,246,0.2)' : 'rgba(59,130,246,0.1)',
              color: '#3b82f6', fontSize: '0.8rem', fontWeight: '600', border: '1px solid rgba(59,130,246,0.3)',
              cursor: 'pointer', transition: 'all 0.2s',
            }}
          >
            {managerCount} Managers
          </button>
          <button
            onClick={() => setFilter(filter === 'USER' ? null : 'USER')}
            style={{
              padding: '0.4rem 1rem', borderRadius: '999px', background: filter === 'USER' ? 'var(--subtle-bg-3)' : 'var(--subtle-bg-4)',
              color: filter === 'USER' ? 'var(--text-primary)' : 'var(--text-secondary)', fontSize: '0.8rem', fontWeight: '600', border: '1px solid var(--border-color)',
              cursor: 'pointer', transition: 'all 0.2s',
            }}
          >
            {userCount} Users
          </button>
          <button
            onClick={() => setFilter(null)}
            style={{
              padding: '0.4rem 1rem', borderRadius: '999px', background: !filter ? 'var(--subtle-bg-3)' : 'var(--subtle-bg-4)',
              color: !filter ? 'var(--text-primary)' : 'var(--text-secondary)', fontSize: '0.8rem', fontWeight: '600', border: '1px solid var(--border-color)',
              cursor: 'pointer', transition: 'all 0.2s',
            }}
          >
            {staff.length} total
          </button>
        </div>
      )}

      {/* Staff Table */}
      <div className="card" style={{ padding: '2rem', overflow: 'auto' }}>
        <h3 style={{ fontSize: '1.15rem', fontWeight: '600', marginBottom: '1.5rem', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
          <UsersRound size={20} color="var(--accent-color)" /> Team Members
        </h3>

        {loading ? (
          <p style={{ color: 'var(--text-secondary)', textAlign: 'center', padding: '2rem' }}>Loading...</p>
        ) : staff.length === 0 ? (
          <p style={{ color: 'var(--text-secondary)', textAlign: 'center', padding: '2rem' }}>
            No staff members found.
          </p>
        ) : filteredStaff.length === 0 ? (
          <p style={{ color: 'var(--text-secondary)', textAlign: 'center', padding: '2rem' }}>
            No staff members with that role.
          </p>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.875rem' }}>
              <thead>
                <tr style={{ borderBottom: '1px solid var(--border-color)' }}>
                  {['Name', 'Email', 'Role', 'Joined', 'Actions'].map(h => (
                    <th key={h} style={{
                      padding: '0.75rem 0.5rem', textAlign: 'left', color: 'var(--text-secondary)',
                      fontSize: '0.75rem', fontWeight: '600', textTransform: 'uppercase', letterSpacing: '0.05em',
                    }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {filteredStaff.map(member => (
                  <tr key={member.id} style={{ borderBottom: '1px solid var(--border-color)', transition: '0.15s' }}
                    onMouseEnter={e => e.currentTarget.style.background = 'var(--subtle-bg-2)'}
                    onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
                  >
                    <td style={{ padding: '0.75rem 0.5rem', fontWeight: '500' }}>
                      {member.name || '—'}
                    </td>
                    <td style={{ padding: '0.75rem 0.5rem', color: 'var(--text-secondary)' }}>
                      {member.email}
                    </td>
                    <td style={{ padding: '0.75rem 0.5rem' }}>
                      {member.wellnessRole ? (
                        // For wellness staff, display the wellnessRole as a
                        // read-only badge (it's edited elsewhere). The RBAC
                        // role dropdown still works for non-wellness members.
                        <span
                          title={`RBAC role: ${member.role}`}
                          style={{
                            background: 'rgba(38,88,85,0.1)',
                            color: 'var(--accent-color, #265855)',
                            border: '1px solid rgba(38,88,85,0.3)',
                            borderRadius: '999px',
                            padding: '0.2rem 0.6rem',
                            fontSize: '0.75rem',
                            fontWeight: 600,
                            textTransform: 'capitalize',
                            display: 'inline-block',
                          }}
                        >
                          {displayRole(member)}
                        </span>
                      ) : canManageStaff ? (
                        <select
                          value={member.role}
                          onChange={e => updateRole(member.id, e.target.value)}
                          style={{
                            background: ROLE_CONFIG[member.role]?.bg || 'transparent',
                            color: ROLE_CONFIG[member.role]?.color || 'inherit',
                            border: `1px solid ${ROLE_CONFIG[member.role]?.color || 'var(--border-color)'}33`,
                            borderRadius: '999px', padding: '0.2rem 0.5rem', fontSize: '0.75rem',
                            fontWeight: 'bold', cursor: 'pointer', outline: 'none',
                          }}
                        >
                          <option value="ADMIN">ADMIN</option>
                          <option value="MANAGER">MANAGER</option>
                          <option value="USER">USER</option>
                        </select>
                      ) : (
                        // #323: non-admins see role as a read-only badge.
                        <RoleBadge role={member.role} />
                      )}
                    </td>
                    <td style={{ padding: '0.75rem 0.5rem', color: 'var(--text-secondary)', whiteSpace: 'nowrap' }}>
                      {formatDate(member.createdAt)}
                      {member.deactivatedAt && (
                        <div data-testid="staff-inactive-badge" style={{
                          display: 'inline-block', marginLeft: '0.5rem',
                          padding: '1px 8px', borderRadius: '8px', fontSize: '0.65rem',
                          fontWeight: 600, background: 'rgba(239,68,68,0.12)', color: '#ef4444',
                          border: '1px solid rgba(239,68,68,0.3)',
                        }}>Inactive</div>
                      )}
                    </td>
                    <td style={{ padding: '0.75rem 0.5rem' }} data-testid={`staff-actions-${member.id}`}>
                      {canManageStaff ? (
                        <div style={{ display: 'flex', gap: '0.3rem', flexWrap: 'wrap' }}>
                          <button
                            onClick={() => openEdit(member)}
                            data-testid={`staff-action-edit-${member.id}`}
                            title="Edit user"
                            style={actionButtonStyle('edit')}
                          >
                            <Edit3 size={13} /> Edit
                          </button>
                          {member.role !== 'ADMIN' && (
                            <button
                              onClick={() => toggleActive(member)}
                              data-testid={`staff-action-deactivate-${member.id}`}
                              title={member.deactivatedAt ? 'Reactivate user' : 'Deactivate user'}
                              style={actionButtonStyle(member.deactivatedAt ? 'reactivate' : 'deactivate')}
                            >
                              {member.deactivatedAt ? <UserCheck size={13} /> : <UserX size={13} />}
                              {member.deactivatedAt ? 'Reactivate' : 'Deactivate'}
                            </button>
                          )}
                          <button
                            onClick={() => resetPassword(member)}
                            data-testid={`staff-action-reset-password-${member.id}`}
                            title="Send password reset link"
                            style={actionButtonStyle('reset')}
                          >
                            <Key size={13} /> Reset Password
                          </button>
                          <button
                            onClick={() => resendInvite(member)}
                            data-testid={`staff-action-resend-invite-${member.id}`}
                            title="Re-send the original invite email"
                            style={actionButtonStyle('invite')}
                          >
                            <MailPlus size={13} /> Resend Invite
                          </button>
                          {member.role !== 'ADMIN' && (
                            <button
                              onClick={() => deleteUser(member.id, member.name || member.email)}
                              data-testid={`staff-action-delete-${member.id}`}
                              title="Delete user"
                              style={actionButtonStyle('delete')}
                            >
                              <Trash2 size={13} /> Delete
                            </button>
                          )}
                        </div>
                      ) : (
                        <span style={{ color: 'var(--text-secondary)', fontSize: '0.75rem' }}>—</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* #618 — edit modal. Opens when an admin clicks Edit on a row. */}
      {editing && (
        <div
          data-testid="staff-edit-modal"
          onClick={(e) => { if (e.target === e.currentTarget) setEditing(null); }}
          style={{
            position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            zIndex: 1000, padding: '1rem',
          }}
        >
          <div className="card" style={{ width: '100%', maxWidth: 460, padding: '1.5rem' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1rem' }}>
              <h3 style={{ margin: 0, fontSize: '1.1rem', fontWeight: 600 }}>Edit staff member</h3>
              <button
                onClick={() => setEditing(null)}
                aria-label="Close"
                style={{ background: 'transparent', border: 'none', color: 'var(--text-secondary)', cursor: 'pointer' }}
              >
                <X size={18} />
              </button>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
              <label style={{ fontSize: '0.8rem', color: 'var(--text-secondary)' }}>
                Name
                <input
                  type="text"
                  className="input-field"
                  value={editing.name}
                  onChange={(e) => setEditing({ ...editing, name: e.target.value })}
                  style={{ width: '100%', marginTop: '0.25rem' }}
                />
              </label>
              <label style={{ fontSize: '0.8rem', color: 'var(--text-secondary)' }}>
                Email
                <input
                  type="email"
                  className="input-field"
                  value={editing.email}
                  onChange={(e) => setEditing({ ...editing, email: e.target.value })}
                  style={{ width: '100%', marginTop: '0.25rem' }}
                />
              </label>
              <label style={{ fontSize: '0.8rem', color: 'var(--text-secondary)' }}>
                RBAC role
                <select
                  className="input-field"
                  value={editing.role}
                  onChange={(e) => setEditing({ ...editing, role: e.target.value })}
                  style={{ width: '100%', marginTop: '0.25rem' }}
                >
                  <option value="ADMIN">ADMIN</option>
                  <option value="MANAGER">MANAGER</option>
                  <option value="USER">USER</option>
                </select>
              </label>
              <label style={{ fontSize: '0.8rem', color: 'var(--text-secondary)' }}>
                Wellness role <span style={{ color: 'var(--text-secondary)', fontWeight: 400 }}>(optional)</span>
                <select
                  className="input-field"
                  value={editing.wellnessRole}
                  onChange={(e) => setEditing({ ...editing, wellnessRole: e.target.value })}
                  style={{ width: '100%', marginTop: '0.25rem' }}
                >
                  <option value="">— None —</option>
                  <option value="doctor">Doctor</option>
                  <option value="professional">Professional</option>
                  <option value="telecaller">Telecaller</option>
                  <option value="helper">Helper</option>
                  <option value="stylist">Stylist</option>
                </select>
              </label>
            </div>
            <div style={{ display: 'flex', gap: '0.5rem', justifyContent: 'flex-end', marginTop: '1.25rem' }}>
              <button
                onClick={() => setEditing(null)}
                disabled={savingEdit}
                style={{
                  background: 'transparent', color: 'var(--text-secondary)',
                  border: '1px solid var(--border-color)', borderRadius: '6px',
                  padding: '0.4rem 0.9rem', cursor: 'pointer', fontSize: '0.85rem',
                }}
              >
                Cancel
              </button>
              <button
                onClick={saveEdit}
                disabled={savingEdit}
                data-testid="staff-edit-save"
                className="btn-primary"
                style={{ padding: '0.4rem 0.9rem', fontSize: '0.85rem' }}
              >
                {savingEdit ? 'Saving...' : 'Save changes'}
              </button>
            </div>
          </div>
        </div>
      )}

      <style>{`@keyframes fadeIn { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: none; } }`}</style>
    </div>
  );
}
