import { useEffect, useRef, useState } from 'react';
import { Phone, Clock, ChevronDown, X, Trash2 } from 'lucide-react';
import { createPortal } from 'react-dom';
import ScrollableSelect from './ScrollableSelect';
import { LEAD_DIAL_STATUSES } from '../utils/leadDialStatuses';
import './LeadWorkspaceControls.css';

export function LeadCampaignDial({ campaigns, selectedIds, onSelection, onDial, disabled }) {
  const [open, setOpen] = useState(false);
  const [choosingStatuses, setChoosingStatuses] = useState(false);
  const [byStatus, setByStatus] = useState(false);
  function switchMode(next) {
    setByStatus(next);
    setChoosingStatuses(false);
    setStatuses([]);
  }
  const [statuses, setStatuses] = useState([]);
  const anchor = useRef(null);
  const popover = useRef(null);
  const [position, setPosition] = useState(null);
  useEffect(() => {
    if (!open) return;
    const place = () => {
      const rect = anchor.current.getBoundingClientRect();
      const width = Math.min(300, window.innerWidth - 16);
      const below = window.innerHeight - rect.bottom - 14;
      const above = rect.top - 14;
      const preferredHeight = 520;
      const up = below < preferredHeight && above > below;
      const availableHeight = up ? above : below;
      setPosition({
        left: Math.max(8, Math.min(rect.right - width, window.innerWidth - width - 8)),
        ...(availableHeight < 220 ? { top: 8 } : up ? { bottom: window.innerHeight - rect.top + 6 } : { top: rect.bottom + 6 }),
        width,
        maxHeight: Math.min(preferredHeight, availableHeight < 220 ? window.innerHeight - 16 : availableHeight),
      });
    };
    const outside = (event) => { if (!anchor.current?.contains(event.target) && !popover.current?.contains(event.target)) setOpen(false); };
    const escape = (event) => { if (event.key === 'Escape') { setOpen(false); anchor.current?.focus(); } };
    place(); window.addEventListener('resize', place); window.addEventListener('scroll', place, true);
    document.addEventListener('mousedown', outside); document.addEventListener('keydown', escape);
    return () => { window.removeEventListener('resize', place); window.removeEventListener('scroll', place, true); document.removeEventListener('mousedown', outside); document.removeEventListener('keydown', escape); };
  }, [open]);
  return <>
    <button ref={anchor} type="button" className="lead-workspace-dial" aria-haspopup="dialog" aria-expanded={open} disabled={disabled} onClick={() => { switchMode(false); setOpen(!open); }}><Phone size={14} /> Bulk dial <ChevronDown size={13} /></button>
    {open && position && createPortal(<div ref={popover} className="lead-workspace-popover lead-workspace-campaigns" style={{ position: 'fixed', zIndex: 1250, ...position }} role="dialog" aria-label="Bulk dial options">
      <div className="bulk-dial-modes" role="group" aria-label="Dial by">
        {['Choose campaigns', 'Choose status'].map((label, index) => <button key={label} type="button" aria-pressed={byStatus === Boolean(index)} onClick={() => { if (byStatus !== Boolean(index)) switchMode(Boolean(index)); }}>{label}</button>)}
      </div>
      {byStatus || choosingStatuses ? <>
        <div className="campaign-dial-scroll">
        <fieldset className="campaign-dial-statuses">
          <legend>Which lead statuses should we call?</legend>
          <p>{byStatus ? 'Calls matching leads across all pages using each lead’s assigned campaign.' : `${selectedIds.length} selected ${selectedIds.length === 1 ? 'campaign' : 'campaigns'}.`} Qualified leads are always excluded.</p>
          {LEAD_DIAL_STATUSES.map(({ value, label, detail }) => <label key={value}>
            <input type="checkbox" checked={statuses.includes(value)} onChange={(event) => setStatuses(current => event.target.checked ? [...current, value] : current.filter(status => status !== value))} />
            <span><strong>{label}</strong><small>{detail}</small></span>
          </label>)}
        </fieldset>
        </div>
        <div className="campaign-dial-footer">
          {!byStatus && <button type="button" className="btn-secondary" onClick={() => setChoosingStatuses(false)}>Back</button>}
          <button type="button" className="lead-workspace-dial" disabled={!statuses.length} onClick={() => { setOpen(false); anchor.current?.focus(); if (byStatus) onDial(statuses, true); else onDial(statuses); }}>{byStatus ? 'Start bulk calls' : 'Start campaign calls'}</button>
        </div>
      </> : <>
      <header><p>Includes eligible leads across every page.</p></header>
      <div className="campaign-dial-scroll">
      <div className="lead-workspace-campaign-list">{campaigns.length ? campaigns.map((campaign) => <label key={campaign.id}><input type="checkbox" checked={selectedIds.includes(String(campaign.id))} onChange={() => onSelection(selectedIds.includes(String(campaign.id)) ? selectedIds.filter((id) => id !== String(campaign.id)) : [...selectedIds, String(campaign.id)])} /><span>{campaign.name || `Campaign ${campaign.id}`}</span><small>{campaign.leadCount || 0}</small></label>) : <p>No campaigns available. Connect Callified and create a campaign first.</p>}</div>
      </div>
      <div className="campaign-dial-footer">
      <button type="button" className="lead-workspace-dial" disabled={!selectedIds.length} onClick={() => setChoosingStatuses(true)}>Choose lead statuses{selectedIds.length ? ` · ${selectedIds.length}` : ''}</button>
      </div>
      </>}
    </div>, document.body)}
  </>;
}

