import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Check, ChevronLeft, ChevronRight, ChevronsUpDown, Plus, X } from "lucide-react";
import { fetchApi } from "../../utils/api";
import "./TripSetupNavigation.css";

export const steps = ["Trip created", "Payment plan", "Documents", "Landing page", "Assign teacher", "Parent link"];
const labels = [...steps.slice(0, 4), "Teachers", "Parent link"];
function linkKey(trip) {
  return `tmc-parent-link:${trip.tenantId}:${trip.id}`;
}
export function rememberParentLink(trip, generated) {
  try {
    if (generated) localStorage.setItem(linkKey(trip), String(trip.teacherContactId));
    else localStorage.removeItem(linkKey(trip));
  } catch { /* Storage may be disabled. */ }
}
export const stepTab = ["overview", "payment", "documents", "overview", "overview", "overview"];
export const anchors = [null, null, null, "landing", "teacher", "parent"];
export function tripStepPath(id, index) {
  const params = new URLSearchParams({tab: stepTab[index]});
  if (anchors[index]) params.set("setup", anchors[index]);
  return `/travel/trips/${id}?${params}`;
}
export function isPublishedTripPage(page) {
  return !!page?.id && page.status === "PUBLISHED";
}
export function setupSteps(trip, linked, generated) {
  let parent = generated;
  if (parent == null && trip.teacherContactId) {
    try { parent = localStorage.getItem(linkKey(trip)) === String(trip.teacherContactId); } catch { /* unavailable */ }
  }
  return [true, !!trip.paymentPlan, (trip.documentRequirements?.length ?? trip._count?.documentRequirements ?? 0) > 0,
    linked, !!trip.teacherContactId, !!trip.teacherContactId && !!parent];
}
function initials(trip) {
  return (trip.tripCode || "Trip").split(/[\s_-]+/).slice(0, 2).map(word => word[0]).join("").toUpperCase();
}
function Dots({ flags, viewed, jump, compact }) {
  const current = flags.indexOf(false);
  return <div className={'ts-dots' + (compact ? ' compact' : '')}>{steps.map((name, i) =>
    <button type="button" key={name} onClick={() => jump(i)} title={`Step ${i + 1}: ${name}`}
      aria-label={`Step ${i + 1}: ${name}, ${flags[i] == null ? "loading" : flags[i] ? "complete" : "pending"}`}
      aria-current={viewed === i ? "step" : undefined} data-done={!!flags[i]} data-current={current === i}>
      <span className="ts-dot">{flags[i] ? <Check size={16}/> : i + 1}</span>
      {!compact && <span>{labels[i]}</span>}
    </button>)}</div>;
}
export function SetupHeader(props) {
  const count = props.flags.filter(Boolean).length;
  const pct = Math.round(count / 6 * 100);
  return <nav className="ts-header ts-ui" aria-label="Trip setup"><div className="ts-summary"><strong>Trip setup · <small>{count} of 6 complete</small></strong><span><i><b style={{width:pct+'%'}}/></i> {pct}%</span></div><Dots {...props}/></nav>;
}
export function SetupNavigator(props) {
  const [dismissed, setDismissed] = useState(false);
  const [hadPendingStep, setHadPendingStep] = useState(false);
  const hasPendingStep = props.flags.includes(false);
  useEffect(() => {
    if (hasPendingStep) setHadPendingStep(true);
  }, [hasPendingStep]);
  if (dismissed || (!hasPendingStep && !hadPendingStep)) return null;
  return <FloatingTripNavigator {...props} onClose={() => setDismissed(true)} />;
}

