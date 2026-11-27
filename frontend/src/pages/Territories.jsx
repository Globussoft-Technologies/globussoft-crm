import { useContext, useEffect, useMemo, useState } from 'react';
import { Network, Plus, Trash2, Edit2, X, Ban, Power, Info } from 'lucide-react';
import { fetchApi } from '../utils/api';
import { useNotify } from '../utils/notify';
import { AuthContext } from '../App';
import { TERRITORY_COUNTRIES, countryName, statesForCountry } from '../data/territoryGeo';
import SearchableSelect from '../components/ui/SearchableSelect';
import MultiSelectDropdown from '../components/MultiSelectDropdown';

export default function Territories() {
  const notify = useNotify();
  const { tenant, user } = useContext(AuthContext) || {};
  const isGeneric = (tenant?.vertical || user?.tenant?.vertical || user?.vertical || 'generic') === 'generic';
  const [territories, setTerritories] = useState([]);
  const [users, setUsers] = useState([]);
  const [teamAssignments, setTeamAssignments] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showModal, setShowModal] = useState(false);
  const [editing, setEditing] = useState(null);
  const [assignmentTarget, setAssignmentTarget] = useState(null);
  const [assignmentUserIds, setAssignmentUserIds] = useState([]);
  const [assignmentWarning, setAssignmentWarning] = useState('');
  const [savingAssignment, setSavingAssignment] = useState(false);
  const [toast, setToast] = useState(null);
  const [showHelp, setShowHelp] = useState(false);

  const [form, setForm] = useState({
    name: '',
    code: '',
    description: '',
    country: '',
    selectedStates: [],
    city: '',
    managerId: '',
    isActive: true,
    customState: '',
    regionsText: '',
    selectedUserIds: [],
  });

  const availableStates = useMemo(() => statesForCountry(form.country), [form.country]);
  const stateOptions = useMemo(() => {
    const knownCodes = new Set(availableStates.map(state => state.code));
    const customOptions = form.selectedStates
      .filter(code => !knownCodes.has(code))
      .map(code => ({ value: code, label: code }));
    return [...availableStates.map(state => ({ value: state.code, label: state.name })), ...customOptions];
  }, [availableStates, form.selectedStates]);
  const countryOptions = useMemo(() => TERRITORY_COUNTRIES.map(country => ({ value: country.code, label: country.name })), []);

  useEffect(() => {
    loadAll();
  }, []);

  const loadAll = async () => {
    setLoading(true);
    try {
      const [t, u, teams] = await Promise.all([
        fetchApi('/api/territories').catch(() => []),
        fetchApi('/api/staff').catch(() => []),
        fetchApi('/api/sales-teams').catch(() => []),
      ]);
      setTerritories(Array.isArray(t) ? t : []);
      setUsers(Array.isArray(u) ? u : []);
      setTeamAssignments(Array.isArray(teams) ? teams : []);
    } catch (e) {
      console.error(e);
    }
    setLoading(false);
  };

  const showToast = (msg, type = 'success') => {
    setToast({ msg, type });
    setTimeout(() => setToast(null), 3500);
  };

  const openNew = () => {
    setEditing(null);
    setForm({ name: '', code: '', description: '', country: '', selectedStates: [], city: '', managerId: '', isActive: true, customState: '', regionsText: '', selectedUserIds: [] });
    setShowModal(true);
  };

  const openEdit = (t) => {
    setEditing(t);
    setForm({
      name: t.name || '',
      code: t.code || '',
      description: t.description || '',
      country: t.country || '',
      selectedStates: Array.isArray(t.states) ? t.states : [],
      city: t.city || '',
      managerId: t.managerId ? String(t.managerId) : '',
      isActive: t.isActive !== false,
      customState: '',
      regionsText: Array.isArray(t.regions) ? t.regions.join(', ') : '',
      selectedUserIds: Array.isArray(t.assignedUserIds) ? t.assignedUserIds.map(Number) : [],
    });
    setShowModal(true);
  };

  const save = async () => {
    if (!form.name.trim()) { showToast('Name is required', 'error'); return; }
    if (isGeneric && !form.country) { showToast('Country is required', 'error'); return; }
    const payload = {
      name: form.name.trim(),
      ...(isGeneric ? {
        code: form.code.trim(),
        description: form.description.trim(),
        country: form.country,
        states: form.selectedStates,
        city: form.city.trim(),
        isActive: form.isActive,
        assignedUserIds: form.selectedUserIds,
      } : {}),
      regions: isGeneric
        ? form.selectedStates.map((state) => `${form.country}-${state}`)
        : form.regionsText.split(',').map(s => s.trim()).filter(Boolean),
      ...(!isGeneric ? { assignedUserIds: form.selectedUserIds } : {}),
    };
    try {
      if (editing) {
        await fetchApi(`/api/territories/${editing.id}`, { method: 'PUT', body: JSON.stringify(payload) });
        showToast('Territory updated');
      } else {
        await fetchApi('/api/territories', { method: 'POST', body: JSON.stringify(payload) });
        showToast('Territory created');
      }
      setShowModal(false);
      loadAll();
    } catch (e) {
      showToast(e.message || 'Save failed', 'error');
    }
  };

  const remove = async (t) => {
    if (!await notify.confirm(`Delete territory "${t.name}"? Contacts will be unassigned.`)) return;
    try {
      await fetchApi(`/api/territories/${t.id}`, { method: 'DELETE' });
      showToast('Territory deleted');
      loadAll();
    } catch (e) {
      showToast(e.message || 'Delete failed', 'error');
    }
  };

  const changeStatus = async (territory, isActive) => {
    try {
      await fetchApi(`/api/territories/${territory.id}`, {
        method: 'PUT',
        body: JSON.stringify({ isActive }),
      });
      setTerritories(current => current.map(t => t.id === territory.id ? { ...t, isActive } : t));
      showToast('Territory status updated');
    } catch (e) {
      showToast(e.message || 'Status update failed', 'error');
    }
  };

  const openAssignment = (territory) => {
    setAssignmentTarget(territory);
    setAssignmentUserIds(Array.isArray(territory.assignedUserIds) ? territory.assignedUserIds.map(Number) : []);
    setAssignmentWarning('');
  };

  const toggleAssignmentUser = (uid) => {
    setAssignmentUserIds((current) => {
      if (!current.includes(uid)) {
        setAssignmentWarning('');
        return [...current, uid];
      }
      const lockedByTeams = teamAssignments.flatMap((team) => {
        if (String(team.territoryId) !== String(assignmentTarget?.id) || team.territoryMode !== 'team') return [];
        return (team.members || [])
          .filter((member) => Number(member.userId || member.user?.id) === Number(uid))
          .map(() => team.name || 'a team');
      });
      if (lockedByTeams.length) {
        setAssignmentWarning(`Cannot remove this staff member. They are assigned through ${lockedByTeams.join(', ')}. Remove the team territory assignment first.`);
        return current;
      }
      setAssignmentWarning('');
      return current.filter((id) => id !== uid);
    });
  };

  const saveAssignment = async () => {
    if (!assignmentTarget) return;
    setSavingAssignment(true);
    try {
      await fetchApi(`/api/territories/${assignmentTarget.id}`, {
        method: 'PUT',
        body: JSON.stringify({ assignedUserIds: assignmentUserIds }),
      });
      // Re-fetch the list so the backend's contact rollup is recalculated
      // immediately after staff assignment changes.
      const refreshed = await fetchApi('/api/territories');
      setTerritories(Array.isArray(refreshed) ? refreshed : []);
      setAssignmentTarget(null);
      showToast('Staff assignment updated');
    } catch (e) {
      showToast(e.message || 'Assignment update failed', 'error');
    } finally {
      setSavingAssignment(false);
    }
  };

  const addCustomState = () => {
    const value = form.customState.trim();
    if (!value || form.selectedStates.includes(value)) return;
    setForm(current => ({ ...current, selectedStates: [...current.selectedStates, value], customState: '' }));
  };

  const userName = (id) => {
    const u = users.find(x => x.id === Number(id));
    return u ? (u.name || u.email || `User #${id}`) : `User #${id}`;
  };

  return (
    <div className="territories-page" style={{ padding: '2rem', animation: 'fadeIn 0.5s ease-out' }}>
      <header className="territories-header" style={{ marginBottom: '1.5rem', display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '1rem' }}>
        <div className="territories-header-main" style={{ display: 'flex', alignItems: 'center', gap: '0.85rem' }}>
          <div className="territories-header-icon" style={{
            width: 44, height: 44, borderRadius: 12,
            background: 'linear-gradient(135deg, #10b981, #06b6d4)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            boxShadow: '0 8px 20px rgba(16,185,129,0.3)',
          }}>
            <Network size={22} color="white" />
          </div>
          <div className="territories-header-copy">
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}><h1 style={{ fontSize: '2rem', fontWeight: 'bold', margin: 0 }}>Territories</h1><button type="button" aria-label="About Territories" title="About Territories" onClick={() => setShowHelp(true)} style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 20, height: 20, padding: 0, border: 0, background: 'transparent', color: 'var(--accent-color)', cursor: 'pointer' }}><Info size={16} /></button></div>
            <p style={{ color: 'var(--text-secondary)', marginTop: '0.25rem', margin: 0 }}>
              Define geographic territories and assign sales teams. Used by routing rules with assignType "territory".
            </p>
          </div>
        </div>
        <button onClick={openNew} className="btn-primary" style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
          <Plus size={16} /> Add Territory
        </button>
      </header>

      {toast && (
        <div style={{
          position: 'fixed', top: 90, right: 24, zIndex: 300,
          padding: '0.85rem 1.2rem', borderRadius: 10,
          background: toast.type === 'error' ? 'rgba(239,68,68,0.9)' : 'rgba(16,185,129,0.9)',
          color: 'white', fontWeight: 600,
          boxShadow: '0 8px 24px rgba(0,0,0,0.4)',
        }}>{toast.msg}</div>
      )}

      {loading ? (
        <div className="card" style={{ padding: '3rem', textAlign: 'center', color: 'var(--text-secondary)' }}>Loading territories...</div>
      ) : territories.length === 0 ? (
        <div className="card" style={{ padding: '3rem', textAlign: 'center' }}>
          <Network size={36} style={{ margin: '0 auto 1rem', opacity: 0.5 }} />
          <p style={{ marginBottom: '1rem', color: 'var(--text-secondary)' }}>No territories yet. Create one to start grouping leads geographically.</p>
          <button onClick={openNew} className="btn-primary"><Plus size={16} /> Create First Territory</button>
        </div>
      ) : (
        isGeneric ? (
          <div className="card territories-table-card" style={{ padding: 0, overflow: 'hidden' }}>
            <div style={{ overflowX: 'auto' }}>
              <table className="stable-table" style={{ width: '100%', minWidth: 1120, borderCollapse: 'collapse', tableLayout: 'fixed' }}>
                <colgroup>
                  <col style={{ width: 190 }} />
                  <col style={{ width: 120 }} />
                  <col style={{ width: 120 }} />
                  <col style={{ width: 230 }} />
                  <col style={{ width: 180 }} />
                  <col style={{ width: 90 }} />
                  <col style={{ width: 100 }} />
                  <col style={{ width: 120 }} />
                  <col style={{ width: 150 }} />
                  <col style={{ width: 150 }} />
                </colgroup>
                <thead>
                  <tr>
                    {['Territory name', 'Code', 'Country', 'States / regions', 'Staff with access', 'Leads', 'Status', 'Created on', 'Last updated', 'Actions'].map(label => (
                      <th key={label} style={{ padding: '0.75rem', textAlign: 'left', whiteSpace: 'nowrap', color: 'var(--text-secondary)', fontSize: '0.75rem', textTransform: 'uppercase' }}>{label}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {territories.map(t => {
                    const usersWithAccess = (t.assignedUserIds || []).map(userName);
                    const regions = t.regions || [];
                    const states = t.states || [];
                    return (
                      <tr key={t.id}>
                        <td style={{ padding: '0.75rem', fontWeight: 700, color: 'var(--accent-color)' }}>{t.name}</td>
                        <td style={{ padding: '0.75rem', color: 'var(--text-secondary)' }}>{t.code || '—'}</td>
                        <td style={{ padding: '0.75rem' }}>{t.country ? countryName(t.country) : '—'}</td>
                        <td style={{ padding: '0.75rem', whiteSpace: 'normal', overflowWrap: 'anywhere' }} title={[...regions, ...states].join(', ')}>
                          {regions.length ? regions.join(', ') : '—'}
                          {states.length > 0 && <div style={{ marginTop: 4, color: 'var(--text-secondary)', fontSize: '0.78rem' }}>States: {states.join(', ')}</div>}
                        </td>
                        <td style={{ padding: '0.75rem', whiteSpace: 'normal', overflowWrap: 'anywhere' }} title={usersWithAccess.join(', ')}>
                          <div>{usersWithAccess.length ? usersWithAccess.join(', ') : '—'}</div>
                          <button
                            type="button"
                            onClick={() => openAssignment(t)}
                            aria-label={`${usersWithAccess.length ? 'Manage' : 'Assign'} staff for ${t.name}`}
                            style={{ marginTop: 6, padding: '0.25rem 0.5rem', border: '1px solid var(--border-color)', borderRadius: 6, background: 'transparent', color: 'var(--accent-color)', cursor: 'pointer', fontSize: '0.75rem' }}
                          >
                            {usersWithAccess.length ? 'Manage staff' : 'Assign staff'}
                          </button>
                        </td>
                        <td style={{ padding: '0.75rem' }}>{t.contactCount || 0}</td>
                        <td style={{ padding: '0.75rem' }}>
                          <button
                            type="button"
                            aria-label={`${t.isActive === false ? 'Disabled' : 'Activate'} ${t.name}`}
                            onClick={() => changeStatus(t, t.isActive === false)}
                            style={{
                              display: 'inline-flex',
                              alignItems: 'center',
                              gap: 6,
                              padding: '0.5rem 0.75rem',
                              border: '1px solid transparent',
                              borderRadius: 8,
                              background: t.isActive === false ? '#fff0ee' : '#e6f8f2',
                              color: t.isActive === false ? '#d92d20' : '#087f5b',
                              font: 'inherit',
                              fontWeight: 600,
                              cursor: 'pointer',
                              whiteSpace: 'nowrap',
                            }}
                          >
                            {t.isActive === false ? <Ban size={15} /> : <Power size={15} />}
                            {t.isActive === false ? 'Disabled' : 'Activate'}
                          </button>
                        </td>
                        <td style={{ padding: '0.75rem', whiteSpace: 'nowrap' }}>{t.createdAt ? new Date(t.createdAt).toLocaleDateString() : '—'}</td>
                        <td style={{ padding: '0.75rem', whiteSpace: 'nowrap' }}>{t.updatedAt ? new Date(t.updatedAt).toLocaleDateString() : '—'}</td>
                        <td style={{ padding: '0.75rem' }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: '0.35rem' }}>
                            <button onClick={() => openEdit(t)} title="Edit" aria-label={`Edit ${t.name}`} style={{ background: 'transparent', border: 'none', color: 'var(--text-secondary)', cursor: 'pointer' }}><Edit2 size={15} /></button>
                            <button onClick={() => remove(t)} title="Delete" aria-label={`Delete ${t.name}`} style={{ background: 'transparent', border: 'none', color: '#ef4444', cursor: 'pointer' }}><Trash2 size={15} /></button>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(min(100%, 280px), 1fr))', gap: '1rem' }}>
          {territories.map(t => (
            <div key={t.id} className="card" style={{ padding: '1.25rem', display: 'flex', flexDirection: 'column', gap: '0.85rem' }}>
              <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between' }}>
                <h3 style={{ fontSize: '1.1rem', fontWeight: 700, margin: 0, lineHeight: 1.3 }}>{t.name}</h3>
                <div style={{ display: 'flex', gap: '0.35rem' }}>
                  <button onClick={() => openEdit(t)} title="Edit" style={{ background: 'transparent', border: 'none', color: 'var(--text-secondary)', cursor: 'pointer' }}><Edit2 size={15} /></button>
                  <button onClick={() => remove(t)} title="Delete" style={{ background: 'transparent', border: 'none', color: '#ef4444', cursor: 'pointer' }}><Trash2 size={15} /></button>
                </div>
              </div>

              <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
                <div style={{ flex: 1, minWidth: 80, background: 'rgba(16,185,129,0.1)', borderRadius: 8, padding: '0.6rem', border: '1px solid rgba(16,185,129,0.2)' }}>
                  <div style={{ fontSize: '0.7rem', color: 'var(--text-secondary)', textTransform: 'uppercase' }}>Regions</div>
                  <div style={{ fontWeight: 700, fontSize: '1.3rem', color: '#6ee7b7' }}>{t.regions?.length || 0}</div>
                </div>
                <div style={{ flex: 1, minWidth: 80, background: 'rgba(99,102,241,0.1)', borderRadius: 8, padding: '0.6rem', border: '1px solid rgba(99,102,241,0.2)' }}>
                  <div style={{ fontSize: '0.7rem', color: 'var(--text-secondary)', textTransform: 'uppercase' }}>Users</div>
                  <div style={{ fontWeight: 700, fontSize: '1.3rem', color: '#a5b4fc' }}>{t.assignedUserIds?.length || 0}</div>
                </div>
                <div style={{ flex: 1, minWidth: 80, background: 'rgba(236,72,153,0.1)', borderRadius: 8, padding: '0.6rem', border: '1px solid rgba(236,72,153,0.2)' }}>
                  <div style={{ fontSize: '0.7rem', color: 'var(--text-secondary)', textTransform: 'uppercase' }}>Leads</div>
                  <div style={{ fontWeight: 700, fontSize: '1.3rem', color: '#f9a8d4' }}>{t.contactCount || 0}</div>
                </div>
              </div>

              {t.regions?.length > 0 && (
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.3rem' }}>
                  {t.regions.slice(0, 4).map(r => (
                    <span key={r} style={{ fontSize: '0.7rem', background: 'rgba(255,255,255,0.05)', padding: '0.15rem 0.5rem', borderRadius: 8, color: 'var(--text-secondary)' }}>{r}</span>
                  ))}
                  {t.regions.length > 4 && <span style={{ fontSize: '0.7rem', color: 'var(--text-secondary)' }}>+{t.regions.length - 4} more</span>}
                </div>
              )}

            </div>
          ))}
        </div>
        )
      )}

      {showModal && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)', backdropFilter: 'blur(5px)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 200, padding: '1rem' }}>
          <div className="card territories-modal" style={{ boxSizing: 'border-box', padding: '1.75rem', width: '100%', maxWidth: 560, maxHeight: '90dvh', overflowY: 'auto', background: 'var(--modal-bg)', color: 'var(--text-primary)', backdropFilter: 'none', WebkitBackdropFilter: 'none' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1.25rem' }}>
              <h3 style={{ fontWeight: 'bold', fontSize: '1.2rem', margin: 0 }}>{editing ? 'Edit Territory' : 'New Territory'}</h3>
              <button onClick={() => setShowModal(false)} aria-label="Close territory dialog" title="Close" style={{ background: 'transparent', border: 'none', color: 'var(--text-secondary)', cursor: 'pointer' }}><X size={22} /></button>
            </div>

            <div style={{ marginBottom: '1rem' }}>
              <label style={{ fontSize: '0.78rem', color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Name</label>
              <input className="input-field" value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} placeholder="e.g. North America West" style={{ boxSizing: 'border-box', width: '100%', marginTop: 4 }} />
            </div>

            {isGeneric ? (
              <>
                <div style={{ marginBottom: '1rem' }}>
                  <div>
                    <label htmlFor="territory-code" style={{ fontSize: '0.78rem', color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Code</label>
                    <input id="territory-code" className="input-field" value={form.code} onChange={e => setForm({ ...form, code: e.target.value.toUpperCase() })} placeholder="SOUTH-001" style={{ boxSizing: 'border-box', width: '100%', marginTop: 4 }} />
                  </div>
                </div>
                <div style={{ marginBottom: '1rem' }}>
                  <label htmlFor="territory-description" style={{ fontSize: '0.78rem', color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Description</label>
                  <textarea id="territory-description" className="input-field" value={form.description} onChange={e => setForm({ ...form, description: e.target.value })} placeholder="Describe this territory" rows={3} style={{ boxSizing: 'border-box', width: '100%', marginTop: 4, resize: 'vertical' }} />
                </div>
                <div style={{ marginBottom: '1rem' }}>
                  <label htmlFor="territory-country" style={{ fontSize: '0.78rem', color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Country *</label>
                  <SearchableSelect
                    id="territory-country"
                    ariaLabel="Country"
                    value={form.country}
                    options={countryOptions}
                    placeholder="Select country"
                    searchPlaceholder="Search countries"
                    onChange={value => setForm({ ...form, country: value, selectedStates: [] })}
                    style={{ boxSizing: 'border-box', width: '100%', marginTop: 4 }}
                  />
                </div>
                <div style={{ marginBottom: '1rem' }}>
                  <div style={{ fontSize: '0.78rem', color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 6 }}>States / regions</div>
                  {!form.country ? <div style={{ color: 'var(--text-secondary)', fontSize: '0.85rem', padding: '0.75rem', border: '1px solid var(--border-color)', borderRadius: 8 }}>Select a country first.</div> : <MultiSelectDropdown options={stateOptions} selected={form.selectedStates} onChange={values => setForm({ ...form, selectedStates: values })} placeholder="Select states or regions" ariaLabel="States / regions" menuHeight={280} searchable />}
                  {form.country && availableStates.length === 0 && <div style={{ display: 'flex', gap: '0.5rem', marginTop: 6 }}><input className="input-field" value={form.customState} onChange={e => setForm({ ...form, customState: e.target.value })} onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); addCustomState(); } }} placeholder="Add state or region" style={{ flex: 1 }} /><button type="button" className="btn-secondary" onClick={addCustomState}>Add</button></div>}
                </div>
                <label style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: '0.85rem', marginBottom: '1rem', fontSize: '0.85rem' }}><input type="checkbox" checked={form.isActive} onChange={e => setForm({ ...form, isActive: e.target.checked })} />Active territory</label>
              </>
            ) : (
              <div style={{ marginBottom: '1rem' }}>
                <label style={{ fontSize: '0.78rem', color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Regions (comma-separated)</label>
                <input className="input-field" value={form.regionsText} onChange={e => setForm({ ...form, regionsText: e.target.value })} placeholder="US-CA, US-NY, US-WA" style={{ boxSizing: 'border-box', width: '100%', marginTop: 4 }} />
                <div style={{ fontSize: '0.72rem', color: 'var(--text-secondary)', marginTop: 4 }}>Matched against contact city/state/country (case-insensitive substring).</div>
              </div>
            )}

            {editing && <div style={{ display: 'flex', justifyContent: 'flex-start', marginTop: '0.25rem', marginBottom: '1rem' }}><button type="button" className="btn-secondary" onClick={() => { setShowModal(false); openAssignment(editing); }}>Manage staff</button></div>}
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '0.75rem' }}>
              <button onClick={() => setShowModal(false)} className="btn-secondary">Cancel</button>
              <button onClick={save} className="btn-primary">{editing ? 'Save Changes' : 'Create Territory'}</button>
            </div>
          </div>
        </div>
      )}

      {showHelp && (
        <div role="dialog" aria-modal="true" aria-labelledby="territories-help-title" style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.45)', backdropFilter: 'blur(3px)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 240, padding: '1rem' }}>
          <div className="card" style={{ boxSizing: 'border-box', width: '100%', maxWidth: 560, maxHeight: '85dvh', overflowY: 'auto', padding: '1.5rem', background: 'var(--modal-bg)', color: 'var(--text-primary)', backdropFilter: 'none' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, marginBottom: '1rem' }}><h2 id="territories-help-title" style={{ margin: 0, fontSize: '1.15rem' }}>About Territories</h2><button type="button" aria-label="Close Territories information" onClick={() => setShowHelp(false)} style={{ background: 'transparent', border: 0, color: 'var(--text-secondary)', cursor: 'pointer', fontSize: '1.25rem' }}>×</button></div>
            <div style={{ display: 'grid', gap: '0.9rem', fontSize: '0.88rem', lineHeight: 1.5 }}>
              <section><strong>What is a territory?</strong><div style={{ color: 'var(--text-secondary)', marginTop: 3 }}>A territory is an area, such as a country, state, or region.</div></section>
              <section><strong>What can I do here?</strong><div style={{ color: 'var(--text-secondary)', marginTop: 3 }}>Create areas, edit them, turn them on or off, and assign staff.</div></section>
              <section><strong>Staff</strong><div style={{ color: 'var(--text-secondary)', marginTop: 3 }}>Use Manage staff to choose which staff members can work in each territory.</div></section>
              <section><strong>Leads</strong><div style={{ color: 'var(--text-secondary)', marginTop: 3 }}>Leads can be sent to staff based on their territory. The Leads column shows how many leads are there.</div></section>
              <section><strong>Teams</strong><div style={{ color: 'var(--text-secondary)', marginTop: 3 }}>A team can share one territory. Staff assigned through that team cannot be removed here until the team assignment is changed.</div></section>
              <section><strong>Other pages</strong><div style={{ color: 'var(--text-secondary)', marginTop: 3 }}>Use Staff for individual access, Teams for shared access, and Leads to view the leads.</div></section>
            </div>
          </div>
        </div>
      )}

      {assignmentTarget && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)', backdropFilter: 'blur(5px)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 220, padding: '1rem' }}>
          <div className="card" style={{ boxSizing: 'border-box', padding: '1.5rem', width: '100%', maxWidth: 520, maxHeight: '85dvh', overflowY: 'auto', background: 'var(--modal-bg)', color: 'var(--text-primary)', backdropFilter: 'none' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1rem' }}>
              <div>
                <h3 style={{ fontWeight: 'bold', fontSize: '1.15rem', margin: 0 }}>Assign staff</h3>
                <div style={{ color: 'var(--text-secondary)', fontSize: '0.85rem', marginTop: 4 }}>{assignmentTarget.name}</div>
              </div>
              <button type="button" onClick={() => setAssignmentTarget(null)} aria-label="Close staff assignment dialog" style={{ background: 'transparent', border: 'none', color: 'var(--text-secondary)', cursor: 'pointer', fontSize: '1.25rem' }}>×</button>
            </div>
            {assignmentWarning && <div role="alert" style={{ marginBottom: '0.75rem', padding: '0.65rem 0.8rem', border: '1px solid #f2c36b', borderRadius: 8, background: '#fff8e6', color: '#8a5a00', fontSize: '0.82rem', lineHeight: 1.4 }}>{assignmentWarning}</div>}
            <div style={{ display: 'grid', gap: '0.45rem' }}>
              {users.length === 0 && <div style={{ color: 'var(--text-secondary)', padding: '1rem 0' }}>No staff available.</div>}
              {users.map((staffMember) => {
                const selected = assignmentUserIds.includes(Number(staffMember.id));
                const role = staffMember.primaryRole?.name || staffMember.primaryRole?.key || staffMember.role || 'Staff';
                return (
                  <button key={staffMember.id} type="button" onClick={() => toggleAssignmentUser(Number(staffMember.id))} aria-pressed={selected} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '1rem', width: '100%', padding: '0.7rem 0.8rem', borderRadius: 8, border: `1px solid ${selected ? 'rgba(99,102,241,0.6)' : 'var(--border-color)'}`, background: selected ? 'rgba(99,102,241,0.14)' : 'transparent', color: 'var(--text-primary)', textAlign: 'left', cursor: 'pointer' }}>
                    <span><span style={{ display: 'block', fontWeight: 600 }}>{staffMember.name || staffMember.email}</span><span style={{ display: 'block', color: 'var(--text-secondary)', fontSize: '0.78rem' }}>{staffMember.email}</span></span>
                    <span style={{ color: 'var(--text-secondary)', fontSize: '0.78rem', whiteSpace: 'nowrap' }}>{role}</span>
                  </button>
                );
              })}
            </div>
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '0.75rem', marginTop: '1.25rem' }}>
              <button type="button" onClick={() => setAssignmentTarget(null)} className="btn-secondary">Cancel</button>
              <button type="button" onClick={saveAssignment} className="btn-primary" disabled={savingAssignment}>{savingAssignment ? 'Saving…' : 'Save assignment'}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
