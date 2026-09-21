import { useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Briefcase, ChevronDown, Filter, GripVertical, List, Plus, RefreshCw, Search, Settings, SlidersHorizontal, Sparkles, Trash2, X } from 'lucide-react';
import { fetchApi, getAuthToken } from '../utils/api';
import { useNotify } from '../utils/notify';
import { formatMoney } from '../utils/money';
import { scopedStorageKey } from '../utils/scopedStorage';
import { SEARCH_DEBOUNCE_MS } from '../utils/timing';
import { AuthContext } from '../appContexts';
import { io } from 'socket.io-client';
import DealModal from '../components/DealModal';
import { DealModal as ContactDealModal } from '../components/contact/ActionModals';

export const VIRTUALIZATION_THRESHOLD = 100;
export const KANBAN_COLUMN_MIN_WIDTH = 220;
export const slugifyStageName = (name) => String(name || '').toLowerCase().trim().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');

export function normalizePipelineStages(stageData) {
  const seen = new Set();
  return (Array.isArray(stageData) ? stageData : []).flatMap((stage, index) => {
    const id = slugifyStageName(stage.name);
    if (!id || seen.has(id)) return [];
    seen.add(id);
    return [{ id, title: stage.name, dbId: stage.id, color: stage.color || STAGE_COLORS[index % STAGE_COLORS.length], position: stage.position ?? index }];
  });
}

const STAGE_COLORS = ['#2563eb', '#0891b2', '#7c3aed', '#d97706', '#0f766e', '#059669', '#dc2626'];


function dateLabel(value, locale) {
  if (!value) return 'No close date';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? 'No close date' : date.toLocaleDateString(locale || undefined, { day: '2-digit', month: 'short', year: 'numeric' });
}
function personName(person) { return person ? (person.name || [person.firstName, person.lastName].filter(Boolean).join(' ') || person.email || '') : ''; }
function dealContact(deal) { return deal.contactName || personName(deal.contact) || deal.company || 'No contact linked'; }
function ownerName(deal) { return deal.ownerName || personName(deal.owner) || 'Unassigned'; }
function stageIdForDeal(deal, stages) {
  const raw = slugifyStageName(deal?.stage);
  if (stages.some((stage) => stage.id === raw)) return raw;
  const aliases = {
    lead: ['new-lead', 'new'],
    proposal: ['proposal-sent', 'proposal'],
    won: ['closed-won', 'won'],
    lost: ['closed-lost', 'lost'],
  };
  return (aliases[raw] || []).find((id) => stages.some((stage) => stage.id === id)) || raw;
}