function FloatingTripNavigator({ trip, flags, viewed, jump, switchTrip, newTrip, tabLabel, onClose }) {
  const [open,setOpen] = useState(false);
  const [rows,setRows] = useState([]);
  const [offset,setOffset] = useState(0);
  const [total,setTotal] = useState(0);
  const [error,setError] = useState('');
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(false);
  const trigger = useRef(null);
  const menu = useRef(null);
  useEffect(() => {
    if (!open) return;
    let active = true;
    setRows([]); setError(''); setTotal(0); setLoading(true);
    const params = new URLSearchParams({limit: '10', offset: String(offset)});
    if (search.trim()) params.set('search', search.trim());
    const timer = setTimeout(() => {
    fetchApi(`/api/travel/trips?${params}`, {silent:true}).then(async result => {
      if (!active) return;
      setLoading(false);
      setTotal(result.total || 0);
      const list = result.trips || [];
      setRows(list.map(row => ({row})));
      await Promise.all(list.filter(row => row.id !== trip.id).map(async row => {
        let linked;
        try { linked = isPublishedTripPage(await fetchApi(`/api/travel/trips/${row.id}/landing-page`, {silent:true})); }
        catch (e) { if (e.status === 404 || e.body?.code === "NOT_LINKED") linked = false; }
        if (active) setRows(old => old.map(item => item.row.id === row.id ? {row, linked, loaded:true} : item));
      }));
    }).catch(() => { if (active) { setLoading(false); setError("Could not load trips."); } });
    }, search.trim() ? 220 : 0);
    function dismiss(e) {
      if (e.type === 'keydown') { if (e.key !== 'Escape') return; trigger.current?.focus(); }
      else if (menu.current?.contains(e.target) || trigger.current?.contains(e.target)) return;
      setOpen(false);
    }
    document.addEventListener('pointerdown',dismiss); document.addEventListener('keydown',dismiss);
    return () => { active=false; clearTimeout(timer); document.removeEventListener('pointerdown',dismiss); document.removeEventListener('keydown',dismiss); };
  }, [open,offset,search,trip.id]);
  const count=flags.filter(Boolean).length, pct=Math.round(count/6*100);
  return createPortal(<nav className="ts-float ts-ui" aria-label="Trip navigator">
    <div className="ts-switch"><button className="ts-trigger" ref={trigger} type="button" aria-expanded={open} onClick={()=>{setSearch('');setOffset(0);setOpen(!open);}}>
      <b className="ts-initial">{initials(trip)}</b><span><strong>{trip.tripCode}</strong><small>{count} of 6 steps done</small></span><ChevronsUpDown size={16}/></button>
      {open && <div className="ts-menu" ref={menu}>
      <div className="ts-menu-search"><small>SWITCH TRIP</small>
        <input type="search" aria-label="Search TMC trips" placeholder="Search TMC trips…" autoFocus value={search}
          onChange={event => { setSearch(event.target.value); setOffset(0); }} />
      </div>
      {!rows.length && <small role="status">{error || (loading ? 'Loading trips…' : search.trim() ? 'No matching trips.' : 'No trips found.')}</small>}
      {rows.map(({row,linked,loaded}) => { const selected=row.id===trip.id, state=selected?flags:setupSteps(row,linked);
        return <button type="button" key={row.id} disabled={!selected && !loaded} data-selected={selected} onClick={()=>{setOpen(false);switchTrip(row, Math.max(0,state.findIndex(value=>!value)));}}>
        <b className="ts-initial">{initials(row)}</b><span><strong>{row.tripCode}</strong><small>{row.destination} · {row.status}</small><span className="ts-segments">{state.map((done,i)=><i key={i} data-done={!!done}/>)}</span></span><b>{state.includes(undefined)?'…':state.filter(Boolean).length+'/6'}</b></button>; })}
      {offset>0 && <button onClick={()=>setOffset(offset-10)}>Previous trips</button>}{offset+10<total && <button onClick={()=>setOffset(offset+10)}>More trips</button>}
      <button type="button" className="ts-new" onClick={newTrip}><Plus size={15}/> New trip</button></div>}
    </div><div className="ts-controls"><button aria-label="Previous setup step" disabled={viewed<=0} onClick={()=>jump(viewed-1)}><ChevronLeft/></button><Dots flags={flags} viewed={viewed} jump={jump} compact/><button aria-label="Next setup step" disabled={viewed===5} onClick={()=>jump(viewed+1)}><ChevronRight/></button></div>
    <div className="ts-where"><small>{viewed<0?'VIEWING':`STEP ${viewed+1} OF 6`}</small><strong>{steps[viewed] || tabLabel}</strong></div>
    <button type="button" className="ts-close" aria-label="Close trip navigator" title="Close trip navigator" onClick={onClose}><X size={18} aria-hidden="true" /></button>
    <b>{pct}%</b>
    <i className="ts-strip"><b style={{width:pct+'%'}}/></i></nav>, document.body);
}
