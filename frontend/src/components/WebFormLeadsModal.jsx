import { useEffect, useState } from 'react';
import Modal from './ui/Modal';
import Pagination from './ui/Pagination';
import { fetchApi } from '../utils/api';
import { formatDateTime } from '../utils/date';

const displayValue = (value) => value == null ? '—' : typeof value === 'object' ? JSON.stringify(value) : String(value);
const cellStyle = { padding: 12, borderBottom: '1px solid var(--border-color)', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' };

export default function WebFormLeadsModal({ form, onClose }) {
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
  return (
    <Modal open title={`Leads — ${form.name}`} onClose={onClose} size="large" style={{ minWidth: 0, height: '80vh', maxHeight: '80vh', background: 'var(--modal-bg)' }} contentStyle={{ overflow: 'hidden', padding: '0.75rem 1rem' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 10 }}>
        <input className="input-field" type="search" aria-label="Search form leads" placeholder="Search form leads…" value={search}
          onChange={(event) => { setSearch(event.target.value); setPage(1); }} style={{ flex: 1, minWidth: 0 }} />
        <a className="btn-secondary" href={`/leads?${new URLSearchParams({ webForm: form.name })}`} style={{ flexShrink: 0, whiteSpace: 'nowrap', textDecoration: 'none' }}>View in Leads</a>
      </div>
      {error ? <p role="alert">{error}</p> : loading ? <p role="status">Loading leads…</p> : (
        <>
          <div style={{ height: 'calc(80vh - 170px)', minHeight: 180, overflowX: 'auto', overflowY: 'hidden', overscrollBehavior: 'contain' }}>
            <table className="stable-table" style={{ width: '100%', minWidth: (fields.length + 2) * 180, borderCollapse: 'collapse', textAlign: 'left', display: 'block' }}>
              <thead style={{ display: 'table', width: '100%', tableLayout: 'fixed' }}><tr style={{ backgroundColor: 'var(--table-header-bg)' }}>{fields.map((field, index) => <th style={cellStyle} key={`${field.id}-${index}`}>{field.label}</th>)}<th style={cellStyle}>Created</th><th style={cellStyle}>Last Updated</th></tr></thead>
              <tbody style={{ display: 'block', maxHeight: 'calc(80vh - 235px)', overflowY: 'auto', overflowX: 'hidden' }}>{data?.leads.map((lead) => (
                <tr key={lead.id} style={{ display: 'table', width: '100%', tableLayout: 'fixed' }}>
                  {fields.map((field, index) => <td key={`${field.id}-${index}`} style={cellStyle}>{displayValue(lead.values[index])}</td>)}
                  <td style={cellStyle}>{formatDateTime(lead.createdAt)}</td><td style={cellStyle}>{formatDateTime(lead.updatedAt)}</td>
                </tr>
              ))}</tbody>
            </table>
          </div>
          {!data?.leads.length && <p>No leads found for this web form.</p>}
          <Pagination page={page} pageSize={10} total={data?.total || 0} onChange={setPage} />
        </>
      )}
    </Modal>
  );
}
