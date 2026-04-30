import { fetchApi } from '../utils/api';
import React, { useState, useEffect } from 'react';
import { ShoppingBag, Search, Download, RefreshCw, Settings, CheckCircle2, XCircle, AlertCircle, ExternalLink, Filter } from 'lucide-react';

const PROVIDERS = [
  { key: 'all', label: 'All Sources' },
  { key: 'indiamart', label: 'IndiaMART' },
  { key: 'justdial', label: 'JustDial' },
  { key: 'tradeindia', label: 'TradeIndia' },
];

const STATUS_COLORS = {
  New: { bg: 'rgba(59, 130, 246, 0.1)', color: '#3b82f6', border: 'rgba(59, 130, 246, 0.3)' },
  Imported: { bg: 'rgba(16, 185, 129, 0.1)', color: '#10b981', border: 'rgba(16, 185, 129, 0.3)' },
  Duplicate: { bg: 'rgba(245, 158, 11, 0.1)', color: '#f59e0b', border: 'rgba(245, 158, 11, 0.3)' },
  Dismissed: { bg: 'rgba(107, 114, 128, 0.1)', color: '#6b7280', border: 'rgba(107, 114, 128, 0.3)' },
};

const PROVIDER_COLORS = {
  indiamart: { bg: 'rgba(37, 99, 235, 0.1)', color: '#2563eb', label: 'IndiaMART' },
  justdial: { bg: 'rgba(220, 38, 38, 0.1)', color: '#dc2626', label: 'JustDial' },
  tradeindia: { bg: 'rgba(234, 88, 12, 0.1)', color: '#ea580c', label: 'TradeIndia' },
};

