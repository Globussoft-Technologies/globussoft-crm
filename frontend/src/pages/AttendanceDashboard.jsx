// Attendance Dashboard — staff + admin view.
//
// Layout (matches the mockup the user requested):
//   1. Period filter (Today / Yesterday / Last 7 Days / Last 30 Days / This Month)
//   2. 9 KPI tiles  — Total Logs, Absent, Present, Early/On-Time/Late Arrival,
//                      Early/On-Time/Late Departure
//   3. Attendance List table — Employee Name, Date, Check-In, Check-Out,
//      Check-In Type, Check-Out Type, Check-In Recorded Via, Check-Out
//      Recorded Via, Absent, Notes, Actions (Edit/Delete — ADMIN only)
//   4. Calendar View link → /wellness/attendance/calendar (existing page)
//
// RBAC:
//   - ADMIN + MANAGER can view the KPIs + all-staff list (backend
//     /api/attendance/summary + /list are role-gated)
//   - ADMIN-only sees Edit/Delete buttons (backend /api/attendance/:id
//     PUT + DELETE are ADMIN-only)
//
// Mounted at /wellness/attendance-dashboard and /travel/attendance via App.jsx.

import { useEffect, useMemo, useState, useContext } from 'react';
import { Link } from 'react-router-dom';
import {
  ClipboardList,
  UserX,
  UserCheck,
  Sunrise,
  Clock,
  Sunset,
  Edit2,
  Trash2,
  Calendar as CalendarIcon,
  Info,
  X,
  RefreshCw,
} from 'lucide-react';
import { fetchApi } from '../utils/api';
import { useNotify } from '../utils/notify';
import { AuthContext } from '../App';
import TopScrollSync from '../components/TopScrollSync';

// ──────────────────────────────────────────────────────────────────
// Date-range presets
// ──────────────────────────────────────────────────────────────────
const PERIOD_OPTIONS = [
  { value: 'today', label: 'Today' },
  { value: 'yesterday', label: 'Yesterday' },
  { value: 'last7', label: 'Last 7 Days' },
  { value: 'last30', label: 'Last 30 Days' },
  { value: 'thisMonth', label: 'This Month' },
];

function resolveRange(preset) {
  const now = new Date();
  const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const toIso = (d) => d.toISOString().slice(0, 10);
  switch (preset) {
    case 'today':
      return { from: toIso(today), to: toIso(today) };
    case 'yesterday': {
      const d = new Date(today.getTime() - 86_400_000);
      return { from: toIso(d), to: toIso(d) };
    }
    case 'last7': {
      const start = new Date(today.getTime() - 6 * 86_400_000);
      return { from: toIso(start), to: toIso(today) };
    }
    case 'last30': {
      const start = new Date(today.getTime() - 29 * 86_400_000);
      return { from: toIso(start), to: toIso(today) };
    }
    case 'thisMonth': {
      const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
      return { from: toIso(start), to: toIso(today) };
    }
    default:
      return { from: toIso(today), to: toIso(today) };
  }
}

// ──────────────────────────────────────────────────────────────────
// Formatters
// ──────────────────────────────────────────────────────────────────
function fmtDate(s) {
  if (!s) return '—';
  return new Date(s).toLocaleDateString();
}
function fmtTime(s) {
  if (!s) return 'N/A';
  return new Date(s).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}
function fmtArrivalLabel(s) {
  if (!s) return 'N/A';
  if (s === 'EARLY') return 'Early';
  if (s === 'ON_TIME') return 'On Time';
  if (s === 'AFTER') return 'Late';
  return 'N/A';
}
function fmtDepartureLabel(s) {
  if (!s) return 'N/A';
  if (s === 'EARLY') return 'Early';
  if (s === 'ON_TIME') return 'On Time';
  if (s === 'LATE') return 'Late';
  return 'N/A';
}

// ──────────────────────────────────────────────────────────────────
// KPI tile
// ──────────────────────────────────────────────────────────────────
function KpiTile({ icon: Icon, label, value, hint }) {
  return (
    <div
      style={{
        background: 'var(--surface-color)',
        border: '1px solid var(--border-color)',
        borderRadius: 12,
        padding: '1rem 1.25rem',
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
        minWidth: 0,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, color: 'var(--text-secondary)', fontSize: 13 }}>
        <Icon size={16} aria-hidden />
        <span>{label}</span>
        {hint ? <Info size={12} aria-label={hint} title={hint} style={{ opacity: 0.6 }} /> : null}
      </div>
      <div style={{ fontSize: 28, fontWeight: 700, color: 'var(--text-primary)' }}>{value}</div>
    </div>
  );
}

