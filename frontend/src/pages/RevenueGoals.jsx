/**
 * RevenueGoals admin page — PRD Gap §1.6.
 *
 * Per-staff revenue goals (distinct from generic Quota). Each goal pins:
 *   - userId (target staff member)
 *   - period: MONTHLY | QUARTERLY | YEARLY
 *   - periodStart / periodEnd
 *   - targetAmount (currency-neutral)
 *   - scope: ALL | SERVICE | PRODUCT | MEMBERSHIP (filters the SUM)
 *   - scopeFilter: optional category filter
 *
 * achievedAmount is computed server-side on every GET as
 * SUM(Sale.total) WHERE cashierId=userId AND status=COMPLETED AND
 * createdAt IN [periodStart, periodEnd].
 *
 * RBAC:
 *   - ADMIN: sees all staff goals + can create/edit/delete
 *   - MANAGER: sees all staff goals (read-only)
 *   - USER: sees only their own goals (read-only)
 *
 * Backend: GET/POST/PUT/DELETE /api/staff/revenue-goals
 */
import React, { useState, useEffect, useContext } from 'react';
import { Plus, Pencil, Trash2, Target, X } from 'lucide-react';
import { fetchApi } from '../utils/api';
import { useNotify } from '../utils/notify';
import { AuthContext } from '../App';
import TopScrollSync from '../components/TopScrollSync';

const PERIOD_OPTIONS = [
  { value: 'MONTHLY', label: 'Monthly' },
  { value: 'QUARTERLY', label: 'Quarterly' },
  { value: 'YEARLY', label: 'Yearly' },
];

const SCOPE_OPTIONS = [
  { value: 'ALL', label: 'All revenue' },
  { value: 'SERVICE', label: 'Service revenue only' },
  { value: 'PRODUCT', label: 'Product revenue only' },
  { value: 'MEMBERSHIP', label: 'Membership revenue only' },
];

function emptyForm() {
  const { currentMonthStart, defaultMonthEnd } = getGoalWindowBounds();
  return {
    userId: '',
    period: 'MONTHLY',
    periodStart: currentMonthStart,
    periodEnd: defaultMonthEnd,
    targetAmount: '',
    scope: 'ALL',
    scopeFilter: '',
    notes: '',
  };
}

