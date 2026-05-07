import React, { useEffect, useState } from 'react';
import { ChevronLeft, Phone, Calendar, DollarSign, Loader2, ChevronRight } from 'lucide-react';
import { fetchApi } from '../../utils/api';
import { formatMoney } from '../../utils/money';
import { formatDate } from '../../utils/date';

const isoDay = (d) => d.toISOString().slice(0, 10);

export default function Visits() {
  const [from, setFrom] = useState(isoDay(new Date(Date.now() - 30 * 86400000)));
  const [to, setTo] = useState(isoDay(new Date()));
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

  const loadVisits = () => {
    setLoading(true);
    const url = `/api/wellness/reports/visit?startDate=${from}&endDate=${to}&skip=${skip}&limit=${limit}`;
    fetchApi(url)
      .then(setData)
      .catch(() => setData(null))
      .finally(() => setLoading(false));
  };

  const loadPatientDetails = (patientId) => {
    setDetailsLoading(true);
    const url = `/api/wellness/reports/visit/${patientId}?startDate=${from}&endDate=${to}&skip=${detailsSkip}&limit=${detailsLimit}`;
    fetchApi(url)
      .then(setPatientDetails)
      .catch(() => setPatientDetails(null))
      .finally(() => setDetailsLoading(false));
  };

  useEffect(loadVisits, [from, to, skip, limit]);

  useEffect(() => {
    if (selectedPatient) {
      loadPatientDetails(selectedPatient.id);
    }
  }, [selectedPatient, from, to, detailsSkip, detailsLimit]);

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
      <div style={{ padding: '2rem', animation: 'fadeIn 0.5s ease-out' }}>
        <button
          onClick={() => setSelectedPatient(null)}
          style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', padding: '0.5rem 1rem', background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.08)', borderRadius: 8, cursor: 'pointer', color: 'var(--text-primary)', fontSize: '0.85rem', marginBottom: '1.5rem' }}
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
              <button onClick={() => { setIsCustomDetailsLimit(false); setCustomDetailsLimit(''); }} style={{ padding: '0.45rem 0.6rem', background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.08)', borderRadius: 8, color: 'var(--text-primary)', fontSize: '0.85rem', cursor: 'pointer' }}>Back</button>
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

        <div className="glass" style={{ padding: 0, overflow: 'hidden' }}>
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
              <tr style={{ borderBottom: '1px solid rgba(255,255,255,0.06)' }}>
                <th style={{ ...thStyle, textAlign: 'left' }}>Date</th>
                <th style={{ ...thStyle, textAlign: 'left' }}>Doctor</th>
                <th style={{ ...thStyle, textAlign: 'left' }}>Service</th>
                <th style={{ ...thStyle, textAlign: 'right' }}>Amount</th>
                <th style={{ ...thStyle, textAlign: 'left' }}>Status</th>
                <th style={{ ...thStyle, textAlign: 'left' }}>Notes</th>
              </tr>
            </thead>
            <tbody>
              {patientDetails.data.visits.map((visit) => (
                <tr key={visit.id} style={{ borderBottom: '1px solid rgba(255,255,255,0.04)' }}>
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
                    {formatMoney(visit.amountCharged || 0)}
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
              {patientDetails.data.visits.length === 0 && (
                <tr>
                  <td colSpan={6} style={{ ...tdStyle, textAlign: 'center', color: 'var(--text-secondary)' }}>
                    No visits in selected period.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

        {patientDetails.count > detailsLimit && (
          <div style={{ display: 'flex', gap: '0.5rem', justifyContent: 'center', marginTop: '1rem' }}>
            <button
              disabled={detailsSkip === 0 || detailsLoading}
              onClick={() => handleDetailsPageChange('prev')}
              style={{ padding: '0.5rem 1rem', background: detailsSkip === 0 ? 'rgba(255,255,255,0.03)' : 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.08)', borderRadius: 8, cursor: detailsSkip === 0 ? 'not-allowed' : 'pointer', color: 'var(--text-primary)', fontSize: '0.85rem' }}
            >
              Previous
            </button>
            <span style={{ padding: '0.5rem 1rem', color: 'var(--text-secondary)', fontSize: '0.85rem' }}>
              {detailsSkip + 1} – {Math.min(detailsSkip + detailsLimit, patientDetails.count)} of {patientDetails.count}
            </span>
            <button
              disabled={detailsSkip + detailsLimit >= patientDetails.count || detailsLoading}
              onClick={() => handleDetailsPageChange('next')}
              style={{ padding: '0.5rem 1rem', background: detailsSkip + detailsLimit >= patientDetails.count ? 'rgba(255,255,255,0.03)' : 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.08)', borderRadius: 8, cursor: detailsSkip + detailsLimit >= patientDetails.count ? 'not-allowed' : 'pointer', color: 'var(--text-primary)', fontSize: '0.85rem' }}
            >
              Next
            </button>
          </div>
        )}
      </div>
    );
  }

  return (
    <div style={{ padding: '2rem', animation: 'fadeIn 0.5s ease-out' }}>
      <header style={{ marginBottom: '1.25rem' }}>
        <h1 style={{ fontSize: '1.75rem', fontWeight: 600, display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
          <Calendar size={24} /> Visits
        </h1>
        <p style={{ color: 'var(--text-secondary)', marginTop: '0.25rem' }}>
          Patient visits — filterable by date.
        </p>
      </header>

      <div style={{ display: 'flex', gap: '0.5rem', marginBottom: '1rem', flexWrap: 'wrap', alignItems: 'center' }}>
        <input type="date" value={from} onChange={(e) => { setFrom(e.target.value); setSkip(0); }} style={dateInput} />
        <span style={{ color: 'var(--text-secondary)' }}>→</span>
        <input type="date" value={to} onChange={(e) => { setTo(e.target.value); setSkip(0); }} style={dateInput} />
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
          <div className="glass" style={{ padding: '1rem', marginBottom: '1rem', display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '0.75rem' }}>
            <div style={{ padding: '0.75rem' }}>
              <div style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Patients with Visits</div>
              <div style={{ fontSize: '1.5rem', fontWeight: 600, marginTop: '0.25rem' }}>{data.count.toLocaleString('en-IN')}</div>
            </div>
          </div>

          <div className="glass" style={{ padding: 0, overflow: 'hidden' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', tableLayout: 'fixed' }}>
              <colgroup>
                <col style={{ width: '25%' }} />
                <col style={{ width: '20%' }} />
                <col style={{ width: '15%' }} />
                <col style={{ width: '20%' }} />
                <col style={{ width: '20%' }} />
              </colgroup>
              <thead>
                <tr style={{ borderBottom: '1px solid rgba(255,255,255,0.06)' }}>
                  <th style={{ ...thStyle, textAlign: 'left' }}>Patient Name</th>
                  <th style={{ ...thStyle, textAlign: 'left' }}>Phone</th>
                  <th style={{ ...thStyle, textAlign: 'right' }}>Total Visits</th>
                  <th style={{ ...thStyle, textAlign: 'right' }}>Total Revenue</th>
                  <th style={{ ...thStyle, textAlign: 'left' }}>Last Visit</th>
                </tr>
              </thead>
              <tbody>
                {data.data.map((patient) => (
                  <tr
                    key={patient.id}
                    onClick={() => handlePatientClick(patient)}
                    style={{ borderBottom: '1px solid rgba(255,255,255,0.04)', cursor: 'pointer', transition: 'background 0.2s' }}
                    onMouseEnter={(e) => e.currentTarget.style.background = 'rgba(255,255,255,0.03)'}
                    onMouseLeave={(e) => e.currentTarget.style.background = 'transparent'}
                  >
                    <td style={{ ...tdStyle, textAlign: 'left', color: 'var(--accent-color)', fontWeight: 500 }}>
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
          </div>

          {data.count > limit && (
            <div style={{ display: 'flex', gap: '0.5rem', justifyContent: 'center', marginTop: '1rem', alignItems: 'center', flexWrap: 'wrap' }}>
              <button
                disabled={skip === 0 || loading}
                onClick={() => handlePageChange('prev')}
                style={{ display: 'flex', alignItems: 'center', gap: '0.25rem', padding: '0.5rem 1rem', background: skip === 0 ? 'rgba(255,255,255,0.03)' : 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.08)', borderRadius: 8, cursor: skip === 0 ? 'not-allowed' : 'pointer', color: 'var(--text-primary)', fontSize: '0.85rem' }}
              >
                <ChevronLeft size={14} /> Previous
              </button>
              <span style={{ padding: '0.5rem 1rem', color: 'var(--text-secondary)', fontSize: '0.85rem' }}>
                {skip + 1} – {Math.min(skip + limit, data.count)} of {data.count}
              </span>
              <button
                disabled={skip + limit >= data.count || loading}
                onClick={() => handlePageChange('next')}
                style={{ display: 'flex', alignItems: 'center', gap: '0.25rem', padding: '0.5rem 1rem', background: skip + limit >= data.count ? 'rgba(255,255,255,0.03)' : 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.08)', borderRadius: 8, cursor: skip + limit >= data.count ? 'not-allowed' : 'pointer', color: 'var(--text-primary)', fontSize: '0.85rem' }}
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

const thStyle = { textAlign: 'left', padding: '0.65rem 1rem', fontSize: '0.7rem', fontWeight: 600, color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '0.05em', overflow: 'hidden', textOverflow: 'ellipsis' };
const tdStyle = { padding: '0.65rem 1rem', fontSize: '0.85rem', overflow: 'hidden', textOverflow: 'ellipsis' };
const dateInput = { padding: '0.45rem 0.6rem', background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.08)', borderRadius: 8, color: 'var(--text-primary)', fontSize: '0.85rem' };
const paginationSelect = { padding: '0.45rem 0.6rem', background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.08)', borderRadius: 8, color: 'var(--text-primary)', fontSize: '0.85rem', cursor: 'pointer' };
const paginationInput = { padding: '0.45rem 0.6rem', background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.08)', borderRadius: 8, color: 'var(--text-primary)', fontSize: '0.85rem', width: '80px' };
const statusBg = (status) => {
  switch (status) {
    case 'completed': return 'rgba(34,197,94,0.2)';
    case 'pending': return 'rgba(245,158,11,0.2)';
    case 'cancelled': return 'rgba(239,68,68,0.2)';
    default: return 'rgba(100,116,139,0.2)';
  }
};
