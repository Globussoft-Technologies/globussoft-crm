/**
 * Visa Sure Advisor Dashboard — Phase 3 per-application advisor view
 * (cluster B3, rows V8-V10).
 *
 * Read-only per-application advisor view per docs/PRD_VISA_SURE_PHASE_3.md
 * §3 FR-4. Mounted at /travel/visa/applications/:applicationId — drilldown
 * from the existing Visa Applications list (875c082 sibling scaffold).
 *
 * WIRED to the GET /api/travel/visa/applications/:id backend endpoint
 * shipped at ce5f5db. Three sections render from real data:
 *
 *   1. Diagnostic answers (V8) — surfaces TravelDiagnostic.classificationLabel
 *      + score from the joined diagnostic projection. Renders a
 *      "View full diagnostic" link when a diagnostic row exists.
 *
 *   2. AI summary notes (V9) — LLM-router `visa-summary` task consumer
 *      per PRD §3 FR-4 + §6 (LLM consumer list). Placeholder text pending
 *      Q11 LLM-keys product call — there is no `aiSummary` field on
 *      VisaApplication yet (FR-4 LLM consumer is post-Q11).
 *
 *   3. Risk indicators (V10) — three coloured pills mapped to FR-3.1
 *      (complex case), FR-3.2 (prior rejection history), FR-3.3
 *      (high readinessLevel / advisorRiskFlag). Pills go RED on FR-3.1
 *      + FR-3.2 trip conditions, YELLOW on FR-3.3 advisor flag, otherwise
 *      remain neutral.
 *

 *   4. Document checklist progress (bonus) — "X of Y required documents
 *      verified" derived from the documentChecklist relation included
 *      by the backend.
 *
 * Mirrors frontend/src/pages/travel/LeadDetail.jsx parallel-fetch shape
 * for the data flow; visual shell matches the 875c082 SHELL it replaces.
 */
import { useEffect, useState, useContext } from 'react';
import { useParams, Link } from 'react-router-dom';
import {
  Stamp,
  ArrowLeft,
  AlertTriangle,
  History,
  ShieldAlert,
  ClipboardList,
  Sparkles,
  CheckCircle2,
  ArrowRight,
  HeartHandshake,
  Plus,
  CalendarDays,
  FileText,
  Loader2,
  Send,
  UserRound,
  Trash2,
} from 'lucide-react';
import { fetchApi, getActiveTenantId, getAuthToken } from '../../../utils/api';
import { useNotify } from '../../../utils/notify';
import { AuthContext } from '../../../App';

const SECTION = {
  background: 'rgba(255, 255, 255, 0.03)',
  border: '1px solid rgba(255, 255, 255, 0.05)',
  borderRadius: 12,
  padding: '1.25rem 1.5rem',
  marginBottom: '1.25rem',
};

const SECTION_HEADER = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  fontSize: '0.95rem',
  fontWeight: 600,
  color: 'var(--text-primary, #fff)',
  margin: 0,
  marginBottom: '0.75rem',
  letterSpacing: 0.3,
};

const EMPTY_LINE = {
  color: 'var(--text-secondary)',
  fontSize: '0.9rem',
  fontStyle: 'italic',
  lineHeight: 1.5,
};

const RISK_PILL_BASE = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 6,
  padding: '6px 12px',
  borderRadius: 999,
  fontSize: '0.8rem',
  fontWeight: 600,
  letterSpacing: 0.3,
  border: '1px solid',
};

// Risk pill palettes — neutral until the FR-3 risk-flag engine populates
// the corresponding fields, then active (red for hard risk, yellow for
// soft / advisor-tagged risk).
const PILL_NEUTRAL = {
  background: 'rgba(255, 255, 255, 0.04)',
  borderColor: 'rgba(255, 255, 255, 0.08)',
  color: 'var(--text-secondary)',
};

const PILL_RED = {
  background: 'rgba(255, 90, 90, 0.12)',
  borderColor: 'rgba(255, 90, 90, 0.4)',
  color: 'rgb(255, 160, 160)',
};

const PILL_YELLOW = {
  background: 'rgba(255, 200, 80, 0.12)',
  borderColor: 'rgba(255, 200, 80, 0.4)',
  color: 'rgb(255, 220, 140)',
};

const enrolBtn = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 6,
  padding: '6px 14px',
  borderRadius: 6,
  fontWeight: 600,
  fontSize: 13,
  background: 'var(--primary-color, var(--accent-color))',
  color: '#fff',
  border: 'none',
  cursor: 'pointer',
};

// Helpers — keep the JSX readable by hoisting the boolean checks here.

// FR-3.2: rejectionHistoryJson is a String? @db.Text — treat null /
// empty string / "[]" / "{}" as "no rejection history". Anything else
// is treated as a hit (the engine writes JSON arrays of prior decisions).
const hasRejectionHistory = (raw) => {
  if (!raw) return false;
  const s = String(raw).trim();
  if (s === '' || s === '[]' || s === '{}' || s === 'null') return false;
  return true;
};

// FR-3.3: advisorRiskFlag is a freeform String? — the visaRiskFlagEngine
// sets it to 'high' or 'priority' for elevated cases. Any non-empty
// value goes yellow; the canonical values are reflected in the title.
const isAdvisorRiskActive = (flag) => {
  if (!flag) return false;
  const f = String(flag).toLowerCase();
  return f === 'high' || f === 'priority';
};

const formatUiDate = (value) => {
  if (!value) return "";
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}/.test(value)) {
    return value.slice(0, 10);
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleDateString('en-GB', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  });
};

const formatTripLabel = (trip) => {
  if (!trip) return "";
  const parts = [trip.tripCode, trip.destination].filter(Boolean);
  const range = [formatUiDate(trip.departDate), formatUiDate(trip.returnDate)]
    .filter(Boolean)
    .join(' to ');
  if (range) parts.push(range);
  return parts.join(' - ');
};

// FR-6.3 — per-document lifecycle states. The advisor moves each document
// through these via the inline <select> in the Document checklist section;
// the backend auto-advances the application docs-pending → filed once every
// REQUIRED document reaches "verified".
const DOC_STATUSES = [
  { value: 'pending', label: 'Pending' },
  { value: 'uploaded', label: 'Uploaded' },
  { value: 'verified', label: 'Verified' },
  { value: 'rejected', label: 'Rejected' },
];

