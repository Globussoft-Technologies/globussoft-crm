import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { CheckCircle2, ChevronDown, Coins, FileText, MessageSquare, Paperclip, Plus, RefreshCw, Save, Settings2, X } from 'lucide-react';
import { fetchApi, getAuthToken } from '../utils/api';
import { useNotify } from '../utils/notify';

const EMPTY_RULE = () => ({
  name: '',
  commissionBasis: 'COLLECTED_AMOUNT',
  ratePercent: '',
  applyToAllStaff: false,
  staffUserIds: [],
});

const RECORD_PAGE_SIZE_OPTIONS = [10, 15, 25, 50, 100];
const RULE_PAGE_SIZE_OPTIONS = [10, 25, 50];
const MAX_RECORD_PAGE_SIZE = 500;
const RECORD_RENDER_BATCH_SIZE = 25;

const cardStyle = {
  background: 'var(--surface-color, #fff)',
  border: '1px solid var(--border-color, #e5e7eb)',
  borderRadius: 16,
  boxShadow: '0 10px 26px rgba(15, 23, 42, 0.06)',
};
const muted = { color: 'var(--text-secondary)', lineHeight: 1.5 };
const inputStyle = { width: '100%', minWidth: 0, boxSizing: 'border-box' };

function formatPaise(value) {
  const amount = Number(value || 0) / 100;
  return `₹${amount.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function formatRupees(value) {
  const amount = Number(value || 0);
  return `₹${amount.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function statusTone(status) {
  if (status === 'COMPLETED') return ['#dcfce7', '#166534'];
  if (status === 'PENDING') return ['#fef3c7', '#92400e'];
  return ['#eef2f7', '#475569'];
}

function displayStaffRole(member) {
  if (member.primaryRole?.name) return member.primaryRole.name;
  if (member.wellnessRole) {
    return `${member.wellnessRole.charAt(0).toUpperCase()}${member.wellnessRole.slice(1)}`;
  }
  return member.role || '—';
}

function isAdminStaff(member) {
  return String(member.role || '').toUpperCase() === 'ADMIN'
    || String(member.primaryRole?.key || '').toUpperCase() === 'ADMIN';
}

function StatusBadge({ status, label }) {
  const [background, color] = statusTone(status);
  return <span style={{ display: 'inline-flex', alignItems: 'center', borderRadius: 999, padding: '5px 9px', background, color, fontSize: 12, fontWeight: 700, whiteSpace: 'nowrap' }}>{label}</span>;
}

function paginationItems(currentPage, totalPages) {
  if (totalPages <= 7) return Array.from({ length: totalPages }, (_value, index) => index + 1);
  const pages = [...new Set([1, totalPages, currentPage - 1, currentPage, currentPage + 1])]
    .filter((page) => page >= 1 && page <= totalPages)
    .sort((left, right) => left - right);
  return pages.reduce((items, page, index) => {
    const previousPage = pages[index - 1];
    if (index > 0 && page - previousPage > 1) items.push(`ellipsis-${previousPage}`);
    items.push(page);
    return items;
  }, []);
}

function getPopoverLayout(rect, { minWidth, maxHeight, rowHeight, itemCount }) {
  const gap = 6;
  const edge = 8;
  const viewport = window.visualViewport;
  const viewportWidth = viewport?.width || window.innerWidth;
  const viewportHeight = viewport?.height || window.innerHeight;
  const maxWidth = Math.max(1, viewportWidth - edge * 2);
  const width = Math.min(Math.max(rect.width, minWidth), maxWidth);
  const left = Math.min(Math.max(edge, rect.left), Math.max(edge, viewportWidth - width - edge));
  const spaceBelow = Math.max(0, viewportHeight - rect.bottom - gap - edge);
  const spaceAbove = Math.max(0, rect.top - gap - edge);
  const estimatedHeight = Math.min(maxHeight, 52 + (itemCount + 1) * rowHeight);
  const opensUp = spaceBelow < estimatedHeight && spaceAbove > spaceBelow;
  const availableSpace = Math.max(0, opensUp ? spaceAbove : spaceBelow);
  const constrainedHeight = Math.min(maxHeight, availableSpace);
  const top = opensUp ? rect.top - constrainedHeight - gap : rect.bottom + gap;

  return {
    top: Math.max(edge, Math.min(top, viewportHeight - edge - constrainedHeight)),
    left,
    width,
    maxHeight: constrainedHeight,
  };
}

function usePopoverDismiss(open, setOpen, pickerRef, menuRef) {
  useEffect(() => {
    if (!open) return undefined;
    const handlePointerDown = (event) => {
      const target = event.target;
      if (pickerRef.current?.contains(target) || menuRef.current?.contains(target)) return;
      setOpen(false);
    };
    const handleKeyDown = (event) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('pointerdown', handlePointerDown, true);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown, true);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [open, setOpen, pickerRef, menuRef]);
}

function StaffPicker({ staff, selectedIds, allStaff, onChange }) {
  const [open, setOpen] = useState(false);
  const [menuLayout, setMenuLayout] = useState(null);
  const pickerRef = useRef(null);
  const menuRef = useRef(null);
  const selected = new Set(selectedIds.map(Number));
  const label = allStaff ? 'All active staff' : selected.size ? `${selected.size} staff selected` : 'Select staff';
  usePopoverDismiss(open, setOpen, pickerRef, menuRef);
  useEffect(() => {
    if (!open) {
      setMenuLayout(null);
      return undefined;
    }
    const updateMenuLayout = () => {
      const picker = pickerRef.current;
      if (!picker) return;
      const rect = picker.getBoundingClientRect();
      setMenuLayout(getPopoverLayout(rect, { minWidth: 240, maxHeight: 320, rowHeight: 40, itemCount: staff.length }));
    };
    updateMenuLayout();
    window.addEventListener('resize', updateMenuLayout);
    window.addEventListener('scroll', updateMenuLayout, true);
    window.visualViewport?.addEventListener('resize', updateMenuLayout);
    window.visualViewport?.addEventListener('scroll', updateMenuLayout);
    return () => {
      window.removeEventListener('resize', updateMenuLayout);
      window.removeEventListener('scroll', updateMenuLayout, true);
      window.visualViewport?.removeEventListener('resize', updateMenuLayout);
      window.visualViewport?.removeEventListener('scroll', updateMenuLayout);
    };
  }, [open, staff.length]);
  const menu = open && menuLayout ? <div ref={menuRef} style={{ position: 'fixed', zIndex: 1000, top: menuLayout.top, left: menuLayout.left, width: menuLayout.width, maxHeight: menuLayout.maxHeight, boxSizing: 'border-box', overflowY: 'auto', padding: 10, borderRadius: 12, background: 'var(--popover-bg, #fff)', border: '1px solid var(--border-color, #d9dee8)', boxShadow: '0 14px 30px rgba(15,23,42,.16)' }}>
    <label style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 6px', borderBottom: '1px solid var(--border-color, #e5e7eb)', fontWeight: 700 }}>
      <input type="checkbox" checked={allStaff} onChange={(event) => { onChange({ allStaff: event.target.checked, ids: [] }); setOpen(false); }} /> All active staff
    </label>
    {!staff.length && <p style={{ ...muted, margin: '10px 6px', fontSize: 13 }}>No active staff found.</p>}
    {staff.map((member) => <label key={member.id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 6px', fontSize: 13, opacity: allStaff ? 0.55 : 1 }}>
      <input type="checkbox" disabled={allStaff} checked={allStaff || selected.has(member.id)} onChange={(event) => {
        const next = new Set(selected);
        if (event.target.checked) next.add(member.id); else next.delete(member.id);
        onChange({ allStaff: false, ids: [...next] });
        setOpen(false);
      }} />
      <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' }}>{member.name}</span>
      <small style={{ marginLeft: 'auto', color: 'var(--text-secondary)' }}>{displayStaffRole(member)}</small>
    </label>)}
  </div> : null;
  return (
    <div ref={pickerRef} style={{ position: 'relative' }}>
      <button type="button" className="btn-secondary" onClick={() => setOpen((value) => !value)} style={{ width: '100%', display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, minHeight: 40 }} aria-expanded={open}>
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{label}</span><ChevronDown size={16} />
      </button>
      {menu && typeof document !== 'undefined' && document.body ? createPortal(menu, document.body) : null}
    </div>
  );
}

function PlotPicker({ plots, selectedIds, allPlots, onChange }) {
  const [open, setOpen] = useState(false);
  const [menuLayout, setMenuLayout] = useState(null);
  const pickerRef = useRef(null);
  const menuRef = useRef(null);
  const selected = new Set(selectedIds.map(Number));
  const label = allPlots ? `All active plots (${plots.length})` : selected.size ? `${selected.size} plots selected` : 'Select plots';
  usePopoverDismiss(open, setOpen, pickerRef, menuRef);

  useEffect(() => {
    if (!open) {
      setMenuLayout(null);
      return undefined;
    }
    const updateMenuLayout = () => {
      const picker = pickerRef.current;
      if (!picker) return;
      const rect = picker.getBoundingClientRect();
      setMenuLayout(getPopoverLayout(rect, { minWidth: 320, maxHeight: 360, rowHeight: 38, itemCount: plots.length }));
    };
    updateMenuLayout();
    window.addEventListener('resize', updateMenuLayout);
    window.addEventListener('scroll', updateMenuLayout, true);
    window.visualViewport?.addEventListener('resize', updateMenuLayout);
    window.visualViewport?.addEventListener('scroll', updateMenuLayout);
    return () => {
      window.removeEventListener('resize', updateMenuLayout);
      window.removeEventListener('scroll', updateMenuLayout, true);
      window.visualViewport?.removeEventListener('resize', updateMenuLayout);
      window.visualViewport?.removeEventListener('scroll', updateMenuLayout);
    };
  }, [open, plots.length]);

  const menu = open && menuLayout ? <div ref={menuRef} style={{ position: 'fixed', zIndex: 1000, top: menuLayout.top, left: menuLayout.left, width: menuLayout.width, maxHeight: menuLayout.maxHeight, boxSizing: 'border-box', overflowY: 'auto', padding: 10, borderRadius: 12, background: 'var(--popover-bg, #fff)', border: '1px solid var(--border-color, #d9dee8)', boxShadow: '0 14px 30px rgba(15,23,42,.16)' }}>
    <label style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 6px', borderBottom: '1px solid var(--border-color, #e5e7eb)', fontWeight: 700 }}>
      <input type="checkbox" checked={allPlots} onChange={(event) => { onChange({ allPlots: event.target.checked, ids: [] }); setOpen(false); }} /> All active plots
    </label>
    {!plots.length && <p style={{ ...muted, margin: '10px 6px', fontSize: 13 }}>No active plots found.</p>}
    {plots.map((plot) => <label key={plot.id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '9px 6px', fontSize: 13, opacity: allPlots ? 0.55 : 1 }}>
      <input type="checkbox" disabled={allPlots} checked={allPlots || selected.has(plot.id)} onChange={(event) => {
        const next = new Set(selected);
        if (event.target.checked) next.add(plot.id); else next.delete(plot.id);
        onChange({ allPlots: false, ids: [...next] });
        setOpen(false);
      }} />
      <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' }}>{plot.name}{plot.plotNumber ? ` · ${plot.plotNumber}` : ''}</span>
      <small style={{ marginLeft: 'auto', color: 'var(--text-secondary)', whiteSpace: 'nowrap' }}>{plot.availability}</small>
    </label>)}
  </div> : null;
  return <div ref={pickerRef} style={{ position: 'relative' }}>
    <button type="button" data-testid="commission-plot-select" className="btn-secondary" onClick={() => setOpen((value) => !value)} style={{ width: '100%', display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, minHeight: 40 }} aria-expanded={open}>
      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{label}</span><ChevronDown size={16} />
    </button>
    {menu && typeof document !== 'undefined' && document.body ? createPortal(menu, document.body) : null}
  </div>;
}

function RuleEditor({ rule, index, staff, onChange, onStaffChange, onRemove, canRemove }) {
  const update = (field, value) => onChange({ ...rule, [field]: value });
  return <div style={{ ...cardStyle, padding: 16, boxShadow: 'none', background: 'var(--surface-muted, #f8fafc)' }} data-testid={`commission-rule-${index}`}>
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, marginBottom: 12 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}><span style={{ width: 26, height: 26, borderRadius: 8, display: 'grid', placeItems: 'center', background: 'var(--primary-color, var(--accent-color))', color: '#fff', fontWeight: 800 }}>{index + 1}</span><strong>Commission rule</strong></div>
      {canRemove && <button type="button" className="btn-secondary" onClick={onRemove} aria-label={`Remove commission rule ${index + 1}`} style={{ padding: 7 }}><X size={16} /></button>}
    </div>
    <div style={{ display: 'grid', gridTemplateColumns: 'minmax(180px, 1.2fr) minmax(180px, 1fr) minmax(120px, .6fr) minmax(220px, 1.5fr)', gap: 12, alignItems: 'end' }}>
      <label>Rule name<input className="input-field" style={inputStyle} value={rule.name} onChange={(event) => update('name', event.target.value)} placeholder="e.g. Sales team commission" /></label>
      <label>Commission calculated on<select className="input-field" style={inputStyle} value={rule.commissionBasis} onChange={(event) => update('commissionBasis', event.target.value)}><option value="COLLECTED_AMOUNT">Collected amount</option><option value="ACTUAL_AMOUNT">Actual plot amount</option></select></label>
      <label>Rate (%)<input className="input-field" style={inputStyle} type="number" min="0" max="100" step="0.01" value={rule.ratePercent} onChange={(event) => update('ratePercent', event.target.value)} /></label>
      <label>Apply to staff<StaffPicker staff={staff} selectedIds={rule.staffUserIds} allStaff={rule.applyToAllStaff} onChange={onStaffChange} /></label>
    </div>
    <p style={{ ...muted, margin: '10px 0 0', fontSize: 12 }}>This rule is independent. Add another rule when a different rate or staff group is needed.</p>
  </div>;
}

function StaffConflictDialog({ conflicts, onCancel, onOverride }) {
  if (!conflicts?.length) return null;
  const uniqueConflicts = [...new Map(conflicts.map((conflict) => [`${conflict.staffId}:${conflict.previousRule}`, conflict])).values()];
  return <div role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onCancel(); }} style={{ position: 'fixed', inset: 0, zIndex: 100, display: 'grid', placeItems: 'center', padding: 20, background: 'rgba(15, 23, 42, .48)' }}>
    <section role="dialog" aria-modal="true" aria-labelledby="staff-conflict-title" style={{ width: 'min(520px, 100%)', borderRadius: 16, padding: 24, background: '#ffffff', opacity: 1, boxShadow: '0 24px 70px rgba(15,23,42,.28)' }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12 }}><div><h2 id="staff-conflict-title" style={{ margin: 0, fontSize: '1.15rem' }}>Staff already assigned</h2><p style={{ ...muted, margin: '7px 0 0', fontSize: 13 }}>Each staff member can belong to only one commission rule for a plot.</p></div><button type="button" className="btn-secondary" aria-label="Close staff conflict dialog" onClick={onCancel} style={{ padding: 7 }}><X size={16} /></button></div>
      <div style={{ marginTop: 16, padding: 12, borderRadius: 10, background: '#fff7ed', color: '#9a3412', fontSize: 13 }}>{uniqueConflicts.map((conflict) => <div key={`${conflict.staffId}:${conflict.previousRule}`} style={{ marginTop: 5 }}>{conflict.staffName} is already applied to <strong>{conflict.previousRule}</strong>.</div>)}</div>
      <p style={{ ...muted, margin: '16px 0 0', fontSize: 13 }}>Do you want to override those assignments? Override will remove those staff from their previous rules and apply them to this rule.</p>
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 9, marginTop: 20 }}><button type="button" className="btn-secondary" onClick={onCancel}>Cancel</button><button type="button" className="btn-primary" onClick={onOverride}>Override assignment</button></div>
    </section>
  </div>;
}

