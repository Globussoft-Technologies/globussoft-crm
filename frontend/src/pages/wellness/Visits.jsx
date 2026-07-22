import { useEffect, useState, useCallback } from 'react';
import { ChevronLeft, Phone, Calendar, ChevronRight } from 'lucide-react';
import { fetchApi } from '../../utils/api';
import { formatMoney } from '../../utils/money';
import { formatDate } from '../../utils/date';
import { DateRangeFilter, resolveDateRangeYmd } from '../../components/wellness/DateRangeFilter';
import TopScrollSync from '../../components/TopScrollSync';

export default function Visits() {
  // Visit reports require a window — opt out of the "All time" option in the
  // dropdown and default to last30 (matches the prior 30-day default).
  const [filter, setFilter] = useState({ preset: 'last30', start: '', end: '' });
  const [from, to] = resolveDateRangeYmd(filter);
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [skip, setSkip] = useState(0);
  const [limit, setLimit] = useState(10);
  const [customLimit, setCustomLimit] = useState('');
  const [isCustomLimit, setIsCustomLimit] = useState(false);
  const [selectedPatient, setSelectedPatient] = useState(null);
  const [patientDetails, setPatientDetails] = useState(null);
  const [detailsLoading, setDetailsLoading] = useState(false);
  const [detailsSkip, setDetailsSkip] = useState(0);
  const [detailsLimit, setDetailsLimit] = useState(10);
  const [customDetailsLimit, setCustomDetailsLimit] = useState('');
  const [isCustomDetailsLimit, setIsCustomDetailsLimit] = useState(false);

  const loadVisits = useCallback(() => {
    if (!from || !to) return; // 'custom' preset with no dates yet — skip fetch
    setLoading(true);
    let cancelled = false;
    const url = `/api/wellness/reports/visit?startDate=${from}&endDate=${to}&skip=${skip}&limit=${limit}`;
    fetchApi(url)
      .then((res) => { if (!cancelled) setData(res); })
      .catch(() => { if (!cancelled) setData(null); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [from, to, skip, limit]);

  const loadPatientDetails = useCallback((patientId) => {
    if (!from || !to) return;
    setDetailsLoading(true);
    let cancelled = false;
    const url = `/api/wellness/reports/visit/${patientId}?startDate=${from}&endDate=${to}&skip=${detailsSkip}&limit=${detailsLimit}`;
    fetchApi(url)
      .then((res) => { if (!cancelled) setPatientDetails(res); })
      .catch(() => { if (!cancelled) setPatientDetails(null); })
      .finally(() => { if (!cancelled) setDetailsLoading(false); });
    return () => { cancelled = true; };
  }, [from, to, detailsSkip, detailsLimit]);

  useEffect(() => {
    const cleanup = loadVisits();
    return cleanup;
  }, [loadVisits]);

  useEffect(() => {
    if (!selectedPatient) return;
    const cleanup = loadPatientDetails(selectedPatient.id);
    return cleanup;
  }, [selectedPatient, loadPatientDetails]);

  // Reset pagination whenever the date range changes so we don't show "page 4"
  // of a window that may have far fewer pages now.
  useEffect(() => { setSkip(0); }, [from, to]);

  const handlePatientClick = (patient) => {
    setSelectedPatient(patient);
    setDetailsSkip(0);
  };

  const handleDetailsPageChange = (direction) => {
    const newSkip = Math.max(0, detailsSkip + (direction === 'next' ? detailsLimit : -detailsLimit));
    setDetailsSkip(newSkip);
  };

  const handlePageChange = (direction) => {
    const newSkip = Math.max(0, skip + (direction === 'next' ? limit : -limit));
    setSkip(newSkip);
  };

  if (selectedPatient && patientDetails) {
    return (
      <div style={{ padding: '2rem 2.25rem', animation: 'fadeIn 0.5s ease-out' }}>
        <button
          onClick={() => setSelectedPatient(null)}
          style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', padding: '0.5rem 1rem', background: 'var(--subtle-bg-2)', border: '1px solid var(--border-color)', borderRadius: 8, cursor: 'pointer', color: 'var(--text-primary)', fontSize: '0.85rem', marginBottom: '1.5rem' }}
        >
          <ChevronLeft size={16} /> Back to Visits List
        </button>

        <header style={{ marginBottom: '1.5rem' }}>
          <h2 style={{ fontSize: '1.5rem', fontWeight: 600, display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            Visits for {patientDetails.data.patient.name}
          </h2>
          <p style={{ color: 'var(--text-secondary)', marginTop: '0.25rem' }}>
            {patientDetails.count} visit{patientDetails.count === 1 ? '' : 's'} in selected period
          </p>
        </header>

        <div style={{ display: 'flex', gap: '0.5rem', marginBottom: '1rem', alignItems: 'center', justifyContent: 'flex-end' }}>
          <label style={{ color: 'var(--text-secondary)', fontSize: '0.85rem' }}>Per page:</label>
          {isCustomDetailsLimit ? (
            <>
              <input
                type="number"
                min="1"
                max="50"
                value={customDetailsLimit}
                onChange={(e) => { const val = Math.min(Math.max(parseInt(e.target.value) || '', 1), 50); setCustomDetailsLimit(val); if (val) setDetailsLimit(val); setDetailsSkip(0); }}
                placeholder="Enter 1-50"
                style={paginationInput}
                autoFocus
                title="Enter a number between 1 and 50"
              />
              <button onClick={() => { setIsCustomDetailsLimit(false); setCustomDetailsLimit(''); }} style={paginationSelect}>Back</button>
            </>
          ) : (
            <select value={detailsLimit} onChange={(e) => {
              if (e.target.value === 'custom') {
                setIsCustomDetailsLimit(true);
                setCustomDetailsLimit('');
              } else {
                setDetailsLimit(parseInt(e.target.value));
                setDetailsSkip(0);
              }
            }} style={paginationSelect}>
              <option value="10">10</option>
              <option value="20">20</option>
              <option value="50">50</option>
              <option value="custom">Custom</option>
            </select>
          )}
        </div>

        <div className="glass" style={{ padding: 0, overflow: 'visible' }}>
          <TopScrollSync>
          <table style={{ width: '100%', borderCollapse: 'collapse', tableLayout: 'fixed' }}>
            <colgroup>
              <col style={{ width: '15%' }} />
              <col style={{ width: '20%' }} />
              <col style={{ width: '25%' }} />
              <col style={{ width: '15%' }} />
              <col style={{ width: '15%' }} />
              <col style={{ width: '10%' }} />
            </colgroup>
            <thead>
              <tr style={{ borderBottom: '1px solid var(--border-color)', background: 'var(--subtle-bg-3)' }}>
                <th style={{ ...thStyle, textAlign: 'left' }}>Date</th>
                <th style={{ ...thStyle, textAlign: 'left' }}>Doctor</th>
                <th style={{ ...thStyle, textAlign: 'left' }}>Service</th>
                <th style={{ ...thStyle, textAlign: 'right' }}>Amount</th>
                <th style={{ ...thStyle, textAlign: 'left' }}>Status</th>
                <th style={{ ...thStyle, textAlign: 'left' }}>Notes</th>
              </tr>
            </thead>
            <tbody>
              {(patientDetails.data?.visits || []).map((visit) => (
                <tr key={visit.id} style={{ borderBottom: '1px solid var(--border-color)' }}>
                  <td style={{ ...tdStyle, textAlign: 'left' }}>
                    {formatDate(visit.visitDate)}
                  </td>
                  <td style={{ ...tdStyle, textAlign: 'left' }}>
                    {visit.doctor?.name || '—'}
                  </td>
                  <td style={{ ...tdStyle, textAlign: 'left', overflow: 'hidden', textOverflow: 'ellipsis' }} title={visit.service?.name}>
                    {visit.service?.name || '—'}
                  </td>
                  <td style={{ ...tdStyle, textAlign: 'right' }}>
                    {formatMoney(
                      visit.revenue != null ? visit.revenue : (visit.amountCharged || 0)
                    )}
                  </td>
                  <td style={{ ...tdStyle, textAlign: 'left' }}>
                    <span style={{ fontSize: '0.75rem', textTransform: 'capitalize', padding: '0.2rem 0.5rem', borderRadius: 4, background: statusBg(visit.status) }}>
                      {visit.status || '—'}
                    </span>
                  </td>
                  <td style={{ ...tdStyle, textAlign: 'left', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    {visit.notes ? visit.notes.substring(0, 20) + (visit.notes.length > 20 ? '...' : '') : '—'}
                  </td>
                </tr>
              ))}
              {(patientDetails.data?.visits || []).length === 0 && (
                <tr>
                  <td colSpan={6} style={{ ...tdStyle, textAlign: 'center', color: 'var(--text-secondary)' }}>
                    No visits in selected period.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
          </TopScrollSync>
        </div>

        {patientDetails.count > detailsLimit && (
          <div style={{ display: 'flex', gap: '0.5rem', justifyContent: 'center', marginTop: '1.25rem' }}>
            <button
              disabled={detailsSkip === 0 || detailsLoading}
              onClick={() => handleDetailsPageChange('prev')}
              style={paginationButton(detailsSkip === 0)}
            >
              Previous
            </button>
            <span style={{ padding: '0.5rem 1rem', color: 'var(--text-secondary)', fontSize: '0.85rem' }}>
              {detailsSkip + 1} – {Math.min(detailsSkip + detailsLimit, patientDetails.count)} of {patientDetails.count}
            </span>
            <button
              disabled={detailsSkip + detailsLimit >= patientDetails.count || detailsLoading}
              onClick={() => handleDetailsPageChange('next')}
              style={paginationButton(detailsSkip + detailsLimit >= patientDetails.count)}
            >
              Next
            </button>
          </div>
        )}
      </div>
    );
  }

  return (
    <div style={{ padding: '2rem 2.25rem', animation: 'fadeIn 0.5s ease-out' }}>
      <header style={{ marginBottom: '1.5rem' }}>
        <h1 style={{ fontSize: '1.75rem', fontWeight: 700, display: 'flex', alignItems: 'center', gap: '0.6rem', margin: 0 }}>
          <Calendar size={24} /> Visits
        </h1>
        <p style={{ color: 'var(--text-secondary)', marginTop: '0.35rem', marginBottom: 0, fontSize: '0.9rem' }}>
          Patient visits — filterable by date.
        </p>
      </header>

      <div style={{ display: 'flex', gap: '0.5rem', marginBottom: '1rem', flexWrap: 'wrap', alignItems: 'center' }}>
        <DateRangeFilter value={filter} onChange={setFilter} label={null} includeAllOption={false} />
        <div style={{ flex: 1 }} />
        <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
          <label style={{ color: 'var(--text-secondary)', fontSize: '0.85rem' }}>Per page:</label>
          {isCustomLimit ? (
            <>
              <input
                type="number"
                min="1"
                max="50"
                value={customLimit}
                onChange={(e) => { const val = Math.min(Math.max(parseInt(e.target.value) || '', 1), 50); setCustomLimit(val); if (val) setLimit(val); setSkip(0); }}
                placeholder="Enter 1-50"
                style={paginationInput}
                autoFocus
                title="Enter a number between 1 and 50"
              />
              <button onClick={() => { setIsCustomLimit(false); setCustomLimit(''); }} style={{ padding: '0.45rem 0.6rem', background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.08)', borderRadius: 8, color: 'var(--text-primary)', fontSize: '0.85rem', cursor: 'pointer' }}>Back</button>
            </>
          ) : (
            <select value={limit} onChange={(e) => {
              if (e.target.value === 'custom') {
                setIsCustomLimit(true);
                setCustomLimit('');
              } else {
                setLimit(parseInt(e.target.value));
                setSkip(0);
              }
            }} style={paginationSelect}>
              <option value="10">10</option>
              <option value="20">20</option>
              <option value="50">50</option>
              <option value="custom">Custom</option>
            </select>
          )}
        </div>
      </div>

      {loading && <div>Loading…</div>}

      {!loading && data && (
        <>
          <div className="glass" style={{ padding: '1.25rem 1.5rem', marginBottom: '1.25rem', display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 220px), 1fr))', gap: '1rem' }}>
            <div style={{ padding: '0.25rem 0.5rem' }}>
              <div style={{ fontSize: '0.72rem', color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '0.06em', fontWeight: 600 }}>Patients with Visits</div>
              <div style={{ fontSize: '1.6rem', fontWeight: 700, marginTop: '0.4rem' }}>{data.count.toLocaleString('en-IN')}</div>
            </div>
            <div style={{ padding: '0.25rem 0.5rem', borderLeft: '1px solid var(--border-color)' }}>
              <div style={{ fontSize: '0.72rem', color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '0.06em', fontWeight: 600 }}>Revenue</div>
              <div style={{ fontSize: '1.6rem', fontWeight: 700, marginTop: '0.4rem', color: 'var(--success-color)' }}>
                {formatMoney(data.totalRevenue || 0)}
              </div>
            </div>
          </div>

          <div className="glass" style={{ padding: 0, overflow: 'visible' }}>
            <TopScrollSync>
            <table style={{ width: '100%', borderCollapse: 'collapse', tableLayout: 'fixed' }}>
              <colgroup>
                <col style={{ width: '25%' }} />
                <col style={{ width: '20%' }} />
                <col style={{ width: '15%' }} />
                <col style={{ width: '20%' }} />
                <col style={{ width: '20%' }} />
              </colgroup>
              <thead>
                <tr style={{ borderBottom: '1px solid var(--border-color)', background: 'var(--subtle-bg-3)' }}>
                  <th style={{ ...thStyle, textAlign: 'left' }}>Patient Name</th>
                  <th style={{ ...thStyle, textAlign: 'left' }}>Phone</th>
                  <th style={{ ...thStyle, textAlign: 'right' }}>Total Visits</th>
                  <th style={{ ...thStyle, textAlign: 'right' }}>Total Revenue</th>
                  <th style={{ ...thStyle, textAlign: 'left' }}>Last Visit</th>
                </tr>
              </thead>
              <tbody>
                {(data.data || []).map((patient) => (
                  <tr
                    key={patient.id}
                    onClick={() => handlePatientClick(patient)}
                    style={{ borderBottom: '1px solid var(--border-color)', cursor: 'pointer', transition: 'background 0.2s' }}
                    onMouseEnter={(e) => e.currentTarget.style.background = 'var(--subtle-bg-2)'}
                    onMouseLeave={(e) => e.currentTarget.style.background = 'transparent'}
                  >
                    <td style={{ ...tdStyle, textAlign: 'left', color: 'var(--primary-color, var(--accent-color))', fontWeight: 600 }}>
                      {patient.name}
                    </td>
                    <td style={{ ...tdStyle, textAlign: 'left' }}>
                      {patient.phone ? (
                        <span style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
                          <Phone size={14} /> {patient.phone}
                        </span>
                      ) : (
                        '—'
                      )}
                    </td>
                    <td style={{ ...tdStyle, textAlign: 'right' }}>
                      {patient.totalVisits.toLocaleString('en-IN')}
                    </td>
                    <td style={{ ...tdStyle, textAlign: 'right', color: 'var(--success-color)', fontWeight: 600 }}>
                      {formatMoney(patient.totalRevenue)}
                    </td>
                    <td style={{ ...tdStyle, textAlign: 'left' }}>
                      {patient.lastVisit ? formatDate(patient.lastVisit) : '—'}
                    </td>
                  </tr>
                ))}
                {data.data.length === 0 && (
                  <tr>
                    <td colSpan={5} style={{ ...tdStyle, textAlign: 'center', color: 'var(--text-secondary)' }}>
                      No visits in this period.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
            </TopScrollSync>
          </div>

          {data.count > limit && (
            <div style={{ display: 'flex', gap: '0.5rem', justifyContent: 'center', marginTop: '1.25rem', alignItems: 'center', flexWrap: 'wrap' }}>
              <button
                disabled={skip === 0 || loading}
                onClick={() => handlePageChange('prev')}
                style={paginationButton(skip === 0)}
              >
                <ChevronLeft size={14} /> Previous
              </button>
              <span style={{ padding: '0.5rem 1rem', color: 'var(--text-secondary)', fontSize: '0.85rem' }}>
                {skip + 1} – {Math.min(skip + limit, data.count)} of {data.count}
              </span>
              <button
                disabled={skip + limit >= data.count || loading}
                onClick={() => handlePageChange('next')}
                style={paginationButton(skip + limit >= data.count)}
              >
                Next <ChevronRight size={14} />
              </button>
            </div>
          )}
        </>
      )}

      {!loading && !data && <div className="glass" style={{ padding: '2rem', textAlign: 'center' }}>No data.</div>}
      <style>{`@keyframes fadeIn { from { opacity: 0; } to { opacity: 1; } }`}</style>
    </div>
  );
}

const thStyle = { textAlign: 'left', padding: '0.75rem 1rem', fontSize: '0.7rem', fontWeight: 600, color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '0.06em', overflow: 'hidden', textOverflow: 'ellipsis' };
const tdStyle = { padding: '0.75rem 1rem', fontSize: '0.88rem', overflow: 'hidden', textOverflow: 'ellipsis' };
const paginationSelect = { padding: '0.45rem 0.6rem', background: 'var(--subtle-bg-2)', border: '1px solid var(--border-color)', borderRadius: 8, color: 'inherit', fontSize: '0.85rem', cursor: 'pointer' };
const paginationInput = { padding: '0.45rem 0.6rem', background: 'var(--subtle-bg-2)', border: '1px solid var(--border-color)', borderRadius: 8, color: 'inherit', fontSize: '0.85rem', width: '80px' };
const paginationButton = (disabled) => ({ display: 'flex', alignItems: 'center', gap: '0.25rem', padding: '0.5rem 1rem', background: disabled ? 'transparent' : 'var(--subtle-bg-2)', border: '1px solid var(--border-color)', borderRadius: 8, cursor: disabled ? 'not-allowed' : 'pointer', color: 'var(--text-primary)', fontSize: '0.85rem', opacity: disabled ? 0.55 : 1 });
const statusBg = (status) => {
  switch (status) {
    case 'completed': return 'rgba(34,197,94,0.2)';
    case 'pending': return 'rgba(245,158,11,0.2)';
    case 'cancelled': return 'rgba(239,68,68,0.2)';
    default: return 'rgba(100,116,139,0.2)';
  }
};