function formatDateInput(date) {
  const d = date instanceof Date ? date : new Date(date);
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function addMonthsToDateInput(dateInput, months) {
  const d = new Date(`${dateInput}T00:00:00`);
  d.setMonth(d.getMonth() + months);
  return formatDateInput(d);
}

function getGoalWindowBounds() {
  const today = new Date();
  const currentMonthStart = formatDateInput(new Date(today.getFullYear(), today.getMonth(), 1));
  return {
    currentMonthStart,
    maxWindowEnd: addMonthsToDateInput(currentMonthStart, 12),
    defaultMonthEnd: addMonthsToDateInput(currentMonthStart, 1),
  };
}

function isDateInputBeforeMin(value, minDate) {
  if (!value) return false;
  return value < minDate;
}

function isDateInputAfterMax(value, maxDate) {
  if (!value) return false;
  return value > maxDate;
}

function progressColor(pct) {
  if (pct >= 100) return '#22c55e';
  if (pct >= 75) return '#eab308';
  if (pct >= 50) return '#3b82f6';
  return '#ef4444';
}

export default function RevenueGoals() {
  const notify = useNotify();
  const { user } = useContext(AuthContext) || {};
  const isAdmin = user?.role === 'ADMIN';

  const [rows, setRows] = useState([]);
  const [staff, setStaff] = useState([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState(null);
  const [saving, setSaving] = useState(false);

  const load = async () => {
    setLoading(true);
    try {
      const data = await fetchApi('/api/staff/revenue-goals');
      setRows(Array.isArray(data) ? data : []);
      if (isAdmin) {
        const s = await fetchApi('/api/staff');
        setStaff(Array.isArray(s) ? s : []);
      }
    } catch (err) {
      notify.error(err.message || 'Failed to load revenue goals.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []);

  const openCreate = () => setEditing(emptyForm());
  const openEdit = (row) => setEditing({
    id: row.id,
    userId: String(row.userId),
    period: row.period || 'MONTHLY',
    periodStart: row.periodStart ? formatDateInput(row.periodStart) : '',
    periodEnd: row.periodEnd ? formatDateInput(row.periodEnd) : '',
    targetAmount: String(row.targetAmount || ''),
    scope: row.scope || 'ALL',
    scopeFilter: row.scopeFilter || '',
    notes: row.notes || '',
  });

  const save = async () => {
    if (!editing) return;
    if (!editing.userId) { notify.error('Pick a staff member.'); return; }
    if (!editing.targetAmount || Number(editing.targetAmount) <= 0) {
      notify.error('Target amount must be greater than zero.'); return;
    }
    if (!editing.periodStart || !editing.periodEnd) {
      notify.error('Period start + end are required.'); return;
    }
    const { currentMonthStart, maxWindowEnd } = getGoalWindowBounds();
    if (isDateInputBeforeMin(editing.periodStart, currentMonthStart)) {
      notify.error('Period start cannot be before the current month.');
      return;
    }
    if (isDateInputBeforeMin(editing.periodEnd, currentMonthStart)) {
      notify.error('Period end cannot be before the current month.');
      return;
    }
    if (isDateInputAfterMax(editing.periodStart, maxWindowEnd) || isDateInputAfterMax(editing.periodEnd, maxWindowEnd)) {
      notify.error('Goal period cannot exceed one year from the current month.');
      return;
    }
    const start = new Date(editing.periodStart);
    const end = new Date(editing.periodEnd);
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
      notify.error('Period dates must be valid.');
      return;
    }
    if (start.getTime() > end.getTime()) {
      notify.error('Period start must be on or before period end.');
      return;
    }
    setSaving(true);
    try {
      // #717 — backend validates `targetUserId` (not `userId`). The global
      // `stripDangerous` middleware (see CLAUDE.md "Standing rules for new
      // code") deletes `id`, `userId`, `tenantId`, `createdAt`, `updatedAt`
      // from EVERY request body BEFORE the route handler reads it — so the
      // old `userId:` payload key was being silently stripped, leaving the
      // route to see `req.body.targetUserId === undefined` and 400 with
      // "targetUserId is required (positive integer)". Sending the
      // non-stripped name matches what the route actually validates.
      const body = {
        targetUserId: Number(editing.userId),
        period: editing.period,
        periodStart: new Date(editing.periodStart).toISOString(),
        periodEnd: new Date(editing.periodEnd).toISOString(),
        targetAmount: Number(editing.targetAmount),
        scope: editing.scope,
        scopeFilter: editing.scopeFilter || null,
        notes: editing.notes || null,
      };
      if (editing.id) {
        await fetchApi(`/api/staff/revenue-goals/${editing.id}`, {
          method: 'PUT',
          body: JSON.stringify(body),
        });
        notify.success('Revenue goal updated.');
      } else {
        await fetchApi('/api/staff/revenue-goals', {
          method: 'POST',
          body: JSON.stringify(body),
        });
        notify.success('Revenue goal created.');
      }
      setEditing(null);
      load();
    } catch (err) {
      notify.error(err.message || 'Save failed.');
    } finally {
      setSaving(false);
    }
  };

  const remove = async (row) => {
    if (!await notify.confirm({
      title: 'Delete revenue goal',
      message: `Delete ${row.user?.name || 'this user'}'s ${row.period?.toLowerCase()} goal?`,
      confirmText: 'Delete',
      destructive: true,
    })) return;
    try {
      await fetchApi(`/api/staff/revenue-goals/${row.id}`, { method: 'DELETE' });
      notify.success('Goal deleted.');
      load();
    } catch (err) {
      notify.error(err.message || 'Delete failed.');
    }
  };

  return (
    <div style={{ padding: '2rem', height: '100%', overflowY: 'auto' }}>
      <header style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1.5rem', flexWrap: 'wrap', gap: '1rem' }}>
        <div>
          <h1 style={{ fontSize: '2rem', fontWeight: 'bold', display: 'flex', alignItems: 'center', gap: '0.75rem', margin: 0 }}>
            <Target size={28} color="var(--primary-color, var(--accent-color))" /> Revenue Goals
          </h1>
          <p style={{ color: 'var(--text-secondary)', marginTop: '0.25rem' }}>
            Per-staff revenue targets. Achievement is computed live from completed sales.
          </p>
        </div>
        {isAdmin && (
          <button
            onClick={openCreate}
            className="btn-primary"
            data-testid="revenue-goal-new"
            style={{ display: 'inline-flex', alignItems: 'center', gap: '0.5rem' }}
          >
            <Plus size={16} /> New goal
          </button>
        )}
      </header>

      {/* Progress widget — top three under-target goals */}
      {!loading && rows.length > 0 && (
        <div className="card" style={{ padding: '1rem 1.25rem', marginBottom: '1.5rem' }}>
          <div style={{ fontSize: '0.85rem', color: 'var(--text-secondary)', marginBottom: '0.75rem', fontWeight: 600 }}>
            Progress at a glance
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 240px), 1fr))', gap: '0.75rem' }}>
            {rows.slice(0, 6).map((r) => {
              const pct = Math.min(100, (Number(r.achievedAmount || 0) / Math.max(1, Number(r.targetAmount || 1))) * 100);
              return (
                <div key={r.id} data-testid={`goal-progress-${r.id}`}>
                  <div style={{ fontSize: '0.85rem', display: 'flex', justifyContent: 'space-between', marginBottom: '0.25rem' }}>
                    <span style={{ fontWeight: 600 }}>{r.user?.name || `User #${r.userId}`}</span>
                    <span style={{ color: progressColor(pct), fontWeight: 600 }}>{pct.toFixed(0)}%</span>
                  </div>
                  <div style={{ height: 6, background: 'var(--subtle-bg-3)', borderRadius: 4, overflow: 'hidden' }}>
                    <div style={{ height: '100%', width: `${pct}%`, background: progressColor(pct), transition: 'width 0.3s' }} />
                  </div>
                  <div style={{ fontSize: '0.72rem', color: 'var(--text-secondary)', marginTop: '0.2rem' }}>
                    {Number(r.achievedAmount || 0).toLocaleString()} / {Number(r.targetAmount || 0).toLocaleString()} ({r.period})
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      <div className="card" style={{ padding: 0, overflow: 'visible' }}>
        <TopScrollSync>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.875rem' }}>
          <thead>
            <tr style={{ background: 'rgba(255,255,255,0.04)' }}>
              <th style={th}>Staff</th>
              <th style={th}>Period</th>
              <th style={th}>Window</th>
              <th style={th}>Target</th>
              <th style={th}>Achieved</th>
              <th style={th}>Scope</th>
              {isAdmin && <th style={th}>Actions</th>}
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr><td colSpan={isAdmin ? 7 : 6} style={{ ...td, textAlign: 'center', padding: '2rem', color: 'var(--text-secondary)' }}>Loading…</td></tr>
            ) : rows.length === 0 ? (
              <tr><td colSpan={isAdmin ? 7 : 6} style={{ ...td, textAlign: 'center', padding: '2rem', color: 'var(--text-secondary)' }}>
                {isAdmin ? 'No revenue goals yet. Click "New goal" to add one.' : 'No goals assigned to you yet.'}
              </td></tr>
            ) : rows.map((row) => {
              const pct = Math.min(100, (Number(row.achievedAmount || 0) / Math.max(1, Number(row.targetAmount || 1))) * 100);
              return (
                <tr key={row.id} style={{ borderTop: '1px solid var(--border-color)' }} data-testid={`goal-row-${row.id}`}>
                  <td style={{ ...td, fontWeight: 600 }}>{row.user?.name || `User #${row.userId}`}</td>
                  <td style={td}>{row.period}</td>
                  <td style={{ ...td, fontSize: '0.8rem', color: 'var(--text-secondary)' }}>
                    {new Date(row.periodStart).toLocaleDateString()} → {new Date(row.periodEnd).toLocaleDateString()}
                  </td>
                  <td style={td}>{Number(row.targetAmount || 0).toLocaleString()}</td>
                  <td style={{ ...td, color: progressColor(pct), fontWeight: 600 }}>
                    {Number(row.achievedAmount || 0).toLocaleString()} ({pct.toFixed(0)}%)
                  </td>
                  <td style={td}>{row.scope}{row.scopeFilter ? ` / ${row.scopeFilter}` : ''}</td>
                  {isAdmin && (
                    <td style={td}>
                      <div style={{ display: 'flex', gap: '0.4rem' }}>
                        <button onClick={() => openEdit(row)} title="Edit" data-testid={`goal-edit-${row.id}`} style={iconBtn('var(--text-primary)')}>
                          <Pencil size={14} />
                        </button>
                        <button onClick={() => remove(row)} title="Delete" data-testid={`goal-delete-${row.id}`} style={iconBtn('#ef4444')}>
                          <Trash2 size={14} />
                        </button>
                      </div>
                    </td>
                  )}
                </tr>
              );
            })}
          </tbody>
        </table>
        </TopScrollSync>
      </div>

      {editing && (
        <div
          onClick={(e) => { if (e.target === e.currentTarget) setEditing(null); }}
          style={{
            position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            zIndex: 1000, padding: '1rem',
          }}
        >
          <div className="card" style={{ width: '100%', maxWidth: 540, padding: '1.5rem' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1rem' }}>
              <h3 style={{ margin: 0, fontSize: '1.1rem', fontWeight: 600 }}>
                {editing.id ? 'Edit revenue goal' : 'New revenue goal'}
              </h3>
              <button onClick={() => setEditing(null)} aria-label="Close" style={{ background: 'transparent', border: 'none', color: 'var(--text-secondary)', cursor: 'pointer' }}>
                <X size={18} />
              </button>
            </div>
            {/* #718 — keep the form grid template stable across the
                error-state re-render. Pre-fix the 2-column rows used
                `gridTemplateColumns: '1fr 1fr'` which can degenerate when
                a flex/grid child overflows its track (a missing
                `min-width: 0` makes columns shrink unevenly). After the
                first failed save, the error toast triggered a parent
                re-render that resolved the grid against the toast's
                container width — one column would collapse to its intrinsic
                content size while the other still claimed 1fr. Switching to
                `repeat(2, minmax(0, 1fr))` + `minWidth: 0` on every Field
                wrapper pins each track to half the row regardless of child
                content sizing (CLAUDE.md "ellipsis on flex/grid children
                needs min-width: 0 at every nesting level"). */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
              <Field label="Staff member">
                <select
                  className="input-field"
                  value={editing.userId}
                  onChange={(e) => setEditing({ ...editing, userId: e.target.value })}
                  data-testid="goal-form-user"
                  style={{ width: '100%', marginTop: '0.25rem' }}
                  disabled={Boolean(editing.id)}
                >
                  <option value="">— Select —</option>
                  {staff.map((s) => (
                    <option key={s.id} value={s.id}>{s.name || s.email}</option>
                  ))}
                </select>
              </Field>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: '0.75rem' }}>
                <Field label="Period">
                  <select
                    className="input-field"
                    value={editing.period}
                    onChange={(e) => setEditing({ ...editing, period: e.target.value })}
                    style={{ width: '100%', marginTop: '0.25rem' }}
                  >
                    {PERIOD_OPTIONS.map((p) => (
                      <option key={p.value} value={p.value}>{p.label}</option>
                    ))}
                  </select>
                </Field>
                <Field label="Target amount">
                  <input
                    type="number"
                    min="0"
                    step="0.01"
                    className="input-field"
                    value={editing.targetAmount}
                    onChange={(e) => setEditing({ ...editing, targetAmount: e.target.value })}
                    data-testid="goal-form-target"
                    style={{ width: '100%', marginTop: '0.25rem' }}
                  />
                </Field>
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: '0.75rem' }}>
                <Field label="Period start">
                  <input
                    type="date"
                    className="input-field"
                    min={getGoalWindowBounds().currentMonthStart}
                    max={getGoalWindowBounds().maxWindowEnd}
                    value={editing.periodStart}
                    onChange={(e) => setEditing({ ...editing, periodStart: e.target.value })}
                    style={{ width: '100%', marginTop: '0.25rem' }}
                  />
                </Field>
                <Field label="Period end">
                  <input
                    type="date"
                    className="input-field"
                    min={editing.periodStart || getGoalWindowBounds().currentMonthStart}
                    max={getGoalWindowBounds().maxWindowEnd}
                    value={editing.periodEnd}
                    onChange={(e) => setEditing({ ...editing, periodEnd: e.target.value })}
                    style={{ width: '100%', marginTop: '0.25rem' }}
                  />
                </Field>
              </div>
              <Field label="Scope">
                <select
                  className="input-field"
                  value={editing.scope}
                  onChange={(e) => setEditing({ ...editing, scope: e.target.value })}
                  style={{ width: '100%', marginTop: '0.25rem' }}
                >
                  {SCOPE_OPTIONS.map((s) => (
                    <option key={s.value} value={s.value}>{s.label}</option>
                  ))}
                </select>
              </Field>
              {editing.scope !== 'ALL' && (
                <Field label="Category filter (optional)">
                  <input
                    type="text"
                    className="input-field"
                    placeholder="e.g. Aesthetics"
                    value={editing.scopeFilter}
                    onChange={(e) => setEditing({ ...editing, scopeFilter: e.target.value })}
                    style={{ width: '100%', marginTop: '0.25rem' }}
                  />
                </Field>
              )}
              <Field label="Notes (optional)">
                <textarea
                  className="input-field"
                  rows={2}
                  value={editing.notes}
                  onChange={(e) => setEditing({ ...editing, notes: e.target.value })}
                  style={{ width: '100%', marginTop: '0.25rem' }}
                />
              </Field>
            </div>
            <div style={{ display: 'flex', gap: '0.5rem', justifyContent: 'flex-end', marginTop: '1.25rem' }}>
              <button
                onClick={() => setEditing(null)}
                disabled={saving}
                style={{
                  background: 'transparent', color: 'var(--text-secondary)',
                  border: '1px solid var(--border-color)', borderRadius: '6px',
                  padding: '0.4rem 0.9rem', cursor: 'pointer', fontSize: '0.85rem',
                }}
              >
                Cancel
              </button>
              <button
                onClick={save}
                disabled={saving}
                className="btn-primary"
                data-testid="goal-form-save"
                style={{ padding: '0.4rem 0.9rem', fontSize: '0.85rem' }}
              >
                {saving ? 'Saving…' : 'Save'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function Field({ label, children }) {
  // #718 — `display: block` + `minWidth: 0` keep the wrapper from collapsing
  // to its intrinsic width when it lands inside a grid cell. A bare <label>
  // inherits inline-level layout in some browsers and lets the grid track
  // shrink to the label text width — that's what produced the
  // "labels disappear / inputs still on the right" symptom after the first
  // failed save (the parent re-render evaluated the grid against the toast
  // container and resolved one column to its inline-content size).
  return (
    <label style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', display: 'block', minWidth: 0 }}>
      {label}
      {children}
    </label>
  );
}

function iconBtn(color) {
  return {
    background: 'transparent',
    border: '1px solid var(--border-color)',
    borderRadius: '6px',
    color,
    padding: '0.3rem 0.55rem',
    cursor: 'pointer',
    display: 'inline-flex',
    alignItems: 'center',
  };
}

const th = {
  padding: '0.85rem 1rem',
  textAlign: 'left',
  fontSize: '0.78rem',
  textTransform: 'uppercase',
  letterSpacing: '0.05em',
  color: 'var(--text-secondary)',
};
const td = { padding: '0.75rem 1rem', fontSize: '0.875rem' };