function CommissionRecordsPagination({
  recordCount,
  currentPage,
  totalPages,
  pageStart,
  pageEnd,
  pageSize,
  pageSizeSelectValue,
  pageSizeOptions,
  hasCustomPageSize,
  customPageSizeOpen,
  customPageSizeDraft,
  customPageSizeError,
  onPageSizeChange,
  onCustomPageSizeDraftChange,
  onApplyCustomPageSize,
  onOpenCustomPageSize,
  onPageChange,
}) {
  if (!recordCount) return null;
  return <div className="commission-records-pagination" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap', marginTop: 16, paddingTop: 14, borderTop: '1px solid var(--border-color, #e5e7eb)' }}>
    <span style={{ ...muted, fontSize: 13 }}>Showing {pageStart}–{pageEnd} of {recordCount} records</span>
    <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
        <label style={{ ...muted, fontSize: 13 }} htmlFor="commission-record-page-size">Rows</label>
        <select id="commission-record-page-size" className="input-field" aria-label="Rows per page" value={pageSizeSelectValue} onChange={onPageSizeChange} style={{ width: 'auto', minWidth: 72, padding: '7px 8px' }}>
          {pageSizeOptions.map((size) => <option key={size} value={size}>{size}</option>)}
          <option value="custom">{hasCustomPageSize ? `Custom (${pageSize})` : 'Custom'}</option>
        </select>
        {customPageSizeOpen && <form onSubmit={onApplyCustomPageSize} aria-label="Set custom rows per page" style={{ display: 'flex', alignItems: 'center', gap: 5, flexWrap: 'wrap' }}>
          <label htmlFor="commission-custom-page-size" style={{ ...muted, fontSize: 13 }}>Custom</label>
          <input id="commission-custom-page-size" className="input-field" type="number" min="1" max={MAX_RECORD_PAGE_SIZE} step="1" inputMode="numeric" value={customPageSizeDraft} onChange={onCustomPageSizeDraftChange} placeholder="Rows" aria-label="Custom rows per page" style={{ width: 72, padding: '7px 8px', textAlign: 'center' }} />
          <button type="submit" className="btn-secondary" style={{ padding: '7px 10px' }}>Apply</button>
          {customPageSizeError && <span role="alert" style={{ flexBasis: '100%', color: 'var(--danger-color, #dc2626)', fontSize: 12 }}>{customPageSizeError}</span>}
        </form>}
        {hasCustomPageSize && !customPageSizeOpen && <button type="button" className="btn-secondary" aria-label="Change custom rows per page" onClick={onOpenCustomPageSize} style={{ padding: '7px 10px' }}>Change</button>}
      </div>
      <button type="button" className="btn-secondary" aria-label="Previous page" disabled={currentPage === 1} onClick={() => onPageChange(Math.max(1, currentPage - 1))}>Previous</button>
      {paginationItems(currentPage, totalPages).map((item) => typeof item === 'number' ? <button type="button" className={item === currentPage ? 'btn-primary' : 'btn-secondary'} aria-label={`Page ${item}`} aria-current={item === currentPage ? 'page' : undefined} onClick={() => onPageChange(item)} key={item}>{item}</button> : <span key={item} style={{ padding: '0 3px', color: 'var(--text-secondary)' }}>…</span>)}
      <button type="button" className="btn-secondary" aria-label="Next page" disabled={currentPage === totalPages} onClick={() => onPageChange(Math.min(totalPages, currentPage + 1))}>Next</button>
    </div>
  </div>;
}

function CommissionRulesPagination({ ruleCount, currentPage, totalPages, pageStart, pageEnd, pageSize, onPageSizeChange, onPageChange }) {
  if (!ruleCount) return null;
  return <div className="commission-records-pagination" data-testid="commission-rules-pagination" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap', marginTop: 16, paddingTop: 14, borderTop: '1px solid var(--border-color, #e5e7eb)' }}>
    <span style={{ ...muted, fontSize: 13 }}>Showing {pageStart}-{pageEnd} of {ruleCount} rules</span>
    <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
      <label style={{ ...muted, fontSize: 13 }} htmlFor="commission-rule-page-size">Rows</label>
      <select id="commission-rule-page-size" className="input-field" aria-label="Rules per page" value={String(pageSize)} onChange={onPageSizeChange} style={{ width: 'auto', minWidth: 72, padding: '7px 8px' }}>
        {RULE_PAGE_SIZE_OPTIONS.map((size) => <option key={size} value={size}>{size}</option>)}
      </select>
      <button type="button" className="btn-secondary" aria-label="Previous rules page" disabled={currentPage === 1} onClick={() => onPageChange(Math.max(1, currentPage - 1))}>Previous</button>
      {paginationItems(currentPage, totalPages).map((item) => typeof item === 'number' ? <button type="button" className={item === currentPage ? 'btn-primary' : 'btn-secondary'} aria-label={`Rules page ${item}`} aria-current={item === currentPage ? 'page' : undefined} onClick={() => onPageChange(item)} key={item}>{item}</button> : <span key={item} style={{ padding: '0 3px', color: 'var(--text-secondary)' }}>...</span>)}
      <button type="button" className="btn-secondary" aria-label="Next rules page" disabled={currentPage === totalPages} onClick={() => onPageChange(Math.min(totalPages, currentPage + 1))}>Next</button>
    </div>
  </div>;
}

function ConfiguredRulesTable({ plans, plots, onManage }) {
  const rows = useMemo(() => plans.flatMap((plan) => {
    const plot = plots.find((item) => String(item.id) === String(plan.plotSiteId));
    return (plan.rules || []).map((rule) => ({ plan, plot, rule }));
  }), [plans, plots]);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(RULE_PAGE_SIZE_OPTIONS[0]);
  const totalPages = Math.max(1, Math.ceil(rows.length / pageSize));
  const currentPage = Math.min(page, totalPages);
  const pageRows = rows.slice((currentPage - 1) * pageSize, currentPage * pageSize);
  useEffect(() => { setPage((current) => Math.min(current, totalPages)); }, [totalPages]);

  if (!rows.length) return <div style={{ padding: 28, borderRadius: 12, background: 'var(--surface-muted, #f6f8fb)', ...muted }}>No commission rules have been added yet. Click <strong>Create rule</strong> to configure the first rule.</div>;
  return <>
    <div className="commission-rules-table-wrap"><table className="commission-records-table commission-rules-table" data-testid="commission-rules-table"><thead><tr>{['Rule ID', 'Plot', 'Rule name', 'Threshold', 'Calculated on', 'Rate', 'Applied to staff', 'Action'].map((heading) => <th key={heading}>{heading}</th>)}</tr></thead><tbody>{pageRows.map(({ plan, plot, rule }) => <tr key={rule.id}><td style={{ verticalAlign: 'top', whiteSpace: 'nowrap' }}>#{rule.id}</td><td style={{ verticalAlign: 'top' }}><strong>{plot?.name || 'Plot unavailable'}</strong><div style={{ ...muted, fontSize: 12, marginTop: 4 }}>{plot?.plotNumber || `Plot ID ${plan.plotSiteId}`}</div></td><td style={{ verticalAlign: 'top' }}><strong>{rule.name}</strong></td><td style={{ verticalAlign: 'top', whiteSpace: 'nowrap' }}>{plan.markupType === 'PERCENT' ? `${plan.markupValue}% of plot price` : `${formatRupees(plan.markupValue)} per plot`}</td><td style={{ verticalAlign: 'top', whiteSpace: 'nowrap' }}>{rule.commissionBasis === 'ACTUAL_AMOUNT' ? 'Actual plot amount' : 'Collected amount'}</td><td style={{ verticalAlign: 'top', whiteSpace: 'nowrap' }}>{rule.ratePercent}%</td><td style={{ verticalAlign: 'top' }}>{rule.applyToAllStaff ? 'All active staff' : rule.staff?.map((member) => member.name).join(', ') || 'No staff'}</td><td style={{ verticalAlign: 'top' }}><button type="button" className="btn-secondary" onClick={() => onManage(plan.plotSiteId)} aria-label={`Manage rule ${rule.id}`}>Manage</button></td></tr>)}</tbody></table></div>
    <CommissionRulesPagination ruleCount={rows.length} currentPage={currentPage} totalPages={totalPages} pageStart={((currentPage - 1) * pageSize) + 1} pageEnd={Math.min(currentPage * pageSize, rows.length)} pageSize={pageSize} onPageSizeChange={(event) => { setPageSize(Number(event.target.value)); setPage(1); }} onPageChange={setPage} />
  </>;
}

function CommissionRecordTableHeader() {
  return <thead><tr>{['Rule ID', 'Plot', 'Actual plot amount', 'Collectable threshold amount', 'Collected amount', 'Applied commission rule', 'Status', 'Assigned member name', 'Actions'].map((heading) => <th key={heading}>{heading}</th>)}</tr></thead>;
}

function CommissionRecordsTableLegacy({ records, recordsTableRef, onScroll, onRuleClick, showLoadHint }) {
  return <div className="commission-records-table-wrap" ref={recordsTableRef} onScroll={onScroll} style={{ overflow: 'auto' }}><table className="commission-records-table commission-records-data-table" style={{ width: '100%' }}><CommissionRecordTableHeader /><tbody>{records.map((record) => {
    const staffNames = [...new Set((record.rules || []).flatMap((rule) => rule.staffNames?.length ? rule.staffNames : rule.staff?.map((member) => member.name) || []))];
    return <tr key={record.plot.id}><td style={{ verticalAlign: 'top' }}>{record.rules?.length ? <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>{record.rules.map((rule) => <button type="button" key={rule.id} className="commission-rule-id-button" onClick={() => onRuleClick(record, rule)} aria-label={`View details for rule ${rule.id}`}>#{rule.id}</button>)}</div> : <span style={{ ...muted }}>—</span>}</td><td style={{ verticalAlign: 'top' }}><strong>{record.plot.name}</strong><div style={{ ...muted, fontSize: 12, marginTop: 4 }}>{record.plot.plotNumber || 'Plot number unavailable'}{record.booking?.contact?.name ? ` · ${record.booking.contact.name}` : ''}</div></td><td style={{ verticalAlign: 'top', whiteSpace: 'nowrap' }}>{formatPaise(record.actualAmountPaise)}</td><td style={{ verticalAlign: 'top', whiteSpace: 'nowrap' }}><strong>{formatPaise(record.collectionTargetPaise)}</strong><div style={{ ...muted, fontSize: 12, marginTop: 4 }}>{record.plan ? `${record.plan.markupType === 'PERCENT' ? record.plan.markupValue : formatRupees(record.plan.markupValue)}${record.plan.markupType === 'PERCENT' ? '% of plot price' : ' per plot'}` : 'Uses plot price'}</div></td><td style={{ verticalAlign: 'top', whiteSpace: 'nowrap' }}>{formatPaise(record.collectedAmountPaise)}<div style={{ ...muted, fontSize: 12, marginTop: 4 }}>{formatPaise(record.outstandingPaise)} remaining</div></td><td style={{ verticalAlign: 'top' }}>{record.rules?.length ? <div style={{ display: 'grid', gap: 7 }}>{record.rules.map((rule) => <div key={rule.id}><strong style={{ fontSize: 13 }}>{rule.name}</strong><div style={{ ...muted, fontSize: 12, marginTop: 2 }}>{rule.ratePercent}% · {(rule.basis || 'COLLECTED_AMOUNT').replaceAll('_', ' ').toLowerCase()}</div></div>)}</div> : <span style={{ ...muted, fontSize: 13 }}>No rules configured</span>}</td><td style={{ verticalAlign: 'top' }}><StatusBadge status={record.status} label={record.statusLabel} /></td><td style={{ verticalAlign: 'top' }}>{staffNames.length ? staffNames.join(', ') : <span style={{ ...muted }}>—</span>}</td></tr>;
  })}{!records.length && <tr><td colSpan="9" style={{ padding: 28, textAlign: 'center', ...muted }}>No commission records match the selected filters.</td></tr>}</tbody></table>{showLoadHint && <div className="commission-records-load-hint">Scroll to load more rows</div>}</div>;
}

function CommissionRecordsTable({ records, recordsTableRef, onScroll, onRuleClick, onAction, onInvoice, showLoadHint }) {
  if (!records.length) return <CommissionRecordsTableLegacy records={records} recordsTableRef={recordsTableRef} onScroll={onScroll} onRuleClick={onRuleClick} showLoadHint={showLoadHint} />;
  return <div className="commission-records-table-wrap" ref={recordsTableRef} onScroll={onScroll} style={{ overflow: 'auto' }}>
    <table className="commission-records-table commission-records-data-table" style={{ width: '100%' }}>
      <CommissionRecordTableHeader />
      <tbody>{records.map((record) => {
        const staffNames = [...new Set((record.rules || []).flatMap((rule) => rule.staffNames?.length ? rule.staffNames : rule.staff?.map((member) => member.name) || []))];
        const hasBooking = Boolean(record.booking?.id);
        const hasInvoice = Boolean(record.booking?.invoiceId);
        return <tr key={record.plot.id}>
          <td style={{ verticalAlign: 'top' }}>{record.rules?.length ? <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>{record.rules.map((rule) => <button type="button" key={rule.id} className="commission-rule-id-button" onClick={() => onRuleClick(record, rule)} aria-label={`View details for rule ${rule.id}`}>#{rule.id}</button>)}</div> : <span style={{ ...muted }}>-</span>}</td>
          <td style={{ verticalAlign: 'top' }}><strong>{record.plot.name}</strong><div style={{ ...muted, fontSize: 12, marginTop: 4 }}>{record.plot.plotNumber || 'Plot number unavailable'}{record.booking?.contact?.name ? ` - ${record.booking.contact.name}` : ''}</div></td>
          <td style={{ verticalAlign: 'top', whiteSpace: 'nowrap' }}>{formatPaise(record.actualAmountPaise)}</td>
          <td style={{ verticalAlign: 'top', whiteSpace: 'nowrap' }}><strong>{formatPaise(record.collectionTargetPaise)}</strong><div style={{ ...muted, fontSize: 12, marginTop: 4 }}>{record.plan ? `${record.plan.markupType === 'PERCENT' ? record.plan.markupValue : formatRupees(record.plan.markupValue)}${record.plan.markupType === 'PERCENT' ? '% of plot price' : ' per plot'}` : 'Uses plot price'}</div></td>
          <td style={{ verticalAlign: 'top', whiteSpace: 'nowrap' }}>{formatPaise(record.collectedAmountPaise)}<div style={{ ...muted, fontSize: 12, marginTop: 4 }}>{formatPaise(record.outstandingPaise)} remaining</div></td>
          <td style={{ verticalAlign: 'top' }}>{record.rules?.length ? <div style={{ display: 'grid', gap: 7 }}>{record.rules.map((rule) => <div key={rule.id}><strong style={{ fontSize: 13 }}>{rule.name}</strong><div style={{ ...muted, fontSize: 12, marginTop: 2 }}>{rule.ratePercent}% - {(rule.basis || 'COLLECTED_AMOUNT').replaceAll('_', ' ').toLowerCase()}</div></div>)}</div> : <span style={{ ...muted, fontSize: 13 }}>No rules configured</span>}</td>
          <td style={{ verticalAlign: 'top' }}><StatusBadge status={record.status} label={record.statusLabel} /></td>
          <td style={{ verticalAlign: 'top' }}>{staffNames.length ? staffNames.join(', ') : <span style={{ ...muted }}>-</span>}</td>
          <td className="commission-record-actions-cell" style={{ verticalAlign: 'top' }}>{hasBooking ? <div className="commission-record-actions"><button type="button" className="btn-secondary" onClick={() => onAction({ kind: 'complete', record })} disabled={record.status === 'COMPLETED'} aria-label={`Mark payment completed for ${record.plot.name}`}><CheckCircle2 size={14} /> {record.status === 'COMPLETED' ? 'Completed' : 'Mark completed'}</button><button type="button" className="btn-secondary" onClick={() => onInvoice(record)} aria-label={`${hasInvoice ? 'Download' : 'Add'} invoice for ${record.plot.name}`}><FileText size={14} /> {hasInvoice ? 'Invoice' : 'Add invoice'}</button><button type="button" className="btn-secondary" onClick={() => onAction({ kind: 'message', record })} aria-label={`Send payment message for ${record.plot.name}`}><MessageSquare size={14} /> Message</button></div> : <span style={{ ...muted, fontSize: 12 }}>Booking required</span>}</td>
        </tr>;
      })}</tbody>
    </table>
    {showLoadHint && <div className="commission-records-load-hint">Scroll to load more rows</div>}
  </div>;
}

function PaymentActionDialog({ action, busy, onClose, onSubmit }) {
  const [paymentMode, setPaymentMode] = useState('bank_transfer');
  const [transactionRef, setTransactionRef] = useState('');
  const [messageChannel, setMessageChannel] = useState('email');
  const [message, setMessage] = useState('');

  useEffect(() => {
    if (!action) return;
    const contact = action.record.booking?.contact;
    const preferredChannel = contact?.email ? 'email' : contact?.phone ? 'sms' : 'email';
    setPaymentMode('bank_transfer');
    setTransactionRef('');
    setMessageChannel(preferredChannel);
    setMessage(`Hello ${contact?.name || 'Customer'}, your payment for ${action.record.plot.name}${action.record.plot.plotNumber ? ` (${action.record.plot.plotNumber})` : ''} has been recorded as completed.`);
  }, [action]);

  if (!action) return null;
  const record = action.record;
  const contact = record.booking?.contact;
  const canEmail = Boolean(contact?.email);
  const canSms = Boolean(contact?.phone);
  const isComplete = action.kind === 'complete';
  const submit = (event) => {
    event.preventDefault();
    onSubmit({
      paymentMode,
      transactionRef: transactionRef.trim(),
      messageChannel,
      message: message.trim(),
    });
  };

  return <div role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !busy) onClose(); }} style={{ position: 'fixed', inset: 0, zIndex: 1000, display: 'grid', placeItems: 'center', padding: 20, background: 'rgba(15, 23, 42, .48)' }}>
    <section role="dialog" aria-modal="true" aria-labelledby="payment-action-title" style={{ width: 'min(620px, 100%)', maxHeight: 'min(720px, calc(100vh - 40px))', overflowY: 'auto', borderRadius: 16, padding: 24, background: '#ffffff', opacity: 1, boxShadow: '0 24px 70px rgba(15,23,42,.28)' }}>
      <header style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12 }}><div><span style={{ ...muted, fontSize: 12, fontWeight: 700 }}>{isComplete ? 'Payment action' : 'Customer message'}</span><h2 id="payment-action-title" style={{ margin: '5px 0 0', fontSize: '1.2rem' }}>{isComplete ? 'Mark payment as completed' : 'Send payment message'}</h2><p style={{ ...muted, margin: '6px 0 0' }}>{record.plot.name}{record.plot.plotNumber ? ` · ${record.plot.plotNumber}` : ''}{contact?.name ? ` · ${contact.name}` : ''}</p></div><button type="button" className="btn-secondary" aria-label="Close payment action" onClick={onClose} disabled={busy} style={{ padding: 7 }}><X size={16} /></button></header>
      {isComplete && <div className="commission-payment-summary"><div><span>Amount to record</span><strong>{formatPaise(record.outstandingPaise)}</strong></div><div><span>Invoice</span><strong>Generated automatically</strong></div></div>}
      <form onSubmit={submit} style={{ display: 'grid', gap: 14, marginTop: 20 }}>
        {isComplete && <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(210px, 1fr))', gap: 12 }}><label>Payment method<select className="input-field" value={paymentMode} onChange={(event) => setPaymentMode(event.target.value)}><option value="bank_transfer">Bank transfer</option><option value="upi">UPI</option><option value="cash">Cash</option><option value="card">Card</option><option value="cheque">Cheque</option><option value="manual">Manual</option></select></label><label>Payment reference<input className="input-field" value={transactionRef} onChange={(event) => setTransactionRef(event.target.value)} placeholder="UTR / receipt reference" required /></label></div>}
        <label>Message channel<select className="input-field" value={messageChannel} onChange={(event) => setMessageChannel(event.target.value)}><option value="email" disabled={!canEmail}>Email{canEmail ? ` · ${contact.email}` : ' · unavailable'}</option><option value="sms" disabled={!canSms}>SMS{canSms ? ` · ${contact.phone}` : ' · unavailable'}</option></select></label>
        <label>Message<textarea className="input-field" rows="4" value={message} onChange={(event) => setMessage(event.target.value)} placeholder="Write the payment update for the customer" required={!isComplete} /></label>
        {isComplete && <p style={{ ...muted, margin: 0, fontSize: 12 }}>Leave the message blank if you only want to record the payment and generate the invoice.</p>}
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 4 }}><button type="button" className="btn-secondary" onClick={onClose} disabled={busy}>Cancel</button><button type="submit" className="btn-primary" disabled={busy || (isComplete && !transactionRef.trim()) || (!isComplete && !message.trim())}>{busy ? 'Processing...' : isComplete ? 'Mark completed' : 'Send message'}</button></div>
      </form>
    </section>
  </div>;
}

function AddInvoiceDialog({ action, busy, onClose, onSubmit }) {
  const [screenshot, setScreenshot] = useState(null);
  const [note, setNote] = useState('');

  useEffect(() => {
    if (!action) return;
    setScreenshot(null);
    setNote('');
  }, [action]);

  if (!action) return null;
  const record = action.record;
  const submit = (event) => {
    event.preventDefault();
    onSubmit({ screenshot, note: note.trim() });
  };

  return <div role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !busy) onClose(); }} style={{ position: 'fixed', inset: 0, zIndex: 1000, display: 'grid', placeItems: 'center', padding: 20, background: 'rgba(15, 23, 42, .48)' }}>
    <section role="dialog" aria-modal="true" aria-labelledby="add-invoice-title" style={{ width: 'min(560px, 100%)', maxHeight: 'min(680px, calc(100vh - 40px))', overflowY: 'auto', borderRadius: 16, padding: 24, background: '#ffffff', opacity: 1, boxShadow: '0 24px 70px rgba(15,23,42,.28)' }}>
      <header style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12 }}><div><span style={{ ...muted, fontSize: 12, fontWeight: 700 }}>Invoice details</span><h2 id="add-invoice-title" style={{ margin: '5px 0 0', fontSize: '1.2rem' }}>Add invoice</h2><p style={{ ...muted, margin: '6px 0 0' }}>{record.plot.name}{record.plot.plotNumber ? ` · ${record.plot.plotNumber}` : ''}</p></div><button type="button" className="btn-secondary" aria-label="Close add invoice" onClick={onClose} disabled={busy} style={{ padding: 7 }}><X size={16} /></button></header>
      <form onSubmit={submit} style={{ display: 'grid', gap: 14, marginTop: 20 }}>
        <label>Invoice screenshot<input className="input-field" type="file" accept="image/png,image/jpeg,image/webp" onChange={(event) => setScreenshot(event.target.files?.[0] || null)} /></label>
        {screenshot && <div style={{ display: 'flex', alignItems: 'center', gap: 7, padding: '9px 11px', borderRadius: 9, background: 'var(--surface-muted, #f8fafc)', ...muted, fontSize: 12 }}><Paperclip size={14} /> {screenshot.name}</div>}
        <label>Note<textarea className="input-field" rows="4" value={note} onChange={(event) => setNote(event.target.value)} placeholder="Add a note about this invoice" /></label>
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 4 }}><button type="button" className="btn-secondary" onClick={onClose} disabled={busy}>Cancel</button><button type="submit" className="btn-primary" disabled={busy}>{busy ? 'Saving...' : 'Add invoice'}</button></div>
      </form>
    </section>
  </div>;
}

