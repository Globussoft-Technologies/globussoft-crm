import React, { useState, useEffect, useContext, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { fetchApi } from '../utils/api';
import { useNotify } from '../utils/notify';
import { UsersRound, Trash2, Shield, ShieldCheck, Edit3, UserX, UserCheck, Key, MailPlus, X, UserPlus, Search, Filter as FilterIcon } from 'lucide-react';
import { AuthContext } from '../App';
import { usePermissions } from '../hooks/usePermissions';
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
  edit:        { fg: 'var(--text-primary)', bg: 'var(--subtle-bg-3)', bd: 'var(--border-color)' },
  deactivate:  { fg: '#f59e0b', bg: 'rgba(245,158,11,0.1)', bd: 'rgba(245,158,11,0.25)' },
  reactivate:  { fg: '#10b981', bg: 'rgba(16,185,129,0.1)', bd: 'rgba(16,185,129,0.25)' },
  reset:       { fg: '#3b82f6', bg: 'rgba(59,130,246,0.1)', bd: 'rgba(59,130,246,0.25)' },
  invite:      { fg: '#0ea5e9', bg: 'rgba(14,165,233,0.1)', bd: 'rgba(14,165,233,0.25)' },
  delete:      { fg: '#ef4444', bg: 'rgba(239,68,68,0.1)', bd: 'rgba(239,68,68,0.25)' },
  // RBAC per-row "Permissions" button — matches the ADMIN role badge hue at
  // line 9 above (purple #a855f7) so the action visually signals "admin /
  // security tooling" without duplicating any other palette entry.
  permissions: { fg: '#a855f7', bg: 'rgba(168,85,247,0.1)', bd: 'rgba(168,85,247,0.25)' },
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
  const { user, tenant } = useContext(AuthContext) || {};
  const canManageStaff = user?.role === 'ADMIN';
  const isWellness = tenant?.vertical === 'wellness';
  // #618 + RBAC: the Permissions button is gated on the granular roles.read
  // permission (not the legacy ADMIN role), so a custom non-ADMIN role with
  // roles.read granted can still view permission sheets. Falls through to
  // the same AccessDenied card the rest of the RBAC pages use.
  const { hasPermission } = usePermissions();
  const canViewPermissions = hasPermission('roles', 'read');
  const navigate = useNavigate();
  const [staff, setStaff] = useState([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState(null);
  // Free-text search across name + email. Trimmed + lower-cased at match time.
  const [searchQuery, setSearchQuery] = useState('');
  // 'all' | 'active' | 'inactive'. Deactivated staff are visible by default in
  // the table (with the Inactive badge), so the default here stays 'all'.
  const [statusFilter, setStatusFilter] = useState('all');
  // Wellness vertical only. '' = no filter; otherwise filters by wellnessRole key.
  const [wellnessRoleFilter, setWellnessRoleFilter] = useState('');
  // Filter dropdown open state + click-outside ref so the panel closes when
  // the user clicks elsewhere on the page.
  const [filterOpen, setFilterOpen] = useState(false);
  const filterPanelRef = useRef(null);
  // #618 — edit-modal state. null when closed; { id, name, email, role,
  // wellnessRole } when an admin clicked Edit on a row.
  const [editing, setEditing] = useState(null);
  const [savingEdit, setSavingEdit] = useState(false);
  // Add-Staff modal state. null when closed; the form draft when open.
  // POSTs to /api/staff which creates a user inside the current tenant.
  // The created user lands on the role-aware Dashboard variant on first login.
  const [creating, setCreating] = useState(null);
  const [savingCreate, setSavingCreate] = useState(false);
  // PRD Gap §1.5 — commission profiles are listed in the edit modal as a
  // dropdown so admins can assign payroll rules per staff member.
  const [commissionProfiles, setCommissionProfiles] = useState([]);
  // RBAC roles available in the current tenant. Populates the "Job role"
  // dropdown in both Add Staff + Edit Staff modals so admins can assign
  // any custom role (Doctor / Nurse / Receptionist / Telecaller / …)
  // without going through a separate Roles & Permissions step.
  const [availableRoles, setAvailableRoles] = useState([]);
  // Per-tenant wellness role catalog (doctor / professional / nurse / …
  // plus any custom rows the admin added via Settings → Wellness Role
  // Types). Populates the "Wellness role" dropdown in both modals so
  // POST /api/staff doesn't reject a hardcoded value that isn't in the
  // tenant's catalog (the cause of the "Unknown wellness role for this
  // tenant" toast on freshly-signed-up wellness tenants).
  const [wellnessRoleTypes, setWellnessRoleTypes] = useState([]);
  // Staff availability tracking
  const [availDate, setAvailDate] = useState(new Date());
  const [availability, setAvailability] = useState([]);
  const [availLoading, setAvailLoading] = useState(false);
  const [showAvailability, setShowAvailability] = useState(false);

  useEffect(() => {
    loadStaff();
    loadCommissionProfiles();
    loadAvailableRoles();
    if (isWellness) loadWellnessRoleTypes();
  }, [isWellness]);

  // Load availability when date changes or showAvailability is toggled
  useEffect(() => {
    if (showAvailability) {
      loadAvailability();
    }
  }, [availDate, showAvailability]);

  // Close the filter dropdown when the user clicks anywhere outside it.
  useEffect(() => {
    if (!filterOpen) return undefined;
    const onDocClick = (e) => {
      if (filterPanelRef.current && !filterPanelRef.current.contains(e.target)) {
        setFilterOpen(false);
      }
    };
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, [filterOpen]);

  const loadCommissionProfiles = async () => {
    if (!canManageStaff) return;
    try {
      const data = await fetchApi('/api/staff/commission-profiles');
      setCommissionProfiles(Array.isArray(data) ? data.filter((p) => p.isActive !== false) : []);
    } catch {
      // Non-fatal — the dropdown just shows "(none)" + the assigned profile
      // is preserved on save because we only send commissionProfileId when
      // it actually changed.
      setCommissionProfiles([]);
    }
  };

  // Fetch the list of roles in the current tenant. Filtered to STAFF (no
  // CUSTOMER, no platform OWNER) since this page only manages staff. The
  // dropdown options populate from /api/roles so a new Custom role becomes
  // immediately assignable from the Add Staff modal — no code change needed.
  const loadAvailableRoles = async () => {
    if (!canManageStaff) return;
    try {
      const res = await fetchApi('/api/roles');
      const all = Array.isArray(res?.roles) ? res.roles : [];
      const staffOnly = all.filter(
        (r) => (!r.userType || r.userType === 'STAFF') && r.isActive !== false,
      );
      // Sort: System roles first (ADMIN / MANAGER), then Custom alphabetical
      // so the dropdown reads predictably across sessions.
      staffOnly.sort((a, b) => {
        if (a.isSystem !== b.isSystem) return a.isSystem ? -1 : 1;
        return (a.name || '').localeCompare(b.name || '');
      });
      setAvailableRoles(staffOnly);
    } catch {
      // Non-fatal — the dropdown just hides if the catalog can't be loaded.
      setAvailableRoles([]);
    }
  };

  // Wellness-vertical only. The backend GET endpoint auto-seeds the
  // default catalog (doctor / professional / nurse / stylist / telecaller
  // / helper) the first time a wellness tenant hits it with an empty
  // table, so a freshly-signed-up tenant gets sensible defaults without
  // any admin setup.
  const loadWellnessRoleTypes = async () => {
    try {
      const data = await fetchApi('/api/wellness/role-types?activeOnly=1');
      setWellnessRoleTypes(Array.isArray(data) ? data : []);
    } catch {
      // Non-fatal — the dropdown collapses to "— None —" if the catalog
      // can't be loaded, and the admin can still pick a non-wellness
      // role for the user.
      setWellnessRoleTypes([]);
    }
  };

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

  const loadAvailability = async () => {
    try {
      setAvailLoading(true);
      const dateStr = availDate.toISOString().split('T')[0];
      const data = await fetchApi(`/api/leave/availability?date=${dateStr}`);
      setAvailability(Array.isArray(data) ? data : []);
    } catch (err) {
      console.error('Failed to load availability:', err);
    } finally {
      setAvailLoading(false);
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
      // PRD Gap §1.5 — current commission-profile assignment (null = unassigned).
      commissionProfileId: member.commissionProfileId == null ? '' : String(member.commissionProfileId),
      // Pre-populate the RBAC role dropdown from the member's current
      // primary role (surfaced by GET /api/staff). Empty string = unset.
      rbacRoleId: member.primaryRole?.id ? String(member.primaryRole.id) : '',
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
          // PRD Gap §1.5 — number or null. '' becomes null (clear assignment).
          commissionProfileId: editing.commissionProfileId === '' ? null : Number(editing.commissionProfileId),
          // rbacRoleId: '' → explicit null (clear), number → assign that
          // role, undefined → don't touch. We always send the field here
          // because the admin can have explicitly cleared the dropdown,
          // and the backend distinguishes null-vs-undefined.
          rbacRoleId: editing.rbacRoleId === ''
            ? null
            : parseInt(editing.rbacRoleId, 10),
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

  // Open the Add-Staff modal with empty defaults. The legacy `role` field
  // (USER/MANAGER/ADMIN) drives the User.role column. The new `rbacRoleId`
  // is the modern junction-table assignment — what /home routing and the
  // widget layout key off of. Empty rbacRoleId = let the boot-time RBAC
  // sync auto-assign the matching role, but for new staff the admin
  // should always pick one explicitly so the user lands on the right page.
  const openCreate = () => {
    setCreating({
      name: '',
      email: '',
      password: '',
      role: 'USER',
      wellnessRole: '',
      rbacRoleId: '',
    });
  };

  const saveCreate = async () => {
    if (!creating) return;
    // Quick client-side gate so we don't ask the backend for a round-trip
    // on obviously-incomplete forms. Backend still re-validates everything.
    const name = (creating.name || '').trim();
    const email = (creating.email || '').trim();
    const password = creating.password || '';
    if (!name) { notify.error('Please enter the staff member’s name.'); return; }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { notify.error('Please enter a valid work email address.'); return; }
    if (password.length < 6) { notify.error('Password must be at least 6 characters.'); return; }
    if (!['ADMIN', 'MANAGER', 'USER'].includes(creating.role)) { notify.error('Please choose a role.'); return; }
    setSavingCreate(true);
    try {
      await fetchApi('/api/staff', {
        method: 'POST',
        body: JSON.stringify({
          name,
          email,
          password,
          role: creating.role,
          wellnessRole: creating.wellnessRole || null,
          // Empty string → undefined so the backend treats it as "no
          // RBAC role specified" rather than "clear to null".
          rbacRoleId: creating.rbacRoleId
            ? parseInt(creating.rbacRoleId, 10)
            : undefined,
        }),
      });
      notify.success(`${name} added to the team.`);
      setCreating(null);
      loadStaff();
    } catch (err) {
      notify.error(err.message || 'Failed to add staff member.');
    } finally {
      setSavingCreate(false);
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

  const normalizedQuery = searchQuery.trim().toLowerCase();
  const filteredStaff = staff.filter((s) => {
    if (filter && s.role !== filter) return false;
    if (statusFilter === 'active' && s.deactivatedAt) return false;
    if (statusFilter === 'inactive' && !s.deactivatedAt) return false;
    if (wellnessRoleFilter && s.wellnessRole !== wellnessRoleFilter) return false;
    if (normalizedQuery) {
      const name = (s.name || '').toLowerCase();
      const email = (s.email || '').toLowerCase();
      if (!name.includes(normalizedQuery) && !email.includes(normalizedQuery)) return false;
    }
    return true;
  });
  // Counts ONLY the filters that live inside the dropdown panel — drives the
  // numeric badge on the Filter button. Search lives outside the dropdown and
  // role-pill filter lives in the stats bar above, so they're surfaced visibly
  // elsewhere already.
  const activeFilterCount = (
    (statusFilter !== 'all' ? 1 : 0)
    + (wellnessRoleFilter ? 1 : 0)
  );
  const hasActiveFilters = Boolean(filter) || activeFilterCount > 0 || Boolean(normalizedQuery);
  const clearFilters = () => {
    setSearchQuery('');
    setFilter(null);
    setStatusFilter('all');
    setWellnessRoleFilter('');
  };

  return (
    <div style={{ padding: '2rem', height: '100%', overflowY: 'auto', animation: 'fadeIn 0.5s ease-out' }}>
      <header style={{ marginBottom: '2rem', display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', gap: '1rem', flexWrap: 'wrap' }}>
        <div>
          <h1 style={{ fontSize: '2rem', fontWeight: 'bold', display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
            <UsersRound size={26} color="var(--accent-color)" /> Staff Directory
          </h1>
          <p style={{ color: 'var(--text-secondary)', marginTop: '0.25rem' }}>
            Manage team members, roles, and access levels.
          </p>
        </div>
        {/* Admin-only Add Staff CTA. Uses the wellness teal token first and
            falls back to the generic accent color — matches the standing
            rule for primary CTAs (CLAUDE.md). Non-admins never see it. */}
        {canManageStaff && (
          <button
            type="button"
            onClick={openCreate}
            data-testid="staff-add-button"
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: '0.45rem',
              padding: '0.55rem 1rem',
              borderRadius: '8px',
              background: 'var(--primary-color, var(--accent-color))',
              color: '#fff',
              border: '1px solid var(--primary-color, var(--accent-color))',
              fontSize: '0.875rem',
              fontWeight: 600,
              cursor: 'pointer',
              boxShadow: '0 2px 8px rgba(38,88,85,0.25)',
              transition: 'filter 0.15s',
            }}
            onMouseEnter={(e) => { e.currentTarget.style.filter = 'brightness(1.1)'; }}
            onMouseLeave={(e) => { e.currentTarget.style.filter = 'none'; }}
            title="Add a new staff member to this organization"
          >
            <UserPlus size={16} /> Add Staff
          </button>
        )}
      </header>

      {/* Stats bar */}
      {staff.length > 0 && (
        <div style={{ display: 'flex', gap: '0.75rem', marginBottom: '1.75rem', flexWrap: 'wrap', alignItems: 'center' }}>
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
          {/* Availability toggle - only for ADMIN/MANAGER */}
          {canManageStaff && (
            <div style={{ marginLeft: 'auto' }}>
              <button
                onClick={() => setShowAvailability(!showAvailability)}
                style={{
                  padding: '0.4rem 1rem', borderRadius: '999px', background: showAvailability ? 'rgba(34,197,94,0.2)' : 'rgba(34,197,94,0.1)',
                  color: '#22c55e', fontSize: '0.8rem', fontWeight: '600', border: '1px solid rgba(34,197,94,0.3)',
                  cursor: 'pointer', transition: 'all 0.2s',
                }}
              >
                {showAvailability ? '✓ Availability' : 'Availability'}
              </button>
            </div>
          )}
        </div>
      )}

      {/* Availability Panel - Only for ADMIN users */}
      {showAvailability && canManageStaff && (
        <div className="card" style={{ padding: '1.5rem', marginBottom: '2rem', background: 'var(--subtle-bg-1)' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1rem' }}>
            <h3 style={{ fontSize: '1rem', fontWeight: '600' }}>Staff Availability</h3>
            <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
              <button
                onClick={() => setAvailDate(new Date(availDate.getTime() - 86400000))}
                style={{ padding: '0.3rem 0.6rem', borderRadius: '4px', border: '1px solid var(--border-color)', background: 'var(--subtle-bg-2)', cursor: 'pointer', fontSize: '0.8rem' }}
              >
                ← Prev
              </button>
              <span style={{ fontSize: '0.85rem', fontWeight: '500', minWidth: '120px', textAlign: 'center' }}>
                {availDate.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })}
              </span>
              <button
                onClick={() => setAvailDate(new Date(availDate.getTime() + 86400000))}
                style={{ padding: '0.3rem 0.6rem', borderRadius: '4px', border: '1px solid var(--border-color)', background: 'var(--subtle-bg-2)', cursor: 'pointer', fontSize: '0.8rem' }}
              >
                Next →
              </button>
              <button
                onClick={() => setAvailDate(new Date())}
                style={{ padding: '0.3rem 0.6rem', borderRadius: '4px', border: '1px solid var(--border-color)', background: 'var(--subtle-bg-2)', cursor: 'pointer', fontSize: '0.75rem' }}
              >
                Today
              </button>
            </div>
          </div>

          {/* Summary bar */}
          {!availLoading && availability.length > 0 && (
            <div style={{ display: 'flex', gap: '2rem', marginBottom: '1.25rem', padding: '0.75rem 0', borderBottom: '1px solid var(--border-color)' }}>
              <div style={{ fontSize: '0.85rem' }}>
                <span style={{ color: 'var(--text-secondary)' }}>Available: </span>
                <span style={{ fontWeight: '600', color: '#22c55e' }}>{availability.filter(a => a.available).length}</span>
              </div>
              <div style={{ fontSize: '0.85rem' }}>
                <span style={{ color: 'var(--text-secondary)' }}>On Leave: </span>
                <span style={{ fontWeight: '600', color: '#ef4444' }}>{availability.filter(a => !a.available).length}</span>
              </div>
            </div>
          )}

          {/* Staff availability list */}
          {availLoading ? (
            <p style={{ color: 'var(--text-secondary)', textAlign: 'center', padding: '1rem' }}>Loading availability...</p>
          ) : availability.length === 0 ? (
            <p style={{ color: 'var(--text-secondary)', textAlign: 'center', padding: '1rem' }}>No staff data available.</p>
          ) : (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(250px, 1fr))', gap: '1rem' }}>
              {availability.map(member => (
                <div
                  key={member.id}
                  style={{
                    padding: '0.75rem',
                    borderRadius: '6px',
                    background: member.available ? 'rgba(34,197,94,0.08)' : 'rgba(239,68,68,0.08)',
                    border: `1px solid ${member.available ? 'rgba(34,197,94,0.2)' : 'rgba(239,68,68,0.2)'}`,
                    transition: 'all 0.2s',
                  }}
                >
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'start' }}>
                    <div>
                      <div style={{ fontWeight: '500', fontSize: '0.85rem', marginBottom: '0.25rem' }}>
                        {member.name || '—'}
                      </div>
                      <div style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>
                        {displayRole(member)}
                      </div>
                    </div>
                    <div
                      style={{
                        padding: '0.2rem 0.5rem',
                        borderRadius: '4px',
                        fontSize: '0.7rem',
                        fontWeight: '600',
                        background: member.available ? 'rgba(34,197,94,0.2)' : 'rgba(239,68,68,0.2)',
                        color: member.available ? '#22c55e' : '#ef4444',
                        whiteSpace: 'nowrap',
                      }}
                    >
                      {member.available ? '● Available' : '✕ On Leave'}
                    </div>
                  </div>
                  {!member.available && member.leave && (
                    <div style={{ marginTop: '0.5rem', fontSize: '0.7rem', color: 'var(--text-secondary)' }}>
                      <div>{member.leave.leaveType}</div>
                      <div>
                        {new Date(member.leave.startDate).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
                        {' – '}
                        {new Date(member.leave.endDate).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
                      </div>
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Staff Table */}
      <div className="card" style={{ padding: '2rem', overflow: 'auto' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '1rem', marginBottom: '1.25rem', flexWrap: 'wrap' }}>
          <h3 style={{ fontSize: '1.15rem', fontWeight: '600', margin: 0, display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <UsersRound size={20} color="var(--accent-color)" /> Team Members
          </h3>
          {staff.length > 0 && (
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', flexWrap: 'wrap' }}>
              {/* Inline search — name + email, case-insensitive substring match. */}
              <div style={{ position: 'relative', width: 260 }}>
                <Search
                  size={14}
                  style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', color: 'var(--text-secondary)', pointerEvents: 'none' }}
                />
                <input
                  type="search"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  placeholder="Search by name or email…"
                  aria-label="Search staff by name or email"
                  data-testid="staff-search-input"
                  className="input-field"
                  style={{ width: '100%', padding: '0.45rem 0.6rem 0.45rem 2rem', fontSize: '0.85rem' }}
                />
              </div>
              <span style={{ fontSize: '0.8rem', color: 'var(--text-secondary)' }}>
                Showing {filteredStaff.length} of {staff.length}
              </span>
              {/* Filter button + popover. Click toggles; click-outside closes.
                  Badge surfaces the count of active in-panel filters so the
                  user can see at a glance that the dropdown is narrowing the
                  table beyond the inline search. */}
              <div ref={filterPanelRef} style={{ position: 'relative' }}>
                <button
                  type="button"
                  onClick={() => setFilterOpen((v) => !v)}
                  aria-haspopup="true"
                  aria-expanded={filterOpen}
                  data-testid="staff-filter-button"
                  style={{
                    display: 'inline-flex', alignItems: 'center', gap: '0.4rem',
                    padding: '0.45rem 0.85rem', borderRadius: '6px',
                    background: filterOpen || activeFilterCount > 0
                      ? 'rgba(38,88,85,0.12)'
                      : 'var(--subtle-bg-3)',
                    color: activeFilterCount > 0
                      ? 'var(--primary-color, var(--accent-color))'
                      : 'var(--text-primary)',
                    border: `1px solid ${activeFilterCount > 0
                      ? 'var(--primary-color, var(--accent-color))'
                      : 'var(--border-color)'}`,
                    cursor: 'pointer', fontSize: '0.85rem', fontWeight: 500,
                  }}
                >
                  <FilterIcon size={14} /> Filter
                  {activeFilterCount > 0 && (
                    <span
                      data-testid="staff-filter-badge"
                      style={{
                        background: 'var(--primary-color, var(--accent-color))',
                        color: '#fff', borderRadius: '999px',
                        padding: '0 0.4rem', fontSize: '0.7rem',
                        fontWeight: 700, lineHeight: '1.25rem',
                        minWidth: '1.25rem', textAlign: 'center',
                      }}
                    >
                      {activeFilterCount}
                    </span>
                  )}
                </button>
                {filterOpen && (
                  <div
                    data-testid="staff-filter-panel"
                    style={{
                      position: 'absolute', top: 'calc(100% + 0.4rem)', right: 0,
                      width: 300, zIndex: 50,
                      // Solid page background + subtle blur so the panel doesn't
                      // bleed table content through. --bg-color is the only
                      // fully-opaque token in the theme; --subtle-bg-* are all
                      // semi-transparent and were causing the readability bug.
                      background: 'var(--bg-color)',
                      backdropFilter: 'blur(8px)',
                      WebkitBackdropFilter: 'blur(8px)',
                      border: '1px solid var(--border-color)',
                      borderRadius: '8px',
                      boxShadow: '0 8px 24px rgba(0,0,0,0.35)',
                      padding: '1rem',
                      display: 'flex', flexDirection: 'column', gap: '0.85rem',
                    }}
                  >
                    <label style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', fontWeight: 600 }}>
                      Status
                      <select
                        value={statusFilter}
                        onChange={(e) => setStatusFilter(e.target.value)}
                        aria-label="Filter by status"
                        data-testid="staff-status-filter"
                        className="input-field"
                        style={{ width: '100%', padding: '0.4rem 0.6rem', fontSize: '0.85rem', marginTop: '0.3rem' }}
                      >
                        <option value="all">All statuses</option>
                        <option value="active">Active only</option>
                        <option value="inactive">Inactive only</option>
                      </select>
                    </label>
                    {isWellness && wellnessRoleTypes.length > 0 && (
                      <label style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', fontWeight: 600 }}>
                        Wellness role
                        <select
                          value={wellnessRoleFilter}
                          onChange={(e) => setWellnessRoleFilter(e.target.value)}
                          aria-label="Filter by wellness role"
                          data-testid="staff-wellness-role-filter"
                          className="input-field"
                          style={{ width: '100%', padding: '0.4rem 0.6rem', fontSize: '0.85rem', marginTop: '0.3rem' }}
                        >
                          <option value="">All wellness roles</option>
                          {wellnessRoleTypes.map((r) => (
                            <option key={r.id} value={r.key}>{r.label}</option>
                          ))}
                        </select>
                      </label>
                    )}
                    <div style={{ display: 'flex', justifyContent: 'space-between', gap: '0.5rem', borderTop: '1px solid var(--border-color)', paddingTop: '0.75rem' }}>
                      <button
                        type="button"
                        onClick={clearFilters}
                        disabled={!hasActiveFilters}
                        data-testid="staff-clear-filters"
                        style={{
                          display: 'inline-flex', alignItems: 'center', gap: '0.3rem',
                          padding: '0.35rem 0.7rem', borderRadius: '6px',
                          background: 'transparent', color: 'var(--text-secondary)',
                          border: '1px solid var(--border-color)',
                          cursor: hasActiveFilters ? 'pointer' : 'not-allowed',
                          opacity: hasActiveFilters ? 1 : 0.5,
                          fontSize: '0.8rem',
                        }}
                      >
                        <X size={12} /> Clear all
                      </button>
                      <button
                        type="button"
                        onClick={() => setFilterOpen(false)}
                        style={{
                          padding: '0.35rem 0.8rem', borderRadius: '6px',
                          background: 'var(--primary-color, var(--accent-color))',
                          color: '#fff',
                          border: '1px solid var(--primary-color, var(--accent-color))',
                          cursor: 'pointer', fontSize: '0.8rem', fontWeight: 600,
                        }}
                      >
                        Done
                      </button>
                    </div>
                  </div>
                )}
              </div>
            </div>
          )}
        </div>

        {loading ? (
          <p style={{ color: 'var(--text-secondary)', textAlign: 'center', padding: '2rem' }}>Loading...</p>
        ) : staff.length === 0 ? (
          <p style={{ color: 'var(--text-secondary)', textAlign: 'center', padding: '2rem' }}>
            No staff members found.
          </p>
        ) : filteredStaff.length === 0 ? (
          <p style={{ color: 'var(--text-secondary)', textAlign: 'center', padding: '2rem' }}>
            No staff members match the current search or filters.
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
                      {/* Surface the primary RBAC role assignment next to
                          the legacy access tier. Helps admins eyeball
                          which staff are mapped to which custom role
                          (DOCTOR / NURSE / etc.) without opening Edit. */}
                      {member.primaryRole && member.primaryRole.key !== member.role && (
                        <div style={{
                          marginTop: 4, fontSize: '0.7rem', color: 'var(--text-secondary)',
                          display: 'flex', alignItems: 'center', gap: '0.25rem',
                        }}>
                          <Shield size={11} /> {member.primaryRole.name}
                        </div>
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
                      {(canManageStaff || canViewPermissions) ? (
                        <div style={{ display: 'flex', gap: '0.3rem', flexWrap: 'wrap' }}>
                          {canManageStaff && (
                            <>
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
                            </>
                          )}
                          {canViewPermissions && (
                            <button
                              onClick={() => navigate(`/staff/${member.id}/permissions`)}
                              data-testid={`staff-action-permissions-${member.id}`}
                              title="View effective permissions for this user"
                              style={actionButtonStyle('permissions')}
                            >
                              <ShieldCheck size={13} /> Permissions
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

      {/* Add-Staff modal. Mirrors the edit-modal shape so both share the
          same overlay/card chrome. On success the new user can log in with
          the chosen email + password; their role decides the dashboard
          variant rendered on first nav to /dashboard. */}
      {creating && (
        <div
          data-testid="staff-create-modal"
          onClick={(e) => { if (e.target === e.currentTarget) setCreating(null); }}
          style={{
            position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            zIndex: 1000, padding: '1rem',
          }}
        >
          <div className="card" style={{ width: '100%', maxWidth: 460, padding: '1.5rem' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.25rem' }}>
              <h3 style={{ margin: 0, fontSize: '1.1rem', fontWeight: 600, display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                <UserPlus size={18} color="var(--primary-color, var(--accent-color))" /> Add staff member
              </h3>
              <button
                onClick={() => setCreating(null)}
                aria-label="Close"
                style={{ background: 'transparent', border: 'none', color: 'var(--text-secondary)', cursor: 'pointer' }}
              >
                <X size={18} />
              </button>
            </div>
            <p style={{ margin: '0 0 1rem', fontSize: '0.8rem', color: 'var(--text-secondary)' }}>
              The new member will be added to your organization and can sign in immediately with the credentials below.
            </p>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
              <label style={{ fontSize: '0.8rem', color: 'var(--text-secondary)' }}>
                Working name
                <input
                  type="text"
                  className="input-field"
                  value={creating.name}
                  onChange={(e) => setCreating({ ...creating, name: e.target.value })}
                  placeholder="e.g. Dr. Priyambada"
                  data-testid="staff-create-name"
                  autoFocus
                  style={{ width: '100%', marginTop: '0.25rem' }}
                />
              </label>
              <label style={{ fontSize: '0.8rem', color: 'var(--text-secondary)' }}>
                Work email <span style={{ color: 'var(--text-secondary)', fontWeight: 400 }}>(not a personal address)</span>
                <input
                  type="email"
                  className="input-field"
                  value={creating.email}
                  onChange={(e) => setCreating({ ...creating, email: e.target.value })}
                  placeholder="name@yourclinic.com"
                  data-testid="staff-create-email"
                  style={{ width: '100%', marginTop: '0.25rem' }}
                />
              </label>
              <label style={{ fontSize: '0.8rem', color: 'var(--text-secondary)' }}>
                Temporary password <span style={{ color: 'var(--text-secondary)', fontWeight: 400 }}>(min 6 characters)</span>
                <input
                  type="text"
                  className="input-field"
                  value={creating.password}
                  onChange={(e) => setCreating({ ...creating, password: e.target.value })}
                  placeholder="Share securely with the new staff member"
                  data-testid="staff-create-password"
                  autoComplete="new-password"
                  style={{ width: '100%', marginTop: '0.25rem' }}
                />
              </label>
              <label style={{ fontSize: '0.8rem', color: 'var(--text-secondary)' }}>
                Role
                <select
                  className="input-field"
                  value={creating.role}
                  onChange={(e) => setCreating({ ...creating, role: e.target.value })}
                  data-testid="staff-create-role"
                  style={{ width: '100%', marginTop: '0.25rem' }}
                >
                  <option value="USER">USER — sees their own tasks + pipeline</option>
                  <option value="MANAGER">MANAGER — team overview + reports</option>
                  <option value="ADMIN">ADMIN — full enterprise overview</option>
                </select>
              </label>
              <label style={{ fontSize: '0.8rem', color: 'var(--text-secondary)' }}>
                Job role <span style={{ color: 'var(--text-secondary)', fontWeight: 400 }}>(drives /home dashboard + permissions)</span>
                <select
                  className="input-field"
                  value={creating.rbacRoleId}
                  onChange={(e) => setCreating({ ...creating, rbacRoleId: e.target.value })}
                  data-testid="staff-create-rbac-role"
                  style={{ width: '100%', marginTop: '0.25rem' }}
                >
                  <option value="">— Use access tier default —</option>
                  {availableRoles.map((r) => (
                    <option key={r.id} value={r.id}>
                      {r.name}{r.description ? ` — ${r.description}` : ''}
                    </option>
                  ))}
                </select>
              </label>
              <label style={{ fontSize: '0.8rem', color: 'var(--text-secondary)' }}>
                Wellness role <span style={{ color: 'var(--text-secondary)', fontWeight: 400 }}>(optional)</span>
                <select
                  className="input-field"
                  value={creating.wellnessRole}
                  onChange={(e) => setCreating({ ...creating, wellnessRole: e.target.value })}
                  data-testid="staff-create-wellness-role"
                  style={{ width: '100%', marginTop: '0.25rem' }}
                >
                  <option value="">— None —</option>
                  {wellnessRoleTypes.map((r) => (
                    <option key={r.id} value={r.key}>{r.label}</option>
                  ))}
                </select>
              </label>
            </div>
            <div style={{ display: 'flex', gap: '0.5rem', justifyContent: 'flex-end', marginTop: '1.25rem' }}>
              <button
                onClick={() => setCreating(null)}
                disabled={savingCreate}
                style={{
                  background: 'transparent', color: 'var(--text-secondary)',
                  border: '1px solid var(--border-color)', borderRadius: '6px',
                  padding: '0.4rem 0.9rem', cursor: 'pointer', fontSize: '0.85rem',
                }}
              >
                Cancel
              </button>
              <button
                onClick={saveCreate}
                disabled={savingCreate}
                data-testid="staff-create-save"
                style={{
                  display: 'inline-flex', alignItems: 'center', gap: '0.4rem',
                  background: 'var(--primary-color, var(--accent-color))',
                  color: '#fff',
                  border: '1px solid var(--primary-color, var(--accent-color))',
                  borderRadius: '6px',
                  padding: '0.4rem 0.9rem', cursor: savingCreate ? 'wait' : 'pointer',
                  fontSize: '0.85rem', fontWeight: 600,
                }}
              >
                {savingCreate ? 'Adding…' : (<><UserPlus size={14} /> Add staff member</>)}
              </button>
            </div>
          </div>
        </div>
      )}

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
                Access tier
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
                Job role <span style={{ color: 'var(--text-secondary)', fontWeight: 400 }}>(drives /home dashboard + permissions)</span>
                <select
                  className="input-field"
                  value={editing.rbacRoleId}
                  onChange={(e) => setEditing({ ...editing, rbacRoleId: e.target.value })}
                  data-testid="staff-edit-rbac-role"
                  style={{ width: '100%', marginTop: '0.25rem' }}
                >
                  <option value="">— None —</option>
                  {availableRoles.map((r) => (
                    <option key={r.id} value={r.id}>
                      {r.name}{r.description ? ` — ${r.description}` : ''}
                    </option>
                  ))}
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
                  {/* If the staff member currently holds a wellnessRole
                      that's NOT in the active catalog (deactivated /
                      deleted by an admin after assignment), surface it
                      as a disabled placeholder option so the dropdown
                      still reflects the saved value instead of silently
                      showing "— None —". */}
                  {editing.wellnessRole &&
                   !wellnessRoleTypes.some((r) => r.key === editing.wellnessRole) && (
                    <option value={editing.wellnessRole} disabled>
                      {editing.wellnessRole} (no longer in catalog)
                    </option>
                  )}
                  {wellnessRoleTypes.map((r) => (
                    <option key={r.id} value={r.key}>{r.label}</option>
                  ))}
                </select>
              </label>
              {/* PRD Gap §1.5 — assign a commission profile. Empty = no profile. */}
              <label style={{ fontSize: '0.8rem', color: 'var(--text-secondary)' }}>
                Commission profile <span style={{ color: 'var(--text-secondary)', fontWeight: 400 }}>(optional)</span>
                <select
                  className="input-field"
                  value={editing.commissionProfileId}
                  onChange={(e) => setEditing({ ...editing, commissionProfileId: e.target.value })}
                  data-testid="staff-edit-commission-profile"
                  style={{ width: '100%', marginTop: '0.25rem' }}
                >
                  <option value="">— None —</option>
                  {commissionProfiles.map((p) => (
                    <option key={p.id} value={p.id}>{p.name}</option>
                  ))}
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
