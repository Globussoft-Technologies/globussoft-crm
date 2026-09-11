import { useCallback, useEffect, useMemo, useState } from 'react';
import { Briefcase, ChevronDown, Filter, GripVertical, List, Plus, RefreshCw, Search, Settings, SlidersHorizontal, Trash2, X } from 'lucide-react';
import { fetchApi } from '../utils/api';
import { useNotify } from '../utils/notify';
import { formatMoney } from '../utils/money';
import DealModal from '../components/DealModal';
import { DealModal as ContactDealModal } from '../components/contact/ActionModals';

export const VIRTUALIZATION_THRESHOLD = 100;
export const slugifyStageName = (name) => String(name || '').toLowerCase().trim().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');

const STAGE_COLORS = ['#2563eb', '#0891b2', '#7c3aed', '#d97706', '#0f766e', '#059669', '#dc2626'];


function dateLabel(value) {
  if (!value) return 'No close date';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? 'No close date' : date.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
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
  return <span style={{ color: stage.color, background: `${stage.color}18`, border: `1px solid ${stage.color}35`, borderRadius: 999, padding: '3px 9px', fontSize: 11, fontWeight: 700 }}>{title}</span>;
}

function DealCard({ deal, stage, onOpen, onDragStart, onDelete, cardFields }) {
  return <article draggable onDragStart={(event) => onDragStart(event, deal)} onClick={() => onOpen(deal)} style={{ background: 'var(--surface-color)', border: '1px solid var(--border-color)', borderLeft: `3px solid ${stage.color}`, borderRadius: 9, padding: 14, cursor: 'grab', alignSelf: 'start', boxShadow: '0 2px 8px rgba(15,23,42,.04)' }}>
    <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}><GripVertical size={15} style={{ color: 'var(--text-secondary)', marginTop: 2, flexShrink: 0 }} aria-hidden="true" /><div style={{ minWidth: 0, flex: 1 }}><h3 style={{ margin: 0, fontSize: 13, lineHeight: 1.35, color: 'var(--text-primary)', overflowWrap: 'anywhere' }}>{deal.title || 'Untitled deal'}</h3>{cardFields.contact && <p style={{ margin: '5px 0 0', fontSize: 12, color: 'var(--text-secondary)' }}>{dealContact(deal)}</p>}</div><button type="button" onClick={(event) => { event.stopPropagation(); onDelete(deal); }} aria-label={`Delete deal ${deal.title}`} style={iconButton}><Trash2 size={14} /></button></div>
    {(cardFields.amount || cardFields.probability) && <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, marginTop: 14, alignItems: 'center' }}>{cardFields.amount && <strong style={{ fontSize: 13, color: 'var(--text-primary)' }}>{formatMoney(deal.amount || 0, { currency: deal.currency })}</strong>}{cardFields.probability && <span style={{ fontSize: 11, color: 'var(--text-secondary)' }}>{Number(deal.probability ?? 0)}%</span>}</div>}
    {(cardFields.owner || cardFields.expectedClose) && <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, marginTop: 11, paddingTop: 10, borderTop: '1px solid var(--border-color)', fontSize: 11, color: 'var(--text-secondary)' }}>{cardFields.owner && <span>{ownerName(deal)}</span>}{cardFields.expectedClose && <span>{dateLabel(deal.expectedClose)}</span>}</div>}
  </article>;
}

