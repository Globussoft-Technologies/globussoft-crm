import { createPortal } from 'react-dom';
import { useEffect, useMemo, useState } from 'react';
import { Download, Eye, FileSignature } from 'lucide-react';
import { fetchApi, getAuthToken } from '../../../../utils/api';
import { useNotify } from '../../../../utils/notify';
import { DateRangeFilter, resolveDateRange, EMPTY_DATE_FILTER } from '../../../../components/wellness/DateRangeFilter';
import { labelStyle, inputStyle } from '../shared/helpers';
import SearchableSingleSelect from '../../services/SearchableSingleSelect';

function parseServiceIds(raw) {
  if (Array.isArray(raw)) return raw.map(Number).filter(Number.isInteger);
  if (typeof raw !== 'string' || !raw.trim()) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.map(Number).filter(Number.isInteger) : [];
  } catch (_err) {
    return [];
  }
}

function formatDateTime(iso) {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleString('en-IN', {
      timeZone: 'Asia/Kolkata',
      day: '2-digit', month: 'short', year: 'numeric',
      hour: '2-digit', minute: '2-digit',
    });
  } catch (_err) {
    return iso;
  }
}

function formatVisit(visit) {
  if (!visit) return '—';
  const date = visit.visitDate ? formatDateTime(visit.visitDate) : `Visit #${visit.id}`;
  return `${date} — ${visit.service?.name || 'Consultation'}`;
}

