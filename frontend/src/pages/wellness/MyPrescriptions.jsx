// Staff-authed self-view of own prescriptions — companion to the
// patient-portal PatientPortal.jsx prescriptions tab.
//
// Backend: GET /api/wellness/my-prescriptions
//          GET /api/wellness/my-prescriptions/:id/pdf
//          Both gated on `my_prescriptions.read` (RBAC), staff JWT,
//          scoped to the logged-in user's linked Patient record.
//
// Empty states distinguish:
//   - "no Rx yet" (user IS linked to a Patient, no prescriptions)
//   - "profile not linked" (no Patient.userId match in this tenant)
// The second case isn't an error — it tells the staff member their
// clinic hasn't linked their User account to a Patient record yet,
// with a clear next-step ("ask the clinic to link your profile").

import { useEffect, useState, useCallback } from 'react';
import {
  Pill,
  Download,
  FileText,
  AlertCircle,
} from 'lucide-react';
import { fetchApi } from '../../utils/api';
import { useNotify } from '../../utils/notify';
import { formatDate } from '../../utils/date';

export default function MyPrescriptions() {
  const notify = useNotify();
  const [data, setData] = useState({ patient: null, prescriptions: [] });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const res = await fetchApi('/api/wellness/my-prescriptions');
      setData({
        patient: res?.patient || null,
        prescriptions: Array.isArray(res?.prescriptions) ? res.prescriptions : [],
      });
    } catch (ex) {
      setError(ex.message || 'Failed to load prescriptions');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const downloadRx = async (rxId) => {
    try {
      // Bypass fetchApi for binary response; reuse the same auth header.
      const token = localStorage.getItem('token');
      const r = await fetch(`/api/wellness/my-prescriptions/${rxId}/pdf`, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      if (!r.ok) throw new Error('PDF download failed');
      const blob = await r.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `prescription-${rxId}.pdf`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (ex) {
      notify.error?.(`Could not download: ${ex.message}`);
    }
  };

  const { patient, prescriptions } = data;

  return (
    <div style={{ padding: '2rem', animation: 'fadeIn 0.4s ease-out' }}>
      <header style={{ marginBottom: '1.5rem' }}>
        <h1
          style={{
            fontSize: '1.75rem',
            fontWeight: 600,
            display: 'flex',
            alignItems: 'center',
            gap: '0.5rem',
          }}
        >
          <Pill size={24} /> My Prescriptions
        </h1>
        <p style={{ color: 'var(--text-secondary)', marginTop: '0.25rem' }}>
          Prescriptions written for you at this clinic. Tap a card to download
          the signed PDF.
        </p>
      </header>

      {loading && <div style={{ padding: '1rem' }}>Loading…</div>}

      {!loading && error && (
        <div className="glass" style={errorBoxStyle} role="alert">
          <AlertCircle size={18} /> {error}
        </div>
      )}

      {/* Profile-not-linked empty state — staff user with no Patient.userId
          match in this tenant. Informational; tells them what to do. */}
      {!loading && !error && !patient && (
        <div className="glass" style={emptyBoxStyle}>
          <FileText size={28} style={{ marginBottom: '0.5rem', opacity: 0.5 }} />
          <div style={{ fontWeight: 600, marginBottom: '0.25rem' }}>
            No patient profile linked
          </div>
          <div style={{ fontSize: '0.85rem', color: 'var(--text-secondary)' }}>
            Your staff account isn&rsquo;t linked to a patient record at this
            clinic yet. Ask the front desk to link your profile so your
            prescriptions appear here.
          </div>
        </div>
      )}

      {/* No-prescriptions empty state — linked Patient exists, just no
          Rx on file yet. */}
      {!loading && !error && patient && prescriptions.length === 0 && (
        <div className="glass" style={emptyBoxStyle}>
          <Pill size={28} style={{ marginBottom: '0.5rem', opacity: 0.5 }} />
          <div style={{ fontWeight: 600, marginBottom: '0.25rem' }}>
            No prescriptions on file yet
          </div>
          <div style={{ fontSize: '0.85rem', color: 'var(--text-secondary)' }}>
            Anything your doctor writes for you will appear here.
          </div>
        </div>
      )}

      {!loading && !error && prescriptions.length > 0 && (
        <div style={{ display: 'grid', gap: '0.75rem' }}>
          {prescriptions.map((rx) => {
            let drugs = [];
            try {
              drugs = JSON.parse(rx.drugs || '[]');
            } catch {
              drugs = [];
            }
            return (
              <div key={rx.id} className="glass" style={{ padding: '1rem' }}>
                <div
                  style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'flex-start',
                    gap: '1rem',
                    flexWrap: 'wrap',
                  }}
                >
                  <div>
                    <div
                      style={{
                        fontWeight: 600,
                        display: 'flex',
                        alignItems: 'center',
                        gap: '0.4rem',
                      }}
                    >
                      <Pill size={15} /> Prescription #{rx.id}
                    </div>
                    <div
                      style={{
                        fontSize: '0.8rem',
                        color: 'var(--text-secondary)',
                        marginTop: '0.2rem',
                      }}
                    >
                      {formatDate(rx.createdAt)}
                      {rx.doctor?.name && ` · Dr ${rx.doctor.name}`}
                      {rx.visit?.service?.name && ` · ${rx.visit.service.name}`}
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() => downloadRx(rx.id)}
                    style={pdfButtonStyle}
                  >
                    <Download size={13} /> PDF
                  </button>
                </div>
                {drugs.length > 0 && (
                  <ul
                    style={{
                      listStyle: 'none',
                      padding: 0,
                      marginTop: '0.75rem',
                      display: 'grid',
                      gap: '0.35rem',
                    }}
                  >
                    {drugs.map((d, i) => (
                      <li
                        key={i}
                        style={{
                          fontSize: '0.85rem',
                          padding: '0.4rem 0.6rem',
                          background: 'var(--subtle-bg-2)',
                          borderRadius: 6,
                        }}
                      >
                        <strong>{d.name}</strong>
                        {d.dosage && ` — ${d.dosage}`}
                        {d.frequency && `, ${d.frequency}`}
                        {d.duration && ` for ${d.duration}`}
                      </li>
                    ))}
                  </ul>
                )}
                {rx.instructions && (
                  <p
                    style={{
                      fontSize: '0.85rem',
                      color: 'var(--text-secondary)',
                      marginTop: '0.6rem',
                      lineHeight: 1.5,
                    }}
                  >
                    {rx.instructions}
                  </p>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

const emptyBoxStyle = {
  padding: '2rem',
  textAlign: 'center',
  color: 'var(--text-primary)',
};

const errorBoxStyle = {
  padding: '1rem',
  display: 'flex',
  alignItems: 'center',
  gap: '0.5rem',
  color: 'var(--text-primary)',
  borderLeft: '3px solid var(--danger-color, #ef4444)',
};

const pdfButtonStyle = {
  display: 'flex',
  alignItems: 'center',
  gap: '0.3rem',
  padding: '0.4rem 0.8rem',
  background: 'var(--primary-color, var(--accent-color))',
  border: 'none',
  borderRadius: 6,
  color: '#fff',
  cursor: 'pointer',
  fontSize: '0.8rem',
};