// ──────────────────────────────────────────────────────────────────
// Edit modal (ADMIN only)
// ──────────────────────────────────────────────────────────────────
function EditAttendanceModal({ row, onClose, onSaved }) {
  const notify = useNotify();
  const [saving, setSaving] = useState(false);
  // Datetime-local inputs expect "YYYY-MM-DDTHH:mm". Convert from ISO + back.
  const toLocalInput = (iso) => {
    if (!iso) return '';
    const d = new Date(iso);
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  };
  const [form, setForm] = useState({
    clockInAt: toLocalInput(row.clockInAt),
    clockOutAt: toLocalInput(row.clockOutAt),
    status: row.status || 'PRESENT',
    notes: row.notes || '',
  });

  const onSubmit = async (e) => {
    e.preventDefault();
    setSaving(true);
    try {
      const body = {
        clockInAt: form.clockInAt ? new Date(form.clockInAt).toISOString() : null,
        clockOutAt: form.clockOutAt ? new Date(form.clockOutAt).toISOString() : null,
        status: form.status,
        notes: form.notes,
      };
      const updated = await fetchApi(`/api/attendance/${row.id}`, {
        method: 'PUT',
        body: JSON.stringify(body),
      });
      notify.success('Attendance updated');
      onSaved(updated);
    } catch {
      // fetchApi auto-toasts on error
    } finally {
      setSaving(false);
    }
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="attendance-edit-title"
      style={{
        position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.45)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        zIndex: 1000,
      }}
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <form
        onSubmit={onSubmit}
        style={{
          background: 'var(--bg-color)',
          color: 'var(--text-primary)',
          border: '1px solid var(--border-color)',
          borderRadius: 12, padding: 24,
          width: 'min(520px, 92vw)',
          maxHeight: '92vh', overflowY: 'auto',
          boxShadow: '0 8px 30px rgba(0,0,0,0.45)',
        }}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
          <h3 id="attendance-edit-title" style={{ margin: 0 }}>
            Edit attendance — {row.user?.name || `User #${row.userId}`}
          </h3>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            style={{ background: 'transparent', border: 'none', cursor: 'pointer', color: 'inherit' }}
          >
            <X size={20} />
          </button>
        </div>

        <div style={{ display: 'grid', gap: 12 }}>
          <label style={{ display: 'grid', gap: 4 }}>
            <span style={{ fontSize: 13, color: 'var(--text-secondary)' }}>Date</span>
            <input type="text" value={fmtDate(row.date)} readOnly
              style={{ padding: '0.5rem 0.75rem', border: '1px solid var(--border-color)', borderRadius: 6, background: 'var(--input-bg)', color: 'var(--text-primary)' }} />
          </label>

          <label style={{ display: 'grid', gap: 4 }}>
            <span style={{ fontSize: 13, color: 'var(--text-secondary)' }}>Clock-In</span>
            <input type="datetime-local" value={form.clockInAt}
              onChange={(e) => setForm({ ...form, clockInAt: e.target.value })}
              style={{ padding: '0.5rem 0.75rem', border: '1px solid var(--border-color)', borderRadius: 6, background: 'var(--input-bg)', color: 'var(--text-primary)', colorScheme: 'dark light' }} />
          </label>

          <label style={{ display: 'grid', gap: 4 }}>
            <span style={{ fontSize: 13, color: 'var(--text-secondary)' }}>Clock-Out</span>
            <input type="datetime-local" value={form.clockOutAt}
              onChange={(e) => setForm({ ...form, clockOutAt: e.target.value })}
              style={{ padding: '0.5rem 0.75rem', border: '1px solid var(--border-color)', borderRadius: 6, background: 'var(--input-bg)', color: 'var(--text-primary)', colorScheme: 'dark light' }} />
          </label>

          <label style={{ display: 'grid', gap: 4 }}>
            <span style={{ fontSize: 13, color: 'var(--text-secondary)' }}>Status</span>
            <select value={form.status}
              onChange={(e) => setForm({ ...form, status: e.target.value })}
              style={{ padding: '0.5rem 0.75rem', border: '1px solid var(--border-color)', borderRadius: 6, background: 'var(--input-bg)', color: 'var(--text-primary)' }}
            >
              <option value="PRESENT" style={{ background: 'var(--bg-color)', color: 'var(--text-primary)' }}>Present</option>
              <option value="HALF_DAY" style={{ background: 'var(--bg-color)', color: 'var(--text-primary)' }}>Half Day</option>
              <option value="LATE" style={{ background: 'var(--bg-color)', color: 'var(--text-primary)' }}>Late</option>
              <option value="ABSENT" style={{ background: 'var(--bg-color)', color: 'var(--text-primary)' }}>Absent</option>
              <option value="HOLIDAY" style={{ background: 'var(--bg-color)', color: 'var(--text-primary)' }}>Holiday</option>
            </select>
          </label>

          <label style={{ display: 'grid', gap: 4 }}>
            <span style={{ fontSize: 13, color: 'var(--text-secondary)' }}>Notes</span>
            <textarea value={form.notes} rows={3}
              onChange={(e) => setForm({ ...form, notes: e.target.value })}
              style={{ padding: '0.5rem 0.75rem', border: '1px solid var(--border-color)', borderRadius: 6, fontFamily: 'inherit', background: 'var(--input-bg)', color: 'var(--text-primary)' }} />
          </label>
        </div>

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 20 }}>
          <button type="button" onClick={onClose} disabled={saving}
            style={{ padding: '0.5rem 1rem', borderRadius: 6, border: '1px solid var(--border-color)', background: 'transparent', cursor: 'pointer', color: 'inherit' }}>
            Cancel
          </button>
          <button type="submit" disabled={saving}
            style={{ padding: '0.5rem 1rem', borderRadius: 6, border: 'none', background: 'var(--primary-color, var(--accent-color))', color: '#fff', cursor: saving ? 'not-allowed' : 'pointer', opacity: saving ? 0.7 : 1 }}>
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
      </form>
    </div>
  );
}

