import { useEffect, useState } from 'react';
import { CalendarClock, ChevronDown, Hourglass, List, RotateCcw, User, Zap } from 'lucide-react';
import { fetchApi } from '../utils/api';
import './DialRunHistory.css';

const labels = { qualified:'Qualified', pending:'Pending', junk:'Junk', dnp:'DNP', notDialed:'Not dialed' };
const kinds = { scheduled:['Scheduled',CalendarClock], pending:['Pending retry',Hourglass], dnp:['DNP retry',RotateCcw],
  single:['Single call',User], run:['Dial run',List], auto:['Auto-dial',Zap] };

function LeadList({ job, audience = false }) {
  const [page,setPage] = useState(0);
  const [result,setResult] = useState(null);
  useEffect(() => {
    if (job.leads) return;
    let current = true;
    setResult(null);
    fetchApi(`/api/callified/dial-jobs/${job.id}/details?${audience ? 'audience' : 'history'}=1&page=${page}`, {silent:true})
      .then(data => { if(current) setResult(data); })
      .catch(() => { if(current) setResult({error:true}); });
    return () => { current=false; };
  },[job.id,job.leads,page,audience]);
  const data = job.leads ? {leads:job.leads} : result;
  if (!data) return <small role="status">Loading leads…</small>;
  if (data.error) return <small role="alert">Unable to load these leads.</small>;
  return <>{!audience && <h4>Leads dialed ({data.total ?? job.total})</h4>}
    {data.leads?.length ? <ul className="dh-leads" aria-label={audience ? 'Scheduled leads' : 'Run leads'}>{data.leads.map(lead =>
      <li key={lead.id}><span className="dial-avatar">{(lead.name || '?').charAt(0)}</span><div><strong>{lead.name || 'Unknown lead'}</strong><small>{lead.phone || 'Phone unavailable'}</small></div>
        {!audience && <span className="dial-outcome" data-outcome={lead.outcome}>{labels[lead.outcome] || 'Unrecorded'}</span>}</li>)}</ul>
      : <small>No lead details available.</small>}
    {(page > 0 || data.hasMore) && <div className="dh-pages"><button type="button" disabled={!page} onClick={()=>setPage(page-1)}>Previous</button><button type="button" disabled={!data.hasMore} onClick={()=>setPage(page+1)}>Next</button></div>}
  </>;
}

export function ScheduleAudience({job,campaigns=[]}) {
  const [open,setOpen] = useState(false);
  const names = (job.campaignIds || []).map(id => campaigns.find(c=>String(c.id)===String(id))?.name || `Campaign #${id}`);
  return <div className="dh-audience"><button type="button" aria-expanded={open} onClick={()=>setOpen(!open)}>View leads ({job.total}) <ChevronDown size={14}/></button>
    {open && <>{names.length > 0 && <p>Campaigns: {names.join(', ')}. Leads are confirmed when the run starts.</p>}<LeadList job={job} audience/></>}</div>;
}

function HistoryCard({job,timezone}) {
  const [open,setOpen] = useState(false);
  const type = job.scheduled ? 'scheduled' : job.runType;
  const [tag, Icon] = kinds[type] || kinds.run;
  const title = job.title || (type === 'run' ? `Dial run #${job.id}` : `${job.total} ${job.total===1?'lead':'leads'}`);
  const status = job.status === 'cancelled' ? job.completed || job.failed || job.activeCallLogId ? 'Stopped' : 'Cancelled' : 'Completed';
  const at = job.firstDialAt || job.scheduledAt || job.createdAt;
  const zone = job.timezone || timezone;
  const when = at ? new Date(at).toLocaleString('en-US',{timeZone:zone,weekday:'short',month:'short',day:'numeric',hour:'numeric',minute:'2-digit',hour12:true}) : '';
  const notDialed = (job.skipped || 0) + (job.status === 'cancelled' ? Math.max(0,job.total-(job.completed||0)-(job.failed||0)-(job.skipped||0)-Number(Boolean(job.activeCallLogId || job.dispatching))) : 0);
  const counts = {...job.outcomes,notDialed};
  return <article className="dh-card" data-kind={type}><button type="button" className="dh-summary" aria-expanded={open} aria-label={`${open?'Hide':'Show'} details for ${title}`} onClick={()=>setOpen(!open)}>
    <span className="dq-tile"><Icon size={17}/></span><div><div className="dh-title"><strong>{title}</strong><span className="dq-tag">{tag}</span><span className="dh-state" data-state={status}>{status}</span></div>
    <small>{type==='scheduled' && status==='Cancelled' ? 'Scheduled for' : 'Ran'} {when}</small>
    <div className="lead-dial-run-counts">{Object.entries(labels).filter(([key])=>counts[key]>0).map(([key,label])=><span key={key}>{counts[key]} {label}</span>)}</div></div><ChevronDown size={16}/></button>
    {open && <div className="dh-expanded">{type==='scheduled' && <dl><dt>Dialing</dt><dd>{title}</dd><dt>Timezone</dt><dd>{zone}</dd></dl>}
      <LeadList job={job}/>{job.error && <p className="dial-run-notice">{job.error}</p>}</div>}</article>;
}

export default function DialRunHistory({timezone,refreshKey,onCount}) {
  const [runs,setRuns] = useState(null), [error,setError] = useState(false);
  const [filter,setFilter] = useState('all'), [limit,setLimit] = useState(5);
  useEffect(()=>{
    let current=true;
    fetchApi('/api/callified/dial-jobs?history=1',{silent:true}).then(result=>{
      if(!current) return;
      const sorted=[...(result.jobs || [])].sort((a,b)=>Date.parse(b.firstDialAt || b.scheduledAt || b.createdAt)-Date.parse(a.firstDialAt || a.scheduledAt || a.createdAt));
      setRuns(sorted); onCount(sorted.length); setError(false);
    }).catch(()=>{if(current)setError(true);});
    return ()=>{current=false;};
  },[refreshKey,onCount]);
  const matches = (job,key) => key==='all' || (key==='normal' ? !job.scheduled && ['single','run'].includes(job.runType) : (job.scheduled?'scheduled':job.runType)===key);
  const items=(runs || []).filter(job=>matches(job,filter));
  return <div className="dq-panel dh-history">{error && <p role="alert">Unable to refresh past runs.</p>}
    <div className="dq-filters" aria-label="Past run types">{Object.entries({all:'All',scheduled:'Scheduled',pending:'Pending retries',dnp:'DNP retries',normal:'Normal calls',auto:'Auto-dial'}).map(([key,label])=>
      <button type="button" key={key} aria-pressed={key===filter} onClick={()=>{setFilter(key);setLimit(5);}}>{label} {runs?.filter(job=>matches(job,key)).length ?? '…'}</button>)}</div>
    {!runs && !error && <small>Loading past runs…</small>}
    {runs && !items.length && <p>{filter==='all'?'No past runs yet.':'No past runs of this type.'}</p>}
    {items.slice(0,limit).map(job=><HistoryCard key={job.id} job={job} timezone={timezone}/>)}
    {items.length>limit && <button type="button" className="btn-secondary dial-show-more" onClick={()=>setLimit(limit+5)}>Show {Math.min(5,items.length-limit)} more runs · {items.length-limit} left</button>}
  </div>;
}
