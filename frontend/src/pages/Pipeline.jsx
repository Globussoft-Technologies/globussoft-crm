import React, { useState, useEffect, useContext, useCallback, useMemo } from 'react';
import { useSearchParams, Link } from 'react-router-dom';
import { Briefcase, Plus, Download, Search, Filter, RefreshCw, Pencil, Trash2, X, Zap } from 'lucide-react';
import { fetchApi } from '../utils/api';
import { useNotify } from '../utils/notify';
import { formatMoney, currencySymbol } from '../utils/money';
import { io } from 'socket.io-client';
import DealModal from '../components/DealModal';
import { AuthContext } from '../App';
import TopScrollSync from '../components/TopScrollSync';

// Slugify a PipelineStage.name → stage column id.
export const slugifyStageName = (name) =>
  String(name || '')
    .toLowerCase()
    .trim()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9-]/g, '');

// Virtualization threshold (kept for test compatibility)
export const VIRTUALIZATION_THRESHOLD = 100;

// Travel-vertical sub-brands
const TRAVEL_SUB_BRANDS = [
  { value: '', label: 'All sub-brands' },
  { value: 'tmc', label: 'TMC (School trips)' },
  { value: 'rfu', label: 'RFU (Umrah)' },
  { value: 'travelstall', label: 'Travel Stall' },
  { value: 'visasure', label: 'Visa Sure' },
];

// Stage → colour (used for inline badge)
const STAGE_COLORS = {
  new: { bg: 'rgba(59,130,246,0.12)', color: '#3b82f6' },
  lead: { bg: 'rgba(59,130,246,0.12)', color: '#3b82f6' },
  'new-lead': { bg: 'rgba(59,130,246,0.12)', color: '#3b82f6' },
  contacted: { bg: 'rgba(234,179,8,0.14)', color: '#a16207' },
  'diagnostic-complete': { bg: 'rgba(99,102,241,0.12)', color: '#6366f1' },
  qualifying: { bg: 'rgba(168,85,247,0.12)', color: '#9333ea' },
  proposal: { bg: 'rgba(234,179,8,0.14)', color: '#a16207' },
  'proposal-sent': { bg: 'rgba(234,179,8,0.14)', color: '#a16207' },
  quoted: { bg: 'rgba(249,115,22,0.12)', color: '#ea580c' },
  negotiation: { bg: 'rgba(249,115,22,0.12)', color: '#ea580c' },
  negotiating: { bg: 'rgba(249,115,22,0.12)', color: '#ea580c' },
  won: { bg: 'rgba(34,197,94,0.14)', color: '#16a34a' },
  'closed-won': { bg: 'rgba(34,197,94,0.14)', color: '#16a34a' },
  lost: { bg: 'rgba(239,68,68,0.12)', color: '#dc2626' },
  dormant: { bg: 'rgba(107,114,128,0.12)', color: '#6b7280' },
};

const WON_STAGES = new Set(['won', 'closed-won']);
const LOST_STAGES = new Set(['lost']);
const ACTIVE_STAGES = new Set(['contacted', 'proposal', 'proposal-sent', 'qualifying', 'quoted', 'negotiation', 'negotiating', 'diagnostic-complete']);

function stageStyle(stageId) {
  return STAGE_COLORS[stageId] || { bg: 'rgba(107,114,128,0.1)', color: '#6b7280' };
}

function fmt(dateStr) {
  if (!dateStr) return '—';
  const d = new Date(dateStr);
  if (isNaN(d)) return '—';
  return d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
}

