import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Building2, Download, FileText, Plus, Trash2, Upload } from 'lucide-react';
import { useNotify } from '../../utils/notify';
import { formatMoney } from '../../utils/money';
import { formatDate, formatDateTime } from '../../utils/date';
import {
  assignOwner, deleteAttachment, fetchAttachments, fetchEmailThreads,
  fetchActivities, fetchScore, fetchSiblings, fetchSmsMessages, patchContact,
  updateDeal, uploadContactFiles,
} from './contactActions';
import { DEAL_STAGES } from './contactProfileConfig';
import { FormRow, Stars } from './ProfileWidgets';

export function DetailsTab({ contact, staff, refresh }) {
  const notify = useNotify();
  const [form, setForm] = useState(() => ({ ...contact }));
  const [ownerId, setOwnerId] = useState(contact.assignedToId ? String(contact.assignedToId) : '');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setForm({ ...contact });
    setOwnerId(contact.assignedToId ? String(contact.assignedToId) : '');
  }, [contact]);

  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));
  const FIELDS = [
    ['name', 'Full name', 'text'], ['email', 'Email', 'email'], ['phone', 'Phone', 'text'],
    ['title', 'Job title', 'text'], ['company', 'Company', 'text'], ['industry', 'Industry', 'text'],
    ['companySize', 'Company size', 'text'], ['website', 'Website', 'text'], ['linkedin', 'LinkedIn', 'text'],
    ['source', 'Source', 'text'], ['subBrand', 'Sub-brand', 'text'],
    ['treatmentOfInterest', 'Treatment of interest', 'text'], ['gst', 'GSTIN', 'text'],
    ['billingStateCode', 'Billing state', 'text'], ['stateCode', 'Residence state', 'text'],
    ['status', 'Lifecycle status', 'status'],
  ];

  const save = async (e) => {
    e.preventDefault();
    setSaving(true);
    try {
      const changed = {};
      for (const [k] of FIELDS) {
        const next = form[k] === '' ? null : form[k];
        if ((next ?? null) !== (contact[k] ?? null)) changed[k] = next;
      }
      if (Object.keys(changed).length) await patchContact(contact.id, changed);
      const nextOwner = ownerId === '' ? null : parseInt(ownerId, 10);
      if (nextOwner !== (contact.assignedToId ?? null)) await assignOwner(contact.id, nextOwner);
      notify.success('Contact saved.');
      refresh();
    } catch {
      notify.error('Failed to save contact.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <form className="cp-card" onSubmit={save}>
      <h3>Contact details</h3>
      <div className="cp-form-grid">
        {FIELDS.map(([k, label, kind]) => (
          <FormRow key={k} label={label}>
            {kind === 'status' ? (
              <select className="cp-input" value={form[k] || 'Lead'} onChange={set(k)}>
                {['Lead', 'Prospect', 'Customer', 'Churned', 'Junk'].map((s) => <option key={s} value={s}>{s}</option>)}
              </select>
            ) : (
              <input className="cp-input" type={kind === 'email' ? 'email' : 'text'} value={form[k] ?? ''} onChange={set(k)} />
            )}
          </FormRow>
        ))}
        <FormRow label="Sales owner">
          <select className="cp-input" value={ownerId} onChange={(e) => setOwnerId(e.target.value)}>
            <option value="">Unassigned</option>
            {staff.map((u) => <option key={u.id} value={u.id}>{u.name || u.email}</option>)}
          </select>
        </FormRow>
      </div>
      <div className="cp-btn-row">
        <button type="submit" className="cp-action-btn cp-action-primary" disabled={saving}>{saving ? 'Saving…' : 'Save changes'}</button>
      </div>
    </form>
  );
}

export function ConversationsTab({ contact, contactId, onOpenAction }) {
  const [filter, setFilter] = useState('all');
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    const [sms, threads] = await Promise.all([
      fetchSmsMessages(contactId),
      fetchEmailThreads(),
    ]);
    const email = contact.email ? contact.email.toLowerCase() : null;
    const emailItems = [];
    for (const t of threads) {
      for (const m of t.messages || []) {
        const mine = String(m.contactId) === String(contactId)
          || (email && [m.to, m.from].filter(Boolean).some((a) => String(a).toLowerCase().includes(email)));
        if (mine) {
          emailItems.push({
            id: `email-${m.id}`, channel: 'email', direction: m.direction || 'OUTBOUND',
            body: m.body || m.snippet || '', subject: m.subject || t.subject,
            personName: m.contactName || m.name || contact.name,
            createdAt: m.createdAt || t.lastAt,
          });
        }
      }
    }
    const norm = [
      ...sms.map((m) => ({
        id: `sms-${m.id}`,
        channel: 'sms',
        direction: m.direction || 'OUTBOUND',
        body: m.body,
        personName: m.contactName || m.contact?.name || m.name || contact.name,
        participant: m.direction === 'INBOUND' ? (m.from || m.sender || m.fromNumber) : (m.to || m.recipient || m.toNumber),
        createdAt: m.createdAt || m.sentAt || m.timestamp,
      })),
      ...emailItems,
    ].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    setItems(norm);
    setLoading(false);
  }, [contact.email, contact.name, contactId]);

  useEffect(() => { load(); }, [load]);

  const visible = filter === 'all' ? items : items.filter((i) => i.channel === filter);
  const groups = useMemo(() => {
    const grouped = new Map();
    visible.forEach((item) => {
      const parsed = new Date(item.createdAt);
      const key = Number.isNaN(parsed.getTime())
        ? 'unknown'
        : `${parsed.getFullYear()}-${String(parsed.getMonth() + 1).padStart(2, '0')}-${String(parsed.getDate()).padStart(2, '0')}`;
      if (!grouped.has(key)) grouped.set(key, []);
      grouped.get(key).push(item);
    });
    return [...grouped.entries()].sort(([a], [b]) => {
      if (a === 'unknown') return 1;
      if (b === 'unknown') return -1;
      return b.localeCompare(a);
    });
  }, [visible]);

  const dateLabel = (key) => {
    if (key === 'unknown') return 'Unknown date';
    return new Intl.DateTimeFormat(undefined, {
      year: 'numeric', month: 'long', day: 'numeric',
    }).format(new Date(`${key}T00:00:00`));
  };

  return (
    <div className="cp-card">
      <h3>Conversation ({items.length})</h3>
      <div className="cp-filters">
        {[['all', 'All'], ['email', 'Email'], ['sms', 'SMS']].map(([k, label]) => (
          <button key={k} type="button" className={`cp-filter${filter === k ? ' active' : ''}`} onClick={() => setFilter(k)}>{label}</button>
        ))}
        <span style={{ flex: 1 }} />
        {contact.email && <button type="button" className="cp-action-btn" onClick={() => onOpenAction?.('email')}>New email</button>}
        {contact.phone && <button type="button" className="cp-action-btn" onClick={() => onOpenAction?.('sms')}>New SMS</button>}
      </div>
      {loading ? (
        <div className="cp-empty">Loading conversations…</div>
      ) : visible.length === 0 ? (
        <div className="cp-empty">No messages yet. Start the conversation above.</div>
      ) : (
        <>
          <div className="cp-msg-list">
            {groups.map(([date, records]) => (
              <div key={date}>
                <div style={{ color: 'var(--text-secondary)', fontSize: '0.72rem', fontWeight: 700, margin: '0.65rem 0 0.4rem' }}>
                  {dateLabel(date)}
                </div>
                {records.map((m) => (
                  <div key={m.id} className={`cp-msg ${m.direction === 'OUTBOUND' ? 'out' : 'in'}`}>
                    <div className="cp-msg-subject">{m.personName || contact.name}</div>
                    <div className="cp-msg-meta">
                      {m.channel} • {formatDateTime(m.createdAt)}
                      {m.participant ? ` • ${m.direction === 'INBOUND' ? 'From' : 'To'} ${m.participant}` : ''}
                    </div>
                    {m.subject && <div className="cp-msg-subject">{m.subject}</div>}
                    <div>{m.body || '—'}</div>
                  </div>
                ))}
              </div>
            ))}
          </div>
          <div style={{ color: 'var(--text-secondary)', fontSize: '0.72rem', marginTop: '0.8rem' }}>
            Showing 1 - {visible.length} of {visible.length}
          </div>
        </>
      )}
    </div>
  );
}