const MarketplaceLeads = () => {
  const [leads, setLeads] = useState([]);
  const [stats, setStats] = useState(null);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [searchTerm, setSearchTerm] = useState('');
  const [selectedLeads, setSelectedLeads] = useState([]);
  const [activeProvider, setActiveProvider] = useState('all');
  const [statusFilter, setStatusFilter] = useState('');
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [showConfig, setShowConfig] = useState(false);
  const [configs, setConfigs] = useState([]);
  const [configForm, setConfigForm] = useState({ provider: 'indiamart', apiKey: '', apiSecret: '', glueCrmKey: '', isActive: false });

  const fetchLeads = () => {
    setLoading(true);
    const params = new URLSearchParams({ page, limit: 50 });
    if (activeProvider !== 'all') params.set('provider', activeProvider);
    if (statusFilter) params.set('status', statusFilter);

    fetchApi(`/api/marketplace-leads?${params}`)
      .then(data => {
        setLeads(data.leads || []);
        setTotalPages(data.pages || 1);
        setLoading(false);
      })
      .catch(() => setLoading(false));
  };

  const fetchStats = () => {
    fetchApi('/api/marketplace-leads/stats')
      .then(data => setStats(data))
      .catch(() => {});
  };

  const fetchConfigs = () => {
    fetchApi('/api/marketplace-leads/config')
      .then(data => setConfigs(data))
      .catch(() => {});
  };

  useEffect(() => { fetchLeads(); }, [activeProvider, statusFilter, page]);
  useEffect(() => { fetchStats(); fetchConfigs(); }, []);

  const handleImport = async (id) => {
    await fetchApi(`/api/marketplace-leads/import/${id}`, { method: 'POST' });
    fetchLeads();
    fetchStats();
  };

  const handleBulkImport = async () => {
    if (selectedLeads.length === 0) return;
    await fetchApi('/api/marketplace-leads/import-bulk', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ leadIds: selectedLeads }),
    });
    setSelectedLeads([]);
    fetchLeads();
    fetchStats();
  };

  const handleDismiss = async (id) => {
    await fetchApi(`/api/marketplace-leads/dismiss/${id}`, { method: 'PUT' });
    fetchLeads();
    fetchStats();
  };

  const handleSync = async (provider) => {
    setSyncing(true);
    try {
      await fetchApi(`/api/marketplace-leads/sync/${provider}`, { method: 'POST' });
      fetchLeads();
      fetchStats();
    } catch (e) { /* handled */ }
    setSyncing(false);
  };

  const handleSaveConfig = async (provider) => {
    await fetchApi(`/api/marketplace-leads/config/${provider}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(configForm),
    });
    fetchConfigs();
  };

  const toggleSelect = (id) => {
    setSelectedLeads(prev => prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]);
  };

  const toggleSelectAll = () => {
    const newLeadIds = filteredLeads.filter(l => l.status === 'New').map(l => l.id);
    if (selectedLeads.length === newLeadIds.length) {
      setSelectedLeads([]);
    } else {
      setSelectedLeads(newLeadIds);
    }
  };

  const filteredLeads = leads.filter(lead => {
    if (!searchTerm) return true;
    const term = searchTerm.toLowerCase();
    return (
      (lead.name && lead.name.toLowerCase().includes(term)) ||
      (lead.email && lead.email.toLowerCase().includes(term)) ||
      (lead.phone && lead.phone.includes(term)) ||
      (lead.company && lead.company.toLowerCase().includes(term)) ||
      (lead.product && lead.product.toLowerCase().includes(term))
    );
  });

  const formatDate = (dateStr) => new Date(dateStr).toLocaleDateString('en-IN', { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });

  // ── Config Panel ──
  if (showConfig) {
    return (
      <div style={{ padding: '2rem', animation: 'fadeIn 0.3s ease' }}>
        <header style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '2rem' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
            <Settings size={24} style={{ color: 'var(--accent-color)' }} />
            <div>
              <h2 style={{ fontSize: '1.5rem', fontWeight: 'bold' }}>Marketplace Configuration</h2>
              <p style={{ color: 'var(--text-secondary)', fontSize: '0.875rem' }}>Connect your Indian marketplace accounts to auto-import leads</p>
            </div>
          </div>
          <button className="btn-primary" onClick={() => setShowConfig(false)} style={{ padding: '0.5rem 1rem' }}>Back to Leads</button>
        </header>

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(400px, 1fr))', gap: '1.5rem' }}>
          {['indiamart', 'justdial', 'tradeindia'].map(provider => {
            const existing = configs.find(c => c.provider === provider) || {};
            const prov = PROVIDER_COLORS[provider];
            return (
              <div key={provider} className="card" style={{ padding: '1.5rem' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1.25rem' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
                    <div style={{ width: 10, height: 10, borderRadius: '50%', background: existing.isActive ? '#10b981' : '#6b7280' }} />
                    <h3 style={{ fontWeight: '600', fontSize: '1.1rem', color: prov.color }}>{prov.label}</h3>
                  </div>
                  {existing.lastSyncAt && (
                    <span style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>Last sync: {formatDate(existing.lastSyncAt)}</span>
                  )}
                </div>

                <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
                  {provider === 'indiamart' && (
                    <div>
                      <label style={labelStyle}>CRM Key (glusr_crm_key)</label>
                      <input
                        className="input-field"
                        style={inputStyle}
                        placeholder="Enter IndiaMART CRM Key"
                        defaultValue={existing.glueCrmKey || ''}
                        onChange={e => setConfigForm(f => ({ ...f, provider, glueCrmKey: e.target.value }))}
                      />
                    </div>
                  )}
                  <div>
                    <label style={labelStyle}>API Key</label>
                    <input
                      className="input-field"
                      style={inputStyle}
                      placeholder="Enter API Key"
                      defaultValue={existing.apiKey || ''}
                      onChange={e => setConfigForm(f => ({ ...f, provider, apiKey: e.target.value }))}
                    />
                  </div>
                  <div>
                    <label style={labelStyle}>API Secret</label>
                    <input
                      className="input-field"
                      style={inputStyle}
                      type="password"
                      placeholder="Enter API Secret"
                      defaultValue={existing.apiSecret || ''}
                      onChange={e => setConfigForm(f => ({ ...f, provider, apiSecret: e.target.value }))}
                    />
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', marginTop: '0.5rem' }}>
                    <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', cursor: 'pointer' }}>
                      <input
                        type="checkbox"
                        defaultChecked={existing.isActive || false}
                        onChange={e => setConfigForm(f => ({ ...f, provider, isActive: e.target.checked }))}
                      />
                      <span style={{ fontSize: '0.875rem' }}>Enable auto-sync</span>
                    </label>
                  </div>
                  <div style={{ display: 'flex', gap: '0.75rem', marginTop: '0.5rem' }}>
                    <button className="btn-primary" onClick={() => handleSaveConfig(provider)} style={{ padding: '0.5rem 1rem', fontSize: '0.875rem' }}>
                      Save Configuration
                    </button>
                    <button
                      className="card"
                      onClick={() => handleSync(provider)}
                      disabled={syncing}
                      style={{ padding: '0.5rem 1rem', fontSize: '0.875rem', cursor: 'pointer', border: '1px solid var(--border-color)', display: 'flex', alignItems: 'center', gap: '0.375rem' }}
                    >
                      <RefreshCw size={14} className={syncing ? 'spin' : ''} /> Sync Now
                    </button>
                  </div>
                </div>
              </div>
            );
          })}
        </div>

        {/* Webhook URLs info */}
        <div className="card" style={{ padding: '1.5rem', marginTop: '1.5rem' }}>
          <h3 style={{ fontWeight: '600', marginBottom: '1rem' }}>Webhook URLs</h3>
          <p style={{ color: 'var(--text-secondary)', fontSize: '0.875rem', marginBottom: '1rem' }}>
            Configure these URLs in your marketplace provider dashboards to receive leads in real-time:
          </p>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
            {['indiamart', 'justdial', 'tradeindia'].map(p => (
              <div key={p} style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', padding: '0.5rem 0.75rem', background: 'var(--subtle-bg)', borderRadius: '6px' }}>
                <span style={{ fontWeight: '500', minWidth: '100px', color: PROVIDER_COLORS[p].color }}>{PROVIDER_COLORS[p].label}:</span>
                <code style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', flex: 1 }}>
                  {window.location.origin.replace(':5173', ':5000')}/api/marketplace-leads/webhook/{p}
                </code>
              </div>
            ))}
          </div>
        </div>
      </div>
    );
  }

  // ── Main Leads View ──
  return (
    <div style={{ padding: '2rem', animation: 'fadeIn 0.3s ease' }}>
      {/* Header */}
      <header style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1.5rem' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
          <ShoppingBag size={24} style={{ color: 'var(--accent-color)' }} />
          <div>
            <h2 style={{ fontSize: '1.5rem', fontWeight: 'bold' }}>Marketplace Leads</h2>
            <p style={{ color: 'var(--text-secondary)', fontSize: '0.875rem' }}>
              Auto-imported leads from IndiaMART, JustDial & TradeIndia
            </p>
          </div>
        </div>
        <div style={{ display: 'flex', gap: '0.75rem' }}>
          <button
            className="card"
            onClick={() => { const providers = configs.filter(c => c.isActive).map(c => c.provider); providers.forEach(p => handleSync(p)); }}
            disabled={syncing}
            style={{ padding: '0.5rem 1rem', fontSize: '0.875rem', cursor: 'pointer', border: '1px solid var(--border-color)', display: 'flex', alignItems: 'center', gap: '0.375rem' }}
          >
            <RefreshCw size={15} className={syncing ? 'spin' : ''} /> Sync All
          </button>
          <button className="btn-primary" onClick={() => setShowConfig(true)} style={{ padding: '0.5rem 1rem', fontSize: '0.875rem', display: 'flex', alignItems: 'center', gap: '0.375rem' }}>
            <Settings size={15} /> Configure
          </button>
        </div>
      </header>

      {/* Stats Cards */}
      {stats && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: '1rem', marginBottom: '1.5rem' }}>
          <div className="card" style={{ padding: '1.25rem' }}>
            <p style={{ color: 'var(--text-secondary)', fontSize: '0.75rem', textTransform: 'uppercase', marginBottom: '0.25rem' }}>Total Leads</p>
            <p style={{ fontSize: '1.75rem', fontWeight: 'bold' }}>{stats.total}</p>
          </div>
          <div className="card" style={{ padding: '1.25rem' }}>
            <p style={{ color: 'var(--text-secondary)', fontSize: '0.75rem', textTransform: 'uppercase', marginBottom: '0.25rem' }}>This Week</p>
            <p style={{ fontSize: '1.75rem', fontWeight: 'bold', color: '#3b82f6' }}>{stats.thisWeek}</p>
          </div>
          <div className="card" style={{ padding: '1.25rem' }}>
            <p style={{ color: 'var(--text-secondary)', fontSize: '0.75rem', textTransform: 'uppercase', marginBottom: '0.25rem' }}>Conversion Rate</p>
            <p style={{ fontSize: '1.75rem', fontWeight: 'bold', color: '#10b981' }}>{stats.conversionRate}%</p>
          </div>
          {stats.byProvider.map(p => (
            <div key={p.provider} className="card" style={{ padding: '1.25rem' }}>
              <p style={{ color: PROVIDER_COLORS[p.provider]?.color || 'var(--text-secondary)', fontSize: '0.75rem', textTransform: 'uppercase', marginBottom: '0.25rem' }}>
                {PROVIDER_COLORS[p.provider]?.label || p.provider}
              </p>
              <p style={{ fontSize: '1.75rem', fontWeight: 'bold' }}>{p.count}</p>
            </div>
          ))}
        </div>
      )}

      {/* Filters Bar */}
      <div style={{ display: 'flex', gap: '0.75rem', marginBottom: '1rem', flexWrap: 'wrap', alignItems: 'center' }}>
        {/* Provider Tabs */}
        <div style={{ display: 'flex', gap: '0.25rem', background: 'var(--subtle-bg)', borderRadius: '8px', padding: '0.25rem' }}>
          {PROVIDERS.map(p => (
            <button
              key={p.key}
              onClick={() => { setActiveProvider(p.key); setPage(1); }}
              style={{
                padding: '0.5rem 1rem',
                borderRadius: '6px',
                border: 'none',
                cursor: 'pointer',
                fontSize: '0.8rem',
                fontWeight: activeProvider === p.key ? '600' : '400',
                background: activeProvider === p.key ? 'var(--accent-color)' : 'transparent',
                color: activeProvider === p.key ? '#fff' : 'var(--text-secondary)',
                transition: 'all 0.2s ease',
              }}
            >
              {p.label}
            </button>
          ))}
        </div>

        {/* Status Filter */}
        <select
          className="input-field"
          value={statusFilter}
          onChange={e => { setStatusFilter(e.target.value); setPage(1); }}
          style={{ padding: '0.5rem 0.75rem', width: '150px', fontSize: '0.85rem' }}
        >
          <option value="">All Statuses</option>
          <option value="New">New</option>
          <option value="Imported">Imported</option>
          <option value="Duplicate">Duplicate</option>
          <option value="Dismissed">Dismissed</option>
        </select>

        {/* Search */}
        <div style={{ position: 'relative', flex: 1, minWidth: '200px' }}>
          <Search size={16} style={{ position: 'absolute', left: '0.75rem', top: '50%', transform: 'translateY(-50%)', color: 'var(--text-secondary)' }} />
          <input
            className="input-field"
            type="text"
            placeholder="Search leads by name, email, phone, company..."
            value={searchTerm}
            onChange={e => setSearchTerm(e.target.value)}
            style={{ width: '100%', padding: '0.5rem 0.75rem 0.5rem 2.25rem', fontSize: '0.85rem' }}
          />
        </div>
      </div>

      {/* Bulk Action Bar */}
      {selectedLeads.length > 0 && (
        <div className="card" style={{ padding: '0.75rem 1.25rem', marginBottom: '1rem', display: 'flex', alignItems: 'center', gap: '1rem', background: 'rgba(59, 130, 246, 0.08)', border: '1px solid rgba(59, 130, 246, 0.2)' }}>
          <Download size={18} color="var(--accent-color)" />
          <span style={{ fontWeight: '500', fontSize: '0.875rem' }}>{selectedLeads.length} lead{selectedLeads.length !== 1 ? 's' : ''} selected</span>
          <button className="btn-primary" onClick={handleBulkImport} style={{ padding: '0.5rem 1rem', fontSize: '0.875rem' }}>
            <CheckCircle2 size={15} style={{ marginRight: '0.375rem', verticalAlign: 'middle' }} />
            Import to CRM
          </button>
          <button onClick={() => setSelectedLeads([])} style={{ background: 'none', border: 'none', color: 'var(--text-secondary)', cursor: 'pointer', fontSize: '0.875rem' }}>
            Clear
          </button>
        </div>
      )}

      {/* Table */}
      {loading ? (
        <div style={{ textAlign: 'center', padding: '3rem', color: 'var(--text-secondary)' }}>Loading marketplace leads...</div>
      ) : filteredLeads.length === 0 ? (
        <div className="card" style={{ padding: '3rem', textAlign: 'center' }}>
          <ShoppingBag size={48} style={{ color: 'var(--text-secondary)', opacity: 0.3, marginBottom: '1rem' }} />
          <h3 style={{ color: 'var(--text-secondary)', marginBottom: '0.5rem' }}>No marketplace leads found</h3>
          <p style={{ color: 'var(--text-secondary)', fontSize: '0.875rem' }}>
            Configure your marketplace integrations to start receiving leads automatically.
          </p>
          {/* #368: empty-state CTA opens the inline config panel (no /integrations
              route exists in App.jsx). Secondary link goes to /marketplace, the
              actual existing integrations browser. */}
          <div style={{ display: 'flex', gap: '0.5rem', justifyContent: 'center', marginTop: '1rem', flexWrap: 'wrap' }}>
            <button className="btn-primary" onClick={() => setShowConfig(true)} style={{ padding: '0.5rem 1.25rem' }}>
              <Settings size={15} style={{ marginRight: '0.375rem', verticalAlign: 'middle' }} /> Configure Marketplaces
            </button>
            <a href="/marketplace" style={{ padding: '0.5rem 1.25rem', borderRadius: '6px', border: '1px solid var(--border-color)', color: 'var(--text-secondary)', textDecoration: 'none', fontSize: '0.875rem', display: 'inline-flex', alignItems: 'center' }}>
              Browse all integrations
            </a>
          </div>
        </div>
      ) : (
        <div className="card" style={{ overflow: 'hidden' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr style={{ borderBottom: '1px solid var(--border-color)' }}>
                <th style={thStyle}>
                  <input type="checkbox" onChange={toggleSelectAll} checked={selectedLeads.length > 0 && selectedLeads.length === filteredLeads.filter(l => l.status === 'New').length} />
                </th>
                <th style={thStyle}>Source</th>
                <th style={thStyle}>Name</th>
                <th style={thStyle}>Contact</th>
                <th style={thStyle}>Company</th>
                <th style={thStyle}>Product / Inquiry</th>
                <th style={thStyle}>City</th>
                <th style={thStyle}>Status</th>
                <th style={thStyle}>Date</th>
                <th style={thStyle}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {filteredLeads.map(lead => {
                const prov = PROVIDER_COLORS[lead.provider] || { bg: '#eee', color: '#666', label: lead.provider };
                const sc = STATUS_COLORS[lead.status] || STATUS_COLORS.New;
                return (
                  <tr key={lead.id} style={{ borderBottom: '1px solid var(--border-color)', transition: 'background 0.15s' }}
                    onMouseEnter={e => e.currentTarget.style.background = 'var(--subtle-bg)'}
                    onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
                  >
                    <td style={tdStyle}>
                      {lead.status === 'New' && (
                        <input type="checkbox" checked={selectedLeads.includes(lead.id)} onChange={() => toggleSelect(lead.id)} />
                      )}
                    </td>
                    <td style={tdStyle}>
                      <span style={{ padding: '0.2rem 0.5rem', borderRadius: '4px', fontSize: '0.7rem', fontWeight: '600', background: prov.bg, color: prov.color }}>
                        {prov.label}
                      </span>
                    </td>
                    <td style={{ ...tdStyle, fontWeight: '500' }}>{lead.name || '—'}</td>
                    <td style={tdStyle}>
                      <div style={{ fontSize: '0.8rem' }}>
                        {lead.email && <div>{lead.email}</div>}
                        {lead.phone && <div style={{ color: 'var(--text-secondary)' }}>{lead.phone}</div>}
                      </div>
                    </td>
                    <td style={tdStyle}>{lead.company || '—'}</td>
                    <td style={{ ...tdStyle, maxWidth: '200px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {lead.product || lead.message?.slice(0, 50) || '—'}
                    </td>
                    <td style={tdStyle}>{lead.city || '—'}</td>
                    <td style={tdStyle}>
                      <span style={{ padding: '0.2rem 0.5rem', borderRadius: '4px', fontSize: '0.7rem', fontWeight: '600', background: sc.bg, color: sc.color, border: `1px solid ${sc.border}` }}>
                        {lead.status}
                      </span>
                    </td>
                    <td style={{ ...tdStyle, fontSize: '0.8rem', color: 'var(--text-secondary)' }}>{formatDate(lead.createdAt)}</td>
                    <td style={tdStyle}>
                      {lead.status === 'New' && (
                        <div style={{ display: 'flex', gap: '0.375rem' }}>
                          <button
                            onClick={() => handleImport(lead.id)}
                            title="Import to CRM"
                            style={{ background: 'rgba(16, 185, 129, 0.1)', border: '1px solid rgba(16, 185, 129, 0.3)', borderRadius: '4px', padding: '0.25rem 0.5rem', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '0.25rem', color: '#10b981', fontSize: '0.75rem' }}
                          >
                            <CheckCircle2 size={13} /> Import
                          </button>
                          <button
                            onClick={() => handleDismiss(lead.id)}
                            title="Dismiss"
                            style={{ background: 'rgba(107, 114, 128, 0.1)', border: '1px solid rgba(107, 114, 128, 0.3)', borderRadius: '4px', padding: '0.25rem 0.5rem', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '0.25rem', color: '#6b7280', fontSize: '0.75rem' }}
                          >
                            <XCircle size={13} />
                          </button>
                        </div>
                      )}
                      {lead.status === 'Imported' && lead.contactId && (
                        <a href={`/contacts/${lead.contactId}`} style={{ color: 'var(--accent-color)', fontSize: '0.75rem', display: 'flex', alignItems: 'center', gap: '0.25rem', textDecoration: 'none' }}>
                          <ExternalLink size={13} /> View Contact
                        </a>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>

          {/* Pagination */}
          {totalPages > 1 && (
            <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', gap: '0.5rem', padding: '1rem', borderTop: '1px solid var(--border-color)' }}>
              <button
                disabled={page <= 1}
                onClick={() => setPage(p => p - 1)}
                style={{ padding: '0.375rem 0.75rem', borderRadius: '6px', border: '1px solid var(--border-color)', background: 'transparent', color: 'var(--text-primary)', cursor: page <= 1 ? 'default' : 'pointer', opacity: page <= 1 ? 0.5 : 1 }}
              >
                Previous
              </button>
              <span style={{ fontSize: '0.85rem', color: 'var(--text-secondary)' }}>
                Page {page} of {totalPages}
              </span>
              <button
                disabled={page >= totalPages}
                onClick={() => setPage(p => p + 1)}
                style={{ padding: '0.375rem 0.75rem', borderRadius: '6px', border: '1px solid var(--border-color)', background: 'transparent', color: 'var(--text-primary)', cursor: page >= totalPages ? 'default' : 'pointer', opacity: page >= totalPages ? 0.5 : 1 }}
              >
                Next
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
};

const thStyle = {
  padding: '0.75rem 1rem',
  textAlign: 'left',
  fontSize: '0.75rem',
  fontWeight: '600',
  color: 'var(--text-secondary)',
  textTransform: 'uppercase',
  letterSpacing: '0.05em',
};

const tdStyle = {
  padding: '0.75rem 1rem',
  fontSize: '0.85rem',
};

const labelStyle = {
  display: 'block',
  fontSize: '0.8rem',
  fontWeight: '500',
  marginBottom: '0.25rem',
  color: 'var(--text-secondary)',
};

const inputStyle = {
  width: '100%',
  padding: '0.5rem 0.75rem',
  fontSize: '0.85rem',
};

export default MarketplaceLeads;