// ──────────────────────────────────────────────────────────────────
// Main page
// ──────────────────────────────────────────────────────────────────
export default function AttendanceDashboard() {
  const notify = useNotify();
  const { user, tenant } = useContext(AuthContext) || {};
  const isAdmin = user?.role === 'ADMIN';
  const isManagerOrAdmin = user?.role === 'ADMIN' || user?.role === 'MANAGER';

  const [period, setPeriod] = useState('today');
  const { from, to } = useMemo(() => resolveRange(period), [period]);

  const [summary, setSummary] = useState(null);
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [editRow, setEditRow] = useState(null);

  const load = () => {
    if (!isManagerOrAdmin) {
      setLoading(false);
      return;
    }
    setLoading(true);
    Promise.all([
      fetchApi(`/api/attendance/summary?from=${from}&to=${to}`).catch(() => null),
      fetchApi(`/api/attendance/list?from=${from}&to=${to}`).catch(() => ({ items: [] })),
    ])
      .then(([sum, list]) => {
        setSummary(sum);
        setRows(Array.isArray(list?.items) ? list.items : []);
      })
      .finally(() => setLoading(false));
  };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(load, [from, to, isManagerOrAdmin]);

  const onDelete = async (row) => {
    if (!isAdmin) return;
    const confirmed = await notify.confirm({
      title: 'Delete attendance row?',
      message: `This will permanently delete the attendance record for ${row.user?.name || 'this user'} on ${fmtDate(row.date)}. This cannot be undone.`,
      confirmText: 'Delete',
      destructive: true,
    });
    if (!confirmed) return;
    try {
      await fetchApi(`/api/attendance/${row.id}`, { method: 'DELETE' });
      notify.success('Attendance row deleted');
      setRows((rs) => rs.filter((r) => r.id !== row.id));
    } catch {
      // fetchApi auto-toasts
    }
  };

  if (!isManagerOrAdmin) {
    return (
      <div style={{ padding: 24 }}>
        <h1 style={{ margin: 0, marginBottom: 12, color: 'var(--text-primary)' }}>Attendance</h1>
        <p style={{ color: 'var(--text-secondary)' }}>
          The all-staff attendance dashboard is visible to administrators and managers.
          For your own attendance history, head to the standard Attendance page.
        </p>
      </div>
    );
  }

  // KPI shape from /summary
  const kpis = [
    { key: 'total', icon: ClipboardList, label: 'Total Logs', value: summary?.totalRows ?? '—' },
    { key: 'absent', icon: UserX, label: 'Absent', value: summary?.absent ?? '—' },
    { key: 'present', icon: UserCheck, label: 'Present', value: summary?.present ?? '—' },
    { key: 'early', icon: Sunrise, label: 'Early Arrival', value: summary?.early ?? '—', hint: 'Clocked in before (shift start − tolerance)' },
    { key: 'onTime', icon: Clock, label: 'On Time Arrival', value: summary?.onTime ?? '—', hint: 'Clocked in within ±tolerance of shift start' },
    { key: 'late', icon: Clock, label: 'Late Arrival', value: summary?.late ?? '—' },
    { key: 'earlyDep', icon: Sunset, label: 'Early Departure', value: summary?.earlyDeparture ?? '—', hint: 'Clocked out before (shift end − tolerance)' },
    { key: 'onTimeDep', icon: Sunset, label: 'On Time Departure', value: summary?.onTimeDeparture ?? '—', hint: 'Clocked out within ±tolerance of shift end' },
    { key: 'lateDep', icon: Sunset, label: 'Late Departure', value: summary?.lateDeparture ?? '—', hint: 'Clocked out after (shift end + tolerance)' },
  ];

  // Wellness route serves the calendar; for travel tenants we link there
  // until a travel-side calendar exists.
  const calendarPath = tenant?.vertical === 'travel'
    ? '/wellness/attendance/calendar'
    : '/wellness/attendance/calendar';

  return (
    <div style={{ padding: '1.5rem', maxWidth: 1600, margin: '0 auto' }}>
      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 12, marginBottom: 8 }}>
        <h1 style={{ margin: 0, display: 'flex', alignItems: 'center', gap: 8, color: 'var(--text-primary)' }}>
          <ClipboardList size={24} aria-hidden /> Attendance
        </h1>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, color: 'var(--text-secondary)' }}>
            <span>Period</span>
            <select
              value={period}
              onChange={(e) => setPeriod(e.target.value)}
              style={{ padding: '0.4rem 0.6rem', borderRadius: 6, border: '1px solid var(--border-color)', background: 'var(--input-bg)', color: 'var(--text-primary)' }}
            >
              {PERIOD_OPTIONS.map((p) => (
                <option key={p.value} value={p.value} style={{ background: 'var(--bg-color)', color: 'var(--text-primary)' }}>{p.label}</option>
              ))}
            </select>
          </label>
          <button
            type="button"
            onClick={load}
            aria-label="Refresh"
            style={{ padding: '0.4rem 0.6rem', borderRadius: 6, border: '1px solid var(--border-color)', background: 'transparent', cursor: 'pointer', color: 'var(--text-primary)', display: 'flex', alignItems: 'center', gap: 4 }}
          >
            <RefreshCw size={14} aria-hidden /> Refresh
          </button>
        </div>
      </div>
      <p style={{ marginTop: 4, color: 'var(--text-secondary)' }}>Business Performance</p>

      {/* KPI grid */}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 220px), 1fr))',
          gap: 12,
          marginBottom: 24,
        }}
      >
        {kpis.map((k) => (
          <KpiTile key={k.key} icon={k.icon} label={k.label} value={k.value} hint={k.hint} />
        ))}
      </div>

      {/* Attendance List */}
      <section
        style={{
          background: 'var(--surface-color)',
          border: '1px solid var(--border-color)',
          color: 'var(--text-primary)',
          borderRadius: 12, padding: '1rem 1.25rem',
        }}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 8, marginBottom: 12 }}>
          <h2 style={{ margin: 0, fontSize: 18, display: 'flex', alignItems: 'center', gap: 8, color: 'var(--text-primary)' }}>
            <ClipboardList size={18} aria-hidden /> Attendance List
          </h2>
          <Link
            to={calendarPath}
            style={{
              display: 'inline-flex', alignItems: 'center', gap: 6,
              padding: '0.4rem 0.9rem', borderRadius: 999,
              border: '1px solid var(--border-color)',
              color: 'var(--text-primary)', textDecoration: 'none', fontSize: 13,
            }}
          >
            <CalendarIcon size={14} aria-hidden /> Calendar View
          </Link>
        </div>

        {loading ? (
          <div style={{ padding: 24, color: 'var(--text-secondary)' }}>Loading…</div>
        ) : rows.length === 0 ? (
          <div style={{ padding: 24, color: 'var(--text-secondary)', textAlign: 'center' }}>
            No attendance rows for the selected period.
          </div>
        ) : (
          <TopScrollSync>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 14, color: 'var(--text-primary)' }}>
              <thead>
                <tr style={{ textAlign: 'left', color: 'var(--text-secondary)' }}>
                  <th style={th}>Employee Name</th>
                  <th style={th}>Date</th>
                  <th style={th}>Check-In</th>
                  <th style={th}>Check-Out</th>
                  <th style={th}>Check-In Type</th>
                  <th style={th}>Check-Out Type</th>
                  <th style={th}>Check-In Recorded Via</th>
                  <th style={th}>Check-Out Recorded Via</th>
                  <th style={th}>Absent</th>
                  <th style={th}>Notes</th>
                  {isAdmin ? <th style={th}>Actions</th> : null}
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id} style={{ borderTop: '1px solid var(--border-color)' }}>
                    <td style={td}>{r.user?.name || `User #${r.userId}`}</td>
                    <td style={td}>{fmtDate(r.date)}</td>
                    <td style={td}>{fmtTime(r.clockInAt)}</td>
                    <td style={td}>{fmtTime(r.clockOutAt)}</td>
                    <td style={td}><Pill text={fmtArrivalLabel(r.arrivalStatus)} /></td>
                    <td style={td}><Pill text={fmtDepartureLabel(r.departureStatus)} /></td>
                    <td style={td}>{r.checkInRecordedVia}</td>
                    <td style={td}>{r.checkOutRecordedVia}</td>
                    <td style={td}>
                      <AbsentPill absent={r.status === 'ABSENT'} />
                    </td>
                    <td style={{ ...td, maxWidth: 220, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                      {r.notes || 'N/A'}
                    </td>
                    {isAdmin ? (
                      <td style={td}>
                        <div style={{ display: 'flex', gap: 6 }}>
                          <button
                            type="button"
                            onClick={() => setEditRow(r)}
                            aria-label={`Edit attendance for ${r.user?.name || `user ${r.userId}`}`}
                            style={iconBtn}
                          >
                            <Edit2 size={14} aria-hidden />
                          </button>
                          <button
                            type="button"
                            onClick={() => onDelete(r)}
                            aria-label={`Delete attendance for ${r.user?.name || `user ${r.userId}`}`}
                            style={{ ...iconBtn, color: '#dc2626' }}
                          >
                            <Trash2 size={14} aria-hidden />
                          </button>
                        </div>
                      </td>
                    ) : null}
                  </tr>
                ))}
              </tbody>
            </table>
          </TopScrollSync>
        )}

        {summary?.policy ? (
          <div style={{ marginTop: 12, fontSize: 12, color: 'var(--text-secondary)' }}>
            Shift policy: {String(summary.policy.shiftStartHour).padStart(2, '0')}:{String(summary.policy.shiftStartMinute).padStart(2, '0')} → {String(summary.policy.shiftEndHour).padStart(2, '0')}:{String(summary.policy.shiftEndMinute).padStart(2, '0')} UTC, ±{summary.policy.onTimeToleranceMin} min tolerance.
          </div>
        ) : null}
      </section>

      {editRow ? (
        <EditAttendanceModal
          row={editRow}
          onClose={() => setEditRow(null)}
          onSaved={(updated) => {
            setRows((rs) => rs.map((r) => (r.id === updated.id ? { ...r, ...updated } : r)));
            setEditRow(null);
            load();
          }}
        />
      ) : null}
    </div>
  );
}