const DOT = { Email: '#3b82f6', Call: '#f59e0b', Meeting: '#8b5cf6', Note: '#10b981', Deal: '#eab308' };

function ActivityTimeline({ contact, staff }) {
  const [filter, setFilter] = useState('All');
  const [activities, setActivities] = useState([]);
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const pageSize = 10;

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    fetchActivities(contact.id, page, pageSize)
      .then((result) => {
        if (cancelled) return;
        setActivities(result.data);
        setTotal(result.total);
        setTotalPages(result.totalPages);
      })
      .catch(() => {
        if (!cancelled) {
          setActivities([]);
          setTotal(0);
          setTotalPages(1);
        }
      })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [contact.id, contact.activities?.[0]?.id, page]);

  const types = useMemo(() => ['All', ...new Set(activities.map((a) => a.type).filter(Boolean))], [activities]);
  const visible = filter === 'All' ? activities : activities.filter((a) => a.type === filter);
  const authorOf = (a) => staff.find((u) => String(u.id) === String(a.userId))?.name
    || (a.userId ? `User #${a.userId}` : 'System');
  return (
    <div className="cp-card">
      <h3>Activities ({total})</h3>
      <div className="cp-filters">
        {types.map((t) => (
          <button key={t} type="button" className={`cp-filter${filter === t ? ' active' : ''}`} onClick={() => { setFilter(t); setPage(1); }}>{t}</button>
        ))}
        <span style={{ flex: 1 }} />
      </div>
      {loading ? (
        <div className="cp-empty">Loading activities…</div>
      ) : visible.length === 0 ? (
        <div className="cp-empty">No activities recorded yet.</div>
      ) : (
        <>
          <div className="cp-timeline">
          {visible.map((a) => (
            <div key={a.id} className="cp-timeline-item">
              <span className="cp-dot" style={{ background: DOT[a.type] || '#10b981' }} />
              <div>
                <div className="cp-timeline-meta">{formatDateTime(a.createdAt)} • {a.type} • {authorOf(a)}</div>
                <div>{a.description}</div>
              </div>
            </div>
          ))}
          </div>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '0.75rem', marginTop: '0.9rem' }}>
          <span style={{ color: 'var(--text-secondary)', fontSize: '0.72rem' }}>
            Showing {((page - 1) * pageSize) + 1} - {Math.min(page * pageSize, total)} of {total}
          </span>
          <div style={{ display: 'flex', gap: '0.4rem' }}>
            <button type="button" className="cp-filter" disabled={page <= 1} onClick={() => setPage((current) => Math.max(1, current - 1))}>Previous</button>
            <button type="button" className="cp-filter" disabled={page >= totalPages} onClick={() => setPage((current) => Math.min(totalPages, current + 1))}>Next</button>
          </div>
          </div>
        </>
      )}
    </div>
  );
}

