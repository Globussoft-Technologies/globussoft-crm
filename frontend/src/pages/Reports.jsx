import React, { useState, useEffect } from 'react';
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, PieChart, Pie, Cell, AreaChart, Area } from 'recharts';
import { fetchApi } from '../utils/api';
import { formatMoney } from '../utils/money';
import { PieChart as PieChartIcon, Download, Filter, Calendar, Table, BarChart3, Clock, Mail } from 'lucide-react';

const COLORS = ['#3b82f6', '#a855f7', '#10b981', '#f59e0b', '#ef4444', '#ec4899', '#6366f1', '#14b8a6'];

const METRIC_OPTIONS = [
  { value: 'revenue', label: 'Revenue ($)', group: 'Deals' },
  { value: 'count', label: 'Deal Count (#)', group: 'Deals' },
  { value: 'win_rate', label: 'Win Rate', group: 'Deals' },
  { value: 'tasks', label: 'Task Status', group: 'Activity' },
  { value: 'contacts_by_source', label: 'Contacts by Source', group: 'Contacts' },
  { value: 'contacts_by_status', label: 'Contacts by Status', group: 'Contacts' },
  { value: 'invoices', label: 'Invoice Status', group: 'Financial' },
  { value: 'expenses', label: 'Expenses by Category', group: 'Financial' },
];

const GROUPBY_OPTIONS = [
  { value: 'stage', label: 'Pipeline Stage' },
  { value: 'probability', label: 'Probability Score' },
];

const DETAIL_TYPES = [
  { value: 'deals', label: 'Deals' },
  { value: 'contacts', label: 'Contacts' },
  { value: 'tasks', label: 'Tasks' },
  { value: 'calls', label: 'Call Logs' },
  { value: 'invoices', label: 'Invoices' },
  { value: 'expenses', label: 'Expenses' },
];

