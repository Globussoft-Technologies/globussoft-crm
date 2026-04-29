import React, { useState, useEffect, useContext } from 'react';
import { fetchApi } from '../utils/api';
import { useNotify } from '../utils/notify';
import { UsersRound, Trash2, Shield } from 'lucide-react';
import { AuthContext } from '../App';

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

  const deleteUser = async (id, name) => {
    if (!await notify.confirm(`Are you sure you want to delete ${name || 'this user'}? This action cannot be undone.`)) return;
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
          <span style={{
            padding: '0.4rem 1rem', borderRadius: '999px', background: 'rgba(168,85,247,0.1)',
            color: '#a855f7', fontSize: '0.8rem', fontWeight: '600', border: '1px solid rgba(168,85,247,0.3)',
            display: 'flex', alignItems: 'center', gap: '0.3rem',
          }}>
            <Shield size={12} /> {adminCount} Admins
          </span>
          <span style={{
            padding: '0.4rem 1rem', borderRadius: '999px', background: 'rgba(59,130,246,0.1)',
            color: '#3b82f6', fontSize: '0.8rem', fontWeight: '600', border: '1px solid rgba(59,130,246,0.3)',
          }}>
            {managerCount} Managers
          </span>
          <span style={{
            padding: '0.4rem 1rem', borderRadius: '999px', background: 'var(--subtle-bg-4)',
            color: 'var(--text-secondary)', fontSize: '0.8rem', border: '1px solid var(--border-color)',
          }}>
            {userCount} Users
          </span>
          <span style={{
            padding: '0.4rem 1rem', borderRadius: '999px', background: 'var(--subtle-bg-4)',
            color: 'var(--text-secondary)', fontSize: '0.8rem', border: '1px solid var(--border-color)',
          }}>
            {staff.length} total
          </span>
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
                {staff.map(member => (
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
                      {new Date(member.createdAt).toLocaleDateString()}
                    </td>
                    <td style={{ padding: '0.75rem 0.5rem' }}>
                      {canManageStaff ? (
                        <button
                          onClick={() => deleteUser(member.id, member.name || member.email)}
                          title="Delete user"
                          style={{
                            background: 'rgba(239,68,68,0.1)', color: '#ef4444', border: '1px solid rgba(239,68,68,0.2)',
                            borderRadius: '6px', padding: '0.35rem 0.5rem', cursor: 'pointer', display: 'flex',
                            alignItems: 'center', gap: '0.3rem', fontSize: '0.75rem',
                          }}
                        >
                          <Trash2 size={13} /> Delete
                        </button>
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

      <style>{`@keyframes fadeIn { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: none; } }`}</style>
    </div>
  );
}