// Application lifecycle states (mirrors VALID_STATUSES in
// backend/routes/travel_visa.js). The advisor moves the application through
// these; setting "Docs pending" arms the FR-6.5 auto-advance (verifying the
// last required document then flips it to "Filed").
const APP_STATUSES = [
  { value: 'intake', label: 'Intake' },
  { value: 'docs-pending', label: 'Docs pending' },
  { value: 'filed', label: 'Filed' },
  { value: 'approved', label: 'Approved' },
  { value: 'rejected', label: 'Rejected' },
  { value: 'appeal', label: 'Appeal' },
];

const LETTER_TEMPLATE_LABELS = [
  'Parental Consent Letter',
  'Cover Letter',
  'No Objection Certificate',
  'Sponsorship Letter',
];

const VisaAdvisorDashboard = () => {
  const { applicationId } = useParams();
  const notify = useNotify();
  const { user } = useContext(AuthContext) || {};
  const canEnrol = user?.role === 'ADMIN' || user?.role === 'MANAGER';
  const [application, setApplication] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  // G107 — recovery-program enrolment UX. We surface "Enrol in recovery"
  // as a CTA when the application status is "rejected" OR the application
  // already has rejection history on file. Selecting a program POSTs to
  // /api/travel/visa/applications/:id/enrol-recovery; the response carries
  // the new recoveryProgramId which we mirror into local state.
  const [showEnrol, setShowEnrol] = useState(false);
  const [programs, setPrograms] = useState([]);
  const [programsLoading, setProgramsLoading] = useState(false);
  const [enrolBusy, setEnrolBusy] = useState(false);
  const [selectedProgramId, setSelectedProgramId] = useState('');
  const [trips, setTrips] = useState([]);
  const [tripsLoading, setTripsLoading] = useState(false);
  const [selectedTripId, setSelectedTripId] = useState('');
  const [participants, setParticipants] = useState([]);
  const [participantsLoading, setParticipantsLoading] = useState(false);
  const [selectedParticipantId, setSelectedParticipantId] = useState('');
  const [packetBusy, setPacketBusy] = useState(false);
  const [packetNotice, setPacketNotice] = useState(null);
  const [letterActionBusy, setLetterActionBusy] = useState(null);

  // FR-6.3 — per-application document checklist editing. `checklistBusy`
  // holds the id of the item currently being saved so its <select> can
  // disable while the PATCH is in flight.
  const [checklistBusy, setChecklistBusy] = useState(null);
  // Application-status change (intake → docs-pending → filed → …).
  const [statusBusy, setStatusBusy] = useState(false);
  // Ad-hoc "Add document" to this application's checklist (e.g. when no
  // template seeded it, or an extra document is needed).
  const [newDocType, setNewDocType] = useState('');
  const [newDocRequired, setNewDocRequired] = useState(true);
  const [addingDoc, setAddingDoc] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetchApi(`/api/travel/visa/applications/${applicationId}`)
      .then((res) => {
        if (cancelled) return;
        setApplication(res || null);
      })
      .catch((err) => {
        if (cancelled) return;
        // Surface the route's structured error code when present so
        // 404 NOT_FOUND / 404 NOT_VISA_SURE render the right copy.
        const code =
          (err && (err.code || (err.body && err.body.code))) || null;
        const message =
          (err && (err.message || (err.body && err.body.error))) ||
          'Failed to load visa application';
        setError({ code, message });
        setApplication(null);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [applicationId]);

  useEffect(() => {
    if (!canEnrol || application?.tripId) {
      setTrips([]);
      return undefined;
    }
    let cancelled = false;
    setTripsLoading(true);
    fetchApi('/api/travel/trips?fields=summary&limit=200', { silent: true })
      .then((res) => {
        if (cancelled) return;
        setTrips(Array.isArray(res?.trips) ? res.trips : []);
      })
      .catch(() => {
        if (cancelled) return;
        setTrips([]);
      })
      .finally(() => {
        if (!cancelled) setTripsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [canEnrol, application?.tripId]);

  useEffect(() => {
    if (application?.tripId && application?.participantId) {
      setParticipants([]);
      setSelectedTripId('');
      setSelectedParticipantId('');
      return undefined;
    }
    if (!canEnrol || !selectedTripId) {
      setParticipants([]);
      setSelectedParticipantId('');
      return undefined;
    }

    let cancelled = false;
    setParticipantsLoading(true);
    setSelectedParticipantId('');
    fetchApi(
      `/api/travel/trips/${selectedTripId}/participants?fields=summary`,
      { silent: true },
    )
      .then((res) => {
        if (cancelled) return;
        const rows = Array.isArray(res?.participants) ? res.participants : [];
        setParticipants(rows);
        if (rows.length === 1) {
          setSelectedParticipantId(String(rows[0].id));
        }
      })
      .catch(() => {
        if (cancelled) return;
        setParticipants([]);
      })
      .finally(() => {
        if (!cancelled) setParticipantsLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [canEnrol, selectedTripId, application?.tripId, application?.participantId]);

  // Re-fetch the application after a checklist mutation so the progress bar,
  // each item's status, and any auto-advanced application status all reflect
  // the latest server state. Silent — a transient refresh failure keeps the
  // last-good render rather than blanking the page.
  const refreshApplication = async () => {
    try {
      const res = await fetchApi(
        `/api/travel/visa/applications/${applicationId}`,
        { silent: true },
      );
      setApplication(res || null);
    } catch {
      /* keep last-good state */
    }
  };

  // PATCH a single document's status, then refresh. When the backend reports
  // the application auto-advanced (all required documents verified), surface a
  // success toast so the advisor knows it moved to "Filed".
  const updateChecklistItem = async (itemId, status) => {
    setChecklistBusy(itemId);
    try {
      const res = await fetchApi(
        `/api/travel/visa/applications/${applicationId}/checklist/${itemId}`,
        { method: 'PATCH', body: JSON.stringify({ status }) },
      );
      await refreshApplication();
      if (res && res.applicationStatus) {
        notify.success(
          'All required documents verified — application advanced to Filed.',
        );
      }
    } catch (err) {
      notify.error(
        (err && (err.message || (err.body && err.body.error))) ||
          'Failed to update document',
      );
    } finally {
      setChecklistBusy(null);
    }
  };

  // PATCH the application's lifecycle status, then refresh. Setting
  // "docs-pending" arms the auto-advance; the rest are manual transitions.
  const updateStatus = async (status) => {
    setStatusBusy(true);
    try {
      await fetchApi(`/api/travel/visa/applications/${applicationId}`, {
        method: 'PATCH',
        body: JSON.stringify({ status }),
      });
      await refreshApplication();
      notify.success(`Status updated to ${status}.`);
    } catch (err) {
      notify.error(
        (err && (err.message || (err.body && err.body.error))) ||
          'Failed to update status',
      );
    } finally {
      setStatusBusy(false);
    }
  };

  // Open an applicant's uploaded document via a short-lived signed link (the
  // raw file URL is no longer public). The backend authorizes the staff member
  // by role + Visa Sure sub-brand access before minting the link.
  const openDoc = async (itemId) => {
    try {
      const res = await fetchApi(`/api/travel/visa/documents/${itemId}/view-url`);
      if (res && res.url) window.open(res.url, '_blank', 'noopener,noreferrer');
      else notify.error("Couldn't open the document");
    } catch (err) {
      notify.error(err?.message || "Couldn't open the document");
    }
  };

  // Add an ad-hoc document to this application's checklist, then refresh.
  // Used when no template seeded the checklist (e.g. a self-serve applicant
  // whose destination had no template) or an extra document is needed.
  const addChecklistItem = async (e) => {
    e.preventDefault();
    const docType = newDocType.trim();
    if (!docType) {
      notify.error('Enter a document name');
      return;
    }
    setAddingDoc(true);
    try {
      await fetchApi(`/api/travel/visa/applications/${applicationId}/checklist`, {
        method: 'POST',
        body: JSON.stringify({ docType, required: newDocRequired }),
      });
      setNewDocType('');
      setNewDocRequired(true);
      await refreshApplication();
      notify.success('Document added to the checklist.');
    } catch (err) {
      notify.error(
        (err && (err.message || (err.body && err.body.error))) ||
          'Failed to add document',
      );
    } finally {
      setAddingDoc(false);
    }
  };


  const generateLetterPacket = async (e) => {
    e.preventDefault();
    const hasApplicationBinding = Boolean(application?.tripId && application?.participantId);

    setPacketBusy(true);
    setPacketNotice(null);
    try {
      const body = {};
      if (!hasApplicationBinding) {
        const tripId = Number(selectedTripId);
        if (!Number.isFinite(tripId)) {
          notify.error('This application is missing its trip binding.');
          setPacketBusy(false);
          return;
        }
        body.tripId = tripId;
        if (selectedParticipantId) {
          body.participantId = Number(selectedParticipantId);
        }
      }
      const res = await fetchApi(
        `/api/travel/visa/applications/${applicationId}/letters/generate`,
        {
          method: 'POST',
          body: JSON.stringify(body),
        },
      );
      await refreshApplication();
      const generated = Array.isArray(res?.generated) ? res.generated : [];
      const skipped = Array.isArray(res?.skipped) ? res.skipped : [];
      setPacketNotice({ generated, skipped });
      notify.success('Letter packet generated successfully.');
    } catch (err) {
      notify.error(
        (err && (err.message || (err.body && err.body.error))) ||
          'Failed to generate letter packet',
      );
    } finally {
      setPacketBusy(false);
    }
  };

  const fetchLetterBlob = async (path) => {
    const headers = {};
    const token = getAuthToken();
    if (token) headers.Authorization = `Bearer ${token}`;
    const activeTenantId = getActiveTenantId();
    if (activeTenantId != null) headers['X-Active-Tenant'] = String(activeTenantId);
    const res = await fetch(path, { headers });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error || `HTTP ${res.status}`);
    }
    return res.blob();
  };

  const openLetter = async (letterId, kind = 'generated') => {
    setLetterActionBusy(`${kind}-${letterId}`);
    try {
      const blob = await fetchLetterBlob(
        `/api/travel/visa/letters/${letterId}/${kind}`,
      );
      const url = URL.createObjectURL(blob);
      window.open(url, '_blank', 'noopener,noreferrer');
      setTimeout(() => URL.revokeObjectURL(url), 30000);
    } catch (err) {
      notify.error(err?.message || "Couldn't open the letter");
    } finally {
      setLetterActionBusy(null);
    }
  };

  const removeLetter = async (letter) => {
    const label = `${letter.documentType || letter.docType || 'Letter'}${letter.signedUploadedAt ? ' (signed copy)' : ''}`;
    const ok = await notify.confirm({
      title: 'Remove letter?',
      message: `Remove ${label} from this packet? This deletes the stored PDF and removes the row from the packet.`,
      confirmText: 'Remove',
      destructive: true,
    });
    if (!ok) return;
    setLetterActionBusy(`remove-${letter.id}`);
    try {
      await fetchApi(`/api/travel/visa/applications/${applicationId}/letters/${letter.id}`, {
        method: 'DELETE',
      });
      await refreshApplication();
      notify.success(`${letter.documentType || letter.docType || 'Letter'} removed from the packet.`);
    } catch (err) {
      notify.error(
        (err && (err.message || (err.body && err.body.error))) ||
          'Failed to remove letter',
      );
    } finally {
      setLetterActionBusy(null);
    }
  };

  const downloadLetterPacket = async () => {
    setLetterActionBusy('download-all');
    try {
      const blob = await fetchLetterBlob(
        `/api/travel/visa/applications/${applicationId}/letters/download-all`,
      );
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `visa-letter-packet-${applicationId}.zip`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 30000);
    } catch (err) {
      notify.error(err?.message || "Couldn't download the packet");
    } finally {
      setLetterActionBusy(null);
    }
  };

  const sendLetterPacket = async () => {
    setLetterActionBusy('send');
    try {
      await fetchApi(`/api/travel/visa/applications/${applicationId}/letters/send`, {
        method: 'POST',
        body: JSON.stringify({}),
      });
      await refreshApplication();
      notify.success('Letter packet sent to the customer portal.');
    } catch (err) {
      notify.error(
        (err && (err.message || (err.body && err.body.error))) ||
          'Failed to send letter packet',
      );
    } finally {
      setLetterActionBusy(null);
    }
  };
  // Document checklist progress (bonus). Required items only — optional
  // items don't gate the application moving forward, per FR-5 docs flow.
  const checklist = Array.isArray(application?.documentChecklist)
    ? application.documentChecklist
    : [];
  const letterDocs = Array.isArray(application?.visaLetterDocuments)
    ? application.visaLetterDocuments
    : [];
  const hasLetterBinding = Boolean(application?.tripId && application?.participantId);
  const linkedTripLabel = application?.trip
    ? formatTripLabel(application.trip)
    : (application?.tripId ? `Trip #${application.tripId}` : '');
  const linkedParticipantLabel = application?.participant?.fullName
    || (application?.participantId ? `Participant #${application.participantId}` : '');
  const requiredItems = checklist.filter((i) => i?.required);
  const verifiedRequired = requiredItems.filter(
    (i) => i?.status === 'verified',
  );

  // Risk-pill state — re-evaluated on every render off the loaded row.
  const complexCaseActive = Boolean(application?.complexCase);
  const rejectionActive = hasRejectionHistory(
    application?.rejectionHistoryJson,
  );
  const advisorRiskActive = isAdvisorRiskActive(application?.advisorRiskFlag);

  return (
    <div style={{ padding: 24, maxWidth: 980, margin: '0 auto' }}>
      <Link
        to="/travel/visa/applications"
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 6,
          color: 'var(--text-secondary)',
          textDecoration: 'none',
          fontSize: '0.85rem',
          marginBottom: '1rem',
        }}
      >
        <ArrowLeft size={14} /> Back to Visa Applications
      </Link>

      <header style={{ marginBottom: '1.5rem' }}>
        <h1
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 10,
            margin: 0,
            fontSize: '1.75rem',
            fontWeight: 'bold',
          }}
        >
          <Stamp
            size={28}
            color="var(--primary-color, var(--accent-color))"
            aria-hidden
          />
          Visa application&nbsp;
          <code style={{ fontSize: '1.1rem', opacity: 0.7 }}>
            #{applicationId}
          </code>
        </h1>
        {application?.contact?.name && (
          <div
            style={{
              marginTop: 6,
              color: 'var(--text-secondary)',
              fontSize: '0.9rem',
            }}
          >
            {application.contact.name}
            {application.applicationType ? (
              <>
                {' '}&middot; <span style={{ opacity: 0.85 }}>
                  {application.applicationType}
                </span>
              </>
            ) : null}
            {application.status ? (
              <>
                {' '}&middot;{' '}
                <span style={{ opacity: 0.85 }}>{application.status}</span>
              </>
            ) : null}
          </div>
        )}
      </header>

      {loading && (
        <div style={EMPTY_LINE}>Loading application&hellip;</div>
      )}

      {!loading && error && (
        <div
          style={{
            ...SECTION,
            borderColor: 'rgba(255, 120, 120, 0.25)',
            background: 'rgba(255, 120, 120, 0.05)',
          }}
        >
          <p style={EMPTY_LINE}>
            {error.code === 'NOT_FOUND' || error.code === 'NOT_VISA_SURE'
              ? 'Visa application not found, or you do not have access to it.'
              : error.message}
          </p>
        </div>
      )}

      {!loading && !error && application && (
        <>
          {/* Application status control — advisors move the lifecycle
              intake → docs-pending → filed → approved/rejected/appeal.
              Setting "Docs pending" arms the FR-6.5 auto-advance. */}
          <section style={SECTION}>
            <h2 style={SECTION_HEADER}>
              <Stamp size={16} aria-hidden /> Application status
            </h2>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
              <select
                data-testid="application-status"
                value={application.status || 'intake'}
                disabled={!canEnrol || statusBusy}
                onChange={(e) => updateStatus(e.target.value)}
                style={{
                  padding: '0.4rem 0.6rem',
                  borderRadius: 6,
                  border: '1px solid var(--border-color, rgba(255,255,255,0.15))',
                  background: 'var(--input-bg, rgba(255,255,255,0.05))',
                  color: 'var(--text-primary, #fff)',
                  fontSize: '0.85rem',
                  cursor: !canEnrol || statusBusy ? 'not-allowed' : 'pointer',
                  opacity: statusBusy ? 0.6 : 1,
                }}
              >
                {APP_STATUSES.map((s) => (
                  <option key={s.value} value={s.value}>{s.label}</option>
                ))}
              </select>
              <span style={{ fontSize: '0.8rem', color: 'var(--text-secondary)' }}>
                Set <strong>Docs pending</strong>, then verify every required
                document below — the application auto-advances to{' '}
                <strong>Filed</strong>.
              </span>
            </div>
          </section>

          {canEnrol && (
            <section style={SECTION}>
              <h2 style={SECTION_HEADER}>
                <FileText size={16} aria-hidden /> Visa letter packet
              </h2>
              <p style={{ ...EMPTY_LINE, fontStyle: 'normal', marginBottom: 12 }}>
                These four documents are generated from managed letter templates.
                For new applications the trip and participant are linked during
                creation, so generation uses that saved binding automatically.
              </p>
              <div
                data-testid="letter-template-list"
                style={{
                  display: 'flex',
                  gap: 8,
                  flexWrap: 'wrap',
                  marginBottom: 12,
                }}
              >
                {LETTER_TEMPLATE_LABELS.map((label) => (
                  <span
                    key={label}
                    style={{
                      padding: '4px 8px',
                      borderRadius: 999,
                      border: '1px solid rgba(255,255,255,0.08)',
                      background: 'rgba(255,255,255,0.04)',
                      color: 'var(--text-secondary)',
                      fontSize: '0.76rem',
                    }}
                  >
                    {label}
                  </span>
                ))}
              </div>
              <form onSubmit={generateLetterPacket}>
                <div
                  style={{
                    display: 'grid',
                    gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 220px), 1fr))',
                    gap: 12,
                  }}
                >
                  {hasLetterBinding ? (
                    <div
                      data-testid="letter-binding-summary"
                      style={{
                        gridColumn: '1 / -1',
                        padding: '0.75rem 0.9rem',
                        borderRadius: 10,
                        border: '1px solid rgba(255,255,255,0.08)',
                        background: 'rgba(255,255,255,0.04)',
                        color: 'var(--text-secondary)',
                        fontSize: '0.84rem',
                        display: 'grid',
                        gap: 4,
                      }}
                    >
                      <strong style={{ color: 'var(--text-primary, #fff)' }}>
                        Linked travel record
                      </strong>
                      <span><CalendarDays size={13} aria-hidden /> {linkedTripLabel}</span>
                      <span><UserRound size={13} aria-hidden /> {linkedParticipantLabel}</span>
                    </div>
                  ) : (
                    <>
                      <label
                        style={{
                          display: 'flex',
                          flexDirection: 'column',
                          gap: 6,
                          color: 'var(--text-primary, #fff)',
                          fontSize: '0.84rem',
                        }}
                      >
                        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                          <CalendarDays size={14} aria-hidden /> Legacy trip
                        </span>
                        <select
                          data-testid="letter-trip-select"
                          value={selectedTripId}
                          onChange={(e) => setSelectedTripId(e.target.value)}
                          disabled={tripsLoading || packetBusy}
                          style={{
                            padding: '0.45rem 0.6rem',
                            borderRadius: 6,
                            border: '1px solid var(--border-color, rgba(255,255,255,0.15))',
                            background: 'var(--input-bg, rgba(255,255,255,0.05))',
                            color: 'var(--text-primary, #fff)',
                            fontSize: '0.85rem',
                          }}
                        >
                          <option value="">{tripsLoading ? 'Loading trips...' : 'Select a trip'}</option>
                          {trips.map((trip) => (
                            <option key={trip.id} value={trip.id}>
                              {formatTripLabel(trip) || `Trip #${trip.id}`}
                            </option>
                          ))}
                        </select>
                      </label>

                      <label
                        style={{
                          display: 'flex',
                          flexDirection: 'column',
                          gap: 6,
                          color: 'var(--text-primary, #fff)',
                          fontSize: '0.84rem',
                        }}
                      >
                        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                          <UserRound size={14} aria-hidden /> Legacy participant
                        </span>
                        <select
                          data-testid="letter-participant-select"
                          value={selectedParticipantId}
                          onChange={(e) => setSelectedParticipantId(e.target.value)}
                          disabled={!selectedTripId || participantsLoading || packetBusy}
                          style={{
                            padding: '0.45rem 0.6rem',
                            borderRadius: 6,
                            border: '1px solid var(--border-color, rgba(255,255,255,0.15))',
                            background: 'var(--input-bg, rgba(255,255,255,0.05))',
                            color: 'var(--text-primary, #fff)',
                            fontSize: '0.85rem',
                          }}
                        >
                          <option value="">
                            {participantsLoading
                              ? 'Loading participants...'
                              : participants.length === 0
                                ? 'Select a trip first'
                                : participants.length === 1
                                  ? participants[0].fullName || 'Selected participant'
                                  : 'Select a participant'}
                          </option>
                          {participants.map((participant) => (
                            <option key={participant.id} value={participant.id}>
                              {participant.fullName || `Participant #${participant.id}`}
                            </option>
                          ))}
                        </select>
                      </label>
                    </>
                  )}

                  <div
                    style={{
                      display: 'flex',
                      flexDirection: 'column',
                      justifyContent: 'flex-end',
                      gap: 8,
                    }}
                  >
                    <button
                      type="submit"
                      data-testid="generate-letter-packet"
                      disabled={packetBusy || (!hasLetterBinding && !selectedTripId)}
                      style={{
                        display: 'inline-flex',
                        alignItems: 'center',
                        gap: 6,
                        padding: '0.55rem 0.9rem',
                        borderRadius: 6,
                        border: 'none',
                        background: 'var(--primary-color, var(--accent-color))',
                        color: '#fff',
                        fontWeight: 600,
                        fontSize: '0.85rem',
                        cursor: packetBusy || (!hasLetterBinding && !selectedTripId) ? 'not-allowed' : 'pointer',
                        opacity: packetBusy || (!hasLetterBinding && !selectedTripId) ? 0.65 : 1,
                        width: 'fit-content',
                      }}
                    >
                      {packetBusy ? <Loader2 size={14} /> : <Send size={14} />}
                      {packetBusy ? 'Generating...' : 'Generate packet'}
                    </button>
                    <span style={{ color: 'var(--text-secondary)', fontSize: '0.8rem', lineHeight: 1.4 }}>
                      Generate first, then send the packet to the customer portal.
                    </span>
                  </div>
                </div>
              </form>

              {packetNotice && (
                <div
                  data-testid="letter-packet-result"
                  style={{
                    marginTop: 14,
                    padding: '0.85rem 1rem',
                    borderRadius: 10,
                    border: '1px solid rgba(255,255,255,0.08)',
                    background: 'rgba(255,255,255,0.04)',
                  }}
                >
                  <div style={{ fontWeight: 600, marginBottom: 6 }}>
                    Generated {packetNotice.generated.length} letter
                    {packetNotice.generated.length === 1 ? '' : 's'}
                  </div>
                  {packetNotice.generated.length > 0 && (
                    <div style={{ color: 'var(--text-secondary)', fontSize: '0.84rem' }}>
                      {packetNotice.generated.map((item) => item.docType).join(', ')}
                    </div>
                  )}
                  {packetNotice.skipped.length > 0 && (
                    <div style={{ color: 'var(--text-secondary)', fontSize: '0.84rem', marginTop: 6 }}>
                      Skipped {packetNotice.skipped.length} locked item
                      {packetNotice.skipped.length === 1 ? '' : 's'}.
                    </div>
                  )}
                </div>
              )}

              {letterDocs.length > 0 && (
                <div
                  data-testid="letter-packet-documents"
                  style={{
                    marginTop: 14,
                    borderTop: '1px solid rgba(255,255,255,0.08)',
                    paddingTop: 14,
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 10,
                  }}
                >
                  <div
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      gap: 10,
                      flexWrap: 'wrap',
                    }}
                  >
                    <div style={{ fontWeight: 600 }}>
                      Current letter packet ({letterDocs.length})
                    </div>
                    <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                      <button
                        type="button"
                        data-testid="send-letter-packet"
                        onClick={sendLetterPacket}
                        disabled={letterActionBusy === 'send'}
                        style={{
                          ...enrolBtn,
                          opacity: letterActionBusy === 'send' ? 0.6 : 1,
                          cursor: letterActionBusy === 'send' ? 'wait' : 'pointer',
                        }}
                      >
                        {letterActionBusy === 'send' ? 'Sending...' : 'Send to portal'}
                      </button>
                      <button
                        type="button"
                        data-testid="download-letter-packet"
                        onClick={downloadLetterPacket}
                        disabled={letterActionBusy === 'download-all'}
                        style={{
                          ...enrolBtn,
                          background: 'transparent',
                          color: 'var(--primary-color, var(--accent-color))',
                          border: '1px solid var(--primary-color, var(--accent-color))',
                          opacity: letterActionBusy === 'download-all' ? 0.6 : 1,
                          cursor: letterActionBusy === 'download-all' ? 'wait' : 'pointer',
                        }}
                      >
                        {letterActionBusy === 'download-all' ? 'Preparing...' : 'Download all'}
                      </button>
                    </div>
                  </div>
                  {letterDocs.map((letter) => (
                    <div
                      key={letter.id}
                      data-testid={`letter-doc-${letter.id}`}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: 10,
                        padding: '0.55rem 0',
                        borderTop: '1px solid rgba(255,255,255,0.06)',
                      }}
                    >
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ color: 'var(--text-primary, #fff)', fontSize: '0.9rem' }}>
                          {letter.documentType || letter.docType}
                        </div>
                        <div style={{ color: 'var(--text-secondary)', fontSize: '0.78rem', marginTop: 2 }}>
                          {letter.status}
                          {letter.signedUploadedAt ? ' - signed uploaded' : ''}
                        </div>
                      </div>
                      <button
                        type="button"
                        onClick={() => openLetter(letter.id, 'generated')}
                        disabled={letterActionBusy === `generated-${letter.id}`}
                        style={{
                          background: 'none',
                          border: 'none',
                          padding: 0,
                          cursor: letterActionBusy === `generated-${letter.id}` ? 'wait' : 'pointer',
                          fontSize: '0.78rem',
                          color: 'var(--primary-color, var(--accent-color))',
                          textDecoration: 'underline',
                          whiteSpace: 'nowrap',
                        }}
                        >
                          Preview
                        </button>
                      <button
                        type="button"
                        onClick={() => removeLetter(letter)}
                        disabled={letterActionBusy === `remove-${letter.id}`}
                        style={{
                          background: 'none',
                          border: 'none',
                          padding: 0,
                          cursor: letterActionBusy === `remove-${letter.id}` ? 'wait' : 'pointer',
                          fontSize: '0.78rem',
                          color: '#ef4444',
                          textDecoration: 'underline',
                          whiteSpace: 'nowrap',
                        }}
                      >
                        <Trash2 size={12} aria-hidden /> Remove
                      </button>
                      {letter.signedUploadedAt && (
                        <button
                          type="button"
                          onClick={() => openLetter(letter.id, 'signed')}
                          disabled={letterActionBusy === `signed-${letter.id}`}
                          style={{
                            background: 'none',
                            border: 'none',
                            padding: 0,
                            cursor: letterActionBusy === `signed-${letter.id}` ? 'wait' : 'pointer',
                            fontSize: '0.78rem',
                            color: '#16a34a',
                            textDecoration: 'underline',
                            whiteSpace: 'nowrap',
                          }}
                        >
                          Signed
                        </button>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </section>
          )}

          {/* Section 1 — Diagnostic answers (V8 / PRD §3 FR-4) */}
          <section style={SECTION}>
            <h2 style={SECTION_HEADER}>
              <ClipboardList size={16} aria-hidden /> Diagnostic answers
            </h2>
            {application.diagnostic ? (
              <div
                style={{
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 6,
                  fontSize: '0.9rem',
                }}
              >
                <div>
                  <strong>Classification:</strong>{' '}
                  <span style={{ color: 'var(--text-secondary)' }}>
                    {application.diagnostic.classificationLabel ||
                      application.diagnostic.classification ||
                      '—'}
                  </span>
                </div>
                <div>
                  <strong>Score:</strong>{' '}
                  <span style={{ color: 'var(--text-secondary)' }}>
                    {application.diagnostic.score != null
                      ? application.diagnostic.score
                      : '—'}
                  </span>
                </div>
                {application.diagnostic.recommendedTier && (
                  <div>
                    <strong>Recommended tier:</strong>{' '}
                    <span style={{ color: 'var(--text-secondary)' }}>
                      {application.diagnostic.recommendedTier}
                    </span>
                  </div>
                )}
                {application.diagnostic.id != null && (
                  <Link
                    to={`/travel/diagnostics/${application.diagnostic.id}`}
                    style={{
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: 6,
                      marginTop: 6,
                      color:
                        'var(--primary-color, var(--accent-color))',
                      textDecoration: 'none',
                      fontSize: '0.85rem',
                      fontWeight: 600,
                    }}
                  >
                    View full diagnostic <ArrowRight size={14} />
                  </Link>
                )}
              </div>
            ) : (
              <div style={EMPTY_LINE}>
                No diagnostic submitted yet for this contact.
              </div>
            )}
          </section>

          {/* Section 2 — AI summary notes (V9 / PRD §3 FR-4 LLM consumer).
              Placeholder pending Q11 LLM-keys product call — there is no
              aiSummary field on VisaApplication yet. */}
          <section style={SECTION}>
            <h2 style={SECTION_HEADER}>
              <Sparkles size={16} aria-hidden /> AI summary notes
            </h2>
            <div style={EMPTY_LINE}>
              Pending LLM rollout — the <code>visa-summary</code> task in
              the LLM router lands with Q11 (LLM-keys product call) per
              PRD §6.
            </div>
          </section>

          {/* Section 3 — Risk indicators (V10 / PRD §3 FR-3.1+3.2+3.3).
              Pills are red on FR-3.1 + FR-3.2 trip conditions and yellow
              on FR-3.3 advisor flag. */}
          <section style={SECTION}>
            <h2 style={SECTION_HEADER}>
              <ShieldAlert size={16} aria-hidden /> Risk indicators
            </h2>
            <div
              style={{
                display: 'flex',
                flexWrap: 'wrap',
                gap: 8,
                alignItems: 'center',
              }}
            >
              {/* FR-3.1 — Complex case */}
              <span
                style={{
                  ...RISK_PILL_BASE,
                  ...(complexCaseActive ? PILL_RED : PILL_NEUTRAL),
                }}
                title="Complex case flag (FR-3.1)"
              >
                <AlertTriangle size={12} aria-hidden /> Complex case&nbsp;
                <span style={{ opacity: 0.8 }}>
                  {complexCaseActive ? 'yes' : 'no'}
                </span>
              </span>

              {/* FR-3.2 — Prior rejection history */}
              <span
                style={{
                  ...RISK_PILL_BASE,
                  ...(rejectionActive ? PILL_RED : PILL_NEUTRAL),
                }}
                title="Prior rejection history (FR-3.2)"
              >
                <History size={12} aria-hidden /> Rejection history&nbsp;
                <span style={{ opacity: 0.8 }}>
                  {rejectionActive ? 'on file' : 'none'}
                </span>
              </span>

              {/* FR-3.3 — Advisor risk flag (yellow = high / priority) */}
              <span
                style={{
                  ...RISK_PILL_BASE,
                  ...(advisorRiskActive ? PILL_YELLOW : PILL_NEUTRAL),
                }}
                title="Advisor risk flag (FR-3.3)"
              >
                <ShieldAlert size={12} aria-hidden /> Advisor risk flag&nbsp;
                <span style={{ opacity: 0.8 }}>
                  {application.advisorRiskFlag || '—'}
                </span>
              </span>
            </div>
            <p style={{ ...EMPTY_LINE, marginTop: 12 }}>
              Risk flags populated by{' '}
              <code>backend/cron/visaRiskFlagEngine.js</code> (shell at
              commit <code>9e8c28f</code>).
            </p>
          </section>

          {/* G107 — Rejection-recovery enrolment. Surfaces a CTA when the
              advisor sees a rejected application OR the row already has
              rejection history. The dropdown is loaded lazily on click to
              avoid a per-render programs fetch. */}
          {(application.status === 'rejected' ||
            rejectionActive ||
            application.recoveryProgramId != null) && (
            <section style={SECTION}>
              <h2 style={SECTION_HEADER}>
                <HeartHandshake size={16} aria-hidden /> Rejection recovery
              </h2>
              {application.recoveryProgramId != null ? (
                <div
                  style={{
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 6,
                    fontSize: '0.9rem',
                  }}
                >
                  <div>
                    Currently enrolled in program{' '}
                    <strong>#{application.recoveryProgramId}</strong>.
                  </div>
                  <Link
                    to="/travel/visa/recovery-programs"
                    style={{
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: 6,
                      marginTop: 6,
                      color: 'var(--primary-color, var(--accent-color))',
                      textDecoration: 'none',
                      fontSize: '0.85rem',
                      fontWeight: 600,
                    }}
                  >
                    Manage programs <ArrowRight size={14} />
                  </Link>
                </div>
              ) : (
                <div style={EMPTY_LINE}>
                  No recovery program selected yet.
                </div>
              )}
              {canEnrol && (
                <div style={{ marginTop: 10 }}>
                  {!showEnrol ? (
                    <button
                      type="button"
                      onClick={() => {
                        setShowEnrol(true);
                        if (programs.length === 0 && !programsLoading) {
                          setProgramsLoading(true);
                          fetchApi(
                            '/api/travel/visa/recovery-programs?active=true',
                          )
                            .then((res) => {
                              setPrograms(
                                Array.isArray(res?.programs)
                                  ? res.programs
                                  : [],
                              );
                            })
                            .catch(() => setPrograms([]))
                            .finally(() => setProgramsLoading(false));
                        }
                      }}
                      style={enrolBtn}
                      aria-label="Enrol in recovery program"
                    >
                      Enrol in recovery
                    </button>
                  ) : (
                    <div
                      style={{
                        display: 'flex',
                        gap: 8,
                        flexWrap: 'wrap',
                        alignItems: 'center',
                      }}
                    >
                      <select
                        value={selectedProgramId}
                        onChange={(e) => setSelectedProgramId(e.target.value)}
                        aria-label="Pick recovery program"
                        style={{
                          padding: '6px 10px',
                          borderRadius: 6,
                          border: '1px solid var(--border-color)',
                          background: 'var(--bg-color)',
                          color: 'var(--text-primary)',
                          fontSize: 13,
                        }}
                      >
                        <option value="">
                          {programsLoading
                            ? 'Loading…'
                            : programs.length === 0
                              ? 'No active programs'
                              : 'Pick a program'}
                        </option>
                        {programs.map((p) => (
                          <option key={p.id} value={p.id}>
                            {p.name} ({p.destinationCountry})
                          </option>
                        ))}
                      </select>
                      <button
                        type="button"
                        onClick={async () => {
                          if (!selectedProgramId) return;
                          setEnrolBusy(true);
                          try {
                            const res = await fetchApi(
                              `/api/travel/visa/applications/${applicationId}/enrol-recovery`,
                              {
                                method: 'POST',
                                body: JSON.stringify({
                                  recoveryProgramId: Number(selectedProgramId),
                                }),
                              },
                            );
                            notify.success(
                              res?.message ||
                                'Application enrolled in recovery program',
                            );
                            setApplication((prev) =>
                              prev
                                ? {
                                    ...prev,
                                    recoveryProgramId:
                                      res?.recoveryProgramId ?? null,
                                  }
                                : prev,
                            );
                            setShowEnrol(false);
                            setSelectedProgramId('');
                          } catch (err) {
                            notify.error(
                              err?.body?.error ||
                                err?.message ||
                                'Failed to enrol',
                            );
                          } finally {
                            setEnrolBusy(false);
                          }
                        }}
                        disabled={!selectedProgramId || enrolBusy}
                        style={{
                          ...enrolBtn,
                          opacity: !selectedProgramId || enrolBusy ? 0.6 : 1,
                          cursor:
                            !selectedProgramId || enrolBusy
                              ? 'not-allowed'
                              : 'pointer',
                        }}
                      >
                        {enrolBusy ? 'Enrolling…' : 'Save'}
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          setShowEnrol(false);
                          setSelectedProgramId('');
                        }}
                        style={{
                          ...enrolBtn,
                          background: 'transparent',
                          color: 'var(--text-secondary)',
                          border: '1px solid var(--border-color)',
                        }}
                      >
                        Cancel
                      </button>
                    </div>
                  )}
                </div>
              )}
            </section>
          )}

          {/* Section 4 (bonus) — Document checklist progress.
              Surfaces the X-of-Y verified ratio across REQUIRED items;
              optional items don't gate forward motion per FR-5. */}
          <section style={SECTION}>
            <h2 style={SECTION_HEADER}>
              <CheckCircle2 size={16} aria-hidden /> Document checklist
            </h2>
            {checklist.length === 0 ? (
              <div style={EMPTY_LINE}>
                No document checklist items recorded for this application
                yet.
              </div>
            ) : (
              <>
                {requiredItems.length > 0 && (
                  <>
                    <div
                      style={{
                        fontSize: '0.9rem',
                        color: 'var(--text-primary, #fff)',
                        marginBottom: 8,
                      }}
                    >
                      <strong>{verifiedRequired.length}</strong> of{' '}
                      <strong>{requiredItems.length}</strong> required
                      documents verified
                    </div>
                    <div
                      style={{
                        height: 6,
                        width: '100%',
                        borderRadius: 999,
                        background: 'rgba(255, 255, 255, 0.06)',
                        overflow: 'hidden',
                      }}
                      role="progressbar"
                      aria-valuemin={0}
                      aria-valuemax={requiredItems.length}
                      aria-valuenow={verifiedRequired.length}
                      aria-label="Required documents verified"
                    >
                      <div
                        style={{
                          height: '100%',
                          width: `${
                            (verifiedRequired.length / requiredItems.length) *
                            100
                          }%`,
                          background:
                            'var(--primary-color, var(--accent-color))',
                          transition: 'width 200ms ease',
                        }}
                      />
                    </div>
                  </>
                )}

                {/* Per-document status controls (FR-6.3). Advisors move each
                    document through pending → uploaded → verified | rejected;
                    verifying the last required document auto-advances the
                    application to "Filed" (handled server-side). */}
                <div
                  style={{
                    marginTop: requiredItems.length > 0 ? 14 : 0,
                    display: 'flex',
                    flexDirection: 'column',
                  }}
                >
                  {checklist.map((item) => (
                    <div
                      key={item.id}
                      data-testid={`doc-item-${item.id}`}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: 10,
                        padding: '0.5rem 0',
                        borderTop:
                          '1px solid var(--border-color, rgba(255,255,255,0.08))',
                      }}
                    >
                      <span
                        style={{
                          flex: 1,
                          minWidth: 0,
                          color: 'var(--text-primary, #fff)',
                          fontSize: '0.9rem',
                        }}
                      >
                        {item.docType}
                        {item.required && (
                          <span
                            style={{
                              marginLeft: 6,
                              fontSize: '0.72rem',
                              color: 'var(--text-secondary, #94a3b8)',
                            }}
                          >
                            (required)
                          </span>
                        )}
                      </span>
                      {item.attachmentUrl && (
                        <button
                          type="button"
                          onClick={() => openDoc(item.id)}
                          data-testid={`doc-view-${item.id}`}
                          title={item.attachmentName || 'View uploaded document'}
                          style={{
                            background: 'none',
                            border: 'none',
                            padding: 0,
                            cursor: 'pointer',
                            fontSize: '0.78rem',
                            color: 'var(--primary-color, var(--accent-color))',
                            textDecoration: 'underline',
                            whiteSpace: 'nowrap',
                          }}
                        >
                          View file
                        </button>
                      )}
                      <select
                        data-testid={`doc-status-${item.id}`}
                        aria-label={`Status for ${item.docType || 'document'}`}
                        value={item.status || 'pending'}
                        disabled={!canEnrol || checklistBusy === item.id}
                        onChange={(e) =>
                          updateChecklistItem(item.id, e.target.value)
                        }
                        style={{
                          padding: '0.3rem 0.5rem',
                          borderRadius: 6,
                          border:
                            '1px solid var(--border-color, rgba(255,255,255,0.15))',
                          background:
                            'var(--input-bg, rgba(255,255,255,0.05))',
                          color: 'var(--text-primary, #fff)',
                          fontSize: '0.82rem',
                          cursor:
                            !canEnrol || checklistBusy === item.id
                              ? 'not-allowed'
                              : 'pointer',
                          opacity: checklistBusy === item.id ? 0.6 : 1,
                        }}
                      >
                        {DOC_STATUSES.map((s) => (
                          <option key={s.value} value={s.value}>
                            {s.label}
                          </option>
                        ))}
                      </select>
                    </div>
                  ))}
                </div>
              </>
            )}

            {/* Add an ad-hoc document — works whether the checklist is empty
                (e.g. a self-serve applicant whose destination had no template)
                or already populated. The applicant then uploads against it. */}
            {canEnrol && (
              <form
                onSubmit={addChecklistItem}
                style={{
                  display: 'flex',
                  gap: 8,
                  alignItems: 'center',
                  flexWrap: 'wrap',
                  marginTop: 14,
                  paddingTop: 14,
                  borderTop:
                    '1px solid var(--border-color, rgba(255,255,255,0.08))',
                }}
              >
                <input
                  data-testid="add-doc-type"
                  type="text"
                  value={newDocType}
                  onChange={(e) => setNewDocType(e.target.value)}
                  placeholder="Add a document (e.g. Bank statement)"
                  style={{
                    flex: 1,
                    minWidth: 180,
                    padding: '0.4rem 0.6rem',
                    borderRadius: 6,
                    border:
                      '1px solid var(--border-color, rgba(255,255,255,0.15))',
                    background: 'var(--input-bg, rgba(255,255,255,0.05))',
                    color: 'var(--text-primary, #fff)',
                    fontSize: '0.85rem',
                  }}
                />
                <label
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: 6,
                    fontSize: '0.8rem',
                    color: 'var(--text-secondary, #94a3b8)',
                  }}
                >
                  <input
                    data-testid="add-doc-required"
                    type="checkbox"
                    checked={newDocRequired}
                    onChange={(e) => setNewDocRequired(e.target.checked)}
                  />
                  Required
                </label>
                <button
                  type="submit"
                  data-testid="add-doc-submit"
                  disabled={addingDoc}
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: 5,
                    padding: '0.4rem 0.8rem',
                    borderRadius: 6,
                    border: 'none',
                    background: 'var(--primary-color, var(--accent-color))',
                    color: '#fff',
                    fontWeight: 600,
                    fontSize: '0.82rem',
                    cursor: addingDoc ? 'wait' : 'pointer',
                    opacity: addingDoc ? 0.6 : 1,
                  }}
                >
                  <Plus size={14} /> {addingDoc ? 'Adding…' : 'Add document'}
                </button>
              </form>
            )}
          </section>
        </>
      )}
    </div>
  );
};

export default VisaAdvisorDashboard;
