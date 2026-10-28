import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { BriefcaseBusiness, Check, Receipt, Search, Truck, UsersRound } from 'lucide-react';
import { fetchApi } from '../utils/api';
import { useNotify } from '../utils/notify';

const WORK_TYPES = [
  { key: 'transport', label: 'Transport', description: 'Pickup and drop-off trips', icon: Truck, color: '#2563eb' },
  { key: 'broker', label: 'Site Visits', description: 'Customer visits and plot selection', icon: UsersRound, color: '#7c3aed' },
  { key: 'billing', label: 'Billing', description: 'Invoices, payments, and booking completion', icon: Receipt, color: '#059669' },
];

function sameTypes(left = [], right = []) {
  return [...left].sort().join('|') === [...right].sort().join('|');
}

function WorkTypeCheckbox({ work, person, checked, onChange }) {
  const Icon = work.icon;
  return (
    <label style={{ display: 'flex', gap: 10, alignItems: 'flex-start', minWidth: 0, padding: 12, border: `1px solid ${checked ? work.color : 'var(--border-color)'}`, borderRadius: 10, background: checked ? `${work.color}10` : 'transparent', cursor: 'pointer' }}>
      <input
        type="checkbox"
        aria-label={`${work.label} for ${person.name}`}
        checked={checked}
        onChange={onChange}
        style={{ marginTop: 3, accentColor: work.color }}
      />
      <span style={{ minWidth: 0 }}>
        <span style={{ display: 'flex', alignItems: 'center', gap: 6, color: checked ? work.color : 'inherit', fontWeight: 800 }}>
          <Icon size={16} aria-hidden="true" /> {work.label}
        </span>
        <span style={{ display: 'block', marginTop: 4, color: 'var(--text-secondary)', fontSize: '.72rem', lineHeight: 1.35 }}>{work.description}</span>
      </span>
    </label>
  );
}