export function ActivitiesTab({ contact, onAddActivity, staff }) {
  return <ActivityTimeline contact={contact} staff={staff} onAddActivity={onAddActivity} />;
}

export function AccountsTab({ contact, refresh, patchField }) {
  const notify = useNotify();
  const [siblings, setSiblings] = useState([]);
  const [linkName, setLinkName] = useState('');
  const [linking, setLinking] = useState(false);

  useEffect(() => {
    fetchSiblings().then((all) => {
      const mine = (contact.company || '').trim().toLowerCase();
      setSiblings(mine ? all.filter((c) => String(c.id) !== String(contact.id) && (c.company || '').trim().toLowerCase() === mine) : []);
    });
  }, [contact.id, contact.company]);

  const link = async (e) => {
    e.preventDefault();
    if (!linkName.trim()) return;
    setLinking(true);
    try {
      await patchField({ company: linkName.trim() });
      setLinkName('');
      notify.success('Account linked.');
    } finally {
      setLinking(false);
    }
  };

  const unlink = async () => {
    const ok = await notify.confirm({ title: 'Unlink account', message: `Remove ${contact.name} from ${contact.company}?`, confirmText: 'Unlink', destructive: true });
    if (!ok) return;
    await patchField({ company: null });
    refresh();
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
      <div className="cp-card">
        <h3><Building2 size={15} style={{ verticalAlign: '-2px' }} /> {contact.company || 'No account linked'}</h3>
        {contact.company ? (
          <>
            <div className="cp-grid">
              <div className="cp-field"><div className="cp-label">Industry</div><div className="cp-value">{contact.industry || 'Not available'}</div></div>
              <div className="cp-field"><div className="cp-label">Company size</div><div className="cp-value">{contact.companySize || 'Not available'}</div></div>
              <div className="cp-field"><div className="cp-label">Website</div><div className="cp-value">{contact.website ? <a href={/^https?:\/\//i.test(contact.website) ? contact.website : `https://${contact.website}`} target="_blank" rel="noopener noreferrer">{contact.website}</a> : 'Not available'}</div></div>
            </div>
            <div className="cp-btn-row"><button type="button" className="cp-action-btn" onClick={unlink}>Unlink account</button></div>
          </>
        ) : (
          <form onSubmit={link} className="cp-form">
            <FormRow label="Link to company"><input className="cp-input" value={linkName} onChange={(e) => setLinkName(e.target.value)} placeholder="Company name" /></FormRow>
            <div className="cp-btn-row"><button type="submit" className="cp-action-btn cp-action-primary" disabled={linking || !linkName.trim()}>{linking ? 'Linking…' : 'Link account'}</button></div>
          </form>
        )}
      </div>
      <div className="cp-card">
        <h3>People at {contact.company || 'this account'} ({siblings.length})</h3>
        {siblings.length === 0 ? (
          <div className="cp-empty">No other contacts linked to this account.</div>
        ) : (
          siblings.map((s) => (
            <div className="cp-row" key={s.id}>
              <Link to={`/contacts/${s.id}`} style={{ flex: 1, color: 'var(--primary-color, var(--accent-color))', textDecoration: 'none' }}>{s.name}</Link>
              <span style={{ color: 'var(--text-secondary)', fontSize: '0.75rem' }}>{[s.title, s.status].filter(Boolean).join(' • ')}</span>
            </div>
          ))
        )}
      </div>
    </div>
  );
}

export function DealsTab({ contact, refresh, onOpenDeal }) {
  const notify = useNotify();
  const deals = contact.deals || [];
  const total = deals.reduce((n, d) => n + (Number(d.amount) || 0), 0);
  const [savingId, setSavingId] = useState(null);

  const changeStage = async (deal, stage) => {
    setSavingId(deal.id);
    try {
      const updated = await updateDeal(deal.id, { stage });
      notify.success(`Deal moved to ${stage}.`);
      refresh(updated);
    } catch {
      notify.error('Failed to update deal stage.');
    } finally {
      setSavingId(null);
    }
  };

  return (
    <div className="cp-card">
      <h3>Deals ({deals.length}) • {formatMoney(total)}</h3>
      <div className="cp-btn-row" style={{ marginBottom: '0.75rem' }}>
        <button type="button" className="cp-action-btn cp-action-primary" onClick={() => onOpenDeal(null)}><Plus size={12} /> Add deal</button>
      </div>
      {deals.length === 0 ? (
        <div className="cp-empty">No deals associated with this contact.</div>
      ) : (
        deals.map((d) => (
          <div className="cp-row" key={d.id}>
            <button type="button" onClick={() => onOpenDeal(d)} style={{ flex: 1, background: 'none', border: 'none', textAlign: 'left', cursor: 'pointer', fontSize: '0.85rem', color: 'var(--text-primary)', padding: 0 }}>
              <span style={{ fontWeight: 600 }}>{d.title}</span>
              <span style={{ color: 'var(--text-secondary)', marginLeft: '0.5rem' }}>{formatMoney(d.amount, { currency: d.currency })}{d.expectedClose ? ` • closes ${formatDate(d.expectedClose)}` : ''}</span>
            </button>
            <select className="cp-input cp-stage-select" value={d.stage} disabled={savingId === d.id} onChange={(e) => changeStage(d, e.target.value)}>
              {DEAL_STAGES.map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
          </div>
        ))
      )}
    </div>
  );
}

export function InsightsTab({ contactId }) {
  const [score, setScore] = useState(null);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    fetchScore(contactId).then((d) => { setScore(d); setLoading(false); }).catch(() => setLoading(false));
  }, [contactId]);

  if (loading) return <div className="cp-card"><div className="cp-empty">Loading insights…</div></div>;
  if (!score) return <div className="cp-card"><div className="cp-empty">Insights unavailable for this contact.</div></div>;

  const f = score.factors || {};
  const tips = [];
  if (!f.recentActivities) tips.push('No engagement in the last 30 days — log a call or send a follow-up to re-activate this contact.');
  if (!f.wonDeals && (f.totalDeals || 0) > 0) tips.push('Open deals but no wins yet — review stalled stages and advance the strongest opportunity.');
  if (!(f.totalDeals || 0)) tips.push('No deals linked — create a first opportunity to start pipeline momentum.');
  if (!f.activeSequences) tips.push('Not enrolled in any sequence — consider adding this contact to a nurture sequence.');
  if ((f.proposalDeals || 0) > 0) tips.push(`${f.proposalDeals} deal${f.proposalDeals > 1 ? 's' : ''} in proposal — prioritize closing conversations this week.`);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
      <div className="cp-card">
        <h3>AI score</h3>
        <div className="cp-grid" style={{ gridTemplateColumns: 'repeat(2, minmax(0, 1fr))' }}>
          <div className="cp-field">
            <div className="cp-label">Stored score</div>
            <div className="cp-value" style={{ fontSize: '1.6rem', fontWeight: 700 }}>{score.currentStoredScore ?? 0}</div>
          </div>
          <div className="cp-field">
            <div className="cp-label">Live computed</div>
            <div className="cp-value" style={{ fontSize: '1.6rem', fontWeight: 700 }}>{score.liveComputedScore ?? 0}</div>
          </div>
        </div>
        <div style={{ marginTop: '0.5rem' }}><Stars value={Math.max(0, Math.min(5, Math.round((Number(score.currentStoredScore) || 0) / 20)))} size={15} /></div>
      </div>
      <div className="cp-card">
        <h3>Score breakdown</h3>
        <div className="cp-grid">
          {[['Status', f.status], ['Total deals', f.totalDeals], ['Won deals', f.wonDeals], ['Deals in proposal', f.proposalDeals], ['Recent activities (30d)', f.recentActivities], ['Active sequences', f.activeSequences]].map(([label, v]) => (
            <div className="cp-field" key={label}>
              <div className="cp-label">{label}</div>
              <div className="cp-value">{v ?? '—'}</div>
            </div>
          ))}
        </div>
      </div>
      <div className="cp-card">
        <h3>Recommendations</h3>
        {tips.length === 0 ? (
          <div className="cp-empty">This contact looks healthy — no urgent actions.</div>
        ) : (
          tips.map((t, i) => <div className="cp-row" key={i}><span>{t}</span></div>)
        )}
      </div>
    </div>
  );
}

