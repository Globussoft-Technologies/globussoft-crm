import React, { useState, useEffect, useRef, useMemo } from 'react';
import { createPortal } from 'react-dom';
import { FileSignature, Plus, Send, Eye, X, Check, ChevronDown } from 'lucide-react';
import { fetchApi } from '../utils/api';
import { useNotify } from '../utils/notify';
import { formatDate } from '../utils/date';
import TopScrollSync from '../components/TopScrollSync';

const STATUS_STYLES = {
  PENDING: { bg: 'rgba(245,158,11,0.12)', color: '#f59e0b', border: 'rgba(245,158,11,0.3)' },
  SIGNED: { bg: 'rgba(16,185,129,0.12)', color: '#10b981', border: 'rgba(16,185,129,0.3)' },
  DECLINED: { bg: 'rgba(239,68,68,0.12)', color: '#ef4444', border: 'rgba(239,68,68,0.3)' },
  EXPIRED: { bg: 'rgba(100,116,139,0.12)', color: '#94a3b8', border: 'rgba(100,116,139,0.3)' },
};

function StatusBadge({ status }) {
  const cfg = STATUS_STYLES[status] || STATUS_STYLES.PENDING;
  return (
    <span style={{
      padding: '0.2rem 0.65rem', borderRadius: '999px', fontSize: '0.72rem',
      fontWeight: 'bold', backgroundColor: cfg.bg, color: cfg.color,
      border: `1px solid ${cfg.border}`,
    }}>
      {status}
    </span>
  );
}

const EMPTY_FORM = {
  documentType: 'Estimate',
  documentId: '',
  signerName: '',
  signerEmail: '',
  expiresInDays: 7,

  // Patient signature fields
  patientId: '',
  documentName: '',
  visitId: '',
  signAutomatically: false,
  services: [],
};

const ENDPOINT_FOR_TYPE = {
  Estimate: '/api/estimates',
};

