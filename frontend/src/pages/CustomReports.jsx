import React, { useState, useEffect } from 'react';
import {
  BarChart3, Plus, Save, Play, Trash2, X, Edit2, Filter
} from 'lucide-react';
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
  PieChart, Pie, Cell, LineChart, Line, Legend
} from 'recharts';
import { fetchApi } from '../utils/api';
import { useNotify } from '../utils/notify';

const COLORS = ['#3b82f6', '#a855f7', '#10b981', '#f59e0b', '#ef4444', '#ec4899', '#6366f1', '#14b8a6'];

const ENTITY_FIELDS = {
  Deal: ['title', 'amount', 'stage', 'probability', 'expectedClose', 'ownerId', 'createdAt'],
  Contact: ['name', 'email', 'status', 'source', 'aiScore', 'createdAt'],
  Invoice: ['amount', 'status', 'dueDate', 'createdAt'],
  Activity: ['type', 'description', 'createdAt'],
  Task: ['title', 'status', 'priority', 'dueDate'],
};

const OPS = [
  { value: 'eq', label: '=' },
  { value: 'neq', label: '≠' },
  { value: 'gt', label: '>' },
  { value: 'gte', label: '≥' },
  { value: 'lt', label: '<' },
  { value: 'lte', label: '≤' },
  { value: 'contains', label: 'contains' },
];

const CHART_TYPES = [
  { value: 'table', label: 'Table' },
  { value: 'bar', label: 'Bar' },
  { value: 'pie', label: 'Pie' },
  { value: 'line', label: 'Line' },
];

const AGG_TYPES = [
  { value: 'count', label: 'Count' },
  { value: 'sum', label: 'Sum' },
  { value: 'avg', label: 'Average' },
];

const defaultConfig = () => ({
  entity: 'Deal',
  filters: [],
  columns: ['title', 'amount', 'stage'],
  groupBy: '',
  aggregate: { type: 'count', field: '' },
  orderBy: { field: 'createdAt', dir: 'desc' },
  limit: 100,
  chartType: 'table',
});

const cardStyle = {
  background: 'rgba(255,255,255,0.05)',
  backdropFilter: 'blur(20px)',
  border: '1px solid rgba(255,255,255,0.1)',
  borderRadius: '16px',
  padding: '1.5rem',
  color: 'var(--text-primary, #fff)',
};

const inputStyle = {
  background: 'rgba(255,255,255,0.08)',
  border: '1px solid rgba(255,255,255,0.15)',
  borderRadius: '8px',
  padding: '0.5rem 0.75rem',
  color: 'inherit',
  fontSize: '0.875rem',
  outline: 'none',
};

const btnStyle = (variant = 'primary') => ({
  display: 'inline-flex',
  alignItems: 'center',
  gap: '0.4rem',
  padding: '0.5rem 0.9rem',
  borderRadius: '10px',
  border: '1px solid rgba(255,255,255,0.15)',
  cursor: 'pointer',
  fontSize: '0.85rem',
  fontWeight: 500,
  transition: 'all 0.15s ease',
  background: variant === 'primary'
    ? 'linear-gradient(135deg,#3b82f6,#a855f7)'
    : variant === 'danger'
      ? 'rgba(239,68,68,0.15)'
      : 'rgba(255,255,255,0.06)',
  color: variant === 'danger' ? '#ef4444' : '#fff',
});