export function FilesTab({ contactId }) {
  const notify = useNotify();
  const [files, setFiles] = useState([]);
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);

  const load = useCallback(() => {
    setLoading(true);
    fetchAttachments(contactId).then((d) => { setFiles(d); setLoading(false); }).catch(() => setLoading(false));
  }, [contactId]);
  useEffect(() => { load(); }, [load]);

  const onPick = async (e) => {
    const picked = Array.from(e.target.files || []);
    if (!picked.length) return;
    setUploading(true);
    try {
      const n = await uploadContactFiles(contactId, picked);
      notify.success(`Uploaded ${n} file${n === 1 ? '' : 's'}.`);
      load();
    } catch {
      notify.error('Upload failed.');
    } finally {
      setUploading(false);
      e.target.value = '';
    }
  };

  const remove = async (a) => {
    const ok = await notify.confirm({ title: 'Delete file', message: `Delete ${a.filename}?`, confirmText: 'Delete', destructive: true });
    if (!ok) return;
    try {
      await deleteAttachment(a.id);
      notify.success('File deleted.');
      load();
    } catch {
      notify.error('Failed to delete file.');
    }
  };

  return (
    <div className="cp-card">
      <h3>Files ({files.length})</h3>
      <div className="cp-btn-row" style={{ marginBottom: '0.75rem' }}>
        <label className="cp-action-btn cp-action-primary" style={{ cursor: 'pointer' }}>
          <Upload size={12} /> {uploading ? 'Uploading…' : 'Upload'}
          <input type="file" multiple hidden accept="image/*,.pdf,.doc,.docx,.xls,.xlsx,.csv" onChange={onPick} disabled={uploading} />
        </label>
      </div>
      {loading ? (
        <div className="cp-empty">Loading files…</div>
      ) : files.length === 0 ? (
        <div className="cp-empty">No files attached.</div>
      ) : (
        files.map((a) => (
          <div className="cp-row" key={a.id}>
            <FileText size={15} color="var(--primary-color, var(--accent-color))" />
            <a href={a.fileUrl} target="_blank" rel="noreferrer" style={{ flex: 1, color: 'var(--text-primary)', textDecoration: 'none', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{a.filename}</a>
            <span style={{ color: 'var(--text-secondary)', fontSize: '0.72rem' }}>{formatDate(a.createdAt)}</span>
            <a href={a.fileUrl} download={a.filename} className="cp-icon-btn" title="Download" aria-label="Download file"><Download size={13} /></a>
            <button type="button" className="cp-icon-btn" onClick={() => remove(a)} title="Delete" aria-label="Delete file"><Trash2 size={13} /></button>
          </div>
        ))
      )}
    </div>
  );
}