export default function Pipeline() {
  const notify = useNotify();
  const [deals, setDeals] = useState([]); const [stages, setStages] = useState([]); const [pipelines, setPipelines] = useState([]);
  const [loading, setLoading] = useState(true); const [error, setError] = useState(''); const [view, setView] = useState('kanban'); const [search, setSearch] = useState('');
  const [stageFilter, setStageFilter] = useState(''); const [ownerFilter, setOwnerFilter] = useState(''); const [pipelineId, setPipelineId] = useState(''); const [showFilters, setShowFilters] = useState(false); const [settingsOpen, setSettingsOpen] = useState(false); const [showCardCustomizer, setShowCardCustomizer] = useState(false); const [cardFields, setCardFields] = useState(() => { try { return JSON.parse(localStorage.getItem('deals-card-fields')) || { contact: true, amount: true, probability: true, owner: true, expectedClose: true }; } catch { return { contact: true, amount: true, probability: true, owner: true, expectedClose: true }; } });
  const [showCreate, setShowCreate] = useState(false); const [createDealDefaults, setCreateDealDefaults] = useState({}); const [selectedDeal, setSelectedDeal] = useState(null); const [dragged, setDragged] = useState(null);

  const load = useCallback(async () => {
    setLoading(true); setError('');
    try {
      const query = new URLSearchParams({ limit: '500', page: '1' }); if (pipelineId) query.set('pipelineId', pipelineId);
      const [dealData, stageData, pipelineData] = await Promise.all([fetchApi(`/api/deals?${query.toString()}`), fetchApi('/api/pipeline_stages'), fetchApi('/api/pipelines?fields=summary')]);
      const list = Array.isArray(dealData) ? dealData : (dealData?.data || []); setDeals(list);
      setStages((Array.isArray(stageData) ? stageData : []).map((stage, index) => ({ id: slugifyStageName(stage.name), title: stage.name, dbId: stage.id, color: stage.color || STAGE_COLORS[index % STAGE_COLORS.length], position: stage.position ?? index })).filter((stage) => stage.id));
      setPipelines(Array.isArray(pipelineData) ? pipelineData : []);
    } catch (err) { setError(err?.body?.error || 'Unable to load deals'); } finally { setLoading(false); }
  }, [pipelineId]);
  useEffect(() => { load(); }, [load]);

  const ownerOptions = useMemo(() => { const map = new Map(); deals.forEach((deal) => { if (deal.ownerId || ownerName(deal) !== 'Unassigned') map.set(String(deal.ownerId || ownerName(deal)), ownerName(deal)); }); return [...map.entries()]; }, [deals]);
  const visibleDeals = useMemo(() => { const query = search.trim().toLowerCase(); return deals.filter((deal) => { const matchesText = !query || [deal.title, deal.company, deal.contactName, dealContact(deal), ownerName(deal)].some((value) => String(value || '').toLowerCase().includes(query)); return matchesText && (!stageFilter || stageIdForDeal(deal, stages) === stageFilter) && (!ownerFilter || String(deal.ownerId || ownerName(deal)) === ownerFilter); }); }, [deals, search, stageFilter, ownerFilter, stages]);
  const stageRows = useMemo(() => stages.map((stage) => { const rows = visibleDeals.filter((deal) => stageIdForDeal(deal, stages) === stage.id); const value = rows.reduce((sum, deal) => sum + (Number(deal.amount) || 0), 0); return { ...stage, rows, value }; }), [stages, visibleDeals]);

  const openDeal = async (deal) => { setSelectedDeal(deal); try { setSelectedDeal(await fetchApi(`/api/deals/${deal.id}`)); } catch (_) { /* keep board row */ } };
  const moveDeal = async (deal, targetStage) => {
    if (!deal || !targetStage || deal.stage === targetStage) return;
    const lostReason = targetStage === 'lost' ? window.prompt('Reason for losing this deal:') : '';
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

  return <div style={{ padding: '24px 28px', maxWidth: 1500, margin: '0 auto' }}>
    <style>{'.deals-kanban-list { scrollbar-width: thin; scrollbar-color: #94a3b8 #e2e8f0; } .deals-kanban-list::-webkit-scrollbar { width: 10px; } .deals-kanban-list::-webkit-scrollbar-track { background: #e2e8f0; border-radius: 6px; } .deals-kanban-list::-webkit-scrollbar-thumb { background: #94a3b8; border-radius: 6px; border: 2px solid #e2e8f0; }'}</style>
    <header style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 16, flexWrap: 'wrap', marginBottom: 22 }}><div><div style={{ display: 'flex', alignItems: 'center', gap: 10 }}><Briefcase size={21} color="var(--accent-color)" /><h1 style={heading}>Deals and Pipelines</h1></div><p style={subtitle}>Track and manage your deals across different stages</p></div><div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}><button type="button" style={secondaryButton} onClick={load}><RefreshCw size={14} /> Refresh</button><button type="button" style={primaryButton} onClick={() => { setCreateDealDefaults({ pipelineId: pipelineId || undefined, stage: stages[0]?.id || undefined }); setShowCreate(true); }}><Plus size={15} /> Add deal</button></div></header>
    <section style={toolbar}><div style={{ display: 'flex', gap: 5, background: 'var(--subtle-bg)', padding: 4, borderRadius: 9 }}><button type="button" style={view === 'kanban' ? activeToggle : toggle} onClick={() => setView('kanban')}><Briefcase size={14} /> Kanban</button><button type="button" style={view === 'list' ? activeToggle : toggle} onClick={() => setView('list')}><List size={14} /> List</button></div><label style={control}><span>Pipeline</span><select value={pipelineId} onChange={(event) => setPipelineId(event.target.value)}><option value="">All pipelines</option>{pipelines.map((pipeline) => <option key={pipeline.id} value={pipeline.id}>{pipeline.name}</option>)}</select><ChevronDown size={13} /></label><button type="button" style={secondaryButton} onClick={() => setShowFilters((value) => !value)}><SlidersHorizontal size={14} /> More filters</button><div style={{ marginLeft: 'auto', position: 'relative' }}><Search size={15} style={{ position: 'absolute', left: 10, top: 10, color: 'var(--text-secondary)' }} /><input aria-label="Search deals" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search deals..." style={{ ...input, paddingLeft: 32, width: 210 }} /></div><div style={{ position: 'relative' }}><button type="button" title="Deal settings" aria-label="Deal settings" style={iconButton} onClick={() => setSettingsOpen((value) => !value)}><Settings size={16} /></button>{settingsOpen && <div role="menu" style={{ position: 'absolute', top: 'calc(100% + 6px)', right: 0, zIndex: 50, width: 220, padding: 6, border: '1px solid var(--border-color)', borderRadius: 8, background: 'var(--surface-color)', boxShadow: '0 12px 30px rgba(15,23,42,.15)' }}><button type="button" role="menuitem" style={settingsItem} onClick={() => { setSettingsOpen(false); setShowCardCustomizer(true); }}>Customize deal cards</button><button type="button" role="menuitem" style={settingsItem} onClick={() => { setSettingsOpen(false); window.location.href = '/pipelines'; }}>Set your default pipeline</button><button type="button" role="menuitem" style={settingsItem} onClick={() => { window.location.href = pipelineId ? '/pipelines?edit=' + pipelineId : '/pipelines'; }}>Edit pipeline</button><button type="button" role="menuitem" style={settingsItem} onClick={() => { window.location.href = '/pipelines'; }}>Create pipeline</button></div>}</div></section>
    {showFilters && <section style={{ ...toolbar, marginTop: -12, borderTop: 0 }}><Filter size={15} color="var(--text-secondary)" /><label style={control}><span>Stage</span><select value={stageFilter} onChange={(event) => setStageFilter(event.target.value)}><option value="">All stages</option>{stages.map((stage) => <option key={stage.id} value={stage.id}>{stage.title}</option>)}</select></label><label style={control}><span>Owner</span><select value={ownerFilter} onChange={(event) => setOwnerFilter(event.target.value)}><option value="">All owners</option>{ownerOptions.map(([id, name]) => <option key={id} value={id}>{name}</option>)}</select></label></section>}
    {error && <div role="alert" style={alert}>{error}<button type="button" onClick={load} style={linkButton}>Try again</button></div>}
    {loading ? <div style={empty}>Loading deals...</div> : stageRows.length === 0 ? <div style={empty}>No pipeline stages configured.</div> : view === 'kanban' ? <div style={{ display: 'grid', gridTemplateColumns: `repeat(${Math.max(stageRows.length, 1)}, minmax(0, 1fr))`, gap: 8, height: 'calc(100vh - 430px)', minHeight: 360, overflow: 'hidden', paddingBottom: 12 }}>{stageRows.map((stage) => <section key={stage.id} onDragOver={(event) => event.preventDefault()} onDrop={() => { if (dragged) moveDeal(dragged, stage.id); setDragged(null); }} style={{ minWidth: 0, minHeight: 0, height: '100%', display: 'flex', flexDirection: 'column', overflow: 'hidden', background: 'var(--subtle-bg)', border: '1px solid var(--border-color)', borderRadius: 10, padding: 8 }}><div style={{ borderTop: `3px solid ${stage.color}`, padding: '8px 4px 10px' }}><div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 4 }}><div style={{ display: 'flex', alignItems: 'center', gap: 5, minWidth: 0 }}><h2 style={{ ...columnTitle, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{stage.title}</h2><span style={countBadge}>{stage.rows.length}</span></div><StageBadge stage={stage} title={formatMoney(stage.value, { maximumFractionDigits: 0 })} /></div><div style={columnMeta}>Weighted value {formatMoney(stage.rows.reduce((sum, deal) => sum + (Number(deal.amount) || 0) * (Number(deal.probability ?? 0) / 100), 0), { maximumFractionDigits: 0 })}</div></div><button type="button" onClick={() => { setCreateDealDefaults({ pipelineId: pipelineId || undefined, stage: stage.id }); setShowCreate(true); }} style={addDealButton}><Plus size={14} /> Add deal</button><div className="deals-kanban-list" style={{ display: 'grid', gap: 8, marginTop: 8, flex: 1, minHeight: 0, overflowY: 'scroll', alignContent: 'start', gridAutoRows: 'max-content', paddingRight: 4 }}>{stage.rows.map((deal) => <DealCard key={deal.id} deal={deal} stage={stage} cardFields={cardFields} onOpen={openDeal} onDragStart={(event, row) => { setDragged(row); event.dataTransfer.effectAllowed = 'move'; }} onDelete={deleteDeal} />)}{stage.rows.length === 0 && <div style={dropHint}>Drop deals here</div>}</div></section>)}</div> : <div style={{ border: '1px solid var(--border-color)', borderRadius: 10, overflow: 'auto' }}><table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 760 }}><thead><tr>{['Deal', 'Contact', 'Stage', 'Owner', 'Amount', 'Probability', 'Expected close'].map((headingText) => <th key={headingText} style={th}>{headingText}</th>)}</tr></thead><tbody>{visibleDeals.map((deal) => { const stage = stageRows.find((row) => row.id === stageIdForDeal(deal, stages)) || { id: deal.stage, title: deal.stage, color: '#64748b' }; return <tr key={deal.id} onClick={() => openDeal(deal)} style={{ cursor: 'pointer' }}><td style={td}><strong>{deal.title}</strong></td><td style={td}>{dealContact(deal)}</td><td style={td}><StageBadge stage={stage} title={stage.title} /></td><td style={td}>{ownerName(deal)}</td><td style={td}>{formatMoney(deal.amount || 0, { currency: deal.currency })}</td><td style={td}>{deal.probability ?? 0}%</td><td style={td}>{dateLabel(deal.expectedClose)}</td></tr>; })}</tbody></table>{visibleDeals.length === 0 && <div style={empty}>No deals match your filters.</div>}</div>}
    <div style={{ marginTop: 12, color: 'var(--text-secondary)', fontSize: 12 }}>Showing {visibleDeals.length} of {deals.length} deals</div>
    {showCardCustomizer && <div role="presentation" style={overlay} onMouseDown={(event) => { if (event.target === event.currentTarget) setShowCardCustomizer(false); }}><div role="dialog" aria-modal="true" style={{ ...formCard, width: 'min(420px, calc(100vw - 32px))' }}><div style={formHeader}><h2 style={{ margin: 0, fontSize: 18 }}>Customize deal cards</h2><button type="button" aria-label="Close" onClick={() => setShowCardCustomizer(false)} style={iconButton}><X size={18} /></button></div>{[['contact', 'Contact'], ['amount', 'Deal value'], ['probability', 'Probability'], ['owner', 'Owner'], ['expectedClose', 'Expected close date']].map(([key, label]) => <label key={key} style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 13, color: 'var(--text-primary)' }}><input type="checkbox" checked={cardFields[key]} onChange={(event) => setCardFields((current) => ({ ...current, [key]: event.target.checked }))} />{label}</label>)}<button type="button" style={primaryButton} onClick={() => { localStorage.setItem('deals-card-fields', JSON.stringify(cardFields)); setShowCardCustomizer(false); }}>Save</button></div></div>}
    {selectedDeal && <DealModal deal={selectedDeal} onClose={() => setSelectedDeal(null)} />}
    {showCreate && <ContactDealModal deal={createDealDefaults} onClose={() => setShowCreate(false)} onDone={load} />}

  </div>;
}

