import React, { useState, useEffect } from 'react';
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Cell } from 'recharts';
import { fetchApi } from '../utils/api';
import { Trophy, Users, TrendingUp, Phone, Mail, CheckSquare, Download, Calendar } from 'lucide-react';

const COLORS = ['#3b82f6', '#a855f7', '#10b981', '#f59e0b', '#ef4444', '#ec4899', '#6366f1', '#14b8a6'];
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

  const handleExportCSV = () => {
    const token = localStorage.getItem('token');
    const baseUrl = import.meta.env.VITE_API_URL || '';
    fetch(`${baseUrl}/api/reports/export-csv?type=agent-performance${dateParams()}`, { headers: { Authorization: `Bearer ${token}` } })
      .then(res => res.blob())
      .then(blob => {
        const link = document.createElement('a');
        link.href = URL.createObjectURL(blob);
        link.download = 'agent-performance.csv';
        link.click();
        URL.revokeObjectURL(link.href);
      });
  };

  const handleExportPDF = () => {
    const token = localStorage.getItem('token');
    const baseUrl = import.meta.env.VITE_API_URL || '';
    fetch(`${baseUrl}/api/reports/export-pdf?type=agent-performance${dateParams()}`, { headers: { Authorization: `Bearer ${token}` } })
      .then(res => res.blob())
      .then(blob => {
        const link = document.createElement('a');
        link.href = URL.createObjectURL(blob);
        link.download = 'agent-performance.pdf';
        link.click();
        URL.revokeObjectURL(link.href);
      });
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
          <button className="btn-secondary" onClick={handleExportCSV} style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <Download size={16} /> CSV
          </button>
          <button className="btn-primary" onClick={handleExportPDF} style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <Download size={16} /> PDF
          </button>
        </div>
      </header>

      {/* Summary Stats */}
      {!loading && agents.length > 0 && (
        <div style={{ display: 'flex', gap: '1rem', marginBottom: '1.5rem', flexWrap: 'wrap' }}>
          <StatCard icon={Users} label="Total Agents" value={agents.length} color="#3b82f6" />
          <StatCard icon={TrendingUp} label="Total Revenue" value={`$${agents.reduce((s, a) => s + a.revenue, 0).toLocaleString()}`} color="#10b981" />
          <StatCard icon={Trophy} label="Deals Won" value={agents.reduce((s, a) => s + a.dealsWon, 0)} color="#f59e0b" />
          <StatCard icon={Phone} label="Total Calls" value={agents.reduce((s, a) => s + a.callsMade, 0)} color="#a855f7" />
          <StatCard icon={Mail} label="Emails Sent" value={agents.reduce((s, a) => s + a.emailsSent, 0)} color="#ec4899" />
          <StatCard icon={CheckSquare} label="Tasks Done" value={agents.reduce((s, a) => s + a.tasksCompleted, 0)} color="#6366f1" />
        </div>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 380px', gap: '1.5rem', alignItems: 'start' }}>
        {/* Agent Performance Table */}
        <div className="card" style={{ overflow: 'hidden' }}>
          <div style={{ padding: '1.25rem', borderBottom: '1px solid var(--border-color)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <h3 style={{ fontSize: '1.1rem', fontWeight: '600', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
              <Users size={18} color="var(--accent-color)" /> Agent Performance
            </h3>
          </div>
          <table style={{ width: '100%', borderCollapse: 'collapse', textAlign: 'left' }}>
            <thead>
              <tr style={{ borderBottom: '1px solid var(--border-color)', backgroundColor: 'var(--table-header-bg)' }}>
                <th style={{ padding: '0.875rem 1rem', color: 'var(--text-secondary)', fontWeight: '500', fontSize: '0.8rem' }}>#</th>
                <th style={{ padding: '0.875rem 1rem', color: 'var(--text-secondary)', fontWeight: '500', fontSize: '0.8rem' }}>Agent</th>
                <th style={{ padding: '0.875rem 1rem', color: 'var(--text-secondary)', fontWeight: '500', fontSize: '0.8rem' }}>Revenue</th>
                <th style={{ padding: '0.875rem 1rem', color: 'var(--text-secondary)', fontWeight: '500', fontSize: '0.8rem' }}>Deals</th>
                <th style={{ padding: '0.875rem 1rem', color: 'var(--text-secondary)', fontWeight: '500', fontSize: '0.8rem' }}>Win %</th>
                <th style={{ padding: '0.875rem 1rem', color: 'var(--text-secondary)', fontWeight: '500', fontSize: '0.8rem' }}>Tasks</th>
                <th style={{ padding: '0.875rem 1rem', color: 'var(--text-secondary)', fontWeight: '500', fontSize: '0.8rem' }}>Calls</th>
                <th style={{ padding: '0.875rem 1rem', color: 'var(--text-secondary)', fontWeight: '500', fontSize: '0.8rem' }}>Emails</th>
                <th style={{ padding: '0.875rem 1rem', color: 'var(--text-secondary)', fontWeight: '500', fontSize: '0.8rem' }}>Contacts</th>
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
                  <td style={{ padding: '0.875rem 1rem', fontWeight: '600', color: i < 3 ? '#f59e0b' : 'var(--text-secondary)' }}>
                    {i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : i + 1}
                  </td>
                  <td style={{ padding: '0.875rem 1rem' }}>
                    <div style={{ fontWeight: '500' }}>{agent.name}</div>
                    <div style={{ fontSize: '0.7rem', color: 'var(--text-secondary)' }}>{agent.role}</div>
                  </td>
                  <td style={{ padding: '0.875rem 1rem', fontWeight: '600', color: 'var(--success-color)' }}>${agent.revenue.toLocaleString()}</td>
                  <td style={{ padding: '0.875rem 1rem' }}>{agent.dealsWon}/{agent.dealsTotal}</td>
                  <td style={{ padding: '0.875rem 1rem' }}>
                    <span style={{
                      padding: '0.2rem 0.6rem', borderRadius: '999px', fontSize: '0.75rem', fontWeight: 'bold',
                      backgroundColor: agent.winRate >= 50 ? 'rgba(16,185,129,0.1)' : 'rgba(239,68,68,0.1)',
                      color: agent.winRate >= 50 ? 'var(--success-color)' : '#ef4444'
                    }}>
                      {agent.winRate}%
                    </span>
                  </td>
                  <td style={{ padding: '0.875rem 1rem' }}>{agent.tasksCompleted}</td>
                  <td style={{ padding: '0.875rem 1rem' }}>{agent.callsMade}</td>
                  <td style={{ padding: '0.875rem 1rem' }}>{agent.emailsSent}</td>
                  <td style={{ padding: '0.875rem 1rem' }}>{agent.contactsAssigned}</td>
                </tr>
              ))}
            </tbody>
          </table>
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
                  <XAxis type="number" stroke="var(--text-secondary)" tickLine={false} axisLine={false} tickFormatter={v => leaderMetric === 'revenue' ? `$${v / 1000}k` : v} />
                  <YAxis dataKey="name" type="category" stroke="var(--text-secondary)" tickLine={false} axisLine={false} width={80} tick={{ fontSize: 11 }} />
                  <Tooltip contentStyle={{ background: 'var(--tooltip-bg)', border: '1px solid var(--border-color)', borderRadius: '8px' }} formatter={v => leaderMetric === 'revenue' ? `$${v.toLocaleString()}` : v} />
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
                      <span style={{ color: 'var(--success-color)', fontWeight: '600' }}>${d.amount.toLocaleString()}</span>
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