export function LeadSelectionBar({ progress, count, totalResults, selectingAll, onSelectAll, canDial, canUpdate, canDelete, busy, staff, campaigns, onClear, onDial, onSchedule, onAssignStaff, onAssignCampaign, onDelete }) {
  const exceedsDialLimit = count > 1000;
  const actionsDisabled = busy || selectingAll;
  return createPortal(<div className="lead-selection-bar" role="toolbar" aria-label="Selected lead actions">
    <strong aria-live="polite">{count} selected</strong>
    {(selectingAll || totalResults > count) && <button type="button" onClick={onSelectAll} disabled={actionsDisabled}>{selectingAll ? 'Selecting all results…' : `Select all ${totalResults} results`}</button>}
    {progress && <div className="lead-bulk-progress" role="status"><span>Updating {progress.done} / {progress.total}</span><div role="progressbar" aria-label="Bulk action progress" aria-valuemin={0} aria-valuemax={progress.total} aria-valuenow={progress.done}><span style={{ width: `${Math.min(100, progress.total ? progress.done / progress.total * 100 : 0)}%` }} /></div></div>}
    <button type="button" aria-label="Clear lead selection" title="Clear selection" onClick={onClear} disabled={busy}><X size={15} /></button>
    <span className="lead-selection-divider" />
    {canDial && <button type="button" className="lead-workspace-dial" onClick={onDial} disabled={actionsDisabled || exceedsDialLimit}><Phone size={14} /> Dial</button>}
    {canDial && onSchedule && <button type="button" onClick={onSchedule} disabled={actionsDisabled || exceedsDialLimit}><Clock size={14} /> Schedule</button>}
    {canDial && exceedsDialLimit && <small className="lead-selection-limit">Dial and Schedule support up to 1,000 selected leads.</small>}
    {canUpdate && <>
      <ScrollableSelect ariaLabel="Assign campaign to selected leads" className="lead-selection-picker" value="" placeholder="Assign campaign" options={[{ value: '__clear', label: 'No campaign' }, ...campaigns.map((campaign) => ({ value: String(campaign.id), label: campaign.name || `Campaign ${campaign.id}` }))]} onChange={(value) => onAssignCampaign(value === '__clear' ? null : value)} disabled={actionsDisabled} width={145} />
      <ScrollableSelect ariaLabel="Assign staff to selected leads" className="lead-selection-picker" value="" placeholder="Assign to staff" options={[{ value: '__clear', label: 'Unassigned' }, ...staff.map((member) => ({ value: String(member.id), label: member.name || member.email }))]} onChange={(value) => onAssignStaff(value === '__clear' ? null : value)} disabled={actionsDisabled} width={140} />
    </>}
    {canDelete && <><span className="lead-selection-divider" /><button type="button" className="lead-selection-delete" onClick={onDelete} disabled={actionsDisabled}><Trash2 size={14} /> Delete</button></>}
  </div>, document.body);
}
