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
  RefreshCw,
} from 'lucide-react';
import { fetchApi } from '../../utils/api';
import { useNotify } from '../../utils/notify';
import { formatDate } from '../../utils/date';
import { usePermissions } from '../../hooks/usePermissions';
import PrescriptionRenewalComposer from '../../components/wellness/PrescriptionRenewalComposer';
import { useRenewalRequests } from '../../hooks/usePrescriptionRenewals';

export default function MyPrescriptions() {
  const notify = useNotify();
  const { hasPermission, isReady: permsReady } = usePermissions();
  // Renewal is a separate grant from viewing: a clinic can let patients see
  // their Rx without opening a request channel. Until permissions resolve we
  // optimistically enable — the backend is the real gate, and a briefly
  // disabled button reads as a broken page.
  const canRequest =
    !permsReady || hasPermission('my_prescription_requests', 'write');
  // Which prescriptions already have a request in flight, so we don't offer an
  // action the backend would refuse with 409.
  const { openByPrescription, reload: reloadRequests } = useRenewalRequests();
  const [renewFor, setRenewFor] = useState(null);
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
            let drugs = rx.drugs;
            if (typeof drugs === 'string') {
              try { drugs = JSON.parse(drugs || '[]'); } catch { drugs = []; }
            }
            if (!Array.isArray(drugs)) drugs = [];
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
                  <div
                    style={{
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: '0.4rem',
                      flexWrap: 'wrap',
                    }}
                  >
                    {/* Asking for a repeat belongs ON the prescription — this
                        is where a patient looking at their medicines expects
                        it. The dedicated My Prescription Requests page still
                        exists to TRACK what they have asked for. */}
                    <RenewAction
                      openRequest={openByPrescription.get(rx.id)}
                      canRequest={canRequest}
                      onClick={() => setRenewFor(rx)}
                    />
                    <button
                      type="button"
                      onClick={() => downloadRx(rx.id)}
                      style={pdfButtonStyle}
                    >
                      <Download size={13} /> PDF
                    </button>
                  </div>
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

      {renewFor && (
        <PrescriptionRenewalComposer
          prescription={renewFor}
          notify={notify}
          onClose={() => setRenewFor(null)}
          onSubmitted={() => {
            setRenewFor(null);
            notify.success?.('Your renewal request has been sent to the clinic.');
            // Refresh the overlay so this card immediately shows "Renewal
            // pending" rather than offering the action again.
            reloadRequests();
          }}
        />
      )}
    </div>
  );
}

/**
 * Per-prescription renewal action.
 *
 * Three states, and each says WHY rather than just going quiet:
 *   - actionable                → "Request renewal"
 *   - a request already open    → the status, disabled (a second one is a 409)
 *   - no `my_prescription_requests.write` grant → disabled with the reason
 *
 * Silently hiding the control in the last two cases reads as a missing
 * feature; the patient needs to know whether they already asked.
 */
function RenewAction({ openRequest, canRequest, onClick }) {
  const blocked = Boolean(openRequest) || !canRequest;
  const label = openRequest
    ? `Renewal ${openRequest.status.toLowerCase()}`
    : 'Request renewal';

  return (
    <button
      type="button"
      onClick={onClick}
      disabled={blocked}
      data-testid={`renew-rx-${openRequest ? openRequest.prescriptionId : ''}`}
      title={
        openRequest
          ? `You already have a renewal request for this prescription (${openRequest.status.toLowerCase()})`
          : !canRequest
            ? 'Renewal requests are not enabled for your account'
            : 'Ask the clinic to repeat this prescription'
      }
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: '0.3rem',
        padding: '0.4rem 0.8rem',
        // Secondary treatment: PDF stays the filled primary on this card, so
        // the new action sits beside it without competing for the same weight.
        background: 'transparent',
        border: '1px solid var(--border-color)',
        borderRadius: 6,
        color: 'inherit',
        cursor: blocked ? 'not-allowed' : 'pointer',
        opacity: blocked ? 0.55 : 1,
        fontSize: '0.8rem',
      }}
    >
      {/* --accent-color, NOT --primary-color: in the wellness theme
          --primary-color is charcoal in BOTH modes, so as a foreground it
          renders charcoal-on-black. */}
      <RefreshCw size={13} style={{ color: 'var(--accent-color)' }} /> {label}
    </button>
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
  // --accent-color, NOT --primary-color. Same trap the Request-renewal button
  // documents above, hit from the other side: in the wellness theme
  // --primary-color is charcoal in BOTH modes, so using it as a BACKGROUND
  // painted a charcoal button onto the near-black prescription card and the
  // control effectively disappeared. --accent-color is the blue that carries
  // white text at contrast in both themes.
  background: 'var(--accent-color, #3b82f6)',
  border: 'none',
  borderRadius: 6,
  color: '#fff',
  cursor: 'pointer',
  fontSize: '0.8rem',
};