const heading = { margin: 0, fontSize: 24, fontWeight: 700, color: 'var(--text-primary)' };
const subtitle = { margin: '5px 0 0 31px', color: 'var(--text-secondary)', fontSize: 13 };
const toolbar = { display: 'flex', gap: 9, alignItems: 'center', flexWrap: 'wrap', padding: 10, marginBottom: 18, border: '1px solid var(--border-color)', borderRadius: 10, background: 'var(--surface-color)' };
const primaryButton = { display: 'inline-flex', alignItems: 'center', gap: 6, padding: '9px 14px', border: 0, borderRadius: 8, background: 'var(--primary-color, var(--accent-color))', color: 'var(--accent-text, #fff)', fontWeight: 700, fontSize: 13, cursor: 'pointer' };
const secondaryButton = { display: 'inline-flex', alignItems: 'center', gap: 6, padding: '8px 12px', border: '1px solid var(--border-color)', borderRadius: 8, background: 'var(--surface-color)', color: 'var(--text-primary)', fontWeight: 600, fontSize: 12, cursor: 'pointer' };
const toggle = { ...secondaryButton, border: 0, padding: '7px 10px', background: 'transparent' };
const activeToggle = { ...toggle, background: 'var(--primary-color, var(--accent-color))', color: '#fff' };
const settingsItem = { display: 'block', width: '100%', padding: '9px 10px', border: 0, borderRadius: 6, background: 'transparent', color: 'var(--text-primary)', textAlign: 'left', fontSize: 12, cursor: 'pointer' };
const formCard = { width: 'min(420px, calc(100vw - 32px))', padding: 22, borderRadius: 12, background: 'var(--surface-color)', border: '1px solid var(--border-color)', boxShadow: '0 20px 60px rgba(0,0,0,.25)', display: 'grid', gap: 14 };
const formHeader = { display: 'flex', justifyContent: 'space-between', alignItems: 'center' };
const overlay = { position: 'fixed', inset: 0, zIndex: 9998, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16, background: 'var(--overlay-bg, rgba(15,23,42,.45))' };
const iconButton = { display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 30, height: 30, padding: 0, border: '1px solid var(--border-color)', borderRadius: 7, background: 'var(--surface-color)', color: 'var(--text-secondary)', cursor: 'pointer' };
const input = { width: '100%', boxSizing: 'border-box', padding: '9px 10px', border: '1px solid var(--border-color)', borderRadius: 7, background: 'var(--surface-color)', color: 'var(--text-primary)', fontSize: 13 };
const control = { display: 'inline-flex', alignItems: 'center', gap: 6, color: 'var(--text-secondary)', fontSize: 12 };
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