function StageBadge({ stage, title }) {
  return <span title={title} style={{ color: stage.color, background: `${stage.color}18`, border: `1px solid ${stage.color}35`, borderRadius: 999, padding: '3px 9px', fontSize: 11, fontWeight: 700, flexShrink: 0, maxWidth: '55%', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{title}</span>;
}

function FilterDropdown({ ariaLabel, value, options, onChange }) {
  const [open, setOpen] = useState(false);
  const selected = options.find((option) => String(option.value) === String(value)) || options[0];
  return <span style={{ position: 'relative' }}><select aria-label={ariaLabel} tabIndex={-1} value={value} onChange={onChange} style={hiddenFilterSelect}>{options.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select><button type="button" aria-label={`${ariaLabel} selector`} aria-haspopup="listbox" aria-expanded={open} onClick={() => setOpen((current) => !current)} style={filterSelect}>{selected.label}<ChevronDown size={14} /></button>{open && <div role="listbox" aria-label={`${ariaLabel} options`} style={filterMenu} onMouseDown={(event) => event.stopPropagation()}>{options.map((option) => <button type="button" role="option" aria-selected={String(option.value) === String(value)} key={option.value} style={filterOption} onClick={() => { onChange({ target: { value: option.value } }); setOpen(false); }}>{option.label}</button>)}</div>}</span>;
}

function DealCard({ deal, stage, onOpen, onDragStart, onDelete, onScore, cardFields, locale }) {
  return <article draggable onDragStart={(event) => onDragStart(event, deal)} onClick={() => onOpen(deal)} style={{ background: 'var(--surface-color)', border: '1px solid var(--border-color)', borderLeft: `3px solid ${stage.color}`, borderRadius: 9, padding: 14, cursor: 'grab', alignSelf: 'start', boxShadow: '0 2px 8px rgba(15,23,42,.04)' }}>
    <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}><GripVertical size={15} style={{ color: 'var(--text-secondary)', marginTop: 2, flexShrink: 0 }} aria-hidden="true" /><div style={{ minWidth: 0, flex: 1 }}><h3 style={{ margin: 0, fontSize: 13, lineHeight: 1.35, color: 'var(--text-primary)', overflowWrap: 'anywhere' }}>{deal.title || 'Untitled deal'}</h3>{cardFields.contact && <p style={{ margin: '5px 0 0', fontSize: 12, color: 'var(--text-secondary)' }}>{dealContact(deal)}</p>}</div><button type="button" onClick={(event) => { event.stopPropagation(); onScore(deal); }} aria-label={`Generate deal score for ${deal.title}`} title="Generate deal score" style={iconButton}><Sparkles size={14} /></button><button type="button" onClick={(event) => { event.stopPropagation(); onDelete(deal); }} aria-label={`Delete deal ${deal.title}`} style={iconButton}><Trash2 size={14} /></button></div>
    {(cardFields.amount || cardFields.probability) && <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, marginTop: 14, alignItems: 'center' }}>{cardFields.amount && <strong style={{ fontSize: 13, color: 'var(--text-primary)' }}>{formatMoney(deal.amount || 0, { currency: deal.currency })}</strong>}{cardFields.probability && <span style={{ fontSize: 11, color: 'var(--text-secondary)' }}>{Number(deal.probability ?? 0)}%</span>}</div>}
    {(cardFields.owner || cardFields.expectedClose) && <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, marginTop: 11, paddingTop: 10, borderTop: '1px solid var(--border-color)', fontSize: 11, color: 'var(--text-secondary)' }}>{cardFields.owner && <span>{ownerName(deal)}</span>}{cardFields.expectedClose && <span>{dateLabel(deal.expectedClose, locale)}</span>}</div>}
  </article>;
}