export default function CustomReports() {
  const notify = useNotify();
  const [reports, setReports] = useState([]);
  const [config, setConfig] = useState(defaultConfig());
  const [editingId, setEditingId] = useState(null);
  const [results, setResults] = useState(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [showSaveModal, setShowSaveModal] = useState(false);
  const [saveName, setSaveName] = useState('');
  const [saveDesc, setSaveDesc] = useState('');
  const [error, setError] = useState('');

  useEffect(() => { loadReports(); }, []);

  const loadReports = async () => {
    try {
      const data = await fetchApi('/api/custom-reports');
      setReports(Array.isArray(data) ? data : []);
    } catch (e) { console.error(e); }
  };

  const fields = ENTITY_FIELDS[config.entity] || [];

  const setEntity = (entity) => {
    setConfig({ ...config, entity, columns: ENTITY_FIELDS[entity].slice(0, 3), groupBy: '', filters: [] });
  };

  const addFilter = () => {
    setConfig({ ...config, filters: [...config.filters, { field: fields[0], op: 'eq', value: '' }] });
  };
  const updateFilter = (idx, patch) => {
    const next = config.filters.map((f, i) => (i === idx ? { ...f, ...patch } : f));
    setConfig({ ...config, filters: next });
  };
  const removeFilter = (idx) => {
    setConfig({ ...config, filters: config.filters.filter((_, i) => i !== idx) });
  };

  const toggleColumn = (col) => {
    const has = config.columns.includes(col);
    setConfig({
      ...config,
      columns: has ? config.columns.filter(c => c !== col) : [...config.columns, col],
    });
  };

  const runReport = async () => {
    setLoading(true);
    setError('');
    try {
      const res = await fetchApi('/api/custom-reports/run', {
        method: 'POST',
        body: JSON.stringify({ config }),
      });
      setResults(res);
    } catch (e) {
      setError(e.message || 'Failed to run report');
      setResults(null);
    } finally { setLoading(false); }
  };

  const runSaved = async (id) => {
    setLoading(true);
    setError('');
    try {
      const r = reports.find(x => x.id === id);
      if (r) {
        setConfig({ ...defaultConfig(), ...r.config });
        setEditingId(r.id);
      }
      const res = await fetchApi(`/api/custom-reports/${id}/run`, { method: 'POST' });
      setResults(res);
    } catch (e) {
      setError(e.message || 'Failed to run');
    } finally { setLoading(false); }
  };

  const editReport = (r) => {
    setConfig({ ...defaultConfig(), ...r.config });
    setEditingId(r.id);
    setResults(null);
  };

  const deleteReport = async (id) => {
    if (!await notify.confirm('Delete this report?')) return;
    try {
      await fetchApi(`/api/custom-reports/${id}`, { method: 'DELETE' });
      if (editingId === id) { setEditingId(null); setConfig(defaultConfig()); }
      loadReports();
    } catch (e) { notify.error(e.message); }
  };

  const newReport = () => {
    setConfig(defaultConfig());
    setEditingId(null);
    setResults(null);
  };

  const openSave = () => {
    if (editingId) {
      const r = reports.find(x => x.id === editingId);
      setSaveName(r?.name || '');
      setSaveDesc(r?.description || '');
    } else {
      setSaveName('');
      setSaveDesc('');
    }
    setShowSaveModal(true);
  };

  const saveReport = async () => {
    if (!saveName.trim()) return;
    setSaving(true);
    try {
      if (editingId) {
        await fetchApi(`/api/custom-reports/${editingId}`, {
          method: 'PUT',
          body: JSON.stringify({ name: saveName, description: saveDesc, config }),
        });
      } else {
        const created = await fetchApi('/api/custom-reports', {
          method: 'POST',
          body: JSON.stringify({ name: saveName, description: saveDesc, config }),
        });
        setEditingId(created.id);
      }
      setShowSaveModal(false);
      loadReports();
    } catch (e) { notify.error(e.message); }
    finally { setSaving(false); }
  };

  // Detect a numeric "value" key in the result rows for charting
  const chartData = (() => {
    if (!results?.rows?.length) return [];
    const cols = results.columns || [];
    const labelKey = cols[0];
    const valueKey = cols.find(c => c.startsWith('sum_') || c.startsWith('avg_') || c === 'count')
      || cols.find(c => typeof results.rows[0][c] === 'number')
      || cols[1];
    return results.rows.map(r => ({
      name: String(r[labelKey] ?? '—'),
      value: Number(r[valueKey] ?? 0),
    }));
  })();

  return (
    <div style={{ padding: '2rem', color: 'var(--text-primary, #fff)' }}>
      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1.5rem' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
          <BarChart3 size={28} style={{ color: '#a855f7' }} />
          <div>
            <h1 style={{ margin: 0, fontSize: '1.75rem', fontWeight: 700 }}>Custom Reports</h1>
            <p style={{ margin: '0.25rem 0 0', opacity: 0.65, fontSize: '0.875rem' }}>
              Build no-code reports with filters, groups, and charts
            </p>
          </div>
        </div>
        <button onClick={newReport} style={btnStyle('primary')}>
          <Plus size={16} /> Create Report
        </button>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '320px 1fr', gap: '1.5rem' }}>
        {/* Saved reports */}
        <div style={cardStyle}>
          <h3 style={{ margin: '0 0 1rem', fontSize: '1rem', fontWeight: 600 }}>Saved Reports</h3>
          {reports.length === 0 && (
            <p style={{ opacity: 0.6, fontSize: '0.85rem' }}>No saved reports yet.</p>
          )}
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
            {reports.map(r => (
              <div key={r.id} style={{
                padding: '0.75rem',
                borderRadius: '10px',
                background: editingId === r.id ? 'rgba(168,85,247,0.15)' : 'rgba(255,255,255,0.04)',
                border: '1px solid rgba(255,255,255,0.08)',
              }}>
                <div style={{ fontWeight: 600, fontSize: '0.9rem', marginBottom: 2 }}>{r.name}</div>
                {r.description && (
                  <div style={{ fontSize: '0.75rem', opacity: 0.65, marginBottom: 6 }}>{r.description}</div>
                )}
                <div style={{ display: 'flex', gap: '0.4rem' }}>
                  <button onClick={() => runSaved(r.id)} style={{ ...btnStyle('secondary'), padding: '0.3rem 0.6rem', fontSize: '0.75rem' }}>
                    <Play size={12} /> Run
                  </button>
                  <button onClick={() => editReport(r)} style={{ ...btnStyle('secondary'), padding: '0.3rem 0.6rem', fontSize: '0.75rem' }}>
                    <Edit2 size={12} /> Edit
                  </button>
                  <button onClick={() => deleteReport(r.id)} style={{ ...btnStyle('danger'), padding: '0.3rem 0.6rem', fontSize: '0.75rem' }}>
                    <Trash2 size={12} />
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Builder */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem' }}>
          <div style={cardStyle}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1rem' }}>
              <h3 style={{ margin: 0, fontSize: '1rem', fontWeight: 600 }}>
                {editingId ? 'Edit Report' : 'Report Builder'}
              </h3>
              <div style={{ display: 'flex', gap: '0.5rem' }}>
                <button onClick={runReport} disabled={loading} style={btnStyle('primary')}>
                  <Play size={14} /> {loading ? 'Running…' : 'Run'}
                </button>
                <button onClick={openSave} style={btnStyle('secondary')}>
                  <Save size={14} /> Save
                </button>
              </div>
            </div>

            {/* Entity */}
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: '1rem', marginBottom: '1rem' }}>
              <Field label="Entity">
                <select value={config.entity} onChange={e => setEntity(e.target.value)} style={inputStyle}>
                  {Object.keys(ENTITY_FIELDS).map(e => <option key={e} value={e}>{e}</option>)}
                </select>
              </Field>
              <Field label="Limit">
                <input type="number" value={config.limit}
                  onChange={e => setConfig({ ...config, limit: parseInt(e.target.value) || 100 })}
                  style={inputStyle} />
              </Field>
            </div>

            {/* Filters */}
            <div style={{ marginBottom: '1rem' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.5rem' }}>
                <label style={{ fontSize: '0.8rem', fontWeight: 600, opacity: 0.85 }}>
                  <Filter size={12} style={{ marginRight: 4 }} /> Filters
                </label>
                <button onClick={addFilter} style={{ ...btnStyle('secondary'), padding: '0.3rem 0.6rem', fontSize: '0.75rem' }}>
                  <Plus size={12} /> Add Filter
                </button>
              </div>
              {config.filters.length === 0 && (
                <p style={{ fontSize: '0.75rem', opacity: 0.5, margin: 0 }}>No filters — all rows will be returned.</p>
              )}
              {config.filters.map((f, i) => (
                <div key={i} style={{ display: 'grid', gridTemplateColumns: '1fr 100px 1fr 32px', gap: '0.5rem', marginBottom: '0.5rem' }}>
                  <select value={f.field} onChange={e => updateFilter(i, { field: e.target.value })} style={inputStyle}>
                    {fields.map(fld => <option key={fld} value={fld}>{fld}</option>)}
                  </select>
                  <select value={f.op} onChange={e => updateFilter(i, { op: e.target.value })} style={inputStyle}>
                    {OPS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                  </select>
                  <input value={f.value} onChange={e => updateFilter(i, { value: e.target.value })}
                    placeholder="value" style={inputStyle} />
                  <button onClick={() => removeFilter(i)} style={{ ...btnStyle('danger'), padding: '0.4rem' }}>
                    <X size={14} />
                  </button>
                </div>
              ))}
            </div>

            {/* Columns */}
            <Field label="Columns">
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.4rem' }}>
                {fields.map(f => (
                  <label key={f} style={{
                    display: 'inline-flex', alignItems: 'center', gap: '0.3rem',
                    padding: '0.3rem 0.65rem', borderRadius: '999px', cursor: 'pointer',
                    background: config.columns.includes(f) ? 'rgba(59,130,246,0.25)' : 'rgba(255,255,255,0.05)',
                    border: '1px solid rgba(255,255,255,0.1)', fontSize: '0.75rem',
                  }}>
                    <input type="checkbox" checked={config.columns.includes(f)}
                      onChange={() => toggleColumn(f)} style={{ display: 'none' }} />
                    {f}
                  </label>
                ))}
              </div>
            </Field>

            {/* Group + Aggregate + Order */}
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '1rem', marginTop: '1rem' }}>
              <Field label="Group By">
                <select value={config.groupBy}
                  onChange={e => setConfig({ ...config, groupBy: e.target.value })}
                  style={inputStyle}>
                  <option value="">— None —</option>
                  {fields.map(f => <option key={f} value={f}>{f}</option>)}
                </select>
              </Field>
              {config.groupBy && (
                <>
                  <Field label="Aggregate">
                    <select value={config.aggregate?.type || 'count'}
                      onChange={e => setConfig({ ...config, aggregate: { ...config.aggregate, type: e.target.value } })}
                      style={inputStyle}>
                      {AGG_TYPES.map(a => <option key={a.value} value={a.value}>{a.label}</option>)}
                    </select>
                  </Field>
                  {config.aggregate?.type !== 'count' && (
                    <Field label="Aggregate Field">
                      <select value={config.aggregate?.field || ''}
                        onChange={e => setConfig({ ...config, aggregate: { ...config.aggregate, field: e.target.value } })}
                        style={inputStyle}>
                        <option value="">— pick numeric field —</option>
                        {fields.map(f => <option key={f} value={f}>{f}</option>)}
                      </select>
                    </Field>
                  )}
                </>
              )}
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: '1rem', marginTop: '1rem' }}>
              <Field label="Order By">
                <select value={config.orderBy.field}
                  onChange={e => setConfig({ ...config, orderBy: { ...config.orderBy, field: e.target.value } })}
                  style={inputStyle}>
                  {fields.map(f => <option key={f} value={f}>{f}</option>)}
                </select>
              </Field>
              <Field label="Direction">
                <select value={config.orderBy.dir}
                  onChange={e => setConfig({ ...config, orderBy: { ...config.orderBy, dir: e.target.value } })}
                  style={inputStyle}>
                  <option value="desc">Descending</option>
                  <option value="asc">Ascending</option>
                </select>
              </Field>
            </div>

            {/* Chart type */}
            <Field label="Chart Type" style={{ marginTop: '1rem' }}>
              <div style={{ display: 'flex', gap: '0.75rem', flexWrap: 'wrap' }}>
                {CHART_TYPES.map(ct => (
                  <label key={ct.value} style={{
                    display: 'inline-flex', alignItems: 'center', gap: '0.4rem', cursor: 'pointer',
                    padding: '0.4rem 0.75rem', borderRadius: '8px',
                    background: config.chartType === ct.value ? 'rgba(168,85,247,0.2)' : 'rgba(255,255,255,0.05)',
                    border: '1px solid rgba(255,255,255,0.1)', fontSize: '0.8rem',
                  }}>
                    <input type="radio" checked={config.chartType === ct.value}
                      onChange={() => setConfig({ ...config, chartType: ct.value })}
                      style={{ accentColor: '#a855f7' }} />
                    {ct.label}
                  </label>
                ))}
              </div>
            </Field>
          </div>

          {/* Results */}
          {error && (
            <div style={{ ...cardStyle, borderColor: 'rgba(239,68,68,0.3)', color: '#fca5a5' }}>
              Error: {error}
            </div>
          )}

          {results && (
            <div style={cardStyle}>
              <h3 style={{ margin: '0 0 1rem', fontSize: '1rem', fontWeight: 600 }}>
                Results ({results.rows.length} rows)
              </h3>

              {/* Chart */}
              {results.rows.length > 0 && config.chartType !== 'table' && (
                <div style={{ height: 320, marginBottom: '1.5rem' }}>
                  <ResponsiveContainer width="100%" height="100%">
                    {config.chartType === 'bar' ? (
                      <BarChart data={chartData}>
                        <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.08)" />
                        <XAxis dataKey="name" stroke="rgba(255,255,255,0.6)" />
                        <YAxis stroke="rgba(255,255,255,0.6)" />
                        <Tooltip contentStyle={{ background: 'var(--tooltip-bg)', border: '1px solid var(--border-color)', borderRadius: 8, color: 'var(--text-primary)' }} />
                        <Bar dataKey="value" fill="#3b82f6" radius={[8, 8, 0, 0]} />
                      </BarChart>
                    ) : config.chartType === 'pie' ? (
                      <PieChart>
                        <Pie data={chartData} dataKey="value" nameKey="name" cx="50%" cy="50%" outerRadius={110} label>
                          {chartData.map((_, i) => <Cell key={i} fill={COLORS[i % COLORS.length]} />)}
                        </Pie>
                        <Legend />
                        <Tooltip contentStyle={{ background: 'var(--tooltip-bg)', border: '1px solid var(--border-color)', borderRadius: 8, color: 'var(--text-primary)' }} />
                      </PieChart>
                    ) : (
                      <LineChart data={chartData}>
                        <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.08)" />
                        <XAxis dataKey="name" stroke="rgba(255,255,255,0.6)" />
                        <YAxis stroke="rgba(255,255,255,0.6)" />
                        <Tooltip contentStyle={{ background: 'var(--tooltip-bg)', border: '1px solid var(--border-color)', borderRadius: 8, color: 'var(--text-primary)' }} />
                        <Line type="monotone" dataKey="value" stroke="#a855f7" strokeWidth={2} />
                      </LineChart>
                    )}
                  </ResponsiveContainer>
                </div>
              )}

              {/* Table */}
              <div style={{ overflowX: 'auto' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.85rem' }}>
                  <thead>
                    <tr>
                      {results.columns.map(c => (
                        <th key={c} style={{
                          textAlign: 'left', padding: '0.6rem', borderBottom: '1px solid rgba(255,255,255,0.1)',
                          opacity: 0.75, fontWeight: 600,
                        }}>{c}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {results.rows.map((row, i) => (
                      <tr key={i}>
                        {results.columns.map(c => (
                          <td key={c} style={{ padding: '0.6rem', borderBottom: '1px solid rgba(255,255,255,0.05)' }}>
                            {formatCell(row[c])}
                          </td>
                        ))}
                      </tr>
                    ))}
                    {results.rows.length === 0 && (
                      <tr><td colSpan={results.columns.length} style={{ padding: '1rem', textAlign: 'center', opacity: 0.6 }}>
                        No results
                      </td></tr>
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Save Modal */}
      {showSaveModal && (
        <div onClick={() => setShowSaveModal(false)} style={{
          position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)',
          display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000,
        }}>
          <div onClick={e => e.stopPropagation()} style={{
            ...cardStyle, width: 'min(440px, 90vw)', background: 'rgba(30,30,40,0.95)',
          }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1rem' }}>
              <h3 style={{ margin: 0 }}>{editingId ? 'Update Report' : 'Save Report'}</h3>
              <button onClick={() => setShowSaveModal(false)} style={{ ...btnStyle('secondary'), padding: '0.3rem' }}>
                <X size={16} />
              </button>
            </div>
            <Field label="Name">
              <input value={saveName} onChange={e => setSaveName(e.target.value)}
                placeholder="Q4 Pipeline by Stage" style={inputStyle} />
            </Field>
            <Field label="Description" style={{ marginTop: '0.75rem' }}>
              <textarea value={saveDesc} onChange={e => setSaveDesc(e.target.value)}
                placeholder="Optional description"
                style={{ ...inputStyle, minHeight: 70, resize: 'vertical' }} />
            </Field>
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '0.5rem', marginTop: '1rem' }}>
              <button onClick={() => setShowSaveModal(false)} style={btnStyle('secondary')}>Cancel</button>
              <button onClick={saveReport} disabled={saving || !saveName.trim()} style={btnStyle('primary')}>
                <Save size={14} /> {saving ? 'Saving…' : 'Save'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function Field({ label, children, style }) {
  return (
    <div style={style}>
      <label style={{ display: 'block', fontSize: '0.75rem', fontWeight: 600, opacity: 0.75, marginBottom: 4 }}>
        {label}
      </label>
      {children}
    </div>
  );
}

function formatCell(v) {
  if (v === null || v === undefined) return '—';
  if (typeof v === 'number') return v.toLocaleString();
  if (v instanceof Date || (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(v))) {
    try { return new Date(v).toLocaleString(); } catch { return String(v); }
  }
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}
