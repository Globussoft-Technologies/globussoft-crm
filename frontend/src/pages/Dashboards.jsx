import React, { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { Responsive, useContainerWidth } from 'react-grid-layout';
import {
  ResponsiveContainer, BarChart, Bar, LineChart, Line, PieChart, Pie, Cell,
  XAxis, YAxis, Tooltip, CartesianGrid, Legend,
} from 'recharts';
import {
  LayoutDashboard, Plus, Edit, Save, X, Trash2, Star, RefreshCw,
} from 'lucide-react';
import { fetchApi } from '../utils/api';
import 'react-grid-layout/css/styles.css';
import 'react-resizable/css/styles.css';

// react-grid-layout v2 dropped the legacy WidthProvider HOC and replaced it
// with the useContainerWidth hook. Recreate the HOC to keep call-site clean.
function WidthProvider(Wrapped) {
  return function WidthProvided(props) {
    const { containerRef, width } = useContainerWidth({ initialWidth: 1280 });
    return (
      <div ref={containerRef} style={{ width: '100%' }}>
        <Wrapped {...props} width={width} />
      </div>
    );
  };
}

const ResponsiveGridLayout = WidthProvider(Responsive);

// ─── Glass styling helpers ─────────────────────────────────────────

const glass = {
  background: 'rgba(255,255,255,0.04)',
  backdropFilter: 'blur(18px)',
  WebkitBackdropFilter: 'blur(18px)',
  border: '1px solid rgba(255,255,255,0.08)',
  borderRadius: '14px',
  color: 'var(--text-primary, #e2e8f0)',
};

const button = (variant = 'primary') => ({
  display: 'inline-flex', alignItems: 'center', gap: '0.5rem',
  padding: '0.5rem 0.95rem', borderRadius: '10px', fontWeight: 600,
  fontSize: '0.85rem', cursor: 'pointer', transition: 'all 0.15s',
  border: '1px solid rgba(255,255,255,0.12)',
  background:
    variant === 'primary' ? 'linear-gradient(135deg,#6366f1,#8b5cf6)' :
    variant === 'danger'  ? 'rgba(239,68,68,0.15)' :
                            'rgba(255,255,255,0.05)',
  color:
    variant === 'danger' ? '#fca5a5' :
    variant === 'primary' ? '#fff' : 'var(--text-primary,#e2e8f0)',
});

const PALETTE = ['#6366f1', '#8b5cf6', '#ec4899', '#f59e0b', '#10b981', '#06b6d4', '#ef4444', '#84cc16'];

// ─── Widget Catalog ────────────────────────────────────────────────

const WIDGET_CATALOG = [
  { type: 'kpi-revenue',        title: 'Revenue (30d)',     w: 3, h: 2, group: 'KPI' },
  { type: 'kpi-deals',          title: 'Open Deals',        w: 3, h: 2, group: 'KPI' },
  { type: 'kpi-contacts',       title: 'Total Contacts',    w: 3, h: 2, group: 'KPI' },
  { type: 'kpi-tasks',          title: 'Pending Tasks',     w: 3, h: 2, group: 'KPI' },
  { type: 'chart-pipeline',     title: 'Pipeline by Stage', w: 6, h: 4, group: 'Charts' },
  { type: 'chart-revenue-trend',title: 'Revenue Trend (12m)', w: 6, h: 4, group: 'Charts' },
  { type: 'chart-leads-source', title: 'Leads by Source',   w: 6, h: 4, group: 'Charts' },
  { type: 'table-recent-deals', title: 'Recent Deals',      w: 6, h: 4, group: 'Tables' },
  { type: 'table-overdue-tasks',title: 'Overdue Tasks',     w: 6, h: 4, group: 'Tables' },
];

const formatCurrency = (n) => {
  if (n == null) return '$0';
  return '$' + Number(n).toLocaleString(undefined, { maximumFractionDigits: 0 });
};

// ─── Widget Renderers ──────────────────────────────────────────────

function KpiWidget({ data, title, accent }) {
  const value = data?.value ?? 0;
  const isCurrency = title.toLowerCase().includes('revenue');
  return (
    <div style={{ padding: '1rem', display: 'flex', flexDirection: 'column', height: '100%', justifyContent: 'space-between' }}>
      <div style={{ fontSize: '0.78rem', textTransform: 'uppercase', letterSpacing: '0.06em', opacity: 0.7 }}>
        {title}
      </div>
      <div style={{ fontSize: '2rem', fontWeight: 800, color: accent || '#a5b4fc' }}>
        {isCurrency ? formatCurrency(value) : value.toLocaleString()}
      </div>
      <div style={{ fontSize: '0.7rem', opacity: 0.55 }}>{data?.label || ''}</div>
    </div>
  );
}

function PipelineChart({ data }) {
  const rows = Array.isArray(data) ? data : [];
  return (
    <div style={{ padding: '0.75rem', height: '100%' }}>
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={rows}>
          <CartesianGrid stroke="rgba(255,255,255,0.06)" />
          <XAxis dataKey="stage" stroke="#94a3b8" fontSize={11} />
          <YAxis stroke="#94a3b8" fontSize={11} />
          <Tooltip contentStyle={{ background: 'rgba(15,23,42,0.95)', border: '1px solid #334155', borderRadius: 8 }} />
          <Bar dataKey="count" fill="#6366f1" radius={[6, 6, 0, 0]} />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

function RevenueTrendChart({ data }) {
  const rows = Array.isArray(data) ? data : [];
  return (
    <div style={{ padding: '0.75rem', height: '100%' }}>
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={rows}>
          <CartesianGrid stroke="rgba(255,255,255,0.06)" />
          <XAxis dataKey="month" stroke="#94a3b8" fontSize={11} />
          <YAxis stroke="#94a3b8" fontSize={11} />
          <Tooltip contentStyle={{ background: 'rgba(15,23,42,0.95)', border: '1px solid #334155', borderRadius: 8 }} />
          <Line type="monotone" dataKey="revenue" stroke="#10b981" strokeWidth={2.5} dot={{ r: 3 }} />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}

function LeadsSourceChart({ data }) {
  const rows = Array.isArray(data) ? data : [];
  return (
    <div style={{ padding: '0.75rem', height: '100%' }}>
      <ResponsiveContainer width="100%" height="100%">
        <PieChart>
          <Pie data={rows} dataKey="count" nameKey="source" cx="50%" cy="50%" outerRadius="75%" label>
            {rows.map((_, i) => <Cell key={i} fill={PALETTE[i % PALETTE.length]} />)}
          </Pie>
          <Tooltip contentStyle={{ background: 'rgba(15,23,42,0.95)', border: '1px solid #334155', borderRadius: 8 }} />
          <Legend wrapperStyle={{ fontSize: 11 }} />
        </PieChart>
      </ResponsiveContainer>
    </div>
  );
}

function DataTable({ data, columns }) {
  const rows = Array.isArray(data) ? data : [];
  return (
    <div style={{ padding: '0.5rem', height: '100%', overflow: 'auto' }}>
      <table style={{ width: '100%', fontSize: '0.78rem', borderCollapse: 'collapse' }}>
        <thead>
          <tr style={{ textAlign: 'left', opacity: 0.7 }}>
            {columns.map((c) => (
              <th key={c.key} style={{ padding: '0.4rem 0.6rem', borderBottom: '1px solid rgba(255,255,255,0.08)' }}>
                {c.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 && (
            <tr><td colSpan={columns.length} style={{ padding: '1rem', opacity: 0.5, textAlign: 'center' }}>No records</td></tr>
          )}
          {rows.map((row, i) => (
            <tr key={row.id || i} style={{ borderBottom: '1px solid rgba(255,255,255,0.04)' }}>
              {columns.map((c) => (
                <td key={c.key} style={{ padding: '0.4rem 0.6rem' }}>
                  {c.render ? c.render(row) : row[c.key]}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function renderWidget(widget, data) {
  if (!data) {
    return <div style={{ padding: '1rem', opacity: 0.5, fontSize: '0.8rem' }}>Loading…</div>;
  }
  if (data.error) {
    return <div style={{ padding: '1rem', color: '#fca5a5', fontSize: '0.8rem' }}>{data.error}</div>;
  }

  switch (widget.type) {
    case 'kpi-revenue':  return <KpiWidget data={data} title={widget.title} accent="#10b981" />;
    case 'kpi-deals':    return <KpiWidget data={data} title={widget.title} accent="#6366f1" />;
    case 'kpi-contacts': return <KpiWidget data={data} title={widget.title} accent="#06b6d4" />;
    case 'kpi-tasks':    return <KpiWidget data={data} title={widget.title} accent="#f59e0b" />;
    case 'chart-pipeline':      return <PipelineChart data={data} />;
    case 'chart-revenue-trend': return <RevenueTrendChart data={data} />;
    case 'chart-leads-source':  return <LeadsSourceChart data={data} />;
    case 'table-recent-deals':
      return <DataTable data={data} columns={[
        { key: 'title', label: 'Deal' },
        { key: 'stage', label: 'Stage' },
        { key: 'amount', label: 'Amount', render: (r) => formatCurrency(r.amount) },
        { key: 'createdAt', label: 'Created', render: (r) => new Date(r.createdAt).toLocaleDateString() },
      ]} />;
    case 'table-overdue-tasks':
      return <DataTable data={data} columns={[
        { key: 'title', label: 'Task' },
        { key: 'priority', label: 'Priority' },
        { key: 'dueDate', label: 'Due', render: (r) => r.dueDate ? new Date(r.dueDate).toLocaleDateString() : '—' },
      ]} />;
    default:
      return <div style={{ padding: '1rem', opacity: 0.5 }}>Unknown widget: {widget.type}</div>;
  }
}

// ─── Main Component ────────────────────────────────────────────────

export default function Dashboards() {
  const [dashboards, setDashboards] = useState([]);
  const [activeId, setActiveId] = useState(null);
  const [active, setActive] = useState(null);
  const [layout, setLayout] = useState([]);
  const [data, setData] = useState({});
  const [editMode, setEditMode] = useState(false);
  const [showCreate, setShowCreate] = useState(false);
  const [showAddWidget, setShowAddWidget] = useState(false);
  const [newName, setNewName] = useState('');
  const [loading, setLoading] = useState(false);

  const loadDashboards = useCallback(async () => {
    try {
      const list = await fetchApi('/api/dashboards');
      setDashboards(Array.isArray(list) ? list : []);
      if (list.length && !activeId) {
        const def = list.find((d) => d.isDefault) || list[0];
        setActiveId(def.id);
      }
    } catch (e) {
      console.error('Failed to load dashboards', e);
    }
  }, [activeId]);

  const loadActive = useCallback(async (id) => {
    if (!id) return;
    setLoading(true);
    try {
      const [board, widgetData] = await Promise.all([
        fetchApi(`/api/dashboards/${id}`),
        fetchApi(`/api/dashboards/${id}/data`).catch(() => ({})),
      ]);
      setActive(board);
      setLayout(Array.isArray(board.layout) ? board.layout : []);
      setData(widgetData || {});
    } catch (e) {
      console.error('Failed to load dashboard', e);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { loadDashboards(); }, []); // eslint-disable-line
  useEffect(() => { if (activeId) loadActive(activeId); }, [activeId, loadActive]);

  const handleCreate = async () => {
    if (!newName.trim()) return;
    try {
      const created = await fetchApi('/api/dashboards', {
        method: 'POST',
        body: JSON.stringify({ name: newName.trim(), layout: [] }),
      });
      setNewName('');
      setShowCreate(false);
      await loadDashboards();
      setActiveId(created.id);
      setEditMode(true);
    } catch (e) {
      alert('Failed to create dashboard');
    }
  };

  const handleSave = async () => {
    if (!active) return;
    try {
      await fetchApi(`/api/dashboards/${active.id}`, {
        method: 'PUT',
        body: JSON.stringify({ layout }),
      });
      setEditMode(false);
      await loadActive(active.id);
    } catch (e) {
      alert('Failed to save layout');
    }
  };

  const handleDelete = async () => {
    if (!active) return;
    if (!window.confirm(`Delete dashboard "${active.name}"?`)) return;
    try {
      await fetchApi(`/api/dashboards/${active.id}`, { method: 'DELETE' });
      setActiveId(null);
      setActive(null);
      setLayout([]);
      await loadDashboards();
    } catch (e) {
      alert('Failed to delete');
    }
  };

  const handleSetDefault = async () => {
    if (!active) return;
    try {
      await fetchApi(`/api/dashboards/${active.id}/set-default`, { method: 'POST' });
      await loadDashboards();
      await loadActive(active.id);
    } catch (e) {
      alert('Only admins can set tenant default');
    }
  };

  const addWidget = (catalog) => {
    const id = `w-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const maxY = layout.reduce((m, w) => Math.max(m, w.y + w.h), 0);
    setLayout([
      ...layout,
      { i: id, x: 0, y: maxY, w: catalog.w, h: catalog.h, type: catalog.type, title: catalog.title },
    ]);
    setShowAddWidget(false);
  };

  const removeWidget = (i) => {
    setLayout(layout.filter((w) => w.i !== i));
  };

  const onLayoutChange = (newLayout) => {
    if (!editMode) return;
    setLayout(layout.map((w) => {
      const m = newLayout.find((n) => n.i === w.i);
      return m ? { ...w, x: m.x, y: m.y, w: m.w, h: m.h } : w;
    }));
  };

  const rglLayouts = useMemo(() => ({
    lg: layout.map((w) => ({ i: w.i, x: w.x, y: w.y, w: w.w, h: w.h })),
  }), [layout]);

  const grouped = useMemo(() => {
    const g = {};
    WIDGET_CATALOG.forEach((c) => { (g[c.group] ||= []).push(c); });
    return g;
  }, []);

  return (
    <div style={{ padding: '1.5rem 2rem', minHeight: '100vh' }}>
      {/* ── Header ───────────────────────────────────────────────── */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: '1rem', marginBottom: '1.5rem' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.85rem' }}>
          <div style={{ ...glass, padding: '0.75rem', borderRadius: '12px' }}>
            <LayoutDashboard size={22} color="#a5b4fc" />
          </div>
          <div>
            <h1 style={{ margin: 0, fontSize: '1.5rem', fontWeight: 700 }}>Custom Dashboards</h1>
            <div style={{ fontSize: '0.8rem', opacity: 0.6 }}>Drag, resize, and tailor your analytics view</div>
          </div>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem', flexWrap: 'wrap' }}>
          <select
            value={activeId || ''}
            onChange={(e) => { setActiveId(parseInt(e.target.value, 10) || null); setEditMode(false); }}
            style={{
              ...glass, padding: '0.5rem 0.85rem', minWidth: 220, fontSize: '0.85rem',
              outline: 'none', cursor: 'pointer',
            }}
          >
            <option value="" disabled>Select dashboard…</option>
            {dashboards.map((d) => (
              <option key={d.id} value={d.id}>
                {d.isDefault ? '★ ' : ''}{d.name}
              </option>
            ))}
          </select>

          {active && (
            <button onClick={() => loadActive(active.id)} style={button('secondary')} title="Refresh data">
              <RefreshCw size={15} />
            </button>
          )}

          {active && !editMode && (
            <button onClick={() => setEditMode(true)} style={button('secondary')}>
              <Edit size={15} /> Edit
            </button>
          )}
          {active && editMode && (
            <>
              <button onClick={() => setShowAddWidget(true)} style={button('secondary')}>
                <Plus size={15} /> Add Widget
              </button>
              <button onClick={handleSave} style={button('primary')}>
                <Save size={15} /> Save
              </button>
              <button onClick={() => { setEditMode(false); loadActive(active.id); }} style={button('secondary')}>
                <X size={15} /> Cancel
              </button>
            </>
          )}
          {active && !active.isDefault && (
            <button onClick={handleSetDefault} style={button('secondary')} title="Set as tenant default (admin only)">
              <Star size={15} />
            </button>
          )}
          {active && (
            <button onClick={handleDelete} style={button('danger')}>
              <Trash2 size={15} />
            </button>
          )}
          <button onClick={() => setShowCreate(true)} style={button('primary')}>
            <Plus size={16} /> Create Dashboard
          </button>
        </div>
      </div>

      {/* ── Empty States ─────────────────────────────────────────── */}
      {dashboards.length === 0 && (
        <div style={{ ...glass, padding: '3rem', textAlign: 'center' }}>
          <LayoutDashboard size={42} color="#a5b4fc" style={{ marginBottom: '1rem' }} />
          <h3 style={{ margin: '0 0 0.5rem' }}>No dashboards yet</h3>
          <p style={{ opacity: 0.6, margin: '0 0 1.25rem' }}>Create your first custom analytics view to get started.</p>
          <button onClick={() => setShowCreate(true)} style={button('primary')}>
            <Plus size={15} /> Create Dashboard
          </button>
        </div>
      )}

      {active && layout.length === 0 && !loading && (
        <div style={{ ...glass, padding: '2.5rem', textAlign: 'center' }}>
          <h3 style={{ margin: '0 0 0.5rem' }}>{active.name} is empty</h3>
          <p style={{ opacity: 0.6, marginBottom: '1.25rem' }}>Enter edit mode and add your first widget.</p>
          {!editMode ? (
            <button onClick={() => setEditMode(true)} style={button('primary')}>
              <Edit size={15} /> Edit Layout
            </button>
          ) : (
            <button onClick={() => setShowAddWidget(true)} style={button('primary')}>
              <Plus size={15} /> Add Widget
            </button>
          )}
        </div>
      )}

      {/* ── Grid ─────────────────────────────────────────────────── */}
      {active && layout.length > 0 && (
        <ResponsiveGridLayout
          className="layout"
          layouts={rglLayouts}
          breakpoints={{ lg: 1200, md: 996, sm: 768, xs: 480, xxs: 0 }}
          cols={{ lg: 12, md: 12, sm: 8, xs: 4, xxs: 2 }}
          rowHeight={80}
          isDraggable={editMode}
          isResizable={editMode}
          onLayoutChange={onLayoutChange}
          margin={[14, 14]}
        >
          {layout.map((w) => (
            <div key={w.i} style={{ ...glass, position: 'relative', overflow: 'hidden' }}>
              {editMode && (
                <button
                  onClick={() => removeWidget(w.i)}
                  style={{
                    position: 'absolute', top: 6, right: 6, zIndex: 5,
                    background: 'rgba(239,68,68,0.18)', border: '1px solid rgba(239,68,68,0.35)',
                    color: '#fca5a5', borderRadius: '8px', cursor: 'pointer',
                    padding: '4px 6px', display: 'flex', alignItems: 'center',
                  }}
                  title="Remove widget"
                >
                  <X size={14} />
                </button>
              )}
              <div style={{
                padding: '0.55rem 0.85rem', fontSize: '0.75rem', fontWeight: 600,
                opacity: 0.75, borderBottom: '1px solid rgba(255,255,255,0.06)',
                display: 'flex', alignItems: 'center', justifyContent: 'space-between',
              }}>
                <span>{w.title}</span>
                {editMode && <span style={{ fontSize: '0.65rem', opacity: 0.5 }}>{w.type}</span>}
              </div>
              <div style={{ height: 'calc(100% - 32px)' }}>
                {renderWidget(w, data[w.i])}
              </div>
            </div>
          ))}
        </ResponsiveGridLayout>
      )}

      {/* ── Create Modal ─────────────────────────────────────────── */}
      {showCreate && (
        <Modal onClose={() => setShowCreate(false)} title="Create Dashboard">
          <input
            type="text"
            placeholder="Dashboard name"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && handleCreate()}
            autoFocus
            style={{
              width: '100%', padding: '0.7rem 0.9rem', borderRadius: 10,
              background: 'rgba(0,0,0,0.25)', border: '1px solid rgba(255,255,255,0.1)',
              color: 'inherit', fontSize: '0.95rem', outline: 'none',
            }}
          />
          <div style={{ display: 'flex', gap: '0.5rem', justifyContent: 'flex-end', marginTop: '1rem' }}>
            <button onClick={() => setShowCreate(false)} style={button('secondary')}>Cancel</button>
            <button onClick={handleCreate} style={button('primary')}>Create</button>
          </div>
        </Modal>
      )}

      {/* ── Add Widget Modal ─────────────────────────────────────── */}
      {showAddWidget && (
        <Modal onClose={() => setShowAddWidget(false)} title="Add Widget" wide>
          {Object.entries(grouped).map(([group, items]) => (
            <div key={group} style={{ marginBottom: '1.2rem' }}>
              <div style={{ fontSize: '0.75rem', textTransform: 'uppercase', letterSpacing: '0.08em', opacity: 0.6, marginBottom: '0.5rem' }}>
                {group}
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill,minmax(200px,1fr))', gap: '0.6rem' }}>
                {items.map((c) => (
                  <button
                    key={c.type}
                    onClick={() => addWidget(c)}
                    style={{
                      ...glass, padding: '0.85rem', textAlign: 'left',
                      cursor: 'pointer', fontSize: '0.85rem',
                    }}
                  >
                    <div style={{ fontWeight: 600 }}>{c.title}</div>
                    <div style={{ fontSize: '0.7rem', opacity: 0.55, marginTop: '0.25rem' }}>{c.type}</div>
                  </button>
                ))}
              </div>
            </div>
          ))}
        </Modal>
      )}
    </div>
  );
}

// ─── Modal helper ──────────────────────────────────────────────────

function Modal({ children, onClose, title, wide }) {
  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)',
        backdropFilter: 'blur(4px)', display: 'flex',
        alignItems: 'center', justifyContent: 'center', zIndex: 1000,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          ...glass, padding: '1.5rem', minWidth: wide ? 560 : 380,
          maxWidth: '90vw', maxHeight: '85vh', overflow: 'auto',
          background: 'rgba(15,23,42,0.92)',
        }}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1rem' }}>
          <h3 style={{ margin: 0, fontSize: '1.05rem' }}>{title}</h3>
          <button onClick={onClose} style={{ ...button('secondary'), padding: '0.35rem' }}><X size={16} /></button>
        </div>
        {children}
      </div>
    </div>
  );
}