function RuleDetailsDialog({ detail, onClose }) {
  if (!detail) return null;
  const { record, rule } = detail;
  const staffNames = rule.staffNames?.length ? rule.staffNames : rule.staff?.map((member) => member.name) || [];
  const basis = (rule.basis || rule.commissionBasis || 'COLLECTED_AMOUNT').replaceAll('_', ' ').toLowerCase();
  return <div role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }} style={{ position: 'fixed', inset: 0, zIndex: 1000, display: 'grid', placeItems: 'center', padding: 20, background: 'rgba(15, 23, 42, .48)' }}>
    <section role="dialog" aria-modal="true" aria-labelledby="commission-rule-details-title" style={{ width: 'min(620px, 100%)', maxHeight: 'min(720px, calc(100vh - 40px))', overflowY: 'auto', borderRadius: 16, padding: 24, background: '#ffffff', opacity: 1, boxShadow: '0 24px 70px rgba(15,23,42,.28)' }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12 }}><div><span style={{ ...muted, fontSize: 12, fontWeight: 700 }}>Rule ID #{rule.id}</span><h2 id="commission-rule-details-title" style={{ margin: '5px 0 0', fontSize: '1.2rem' }}>{rule.name}</h2></div><button type="button" className="btn-secondary" aria-label="Close rule details" onClick={onClose} style={{ padding: 7 }}><X size={16} /></button></div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(210px, 1fr))', gap: 10, marginTop: 20 }}><div className="commission-rule-detail-item"><span>Plot</span><strong>{record.plot.name}{record.plot.plotNumber ? ` · ${record.plot.plotNumber}` : ''}</strong></div><div className="commission-rule-detail-item"><span>Actual plot amount</span><strong>{formatPaise(record.actualAmountPaise)}</strong></div><div className="commission-rule-detail-item"><span>Collectable threshold</span><strong>{formatPaise(record.collectionTargetPaise)}</strong></div><div className="commission-rule-detail-item"><span>Collected amount</span><strong>{formatPaise(record.collectedAmountPaise)}</strong></div><div className="commission-rule-detail-item"><span>Commission calculated on</span><strong>{basis}</strong></div><div className="commission-rule-detail-item"><span>Commission rate</span><strong>{rule.ratePercent}%</strong></div><div className="commission-rule-detail-item"><span>Current commission</span><strong>{formatPaise(rule.commissionPaise)}</strong></div><div className="commission-rule-detail-item"><span>Status</span><StatusBadge status={record.status} label={record.statusLabel} /></div></div>
      <div style={{ marginTop: 12 }} className="commission-rule-detail-item"><span>Assigned member name</span><strong>{staffNames.length ? staffNames.join(', ') : 'No staff assigned'}</strong></div>
      <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 20 }}><button type="button" className="btn-secondary" onClick={onClose}>Close</button></div>
    </section>
  </div>;
}

