import React, { useState, useEffect, useRef } from 'react';
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Cell } from 'recharts';
import { fetchApi, getAuthToken } from '../utils/api';
import { formatMoney } from '../utils/money';
import TopScrollSync from '../components/TopScrollSync';
import { Trophy, Users, TrendingUp, Phone, Mail, CheckSquare, Upload, Calendar } from 'lucide-react';

const COLORS = ['#3b82f6', '#a855f7', '#10b981', '#f59e0b', '#ef4444', '#ec4899', '#6366f1', '#14b8a6'];

// #602: numeric/currency cells must not wrap mid-number; tabular-nums aligns
// digit columns vertically across rows. min-width keeps a 7-digit currency
// like "₹12,34,567" or "$1,234,567" on one line at typical zoom.
const thBaseStyle = { padding: '0.875rem 1rem', color: 'var(--text-secondary)', fontWeight: '500', fontSize: '0.8rem' };
const thNumStyle = { ...thBaseStyle, whiteSpace: 'nowrap' };
const tdBaseStyle = { padding: '0.875rem 1rem' };
const tdNumStyle = { ...tdBaseStyle, whiteSpace: 'nowrap', fontVariantNumeric: 'tabular-nums', minWidth: '5rem' };

const METRIC_OPTIONS = [
  { value: 'revenue', label: 'Revenue' },
  { value: 'deals', label: 'Deals Won' },
  { value: 'calls', label: 'Calls Made' },
  { value: 'tasks', label: 'Tasks Completed' },
  { value: 'emails', label: 'Emails Sent' },
];