export default function Signatures() {
  const notify = useNotify();
  const [requests, setRequests] = useState([]);
  const [docOptions, setDocOptions] = useState([]);
  const [form, setForm] = useState(EMPTY_FORM);
  const [showCreate, setShowCreate] = useState(false);
  const [viewing, setViewing] = useState(null);
  const [details, setDetails] = useState(null);
  const [loading, setLoading] = useState(false);
  const [signatureType, setSignatureType] = useState('Patient');
const [patients, setPatients] = useState([]);
const [selectedPatient, setSelectedPatient] = useState(null);
const [patientVisits, setPatientVisits] = useState([]);
const [loadingVisits, setLoadingVisits] = useState(false);
const [servicesCatalog, setServicesCatalog] = useState([]);
const [loadingServices, setLoadingServices] = useState(false);

useEffect(() => {
  const fetchPatients = async () => {
    try {
      const data = await fetchApi('/api/wellness/patients?limit=200');
      setPatients(data?.patients || []);
    } catch (error) {
      console.error('Failed to fetch patients:', error);
      setPatients([]);
    }
  };
  // Service catalog backing the Patient-tab Services multi-select.
  // Mirrors the `services` prop the ConsentTab service dropdown renders
  // from — GET /api/wellness/services returns the bare tenant array.
  const fetchServicesCatalog = async () => {
    setLoadingServices(true);
    try {
      const data = await fetchApi('/api/wellness/services');
      setServicesCatalog(Array.isArray(data) ? data : []);
    } catch (error) {
      console.error('Failed to fetch services:', error);
      setServicesCatalog([]);
    } finally {
      setLoadingServices(false);
    }
  };

  fetchPatients();
  fetchServicesCatalog();
}, []);
  useEffect(() => { loadRequests(); }, []);
  useEffect(() => { loadDocOptions(form.documentType); }, [form.documentType]);

  const loadRequests = async () => {
    try {
      const data = await fetchApi('/api/signatures');
      setRequests(Array.isArray(data) ? data : []);
    } catch (err) { console.error(err); }
  };

  const loadDocOptions = async (docType) => {
    const endpoint = ENDPOINT_FOR_TYPE[docType];
    if (!endpoint) { setDocOptions([]); return; }
    try {
      const data = await fetchApi(endpoint);
      setDocOptions(Array.isArray(data) ? data : []);
    } catch (err) { setDocOptions([]); }
  };

  const docLabel = (d) => {
    if (!d) return `#${d?.id ?? ''}`;
    return d.title || d.estimateNum || `Estimate #${d.id}`;
  };

  // Patient picker — mirrors PrescribeTab's visit tie-in: picking a
  // patient loads their visits (GET /api/wellness/patients/:id/visits,
  // the same endpoint the patient-detail tabs use) and resets the
  // visit + services picks so a previous patient's state never leaks.
  const handlePatientChange = async (patientId) => {
    const patient = patients.find((p) => String(p.id) === String(patientId)) || null;
    setSelectedPatient(patient);
    setForm((prev) => ({
      ...prev,
      patientId: patientId || '',
      signerName: patient?.name || '',
      signerEmail: patient?.email || '',
      visitId: '',
      services: [],
    }));
    setPatientVisits([]);
    if (!patientId) return;
    setLoadingVisits(true);
    try {
      const data = await fetchApi(`/api/wellness/patients/${patientId}/visits`);
      setPatientVisits(Array.isArray(data) ? data : []);
    } catch (error) {
      console.error('Failed to load patient visits:', error);
      setPatientVisits([]);
    } finally {
      setLoadingVisits(false);
    }
  };

  // Visit picker — same option shape as PrescribeTab's "Tied to visit".
  // When the picked visit carries a service and nothing is selected yet,
  // pre-select it so the Services box reflects the visit (non-destructive:
  // an existing manual pick is never overwritten).
  const handleVisitChange = (visitId) => {
    setForm((prev) => {
      const visit = patientVisits.find((v) => String(v.id) === String(visitId));
      const visitServiceId = visit?.service?.id ?? visit?.serviceId;
      const services =
        visitServiceId != null && prev.services.length === 0
          ? [String(visitServiceId)]
          : prev.services;
      return { ...prev, visitId, services };
    });
  };

  const submitCreate = async (e) => {
    e.preventDefault();
    // Patient tab — visit is required, same contract as PrescribeTab
    // ("Pick a visit this prescription belongs to (or log a visit
    // first)"). The backend /api/signatures contract only understands
    // (documentType, documentId int, signerName, signerEmail), so the
    // tied visit travels as a Custom documentId with the patient/visit/
    // service context attached forward-compatibly in the same body.
    if (signatureType === 'Patient') {
      if (!form.patientId) return notify.error('Select a patient to send the signature request to');
      if (!form.visitId) return notify.error('Pick a visit this signature belongs to (or log a visit first).');
      if (!form.signerEmail) return notify.error('Patient email is required to send the signature link');
      setLoading(true);
      try {
        await fetchApi('/api/signatures', {
          method: 'POST',
          body: JSON.stringify({
            documentType: 'Custom',
            documentId: parseInt(form.visitId),
            signerName: form.signerName,
            signerEmail: form.signerEmail,
            expiresInDays: parseInt(form.expiresInDays) || 7,
            patientId: parseInt(form.patientId),
            visitId: parseInt(form.visitId),
            serviceIds: form.services.map((s) => parseInt(s)).filter(Number.isFinite),
            documentName: form.documentName,
            signAutomatically: form.signAutomatically,
          }),
        });
        setForm(EMPTY_FORM);
        setSelectedPatient(null);
        setPatientVisits([]);
        setShowCreate(false);
        loadRequests();
      } catch (err) {
        notify.error('Failed to create signature request');
      } finally {
        setLoading(false);
      }
      return;
    }
    if (!form.documentId) return notify.error('Pick a document to send for signature');
    setLoading(true);
    try {
      await fetchApi('/api/signatures', {
        method: 'POST',
        body: JSON.stringify({
          documentType: form.documentType,
          documentId: parseInt(form.documentId),
          signerName: form.signerName,
          signerEmail: form.signerEmail,
          expiresInDays: parseInt(form.expiresInDays) || 7,
        }),
      });
      setForm(EMPTY_FORM);
      setShowCreate(false);
      loadRequests();
    } catch (err) {
      notify.error('Failed to create signature request');
    } finally {
      setLoading(false);
    }
  };

  const resend = async (id) => {
    try {
      await fetchApi(`/api/signatures/${id}/resend`, { method: 'POST' });
      notify.success('Reminder email sent');
    } catch (err) {
      notify.error('Failed to resend signature request');
    }
  };

  const cancel = async (id) => {
    if (!await notify.confirm('Cancel this signature request? This cannot be undone.')) return;
    try {
      await fetchApi(`/api/signatures/${id}`, { method: 'DELETE' });
      loadRequests();
    } catch (err) {
      notify.error('Failed to cancel request');
    }
  };

  const view = async (req) => {
    setViewing(req);
    setDetails(null);
    try {
      const data = await fetchApi(`/api/signatures/${req.id}`);
      setDetails(data);
    } catch (err) { /* swallow */ }
  };

  const counts = {
    pending: requests.filter(r => r.status === 'PENDING').length,
    signed: requests.filter(r => r.status === 'SIGNED').length,
    declined: requests.filter(r => r.status === 'DECLINED').length,
    expired: requests.filter(r => r.status === 'EXPIRED').length,
  };

  return (
    <div style={{ padding: '2rem', height: '100%', overflowY: 'auto', animation: 'fadeIn 0.5s ease-out' }}>
      <header style={{ marginBottom: '2rem', display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: '1rem', flexWrap: 'wrap' }}>
        <div>
          <h1 style={{ fontSize: '2rem', fontWeight: 'bold', display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
            <FileSignature size={26} color="var(--accent-color)" /> E-Signature Requests
          </h1>
          <p style={{ color: 'var(--text-secondary)', marginTop: '0.25rem' }}>
            Send documents for secure electronic signature with tokenized email links.
          </p>
        </div>
        <button
          onClick={() => setShowCreate(true)}
          className="btn-primary"
          style={{ padding: '0.7rem 1.2rem', display: 'flex', alignItems: 'center', gap: '0.5rem' }}
        >
          <Plus size={16} /> Request Signature
        </button>
      </header>

      {/* Stats */}
      <div style={{ display: 'flex', gap: '0.75rem', marginBottom: '1.75rem', flexWrap: 'wrap' }}>
        {[
          ['PENDING', counts.pending],
          ['SIGNED', counts.signed],
          ['DECLINED', counts.declined],
          ['EXPIRED', counts.expired],
        ].map(([label, n]) => {
          const cfg = STATUS_STYLES[label];
          return (
            <span key={label} style={{
              padding: '0.4rem 1rem', borderRadius: '999px', fontSize: '0.8rem', fontWeight: '600',
              background: cfg.bg, color: cfg.color, border: `1px solid ${cfg.border}`,
            }}>
              {n} {label}
            </span>
          );
        })}
      </div>

      {/* Requests Table */}
      <div className="card" style={{ padding: '2rem' }}>
        <h3 style={{ fontSize: '1.15rem', fontWeight: '600', marginBottom: '1.5rem', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
          <FileSignature size={20} color="var(--accent-color)" /> All Signature Requests
        </h3>

        {requests.length === 0 ? (
          <div style={{ textAlign: 'center', padding: '4rem 2rem', background: 'var(--subtle-bg-2)', border: '1px dashed var(--border-color)', borderRadius: '8px' }}>
            <FileSignature size={48} style={{ opacity: 0.2, margin: '0 auto 1rem', color: 'var(--accent-color)' }} />
            <p style={{ color: 'var(--text-secondary)' }}>No signature requests yet. Send your first one to get started.</p>
          </div>
        ) : (
          <TopScrollSync>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.875rem' }}>
              <thead>
                <tr style={{ borderBottom: '1px solid var(--border-color)', textAlign: 'left' }}>
                  <th style={{ padding: '0.75rem 0.5rem', color: 'var(--text-secondary)', fontWeight: '600' }}>Document</th>
                  <th style={{ padding: '0.75rem 0.5rem', color: 'var(--text-secondary)', fontWeight: '600' }}>Signer</th>
                  <th style={{ padding: '0.75rem 0.5rem', color: 'var(--text-secondary)', fontWeight: '600' }}>Email</th>
                  <th style={{ padding: '0.75rem 0.5rem', color: 'var(--text-secondary)', fontWeight: '600' }}>Status</th>
                  <th style={{ padding: '0.75rem 0.5rem', color: 'var(--text-secondary)', fontWeight: '600' }}>Sent</th>
                  <th style={{ padding: '0.75rem 0.5rem', color: 'var(--text-secondary)', fontWeight: '600' }}>Signed</th>
                  <th style={{ padding: '0.75rem 0.5rem', color: 'var(--text-secondary)', fontWeight: '600' }}>Actions</th>
                </tr>
              </thead>
              <tbody>
                {requests.map(r => (
                  <tr key={r.id} style={{ borderBottom: '1px solid var(--border-color)' }}
                    onMouseOver={e => e.currentTarget.style.background = 'var(--subtle-bg-2)'}
                    onMouseOut={e => e.currentTarget.style.background = 'transparent'}
                  >
                    <td style={{ padding: '0.85rem 0.5rem', fontWeight: '600' }}>
                      {r.documentType} #{r.documentId}
                    </td>
                    <td style={{ padding: '0.85rem 0.5rem' }}>{r.signerName}</td>
                    <td style={{ padding: '0.85rem 0.5rem', color: 'var(--text-secondary)' }}>{r.signerEmail}</td>
                    <td style={{ padding: '0.85rem 0.5rem' }}><StatusBadge status={r.status} /></td>
                    <td style={{ padding: '0.85rem 0.5rem', color: 'var(--text-secondary)', fontSize: '0.8rem' }}>
                      {r.createdAt ? formatDate(r.createdAt) : '—'}
                    </td>
                    <td style={{ padding: '0.85rem 0.5rem', color: 'var(--text-secondary)', fontSize: '0.8rem' }}>
                      {r.signedAt ? formatDate(r.signedAt) : '—'}
                    </td>
                    <td style={{ padding: '0.85rem 0.5rem' }}>
                      <div style={{ display: 'flex', gap: '0.4rem', flexWrap: 'wrap' }}>
                        <button
                          onClick={() => view(r)}
                          style={{
                            padding: '0.35rem 0.65rem', fontSize: '0.75rem',
                            background: 'transparent', color: 'var(--accent-color)',
                            border: '1px solid var(--border-color)', borderRadius: '6px',
                            cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '0.25rem',
                          }}
                        >
                          <Eye size={12} /> View
                        </button>
                        {r.status === 'PENDING' && (
                          <button
                            onClick={() => resend(r.id)}
                            style={{
                              padding: '0.35rem 0.65rem', fontSize: '0.75rem',
                              background: 'transparent', color: '#3b82f6',
                              border: '1px solid rgba(59,130,246,0.3)', borderRadius: '6px',
                              cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '0.25rem',
                            }}
                          >
                            <Send size={12} /> Resend
                          </button>
                        )}
                        {r.status !== 'SIGNED' && (
                          <button
                            onClick={() => cancel(r.id)}
                            style={{
                              padding: '0.35rem 0.65rem', fontSize: '0.75rem',
                              background: 'transparent', color: '#ef4444',
                              border: '1px solid rgba(239,68,68,0.3)', borderRadius: '6px',
                              cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '0.25rem',
                            }}
                          >
                            <X size={12} /> Cancel
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TopScrollSync>
        )}
      </div>

      {/* Create Modal */}
      {showCreate && (
        <Modal
          onClose={() => setShowCreate(false)}
          title="Request Signature"
          icon={
            <Plus
              size={20}
              color="var(--accent-color)"
            />
          }
        >
          {/* Patient / Estimate Tabs */}
          <div
            style={{
              display: 'flex',
              gap: '0.5rem',
              marginBottom: '1.5rem',
              padding: '4px',
              background: 'var(--subtle-bg-2)',
              borderRadius: '8px',
            }}
          >
            {['Patient', 'Estimate'].map((type) => (
              <button
                key={type}
                type="button"
                onClick={() => setSignatureType(type)}
                style={{
                  flex: 1,
                  padding: '0.65rem 1rem',
                  border: 'none',
                  borderRadius: '6px',
                  cursor: 'pointer',
                  fontWeight: 600,
                  fontSize: '0.85rem',
                  background:
                    signatureType === type
                      ? 'var(--surface-color)'
                      : 'transparent',
                  color:
                    signatureType === type
                      ? 'var(--text-primary)'
                      : 'var(--text-secondary)',
                  boxShadow:
                    signatureType === type
                      ? '0 1px 4px rgba(0,0,0,0.12)'
                      : 'none',
                }}
              >
                {type}
              </button>
            ))}
          </div>

    {/* ================= PATIENT FORM ================= */}
    {signatureType === 'Patient' && (
      <form onSubmit={submitCreate} style={{ display: 'flex', flexDirection: 'column', gap: '1.1rem' }}>

        <Field label="Document">
          <input
            type="text"
            required
            className="input-field"
            placeholder="Enter document name"
            value={form.documentName}
            onChange={(e) =>
              setForm({ ...form, documentName: e.target.value })
            }
          />
        </Field>

        {/* Signer */}
        <Field label="Signer">
          <select
            required
            className="input-field"
            value={form.patientId}
            onChange={(e) => handlePatientChange(e.target.value)}
          >
            <option value="">-- Select Patient --</option>

            {patients.map(patient => (
              <option key={patient.id} value={patient.id}>
                {patient.name}
              </option>
            ))}
          </select>
        </Field>
        {selectedPatient && !selectedPatient.email && (
          <Field label="Signer Email">
            <input
              type="email"
              required
              className="input-field"
              placeholder="Enter patient email"
              value={form.signerEmail}
              onChange={(e) =>
                setForm({
                  ...form,
                  signerEmail: e.target.value,
                })
              }
            />
          </Field>
        )}

        {/* Tied to visit — same contract as PrescribeTab's "Tied to visit":
            required, one option per visit rendered as
            "<date> — <service name>". Picking a visit pre-selects its
            service below when nothing is selected yet. */}
        <Field label="Tied to visit">
          <select
            required
            className="input-field"
            value={form.visitId}
            disabled={!selectedPatient || loadingVisits}
            onChange={(e) => handleVisitChange(e.target.value)}
          >
            <option value="">— select visit —</option>
            {loadingVisits && (
              <option value="">Loading visits...</option>
            )}
            {!loadingVisits && selectedPatient && patientVisits.length === 0 && (
              <option value="">No visits found for this patient</option>
            )}
            {patientVisits.map((v) => (
              <option key={v.id} value={v.id}>
                {formatDate(v.visitDate)} — {v.service?.name || 'Consultation'}
              </option>
            ))}
          </select>
        </Field>

        {/* Services — same source as the ConsentTab service dropdown
            (tenant service catalog), rendered as a dropdown that stays
            multi-select: collapsed trigger + checkbox menu. */}
        <Field label="Services">
          <ServicesMultiSelect
            options={servicesCatalog}
            value={form.services}
            onChange={(services) => setForm((prev) => ({ ...prev, services }))}
            disabled={!selectedPatient || loadingServices}
            loading={loadingServices}
            noPatient={!selectedPatient}
          />
        </Field>

        
        <button
          type="submit"
          className="btn-primary"
          disabled={loading}
          style={{
            padding: '0.85rem',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            gap: '0.5rem',
          }}
        >
          <Send size={16} />
          {loading ? 'Sending...' : 'Send Signature Request'}
        </button>

      </form>
    )}

          {/* ================= ESTIMATE FORM ================= */}
          {signatureType === 'Estimate' && (
            <form
              onSubmit={submitCreate}
              style={{
                display: 'flex',
                flexDirection: 'column',
                gap: '1.1rem',
              }}
            >
              {/* Document */}
              <Field label="Document">
                <select
                  required
                  className="input-field"
                  value={form.documentId}
                  onChange={(e) =>
                    setForm({
                      ...form,
                      documentId: e.target.value,
                    })
                  }
                  style={{
                    background: 'var(--input-bg)',
                  }}
                >
                  <option value="">
                    -- Select Estimate --
                  </option>

                  {docOptions.map((d) => (
                    <option
                      key={d.id}
                      value={d.id}
                    >
                      {docLabel(d)}
                    </option>
                  ))}
                </select>
              </Field>

              {/* Signer Name */}
              <Field label="Signer Name">
                <input
                  type="text"
                  required
                  className="input-field"
                  placeholder="Jane Doe"
                  value={form.signerName}
                  onChange={(e) =>
                    setForm({
                      ...form,
                      signerName: e.target.value,
                    })
                  }
                />
              </Field>

              {/* Signer Email */}
              <Field label="Signer Email">
                <input
                  type="email"
                  required
                  className="input-field"
                  placeholder="jane@example.com"
                  value={form.signerEmail}
                  onChange={(e) =>
                    setForm({
                      ...form,
                      signerEmail: e.target.value,
                    })
                  }
                />
              </Field>

              {/* Expires */}
              <Field label="Expires In (days)">
                <input
                  type="number"
                  min="1"
                  max="365"
                  className="input-field"
                  value={form.expiresInDays}
                  onChange={(e) =>
                    setForm({
                      ...form,
                      expiresInDays: e.target.value,
                    })
                  }
                />
              </Field>

              <button
                type="submit"
                className="btn-primary"
                disabled={loading}
                style={{
                  padding: '0.85rem',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  gap: '0.5rem',
                }}
              >
                <Send size={16} />
                {loading
                  ? 'Sending...'
                  : 'Send Signature Request'}
              </button>
            </form>
          )}
        </Modal>
      )}

      {/* View Modal */}
      {viewing && (
        <Modal onClose={() => { setViewing(null); setDetails(null); }} title={`${viewing.documentType} #${viewing.documentId}`} icon={<Eye size={20} color="var(--accent-color)" />}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem', fontSize: '0.9rem' }}>
            <Row k="Signer" v={viewing.signerName} />
            <Row k="Email" v={viewing.signerEmail} />
            <Row k="Status" v={<StatusBadge status={viewing.status} />} />
            <Row k="Sent" v={viewing.createdAt ? new Date(viewing.createdAt).toLocaleString() : '—'} />
            <Row k="Expires" v={viewing.expiresAt ? new Date(viewing.expiresAt).toLocaleString() : '—'} />
            <Row k="Signed" v={viewing.signedAt ? new Date(viewing.signedAt).toLocaleString() : '—'} />

            {viewing.status === 'SIGNED' && (details?.signature || viewing.signature) && (
              <div style={{ marginTop: '1rem' }}>
                <div style={{ color: 'var(--text-secondary)', fontSize: '0.8rem', marginBottom: '0.4rem', display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
                  <Check size={14} color="#10b981" /> Captured Signature
                </div>
                <div style={{ background: 'var(--surface-color)', borderRadius: '8px', padding: '0.75rem', border: '1px solid var(--border-color)' }}>
                  <img
                    src={details?.signature || viewing.signature}
                    alt="Signature"
                    style={{ maxWidth: '100%', display: 'block', margin: '0 auto' }}
                  />
                </div>
              </div>
            )}
          </div>
        </Modal>
      )}

      <style>{`@keyframes fadeIn { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: none; } }
        /* Request Signature modal: solid theme-aware surface. The global
           .card is translucent + blurred, so over the dark blurred
           backdrop this dialog washed out in dark theme (light was fine).
           Scoped to .sig-modal-card — nothing else in the app is touched. */
        .sig-modal-card { background: var(--modal-bg); }
        .sig-modal-card .input-field { color: var(--text-primary); }
        .sig-modal-card .input-field::placeholder { color: var(--text-secondary); opacity: 1; }
        .sig-modal-card select.input-field option { background-color: var(--modal-bg); color: var(--text-primary); }`}</style>
    </div>
  );
}

function Field({ label, children }) {
  return (
    <div>
      <label style={{ display: 'block', fontSize: '0.875rem', marginBottom: '0.4rem', color: 'var(--text-secondary)' }}>
        {label}
      </label>
      {children}
    </div>
  );
}

// Dropdown-style multi-select for the Patient-tab Services field.
// Looks like the single-select dropdowns above (collapsed trigger +
// chevron) but every menu row is a checkbox toggle, so any number of
// services can be picked. `value` is the array of selected service ids
// (strings, same shape the old native multi-select produced).
function ServicesMultiSelect({ options, value, onChange, disabled, loading, noPatient }) {
  const [isOpen, setIsOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [menuPos, setMenuPos] = useState({ top: 0, left: 0, width: 0, openUp: false });
  const triggerRef = useRef(null);
  const searchRef = useRef(null);

  const selected = Array.isArray(value) ? value.map(String) : [];

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return options;
    return options.filter((o) => String(o.name).toLowerCase().includes(q));
  }, [options, search]);

  const updatePos = () => {
    if (!triggerRef.current) return;
    const rect = triggerRef.current.getBoundingClientRect();
    const menuHeight = Math.min(280, filtered.length * 40 + 96);
    const openUp = rect.bottom + menuHeight + 8 > window.innerHeight && rect.top > menuHeight;
    setMenuPos({
      top: openUp ? 0 : rect.bottom + 4,
      bottom: openUp ? window.innerHeight - rect.top + 4 : 0,
      left: rect.left,
      width: rect.width,
      openUp,
    });
  };

  useEffect(() => {
    if (!isOpen) return;
    updatePos();
    window.addEventListener('scroll', updatePos, true);
    window.addEventListener('resize', updatePos);
    const onKey = (e) => { if (e.key === 'Escape') setIsOpen(false); };
    document.addEventListener('keydown', onKey);
    // Focus the search box once the portal menu mounts.
    const t = setTimeout(() => searchRef.current?.focus(), 0);
    return () => {
      window.removeEventListener('scroll', updatePos, true);
      window.removeEventListener('resize', updatePos);
      document.removeEventListener('keydown', onKey);
      clearTimeout(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, filtered.length]);

  const toggle = (id) => {
    const key = String(id);
    onChange(selected.includes(key) ? selected.filter((s) => s !== key) : [...selected, key]);
  };

  const label = noPatient
    ? '-- Select Patient First --'
    : loading
      ? 'Loading services...'
      : selected.length === 0
        ? '-- Select services --'
        : selected.length === 1
          ? (options.find((o) => String(o.id) === selected[0])?.name || '1 service selected')
          : `${selected.length} services selected`;

  return (
    <div style={{ position: 'relative', width: '100%' }}>
      <button
        ref={triggerRef}
        type="button"
        aria-haspopup="listbox"
        aria-expanded={isOpen}
        disabled={disabled}
        onClick={() => { setSearch(''); setIsOpen((v) => !v); }}
        className="input-field"
        style={{
          width: '100%',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: '0.5rem',
          textAlign: 'left',
          cursor: disabled ? 'not-allowed' : 'pointer',
          opacity: disabled ? 0.6 : 1,
          overflow: 'hidden',
        }}
      >
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: selected.length ? 'var(--text-primary)' : 'var(--text-secondary)' }}>
          {label}
        </span>
        <ChevronDown
          size={16}
          style={{ flexShrink: 0, transform: isOpen ? 'rotate(180deg)' : 'rotate(0deg)', transition: 'transform 0.2s' }}
        />
      </button>

      {isOpen && !disabled && createPortal(
        <>
          <div aria-hidden="true" onClick={() => setIsOpen(false)} style={{ position: 'fixed', inset: 0, zIndex: 10000 }} />
          <div
            role="listbox"
            aria-label="Services"
            aria-multiselectable="true"
            style={{
              position: 'fixed',
              ...(menuPos.openUp ? { bottom: menuPos.bottom } : { top: menuPos.top }),
              left: menuPos.left,
              width: menuPos.width,
              maxHeight: 280,
              background: 'var(--modal-bg, var(--bg-color))',
              border: '1px solid var(--border-color)',
              borderRadius: 8,
              overflow: 'hidden',
              boxShadow: '0 20px 25px -5px rgba(0,0,0,0.25), 0 10px 10px -5px rgba(0,0,0,0.15)',
              zIndex: 10001,
              display: 'flex',
              flexDirection: 'column',
            }}
          >
            <div style={{ padding: '0.5rem', borderBottom: '1px solid var(--border-color)' }}>
              <input
                ref={searchRef}
                type="text"
                placeholder="Search services..."
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                style={{
                  width: '100%', padding: '0.45rem 0.6rem', borderRadius: 6,
                  border: '1px solid var(--border-color)', background: 'var(--input-bg)',
                  color: 'var(--text-primary)', fontSize: '0.85rem', outline: 'none', boxSizing: 'border-box',
                }}
              />
            </div>
            <div style={{ overflowY: 'auto', flex: 1 }}>
              {filtered.length === 0 && (
                <div style={{ padding: '0.65rem 1rem', color: 'var(--text-secondary)', textAlign: 'center', fontSize: '0.85rem' }}>
                  No services found
                </div>
              )}
              {filtered.map((service) => {
                const key = String(service.id);
                const checked = selected.includes(key);
                return (
                  <div
                    key={service.id}
                    role="option"
                    aria-selected={checked}
                    onClick={() => toggle(service.id)}
                    onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--hover-bg, var(--subtle-bg-3))'; }}
                    onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
                    style={{
                      padding: '0.55rem 0.85rem', cursor: 'pointer', display: 'flex',
                      alignItems: 'center', gap: '0.6rem', fontSize: '0.88rem',
                      color: 'var(--text-primary)', fontWeight: checked ? 600 : 400,
                    }}
                  >
                    <span
                      aria-hidden="true"
                      style={{
                        width: 16, height: 16, borderRadius: 4, flexShrink: 0,
                        border: checked ? 'none' : '1px solid var(--border-color)',
                        background: checked ? 'var(--primary-color, var(--accent-color))' : 'transparent',
                        display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#fff',
                      }}
                    >
                      {checked && <Check size={12} />}
                    </span>
                    {service.name}
                  </div>
                );
              })}
            </div>
            {selected.length > 0 && (
              <div style={{ padding: '0.5rem 0.85rem', borderTop: '1px solid var(--border-color)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span style={{ fontSize: '0.78rem', color: 'var(--text-secondary)' }}>
                  {selected.length} selected
                </span>
                <button
                  type="button"
                  onClick={() => onChange([])}
                  style={{ background: 'transparent', border: 'none', color: 'var(--primary-color, var(--accent-color))', cursor: 'pointer', fontSize: '0.8rem', fontWeight: 600 }}
                >
                  Clear
                </button>
              </div>
            )}
          </div>
        </>,
        document.body
      )}
    </div>
  );
}

function Row({ k, v }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', gap: '1rem', padding: '0.4rem 0', borderBottom: '1px solid var(--border-color)' }}>
      <span style={{ color: 'var(--text-secondary)' }}>{k}</span>
      <span style={{ fontWeight: 600, textAlign: 'right' }}>{v}</span>
    </div>
  );
}

function Modal({ onClose, title, icon, children }) {
  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)', backdropFilter: 'blur(6px)',
        display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000, padding: '1rem',
      }}
    >
      <div
        onClick={e => e.stopPropagation()}
        className="card sig-modal-card"
        style={{ padding: '2rem', width: '100%', maxWidth: '520px', maxHeight: '90vh', overflowY: 'auto' }}
      >
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '1.25rem' }}>
          <h3 style={{ fontSize: '1.15rem', fontWeight: 600, display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            {icon} {title}
          </h3>
          <button
            onClick={onClose}
            style={{ background: 'transparent', border: 'none', cursor: 'pointer', color: 'var(--text-secondary)' }}
          >
            <X size={20} />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}