function exportCsv(rows, stages) {
  const stageMap = Object.fromEntries(stages.map((s) => [s.id, s.title]));
  const headers = ['ID', 'Title', 'Company', 'Contact', 'Amount', 'Currency', 'Stage', 'Probability', 'Expected close', 'Created'];
  const lines = [
    headers.join(','),
    ...rows.map((d) => [
      d.id,
      `"${(d.title || '').replace(/"/g, '""')}"`,
      `"${(d.company || '').replace(/"/g, '""')}"`,
      `"${(d.contactName || '').replace(/"/g, '""')}"`,
      d.amount || '',
      d.currency || '',
      stageMap[d.stage] || d.stage || '',
      d.probability != null ? d.probability : '',
      d.expectedCloseDate ? fmt(d.expectedCloseDate) : '',
      fmt(d.createdAt),
    ].join(',')),
  ];
  const blob = new Blob([lines.join('\n')], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `pipeline-${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

const EMPTY_FORM = {
  title: '', company: '', contactName: '', amount: '', probability: '50', stage: '',
};

const Pipeline = () => {
  const notify = useNotify();
  const { user } = useContext(AuthContext) || {};
  const isTravelTenant = user?.tenant?.vertical === 'travel';

  const [deals, setDeals] = useState([]);
  const [contacts, setContacts] = useState([]);
  const [stages, setStages] = useState([]);
  const [loading, setLoading] = useState(true);

  // Filters
  const [searchParams, setSearchParams] = useSearchParams();
  const _validSubBrands = TRAVEL_SUB_BRANDS.map((sb) => sb.value).filter(Boolean);
  const parseSubBrandParam = (raw) => {
    if (!raw) return '';
    const first = raw.split(',').map((s) => s.trim()).find((s) => _validSubBrands.includes(s));
    return first || '';
  };
  const [selectedSubBrand, setSelectedSubBrand] = useState(() =>
    parseSubBrandParam(searchParams.get('subBrand')),
  );
  const [filterStage, setFilterStage] = useState('');
  const [search, setSearch] = useState('');

  // Inline stage update
  const [updatingId, setUpdatingId] = useState(null);

  // Delete
  const [deletingId, setDeletingId] = useState(null);

  // Modals
  const [showCreate, setShowCreate] = useState(false);
  const [form, setForm] = useState(EMPTY_FORM);
  const [saving, setSaving] = useState(false);
  const [selectedDeal, setSelectedDeal] = useState(null);
  const [aiScoreModal, setAiScoreModal] = useState(null);

  // Sub-brand ↔ URL sync
  useEffect(() => {
    const current = searchParams.get('subBrand') || '';
    if (!selectedSubBrand) {
      if (current) { searchParams.delete('subBrand'); setSearchParams(searchParams, { replace: true }); }
      return;
    }
    if (current !== selectedSubBrand) {
      searchParams.set('subBrand', selectedSubBrand);
      setSearchParams(searchParams, { replace: true });
    }
  }, [selectedSubBrand]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const fromUrl = parseSubBrandParam(searchParams.get('subBrand'));
    if (fromUrl !== selectedSubBrand) setSelectedSubBrand(fromUrl);
  }, [searchParams]); // eslint-disable-line react-hooks/exhaustive-deps

  // Load all data
  const load = useCallback(() => {
    setLoading(true);
    Promise.all([
      fetchApi('/api/deals').catch(() => []),
      fetchApi('/api/contacts').catch(() => []),
      fetchApi('/api/pipeline_stages').catch(() => []),
    ]).then(([dealData, contactData, stageData]) => {
      setDeals(Array.isArray(dealData) ? dealData : []);
      setContacts(Array.isArray(contactData) ? contactData : []);
      if (Array.isArray(stageData) && stageData.length > 0) {
        const seen = new Set();
        const deduped = [];
        for (const s of stageData) {
          const id = slugifyStageName(s.name);
          if (!id || seen.has(id)) continue;
          seen.add(id);
          deduped.push({ id, title: s.name, color: s.color, dbId: s.id });
        }
        if (deduped.length > 0) setStages(deduped);
      }
      setLoading(false);
    }).catch(() => setLoading(false));
  }, []);

  useEffect(() => {
    load();
    const socket = io('/', { reconnection: false, timeout: 5000 });
    socket.on('connect_error', () => {});
    socket.on('error', () => {});
    socket.on('deal_updated', (updated) => {
      setDeals((prev) => {
        const exists = prev.find((d) => d.id === updated.id);
        return exists ? prev.map((d) => d.id === updated.id ? updated : d) : [updated, ...prev];
      });
    });
    socket.on('deal_deleted', (id) => setDeals((prev) => prev.filter((d) => d.id !== id)));
    return () => socket.disconnect();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Visible rows after filters
  const visible = useMemo(() => {
    let rows = deals;
    if (selectedSubBrand) rows = rows.filter((d) => d.subBrand === selectedSubBrand);
    if (filterStage)      rows = rows.filter((d) => d.stage === filterStage);
    const q = search.trim().toLowerCase();
    if (q) rows = rows.filter((d) =>
      (d.title || '').toLowerCase().includes(q) ||
      (d.company || '').toLowerCase().includes(q) ||
      (d.contactName || '').toLowerCase().includes(q),
    );
    return rows;
  }, [deals, selectedSubBrand, filterStage, search]);

  // KPI tiles — computed from all (unfiltered) deals for accuracy
  const kpis = useMemo(() => {
    let total = 0, won = 0, active = 0, lost = 0;
    for (const d of deals) {
      const amt = Number(d.amount) || 0;
      total += amt;
      if (WON_STAGES.has(d.stage))    won    += amt;
      if (ACTIVE_STAGES.has(d.stage)) active += amt;
      if (LOST_STAGES.has(d.stage))   lost   += amt;
    }
    return { total, won, active, lost };
  }, [deals]);

  // Stage options for filter/form
  const stageOptions = useMemo(() => stages, [stages]);

  // Inline stage update
  const updateStage = async (id, newStage) => {
    setUpdatingId(id);
    const prev = deals;
    setDeals((d) => d.map((x) => x.id === id ? { ...x, stage: newStage } : x));
    try {
      await fetchApi(`/api/deals/${id}`, {
        method: 'PUT',
        body: JSON.stringify({ stage: newStage }),
      });
    } catch (e) {
      setDeals(prev);
      notify.error(e?.body?.error || 'Failed to update stage');
    } finally {
      setUpdatingId(null);
    }
  };

  // Delete
  const remove = async (deal) => {
    const ok = await notify.confirm({
      title: 'Delete deal',
      message: `Delete "${deal.title}"? This cannot be undone.`,
      confirmText: 'Delete',
      destructive: true,
    });
    if (!ok) return;
    setDeletingId(deal.id);
    try {
      await fetchApi(`/api/deals/${deal.id}`, { method: 'DELETE' });
      setDeals((prev) => prev.filter((d) => d.id !== deal.id));
      notify.success('Deal deleted');
    } catch (e) {
      notify.error(e?.body?.error || 'Failed to delete');
    } finally {
      setDeletingId(null);
    }
  };

  // Create
  const openCreate = () => {
    setForm({ ...EMPTY_FORM, stage: stageOptions[0]?.id || 'lead' });
    setShowCreate(true);
  };

  const submitCreate = async (e) => {
    e.preventDefault();
    if (!form.title.trim()) { notify.error('Title is required'); return; }
    setSaving(true);
    try {
      const body = {
        title: form.title.trim(),
        company: form.company.trim() || undefined,
        contactName: form.contactName.trim() || undefined,
        amount: form.amount ? parseFloat(form.amount) : 0,
        probability: form.probability ? parseInt(form.probability, 10) : 50,
        stage: form.stage || stageOptions[0]?.id || 'lead',
      };
      const created = await fetchApi('/api/deals', { method: 'POST', body: JSON.stringify(body) });
      if (created && created.id) setDeals((prev) => [created, ...prev]);
      notify.success('Deal created');
      setShowCreate(false);
    } catch (err) {
      notify.error(err?.body?.error || err?.message || 'Failed to create deal');
    } finally {
      setSaving(false);
    }
  };

  // AI score
  const fetchAiScore = async (e, dealId) => {
    e.stopPropagation();
    try {
      const data = await fetchApi(`/api/ai_scoring/score/${dealId}`);
      setAiScoreModal(data);
    } catch {
      notify.error('Failed to connect to AI Predictor.');
    }
  };

  // Stage select component
  function StageSelect({ deal }) {
    const s = stageStyle(deal.stage);
    return (
      <select
        value={deal.stage || ''}
        disabled={updatingId === deal.id}
        onChange={(ev) => updateStage(deal.id, ev.target.value)}
        aria-label="Change stage"
        onClick={(ev) => ev.stopPropagation()}
        style={{
          background: s.bg,
          color: s.color,
          border: `1px solid ${s.color}33`,
          borderRadius: 20,
          padding: '4px 22px 4px 10px',
          fontSize: 12,
          fontWeight: 600,
          cursor: updatingId === deal.id ? 'wait' : 'pointer',
          opacity: updatingId === deal.id ? 0.6 : 1,
          appearance: 'none',
          WebkitAppearance: 'none',
          backgroundImage: `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='6'%3E%3Cpath d='M0 0l5 6 5-6z' fill='${encodeURIComponent(s.color)}'/%3E%3C/svg%3E")`,
          backgroundRepeat: 'no-repeat',
          backgroundPosition: 'right 6px center',
          minWidth: 110,
        }}
      >
        {stageOptions.map((st) => (
          <option key={st.id} value={st.id} style={{ background: 'var(--bg-color)', color: 'var(--text-primary)' }}>
            {st.title}
          </option>
        ))}
      </select>
    );
  }

  return (
    <div style={{ padding: '24px 28px', maxWidth: 1320, margin: '0 auto' }}>

      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap', marginBottom: 6 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <div style={{
            width: 32, height: 32, borderRadius: 8,
            background: 'var(--subtle-bg)', border: '1px solid var(--border-color)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}>
            <Briefcase size={16} style={{ color: 'var(--accent-color)' }} />
          </div>
          <h1 style={{ margin: 0, fontSize: 22, fontWeight: 700, color: 'var(--text-primary)' }}>
            Sales Pipeline
          </h1>
          <span style={{
            fontSize: 12, color: 'var(--success-color)', marginLeft: 4,
            padding: '2px 10px', borderRadius: 12,
            border: '1px solid var(--success-color)',
            background: 'rgba(16,185,129,0.08)',
            fontWeight: 600,
          }}>
            Live Sync Active
          </span>
        </div>
        <div style={{ display: 'flex', gap: 10 }}>
          <button type="button" onClick={() => exportCsv(visible, stageOptions)} style={secondaryBtn} title="Export to CSV">
            <Download size={14} /> Export
          </button>
          <button type="button" onClick={openCreate} style={primaryBtn}>
            <Plus size={14} /> Add Deal
          </button>
        </div>
      </div>

      <p style={{ margin: '0 0 20px 0', fontSize: 13.5, color: 'var(--text-secondary)' }}>
        {stageOptions.length > 0
          ? stageOptions.map((s, i) => (
              <span key={s.id}>{i > 0 && ' / '}<strong style={{ color: 'var(--text-primary)' }}>{s.title}</strong></span>
            ))
          : 'Sales pipeline'
        }. <strong style={{ color: 'var(--text-primary)' }}>{deals.length}</strong> deal{deals.length !== 1 ? 's' : ''}.
      </p>

      {/* Filters */}
      <div style={{
        display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'center',
        background: 'var(--surface-color)',
        border: '1px solid var(--border-color)',
        borderRadius: 12, padding: '14px 16px',
        marginBottom: 18,
      }}>
        <Filter size={14} aria-hidden style={{ color: 'var(--text-secondary)', flexShrink: 0 }} />

        {/* Sub-brand filter — travel tenants only */}
        {isTravelTenant && (
          <select
            value={selectedSubBrand}
            onChange={(e) => setSelectedSubBrand(e.target.value)}
            aria-label="Filter by sub-brand"
            style={selectStyle}
          >
            {TRAVEL_SUB_BRANDS.map((sb) => (
              <option key={sb.value || 'all'} value={sb.value}>{sb.label}</option>
            ))}
          </select>
        )}

        {/* Stage filter */}
        <select
          value={filterStage}
          onChange={(e) => setFilterStage(e.target.value)}
          aria-label="Filter by stage"
          style={selectStyle}
        >
          <option value="">All stages</option>
          {stageOptions.map((s) => (
            <option key={s.id} value={s.id}>{s.title}</option>
          ))}
        </select>

        {/* Search */}
        <div style={{ position: 'relative', display: 'flex', alignItems: 'center' }}>
          <Search size={13} aria-hidden style={{ position: 'absolute', left: 9, color: 'var(--text-secondary)', pointerEvents: 'none' }} />
          <input
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search title, company, contact…"
            aria-label="Search deals"
            style={{ ...selectStyle, paddingLeft: 30, minWidth: 220 }}
          />
        </div>

        <button type="button" onClick={load} style={secondaryBtn} title="Refresh" aria-label="Refresh deals">
          <RefreshCw size={13} />
        </button>
      </div>

      {/* KPI tiles */}
      <div style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 180px), 1fr))',
        gap: 12, marginBottom: 20,
      }}>
        {[
          { label: 'Total pipeline value', val: kpis.total, color: 'var(--text-primary)' },
          { label: 'Won',                  val: kpis.won,    color: 'var(--success-color, #16a34a)' },
          { label: 'In negotiation',       val: kpis.active, color: 'var(--warning-color, #a16207)' },
          { label: 'Lost',                 val: kpis.lost,   color: 'var(--danger-color, #dc2626)' },
        ].map((tile) => (
          <div key={tile.label} style={{
            background: 'var(--surface-color)',
            border: '1px solid var(--border-color)',
            borderRadius: 12, padding: '14px 16px',
          }}>
            <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginBottom: 6 }}>{tile.label}</div>
            <div style={{ fontSize: 21, fontWeight: 700, color: tile.color }}>
              {formatMoney(tile.val)}
            </div>
          </div>
        ))}
      </div>

      {/* Table */}
      <div style={{
        background: 'var(--surface-color)',
        border: '1px solid var(--border-color)',
        borderRadius: 12, overflow: 'hidden',
      }}>
        {loading ? (
          <div style={emptyStyle}>Loading deals…</div>
        ) : visible.length === 0 ? (
          <div style={emptyStyle}>
            {deals.length === 0
              ? 'No deals yet. Click "+ Add Deal" to create the first one.'
              : 'No deals match the current filters.'}
          </div>
        ) : (
          <TopScrollSync>
            <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 760 }}>
              <thead>
                <tr>
                  {['Deal title', 'Contact', 'Company', 'Amount', 'Expected close', 'Stage', 'Prob.', 'Actions'].map((h) => (
                    <th key={h} style={thStyle}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {visible.map((deal) => {
                  const sc = stageStyle(deal.stage);
                  return (
                    <tr
                      key={deal.id}
                      style={{ borderTop: '1px solid var(--border-color)', cursor: 'pointer' }}
                      onClick={() => setSelectedDeal(deal)}
                      onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--subtle-bg)'; }}
                      onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
                    >
                      {/* Title */}
                      <td style={tdStyle}>
                        <span style={{ fontWeight: 600, fontSize: 14, color: 'var(--text-primary)' }}>
                          {deal.title}
                        </span>
                        {deal.subBrand && (
                          <div style={{ fontSize: 11, color: 'var(--text-secondary)', marginTop: 2 }}>
                            {deal.subBrand}
                          </div>
                        )}
                      </td>

                      {/* Contact */}
                      <td style={tdStyle}>
                        <span style={{ color: 'var(--text-secondary)', fontSize: 13.5 }}>
                          {deal.contactName || '—'}
                        </span>
                      </td>

                      {/* Company */}
                      <td style={tdStyle}>
                        {deal.company ? (
                          <span style={{
                            display: 'inline-block',
                            padding: '3px 9px', borderRadius: 6,
                            fontSize: 12, fontWeight: 600,
                            background: 'var(--subtle-bg-3)',
                            color: 'var(--text-secondary)',
                          }}>
                            {deal.company}
                          </span>
                        ) : <span style={{ color: 'var(--text-secondary)' }}>—</span>}
                      </td>

                      {/* Amount */}
                      <td style={{ ...tdStyle, fontVariantNumeric: 'tabular-nums', fontWeight: 600, color: 'var(--text-primary)' }}>
                        {deal.amount != null && deal.amount !== ''
                          ? formatMoney(deal.amount, { currency: deal.currency })
                          : <span style={{ color: 'var(--text-secondary)' }}>—</span>}
                      </td>

                      {/* Expected close */}
                      <td style={{ ...tdStyle, whiteSpace: 'nowrap', color: 'var(--text-secondary)' }}>
                        {fmt(deal.expectedCloseDate)}
                      </td>

                      {/* Stage — inline editable */}
                      <td style={tdStyle} onClick={(e) => e.stopPropagation()}>
                        <StageSelect deal={deal} />
                      </td>

                      {/* Probability */}
                      <td style={tdStyle}>
                        <span style={{
                          display: 'inline-block',
                          padding: '3px 8px', borderRadius: 4,
                          fontSize: 12, fontWeight: 700,
                          background: `${sc.color}20`,
                          color: sc.color,
                        }}>
                          {deal.probability != null ? `${deal.probability}%` : '—'}
                        </span>
                      </td>

                      {/* Actions */}
                      <td style={{ ...tdStyle, textAlign: 'right' }} onClick={(e) => e.stopPropagation()}>
                        <div style={{ display: 'flex', gap: 4, justifyContent: 'flex-end' }}>
                          <button
                            type="button"
                            onClick={(e) => fetchAiScore(e, deal.id)}
                            title="AI Predictive Score"
                            aria-label={`Generate deal score for ${deal.title}`}
                            style={{ ...iconBtnStyle, color: '#a855f7' }}
                          >
                            <Zap size={13} />
                          </button>
                          <button
                            type="button"
                            onClick={() => setSelectedDeal(deal)}
                            title="View / Edit deal"
                            aria-label={`Edit deal ${deal.title}`}
                            style={iconBtnStyle}
                          >
                            <Pencil size={13} />
                          </button>
                          <button
                            type="button"
                            onClick={() => remove(deal)}
                            disabled={deletingId === deal.id}
                            title="Delete deal"
                            aria-label={`Delete deal ${deal.title}`}
                            style={{
                              ...iconBtnStyle,
                              color: 'var(--danger-color, #dc2626)',
                              opacity: deletingId === deal.id ? 0.4 : 1,
                              cursor: deletingId === deal.id ? 'wait' : 'pointer',
                            }}
                          >
                            <Trash2 size={13} />
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </TopScrollSync>
        )}
      </div>

      {/* ── Create deal drawer ── */}
      {showCreate && (
        <div
          onClick={(e) => { if (e.target === e.currentTarget) setShowCreate(false); }}
          style={overlayStyle}
        >
          <form
            onSubmit={submitCreate}
            className="card"
            role="dialog"
            aria-modal="true"
            aria-label="Add new deal"
            style={drawerStyle}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 18 }}>
              <h2 style={{ margin: 0, fontSize: 18, fontWeight: 700 }}>Add New Deal</h2>
              <button type="button" onClick={() => setShowCreate(false)} style={closeBtn} aria-label="Close"><X size={16} /></button>
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
              <label style={labelStyle}>
                Deal Title *
                <input
                  required type="text" value={form.title}
                  onChange={(e) => setForm({ ...form, title: e.target.value })}
                  style={inputStyle} placeholder="e.g. Acme Corp Annual Renewal"
                />
              </label>

              <div style={{ display: 'flex', gap: 10 }}>
                <label style={{ ...labelStyle, flex: 1 }}>
                  Contact name
                  <input
                    type="text" list="contacts-list" value={form.contactName}
                    onChange={(e) => setForm({ ...form, contactName: e.target.value })}
                    style={inputStyle} placeholder="Contact person"
                  />
                  <datalist id="contacts-list">
                    {contacts.map((c) => <option key={c.id} value={c.name}>{c.company}</option>)}
                  </datalist>
                </label>
                <label style={{ ...labelStyle, flex: 1 }}>
                  Company
                  <input
                    type="text" list="companies-list" value={form.company}
                    onChange={(e) => setForm({ ...form, company: e.target.value })}
                    style={inputStyle} placeholder="Company name"
                  />
                  <datalist id="companies-list">
                    {[...new Set(contacts.map((c) => c.company))].filter(Boolean).map((comp, i) => (
                      <option key={i} value={comp} />
                    ))}
                  </datalist>
                </label>
              </div>

              <div style={{ display: 'flex', gap: 10 }}>
                <label style={{ ...labelStyle, flex: 1 }}>
                  Amount ({currencySymbol()})
                  <input
                    type="number" min="0" step="any" value={form.amount}
                    onChange={(e) => setForm({ ...form, amount: e.target.value })}
                    style={inputStyle} placeholder="0"
                  />
                </label>
                <label style={{ ...labelStyle, width: 100 }}>
                  Probability (%)
                  <input
                    type="number" min="0" max="100" value={form.probability}
                    onChange={(e) => setForm({ ...form, probability: e.target.value })}
                    style={inputStyle} placeholder="50"
                  />
                </label>
              </div>

              <label style={labelStyle}>
                Stage
                <select
                  value={form.stage}
                  onChange={(e) => setForm({ ...form, stage: e.target.value })}
                  style={inputStyle}
                >
                  {stageOptions.map((s) => (
                    <option key={s.id} value={s.id}>{s.title}</option>
                  ))}
                </select>
              </label>
            </div>

            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, marginTop: 22 }}>
              <button type="button" onClick={() => setShowCreate(false)} style={secondaryBtn}>Cancel</button>
              <button type="submit" disabled={saving} style={primaryBtn}>
                {saving ? 'Saving…' : 'Save Deal'}
              </button>
            </div>
          </form>
        </div>
      )}

      {/* ── AI Score modal ── */}
      {aiScoreModal && (
        <div style={{ ...overlayStyle, backdropFilter: 'blur(10px)' }}>
          <div className="card" style={{
            padding: '2.5rem', width: 460,
            border: '1px solid #a855f7',
            boxShadow: '0 10px 40px rgba(168,85,247,0.2)',
          }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1.5rem' }}>
              <h3 style={{ fontSize: '1.5rem', fontWeight: 'bold', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                <Zap size={24} color="#a855f7" /> Deal Predictive Score
              </h3>
              <button onClick={() => setAiScoreModal(null)} aria-label="Close" style={closeBtn}><X size={24} /></button>
            </div>
            <div style={{ padding: '1.5rem', background: 'rgba(168,85,247,0.05)', borderRadius: 12, border: '1px solid rgba(168,85,247,0.2)', marginBottom: '1.5rem' }}>
              <p style={{ color: 'var(--text-secondary)', fontSize: '0.875rem' }}>Deal Analysis</p>
              <h4 style={{ fontSize: '1.25rem', fontWeight: 600, marginBottom: '1rem' }}>{aiScoreModal.title}</h4>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.5rem' }}>
                <span style={{ color: 'var(--text-secondary)' }}>Win Probability Score:</span>
                <span style={{ fontSize: '2rem', fontWeight: 'bold', color: aiScoreModal.probability > 70 ? 'var(--success-color)' : aiScoreModal.probability > 40 ? 'var(--warning-color)' : 'var(--danger-color)' }}>
                  {aiScoreModal.probability}%
                </span>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span style={{ color: 'var(--text-secondary)' }}>Confidence Level:</span>
                <span style={{ padding: '0.25rem 0.75rem', borderRadius: 12, backgroundColor: 'var(--subtle-bg-3)', fontSize: '0.875rem' }}>{aiScoreModal.confidence}</span>
              </div>
            </div>
            <div style={{ marginBottom: '1.5rem' }}>
              <h5 style={{ fontSize: '1rem', fontWeight: 600, marginBottom: '0.75rem' }}>Predictive Variables</h5>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1rem' }}>
                <div style={{ padding: '1rem', background: 'var(--subtle-bg)', borderRadius: 8 }}>
                  <p style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>Stage Weighting</p>
                  <p style={{ fontWeight: 500 }}>+{aiScoreModal.predictiveVariables?.stageWeight}</p>
                </div>
                <div style={{ padding: '1rem', background: 'var(--subtle-bg)', borderRadius: 8 }}>
                  <p style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>Budget Bonus</p>
                  <p style={{ fontWeight: 500 }}>+{aiScoreModal.predictiveVariables?.budgetBonus}</p>
                </div>
              </div>
            </div>
            <button className="btn-primary" style={{ width: '100%' }} onClick={() => setAiScoreModal(null)}>Dismiss Analysis</button>
          </div>
        </div>
      )}

      {/* ── Deal detail modal ── */}
      {selectedDeal && (
        <DealModal deal={selectedDeal} onClose={() => setSelectedDeal(null)} />
      )}
    </div>
  );
};

export default Pipeline;

// ── Styles ──────────────────────────────────────────────────────────────────

const selectStyle = {
  padding: '7px 10px', borderRadius: 8,
  border: '1px solid var(--border-color)',
  background: 'var(--surface-color)',
  color: 'var(--text-primary)',
  fontSize: 13, minWidth: 130,
};

const primaryBtn = {
  display: 'inline-flex', alignItems: 'center', gap: 6,
  padding: '8px 14px', borderRadius: 8,
  fontSize: 13, fontWeight: 600, cursor: 'pointer',
  background: 'var(--primary-color, var(--accent-color))',
  color: 'var(--accent-text, #fff)',
  border: '1px solid var(--primary-color, var(--accent-color))',
  whiteSpace: 'nowrap',
};

const secondaryBtn = {
  display: 'inline-flex', alignItems: 'center', gap: 6,
  padding: '8px 14px', borderRadius: 8,
  fontSize: 13, fontWeight: 500, cursor: 'pointer',
  background: 'var(--surface-color)',
  color: 'var(--text-primary)',
  border: '1px solid var(--border-color)',
  whiteSpace: 'nowrap',
};

const thStyle = {
  textAlign: 'left', padding: '12px 14px',
  fontSize: 11.5, letterSpacing: '0.04em',
  fontWeight: 600, textTransform: 'uppercase',
  color: 'var(--text-secondary)',
  borderBottom: '1px solid var(--border-color)',
  background: 'var(--subtle-bg)',
  whiteSpace: 'nowrap',
};

const tdStyle = {
  padding: '12px 14px',
  fontSize: 13.5,
  color: 'var(--text-primary)',
  verticalAlign: 'middle',
};

const emptyStyle = {
  padding: 48, textAlign: 'center',
  fontSize: 14, color: 'var(--text-secondary)',
};

const iconBtnStyle = {
  display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
  width: 30, height: 30, borderRadius: 7,
  border: '1px solid transparent',
  background: 'transparent',
  color: 'var(--text-secondary)',
  cursor: 'pointer',
};

const overlayStyle = {
  position: 'fixed', inset: 0,
  background: 'rgba(0,0,0,0.6)',
  backdropFilter: 'blur(4px)',
  WebkitBackdropFilter: 'blur(4px)',
  display: 'flex', alignItems: 'center', justifyContent: 'center',
  zIndex: 1000, padding: '1rem',
};

const drawerStyle = {
  background: 'var(--bg-color, var(--surface-color))',
  color: 'var(--text-primary)',
  width: '100%', maxWidth: 500,
  maxHeight: '90vh', overflowY: 'auto',
  padding: '1.5rem',
};

const closeBtn = {
  background: 'transparent', border: 'none',
  color: 'var(--text-secondary)', cursor: 'pointer', padding: 4,
  display: 'flex', alignItems: 'center',
};

const labelStyle = {
  display: 'flex', flexDirection: 'column', gap: 5,
  fontSize: 12, color: 'var(--text-secondary)', fontWeight: 500,
};

const inputStyle = {
  padding: '8px 10px', borderRadius: 7,
  border: '1px solid var(--border-color)',
  background: 'var(--input-bg, var(--surface-color))',
  color: 'var(--text-primary)', fontSize: 14,
};