export default function PickupPlotWorkAssignments() {
  const notify = useNotify();
  const [staff, setStaff] = useState([]);
  const [drafts, setDrafts] = useState({});
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const loadedRef = useRef(false);
  const [loadError, setLoadError] = useState('');
  const [savingId, setSavingId] = useState(null);

  const load = useCallback(async () => {
    const initialLoad = !loadedRef.current;
    if (initialLoad) setLoading(true);
    else setRefreshing(true);
    setLoadError('');
    try {
      const response = await fetchApi('/api/pickup-plot-inventory/work-assignments');
      const rows = Array.isArray(response?.staff) ? response.staff : [];
      setStaff(rows);
      setDrafts(Object.fromEntries(rows.map((person) => [person.id, person.workTypes || []])));
    } catch (error) {
      const message = error.message || 'Could not load staff work assignments.';
      setLoadError(message);
      notify.error(message);
    } finally {
      loadedRef.current = true;
      setLoading(false);
      setRefreshing(false);
    }
  }, [notify]);

  useEffect(() => { load(); }, [load]);

  const toggleType = (userId, type) => {
    setDrafts((current) => {
      const selected = current[userId] || [];
      return {
        ...current,
        [userId]: selected.includes(type)
          ? selected.filter((value) => value !== type)
          : [...selected, type],
      };
    });
  };

  const save = async (person) => {
    setSavingId(person.id);
    try {
      const workTypes = drafts[person.id] || [];
      await fetchApi('/api/pickup-plot-inventory/work-assignments', {
        method: 'PUT',
        body: JSON.stringify({ targetUserId: person.id, workTypes }),
      });
      setStaff((rows) => rows.map((row) => (
        row.id === person.id ? { ...row, workTypes: [...workTypes] } : row
      )));
      notify.success(`Work assignments updated for ${person.name}.`);
    } catch (error) {
      notify.error(error.message || 'Could not update work assignments.');
    } finally {
      setSavingId(null);
    }
  };

  const visibleStaff = useMemo(() => {
    const needle = search.trim().toLowerCase();
    if (!needle) return staff;
    return staff.filter((person) => [person.name, person.email, person.phone]
      .some((value) => String(value || '').toLowerCase().includes(needle)));
  }, [search, staff]);

  const assignedCount = staff.filter((person) => (person.workTypes || []).length > 0).length;
  const headerCellStyle = {
    position: 'sticky', top: 0, zIndex: 2, padding: '13px 14px',
    borderBottom: '1px solid var(--border-color)', background: 'var(--popover-bg)',
    color: 'var(--text-secondary)', fontSize: '.76rem', textAlign: 'left',
    textTransform: 'uppercase', letterSpacing: '.04em',
  };

  return (
    <main data-testid="staff-work-assignment-page" style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0, overflow: 'hidden', padding: '2rem', boxSizing: 'border-box' }}>
      <header style={{ flex: '0 0 auto', display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: 18, marginBottom: 24 }}>
        <div style={{ minWidth: 0 }}>
          <h1 style={{ margin: 0, display: 'flex', alignItems: 'center', gap: 10 }}>
            <BriefcaseBusiness size={28} aria-hidden="true" /> Staff Work Assignment
          </h1>
          <p style={{ margin: '7px 0 0', maxWidth: 720, color: 'var(--text-secondary)' }}>
            Give staff Transport, Site Visit, or Billing work—one at a time or in any combination.
          </p>
        </div>
        <div
          data-testid="staff-work-assignment-header-actions"
          style={{ display: 'flex', flex: '1 1 100%', alignItems: 'center', justifyContent: 'flex-start', flexWrap: 'wrap', gap: 12 }}
        >
          <div className="pickup-plot-work-search-wrap" style={{ display: 'flex', alignItems: 'center', gap: 6, flex: '1 1 280px', maxWidth: 420, minWidth: 220, padding: '0 10px', border: '1px solid var(--border-color)', borderRadius: 10, background: 'var(--input-bg)' }}>
            <Search
              size={17}
              aria-hidden="true"
              style={{ flex: '0 0 17px', color: 'var(--text-secondary)', pointerEvents: 'none' }}
            />
            <input
              className="input-field pickup-plot-work-search"
              type="search"
              aria-label="Search staff"
              placeholder="Search by name, email, or phone…"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              style={{ width: '100%', height: 42, boxSizing: 'border-box', padding: '0 4px', border: 0, outline: 0, background: 'transparent' }}
            />
          </div>
          <div
            className="card"
            data-testid="staff-work-assignment-count"
            style={{ display: 'flex', alignItems: 'center', gap: 10, height: 44, minWidth: 170, padding: '0 16px', boxSizing: 'border-box' }}
          >
            <strong style={{ flex: '0 0 auto', fontSize: '1.15rem', lineHeight: 1 }}>{assignedCount}</strong>
            <span style={{ color: 'var(--text-secondary)', fontSize: '.76rem', lineHeight: 1.2, whiteSpace: 'nowrap' }}>staff with assigned work</span>
          </div>
        </div>
      </header>

      <div
          className="card pickup-plot-table-scroll"
          data-testid="staff-work-assignment-table-scroll"
          style={{ flex: '1 1 0', minHeight: 0, width: '100%', maxWidth: '100%', overflow: 'auto', padding: 0, boxSizing: 'border-box', scrollbarGutter: 'stable', overscrollBehavior: 'contain' }}
        >
          {refreshing && <div className="pickup-module-refresh-status" role="status">Refreshing data…</div>}
          <table className="pickup-plot-leads-table pickup-plot-no-row-hover" aria-label="Staff work assignments" style={{ width: '100%', minWidth: 1180, tableLayout: 'fixed', borderCollapse: 'collapse' }}>
            <colgroup>
              <col style={{ width: '22%' }} />
              <col style={{ width: '22%' }} />
              <col style={{ width: '22%' }} />
              <col style={{ width: '22%' }} />
              <col style={{ width: '12%' }} />
            </colgroup>
            <thead>
              <tr>
                {['Staff', 'Transport', 'Site Visits', 'Billing', 'Action'].map((label) => (
                  <th key={label} scope="col" style={headerCellStyle}>{label}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {visibleStaff.map((person) => {
                const selected = drafts[person.id] || [];
                const changed = !sameTypes(selected, person.workTypes);
                return (
                  <tr key={person.id} aria-label={`Work assignment for ${person.name}`} style={{ borderBottom: '1px solid var(--border-color)' }}>
                    <td style={{ padding: 14, verticalAlign: 'middle', minWidth: 0 }}>
                      <strong style={{ display: 'block', overflowWrap: 'anywhere' }}>{person.name}</strong>
                      <span style={{ display: 'block', marginTop: 7, color: 'var(--text-secondary)', fontSize: '.78rem', overflowWrap: 'anywhere' }}>{person.email}</span>
                    </td>
                    {WORK_TYPES.map((work) => (
                      <td key={work.key} style={{ padding: '10px 7px', verticalAlign: 'middle' }}>
                        <WorkTypeCheckbox
                          work={work}
                          person={person}
                          checked={selected.includes(work.key)}
                          onChange={() => toggleType(person.id, work.key)}
                        />
                      </td>
                    ))}
                    <td style={{ padding: 14, verticalAlign: 'middle', textAlign: 'right' }}>
                      <button
                        type="button"
                        className={changed ? 'btn-primary' : 'btn-secondary'}
                        disabled={!changed || savingId === person.id}
                        onClick={() => save(person)}
                        style={{ width: '100%', minWidth: 88, minHeight: 42, display: 'inline-flex', justifyContent: 'center', alignItems: 'center', gap: 7 }}
                      >
                        {savingId === person.id ? 'Saving…' : <><Check size={16} aria-hidden="true" /> Save</>}
                      </button>
                    </td>
                  </tr>
                );
              })}
              {loading && !loadedRef.current && (
                <tr><td colSpan="5" style={{ padding: 48, textAlign: 'center', color: 'var(--text-secondary)' }}>Loading staff…</td></tr>
              )}
              {!loading && visibleStaff.length === 0 && (
                <tr>
                  <td colSpan="5" style={{ padding: 48, textAlign: 'center', color: 'var(--text-secondary)' }}>
                    {loadError ? (
                      <>
                        <div>{loadError}</div>
                        <button type="button" className="btn-secondary" onClick={load} style={{ marginTop: 12 }}>Retry</button>
                      </>
                    ) : search.trim()
                      ? 'No staff members match your search.'
                      : 'No active staff accounts are available.'}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
    </main>
  );
}