export default function PlotPayouts() {
  const notify = useNotify();
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [workspace, setWorkspace] = useState({ plots: [], staff: [], plans: [], records: [] });
  const [activeTab, setActiveTab] = useState('rules');
  const [rulesView, setRulesView] = useState('list');
  const [selectedPlotIds, setSelectedPlotIds] = useState([]);
  const [allPlotsSelected, setAllPlotsSelected] = useState(false);
  const [markupType, setMarkupType] = useState('PERCENT');
  const [markupValue, setMarkupValue] = useState('0');
  const [rules, setRules] = useState([EMPTY_RULE()]);
  const [staffConflict, setStaffConflict] = useState(null);
  const [statusFilter, setStatusFilter] = useState('ALL');
  const [search, setSearch] = useState('');
  const [recordPage, setRecordPage] = useState(1);
  const [recordPageSize, setRecordPageSize] = useState(10);
  const [customRecordPageSizeOpen, setCustomRecordPageSizeOpen] = useState(false);
  const [customRecordPageSizeDraft, setCustomRecordPageSizeDraft] = useState('');
  const [customRecordPageSizeError, setCustomRecordPageSizeError] = useState('');
  const [visibleRecordCount, setVisibleRecordCount] = useState(RECORD_RENDER_BATCH_SIZE);
  const [ruleDetails, setRuleDetails] = useState(null);
  const [paymentAction, setPaymentAction] = useState(null);
  const [paymentActionBusy, setPaymentActionBusy] = useState(false);
  const recordsTableRef = useRef(null);

  const load = async () => {
    setLoading(true);
    try {
      const response = await fetchApi('/api/commissions/workspace', { silent: true });
      const staff = (response.staff || []).filter((member) => !isAdminStaff(member));
      setWorkspace({ plots: response.plots || [], staff, plans: response.plans || [], records: response.records || [] });
    } catch (error) {
      notify.error(error.message || 'Could not load commissions.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const selectedPlots = useMemo(() => allPlotsSelected ? workspace.plots : workspace.plots.filter((plot) => selectedPlotIds.includes(Number(plot.id))), [allPlotsSelected, selectedPlotIds, workspace.plots]);
  const selectedPlans = useMemo(() => selectedPlots.map((plot) => workspace.plans.find((plan) => String(plan.plotSiteId) === String(plot.id))).filter(Boolean), [selectedPlots, workspace.plans]);
  const selectedPlan = selectedPlans[0] || null;
  const selectedPlot = selectedPlots.length === 1 ? selectedPlots[0] : null;
  const configuredRuleCount = workspace.plans.reduce((count, plan) => count + (plan.rules || []).length, 0);
  const totalBaseAmount = selectedPlots.reduce((sum, plot) => sum + Number(plot.price || 0), 0);
  const collectionThreshold = selectedPlots.reduce((sum, plot) => {
    const baseAmount = Number(plot.price || 0);
    return sum + (markupType === 'PERCENT' ? baseAmount * (Number(markupValue || 0) / 100) : Number(markupValue || 0));
  }, 0);

  useEffect(() => {
    if (!selectedPlots.length) {
      setMarkupType('PERCENT');
      setMarkupValue('0');
      setRules([EMPTY_RULE()]);
      return;
    }
    if (!selectedPlan) {
      setMarkupType('PERCENT');
      setMarkupValue('0');
      setRules([EMPTY_RULE()]);
      return;
    }
    setMarkupType(selectedPlan.markupType || 'PERCENT');
    setMarkupValue(String(selectedPlan.markupValue ?? 0));
    setRules(selectedPlan.rules?.length ? selectedPlan.rules.map((rule) => ({ name: rule.name, commissionBasis: rule.commissionBasis === 'MARKUP_AMOUNT' ? 'COLLECTED_AMOUNT' : rule.commissionBasis || 'COLLECTED_AMOUNT', ratePercent: String(rule.ratePercent ?? 0), applyToAllStaff: Boolean(rule.applyToAllStaff), staffUserIds: rule.staffUserIds || [] })) : [EMPTY_RULE()]);
  }, [allPlotsSelected, selectedPlotIds, selectedPlan, selectedPlots.length]);

  const filteredRecords = useMemo(() => workspace.records.filter((record) => {
    const matchesStatus = statusFilter === 'ALL' || record.status === statusFilter;
    const haystack = `${record.plot?.name || ''} ${record.plot?.plotNumber || ''} ${record.booking?.contact?.name || ''}`.toLowerCase();
    return matchesStatus && (!search.trim() || haystack.includes(search.trim().toLowerCase()));
  }), [workspace.records, statusFilter, search]);
  const totalRecordPages = Math.max(1, Math.ceil(filteredRecords.length / recordPageSize));
  const currentRecordPage = Math.min(recordPage, totalRecordPages);
  const paginatedRecords = filteredRecords.slice((currentRecordPage - 1) * recordPageSize, currentRecordPage * recordPageSize);
  const visiblePaginatedRecords = paginatedRecords.slice(0, visibleRecordCount);
  const hasCustomRecordPageSize = !RECORD_PAGE_SIZE_OPTIONS.includes(recordPageSize);
  const recordPageSizeSelectValue = customRecordPageSizeOpen || hasCustomRecordPageSize ? 'custom' : String(recordPageSize);
  const recordPageStart = filteredRecords.length ? ((currentRecordPage - 1) * recordPageSize) + 1 : 0;
  const recordPageEnd = Math.min(currentRecordPage * recordPageSize, filteredRecords.length);
  useEffect(() => { setRecordPage(1); }, [statusFilter, search]);
  useEffect(() => { setRecordPage((current) => Math.min(current, totalRecordPages)); }, [totalRecordPages]);
  useEffect(() => { setVisibleRecordCount(Math.min(RECORD_RENDER_BATCH_SIZE, paginatedRecords.length)); }, [currentRecordPage, recordPageSize, filteredRecords.length, paginatedRecords.length]);

  const handleRecordsTableScroll = (event) => {
    const table = event.currentTarget;
    if (table.scrollTop + table.clientHeight < table.scrollHeight - 80) return;
    setVisibleRecordCount((current) => Math.min(current + RECORD_RENDER_BATCH_SIZE, paginatedRecords.length));
  };

  const applyCustomRecordPageSize = (event) => {
    event.preventDefault();
    const nextPageSize = Number(customRecordPageSizeDraft);
    if (!Number.isInteger(nextPageSize) || nextPageSize < 1 || nextPageSize > MAX_RECORD_PAGE_SIZE) {
      setCustomRecordPageSizeError(`Enter a whole number between 1 and ${MAX_RECORD_PAGE_SIZE}.`);
      return;
    }
    setRecordPageSize(nextPageSize);
    setRecordPage(1);
    setCustomRecordPageSizeOpen(false);
    setCustomRecordPageSizeError('');
  };

  const handleRecordPageSizeChange = (event) => {
    if (event.target.value === 'custom') {
      setCustomRecordPageSizeDraft(hasCustomRecordPageSize ? String(recordPageSize) : '');
      setCustomRecordPageSizeError('');
      setCustomRecordPageSizeOpen(true);
      return;
    }
    setRecordPageSize(Number(event.target.value));
    setRecordPage(1);
    setCustomRecordPageSizeOpen(false);
    setCustomRecordPageSizeError('');
  };

  const openCustomRecordPageSize = () => {
    setCustomRecordPageSizeDraft(String(recordPageSize));
    setCustomRecordPageSizeError('');
    setCustomRecordPageSizeOpen(true);
  };

  const selectPlots = (selection) => {
    setAllPlotsSelected(selection.allPlots);
    setSelectedPlotIds(selection.ids.map(Number));
  };
  const addRule = () => setRules((current) => [...current, EMPTY_RULE()]);
  const updateRule = (index, next) => setRules((current) => current.map((rule, ruleIndex) => ruleIndex === index ? next : rule));
  const removeRule = (index) => setRules((current) => current.filter((_rule, ruleIndex) => ruleIndex !== index));

  const assignedStaffIds = (rule) => rule.applyToAllStaff ? workspace.staff.map((member) => member.id) : rule.staffUserIds.map(Number);
  const findStaffConflicts = (ruleIndex, selection) => {
    const selectedIds = new Set(selection.allStaff ? workspace.staff.map((member) => member.id) : selection.ids.map(Number));
    const conflicts = [];
    rules.forEach((rule, existingIndex) => {
      if (existingIndex === ruleIndex) return;
      const existingIds = new Set(assignedStaffIds(rule));
      for (const staffId of selectedIds) {
        if (!existingIds.has(staffId)) continue;
        const member = workspace.staff.find((staffMember) => staffMember.id === staffId);
        conflicts.push({ staffId, staffName: member?.name || `Staff #${staffId}`, previousRule: `Rule ${existingIndex + 1}${rule.name ? ` · ${rule.name}` : ''}`, existingIndex });
      }
    });
    return conflicts;
  };
  const requestStaffChange = (ruleIndex, selection) => {
    const conflicts = findStaffConflicts(ruleIndex, selection);
    if (conflicts.length) return setStaffConflict({ ruleIndex, selection, conflicts });
    updateRule(ruleIndex, { ...rules[ruleIndex], applyToAllStaff: selection.allStaff, staffUserIds: selection.ids });
  };
  const applyStaffChange = (override) => {
    if (!staffConflict) return;
    const { ruleIndex, selection, conflicts } = staffConflict;
    if (!override) return setStaffConflict(null);
    const conflictingIds = new Set(conflicts.map((conflict) => conflict.staffId));
    const nextRules = rules.map((rule, existingIndex) => {
      if (existingIndex === ruleIndex) return { ...rule, applyToAllStaff: selection.allStaff, staffUserIds: selection.ids };
      const remainingIds = assignedStaffIds(rule).filter((staffId) => !conflictingIds.has(staffId));
      return { ...rule, applyToAllStaff: false, staffUserIds: remainingIds };
    }).filter((rule, existingIndex) => existingIndex === ruleIndex || rule.applyToAllStaff || rule.staffUserIds.length);
    setRules(nextRules);
    setStaffConflict(null);
    notify.success('Staff assignment overridden. The previous rule was updated.');
  };

  const saveRules = async (event) => {
    event.preventDefault();
    if (!selectedPlots.length) return notify.error('Select at least one plot before saving commission rules.');
    if (!rules.length) return notify.error('Add at least one commission rule.');
    if (rules.some((rule) => rule.ratePercent === '' || rule.ratePercent === null || rule.ratePercent === undefined || !Number.isFinite(Number(rule.ratePercent)))) return notify.error('Enter a valid commission rate for every rule.');
    if (rules.some((rule) => !rule.applyToAllStaff && !rule.staffUserIds.length)) return notify.error('Select staff for every rule, or choose All active staff.');
    setSaving(true);
    try {
      const body = JSON.stringify({ markupType, markupValue: Number(markupValue || 0), rules: rules.map((rule) => ({ name: rule.name, commissionBasis: rule.commissionBasis, ratePercent: Number(rule.ratePercent || 0), applyToAllStaff: rule.applyToAllStaff, staffUserIds: rule.staffUserIds })) });
      await Promise.all(selectedPlots.map((plot) => fetchApi(`/api/commissions/plots/${plot.id}/rules`, { method: 'PUT', body })));
      notify.success(`Commission rules saved for ${selectedPlots.length} plot${selectedPlots.length === 1 ? '' : 's'}.`);
      await load();
      setRulesView('list');
    } catch (error) {
      notify.error(error.message || 'Could not save commission rules.');
    } finally {
      setSaving(false);
    }
  };

  const sendRecordMessage = async (record, { channel, message }) => {
    const contact = record.booking?.contact;
    const normalizedChannel = String(channel || '').trim().toLowerCase();
    if (normalizedChannel === 'email') {
      if (!contact?.email) throw new Error('This customer does not have an email address.');
      const result = await fetchApi('/api/communications/send-email', {
        method: 'POST',
        body: JSON.stringify({
          to: contact.email,
          contactId: contact.id,
          subject: `Payment update for ${record.plot.name}`,
          body: message,
        }),
      });
      if (result?.delivered === false || (Number(result?.totalSent) === 0 && Number(result?.totalFailed) > 0)) {
        throw new Error(result?.error || 'The email could not be delivered.');
      }
      return;
    }
    if (normalizedChannel !== 'sms') throw new Error('Select a valid message channel.');
    if (!contact?.phone) throw new Error('This customer does not have a phone number.');
    const result = await fetchApi('/api/sms/send', {
      method: 'POST',
      body: JSON.stringify({ to: contact.phone, contactId: contact.id, body: message }),
    });
    if (result?.success === false) throw new Error(result.error || 'The SMS could not be delivered.');
  };

  const downloadInvoicePdf = async (invoiceId, invoiceNum) => {
    const response = await fetch(`/api/billing/${invoiceId}/pdf`, { headers: { Authorization: `Bearer ${getAuthToken()}` } });
    if (!response.ok) {
      let detail = `HTTP ${response.status}`;
      try {
        const body = await response.json();
        if (body?.error) detail = body.error;
      } catch {
        // The response was not JSON; keep the HTTP status.
      }
      throw new Error(detail);
    }
    const blob = await response.blob();
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `${invoiceNum || 'invoice'}.pdf`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  };

  const handleInvoiceAction = (record) => {
    setPaymentAction({ kind: 'invoice', record });
  };

  const handleInvoiceSubmit = async ({ screenshot, note }) => {
    if (!paymentAction || paymentAction.kind !== 'invoice') return;
    const { record } = paymentAction;
    setPaymentActionBusy(true);
    try {
      let upload = null;
      if (screenshot) {
        const formData = new FormData();
        formData.append('image', screenshot, screenshot.name);
        upload = await fetchApi('/api/uploads/image', { method: 'POST', body: formData });
      }
      const response = await fetchApi(`/api/commissions/records/${record.plot.id}/invoice`, {
        method: 'POST',
        body: JSON.stringify({
          note,
          screenshotUrl: upload?.url || undefined,
          screenshotFilename: upload?.fileName || undefined,
        }),
      });
      setPaymentAction(null);
      await load();
      if (response.invoice?.id) await downloadInvoicePdf(response.invoice.id, response.invoice.invoiceNum);
      notify.success('Invoice added with the screenshot and note.');
    } catch (error) {
      notify.error(error.message || 'Could not add the invoice.');
    } finally {
      setPaymentActionBusy(false);
    }
  };

  const handlePaymentActionSubmit = async (values) => {
    if (!paymentAction) return;
    const { record } = paymentAction;
    setPaymentActionBusy(true);
    try {
      if (paymentAction.kind === 'complete') {
        await fetchApi(`/api/commissions/records/${record.plot.id}/complete-payment`, {
          method: 'POST',
          body: JSON.stringify({
            amount: Number(record.outstandingPaise || 0) / 100,
            paymentMode: values.paymentMode,
            transactionRef: values.transactionRef,
          }),
        });
        let messageError = null;
        if (values.message?.trim()) {
          try {
            await sendRecordMessage(record, { channel: values.messageChannel, message: values.message.trim() });
          } catch (error) {
            messageError = error.message || 'The message could not be sent.';
          }
        }
        setPaymentAction(null);
        await load();
        notify.success(messageError ? 'Payment marked completed and invoice generated.' : 'Payment marked completed, invoice generated, and message sent.');
        if (messageError) notify.error(`Payment completed, but the message was not sent: ${messageError}`);
        return;
      }
      await sendRecordMessage(record, { channel: values.messageChannel, message: values.message });
      setPaymentAction(null);
      notify.success('Message sent to the customer.');
    } catch (error) {
      notify.error(error.message || 'Could not complete the payment action.');
    } finally {
      setPaymentActionBusy(false);
    }
  };

  const openRuleCreator = () => {
    setRulesView('create');
    setAllPlotsSelected(false);
    setSelectedPlotIds([]);
    setMarkupType('PERCENT');
    setMarkupValue('0');
    setRules([EMPTY_RULE()]);
  };

  const openRecordRules = (plotId) => {
    setAllPlotsSelected(false);
    setSelectedPlotIds([Number(plotId)]);
    setActiveTab('rules');
    setRulesView('create');
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  return <main className="finance-page" data-testid="commission-page" style={{ maxWidth: 1480, padding: 'clamp(16px, 2.5vw, 32px)' }}>
    <section style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 18, flexWrap: 'wrap', marginBottom: 22 }}>
      <div style={{ minWidth: 0 }}><div style={{ display: 'flex', alignItems: 'center', gap: 10 }}><span style={{ width: 38, height: 38, borderRadius: 12, display: 'grid', placeItems: 'center', background: 'var(--primary-color, var(--accent-color))', color: '#fff' }}><Coins size={20} /></span><div><h1 style={{ margin: 0, fontSize: 'clamp(1.45rem, 2.2vw, 2rem)' }}>Commissions</h1><p style={{ ...muted, margin: '5px 0 0' }}>Set plot collection thresholds, assign commission rules, and track collection progress from Finance.</p></div></div></div>
      <button type="button" className="btn-secondary" onClick={load} disabled={loading} style={{ display: 'inline-flex', alignItems: 'center', gap: 7 }}><RefreshCw size={16} className={loading ? 'spin' : ''} /> Refresh</button>
    </section>

    <section style={{ ...cardStyle, padding: 6, display: 'flex', gap: 6, marginBottom: 18 }} role="tablist" aria-label="Commission workspace tabs">
      <button type="button" role="tab" aria-selected={activeTab === 'rules'} onClick={() => setActiveTab('rules')} style={{ flex: 1, border: 0, borderRadius: 11, padding: '12px 16px', background: activeTab === 'rules' ? 'var(--primary-color, var(--accent-color))' : 'transparent', color: activeTab === 'rules' ? '#fff' : 'var(--text-primary)', fontWeight: 800, cursor: 'pointer' }}><Settings2 size={16} style={{ verticalAlign: 'middle', marginRight: 7 }} /> Rules</button>
      <button type="button" role="tab" aria-selected={activeTab === 'records'} onClick={() => setActiveTab('records')} style={{ flex: 1, border: 0, borderRadius: 11, padding: '12px 16px', background: activeTab === 'records' ? 'var(--primary-color, var(--accent-color))' : 'transparent', color: activeTab === 'records' ? '#fff' : 'var(--text-primary)', fontWeight: 800, cursor: 'pointer' }}><CheckCircle2 size={16} style={{ verticalAlign: 'middle', marginRight: 7 }} /> Records</button>
    </section>

    {loading ? <section style={{ ...cardStyle, padding: 32, textAlign: 'center', ...muted }}>Loading plots, staff, rules, and collection records…</section> : activeTab === 'rules' ? <>
      <section style={{ ...cardStyle, padding: 'clamp(18px, 2.5vw, 28px)', marginBottom: 18 }}>
        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 16, flexWrap: 'wrap', marginBottom: 18 }}><div><h2 style={{ margin: 0, fontSize: '1.2rem' }}>{rulesView === 'create' ? 'Create commission rule' : 'Commission rules'}</h2><p style={{ ...muted, margin: '6px 0 0' }}>{rulesView === 'create' ? 'Select one or more plots, set the collection threshold, then add one or more rules for specific staff or everyone.' : 'Review every configured rule, the plot it belongs to, and the staff members who receive commission.'}</p></div><div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}><span style={{ ...muted, fontSize: 13 }}>{workspace.plots.length} plots · {workspace.staff.length} active staff · {configuredRuleCount} rules</span>{rulesView === 'create' ? <button type="button" className="btn-secondary" onClick={() => setRulesView('list')}>Back to rules</button> : <button type="button" className="btn-primary" data-testid="create-commission-rule" onClick={openRuleCreator} style={{ display: 'inline-flex', alignItems: 'center', gap: 7 }}><Plus size={16} /> Create rule</button>}</div></div>
        {rulesView === 'list' ? <ConfiguredRulesTable plans={workspace.plans} plots={workspace.plots} onManage={openRecordRules} /> : <><label style={{ maxWidth: 620, display: 'block' }}>Plots<PlotPicker plots={workspace.plots} selectedIds={selectedPlotIds} allPlots={allPlotsSelected} onChange={selectPlots} /></label>
        {!selectedPlots.length ? <div style={{ marginTop: 20, padding: 22, borderRadius: 12, background: 'var(--surface-muted, #f6f8fb)', ...muted }}>Choose one or more plots to configure a shared collection threshold and commission rules.</div> : <form onSubmit={saveRules} style={{ marginTop: 22 }}>
          <div style={{ display: 'grid', gridTemplateColumns: 'minmax(220px, 1fr) minmax(180px, .6fr) minmax(180px, .7fr)', gap: 12, alignItems: 'end', padding: 16, borderRadius: 12, background: 'var(--surface-muted, #f6f8fb)' }}>
            <div><strong>{selectedPlot ? `${selectedPlot.name}${selectedPlot.plotNumber ? ` · ${selectedPlot.plotNumber}` : ''}` : `${selectedPlots.length} plots selected`}</strong><p style={{ ...muted, margin: '5px 0 0', fontSize: 13 }}>Actual plot amount{selectedPlots.length > 1 ? ' combined' : ''}: <strong>{formatRupees(totalBaseAmount)}</strong></p><p style={{ ...muted, margin: '4px 0 0', fontSize: 13 }}>Collection threshold{selectedPlots.length > 1 ? ' combined' : ''}: <strong>{formatRupees(collectionThreshold)}</strong></p></div>
            <label>Collection threshold type<select className="input-field" style={{ ...inputStyle, marginTop: 5 }} value={markupType} onChange={(event) => setMarkupType(event.target.value)}><option value="PERCENT">Percentage of plot price</option><option value="FIXED">Fixed amount per plot</option></select></label>
            <label>Collection threshold {markupType === 'PERCENT' ? '(%)' : '(₹)'}<input className="input-field" style={{ ...inputStyle, marginTop: 5 }} type="number" min="0" step="0.01" value={markupValue} onChange={(event) => setMarkupValue(event.target.value)} /></label>
          </div>
          <div style={{ display: 'grid', gap: 12 }}>{rules.map((rule, index) => <RuleEditor key={index} rule={rule} index={index} staff={workspace.staff} canRemove={rules.length > 1} onChange={(next) => updateRule(index, next)} onStaffChange={(selection) => requestStaffChange(index, selection)} onRemove={() => removeRule(index)} />)}</div>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap', marginTop: 16 }}><button type="button" className="btn-secondary" onClick={addRule} style={{ display: 'inline-flex', alignItems: 'center', gap: 7 }}><Plus size={16} /> Add another rule</button><button type="submit" className="btn-primary" disabled={saving} style={{ display: 'inline-flex', alignItems: 'center', gap: 7 }}><Save size={16} /> {saving ? 'Saving…' : `Save rules for ${selectedPlots.length} plot${selectedPlots.length === 1 ? '' : 's'}`}</button></div>
        </form>}</>}
      </section>
    </> : <>
      <section className="commission-records-card" style={{ ...cardStyle, padding: 'clamp(18px, 2.5vw, 24px)' }}><div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap', marginBottom: 16 }}><div><h2 style={{ margin: 0, fontSize: '1.2rem' }}>Commission records</h2><p style={{ ...muted, margin: '6px 0 0' }}>Live collection status and the rules currently applied to each plot.</p></div><div className="commission-records-filters"><input className="input-field" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search plot or customer" /><select className="input-field" value={statusFilter} onChange={(event) => setStatusFilter(event.target.value)}><option value="ALL">All statuses</option><option value="NO_PAYMENT_COLLECTED">No payment collected</option><option value="PENDING">Pending</option><option value="COMPLETED">Completed</option></select></div></div>
        <CommissionRecordsTable records={visiblePaginatedRecords} recordsTableRef={recordsTableRef} onScroll={handleRecordsTableScroll} onRuleClick={(record, rule) => setRuleDetails({ record, rule })} onAction={setPaymentAction} onInvoice={handleInvoiceAction} showLoadHint={visiblePaginatedRecords.length < paginatedRecords.length} />
        <CommissionRecordsPagination recordCount={filteredRecords.length} currentPage={currentRecordPage} totalPages={totalRecordPages} pageStart={recordPageStart} pageEnd={recordPageEnd} pageSize={recordPageSize} pageSizeSelectValue={recordPageSizeSelectValue} pageSizeOptions={RECORD_PAGE_SIZE_OPTIONS} hasCustomPageSize={hasCustomRecordPageSize} customPageSizeOpen={customRecordPageSizeOpen} customPageSizeDraft={customRecordPageSizeDraft} customPageSizeError={customRecordPageSizeError} onPageSizeChange={handleRecordPageSizeChange} onCustomPageSizeDraftChange={(event) => { setCustomRecordPageSizeDraft(event.target.value); setCustomRecordPageSizeError(''); }} onApplyCustomPageSize={applyCustomRecordPageSize} onOpenCustomPageSize={openCustomRecordPageSize} onPageChange={setRecordPage} />
      </section>
    </>}
    <StaffConflictDialog conflicts={staffConflict?.conflicts} onCancel={() => applyStaffChange(false)} onOverride={() => applyStaffChange(true)} />
    <RuleDetailsDialog detail={ruleDetails} onClose={() => setRuleDetails(null)} />
    <PaymentActionDialog action={paymentAction?.kind === 'invoice' ? null : paymentAction} busy={paymentActionBusy} onClose={() => { if (!paymentActionBusy) setPaymentAction(null); }} onSubmit={handlePaymentActionSubmit} />
    <AddInvoiceDialog action={paymentAction?.kind === 'invoice' ? paymentAction : null} busy={paymentActionBusy} onClose={() => { if (!paymentActionBusy) setPaymentAction(null); }} onSubmit={handleInvoiceSubmit} />
  </main>;
}
