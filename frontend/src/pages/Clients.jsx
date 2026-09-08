import { fetchApi } from '../utils/api';
import React, { useState, useEffect, useRef } from 'react';
import { Building2, Search } from 'lucide-react';
import { Link } from 'react-router-dom';
import { formatDateMedium as formatDate } from '../utils/date';
import TopScrollSync from '../components/TopScrollSync';

const SEARCH_DEBOUNCE_MS = 300;

const Clients = () => {
  // `clients` holds ONLY the current page's rows — paging is server-driven
  // via ?limit=&offset=, and the header/footer totals come from the
  // backend ?count=1 (same status filter), not from a full download.
  const [clients, setClients] = useState([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [searchTerm, setSearchTerm] = useState('');
  const [debouncedTerm, setDebouncedTerm] = useState('');
  const [currentPage, setCurrentPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);
  const requestIdRef = useRef(0);

  // Debounce search so typing doesn't fire a request per keystroke.
  useEffect(() => {
    const t = setTimeout(() => setDebouncedTerm(searchTerm.trim()), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [searchTerm]);

  useEffect(() => {
    const myId = ++requestIdRef.current;
    const isCurrent = () => myId === requestIdRef.current;
    const term = debouncedTerm.trim();
    setLoading(true);
    const load = async () => {
      try {
        const offset = (currentPage - 1) * pageSize;
        const search = term ? `&q=${encodeURIComponent(term)}` : '';
        const [rows, countRes] = await Promise.all([
          fetchApi(`/api/contacts?status=Customer&limit=${pageSize}&offset=${offset}${search}`),
          fetchApi(`/api/contacts?status=Customer&count=1${search}`),
        ]);
        if (!isCurrent()) return;
        const list = Array.isArray(rows) ? rows : [];
        setClients(list);
        const serverTotal = countRes && typeof countRes.total === 'number' ? countRes.total : null;
        setTotal(serverTotal != null ? serverTotal : offset + list.length);
      } catch {
        if (!isCurrent()) return;
        setClients([]);
        setTotal(0);
      } finally {
        if (isCurrent()) setLoading(false);
      }
    };
    load();
  }, [currentPage, pageSize, debouncedTerm]);

  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const safePage = Math.min(Math.max(1, currentPage), totalPages);
  const startIndex = (safePage - 1) * pageSize;
  const startItem = total === 0 ? 0 : startIndex + 1;
  const endItem = Math.min(startIndex + pageSize, total);

  // If the total shrinks under the current page (records deleted elsewhere),
  // step back to the last valid page (refetch converges: totalPages >= 1).
  useEffect(() => {
    if (!loading && currentPage > totalPages) setCurrentPage(totalPages);
  }, [loading, currentPage, totalPages]);

  return (
    <div style={{ padding: '2rem', animation: 'fadeIn 0.3s ease' }}>
      <header style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '2rem' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
          <Building2 size={24} style={{ color: 'var(--accent-color)' }} />
          <div>
            <h2 style={{ fontSize: '1.5rem', fontWeight: 'bold' }}>Clients</h2>
            <p style={{ color: 'var(--text-secondary)', fontSize: '0.875rem' }}>
              {total} active client{total !== 1 ? 's' : ''}
            </p>
          </div>
        </div>
      </header>

      <div className="card" style={{ overflow: 'visible' }}>
        <div style={{ padding: '1rem', borderBottom: '1px solid var(--border-color)' }}>
          <div style={{ position: 'relative', maxWidth: '300px' }}>
            <Search size={18} style={{ position: 'absolute', left: '1rem', top: '50%', transform: 'translateY(-50%)', color: 'var(--text-secondary)' }} />
            <input
              type="text"
              className="input-field"
              placeholder="Search clients..."
              value={searchTerm}
              onChange={e => { setSearchTerm(e.target.value); setCurrentPage(1); }}
              style={{ paddingLeft: '2.5rem', backgroundColor: 'var(--surface-hover)' }}
            />
          </div>
        </div>

        <TopScrollSync>
        <table style={{ width: '100%', borderCollapse: 'collapse', textAlign: 'left' }}>
          <thead>
            <tr style={{ borderBottom: '1px solid var(--border-color)', backgroundColor: 'var(--table-header-bg)' }}>
              <th style={{ padding: '1rem', color: 'var(--text-secondary)', fontWeight: '500', fontSize: '0.875rem' }}>Name</th>
              <th style={{ padding: '1rem', color: 'var(--text-secondary)', fontWeight: '500', fontSize: '0.875rem' }}>Email</th>
              <th style={{ padding: '1rem', color: 'var(--text-secondary)', fontWeight: '500', fontSize: '0.875rem' }}>Company</th>
              <th style={{ padding: '1rem', color: 'var(--text-secondary)', fontWeight: '500', fontSize: '0.875rem' }}>Title</th>
              {/* #593: rules-based score (leadScoringEngine.js); dropped misleading "AI" prefix. */}
              <th style={{ padding: '1rem', color: 'var(--text-secondary)', fontWeight: '500', fontSize: '0.875rem' }}>Lead Score</th>
              <th style={{ padding: '1rem', color: 'var(--text-secondary)', fontWeight: '500', fontSize: '0.875rem' }}>Since</th>
            </tr>
          </thead>
          <tbody>
            {loading && clients.length === 0 ? (
              <tr><td colSpan="6" style={{ padding: '2rem', textAlign: 'center', color: 'var(--text-secondary)' }}>Loading clients...</td></tr>
            ) : clients.length === 0 ? (
              <tr><td colSpan="6" style={{ padding: '2rem', textAlign: 'center', color: 'var(--text-secondary)' }}>No clients found</td></tr>
            ) : clients.map(client => (
              <tr key={client.id} style={{ borderBottom: '1px solid var(--border-color)' }} className="table-row-hover">
                <td style={{ padding: '1rem' }}>
                  <div style={{ fontWeight: '500' }}>
                    <Link
                      to={`/contacts/${client.id}`}
                      style={{
                        color: 'var(--text-primary)',
                        textDecoration: 'none',
                        display: 'block',
                        pointerEvents: 'all',
                        position: 'relative',
                        zIndex: 10,
                      }}
                      className="hover-underline"
                    >
                      {client.name}
                    </Link>
                  </div>
                </td>
                <td style={{ padding: '1rem', color: 'var(--text-secondary)' }}>{client.email}</td>
                <td style={{ padding: '1rem', color: 'var(--text-secondary)' }}>{client.company}</td>
                <td style={{ padding: '1rem', color: 'var(--text-secondary)' }}>{client.title}</td>
                <td style={{ padding: '1rem' }}>
                  <span style={{
                    padding: '0.25rem 0.75rem',
                    borderRadius: '999px',
                    fontSize: '0.75rem',
                    fontWeight: 'bold',
                    backgroundColor: client.aiScore > 75 ? 'rgba(16, 185, 129, 0.1)' : client.aiScore > 40 ? 'rgba(245, 158, 11, 0.1)' : 'rgba(239, 68, 68, 0.1)',
                    color: client.aiScore > 75 ? 'var(--success-color)' : client.aiScore > 40 ? 'var(--warning-color)' : '#ef4444',
                  }}>
                    {client.aiScore}/100
                  </span>
                </td>
                <td style={{ padding: '1rem', color: 'var(--text-secondary)', fontSize: '0.875rem' }}>
                  {formatDate(client.createdAt)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        </TopScrollSync>

        {!loading && total > 0 && (
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '1rem', flexWrap: 'wrap', padding: '1rem', borderTop: '1px solid var(--border-color)' }}>
            <p style={{ color: 'var(--text-secondary)', fontSize: '0.875rem', margin: 0 }}>
              Showing {startItem}-{endItem} of {total} client{total !== 1 ? 's' : ''}
            </p>
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
              <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', color: 'var(--text-secondary)', fontSize: '0.875rem' }}>
                <span>Rows per page</span>
                <select
                  aria-label="Rows per page"
                  value={String(pageSize)}
                  onChange={e => { setPageSize(Number(e.target.value)); setCurrentPage(1); }}
                  style={{ padding: '0.5rem 0.6rem', borderRadius: '8px', border: '1px solid var(--border-color)', background: 'var(--input-bg, var(--surface-hover))', color: 'var(--text-primary)' }}
                >
                  {[10, 15, 25, 50].map(size => (
                    <option key={size} value={size}>{size}</option>
                  ))}
                </select>
              </label>
              <button
                type="button"
                className="btn-secondary"
                onClick={() => setCurrentPage(prev => Math.max(1, Math.min(prev, totalPages) - 1))}
                disabled={safePage <= 1}
                aria-label="Previous page"
                style={{ padding: '0.6rem 1rem', opacity: safePage <= 1 ? 0.6 : 1, cursor: safePage <= 1 ? 'not-allowed' : 'pointer' }}
              >
                Previous
              </button>
              <span style={{ color: 'var(--text-secondary)', fontSize: '0.875rem' }}>
                Page {safePage} of {totalPages}
              </span>
              <button
                type="button"
                className="btn-secondary"
                onClick={() => setCurrentPage(prev => Math.min(totalPages, Math.min(prev, totalPages) + 1))}
                disabled={safePage >= totalPages}
                aria-label="Next page"
                style={{ padding: '0.6rem 1rem', opacity: safePage >= totalPages ? 0.6 : 1, cursor: safePage >= totalPages ? 'not-allowed' : 'pointer' }}
              >
                Next
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

export default Clients;
