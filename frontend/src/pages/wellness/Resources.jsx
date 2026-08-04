import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Box, Plus, Pencil, Trash2 } from 'lucide-react';
import { fetchApi } from '../../utils/api';
import { useNotify } from '../../utils/notify';
import PageHeader from '../../components/PageHeader';

// Wave 11 Agent GG - admin Resource CRUD page. Resources are bookable rooms /
// machines / equipment surfaced in the Calendar's New Visit modal so a
// receptionist can pin a visit to "Laser Room 1" instead of leaving the
// resource dimension implicit. The booking-conflict gate at
// backend/lib/bookingAvailability.js raises RESOURCE_DOUBLE_BOOKED when
// a second visit lands in the same hour with the same resource.

const TYPES = ['ROOM', 'MACHINE', 'EQUIPMENT'];
const EMPTY_FORM = { name: '', type: 'ROOM', locationId: '', isActive: true };
const PAGE_SIZE = 12;

export default function Resources() {
  const notify = useNotify();
  const [resources, setResources] = useState([]);
  const [locations, setLocations] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showAdd, setShowAdd] = useState(false);
  const [editingId, setEditingId] = useState(null);
  const [form, setForm] = useState(EMPTY_FORM);
  const [saving, setSaving] = useState(false);
  const [hasMore, setHasMore] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const listRef = useRef(null);

  const load = useCallback(async ({ replace = true, offset = 0 } = {}) => {
    if (replace) {
      setLoading(true);
      setHasMore(true);
      if (listRef.current) listRef.current.scrollTop = 0;
    } else {
      setLoadingMore(true);
    }

    try {
      const q = new URLSearchParams();
      q.set('limit', String(PAGE_SIZE));
      if (offset > 0) q.set('offset', String(offset));

      const [r, l] = await Promise.all([
        fetchApi(`/api/wellness/resources?${q.toString()}`).catch(() => []),
        fetchApi('/api/wellness/locations').catch(() => []),
      ]);

      const rows = Array.isArray(r) ? r : [];
      const locs = Array.isArray(l) ? l : [];

      setResources((prev) => (replace ? rows : [...prev, ...rows]));
      setLocations(locs.length > 0 ? locs : []);
      setHasMore(rows.length === PAGE_SIZE);
    } catch (_err) {
      if (replace) setResources([]);
      setHasMore(false);
    } finally {
      setLoading(false);
      setLoadingMore(false);
    }
  }, []);

  useEffect(() => {
    load({ replace: true, offset: 0 });
  }, [load]);

  const filterRows = useCallback((rows) => rows, []);

  const resetForm = () => {
    setForm(EMPTY_FORM);
    setEditingId(null);
    setShowAdd(false);
  };

  const startEdit = (r) => {
    setEditingId(r.id);
    setForm({
      name: r.name || '',
      type: r.type || 'ROOM',
      locationId: r.locationId || '',
      isActive: r.isActive !== false,
    });
    setShowAdd(true);
  };

  const submit = async (e) => {
    e.preventDefault();
    setSaving(true);
    try {
      const body = {
        name: form.name,
        type: form.type,
        locationId: form.locationId ? parseInt(form.locationId, 10) : null,
        isActive: form.isActive,
      };
      if (editingId) {
        await fetchApi(`/api/wellness/resources/${editingId}`, { method: 'PUT', body: JSON.stringify(body) });
        notify.success(`Updated "${form.name}"`);
      } else {
        await fetchApi('/api/wellness/resources', { method: 'POST', body: JSON.stringify(body) });
        notify.success(`Created "${form.name}"`);
      }
      resetForm();
      load({ replace: true, offset: 0 });
    } catch (_err) { /* fetchApi already toasted */ } finally {
      setSaving(false);
    }
  };

  const remove = async (r) => {
    const ok = await notify.confirm({
      title: 'Delete resource',
      message: `Delete resource "${r.name}"? Existing visits will keep their slot but lose the resource pointer.`,
      confirmText: 'Delete',
      destructive: true,
    });
    if (!ok) return;
    try {
      await fetchApi(`/api/wellness/resources/${r.id}`, { method: 'DELETE' });
      notify.success(`Deleted "${r.name}"`);
      load({ replace: true, offset: 0 });
    } catch (_err) { /* fetchApi already toasted */ }
  };

  const onListScroll = useCallback((e) => {
    const el = e.currentTarget;
    if (loading || loadingMore || !hasMore) return;
    if (el.scrollTop + el.clientHeight >= el.scrollHeight - 120) {
      load({ replace: false, offset: resources.length });
    }
  }, [hasMore, load, loading, loadingMore, resources.length]);

  const visibleResources = useMemo(() => filterRows(resources), [filterRows, resources]);

  return (
    <div style={{ padding: '2rem', animation: 'fadeIn 0.5s ease-out' }}>
      <PageHeader
        icon={Box}
        title="Resources"
        count={visibleResources.length}
        description="Bookable rooms, machines, and equipment. The calendar guards against same-hour double-booking."
      >
        <button
          onClick={() => (showAdd ? resetForm() : setShowAdd(true))}
          style={{ display: 'flex', alignItems: 'center', gap: '0.3rem', padding: '0.5rem 1rem', background: 'var(--primary-color, var(--accent-color))', color: '#fff', border: 'none', borderRadius: 8, cursor: 'pointer' }}
        >
          <Plus size={16} /> {showAdd ? 'Cancel' : 'New resource'}
        </button>
      </PageHeader>

      {showAdd && (
        <form onSubmit={submit} className="glass" style={{ padding: '1.25rem', marginBottom: '1rem', display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 220px), 1fr))', gap: '0.5rem' }}>
          {editingId && (
            <div style={{ gridColumn: '1 / -1', fontSize: '0.85rem', color: 'var(--text-secondary)' }}>
              Editing <strong>{form.name}</strong>
            </div>
          )}
          <input placeholder="Name - e.g. Laser Room 1" required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} style={inputStyle} />
          <select value={form.type} onChange={(e) => setForm({ ...form, type: e.target.value })} style={inputStyle}>
            {TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
          </select>
          <select value={form.locationId} onChange={(e) => setForm({ ...form, locationId: e.target.value })} style={inputStyle}>
            <option value="">- tenant-wide (any clinic) -</option>
            {locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
          </select>
          <label style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', fontSize: '0.85rem' }}>
            <input type="checkbox" checked={form.isActive} onChange={(e) => setForm({ ...form, isActive: e.target.checked })} />
            Active (bookable in calendar)
          </label>
          <div style={{ gridColumn: '1 / -1', display: 'flex', justifyContent: 'flex-end', gap: '0.5rem' }}>
            <button type="button" onClick={resetForm} style={btnSecondary}>Cancel</button>
            <button type="submit" disabled={saving} style={btnPrimary}>{saving ? 'Saving...' : editingId ? 'Update' : 'Create'}</button>
          </div>
        </form>
      )}

      {loading ? (
        <div className="glass" style={{ padding: '2rem', textAlign: 'center', color: 'var(--text-secondary)' }}>Loading...</div>
      ) : visibleResources.length === 0 ? (
        <div className="glass" style={{ padding: '2rem', textAlign: 'center', color: 'var(--text-secondary)' }}>
          No resources yet. Add a treatment room or machine to surface it in the Calendar's booking modal.
        </div>
      ) : (
        <div className="glass" style={{ padding: '0.6rem', borderRadius: 18, border: '1px solid var(--border-color)', boxShadow: '0 14px 32px rgba(16, 24, 40, 0.08)' }}>
          <div style={{ background: 'var(--bg-color)', borderRadius: '14px 14px 0 0', boxShadow: '0 1px 0 var(--border-color)' }}>
            <table style={{ width: '100%', tableLayout: 'fixed', borderCollapse: 'collapse', fontSize: '0.72rem' }}>
              <colgroup>
                <col style={{ width: '30%' }} />
                <col style={{ width: '18%' }} />
                <col style={{ width: '24%' }} />
                <col style={{ width: '12%' }} />
                <col style={{ width: '16%' }} />
              </colgroup>
              <thead>
                <tr style={{ textAlign: 'left', color: 'var(--text-secondary)' }}>
                  <th style={{ ...th, borderRadius: '14px 0 0 0' }}>Name</th>
                  <th style={th}>Type</th>
                  <th style={th}>Location</th>
                  <th style={th}>Active</th>
                  <th style={{ ...th, borderRadius: '0 14px 0 0' }}></th>
                </tr>
              </thead>
            </table>
          </div>

          <div ref={listRef} onScroll={onListScroll} style={{ maxHeight: 'calc(100vh - 470px)', overflowY: 'auto', overflowX: 'hidden', paddingTop: '0.35rem' }}>
            <table style={{ width: '100%', tableLayout: 'fixed', borderCollapse: 'separate', borderSpacing: 0, fontSize: '0.85rem' }}>
              <colgroup>
                <col style={{ width: '30%' }} />
                <col style={{ width: '18%' }} />
                <col style={{ width: '24%' }} />
                <col style={{ width: '12%' }} />
                <col style={{ width: '16%' }} />
              </colgroup>
              <tbody>
                {visibleResources.map((r) => {
                  const loc = locations.find((l) => l.id === r.locationId);
                  return (
                    <tr key={r.id} style={{ borderTop: '1px solid rgba(255,255,255,0.06)' }}>
                      <td style={{ ...td, overflowWrap: 'anywhere' }}>{r.name}</td>
                      <td style={td}>{r.type}</td>
                      <td style={{ ...td, overflowWrap: 'anywhere' }}>
                        {loc ? loc.name : <span style={{ color: 'var(--text-secondary)' }}>tenant-wide</span>}
                      </td>
                      <td style={td}>{r.isActive ? 'Yes' : 'No'}</td>
                      <td style={{ ...td, textAlign: 'right' }}>
                        <div style={{ display: 'flex', flexWrap: 'wrap', justifyContent: 'flex-end', gap: '0.35rem' }}>
                          <button onClick={() => startEdit(r)} style={iconBtn} aria-label="Edit"><Pencil size={14} /></button>
                          <button onClick={() => remove(r)} style={iconBtn} aria-label="Delete"><Trash2 size={14} /></button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
                {loadingMore && (
                  <tr>
                    <td colSpan={5} style={{ padding: '0.9rem 0.5rem', textAlign: 'center', color: 'var(--text-secondary)', fontSize: '0.8rem' }}>
                      Loading more resources...
                    </td>
                  </tr>
                )}
                {!hasMore && visibleResources.length > 0 && (
                  <tr>
                    <td colSpan={5} style={{ padding: '0.9rem 0.5rem', textAlign: 'center', color: 'var(--text-secondary)', fontSize: '0.8rem' }}>
                      You have reached the end of the resources list.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}

const inputStyle = { padding: '0.55rem 0.7rem', borderRadius: 8, border: '1px solid var(--border-color, rgba(255,255,255,0.1))', background: 'transparent', color: 'var(--text-primary)', fontSize: '0.9rem' };
const btnPrimary = { padding: '0.55rem 1.25rem', background: 'var(--primary-color, var(--accent-color))', border: 'none', color: '#fff', borderRadius: 8, cursor: 'pointer', fontWeight: 600 };
const btnSecondary = { padding: '0.55rem 1.25rem', background: 'transparent', border: '1px solid var(--border-color, rgba(255,255,255,0.15))', color: 'var(--text-primary)', borderRadius: 8, cursor: 'pointer' };
const th = { textAlign: 'left', padding: '0.6rem 0.75rem', fontSize: '0.8rem', fontWeight: 600, color: 'var(--text-secondary)' };
const td = { padding: '0.6rem 0.75rem', fontSize: '0.85rem' };
const iconBtn = { background: 'transparent', border: 'none', cursor: 'pointer', color: 'var(--text-secondary)', padding: '0.3rem', marginLeft: '0.25rem' };
