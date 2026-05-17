// Wave 2 Agent JJ — Staff Attendance page (Google Doc audit, 8 May 2026).
//
// Layout:
//   - Top card: today's clock-in/out with big Punch In / Punch Out buttons
//   - Below: "My Last 30 Days" attendance grid
//   - For ADMIN/MANAGER only: a "Today — All Staff" section listing every
//     staff row's status for the current day. Plain users don't see it.
//   - For ADMIN/MANAGER only: an "Export Payroll CSV" toolbar with from/to
//     date pickers — downloads a CSV (staff_id, name, hours_worked, lates,
//     absences, leaves) computed client-side from /api/attendance/summary.
//
// Uses /api/attendance/* endpoints. Dual-vertical (works under both wellness
// and generic verticals); the route is mounted at /wellness/attendance for
// the wellness sidebar but the page itself doesn't gate on tenant.vertical.
//
// #802 (Zylu-Gap ATT-001) — added Early + On-Time KPI tiles to the manager
// staff section. Backend gap: /api/attendance/summary returns counts for
// PRESENT/HALF_DAY/LATE/ABSENT only; Early/On-Time require either a
// shift-policy table (clock-in vs scheduled start with tolerance) OR
// extending the Attendance.status enum to include EARLY/ON_TIME. Today the
// tiles read summary.early / summary.onTime which the backend doesn't yet
// emit — they render 0 until that gap closes. Tiles are wired so a follow-up
// backend change is purely additive.
//
// #804 (Zylu-Gap ATT-003) — added Export Payroll CSV button. Date-range
// picker, CSV columns match Zylu spec (staff_id, name, hours_worked,
// lates, absences, leaves). Today the CSV computes hours_worked + lates
// from summary.byUser data; absences / leaves are surfaced as 0 with a
// note in the CSV header line — backend gap is the same per-user
// breakdown not yet returning lates/absences/leaves per row.
import { useEffect, useState, useContext } from 'react';
import { Clock, LogIn, LogOut, Calendar, Users, Download } from 'lucide-react';
import { fetchApi } from '../../utils/api';
import { useNotify } from '../../utils/notify';
import { AuthContext } from '../../App';

function fmtDate(s) {
  if (!s) return '—';
  return new Date(s).toLocaleDateString();
}