export default function Pipeline() {
  const navigate = useNavigate();
  const notify = useNotify();
  const [searchParams, setSearchParams] = useSearchParams();
  const { user, tenant } = useContext(AuthContext) || {};
  const locale = user?.locale || tenant?.locale;
  const cardFieldsKey = scopedStorageKey('deals-card-fields-v2', {
    tenantId: tenant?.id ?? user?.tenantId,
    userId: user?.userId,
  });
  const [deals, setDeals] = useState([]); const [stages, setStages] = useState([]); const [pipelines, setPipelines] = useState([]);
  const [staff, setStaff] = useState([]); const [stats, setStats] = useState(null);
  const [loading, setLoading] = useState(true); const [error, setError] = useState(''); const [view, setView] = useState('kanban'); const [search, setSearch] = useState(''); const [debouncedSearch, setDebouncedSearch] = useState('');
  const [page, setPage] = useState(1); const [pageSize, setPageSize] = useState(50); const [total, setTotal] = useState(0); const [totalPages, setTotalPages] = useState(1);
  const [pipelineMenuOpen, setPipelineMenuOpen] = useState(false);
  const requestIdRef = useRef(0); const firstLoadRef = useRef(true); const pipelineSelectionResolvedRef = useRef(false);
  const [stageFilter, setStageFilter] = useState(''); const [ownerFilter, setOwnerFilter] = useState(''); const [pipelineId, setPipelineId] = useState(() => searchParams.get('pipelineId') || ''); const [showFilters, setShowFilters] = useState(false); const [settingsOpen, setSettingsOpen] = useState(false); const [showCardCustomizer, setShowCardCustomizer] = useState(false); const [cardFields, setCardFields] = useState(() => { try { return JSON.parse(localStorage.getItem(cardFieldsKey)) || { contact: true, amount: true, probability: true, owner: true, expectedClose: true }; } catch { return { contact: true, amount: true, probability: true, owner: true, expectedClose: true }; } });
  const [showCreate, setShowCreate] = useState(false); const [createDealDefaults, setCreateDealDefaults] = useState({}); const [selectedDeal, setSelectedDeal] = useState(null); const [dragged, setDragged] = useState(null);

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedSearch(search.trim()), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [search]);

  useEffect(() => { setPage(1); }, [pipelineId, stageFilter, ownerFilter, debouncedSearch, pageSize]);

  const load = useCallback(async () => {
    const requestId = ++requestIdRef.current;
    if (firstLoadRef.current) setLoading(true);
    setError('');
    try {
      const query = new URLSearchParams({ limit: String(pageSize), page: String(page) });
      if (pipelineId) query.set('pipelineId', pipelineId);
      if (stageFilter) query.set('stage', stageFilter);
      if (ownerFilter) query.set('ownerId', ownerFilter);
      if (debouncedSearch) query.set('search', debouncedSearch);
      const statsQuery = new URLSearchParams(query); statsQuery.delete('limit'); statsQuery.delete('page');
      const [dealData, stageData, pipelineData, statsData, staffData] = await Promise.all([
        fetchApi(`/api/deals?${query.toString()}`),
        fetchApi(pipelineId ? `/api/pipeline_stages?pipelineId=${encodeURIComponent(pipelineId)}` : '/api/pipeline_stages'),
        fetchApi('/api/pipelines?fields=summary'),
        fetchApi(`/api/deals/stats?${statsQuery.toString()}`),
        fetchApi('/api/staff?fields=summary', { silent: true }).catch(() => []),
      ]);
      if (requestId !== requestIdRef.current) return;
      const list = Array.isArray(dealData) ? dealData : (dealData?.data || []); setDeals(list);
      const serverTotal = Array.isArray(dealData) ? list.length : Number(dealData?.total ?? list.length);
      setTotal(serverTotal);
      setTotalPages(Array.isArray(dealData) ? 1 : Math.max(1, Number(dealData?.totalPages) || Math.ceil(serverTotal / pageSize)));
      setStats(statsData && !Array.isArray(statsData) ? statsData : null);
      setStages(normalizePipelineStages(stageData));
      setPipelines(Array.isArray(pipelineData) ? pipelineData : []);
      setStaff(Array.isArray(staffData) ? staffData : (staffData?.data || []));
      firstLoadRef.current = false;
      return true;
    } catch (err) {
      if (requestId === requestIdRef.current) setError(err?.body?.error || 'Unable to load deals');
      return false;
    } finally {
      if (requestId === requestIdRef.current) setLoading(false);
    }
  }, [pipelineId, stageFilter, ownerFilter, debouncedSearch, page, pageSize]);
  useEffect(() => { load(); }, [load]);

  const refreshDeals = async () => {
    if (await load()) notify.success('Deals refreshed');
  };

  useEffect(() => {
    if (pipelineSelectionResolvedRef.current || pipelines.length === 0) return;
    pipelineSelectionResolvedRef.current = true;
    const requestedId = searchParams.get('pipelineId');
    const requested = requestedId && pipelines.find((item) => String(item.id) === requestedId);
    if (!requested) return;
    const selectedId = String(requested.id);
    if (selectedId !== pipelineId) setPipelineId(selectedId);
  }, [pipelineId, pipelines, searchParams]);

  useEffect(() => {
    if (!loading && page > totalPages) setPage(totalPages);
  }, [loading, page, totalPages]);

  useEffect(() => {
    const token = getAuthToken();
    const socket = io('/', { auth: token ? { token } : undefined, reconnection: false, timeout: 5000 });
    const refresh = () => load();
    socket.on('connect', () => {
      const tenantId = tenant?.id ?? user?.tenantId;
      if (tenantId) socket.emit('join_room', `tenant:${tenantId}`);
    });
    socket.on('deal_created', refresh);
    socket.on('deal_updated', refresh);
    socket.on('deal_deleted', refresh);
    socket.on('connect_error', () => {});
    return () => socket.disconnect();
  }, [load, tenant?.id, user?.tenantId]);

  const ownerOptions = useMemo(() => staff.map((member) => [String(member.id), member.name || member.email || `User ${member.id}`]), [staff]);
  const visibleDeals = deals;
  const stageRows = useMemo(() => stages.map((stage) => {
    const rows = visibleDeals.filter((deal) => stageIdForDeal(deal, stages) === stage.id);
    const aggregate = stats?.byStage?.find((item) => slugifyStageName(item.stage) === stage.id);
    return {
      ...stage,
      rows,
      count: Number(aggregate?.count ?? rows.length),
      value: Number(aggregate?.value ?? rows.reduce((sum, deal) => sum + (Number(deal.amount) || 0), 0)),
      expectedValue: Number(aggregate?.expectedValue ?? rows.reduce((sum, deal) => sum + (Number(deal.amount) || 0) * (Number(deal.probability ?? 0) / 100), 0)),
    };
  }), [stages, visibleDeals, stats]);

  const changePipeline = (event) => {
    const nextPipelineId = event.target.value;
    pipelineSelectionResolvedRef.current = true;
    setPipelineId(nextPipelineId);
    const nextParams = new URLSearchParams(searchParams);
    if (nextPipelineId) nextParams.set('pipelineId', nextPipelineId);
    else nextParams.delete('pipelineId');
    setSearchParams(nextParams, { replace: true });
  };

  const openDeal = (deal) => { if (deal?.id != null) navigate(`/deals/${deal.id}`); };
  const moveDeal = async (deal, targetStage) => {
    if (!deal || !targetStage || deal.stage === targetStage) return;
    const lostReason = targetStage === 'lost' ? await notify.prompt({ title: 'Lost deal', message: 'Reason for losing this deal:', confirmText: 'Save reason' }) : '';
    if (targetStage === 'lost' && !lostReason) return;
    const previous = deals; setDeals((rows) => rows.map((row) => row.id === deal.id ? { ...row, stage: targetStage, probability: targetStage === 'won' ? 100 : targetStage === 'lost' ? 0 : row.probability } : row));
    try { await fetchApi(`/api/deals/${deal.id}`, { method: 'PUT', body: JSON.stringify({ stage: targetStage, ...(lostReason ? { lostReason } : {}) }) }); notify.success('Deal stage updated'); } catch (err) { setDeals(previous); notify.error(err?.body?.error || 'Unable to move deal'); }
  };
  
  const deleteDeal = async (deal) => {
    if (!await notify.confirm({
      title: 'Delete deal',
      message: `Delete "${deal.title}"? This cannot be undone.`,
      confirmText: 'Delete',
      destructive: true,
    })) return;
    try { await fetchApi(`/api/deals/${deal.id}`, { method: 'DELETE' }); setDeals((rows) => rows.filter((row) => row.id !== deal.id)); notify.success('Deal deleted'); } catch (err) { notify.error(err?.body?.error || 'Unable to delete deal'); }
  };
  const generateDealScore = async (deal) => {
    try {
      const result = await fetchApi(`/api/ai_scoring/score/${deal.id}`);
      setDeals((rows) => rows.map((row) => row.id === deal.id ? { ...row, probability: result.probability } : row));
      notify.success('Deal score updated');
    } catch (err) { notify.error(err?.body?.error || 'Unable to generate deal score'); }
  };

  return <div style={{ padding: '24px 28px', maxWidth: 1500, margin: '0 auto' }}>
    <style>{'.deals-kanban-list { scrollbar-width: thin; scrollbar-color: #94a3b8 #e2e8f0; } .deals-kanban-list::-webkit-scrollbar { width: 10px; } .deals-kanban-list::-webkit-scrollbar-track { background: #e2e8f0; border-radius: 6px; } .deals-kanban-list::-webkit-scrollbar-thumb { background: #94a3b8; border-radius: 6px; border: 2px solid #e2e8f0; }'}</style>
    <header style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 16, flexWrap: 'wrap', marginBottom: 22 }}><div><div style={{ display: 'flex', alignItems: 'center', gap: 10 }}><Briefcase size={21} color="var(--accent-color)" /><h1 style={heading}>Deals and Pipelines</h1></div><p style={subtitle}>Track and manage your deals across different stages</p></div><div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}><button type="button" style={secondaryButton} onClick={refreshDeals}><RefreshCw size={14} /> Refresh</button><button type="button" style={primaryButton} onClick={() => { setCreateDealDefaults({ pipelineId: pipelineId || undefined, stage: stages[0]?.id || undefined }); setShowCreate(true); }}><Plus size={15} /> Add deal</button></div></header>
    <section style={toolbar}><div style={{ display: 'flex', gap: 5, background: 'var(--subtle-bg)', padding: 4, borderRadius: 9 }}><button type="button" style={view === 'kanban' ? activeToggle : toggle} onClick={() => setView('kanban')}><Briefcase size={14} /> Kanban</button><button type="button" style={view === 'list' ? activeToggle : toggle} onClick={() => setView('list')}><List size={14} /> List</button></div><label style={control}><span>Pipeline</span><div style={{ position: 'relative' }}><select tabIndex={-1} value={pipelineId} onChange={changePipeline} style={hiddenPipelineSelect}><option value="">All pipelines</option>{pipelines.map((pipeline) => <option key={pipeline.id} value={pipeline.id}>{pipeline.name}</option>)}</select><button type="button" aria-label="Pipeline" aria-haspopup="listbox" aria-expanded={pipelineMenuOpen} onClick={() => setPipelineMenuOpen((value) => !value)} style={pipelineSelect}>{pipelines.find((pipeline) => String(pipeline.id) === String(pipelineId))?.name || 'All pipelines'}<ChevronDown size={14} /></button>{pipelineMenuOpen && <div role="listbox" aria-label="Pipeline options" style={pipelineMenu} onMouseDown={(event) => event.stopPropagation()}><button type="button" role="option" aria-selected={!pipelineId} style={pipelineOption} onClick={() => { changePipeline({ target: { value: '' } }); setPipelineMenuOpen(false); }}>All pipelines</button>{pipelines.map((pipeline) => <button type="button" role="option" aria-selected={String(pipeline.id) === String(pipelineId)} key={pipeline.id} style={pipelineOption} onClick={() => { changePipeline({ target: { value: String(pipeline.id) } }); setPipelineMenuOpen(false); }}>{pipeline.name}</button>)}</div>}</div></label><button type="button" style={moreFiltersButton} onClick={() => setShowFilters((value) => !value)}><SlidersHorizontal size={14} /> More filters</button><div style={{ marginLeft: 'auto', position: 'relative' }}><Search size={15} style={{ position: 'absolute', left: 10, top: 10, color: 'var(--text-secondary)' }} /><input aria-label="Search deals" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search deals..." style={{ ...input, paddingLeft: 32, width: 210 }} /></div><div style={{ position: 'relative' }}><button type="button" title="Deal settings" aria-label="Deal settings" style={iconButton} onClick={() => setSettingsOpen((value) => !value)}><Settings size={16} /></button>{settingsOpen && <div role="menu" style={{ position: 'absolute', top: 'calc(100% + 6px)', right: 0, zIndex: 50, width: 220, padding: 6, border: '1px solid var(--border-color)', borderRadius: 8, background: 'var(--surface-color)', boxShadow: '0 12px 30px rgba(15,23,42,.15)' }}><button type="button" role="menuitem" style={settingsItem} onClick={() => { setSettingsOpen(false); setShowCardCustomizer(true); }}>Customize deal cards</button><button type="button" role="menuitem" style={settingsItem} onClick={() => { setSettingsOpen(false); window.location.href = '/pipelines'; }}>Set your default pipeline</button><button type="button" role="menuitem" style={settingsItem} onClick={() => { window.location.href = pipelineId ? '/pipelines?edit=' + pipelineId : '/pipelines'; }}>Edit pipeline</button><button type="button" role="menuitem" style={settingsItem} onClick={() => { window.location.href = '/pipelines'; }}>Create pipeline</button></div>}</div></section>
    {showFilters && <section style={{ ...toolbar, marginTop: -12, borderTop: 0 }}><Filter size={15} color="var(--text-secondary)" /><label style={control}><span>Stage</span><FilterDropdown ariaLabel="Stage" value={stageFilter} options={[{ value: '', label: 'All stages' }, ...stages.map((stage) => ({ value: stage.id, label: stage.title }))]} onChange={(event) => setStageFilter(event.target.value)} /></label><label style={control}><span>Owner</span><FilterDropdown ariaLabel="Owner" value={ownerFilter} options={[{ value: '', label: 'All owners' }, ...ownerOptions.map(([id, name]) => ({ value: id, label: name }))]} onChange={(event) => setOwnerFilter(event.target.value)} /></label></section>}
    {error && <div role="alert" style={alert}>{error}<button type="button" onClick={load} style={linkButton}>Try again</button></div>}
    {loading ? <div style={empty}>Loading deals...</div> : stageRows.length === 0 ? <div style={empty}>No pipeline stages configured.</div> : view === 'kanban' ? <div aria-label="Deal pipeline board" style={{ display: 'grid', gridTemplateColumns: `repeat(${Math.max(stageRows.length, 1)}, minmax(${KANBAN_COLUMN_MIN_WIDTH}px, 1fr))`, gap: 8, width: '100%', maxWidth: '100%', height: 'calc(100vh - 430px)', minHeight: 360, overflowX: 'auto', overflowY: 'hidden', scrollbarGutter: 'stable', paddingBottom: 12 }}>{stageRows.map((stage) => <section key={stage.id} onDragOver={(event) => event.preventDefault()} onDrop={() => { if (dragged) moveDeal(dragged, stage.id); setDragged(null); }} style={{ minWidth: 0, minHeight: 0, height: '100%', display: 'flex', flexDirection: 'column', overflow: 'hidden', background: 'var(--subtle-bg)', border: '1px solid var(--border-color)', borderRadius: 10, padding: 8 }}><div style={{ borderTop: `3px solid ${stage.color}`, padding: '8px 4px 10px' }}><div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 4 }}><div style={{ display: 'flex', alignItems: 'center', gap: 5, minWidth: 0 }}><h2 title={stage.title} style={{ ...columnTitle, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{stage.title}</h2><span style={countBadge}>{stage.count}</span></div><StageBadge stage={stage} title={formatMoney(stage.value, { maximumFractionDigits: 0 })} /></div><div style={columnMeta}>Weighted value {formatMoney(stage.expectedValue, { maximumFractionDigits: 0 })}</div></div><button type="button" onClick={() => { setCreateDealDefaults({ pipelineId: pipelineId || undefined, stage: stage.id }); setShowCreate(true); }} style={addDealButton}><Plus size={14} /> Add deal</button><div className="deals-kanban-list" style={{ display: 'grid', gap: 8, marginTop: 8, flex: 1, minHeight: 0, overflowY: 'auto', alignContent: 'start', gridAutoRows: 'max-content', paddingRight: 4 }}>{stage.rows.map((deal) => <DealCard key={deal.id} deal={deal} stage={stage} cardFields={cardFields} locale={locale} onOpen={openDeal} onDragStart={(event, row) => { setDragged(row); event.dataTransfer.effectAllowed = 'move'; }} onDelete={deleteDeal} onScore={generateDealScore} />)}{stage.rows.length === 0 && <div style={dropHint}>No deals on this page</div>}</div></section>)}</div> : <div style={{ border: '1px solid var(--border-color)', borderRadius: 10, overflow: 'auto' }}><table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 760 }}><thead><tr>{['Deal', 'Contact', 'Stage', 'Owner', 'Amount', 'Probability', 'Expected close'].map((headingText) => <th key={headingText} style={th}>{headingText}</th>)}</tr></thead><tbody>{visibleDeals.map((deal) => { const stage = stageRows.find((row) => row.id === stageIdForDeal(deal, stages)) || { id: deal.stage, title: deal.stage, color: '#64748b' }; return <tr key={deal.id} onClick={() => openDeal(deal)} style={{ cursor: 'pointer' }}><td style={td}><strong>{deal.title}</strong></td><td style={td}>{dealContact(deal)}</td><td style={td}><StageBadge stage={stage} title={stage.title} /></td><td style={td}>{ownerName(deal)}</td><td style={td}>{formatMoney(deal.amount || 0, { currency: deal.currency })}</td><td style={td}>{deal.probability ?? 0}%</td><td style={td}>{dateLabel(deal.expectedClose, locale)}</td></tr>; })}</tbody></table>{visibleDeals.length === 0 && <div style={empty}>No deals match your filters.</div>}</div>}
    <div style={paginationBar}><span>Showing {total === 0 ? 0 : (page - 1) * pageSize + 1}–{Math.min(page * pageSize, total)} of {total} deals</span><label style={control}><span>Rows</span><select aria-label="Deals per page" value={pageSize} onChange={(event) => setPageSize(Number(event.target.value))}>{[25, 50, 100].map((size) => <option key={size} value={size}>{size}</option>)}</select></label><button type="button" style={secondaryButton} disabled={page <= 1 || loading} onClick={() => setPage((value) => Math.max(1, value - 1))}>Previous</button><span>Page {page} of {totalPages}</span><button type="button" style={secondaryButton} disabled={page >= totalPages || loading} onClick={() => setPage((value) => Math.min(totalPages, value + 1))}>Next</button></div>
    {showCardCustomizer && <div role="presentation" style={overlay} onMouseDown={(event) => { if (event.target === event.currentTarget) setShowCardCustomizer(false); }}><div role="dialog" aria-modal="true" style={{ ...formCard, width: 'min(420px, calc(100vw - 32px))' }}><div style={formHeader}><h2 style={{ margin: 0, fontSize: 18 }}>Customize deal cards</h2><button type="button" aria-label="Close" onClick={() => setShowCardCustomizer(false)} style={iconButton}><X size={18} /></button></div>{[['contact', 'Contact'], ['amount', 'Deal value'], ['probability', 'Probability'], ['owner', 'Owner'], ['expectedClose', 'Expected close date']].map(([key, label]) => <label key={key} style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 13, color: 'var(--text-primary)' }}><input type="checkbox" checked={cardFields[key]} onChange={(event) => setCardFields((current) => ({ ...current, [key]: event.target.checked }))} />{label}</label>)}<button type="button" style={primaryButton} onClick={() => { localStorage.removeItem('deals-card-fields'); localStorage.setItem(cardFieldsKey, JSON.stringify(cardFields)); setShowCardCustomizer(false); }}>Save</button></div></div>}
    {selectedDeal && <DealModal deal={selectedDeal} onClose={() => setSelectedDeal(null)} />}
    {showCreate && <ContactDealModal deal={createDealDefaults} onClose={() => setShowCreate(false)} onDone={load} />}

  </div>;
}