export default function Reports() {
  const [data, setData] = useState([]);
  const [metric, setMetric] = useState('revenue');
  const [groupBy, setGroupBy] = useState('stage');
  const [chartType, setChartType] = useState('bar');
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');
  const [loading, setLoading] = useState(true);
  const [viewMode, setViewMode] = useState('chart'); // chart | table
  const [detailType, setDetailType] = useState('deals');
  const [detailData, setDetailData] = useState([]);
  const [detailLoading, setDetailLoading] = useState(false);
  const [showScheduleModal, setShowScheduleModal] = useState(false);
  const [schedules, setSchedules] = useState([]);
  const [newSchedule, setNewSchedule] = useState({ name: '', reportType: 'deals', frequency: 'weekly', recipients: '', format: 'PDF' });

  // #117: skip queries entirely if the range is inverted — the backend rejects
  // these now, but bailing on the client also avoids spurious red flashes.
  const rangeInverted = !!(startDate && endDate && new Date(startDate) > new Date(endDate));

  const dateParams = () => {
    if (rangeInverted) return '';
    let params = '';
    if (startDate) params += `&startDate=${startDate}`;
    if (endDate) params += `&endDate=${endDate}`;
    return params;
  };

  useEffect(() => {
    setLoading(true);
    fetchApi(`/api/reports/query?metric=${metric}&groupBy=${groupBy}${dateParams()}`)
      .then(res => {
        if (Array.isArray(res) && res.length > 0) {
          setData(res);
        } else {
          setData([
            { name: 'Lead', value: 35000 },
            { name: 'Contacted', value: 20000 },
            { name: 'Proposal', value: 15000 },
            { name: 'Won', value: 80000 }
          ]);
        }
        setLoading(false);
      })
      .catch(err => {
        console.error(err);
        setData([{ name: 'Error state', value: 1 }]);
        setLoading(false);
      });
  }, [metric, groupBy, startDate, endDate]);

  useEffect(() => {
    if (viewMode === 'table') {
      setDetailLoading(true);
      fetchApi(`/api/reports/detailed/${detailType}?${dateParams()}`)
        .then(res => { setDetailData(Array.isArray(res) ? res : []); setDetailLoading(false); })
        .catch(() => { setDetailData([]); setDetailLoading(false); });
    }
  }, [viewMode, detailType, startDate, endDate]);

  // Schedules
  useEffect(() => {
    fetchApi('/api/report-schedules').then(data => setSchedules(data)).catch(() => {});
  }, []);

  // #127: pragmatic email check — same regex used server-side in report_schedules.js
  const EMAIL_RE = /^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]{2,}$/;

  const handleCreateSchedule = async (e) => {
    e.preventDefault();
    const recipients = newSchedule.recipients.split(',').map(r => r.trim()).filter(Boolean);
    if (recipients.length === 0) {
      alert('Add at least one recipient email.');
      return;
    }
    const invalid = recipients.filter(r => !EMAIL_RE.test(r));
    if (invalid.length) {
      alert(`Invalid email address(es): ${invalid.join(', ')}\n\nFix these before creating the schedule.`);
      return;
    }
    try {
      await fetchApi('/api/report-schedules', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...newSchedule, recipients }),
      });
    } catch (err) {
      alert(`Failed to create schedule: ${err.message || err}`);
      return;
    }
    setNewSchedule({ name: '', reportType: 'deals', frequency: 'weekly', recipients: '', format: 'PDF' });
    fetchApi('/api/report-schedules').then(data => setSchedules(Array.isArray(data) ? data : [])).catch(() => {});
    setShowScheduleModal(false);
  };

  const handleToggleSchedule = async (id) => {
    await fetchApi(`/api/report-schedules/${id}/toggle`, { method: 'PUT' });
    fetchApi('/api/report-schedules').then(data => setSchedules(Array.isArray(data) ? data : [])).catch(() => {});
  };

  const handleDeleteSchedule = async (id) => {
    await fetchApi(`/api/report-schedules/${id}`, { method: 'DELETE' });
    fetchApi('/api/report-schedules').then(data => setSchedules(Array.isArray(data) ? data : [])).catch(() => {});
  };

  const totalValue = data.reduce((sum, item) => sum + (item.value || 0), 0);

  const exportFile = (format) => {
    const token = localStorage.getItem('token');
    const baseUrl = import.meta.env.VITE_API_URL || '';
    const endpoint = format === 'pdf' ? 'export-pdf' : 'export-csv';
    const params = viewMode === 'table'
      ? `type=${detailType}${dateParams()}`
      : `metric=${metric}&groupBy=${groupBy}${dateParams()}`;
    fetch(`${baseUrl}/api/reports/${endpoint}?${params}`, { headers: { Authorization: `Bearer ${token}` } })
      .then(res => {
        if (!res.ok) throw new Error(`${format.toUpperCase()} export failed`);
        return res.blob();
      })
      .then(blob => {
        const link = document.createElement('a');
        link.href = URL.createObjectURL(blob);
        link.download = `report.${format}`;
        link.click();
        URL.revokeObjectURL(link.href);
      })
      .catch(() => alert(`Failed to export ${format.toUpperCase()}`));
  };

  const needsGroupBy = metric === 'revenue' || metric === 'count';

  return (
    <div style={{ padding: '2rem', height: '100%', display: 'flex', flexDirection: 'column', animation: 'fadeIn 0.5s ease-out' }}>
      <header style={{ marginBottom: '2rem', display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '1rem' }}>
        <div>
          <h1 style={{ fontSize: '2rem', fontWeight: 'bold' }}>Reports & Analytics</h1>
          <p style={{ color: 'var(--text-secondary)', marginTop: '0.25rem' }}>Business intelligence dashboard — real-time revenue, pipeline, and deal analytics.</p>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', flexWrap: 'wrap' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', flexDirection: 'column' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
              <Calendar size={16} color="var(--text-secondary)" />
              <input type="date" className="input-field" value={startDate} onChange={e => setStartDate(e.target.value)} style={{ padding: '0.5rem', fontSize: '0.8rem', borderColor: rangeInverted ? '#ef4444' : undefined }} />
              <span style={{ color: 'var(--text-secondary)' }}>to</span>
              <input type="date" className="input-field" value={endDate} onChange={e => setEndDate(e.target.value)} style={{ padding: '0.5rem', fontSize: '0.8rem', borderColor: rangeInverted ? '#ef4444' : undefined }} />
            </div>
            {rangeInverted && (
              <span style={{ color: '#ef4444', fontSize: '0.7rem', alignSelf: 'flex-start' }}>
                Start date must be on or before end date
              </span>
            )}
          </div>
          <button className="btn-secondary" onClick={() => exportFile('csv')} style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <Download size={16} /> CSV
          </button>
          <button className="btn-primary" onClick={() => exportFile('pdf')} style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <Download size={16} /> PDF
          </button>
          <button className="btn-secondary" onClick={() => setShowScheduleModal(true)} style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <Clock size={16} /> Schedule
          </button>
        </div>
      </header>

      {/* View Mode Tabs */}
      <div style={{ display: 'flex', gap: '0.5rem', marginBottom: '1.5rem' }}>
        <button onClick={() => setViewMode('chart')} style={{ padding: '0.5rem 1.25rem', borderRadius: '8px', border: 'none', cursor: 'pointer', fontWeight: '500', background: viewMode === 'chart' ? 'var(--accent-color)' : 'var(--subtle-bg)', color: viewMode === 'chart' ? '#fff' : 'var(--text-primary)', display: 'flex', alignItems: 'center', gap: '0.4rem', transition: 'var(--transition)' }}>
          <BarChart3 size={16} /> Charts
        </button>
        <button onClick={() => setViewMode('table')} style={{ padding: '0.5rem 1.25rem', borderRadius: '8px', border: 'none', cursor: 'pointer', fontWeight: '500', background: viewMode === 'table' ? 'var(--accent-color)' : 'var(--subtle-bg)', color: viewMode === 'table' ? '#fff' : 'var(--text-primary)', display: 'flex', alignItems: 'center', gap: '0.4rem', transition: 'var(--transition)' }}>
          <Table size={16} /> Detailed Data
        </button>
      </div>

      {viewMode === 'chart' ? (
        <div style={{ display: 'flex', gap: '2rem', flex: 1, minHeight: 0, flexWrap: 'wrap' }}>
          {/* Controls Sidebar */}
          <div className="card" style={{ width: '300px', minWidth: '260px', padding: '2rem', display: 'flex', flexDirection: 'column', gap: '2rem', flex: '0 0 auto' }}>
            <h3 style={{ fontSize: '1.25rem', fontWeight: '600', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
              <Filter size={20} color="var(--accent-color)" /> Query Builder
            </h3>

            <div>
              <label style={{ display: 'block', marginBottom: '0.75rem', fontSize: '0.875rem', color: 'var(--text-secondary)', fontWeight: '600' }}>1. Select Metric</label>
              <select className="input-field" value={metric} onChange={e => setMetric(e.target.value)} style={{ padding: '0.75rem', background: 'var(--input-bg)', width: '100%', outline: 'none' }}>
                {METRIC_OPTIONS.map(m => <option key={m.value} value={m.value}>{m.label}</option>)}
              </select>
            </div>

            {needsGroupBy && (
              <div>
                <label style={{ display: 'block', marginBottom: '0.75rem', fontSize: '0.875rem', color: 'var(--text-secondary)', fontWeight: '600' }}>2. Group By</label>
                <select className="input-field" value={groupBy} onChange={e => setGroupBy(e.target.value)} style={{ padding: '0.75rem', background: 'var(--input-bg)', width: '100%', outline: 'none' }}>
                  {GROUPBY_OPTIONS.map(g => <option key={g.value} value={g.value}>{g.label}</option>)}
                </select>
              </div>
            )}

            <div>
              <label style={{ display: 'block', marginBottom: '0.75rem', fontSize: '0.875rem', color: 'var(--text-secondary)', fontWeight: '600' }}>{needsGroupBy ? '3' : '2'}. Visualization</label>
              <select className="input-field" value={chartType} onChange={e => setChartType(e.target.value)} style={{ padding: '0.75rem', background: 'var(--input-bg)', width: '100%', outline: 'none' }}>
                <option value="bar">Bar Chart</option>
                <option value="pie">Donut Chart</option>
                <option value="area">Area Chart</option>
              </select>
            </div>

            <div style={{ marginTop: 'auto', padding: '1.5rem', background: 'rgba(59, 130, 246, 0.1)', borderRadius: '12px', border: '1px solid rgba(59, 130, 246, 0.2)' }}>
              <p style={{ color: 'var(--text-secondary)', fontSize: '0.875rem', marginBottom: '0.5rem' }}>Aggregate Total</p>
              <h2 style={{ fontSize: '1.75rem', fontWeight: 'bold', color: 'var(--accent-color)' }}>
                {metric === 'revenue' || metric === 'invoices' || metric === 'expenses' ? formatMoney(totalValue) : totalValue}
              </h2>
            </div>
          </div>

          {/* Chart View */}
          <div className="card" style={{ flex: 1, padding: '2rem', display: 'flex', flexDirection: 'column' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '2rem' }}>
              <h3 style={{ fontSize: '1.25rem', fontWeight: '600', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                <PieChartIcon size={20} color="var(--success-color)" /> Data Projection
              </h3>
            </div>

            <div style={{ flex: 1, position: 'relative', minHeight: '350px' }}>
              {loading ? (
                <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-secondary)' }}>Crunching metrics...</div>
              ) : data.length === 0 ? (
                <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-secondary)' }}>No data available for this query.</div>
              ) : (
                <ResponsiveContainer width="100%" height="100%">
                  {chartType === 'bar' ? (
                    <BarChart data={data} margin={{ top: 20, right: 30, left: 20, bottom: 20 }}>
                      <CartesianGrid strokeDasharray="3 3" stroke="var(--border-color)" vertical={false} />
                      <XAxis dataKey="name" stroke="var(--text-secondary)" tickLine={false} axisLine={false} />
                      <YAxis stroke="var(--text-secondary)" tickLine={false} axisLine={false} tickFormatter={val => metric === 'revenue' ? formatMoney(val, { maximumFractionDigits: 0 }) : val} />
                      <Tooltip contentStyle={{ background: 'var(--tooltip-bg)', border: '1px solid var(--border-color)', borderRadius: '8px' }} itemStyle={{ color: 'var(--text-primary)' }} />
                      <Bar dataKey="value" radius={[4, 4, 0, 0]}>
                        {data.map((entry, index) => (
                          <Cell key={`cell-${index}`} fill={COLORS[index % COLORS.length]} />
                        ))}
                      </Bar>
                    </BarChart>
                  ) : chartType === 'pie' ? (
                    <PieChart>
                      <Pie data={data} innerRadius={80} outerRadius={140} paddingAngle={5} dataKey="value" label={({ name, percent }) => `${name} ${(percent * 100).toFixed(0)}%`}>
                        {data.map((entry, index) => (
                          <Cell key={`cell-${index}`} fill={COLORS[index % COLORS.length]} />
                        ))}
                      </Pie>
                      <Tooltip contentStyle={{ background: 'var(--tooltip-bg)', border: '1px solid var(--border-color)', borderRadius: '8px' }} itemStyle={{ color: 'var(--text-primary)' }} />
                    </PieChart>
                  ) : (
                    <AreaChart data={data} margin={{ top: 20, right: 30, left: 20, bottom: 20 }}>
                      <defs>
                        <linearGradient id="colorVal" x1="0" y1="0" x2="0" y2="1">
                          <stop offset="5%" stopColor="#10b981" stopOpacity={0.8} />
                          <stop offset="95%" stopColor="#10b981" stopOpacity={0} />
                        </linearGradient>
                      </defs>
                      <CartesianGrid strokeDasharray="3 3" stroke="var(--border-color)" vertical={false} />
                      <XAxis dataKey="name" stroke="var(--text-secondary)" tickLine={false} axisLine={false} />
                      <YAxis stroke="var(--text-secondary)" tickLine={false} axisLine={false} tickFormatter={val => metric === 'revenue' ? formatMoney(val, { maximumFractionDigits: 0 }) : val} />
                      <Tooltip contentStyle={{ background: 'var(--tooltip-bg)', border: '1px solid var(--border-color)', borderRadius: '8px' }} />
                      <Area type="monotone" dataKey="value" stroke="#10b981" fillOpacity={1} fill="url(#colorVal)" />
                    </AreaChart>
                  )}
                </ResponsiveContainer>
              )}
            </div>
          </div>
        </div>
      ) : (
        /* Detailed Data Table View */
        <div>
          <div style={{ marginBottom: '1rem', display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
            {DETAIL_TYPES.map(t => (
              <button key={t.value} onClick={() => setDetailType(t.value)} style={{
                padding: '0.5rem 1rem', borderRadius: '8px', border: 'none', cursor: 'pointer', fontWeight: '500', fontSize: '0.85rem',
                background: detailType === t.value ? 'var(--accent-color)' : 'var(--subtle-bg)',
                color: detailType === t.value ? '#fff' : 'var(--text-primary)', transition: 'var(--transition)'
              }}>
                {t.label}
              </button>
            ))}
          </div>

          <div className="card" style={{ overflow: 'auto' }}>
            {detailLoading ? (
              <div style={{ padding: '2rem', textAlign: 'center', color: 'var(--text-secondary)' }}>Loading data...</div>
            ) : detailData.length === 0 ? (
              <div style={{ padding: '2rem', textAlign: 'center', color: 'var(--text-secondary)' }}>No records found for the selected period.</div>
            ) : (
              <table style={{ width: '100%', borderCollapse: 'collapse', textAlign: 'left', fontSize: '0.85rem' }}>
                <thead>
                  <tr style={{ borderBottom: '1px solid var(--border-color)', backgroundColor: 'var(--table-header-bg)' }}>
                    {detailType === 'deals' && <>
                      <th style={thStyle}>Title</th><th style={thStyle}>Amount</th><th style={thStyle}>Stage</th><th style={thStyle}>Owner</th><th style={thStyle}>Contact</th><th style={thStyle}>Created</th>
                    </>}
                    {detailType === 'contacts' && <>
                      <th style={thStyle}>Name</th><th style={thStyle}>Email</th><th style={thStyle}>Company</th><th style={thStyle}>Status</th><th style={thStyle}>Source</th><th style={thStyle}>Assigned To</th><th style={thStyle}>AI Score</th>
                    </>}
                    {detailType === 'tasks' && <>
                      <th style={thStyle}>Title</th><th style={thStyle}>Status</th><th style={thStyle}>Priority</th><th style={thStyle}>Assignee</th><th style={thStyle}>Due Date</th>
                    </>}
                    {detailType === 'calls' && <>
                      <th style={thStyle}>Contact</th><th style={thStyle}>Duration</th><th style={thStyle}>Direction</th><th style={thStyle}>Agent</th><th style={thStyle}>Date</th>
                    </>}
                    {detailType === 'invoices' && <>
                      <th style={thStyle}>Invoice #</th><th style={thStyle}>Amount</th><th style={thStyle}>Status</th><th style={thStyle}>Contact</th><th style={thStyle}>Due Date</th>
                    </>}
                    {detailType === 'expenses' && <>
                      <th style={thStyle}>Title</th><th style={thStyle}>Amount</th><th style={thStyle}>Category</th><th style={thStyle}>Status</th><th style={thStyle}>Submitted By</th>
                    </>}
                  </tr>
                </thead>
                <tbody>
                  {detailData.map((row, i) => (
                    <tr key={row.id || i} style={{ borderBottom: '1px solid var(--border-color)' }} className="table-row-hover">
                      {detailType === 'deals' && <>
                        <td style={tdStyle}>{row.title}</td>
                        <td style={{ ...tdStyle, fontWeight: '600', color: 'var(--success-color)' }}>{formatMoney(row.amount || 0)}</td>
                        <td style={tdStyle}><StageBadge stage={row.stage} /></td>
                        <td style={tdStyle}>{row.owner?.name || '—'}</td>
                        <td style={tdStyle}>{row.contact?.name || '—'}</td>
                        <td style={tdStyle}>{fmtDate(row.createdAt)}</td>
                      </>}
                      {detailType === 'contacts' && <>
                        <td style={{ ...tdStyle, fontWeight: '500' }}>{row.name}</td>
                        <td style={tdStyle}>{row.email}</td>
                        <td style={tdStyle}>{row.company || '—'}</td>
                        <td style={tdStyle}><StatusBadge status={row.status} /></td>
                        <td style={tdStyle}>{row.source || '—'}</td>
                        <td style={tdStyle}>{row.assignedTo?.name || '—'}</td>
                        <td style={tdStyle}>{row.aiScore}</td>
                      </>}
                      {detailType === 'tasks' && <>
                        <td style={tdStyle}>{row.title}</td>
                        <td style={tdStyle}><StatusBadge status={row.status} /></td>
                        <td style={tdStyle}>{row.priority}</td>
                        <td style={tdStyle}>{row.user?.name || '—'}</td>
                        <td style={tdStyle}>{row.dueDate ? fmtDate(row.dueDate) : '—'}</td>
                      </>}
                      {detailType === 'calls' && <>
                        <td style={tdStyle}>{row.contact?.name || '—'}</td>
                        <td style={tdStyle}>{Math.floor(row.duration / 60)}m {row.duration % 60}s</td>
                        <td style={tdStyle}>{row.direction}</td>
                        <td style={tdStyle}>{row.user?.name || '—'}</td>
                        <td style={tdStyle}>{fmtDate(row.createdAt)}</td>
                      </>}
                      {detailType === 'invoices' && <>
                        <td style={tdStyle}>{row.invoiceNum}</td>
                        <td style={{ ...tdStyle, fontWeight: '600' }}>{formatMoney(row.amount || 0)}</td>
                        <td style={tdStyle}><StatusBadge status={row.status} /></td>
                        <td style={tdStyle}>{row.contact?.name || '—'}</td>
                        <td style={tdStyle}>{fmtDate(row.dueDate)}</td>
                      </>}
                      {detailType === 'expenses' && <>
                        <td style={tdStyle}>{row.title}</td>
                        <td style={{ ...tdStyle, fontWeight: '600' }}>{formatMoney(row.amount || 0)}</td>
                        <td style={tdStyle}>{row.category}</td>
                        <td style={tdStyle}><StatusBadge status={row.status} /></td>
                        <td style={tdStyle}>{row.user?.name || '—'}</td>
                      </>}
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>
      )}

      {/* Scheduled Reports Section */}
      {schedules.length > 0 && (
        <div style={{ marginTop: '2rem' }}>
          <h3 style={{ fontSize: '1.1rem', fontWeight: '600', marginBottom: '1rem', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <Mail size={18} color="var(--accent-color)" /> Scheduled Email Reports
          </h3>
          <div className="card" style={{ overflow: 'hidden' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', textAlign: 'left', fontSize: '0.85rem' }}>
              <thead>
                <tr style={{ borderBottom: '1px solid var(--border-color)', backgroundColor: 'var(--table-header-bg)' }}>
                  <th style={thStyle}>Name</th>
                  <th style={thStyle}>Type</th>
                  <th style={thStyle}>Frequency</th>
                  <th style={thStyle}>Format</th>
                  <th style={thStyle}>Recipients</th>
                  <th style={thStyle}>Last Run</th>
                  <th style={thStyle}>Status</th>
                  <th style={{ ...thStyle, textAlign: 'right' }}>Actions</th>
                </tr>
              </thead>
              <tbody>
                {schedules.map(s => (
                  <tr key={s.id} style={{ borderBottom: '1px solid var(--border-color)' }} className="table-row-hover">
                    <td style={{ ...tdStyle, fontWeight: '500' }}>{s.name}</td>
                    <td style={tdStyle}>{s.reportType}</td>
                    <td style={tdStyle}>{s.frequency}</td>
                    <td style={tdStyle}>{s.format}</td>
                    <td style={tdStyle}>{(() => { try { return JSON.parse(s.recipients).join(', '); } catch { return s.recipients; } })()}</td>
                    <td style={tdStyle}>{s.lastRunAt ? fmtDate(s.lastRunAt) : 'Never'}</td>
                    <td style={tdStyle}>
                      <span style={{
                        padding: '0.2rem 0.6rem', borderRadius: '999px', fontSize: '0.7rem', fontWeight: 'bold',
                        backgroundColor: s.enabled ? 'rgba(16,185,129,0.1)' : 'rgba(239,68,68,0.1)',
                        color: s.enabled ? 'var(--success-color)' : '#ef4444'
                      }}>
                        {s.enabled ? 'Active' : 'Paused'}
                      </span>
                    </td>
                    <td style={{ ...tdStyle, textAlign: 'right', display: 'flex', gap: '0.5rem', justifyContent: 'flex-end' }}>
                      <button onClick={() => handleToggleSchedule(s.id)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--accent-color)', fontSize: '0.8rem' }}>
                        {s.enabled ? 'Pause' : 'Enable'}
                      </button>
                      <button onClick={() => handleDeleteSchedule(s.id)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#ef4444', fontSize: '0.8rem' }}>
                        Delete
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Schedule Modal */}
      {showScheduleModal && (
        <div style={{ position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, background: 'var(--overlay-bg)', backdropFilter: 'blur(5px)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 100 }}>
          <div className="card" style={{ padding: '2rem', width: '480px' }}>
            <h3 style={{ marginBottom: '1.5rem', fontSize: '1.25rem', fontWeight: 'bold' }}>Schedule Email Report</h3>
            <form onSubmit={handleCreateSchedule} style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
              <div>
                <label style={labelStyle}>Report Name</label>
                <input type="text" className="input-field" placeholder="e.g. Weekly Sales Summary" required value={newSchedule.name} onChange={e => setNewSchedule({ ...newSchedule, name: e.target.value })} />
              </div>
              <div>
                <label style={labelStyle}>Report Type</label>
                <select className="input-field" value={newSchedule.reportType} onChange={e => setNewSchedule({ ...newSchedule, reportType: e.target.value })}>
                  <option value="deals">Deals Summary</option>
                  <option value="agent-performance">Agent Performance</option>
                  <option value="pipeline">Pipeline Overview</option>
                  <option value="tasks">Tasks Summary</option>
                  <option value="contacts">Contacts Summary</option>
                </select>
              </div>
              <div>
                <label style={labelStyle}>Frequency</label>
                <select className="input-field" value={newSchedule.frequency} onChange={e => setNewSchedule({ ...newSchedule, frequency: e.target.value })}>
                  <option value="daily">Daily (8am)</option>
                  <option value="weekly">Weekly (Monday 8am)</option>
                  <option value="monthly">Monthly (1st of month)</option>
                </select>
              </div>
              <div>
                <label style={labelStyle}>Format</label>
                <select className="input-field" value={newSchedule.format} onChange={e => setNewSchedule({ ...newSchedule, format: e.target.value })}>
                  <option value="PDF">PDF</option>
                  <option value="CSV">CSV</option>
                </select>
              </div>
              <div>
                <label style={labelStyle}>Recipients (comma-separated emails)</label>
                <input type="text" className="input-field" placeholder="admin@company.com, manager@company.com" required value={newSchedule.recipients} onChange={e => setNewSchedule({ ...newSchedule, recipients: e.target.value })} />
              </div>
              <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '1rem', marginTop: '0.5rem' }}>
                <button type="button" onClick={() => setShowScheduleModal(false)} style={{ background: 'transparent', color: 'var(--text-secondary)', border: 'none', cursor: 'pointer' }}>Cancel</button>
                <button type="submit" className="btn-primary">Create Schedule</button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}

const thStyle = { padding: '0.875rem 1rem', color: 'var(--text-secondary)', fontWeight: '500', fontSize: '0.8rem' };
const tdStyle = { padding: '0.875rem 1rem' };
const labelStyle = { display: 'block', marginBottom: '0.4rem', fontSize: '0.85rem', color: 'var(--text-secondary)', fontWeight: '500' };

function fmtDate(d) {
  if (!d) return '—';
  return new Date(d).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
}

function StageBadge({ stage }) {
  const colors = { won: '#10b981', lost: '#ef4444', lead: '#3b82f6', contacted: '#f59e0b', proposal: '#a855f7' };
  const c = colors[stage] || '#6b7280';
  return <span style={{ padding: '0.2rem 0.6rem', borderRadius: '999px', fontSize: '0.7rem', fontWeight: 'bold', backgroundColor: `${c}18`, color: c }}>{stage}</span>;
}

function StatusBadge({ status }) {
  const s = (status || '').toLowerCase();
  const c = ['paid', 'completed', 'customer', 'active', 'approved', 'reimbursed'].some(x => s.includes(x)) ? '#10b981'
    : ['overdue', 'rejected', 'churned', 'lost', 'urgent'].some(x => s.includes(x)) ? '#ef4444'
    : ['pending', 'lead', 'draft', 'open'].some(x => s.includes(x)) ? '#f59e0b' : '#3b82f6';
  return <span style={{ padding: '0.2rem 0.6rem', borderRadius: '999px', fontSize: '0.7rem', fontWeight: 'bold', backgroundColor: `${c}18`, color: c }}>{status}</span>;
}