// ──────────────────────────────────────────────────────────────────
// Style atoms
// ──────────────────────────────────────────────────────────────────
const th = { padding: '0.6rem 0.5rem', fontWeight: 600, fontSize: 12, textTransform: 'uppercase', letterSpacing: 0.4, borderBottom: '1px solid var(--border-color)' };
const td = { padding: '0.6rem 0.5rem', verticalAlign: 'middle' };
const iconBtn = {
  background: 'transparent', border: '1px solid var(--border-color)',
  borderRadius: 6, padding: '0.3rem 0.5rem', cursor: 'pointer', color: 'inherit',
  display: 'inline-flex', alignItems: 'center',
};

function Pill({ text }) {
  if (text === 'N/A') {
    return <span style={{ color: 'var(--text-secondary)' }}>N/A</span>;
  }
  const colorMap = {
    'Early':    { bg: 'rgba(245,158,11,0.18)', fg: '#fbbf24' },
    'On Time':  { bg: 'rgba(16,185,129,0.18)', fg: '#34d399' },
    'Late':     { bg: 'rgba(220,38,38,0.18)',  fg: '#f87171' },
  };
  const c = colorMap[text] || { bg: 'rgba(100,116,139,0.18)', fg: '#cbd5e1' };
  return (
    <span style={{ background: c.bg, color: c.fg, padding: '2px 8px', borderRadius: 999, fontSize: 12, fontWeight: 600 }}>
      {text}
    </span>
  );
}

function AbsentPill({ absent }) {
  return (
    <span
      style={{
        background: absent ? 'rgba(220,38,38,0.18)' : 'rgba(16,185,129,0.18)',
        color: absent ? '#f87171' : '#34d399',
        padding: '2px 10px', borderRadius: 999, fontSize: 12, fontWeight: 600,
      }}
    >
      {absent ? 'Yes' : 'No'}
    </span>
  );
}