// Consent PDFs are produced by the e-signature flow. This tab intentionally
// has no template/canvas/create form: selecting a visit + service finds the
// signed request that already belongs to that exact clinical context.
export default function ConsentTab({ patient, services }) {
  const notify = useNotify();
  const visits = Array.isArray(patient?.visits) ? patient.visits : [];
  const serviceOptions = useMemo(
    () => (Array.isArray(services) ? services : []).map((service) => ({
      value: String(service.id),
      label: service.name,
    })),
    [services],
  );
  const [visitId, setVisitId] = useState('');
  const [serviceId, setServiceId] = useState('');
  const [signatureRequests, setSignatureRequests] = useState([]);
  const [loadingRequests, setLoadingRequests] = useState(true);
  const [requestError, setRequestError] = useState('');
  const [busyId, setBusyId] = useState(null);
  const [viewing, setViewing] = useState(null);
  const [consentFilter, setConsentFilter] = useState(EMPTY_DATE_FILTER);

  useEffect(() => {
    setVisitId('');
    setServiceId('');
  }, [patient?.id]);

  useEffect(() => {
    let active = true;
    setLoadingRequests(true);
    setRequestError('');
    fetchApi(`/api/signatures?patientId=${encodeURIComponent(patient.id)}&status=SIGNED&fields=patient-consent`)
      .then((data) => {
        if (active) setSignatureRequests(Array.isArray(data) ? data : []);
      })
      .catch((err) => {
        if (!active) return;
        setSignatureRequests([]);
        setRequestError(err?.message || 'Could not load signed e-signatures.');
      })
      .finally(() => {
        if (active) setLoadingRequests(false);
      });
    return () => { active = false; };
  }, [patient.id]);

  const selectedVisit = visits.find((visit) => String(visit.id) === String(visitId));
  const linkedRequests = signatureRequests.filter((request) => {
    if (String(request.visitId) !== String(visitId) || !serviceId) return false;
    return parseServiceIds(request.serviceIds).includes(Number(serviceId));
  });

  const handleVisitChange = (nextVisitId) => {
    setVisitId(nextVisitId);
    const visit = visits.find((item) => String(item.id) === String(nextVisitId));
    const visitServiceId = visit?.service?.id ?? visit?.serviceId;
    setServiceId(visitServiceId == null ? '' : String(visitServiceId));
  };

  const fetchPdf = async (requestId) => {
    const token = getAuthToken();
    const response = await fetch(`/api/signatures/${requestId}/pdf`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      throw new Error(body?.error || 'PDF download failed');
    }
    return URL.createObjectURL(await response.blob());
  };

  const viewPdf = async (request) => {
    setBusyId(request.id);
    try {
      const url = await fetchPdf(request.id);
      setViewing({ title: request.documentName || 'Consent form', url });
    } catch (err) {
      notify.error(`Could not view consent form: ${err.message}`);
    } finally {
      setBusyId(null);
    }
  };

  const downloadPdf = async (request) => {
    setBusyId(request.id);
    try {
      const url = await fetchPdf(request.id);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = `consent-${request.id}.pdf`;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(url);
    } catch (err) {
      notify.error(`Could not download consent form: ${err.message}`);
    } finally {
      setBusyId(null);
    }
  };

  const downloadLegacyPdf = async (consent) => {
    setBusyId(`legacy-${consent.id}`);
    try {
      const token = getAuthToken();
      const response = await fetch(`/api/wellness/consents/${consent.id}/pdf`, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      if (!response.ok) throw new Error('PDF download failed');
      const url = URL.createObjectURL(await response.blob());
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = `consent-${consent.id}.pdf`;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(url);
    } catch (err) {
      notify.error(`Could not download consent form: ${err.message}`);
    } finally {
      setBusyId(null);
    }
  };

  const closeViewer = () => {
    if (viewing?.url) URL.revokeObjectURL(viewing.url);
    setViewing(null);
  };

  const allLegacyConsents = Array.isArray(patient?.consents) ? patient.consents : [];
  const [rangeStart, rangeEnd] = resolveDateRange(consentFilter);
  const legacyConsents = rangeStart && rangeEnd
    ? allLegacyConsents.filter((consent) => {
      const timestamp = new Date(consent.signedAt).getTime();
      return timestamp >= rangeStart.getTime() && timestamp <= rangeEnd.getTime();
    })
    : allLegacyConsents;

  return (
    <div className="glass" style={{ padding: '1.5rem' }}>
      <section
        data-testid="consent-selection"
        style={{
          marginBottom: '1.5rem', padding: '1rem',
          background: 'var(--card-bg, rgba(0,0,0,0.04))',
          border: '1px solid var(--border-color, rgba(255,255,255,0.1))',
          borderRadius: 8,
        }}
      >
        <h3 style={{ margin: '0 0 0.35rem', fontSize: '1.05rem' }}>Find consent PDF</h3>
        <p style={{ margin: '0 0 1rem', color: 'var(--text-secondary)', fontSize: '0.85rem' }}>
          Select the visit and service used when the patient signed the e-signature request.
        </p>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.75rem' }}>
          <div>
            <label style={labelStyle} htmlFor="consent-visit">Visit</label>
            <select
              id="consent-visit"
              aria-label="Visit"
              value={visitId}
              onChange={(event) => handleVisitChange(event.target.value)}
              style={inputStyle}
            >
              <option value="">— select visit —</option>
              {visits.map((visit) => (
                <option key={visit.id} value={visit.id}>{formatVisit(visit)}</option>
              ))}
            </select>
          </div>
          <div>
            <label style={labelStyle}>Service</label>
            <SearchableSingleSelect
              value={serviceId}
              onChange={setServiceId}
              options={serviceOptions}
              placeholder="Search service..."
              aria-label="Service"
              disabled={!visitId}
            />
          </div>
        </div>
      </section>

      <section
        data-testid="linked-consents"
        style={{
          marginBottom: '1.5rem', padding: '1rem',
          background: 'var(--card-bg, rgba(0,0,0,0.04))',
          border: '1px solid var(--border-color, rgba(255,255,255,0.1))',
          borderRadius: 8,
        }}
      >
        <h3 style={{ margin: '0 0 0.75rem', fontSize: '1.05rem', display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
          <FileSignature size={17} /> Signed e-signatures
        </h3>
        {loadingRequests ? (
          <p style={{ margin: 0, color: 'var(--text-secondary)' }}>Loading signed e-signatures...</p>
        ) : requestError ? (
          <p role="alert" style={{ margin: 0, color: '#ef4444' }}>{requestError}</p>
        ) : !visitId || !serviceId ? (
          <p style={{ margin: 0, color: 'var(--text-secondary)' }}>Select a visit and service to find its signed consent PDF.</p>
        ) : linkedRequests.length === 0 ? (
          <p style={{ margin: 0, color: 'var(--text-secondary)' }}>No signed e-signature found for this visit and service.</p>
        ) : (
          <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
            {linkedRequests.map((request) => (
              <li key={request.id} style={{ padding: '0.5rem 0', borderBottom: '1px solid var(--border-color, rgba(255,255,255,0.06))', display: 'flex', flexWrap: 'wrap', gap: '0.5rem', alignItems: 'center' }}>
                <strong>{request.documentName || `Consent #${request.id}`}</strong>
                <span style={{ color: 'var(--text-secondary)' }}>— signed {formatDateTime(request.signedAt)} IST</span>
                <div style={{ marginLeft: 'auto', display: 'flex', gap: '0.4rem' }}>
                  <button type="button" onClick={() => viewPdf(request)} disabled={busyId === request.id} style={actionButtonStyle}>
                    <Eye size={12} /> View
                  </button>
                  <button type="button" onClick={() => downloadPdf(request)} disabled={busyId === request.id} style={actionButtonStyle}>
                    <Download size={12} /> PDF
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
        {selectedVisit && linkedRequests.length > 0 && (
          <p style={{ margin: '0.75rem 0 0', color: 'var(--text-secondary)', fontSize: '0.78rem' }}>
            Visit: {formatVisit(selectedVisit)}
          </p>
        )}
      </section>

      <section data-testid="prior-consents" style={{ padding: '1rem', background: 'var(--card-bg, rgba(0,0,0,0.04))', border: '1px solid var(--border-color, rgba(255,255,255,0.1))', borderRadius: 8 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '0.5rem', marginBottom: '0.75rem' }}>
          <h3 style={{ margin: 0, fontSize: '1.05rem' }}>Existing consent records</h3>
          {allLegacyConsents.length > 0 && <DateRangeFilter value={consentFilter} onChange={setConsentFilter} label={null} />}
        </div>
        <p style={{ margin: '0 0 0.75rem', color: 'var(--text-secondary)', fontSize: '0.82rem' }}>
          Older consent records remain available here. New consent PDFs are linked from signed e-signatures above.
        </p>
        {allLegacyConsents.length === 0 ? (
          <p style={{ margin: 0, color: 'var(--text-secondary)', fontSize: '0.9rem' }}>No older consent records on file.</p>
        ) : legacyConsents.length === 0 ? (
          <p style={{ margin: 0, color: 'var(--text-secondary)', fontSize: '0.9rem' }}>No consent records in the selected range.</p>
        ) : (
          <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
            {legacyConsents.map((consent) => (
              <li key={consent.id} style={{ padding: '0.45rem 0', borderBottom: '1px solid var(--border-color, rgba(255,255,255,0.06))', display: 'flex', flexWrap: 'wrap', gap: '0.5rem', alignItems: 'center' }}>
                <strong>Consent record #{consent.id}</strong>
                <span style={{ color: 'var(--text-secondary)' }}>— {formatDateTime(consent.signedAt)} IST</span>
                {consent.service?.name && <span style={{ color: 'var(--text-secondary)' }}>— {consent.service.name}</span>}
                <button type="button" onClick={() => downloadLegacyPdf(consent)} disabled={busyId === `legacy-${consent.id}`} style={{ ...actionButtonStyle, marginLeft: 'auto' }}>
                  <Download size={12} /> PDF
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      {viewing && typeof document !== 'undefined' && createPortal(
        <div role="dialog" aria-modal="true" style={modalBackdropStyle}>
          <div style={modalStyle}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.75rem', flexShrink: 0 }}>
              <h3 style={{ margin: 0 }}>{viewing.title}</h3>
              <button type="button" onClick={closeViewer} aria-label="Close PDF" style={{ ...actionButtonStyle, fontSize: '1rem' }}>×</button>
            </div>
            <iframe title="Consent form PDF" src={viewing.url} style={{ width: '100%', flex: '1 1 auto', height: 'auto', minHeight: 0, border: '1px solid var(--border-color)', borderRadius: 8 }} />
          </div>
        </div>,
        document.body,
      )}
    </div>
  );
}

const actionButtonStyle = {
  padding: '0.35rem 0.65rem', fontSize: '0.75rem', background: 'transparent',
  color: 'var(--primary-color, var(--accent-color))', border: '1px solid var(--border-color)',
  borderRadius: 6, cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '0.25rem',
};

const modalBackdropStyle = {
  position: 'fixed', inset: 0, zIndex: 10000, width: '100vw', height: '100dvh',
  boxSizing: 'border-box', overflow: 'hidden', background: 'rgba(0,0,0,0.6)',
  display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '1rem',
};

const modalStyle = {
  width: 'min(900px, 100%)', height: 'min(90dvh, 800px, calc(100dvh - 2rem))',
  maxHeight: 'calc(100dvh - 2rem)', overflow: 'hidden', boxSizing: 'border-box',
  display: 'flex', flexDirection: 'column',
  background: 'var(--modal-bg, var(--surface-color))', borderRadius: 12, padding: '1rem',
};