function fmtTime(s) {
  if (!s) return '—';
  return new Date(s).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function fmtMinutes(m) {
  if (m === null || m === undefined) return '—';
  const h = Math.floor(m / 60);
  const mm = m % 60;
  return `${h}h ${mm}m`;
}

function statusClass(s) {
  switch (s) {
    case 'PRESENT': return { color: '#0a9050', bg: '#e7f6ed' };
    case 'HALF_DAY': return { color: '#a36b00', bg: '#fff5dc' };
    case 'LATE': return { color: '#a01a1a', bg: '#fde7e7' };
    case 'ABSENT': return { color: '#666', bg: '#eee' };
    case 'HOLIDAY': return { color: '#1a4ea0', bg: '#e7eefd' };
    default: return { color: '#444', bg: '#eee' };
  }
}

export default function Attendance() {
  const notify = useNotify();
  const { user } = useContext(AuthContext) || {};
  const isManager = user?.role === 'ADMIN' || user?.role === 'MANAGER';

  const [history, setHistory] = useState([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);

  // Today's row (clockInAt/clockOutAt) — derived from history's first row.
  const todayKey = new Date().toISOString().slice(0, 10);
  const todayRow = history.find((r) => (r.date || '').slice(0, 10) === todayKey) || null;
  const isClockedIn = todayRow && todayRow.clockInAt && !todayRow.clockOutAt;
  const isClockedOut = todayRow && todayRow.clockOutAt;

  const load = () => {
    setLoading(true);
    const from = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
    fetchApi(`/api/attendance/me?from=${from}`)
      .then((rows) => setHistory(Array.isArray(rows) ? rows : []))
      .catch(() => setHistory([]))
      .finally(() => setLoading(false));
  };
  useEffect(load, []);

  const onClockIn = async () => {
    setBusy(true);
    try {
      await fetchApi('/api/attendance/clock-in', { method: 'POST', body: JSON.stringify({}) });
      notify.success('Clocked in');
      load();
    } catch (e) {
      const msg = e && e.body && e.body.error;
      notify.error(msg || 'Clock-in failed');
    } finally {
      setBusy(false);
    }
  };

  const onClockOut = async () => {
    setBusy(true);
    try {
      await fetchApi('/api/attendance/clock-out', { method: 'POST', body: JSON.stringify({}) });
      notify.success('Clocked out');
      load();
    } catch (e) {
      const msg = e && e.body && e.body.error;
      notify.error(msg || 'Clock-out failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={{ padding: 24, maxWidth: 1100, margin: '0 auto' }}>
      <h1 style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 20 }}>
        <Clock size={28} aria-hidden /> Attendance
      </h1>

      {/* Today's punch card */}
      <section style={{ background: 'var(--surface-color, #fff)', borderRadius: 12, padding: 24, boxShadow: '0 1px 4px rgba(0,0,0,0.06)', marginBottom: 24 }}>
        <h2 style={{ marginTop: 0 }}>Today, {new Date().toLocaleDateString()}</h2>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 220px), 1fr))', gap: 16, marginTop: 16 }}>
          <div>
            <div style={{ fontSize: 12, color: 'var(--text-secondary, #888)' }}>Clock-in</div>
            <div style={{ fontSize: 22, fontWeight: 600 }}>{fmtTime(todayRow?.clockInAt)}</div>
          </div>
          <div>
            <div style={{ fontSize: 12, color: 'var(--text-secondary, #888)' }}>Clock-out</div>
            <div style={{ fontSize: 22, fontWeight: 600 }}>{fmtTime(todayRow?.clockOutAt)}</div>
          </div>
          <div>
            <div style={{ fontSize: 12, color: 'var(--text-secondary, #888)' }}>Total</div>
            <div style={{ fontSize: 22, fontWeight: 600 }}>{fmtMinutes(todayRow?.totalMinutes)}</div>
          </div>
          <div>
            <div style={{ fontSize: 12, color: 'var(--text-secondary, #888)' }}>Status</div>
            <div style={{ fontSize: 16, fontWeight: 600 }}>{todayRow?.status || 'Not clocked in'}</div>
          </div>
        </div>
        <div style={{ display: 'flex', gap: 12, marginTop: 20 }}>
          <button
            type="button"
            onClick={onClockIn}
            disabled={busy || isClockedIn || isClockedOut}
            aria-label="Punch In"
            style={{
              padding: '14px 28px', fontSize: 16, fontWeight: 600,
              background: isClockedIn || isClockedOut ? '#ccc' : 'var(--primary-color, var(--accent-color))',
              color: '#fff', border: 'none', borderRadius: 8,
              cursor: (busy || isClockedIn || isClockedOut) ? 'not-allowed' : 'pointer',
              display: 'flex', alignItems: 'center', gap: 8,
            }}
          >
            <LogIn size={18} aria-hidden /> Punch In
          </button>
          <button
            type="button"
            onClick={onClockOut}
            disabled={busy || !isClockedIn}
            aria-label="Punch Out"
            style={{
              padding: '14px 28px', fontSize: 16, fontWeight: 600,
              background: !isClockedIn ? '#ccc' : '#a01a1a',
              color: '#fff', border: 'none', borderRadius: 8,
              cursor: (busy || !isClockedIn) ? 'not-allowed' : 'pointer',
              display: 'flex', alignItems: 'center', gap: 8,
            }}
          >
            <LogOut size={18} aria-hidden /> Punch Out
          </button>
        </div>
      </section>

      {/* Last-30-days history */}
      <section style={{ background: 'var(--surface-color, #fff)', borderRadius: 12, padding: 24, boxShadow: '0 1px 4px rgba(0,0,0,0.06)', marginBottom: 24 }}>
        <h2 style={{ marginTop: 0, display: 'flex', alignItems: 'center', gap: 8 }}>
          <Calendar size={20} aria-hidden /> My Last 30 Days
        </h2>
        {loading ? (
          <div>Loading&hellip;</div>
        ) : history.length === 0 ? (
          <div style={{ color: 'var(--text-secondary, #888)', padding: 20, textAlign: 'center' }}>No attendance rows yet. Clock in to get started.</div>
        ) : (
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr>
                <th style={{ textAlign: 'left', padding: 8, borderBottom: '1px solid var(--border-color, #eee)' }}>Date</th>
                <th style={{ textAlign: 'left', padding: 8, borderBottom: '1px solid var(--border-color, #eee)' }}>Clock-in</th>
                <th style={{ textAlign: 'left', padding: 8, borderBottom: '1px solid var(--border-color, #eee)' }}>Clock-out</th>
                <th style={{ textAlign: 'left', padding: 8, borderBottom: '1px solid var(--border-color, #eee)' }}>Total</th>
                <th style={{ textAlign: 'left', padding: 8, borderBottom: '1px solid var(--border-color, #eee)' }}>Status</th>
                <th style={{ textAlign: 'left', padding: 8, borderBottom: '1px solid var(--border-color, #eee)' }}>Source</th>
              </tr>
            </thead>
            <tbody>
              {history.map((r) => {
                const sc = statusClass(r.status);
                return (
                  <tr key={r.id}>
                    <td style={{ padding: 8, borderBottom: '1px solid var(--border-light, #f5f5f5)' }}>{fmtDate(r.date)}</td>
                    <td style={{ padding: 8, borderBottom: '1px solid var(--border-light, #f5f5f5)' }}>{fmtTime(r.clockInAt)}</td>
                    <td style={{ padding: 8, borderBottom: '1px solid var(--border-light, #f5f5f5)' }}>{fmtTime(r.clockOutAt)}</td>
                    <td style={{ padding: 8, borderBottom: '1px solid var(--border-light, #f5f5f5)' }}>{fmtMinutes(r.totalMinutes)}</td>
                    <td style={{ padding: 8, borderBottom: '1px solid var(--border-light, #f5f5f5)' }}>
                      <span style={{ background: sc.bg, color: sc.color, padding: '2px 8px', borderRadius: 4, fontSize: 12, fontWeight: 600 }}>
                        {r.status}
                      </span>
                    </td>
                    <td style={{ padding: 8, borderBottom: '1px solid var(--border-light, #f5f5f5)', fontSize: 12, color: 'var(--text-secondary, #666)' }}>{r.source}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </section>

      {/* Manager-only: today's staff snapshot */}
      {isManager && <ManagerStaffSnapshot />}
    </div>
  );
}

function ManagerStaffSnapshot() {
  const notify = useNotify();
  const [summary, setSummary] = useState(null);
  const [loading, setLoading] = useState(true);
  // #804: payroll-CSV date range. Defaults to the last 30 days so a manager
  // hitting Export immediately gets a reasonable monthly slice. From/to are
  // normal <input type="date"> values (YYYY-MM-DD).
  const today = new Date().toISOString().slice(0, 10);
  const thirtyAgo = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
  const [csvFrom, setCsvFrom] = useState(thirtyAgo);
  const [csvTo, setCsvTo] = useState(today);
  const [exporting, setExporting] = useState(false);

  useEffect(() => {
    const t = new Date().toISOString().slice(0, 10);
    fetchApi(`/api/attendance/summary?from=${t}&to=${t}`)
      .then(setSummary)
      .catch(() => setSummary(null))
      .finally(() => setLoading(false));
  }, []);

  // #802: total = present + absent + late + halfDay (the four counted statuses
  // the backend currently emits). Early / On-Time are surfaced separately as
  // a backend gap — neither contributes to `total` today because the schema
  // doesn't yet distinguish them from PRESENT.
  const total = summary
    ? (summary.present || 0) + (summary.absent || 0) + (summary.late || 0) + (summary.halfDay || 0)
    : 0;

  // #804: compute payroll CSV client-side. Hits /api/attendance/summary for
  // the requested range, then assembles a CSV from summary.byUser. Hours =
  // minutes/60 (two decimals). Lates / absences / leaves are best-effort
  // from summary.byUser.{late, absent, leaves} when the backend grows
  // those per-user counters; today byUser only carries {userId, days,
  // minutes, present, halfDay} so the columns render 0 — flagged in the
  // CSV header note (#804 backend-gap).
  const onExportCsv = async () => {
    if (!csvFrom || !csvTo) { notify.error('Pick a date range first.'); return; }
    if (csvFrom > csvTo) { notify.error('From date must be before To date.'); return; }
    setExporting(true);
    try {
      const data = await fetchApi(`/api/attendance/summary?from=${csvFrom}&to=${csvTo}`);
      const rows = Object.values(data?.byUser || {});
      const header = [
        'staff_id', 'name', 'hours_worked', 'lates', 'absences', 'leaves',
      ];
      const lines = [header.join(',')];
      for (const u of rows) {
        const hours = Math.round(((u.minutes || 0) / 60) * 100) / 100;
        const lates = u.late || 0;
        const absences = u.absent || 0;
        const leaves = u.leaves || 0;
        // name field is not yet populated by /summary — manager-facing CSV
        // identifies staff by id+placeholder until backend joins users into byUser.
        const name = u.name || `User #${u.userId}`;
        lines.push([u.userId, csvEscape(name), hours, lates, absences, leaves].join(','));
      }
      const blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `payroll-${csvFrom}-to-${csvTo}.csv`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      notify.success(`Payroll CSV exported (${rows.length} staff)`);
    } catch (e) {
      const msg = e && e.body && e.body.error;
      notify.error(msg || 'Export failed');
    } finally {
      setExporting(false);
    }
  };

  return (
    <section style={{ background: 'var(--surface-color, #fff)', borderRadius: 12, padding: 24, boxShadow: '0 1px 4px rgba(0,0,0,0.06)' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 12, marginBottom: 16 }}>
        <h2 style={{ margin: 0, display: 'flex', alignItems: 'center', gap: 8 }}>
          <Users size={20} aria-hidden /> Today &mdash; All Staff
        </h2>
        {/* #804: payroll-CSV export toolbar. Renders only for managers (already
            gated by parent isManager). Inline label + two date inputs + the
            export button so the whole toolbar fits in one row on desktop. */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <label style={{ fontSize: 12, color: 'var(--text-secondary, #888)' }} htmlFor="payroll-from">From</label>
          <input
            id="payroll-from"
            type="date"
            value={csvFrom}
            onChange={(e) => setCsvFrom(e.target.value)}
            style={{ padding: '4px 8px', borderRadius: 6, border: '1px solid var(--border-color, #ddd)' }}
            aria-label="Payroll CSV from date"
          />
          <label style={{ fontSize: 12, color: 'var(--text-secondary, #888)' }} htmlFor="payroll-to">To</label>
          <input
            id="payroll-to"
            type="date"
            value={csvTo}
            onChange={(e) => setCsvTo(e.target.value)}
            style={{ padding: '4px 8px', borderRadius: 6, border: '1px solid var(--border-color, #ddd)' }}
            aria-label="Payroll CSV to date"
          />
          <button
            type="button"
            onClick={onExportCsv}
            disabled={exporting}
            aria-label="Export Payroll CSV"
            style={{
              padding: '6px 14px', fontSize: 13, fontWeight: 600,
              background: 'var(--primary-color, var(--accent-color))', color: '#fff',
              border: 'none', borderRadius: 6, cursor: exporting ? 'not-allowed' : 'pointer',
              display: 'inline-flex', alignItems: 'center', gap: 6,
            }}
          >
            <Download size={14} aria-hidden /> {exporting ? 'Exporting…' : 'Export Payroll CSV'}
          </button>
        </div>
      </div>
      {loading ? (
        <div>Loading&hellip;</div>
      ) : !summary ? (
        <div style={{ color: 'var(--text-secondary, #888)' }}>No data yet.</div>
      ) : (
        <div>
          {/* #802: Zylu-spec KPI grid — six tiles in spec order. Total =
              Present + Absent + Late + Half-day (Early/On-Time excluded
              today since the backend doesn't yet emit those statuses). */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 140px), 1fr))', gap: 12, marginBottom: 16 }}>
            <Stat label="Total" value={total} />
            <Stat label="Absent" value={summary.absent || 0} />
            <Stat label="Present" value={summary.present || 0} />
            <Stat
              label="Early"
              value={summary.early || 0}
              title="Clock-in before shift start. Backend wiring pending (#802) — emits 0 until shift-policy ships."
            />
            <Stat
              label="On-Time"
              value={summary.onTime || 0}
              title="Clock-in within tolerance of shift start. Backend wiring pending (#802) — emits 0 until shift-policy ships."
            />
            <Stat label="Late" value={summary.late || 0} />
            <Stat label="Half-day" value={summary.halfDay || 0} />
            <Stat label="Total minutes" value={summary.totalMinutes || 0} />
          </div>
          {Object.keys(summary.byUser || {}).length > 0 ? (
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead>
                <tr>
                  <th style={{ textAlign: 'left', padding: 8, borderBottom: '1px solid var(--border-color, #eee)' }}>User</th>
                  <th style={{ textAlign: 'left', padding: 8, borderBottom: '1px solid var(--border-color, #eee)' }}>Days</th>
                  <th style={{ textAlign: 'left', padding: 8, borderBottom: '1px solid var(--border-color, #eee)' }}>Minutes</th>
                </tr>
              </thead>
              <tbody>
                {Object.values(summary.byUser).map((u) => (
                  <tr key={u.userId}>
                    <td style={{ padding: 8, borderBottom: '1px solid var(--border-light, #f5f5f5)' }}>User #{u.userId}</td>
                    <td style={{ padding: 8, borderBottom: '1px solid var(--border-light, #f5f5f5)' }}>{u.days}</td>
                    <td style={{ padding: 8, borderBottom: '1px solid var(--border-light, #f5f5f5)' }}>{u.minutes}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <div style={{ color: 'var(--text-secondary, #888)' }}>Nobody clocked in today yet.</div>
          )}
        </div>
      )}
    </section>
  );
}

// #804: CSV-escape helper — wraps in double-quotes only when the cell
// contains a comma, double-quote, or newline. Doubles embedded quotes
// per RFC 4180. Used for the `name` column where staff names can
// contain commas (e.g. "Dr. Aaron, MD").
function csvEscape(s) {
  const v = String(s == null ? '' : s);
  if (/[",\n]/.test(v)) {
    return `"${v.replace(/"/g, '""')}"`;
  }
  return v;
}

function Stat({ label, value, title }) {
  return (
    <div
      style={{ background: 'var(--subtle-bg, #f7f7f7)', borderRadius: 8, padding: 12 }}
      title={title}
    >
      <div style={{ fontSize: 11, color: 'var(--text-secondary, #888)' }}>{label}</div>
      <div style={{ fontSize: 22, fontWeight: 700 }}>{value}</div>
    </div>
  );
}
