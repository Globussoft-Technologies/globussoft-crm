import { useEffect, useState } from 'react';
import Modal from './ui/Modal';
import Pagination from './ui/Pagination';
import { fetchApi } from '../utils/api';
import { formatDateTime } from '../utils/date';

const displayValue = (value) => value == null ? '—' : typeof value === 'object' ? JSON.stringify(value) : String(value);
const cellStyle = {
  padding: 12,
  borderBottom: '1px solid var(--border-color)',
  whiteSpace: 'pre-wrap',
  overflow: 'visible',
  textOverflow: 'clip',
  overflowWrap: 'break-word',
  wordBreak: 'normal',
  verticalAlign: 'top',
};

export default function WebFormLeadsModal({ form, onClose, onOpenLead }) {
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError('');
    const timer = setTimeout(async () => {
      try {
        const result = await fetchApi(`/api/forms/${form.id}/leads?${new URLSearchParams({ page, limit: 10, search })}`);
        if (active) setData(result);
      } catch (err) {
        if (active) setError(err.message || 'Failed to load form leads');
      } finally {
        if (active) setLoading(false);
      }
    }, 300);
    return () => { active = false; clearTimeout(timer); };
  }, [form.id, page, search]);

  const fields = data?.fields || form.fields || [];
  const openLead = (lead) => {
    if (!lead.contactId || !onOpenLead) return;
    onOpenLead(lead.contactId);
  };
  return (
    <Modal open title={`Leads — ${form.name}`} onClose={onClose} size="large" style={{ minWidth: 0, height: '80vh', maxHeight: '80vh', boxSizing: 'border-box', background: 'var(--modal-bg)' }} contentStyle={{ overflow: 'hidden', padding: '0.75rem 1rem', display: 'flex', flexDirection: 'column', minHeight: 0 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 10 }}>
        <input className="input-field" type="search" aria-label="Search form leads" placeholder="Search form leads…" value={search}
          onChange={(event) => { setSearch(event.target.value); setPage(1); }} style={{ flex: 1, minWidth: 0 }} />
        <a className="btn-secondary" href={`/leads?${new URLSearchParams({ webForm: form.name })}`} style={{ flexShrink: 0, whiteSpace: 'nowrap', textDecoration: 'none' }}>View in Leads</a>
      </div>
      <div title="Red rows are Web Form submissions whose related record is not currently available as an active Lead." style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 10, color: '#b91c1c', fontSize: '0.82rem' }}>
        <span aria-hidden="true" style={{ width: 8, height: 8, borderRadius: '50%', backgroundColor: '#b91c1c', flexShrink: 0 }} />
        <span>Red rows indicate submissions that are not active Leads.</span>
      </div>
      {error ? <p role="alert">{error}</p> : loading ? <p role="status">Loading leads…</p> : (
        <>
          <div style={{ flex: '1 1 auto', minHeight: 0, minWidth: 0, overflow: 'auto', overscrollBehavior: 'contain' }}>
            <table className="web-form-leads-table" style={{ width: '100%', minWidth: Math.max((fields.length + 2) * 180, 720), borderCollapse: 'collapse', textAlign: 'left', tableLayout: 'fixed' }}>
              <colgroup>
                {fields.map((field, index) => <col key={`${field.id}-${index}`} style={{ width: 180 }} />)}
                <col style={{ width: 180 }} />
                <col style={{ width: 180 }} />
              </colgroup>
              <thead style={{ position: 'sticky', top: 0, zIndex: 1 }}><tr style={{ backgroundColor: 'var(--table-header-bg)' }}>{fields.map((field, index) => <th style={cellStyle} key={`${field.id}-${index}`}>{field.label}</th>)}<th style={cellStyle}>Created</th><th style={cellStyle}>Last Updated</th></tr></thead>
              <tbody style={{ display: 'table-row-group' }}>{data?.leads.map((lead) => {
                const isMissingFromLeads = lead.isLead === false || Boolean(lead.deletedAt);
                const missingMessage = lead.deletedAt
                  ? 'This lead was deleted from Leads'
                  : lead.contactId
                    ? 'This submission is no longer a Lead and is not present in Leads'
                    : 'This submission no longer has a lead record in Leads';
                const canOpenLead = Boolean(onOpenLead && lead.contactId && !isMissingFromLeads);
                const rowCellStyle = isMissingFromLeads ? { ...cellStyle, color: '#b91c1c', backgroundColor: 'rgba(239, 68, 68, 0.1)' } : cellStyle;
                return (
                <tr
                  key={lead.id}
                  className={canOpenLead ? 'table-row-hover' : undefined}
                  role={canOpenLead ? 'link' : undefined}
                  tabIndex={canOpenLead ? 0 : undefined}
                  title={isMissingFromLeads ? `Marked red: not an active Lead. ${missingMessage}` : canOpenLead ? 'Open lead detail' : undefined}
                  aria-label={isMissingFromLeads ? 'Submission not present in Leads' : canOpenLead ? `Open submitted lead ${displayValue(lead.values.find((value) => value != null && value !== ''))}` : undefined}
                  onClick={() => { if (canOpenLead) openLead(lead); }}
                  onKeyDown={(event) => {
                    if (!canOpenLead || (event.key !== 'Enter' && event.key !== ' ')) return;
                    event.preventDefault();
                    openLead(lead);
                  }}
                  style={isMissingFromLeads
                    ? { display: 'table-row', color: '#b91c1c', backgroundColor: 'rgba(239, 68, 68, 0.1)' }
                    : { display: 'table-row', cursor: canOpenLead ? 'pointer' : undefined }}
                >
                  {fields.map((field, index) => <td key={`${field.id}-${index}`} style={rowCellStyle}>{displayValue(lead.values[index])}</td>)}
                  <td style={rowCellStyle}>{formatDateTime(lead.createdAt)}</td><td style={rowCellStyle}>{formatDateTime(lead.updatedAt)}</td>
                </tr>
                );
              })}</tbody>
            </table>
          </div>
          {!data?.leads.length && <p>No leads found for this web form.</p>}
          <Pagination page={page} pageSize={10} total={data?.total || 0} onChange={setPage} style={{ flex: '0 0 auto', margin: 0 }} />
        </>
      )}
    </Modal>
  );
}