export default function AgentReports() {
  const [agents, setAgents] = useState([]);
  const [leaderboard, setLeaderboard] = useState([]);
  const [leaderMetric, setLeaderMetric] = useState('revenue');
  const [selectedAgent, setSelectedAgent] = useState(null);
  const [agentDetail, setAgentDetail] = useState(null);
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');
  const [loading, setLoading] = useState(true);
  const [exporting, setExporting] = useState(null); // 'csv' | 'pdf' | null
  const [exportError, setExportError] = useState('');
  const [exportInfo, setExportInfo] = useState('');
  // Concurrency guard as a ref (not state): the buttons stay enabled and
  // clickable-looking during an export, so the cursor never freezes in a
  // "disabled" state. Double-clicks while busy are ignored via this ref.
  const exportingRef = useRef(false);

  const dateParams = () => {
    let params = '';
    if (startDate) params += `&startDate=${startDate}`;
    if (endDate) params += `&endDate=${endDate}`;
    return params;
  };

  useEffect(() => {
    setLoading(true);
    fetchApi(`/api/reports/agent-performance?${dateParams()}`)
      .then(data => { setAgents(data); setLoading(false); })
      .catch(() => setLoading(false));
  }, [startDate, endDate]);

  useEffect(() => {
    fetchApi(`/api/reports/leaderboard?metric=${leaderMetric}${dateParams()}`)
      .then(data => setLeaderboard(data))
      .catch(() => {});
  }, [leaderMetric, startDate, endDate]);

  useEffect(() => {
    if (!selectedAgent) { setAgentDetail(null); return; }
    fetchApi(`/api/reports/agent/${selectedAgent}?${dateParams()}`)
      .then(data => setAgentDetail(data))
      .catch(() => {});
  }, [selectedAgent, startDate, endDate]);

  // Shared blob-download pipeline for both exports. Fixes the dead PDF
  // button: the old code clicked a detached <a> (ignored by some browsers)
  // and revoked the object URL synchronously — winning the race against the
  // browser for the larger streamed PDF, so no file was ever saved. It also
  // never checked res.ok, so a server 500 downloaded as a corrupt ".pdf".
  // Relative path → same-origin via Vite's /api proxy. A VITE_API_URL
  // prefix would make this cross-origin (CORS preflight 401 + mixed-content
  // over HTTPS). See Invoices.jsx downloadPdf for the canonical note.
  const downloadExport = async (url, filename, kind) => {
    if (exportingRef.current) return;
    exportingRef.current = true;
    setExporting(kind);
    setExportError('');
    setExportInfo('');
    try {
      const token = getAuthToken();
      const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
      // NOTE: `res.ok === false` (not `!res.ok`) — unit-test fetch stubs
      // resolve with a bare { blob } object where `ok` is undefined.
      if (res.ok === false) {
        let detail = '';
        try { detail = await res.text(); } catch { /* ignore */ }
        throw new Error(detail && detail.length < 200 ? detail : `Export failed (${res.status || 'server error'})`);
      }
      const blob = await res.blob();
      if (!blob || blob.size === 0) throw new Error('Server returned an empty file');
      const objectUrl = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = objectUrl;
      link.download = filename;
      link.rel = 'noopener';
      link.style.display = 'none';
      document.body.appendChild(link);
      link.click();
      link.remove();
      // Revoke lazily — revoking synchronously aborts the download,
      // which is exactly why the PDF never saved.
      setTimeout(() => URL.revokeObjectURL(objectUrl), 4000);
    } catch (e) {
      console.error(`[AgentReports] ${kind} export failed:`, e);
      setExportError(e.message || `${kind.toUpperCase()} export failed`);
    } finally {
      exportingRef.current = false;
      setExporting(null);
    }
  };

  const handleExportCSV = () => {
    downloadExport(`/api/reports/export-csv?type=agent-performance${dateParams()}`, 'agent-performance.csv', 'csv');
  };

  const escapeHtml = (v) => String(v == null ? '' : v)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

  // Client-side fallback: builds a printable report from the table data
  // already on screen and opens the browser print dialog (Save as PDF).
  // Used when the server /export-pdf endpoint fails, times out, or
  // returns an empty/error payload — so the PDF button always does
  // something instead of silently doing nothing.
  const printAgentsFallback = () => {
    try {
      const period = [startDate, endDate].filter(Boolean).join(' to ') || 'All time';
      const rows = agents.map((a, i) => (
        `<tr><td>${i + 1}</td><td>${escapeHtml(a.name)}<br/><small>${escapeHtml(a.role || '')}</small></td>` +
        `<td>${escapeHtml(formatMoney(a.revenue, { maximumFractionDigits: 0 }))}</td>` +
        `<td>${escapeHtml(a.dealsWon)}/${escapeHtml(a.dealsTotal)}</td><td>${escapeHtml(a.winRate)}%</td>` +
        `<td>${escapeHtml(a.tasksCompleted)}</td><td>${escapeHtml(a.callsMade)}</td>` +
        `<td>${escapeHtml(a.emailsSent)}</td><td>${escapeHtml(a.contactsAssigned)}</td></tr>`
      )).join('');
      const html = `<!doctype html><html><head><meta charset="utf-8"><title>Agent Performance Report</title>` +
        `<style>body{font-family:Arial,sans-serif;color:#111;padding:24px;}h1{font-size:20px;margin:0;}p{color:#555;font-size:12px;}` +
        `table{border-collapse:collapse;width:100%;margin-top:16px;font-size:12px;}th,td{border:1px solid #ccc;padding:6px 8px;text-align:left;}` +
        `th{background:#f0f0f0;}@media print{@page{size:A4 landscape;}}</style></head><body>` +
        `<h1>Agent Performance Report</h1><p>Period: ${escapeHtml(period)} &nbsp;•&nbsp; Generated: ${escapeHtml(new Date().toLocaleString())}</p>` +
        `<table><thead><tr><th>#</th><th>Agent</th><th>Revenue</th><th>Deals</th><th>Win %</th><th>Tasks</th><th>Calls</th><th>Emails</th><th>Contacts</th></tr></thead>` +
        `<tbody>${rows || '<tr><td colspan="9">No agent data.</td></tr>'}</tbody></table>` +
        `<script>window.onload = function () { window.focus(); window.print(); };</script></body></html>`;
      const iframe = document.createElement('iframe');
      iframe.style.position = 'fixed';
      iframe.style.right = '0';
      iframe.style.bottom = '0';
      iframe.style.width = '0';
      iframe.style.height = '0';
      iframe.style.border = '0';
      iframe.setAttribute('aria-hidden', 'true');
      iframe.setAttribute('title', 'Agent performance print view');
      document.body.appendChild(iframe);
      const idoc = iframe.contentDocument || (iframe.contentWindow && iframe.contentWindow.document);
      if (!idoc) throw new Error('Print view unavailable');
      idoc.open();
      idoc.write(html);
      idoc.close();
      const cleanup = () => { try { iframe.remove(); } catch { /* ignore */ } };
      try {
        const iwin = iframe.contentWindow;
        if (iwin) {
          iwin.focus();
          // Give the iframe a tick to render before printing.
          setTimeout(() => { try { iwin.print(); } catch { /* ignore */ } }, 250);
          setTimeout(cleanup, 5000);
        } else {
          setTimeout(cleanup, 5000);
        }
      } catch { setTimeout(cleanup, 5000); }
      return true;
    } catch (e) {
      console.error('[AgentReports] print fallback failed:', e);
      return false;
    }
  };

  const handleExportPDF = async () => {
    if (exportingRef.current) return;
    // No rows on screen → nothing for the fallback to print; try server only.
    if (!agents || agents.length === 0) {
      downloadExport(`/api/reports/export-pdf?type=agent-performance${dateParams()}`, 'agent-performance.pdf', 'pdf');
      return;
    }
    exportingRef.current = true;
    setExporting('pdf');
    setExportError('');
    setExportInfo('');
    const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
    // The server builds the PDF with per-agent DB queries before streaming
    // anything back, so on bigger tenants it legitimately takes 20-40s.
    // Aborting at 15s was killing slow-but-working exports and forcing the
    // print fallback every time — hence the "Server PDF unavailable" message.
    const timeoutId = controller ? setTimeout(() => { try { controller.abort(); } catch { /* ignore */ } }, 60000) : null;
    try {
      const token = getAuthToken();
      const fetchOpts = { headers: { Authorization: `Bearer ${token}` } };
      if (controller) fetchOpts.signal = controller.signal;
      const res = await fetch(`/api/reports/export-pdf?type=agent-performance${dateParams()}`, fetchOpts);
      // NOTE: `res.ok === false` (not `!res.ok`) — unit-test fetch stubs
      // resolve with a bare { blob } object where `ok` is undefined.
      if (res.ok === false) throw new Error(`Export failed (${res.status || 'server error'})`);
      const contentType = typeof res.headers?.get === 'function' ? (res.headers.get('content-type') || '') : '';
      const blob = await res.blob();
      if (!blob || blob.size === 0) throw new Error('Server returned an empty file');
      if (contentType.includes('application/json')) throw new Error('Server returned an error instead of a PDF');
      const objectUrl = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = objectUrl;
      link.download = 'agent-performance.pdf';
      link.rel = 'noopener';
      link.style.display = 'none';
      document.body.appendChild(link);
      link.click();
      link.remove();
      // Revoke lazily — revoking synchronously aborts the download,
      // which is exactly why the PDF never saved.
      setTimeout(() => URL.revokeObjectURL(objectUrl), 4000);
    } catch (e) {
      console.error('[AgentReports] pdf export failed, using print fallback:', e);
      const opened = printAgentsFallback();
      if (opened) {
        // Fallback worked — this is informational, not an error, so it
        // renders in neutral theme text instead of alarming red.
        setExportInfo('Server PDF took too long — opened print view instead (choose "Save as PDF").');
      } else {
        setExportError(e.message || 'PDF export failed');
      }
    } finally {
      if (timeoutId) clearTimeout(timeoutId);
      exportingRef.current = false;
      setExporting(null);
    }
  };

  const StatCard = ({ icon: Icon, label, value, color }) => (
    <div style={{ padding: '1.25rem', background: `${color}10`, borderRadius: '12px', border: `1px solid ${color}25`, flex: 1, minWidth: '140px' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.5rem' }}>
        <Icon size={16} color={color} />
        <span style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', fontWeight: '500' }}>{label}</span>
      </div>
      <div style={{ fontSize: '1.5rem', fontWeight: 'bold' }}>{value}</div>
    </div>
  );

  return (
    <div style={{ padding: '2rem', animation: 'fadeIn 0.5s ease-out' }}>
      <header style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '2rem' }}>
        <div>
          <h1 style={{ fontSize: '2rem', fontWeight: 'bold' }}>Agent Reports</h1>
          <p style={{ color: 'var(--text-secondary)', marginTop: '0.25rem' }}>Performance analytics by sales agent — deals, calls, tasks, and more.</p>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <Calendar size={16} color="var(--text-secondary)" />
            <input type="date" className="input-field" value={startDate} onChange={e => setStartDate(e.target.value)} style={{ padding: '0.5rem', fontSize: '0.8rem' }} />
            <span style={{ color: 'var(--text-secondary)' }}>to</span>
            <input type="date" className="input-field" value={endDate} onChange={e => setEndDate(e.target.value)} style={{ padding: '0.5rem', fontSize: '0.8rem' }} />
          </div>
          <button className="btn-secondary" onClick={handleExportCSV} aria-disabled={exporting === 'csv'} title={exporting === 'csv' ? 'Exporting CSV, please wait…' : 'Download CSV'} style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', cursor: exporting ? 'wait' : 'pointer', opacity: exporting && exporting !== 'csv' ? 0.6 : 1 }}>
            <Upload size={16} /> {exporting === 'csv' ? 'Generating…' : 'CSV'}
          </button>
          <button className="btn-primary" onClick={handleExportPDF} aria-disabled={exporting === 'pdf'} title={exporting === 'pdf' ? 'Exporting PDF, please wait…' : 'Download PDF'} style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', cursor: exporting ? 'wait' : 'pointer', opacity: exporting && exporting !== 'pdf' ? 0.6 : 1 }}>
            <Upload size={16} /> {exporting === 'pdf' ? 'Generating…' : 'PDF'}
          </button>
          {exporting && (
            <span role="status" style={{ color: 'var(--text-secondary)', fontSize: '0.8rem', maxWidth: '260px' }}>
              Generating {exporting === 'pdf' ? 'PDF' : 'CSV'}, please wait…
              {exporting === 'pdf' ? ' (server report can take up to a minute)' : ''}
            </span>
          )}
          {exportInfo && !exporting && (
            <span role="status" style={{ color: 'var(--text-secondary)', fontSize: '0.8rem', maxWidth: '260px' }}>
              {exportInfo}
            </span>
          )}
          {exportError && (
            <span role="alert" style={{ color: '#ef4444', fontSize: '0.8rem', maxWidth: '220px' }}>
              {exportError}
            </span>
          )}
        </div>
      </header>

      {/* Summary Stats */}
      {!loading && agents.length > 0 && (
        <div style={{ display: 'flex', gap: '1rem', marginBottom: '1.5rem', flexWrap: 'wrap' }}>
          <StatCard icon={Users} label="Total Agents" value={agents.length} color="#3b82f6" />
          <StatCard icon={TrendingUp} label="Total Revenue" value={formatMoney(agents.reduce((s, a) => s + a.revenue, 0))} color="#10b981" />
          <StatCard icon={Trophy} label="Deals Won" value={agents.reduce((s, a) => s + a.dealsWon, 0)} color="#f59e0b" />
          <StatCard icon={Phone} label="Total Calls" value={agents.reduce((s, a) => s + a.callsMade, 0)} color="#a855f7" />
          <StatCard icon={Mail} label="Emails Sent" value={agents.reduce((s, a) => s + a.emailsSent, 0)} color="#ec4899" />
          <StatCard icon={CheckSquare} label="Tasks Done" value={agents.reduce((s, a) => s + a.tasksCompleted, 0)} color="#6366f1" />
        </div>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 380px', gap: '1.5rem', alignItems: 'start' }}>
        {/* Agent Performance Table */}
        <div className="card" style={{ overflow: 'visible' }}>
          <div style={{ padding: '1.25rem', borderBottom: '1px solid var(--border-color)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <h3 style={{ fontSize: '1.1rem', fontWeight: '600', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
              <Users size={18} color="var(--accent-color)" /> Agent Performance
            </h3>
          </div>
          <TopScrollSync>
          <table style={{ width: '100%', borderCollapse: 'collapse', textAlign: 'left' }}>
            <thead>
              <tr style={{ borderBottom: '1px solid var(--border-color)', backgroundColor: 'var(--table-header-bg)' }}>
                <th style={thBaseStyle}>#</th>
                <th style={thBaseStyle}>Agent</th>
                <th style={thNumStyle}>Revenue</th>
                <th style={thNumStyle}>Deals</th>
                <th style={thNumStyle}>Win %</th>
                <th style={thNumStyle}>Tasks</th>
                <th style={thNumStyle}>Calls</th>
                <th style={thNumStyle}>Emails</th>
                <th style={thNumStyle}>Contacts</th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr><td colSpan="9" style={{ padding: '2rem', textAlign: 'center', color: 'var(--text-secondary)' }}>Loading agent data...</td></tr>
              ) : agents.length === 0 ? (
                <tr><td colSpan="9" style={{ padding: '2rem', textAlign: 'center', color: 'var(--text-secondary)' }}>No agent data found</td></tr>
              ) : agents.map((agent, i) => (
                <tr
                  key={agent.id}
                  style={{ borderBottom: '1px solid var(--border-color)', cursor: 'pointer', background: selectedAgent === agent.id ? 'rgba(59,130,246,0.06)' : undefined }}
                  className="table-row-hover"
                  onClick={() => setSelectedAgent(selectedAgent === agent.id ? null : agent.id)}
                >
                  <td style={{ ...tdNumStyle, fontWeight: '600', color: i < 3 ? '#f59e0b' : 'var(--text-secondary)' }}>
                    {i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : i + 1}
                  </td>
                  <td style={tdBaseStyle}>
                    <div style={{ fontWeight: '500' }}>{agent.name}</div>
                    <div style={{ fontSize: '0.7rem', color: 'var(--text-secondary)' }}>{agent.role}</div>
                  </td>
                  <td style={{ ...tdNumStyle, fontWeight: '600', color: 'var(--success-color)' }}>{formatMoney(agent.revenue, { maximumFractionDigits: 0 })}</td>
                  <td style={tdNumStyle}>{agent.dealsWon}/{agent.dealsTotal}</td>
                  <td style={tdNumStyle}>
                    <span style={{
                      padding: '0.2rem 0.6rem', borderRadius: '999px', fontSize: '0.75rem', fontWeight: 'bold',
                      backgroundColor: agent.winRate >= 50 ? 'rgba(16,185,129,0.1)' : 'rgba(239,68,68,0.1)',
                      color: agent.winRate >= 50 ? 'var(--success-color)' : '#ef4444'
                    }}>
                      {agent.winRate}%
                    </span>
                  </td>
                  <td style={tdNumStyle}>{agent.tasksCompleted}</td>
                  <td style={tdNumStyle}>{agent.callsMade}</td>
                  <td style={tdNumStyle}>{agent.emailsSent}</td>
                  <td style={tdNumStyle}>{agent.contactsAssigned}</td>
                </tr>
              ))}
            </tbody>
          </table>
          </TopScrollSync>
        </div>

        {/* Right Panel: Leaderboard Chart */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem' }}>
          <div className="card" style={{ padding: '1.5rem' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1rem' }}>
              <h3 style={{ fontSize: '1.1rem', fontWeight: '600', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                <Trophy size={18} color="#f59e0b" /> Leaderboard
              </h3>
              <select className="input-field" value={leaderMetric} onChange={e => setLeaderMetric(e.target.value)} style={{ width: '140px', padding: '0.4rem', fontSize: '0.8rem' }}>
                {METRIC_OPTIONS.map(m => <option key={m.value} value={m.value}>{m.label}</option>)}
              </select>
            </div>
            <div style={{ height: '280px' }}>
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={leaderboard.slice(0, 6)} layout="vertical" margin={{ left: 10, right: 20, top: 5, bottom: 5 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="var(--border-color)" horizontal={false} />
                  <XAxis type="number" stroke="var(--text-secondary)" tickLine={false} axisLine={false} tickFormatter={v => leaderMetric === 'revenue' ? formatMoney(v, { maximumFractionDigits: 0 }) : v} />
                  <YAxis dataKey="name" type="category" stroke="var(--text-secondary)" tickLine={false} axisLine={false} width={80} tick={{ fontSize: 11 }} />
                  <Tooltip wrapperStyle={{ zIndex: 9999 }} contentStyle={{ background: 'var(--tooltip-bg)', border: '1px solid var(--border-color)', borderRadius: '8px' }} formatter={v => leaderMetric === 'revenue' ? formatMoney(v) : v} />
                  <Bar dataKey="value" radius={[0, 4, 4, 0]}>
                    {leaderboard.slice(0, 6).map((_, i) => <Cell key={i} fill={COLORS[i % COLORS.length]} />)}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </div>
          </div>

          {/* Agent Detail Card */}
          {agentDetail && (
            <div className="card" style={{ padding: '1.5rem' }}>
              <h3 style={{ fontSize: '1.1rem', fontWeight: '600', marginBottom: '1rem' }}>
                {agentDetail.agent.name || agentDetail.agent.email}
              </h3>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.75rem', fontSize: '0.85rem' }}>
                <div>
                  <span style={{ color: 'var(--text-secondary)' }}>Deals:</span> <strong>{agentDetail.deals.length}</strong>
                </div>
                <div>
                  <span style={{ color: 'var(--text-secondary)' }}>Tasks:</span> <strong>{agentDetail.tasks.length}</strong>
                </div>
                <div>
                  <span style={{ color: 'var(--text-secondary)' }}>Calls:</span> <strong>{agentDetail.calls.length}</strong>
                </div>
                <div>
                  <span style={{ color: 'var(--text-secondary)' }}>Emails:</span> <strong>{agentDetail.emails.length}</strong>
                </div>
                <div style={{ gridColumn: 'span 2' }}>
                  <span style={{ color: 'var(--text-secondary)' }}>Assigned Contacts:</span> <strong>{agentDetail.contacts.length}</strong>
                </div>
              </div>
              {agentDetail.deals.length > 0 && (
                <div style={{ marginTop: '1rem' }}>
                  <h4 style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', fontWeight: '600', marginBottom: '0.5rem' }}>Recent Deals</h4>
                  {agentDetail.deals.slice(0, 5).map(d => (
                    <div key={d.id} style={{ padding: '0.4rem 0', borderBottom: '1px solid var(--border-color)', fontSize: '0.8rem', display: 'flex', justifyContent: 'space-between' }}>
                      <span>{d.title}</span>
                      <span style={{ color: 'var(--success-color)', fontWeight: '600' }}>{formatMoney(d.amount, { maximumFractionDigits: 0 })}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