const heading = { margin: 0, fontSize: 24, fontWeight: 700, color: 'var(--text-primary)' };
const subtitle = { margin: '5px 0 0 31px', color: 'var(--text-secondary)', fontSize: 13 };
const toolbar = { display: 'flex', gap: 9, alignItems: 'center', flexWrap: 'wrap', padding: 10, marginBottom: 18, border: '1px solid var(--border-color)', borderRadius: 10, background: 'var(--surface-color)' };
const paginationBar = { display: 'flex', gap: 10, alignItems: 'center', justifyContent: 'flex-end', flexWrap: 'wrap', marginTop: 12, color: 'var(--text-secondary)', fontSize: 12 };
const primaryButton = { display: 'inline-flex', alignItems: 'center', gap: 6, padding: '9px 14px', border: 0, borderRadius: 8, background: 'var(--primary-color, var(--accent-color))', color: 'var(--accent-text, #fff)', fontWeight: 700, fontSize: 13, cursor: 'pointer' };
const secondaryButton = { display: 'inline-flex', alignItems: 'center', gap: 6, padding: '8px 12px', border: '1px solid var(--border-color)', borderRadius: 8, background: 'var(--surface-color)', color: 'var(--text-primary)', fontWeight: 600, fontSize: 12, cursor: 'pointer' };
const moreFiltersButton = { ...secondaryButton, height: 44, padding: '8px 14px', borderRadius: 11, fontSize: 13 };
const toggle = { ...secondaryButton, border: 0, padding: '7px 10px', background: 'transparent' };
const activeToggle = { ...toggle, background: 'var(--primary-color, var(--accent-color))', color: '#fff' };
const settingsItem = { display: 'block', width: '100%', padding: '9px 10px', border: 0, borderRadius: 6, background: 'transparent', color: 'var(--text-primary)', textAlign: 'left', fontSize: 12, cursor: 'pointer' };
const formCard = { width: 'min(420px, calc(100vw - 32px))', padding: 22, borderRadius: 12, background: 'var(--surface-color)', border: '1px solid var(--border-color)', boxShadow: '0 20px 60px rgba(0,0,0,.25)', display: 'grid', gap: 14 };
const formHeader = { display: 'flex', justifyContent: 'space-between', alignItems: 'center' };
const overlay = { position: 'fixed', inset: 0, zIndex: 9998, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16, background: 'var(--overlay-bg, rgba(15,23,42,.45))' };
const iconButton = { display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 30, height: 30, padding: 0, border: '1px solid var(--border-color)', borderRadius: 7, background: 'var(--surface-color)', color: 'var(--text-secondary)', cursor: 'pointer' };
const input = { width: '100%', boxSizing: 'border-box', padding: '9px 10px', border: '1px solid var(--border-color)', borderRadius: 7, background: 'var(--surface-color)', color: 'var(--text-primary)', fontSize: 13 };
const control = { display: 'inline-flex', alignItems: 'center', gap: 6, color: 'var(--text-secondary)', fontSize: 12 };
const pipelineSelect = { width: 170, minWidth: 170, height: 44, padding: '8px 34px 8px 13px', border: '1px solid var(--border-color)', borderRadius: 11, background: 'var(--surface-color)', color: 'var(--text-primary)', fontSize: 13, fontWeight: 600, lineHeight: 1.2, cursor: 'pointer', appearance: 'none', WebkitAppearance: 'none', boxShadow: '0 1px 2px rgba(15,23,42,.04)' };
const filterSelect = { width: 155, minWidth: 155, height: 44, padding: '8px 34px 8px 13px', border: '1px solid var(--border-color)', borderRadius: 11, background: 'var(--surface-color)', color: 'var(--text-primary)', fontSize: 13, fontWeight: 600, lineHeight: 1.2, cursor: 'pointer', appearance: 'none', WebkitAppearance: 'none', boxShadow: '0 1px 2px rgba(15,23,42,.04)' };
const hiddenFilterSelect = { position: 'absolute', width: 1, height: 1, opacity: 0, pointerEvents: 'none' };
const filterMenu = { position: 'absolute', top: 'calc(100% + 6px)', left: 0, zIndex: 100, width: '100%', minWidth: 155, maxHeight: 240, overflowY: 'auto', padding: 5, border: '1px solid var(--border-color)', borderRadius: 10, background: 'var(--popover-bg, var(--surface-color))', boxShadow: '0 12px 28px rgba(15,23,42,.16)' };
const filterOption = { display: 'block', width: '100%', padding: '9px 10px', border: 0, borderRadius: 6, background: 'transparent', color: 'var(--text-primary)', textAlign: 'left', fontSize: 13, cursor: 'pointer' };
const hiddenPipelineSelect = { position: 'absolute', width: 1, height: 1, opacity: 0, pointerEvents: 'none' };
const pipelineMenu = { position: 'absolute', top: 'calc(100% + 6px)', left: 0, zIndex: 100, width: '100%', minWidth: 170, maxHeight: 240, overflowY: 'auto', padding: 5, border: '1px solid var(--border-color)', borderRadius: 10, background: 'var(--popover-bg, var(--surface-color))', boxShadow: '0 12px 28px rgba(15,23,42,.16)' };
const pipelineOption = { display: 'block', width: '100%', padding: '9px 10px', border: 0, borderRadius: 6, background: 'transparent', color: 'var(--text-primary)', textAlign: 'left', fontSize: 13, cursor: 'pointer' };
const alert = { padding: 12, marginBottom: 16, borderRadius: 8, background: 'rgba(239,68,68,.1)', color: 'var(--danger-color, #b91c1c)', fontSize: 13 };
const linkButton = { marginLeft: 10, padding: 0, border: 0, background: 'transparent', color: 'inherit', textDecoration: 'underline', cursor: 'pointer' };
const empty = { padding: 52, textAlign: 'center', color: 'var(--text-secondary)', border: '1px dashed var(--border-color)', borderRadius: 10 };
const columnTitle = { margin: 0, fontSize: 14, color: 'var(--text-primary)' };
const countBadge = { minWidth: 20, padding: '2px 6px', borderRadius: 999, background: 'var(--surface-color)', color: 'var(--text-secondary)', fontSize: 11, textAlign: 'center' };
const columnMeta = { marginTop: 8, fontSize: 11, color: 'var(--text-secondary)' };
const addDealButton = { width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 5, padding: '8px 0', border: '1px dashed var(--border-color)', borderRadius: 7, background: 'transparent', color: 'var(--accent-color)', cursor: 'pointer', fontSize: 12, fontWeight: 600 };
const dropHint = { padding: '30px 8px', border: '1px dashed var(--border-color)', borderRadius: 8, textAlign: 'center', color: 'var(--text-secondary)', fontSize: 12 };
const th = { padding: '12px 14px', textAlign: 'left', fontSize: 11, color: 'var(--text-secondary)', borderBottom: '1px solid var(--border-color)', background: 'var(--subtle-bg)' };
const td = { padding: '13px 14px', borderBottom: '1px solid var(--border-color)', color: 'var(--text-primary)', fontSize: 13 };
