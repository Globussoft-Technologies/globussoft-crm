/**
 * Visa Applications — Phase 3 list view + Create drawer (cluster B3, V8 SHIPPED).
 *
 * Graduates V8 from 🟡 PARTIAL (SHELL) → ✅ SHIPPED.
 * Backend GET endpoint at ce5f5db (/api/travel/visa/applications) returns
 * { applications, total, limit, offset } scoped to the caller's tenant
 * AND the tenant's travel contacts. Each row has the application + a
 * decorated { contact: {id, name, email, phone} } projection.
 *
 * Create flow (this commit — wires 6c084cb POST endpoint):
 *   - Header "+ Create Application" CTA (admin/manager visible).
 *   - Drawer with three required fields per the backend contract:
 *       contactId (Int)               — picked from the contact list
 *       applicationType (String enum) — one of VALID_APPLICATION_TYPES
 *       destinationCountry (String 1..200)
 *   - Submit → POST /api/travel/visa/applications → on 201: close drawer,
 *     refresh list, toast success. Backend error codes (MISSING_FIELDS /
 *     INVALID_APPLICATION_TYPE / NOT_FOUND / NOT_VISA_SURE) surface inline
 *     in the drawer + the global fetchApi toast.
 *
 * Contact picker fallback: backend /api/contacts does NOT support a
 * ?subBrand= filter today (routes/contacts.js:150 — only status /
 * assignedToId / unassigned / includeDeleted). We fetch with limit=200
 * and show the batch as-is. The drawer is a one-shot surface (open,
 * choose, close) so the 200-row ceiling is acceptable for now. If the
 * tenant needs server-side filtering later, that can be added without
 * changing the drawer contract.
 *
 * Render:
 *   - Header + Create CTA
 *   - Status filter dropdown (all / intake / docs-pending / filed /
 *     approved / rejected / appeal) — pinned to backend VALID_STATUSES,
 *     NOT the dispatch's prose list (the dispatch said "docs-collected"
 *     + "submitted" which the route validator rejects with 400 INVALID_STATUS).
 *   - Pagination (50 per page, prev/next)
 *   - Row table: ID | Contact | Type | Status badge |
 *     Risk pills (3: readiness / risk-flag / complex) | Updated
 *   - Empty state for tenants with no visa apps yet
 *   - Row-click navigates to /travel/visa/applications/:id (sibling
 *     agent wires the AdvisorDashboard detail page this same tick).
 *
 * Visual shape mirrors pages/travel/Itineraries.jsx (the canonical
 * Travel list page) for consistency with the rest of the vertical.
 */
import { useContext, useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { FileText, Filter, AlertTriangle, ShieldAlert, Layers, Plus, X } from 'lucide-react';
import { fetchApi } from '../../../utils/api';
import { useNotify } from '../../../utils/notify';
import { AuthContext } from '../../../App';
import TopScrollSync from '../../../components/TopScrollSync';

const PAGE_SIZE = 50;

// Pinned to backend VALID_STATUSES in routes/travel_visa.js (ce5f5db).
const STATUSES = [
  { value: '', label: 'All statuses' },
  { value: 'intake', label: 'Intake' },
  { value: 'docs-pending', label: 'Docs pending' },
  { value: 'filed', label: 'Filed' },
  { value: 'approved', label: 'Approved' },
  { value: 'rejected', label: 'Rejected' },
  { value: 'appeal', label: 'Appeal' },
];

// Pinned to backend VALID_APPLICATION_TYPES in routes/travel_visa.js
// (6c084cb). Six values per schema (prisma/schema.prisma:4502).
const APPLICATION_TYPES = [
  { value: 'tourist', label: 'Tourist' },
  { value: 'business', label: 'Business' },
  { value: 'student', label: 'Student' },
  { value: 'work', label: 'Work' },
  { value: 'umrah', label: 'Umrah' },
  { value: 'hajj', label: 'Hajj' },
];


const EMPTY_FORM = {
  contactId: '',
  applicantName: '',
  applicantEmail: '',
  applicantPhone: '',
  applicantBirthDate: '',
  tripId: '',
  participantId: '',
  applicationType: 'tourist',
  destinationCountry: '',
};

const STATUS_COLORS = {
  intake: { bg: 'rgba(120,120,120,0.12)', color: '#5C6E82' },
  'docs-pending': { bg: 'rgba(200,154,78,0.16)', color: '#9A6F2E' },
  filed: { bg: 'rgba(47,122,77,0.14)', color: '#2F7A4D' },
  approved: { bg: 'rgba(38,88,85,0.16)', color: '#265855' },
  rejected: { bg: 'rgba(168,50,63,0.14)', color: '#A8323F' },
  appeal: { bg: 'rgba(120,90,170,0.16)', color: '#6E4FA0' },
};

const READINESS_COLORS = {
  ready: { bg: 'rgba(47,122,77,0.14)', color: '#2F7A4D' },
  'partially-ready': { bg: 'rgba(200,154,78,0.16)', color: '#9A6F2E' },
  'not-ready': { bg: 'rgba(168,50,63,0.14)', color: '#A8323F' },
};

function fmt(d) {
  if (!d) return '—';
  return new Date(d).toLocaleDateString();
}

function formatTripLabel(trip) {
  if (!trip) return '';
  const code = trip.tripCode || `Trip #${trip.id}`;
  const destination = trip.destination ? ` - ${trip.destination}` : '';
  const depart = trip.departDate ? ` - ${new Date(trip.departDate).toLocaleDateString()}` : '';
  return `${code}${destination}${depart}`;
}

function normalizeMatchKey(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');
}

function normalizePhoneForMatch(value) {
  const digits = String(value || '').replace(/\D+/g, '');
  if (!digits) return '';
  return digits.length > 10 ? digits.slice(-10) : digits;
}

function resolveParticipantForContact(contact, participants) {
  if (!contact || !Array.isArray(participants) || participants.length === 0) return null;
  const contactName = normalizeMatchKey(contact.name);
  const contactEmail = normalizeMatchKey(contact.email);
  const contactPhone = normalizePhoneForMatch(contact.phone);

  const scored = participants
    .map((participant) => {
      const participantName = normalizeMatchKey(participant.fullName);
      const parentName = normalizeMatchKey(participant.parentName);
      const parentEmail = normalizeMatchKey(participant.parentEmail);
      const parentPhone = normalizePhoneForMatch(participant.parentPhone);

      let score = 0;
      if (contactName && participantName === contactName) score = Math.max(score, 4);
      if (contactName && parentName === contactName) score = Math.max(score, 3);
      if (contactEmail && parentEmail === contactEmail) score = Math.max(score, 2);
      if (contactPhone && parentPhone === contactPhone) score = Math.max(score, 2);

      return { participant, score };
    })
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score);

  if (scored.length === 0) {
    return participants.length === 1 ? participants[0] : null;
  }

  const topScore = scored[0].score;
  const topMatches = scored.filter((item) => item.score === topScore);
  return topMatches.length === 1 ? topMatches[0].participant : null;
}

function StatusBadge({ status }) {
  if (!status) return <span style={{ color: 'var(--text-secondary)' }}>—</span>;
  const sc = STATUS_COLORS[status] || { bg: 'var(--subtle-bg)', color: 'var(--text-secondary)' };
  return (
    <span
      style={{
        background: sc.bg,
        color: sc.color,
        padding: '2px 8px',
        borderRadius: 4,
        fontSize: 11,
        fontWeight: 600,
        textTransform: 'uppercase',
        letterSpacing: 0.5,
      }}
    >
      {status}
    </span>
  );
}

// 3 risk indicator pills: readinessLevel + advisorRiskFlag + complexCase.
// Each surfaces an independent dimension of operational risk on the row.
function RiskPills({ readinessLevel, advisorRiskFlag, complexCase }) {
  const pills = [];

  if (readinessLevel) {
    const rc = READINESS_COLORS[readinessLevel] || {
      bg: 'var(--subtle-bg)',
      color: 'var(--text-secondary)',
    };
    pills.push(
      <span
        key="readiness"
        title={`Readiness: ${readinessLevel}`}
        style={pillStyle(rc.bg, rc.color)}
      >
        <Layers size={10} /> {readinessLevel}
      </span>,
    );
  }

  if (advisorRiskFlag) {
    pills.push(
      <span
        key="risk"
        title="Advisor flagged as risky"
        style={pillStyle('rgba(168,50,63,0.14)', '#A8323F')}
      >
        <ShieldAlert size={10} /> risk
      </span>,
    );
  }

  if (complexCase) {
    pills.push(
      <span
        key="complex"
        title="Complex case (extra review)"
        style={pillStyle('rgba(120,90,170,0.16)', '#6E4FA0')}
      >
        <AlertTriangle size={10} /> complex
      </span>,
    );
  }

  if (pills.length === 0) return <span style={{ color: 'var(--text-secondary)' }}>—</span>;
  return <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>{pills}</div>;
}

function pillStyle(bg, color) {
  return {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 3,
    background: bg,
    color,
    padding: '2px 6px',
    borderRadius: 4,
    fontSize: 10,
    fontWeight: 600,
    textTransform: 'uppercase',
    letterSpacing: 0.4,
  };
}

export default function VisaApplications() {
  const notify = useNotify();
  const navigate = useNavigate();
  const { user } = useContext(AuthContext) || {};
  // Backend gates POST on ADMIN/MANAGER (routes/travel_visa.js:420).
  // Hide the CTA from USER role to avoid showing a button that will 403.
  const canCreate = user?.role === 'ADMIN' || user?.role === 'MANAGER';

  const [applications, setApplications] = useState([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  // Honor a ?status= deep-link (e.g. from the dashboard KPI tiles); ignore
  // unknown values so a bad URL just shows all.
  const [searchParams] = useSearchParams();
  const initialStatus = STATUSES.some((s) => s.value && s.value === searchParams.get('status'))
    ? searchParams.get('status')
    : '';
  const [status, setStatus] = useState(initialStatus);
  const [offset, setOffset] = useState(0);

  // Create-drawer state.
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState(EMPTY_FORM);
  const [saving, setSaving] = useState(false);
  const [contacts, setContacts] = useState([]);
  const [contactsLoading, setContactsLoading] = useState(false);
  const [trips, setTrips] = useState([]);
  const [tripsLoading, setTripsLoading] = useState(false);
  const [participants, setParticipants] = useState([]);
  const [participantsLoading, setParticipantsLoading] = useState(false);
  // Field-level error map keyed by code so the drawer can surface
  // backend validation feedback inline ("destinationCountry is
  // required" / "contact is required").
  const [formError, setFormError] = useState(null);

  const load = () => {
    setLoading(true);
    const qs = new URLSearchParams();
    if (status) qs.set('status', status);
    qs.set('limit', String(PAGE_SIZE));
    qs.set('offset', String(offset));
    fetchApi(`/api/travel/visa/applications?${qs.toString()}`)
      .then((res) => {
        setApplications(Array.isArray(res?.applications) ? res.applications : []);
        setTotal(Number(res?.total) || 0);
      })
      .catch((e) => {
        notify.error(e?.body?.error || 'Failed to load visa applications');
        setApplications([]);
        setTotal(0);
      })
      .finally(() => setLoading(false));
  };

  // Reload whenever filter or page changes.
  useEffect(load, [status, offset]); // eslint-disable-line react-hooks/exhaustive-deps

  // Reset offset to 0 when status filter changes so we don't land on an
  // empty page after a narrowing filter.
  const onStatusChange = (v) => {
    setStatus(v);
    setOffset(0);
  };

  const openCreate = () => {
    setForm(EMPTY_FORM);
    setFormError(null);
    setCreating(true);
    // Backend /api/contacts doesn't support ?subBrand= today; fetch a
    // batch and filter client-side. See module header for follow-up note.
    setContactsLoading(true);
    fetchApi('/api/contacts?limit=200')
      .then((res) => {
        const list = Array.isArray(res) ? res : (res?.contacts || []);
        setContacts(list);
      })
      .catch(() => setContacts([]))
      .finally(() => setContactsLoading(false));
    setTripsLoading(true);
    fetchApi('/api/travel/trips?fields=summary&limit=200', { silent: true })
      .then((res) => {
        setTrips(Array.isArray(res?.trips) ? res.trips : []);
      })
      .catch(() => setTrips([]))
      .finally(() => setTripsLoading(false));
  };

  const closeDrawer = () => {
    setCreating(false);
    setFormError(null);
  };

  const selectedContact = form.contactId
    ? contacts.find((c) => String(c.id) === String(form.contactId)) || null
    : null;
  const selectedTrip = form.tripId
    ? trips.find((t) => String(t.id) === String(form.tripId)) || null
    : null;
  const selectedParticipant = form.participantId
    ? participants.find((p) => String(p.id) === String(form.participantId)) || null
    : null;
  const inferredParticipant = !selectedParticipant
    ? resolveParticipantForContact(selectedContact, participants)
    : null;
  const resolvedParticipant = selectedParticipant || inferredParticipant;
  const needsParticipantChoice = Boolean(form.tripId) && !resolvedParticipant;

  const onContactChange = (value) => {
    const contact = contacts.find((c) => String(c.id) === String(value));
    setForm({
      ...form,
      contactId: value,
      applicantName: contact?.name || '',
      applicantEmail: contact?.email || '',
      applicantPhone: contact?.phone || '',
      applicantBirthDate: contact?.birthDate ? String(contact.birthDate).slice(0, 10) : '',
      participantId: form.tripId ? String(resolveParticipantForContact(contact, participants)?.id || '') : '',
    });
    if (formError?.field === 'contactId') setFormError(null);
  };

  const onTripChange = (value) => {
    const trip = trips.find((t) => String(t.id) === String(value));
    setForm({
      ...form,
      tripId: value,
      participantId: '',
      destinationCountry: trip?.destination || form.destinationCountry,
    });
    setParticipants([]);
    if (formError?.field === 'tripId' || formError?.field === 'participantId') setFormError(null);
  };

  useEffect(() => {
    if (!creating || !form.tripId) {
      setParticipants([]);
      return undefined;
    }
    let cancelled = false;
    setParticipantsLoading(true);
    fetchApi(`/api/travel/trips/${form.tripId}`, { silent: true })
      .then((res) => {
        if (cancelled) return;
        const rows = Array.isArray(res?.participants) ? res.participants : [];
        setParticipants(rows);
        const autoParticipant = resolveParticipantForContact(selectedContact, rows);
        if (autoParticipant) {
          setForm((prev) => (
            String(prev.tripId) === String(form.tripId)
              ? { ...prev, participantId: String(autoParticipant.id) }
              : prev
          ));
        }
      })
      .catch(() => {
        if (!cancelled) setParticipants([]);
      })
      .finally(() => {
        if (!cancelled) setParticipantsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [creating, form.tripId, selectedContact?.id]);

  const submitCreate = async (e) => {
    e.preventDefault();
    setFormError(null);

    // Client-side gates that mirror the backend's MISSING_FIELDS /
    // INVALID_DESTINATION checks so the user sees the error before the
    // round-trip. Backend is still the source of truth.
    if (!form.contactId && !(form.applicantName || '').trim()) {
      setFormError({ field: 'contactId', message: 'Pick a contact or enter a new applicant name' });
      return;
    }
    if (!form.applicationType) {
      setFormError({ field: 'applicationType', message: 'Application type is required' });
      return;
    }
    if (!form.tripId) {
      setFormError({ field: 'tripId', message: 'Trip is required' });
      return;
    }
    if (!form.participantId) {
      setFormError({ field: 'participantId', message: 'Participant is required' });
      return;
    }
    const dest = (form.destinationCountry || '').trim();
    if (!dest) {
      setFormError({ field: 'destinationCountry', message: 'Destination country is required' });
      return;
    }
    if (dest.length > 200) {
      setFormError({ field: 'destinationCountry', message: 'Destination country must be at most 200 characters' });
      return;
    }

    setSaving(true);
    try {
      const body = {
        applicationType: form.applicationType,
        destinationCountry: dest,
      };
      if (form.contactId) {
        body.contactId = parseInt(form.contactId, 10);
      } else {
        body.applicantName = (form.applicantName || '').trim();
        if ((form.applicantEmail || '').trim()) body.applicantEmail = form.applicantEmail.trim();
        if ((form.applicantPhone || '').trim()) body.applicantPhone = form.applicantPhone.trim();
        if (form.applicantBirthDate) body.applicantBirthDate = form.applicantBirthDate;
      }
      body.tripId = parseInt(form.tripId, 10);
      body.participantId = parseInt(form.participantId, 10);
      await fetchApi('/api/travel/visa/applications', {
        method: 'POST',
        body: JSON.stringify(body),
        // Suppress the global fetchApi toast — we render inline + raise
        // our own targeted success/error toast in this flow.
        silent: true,
      });
      notify.success('Visa application created');
      closeDrawer();
      // Jump back to the first page so the new row (ordered by
      // createdAt desc) is visible without paginating.
      setOffset(0);
      // If we're already on page 0, useEffect won't re-fire — call load
      // explicitly to refresh.
      if (offset === 0) load();
    } catch (err) {
      // Map backend error codes (routes/travel_visa.js:411-417) to a
      // field-targeted inline message so the drawer guides the user
      // without losing their other inputs.
      const code = err?.code || err?.data?.code;
      const backendMsg = err?.data?.error || err?.message || 'Failed to create application';
      let field = null;
      switch (code) {
        case 'MISSING_FIELDS':
          // Backend's MISSING_FIELDS error text names the offending
          // field; surface the message directly without picking one.
          field = null;
          break;
        case 'INVALID_APPLICATION_TYPE':
          field = 'applicationType';
          break;
        case 'INVALID_DESTINATION':
          field = 'destinationCountry';
          break;
        case 'INVALID_TRIP_ID':
        case 'TRIP_NOT_FOUND':
          field = 'tripId';
          break;
        case 'INVALID_PARTICIPANT_ID':
        case 'PARTICIPANT_NOT_FOUND':
          field = 'participantId';
          break;
        case 'NOT_FOUND':
        case 'NOT_VISA_SURE':
          field = 'contactId';
          break;
        case 'INVALID_EMAIL':
          field = 'applicantEmail';
          break;
        case 'INVALID_PHONE':
          field = 'applicantPhone';
          break;
        case 'INVALID_BIRTHDATE':
          field = 'applicantBirthDate';
          break;
        default:
          field = null;
      }
      setFormError({ field, code: code || null, message: backendMsg });
      notify.error(backendMsg);
    } finally {
      setSaving(false);
    }
  };

  const hasPrev = offset > 0;
  const hasNext = offset + PAGE_SIZE < total;
  const pageStart = total === 0 ? 0 : offset + 1;
  const pageEnd = Math.min(offset + PAGE_SIZE, total);

  return (
    <div style={{ padding: 24, maxWidth: 1200, margin: '0 auto' }}>
      <header
        style={{
          marginBottom: 4,
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'flex-start',
          flexWrap: 'wrap',
          gap: 12,
        }}
      >
        <div>
          <h1
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 10,
              margin: 0,
              marginBottom: 4,
            }}
          >
            <FileText size={28} aria-hidden /> Visa Applications
          </h1>
          <p style={{ color: 'var(--text-secondary)', marginTop: 0 }}>
            All visa applications across your tenant. Click a row to open the
            advisor dashboard with diagnostic answers, document checklist, and risk
            indicators.
          </p>
        </div>
        {canCreate && (
          <button
            type="button"
            onClick={openCreate}
            style={primaryBtn}
            aria-label="Create a new visa application"
          >
            <Plus size={14} /> Create Application
          </button>
        )}
      </header>

      <div
        style={{
          display: 'flex',
          gap: 12,
          flexWrap: 'wrap',
          alignItems: 'center',
          background: 'var(--surface-color)',
          padding: 12,
          borderRadius: 8,
          border: '1px solid var(--border-color)',
          marginBottom: 16,
        }}
      >
        <Filter
          size={16}
          aria-hidden
          style={{ color: 'var(--text-secondary)' }}
        />
        <select
          value={status}
          onChange={(e) => onStatusChange(e.target.value)}
          style={selectStyle}
          aria-label="Filter by status"
        >
          {STATUSES.map((s) => (
            <option key={s.value} value={s.value}>
              {s.label}
            </option>
          ))}
        </select>
        <button
          type="button"
          onClick={load}
          style={refreshBtn}
          aria-label="Reload list"
        >
          Refresh
        </button>
        <div
          style={{
            marginLeft: 'auto',
            fontSize: 12,
            color: 'var(--text-secondary)',
          }}
        >
          {total > 0
            ? `Showing ${pageStart}–${pageEnd} of ${total}`
            : loading
              ? 'Loading…'
              : 'No results'}
        </div>
      </div>

      <div
        style={{
          background: 'var(--surface-color)',
          borderRadius: 8,
          border: '1px solid var(--border-color)',
          overflow: 'visible',
        }}
      >
        {loading ? (
          <div style={empty}>Loading&hellip;</div>
        ) : applications.length === 0 ? (
          <div style={empty}>
            No visa applications yet. Applications appear here once
            contacts in your tenant have applications
            created in the system.
          </div>
        ) : (
          <TopScrollSync>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr>
                <th style={th}>ID</th>
                <th style={th}>Contact</th>
                <th style={th}>Type</th>
                <th style={th}>Status</th>
                <th style={th}>Risk indicators</th>
                <th style={th}>Updated</th>
              </tr>
            </thead>
            <tbody>
              {applications.map((a) => (
                <tr
                  key={a.id}
                  onClick={() => navigate(`/travel/visa/applications/${a.id}`)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      navigate(`/travel/visa/applications/${a.id}`);
                    }
                  }}
                  tabIndex={0}
                  role="button"
                  aria-label={`Open visa application ${a.id}`}
                  style={{
                    borderTop: '1px solid var(--border-light)',
                    cursor: 'pointer',
                  }}
                >
                  <td style={td}>
                    <strong>#{a.id}</strong>
                  </td>
                  <td style={td}>
                    {a.contact?.name
                      || a.contact?.email
                      || (a.contactId ? `Contact #${a.contactId}` : '—')}
                    {a.destinationCountry && (
                      <div
                        style={{
                          fontSize: 11,
                          color: 'var(--text-secondary)',
                          marginTop: 2,
                        }}
                      >
                        → {a.destinationCountry}
                      </div>
                    )}
                  </td>
                  <td style={td}>{a.applicationType || '—'}</td>
                  <td style={td}>
                    <StatusBadge status={a.status} />
                  </td>
                  <td style={td}>
                    <RiskPills
                      readinessLevel={a.readinessLevel}
                      advisorRiskFlag={a.advisorRiskFlag}
                      complexCase={a.complexCase}
                    />
                  </td>
                  <td style={td}>{fmt(a.updatedAt || a.createdAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          </TopScrollSync>
        )}
      </div>

      {total > PAGE_SIZE && (
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            marginTop: 16,
          }}
        >
          <button
            type="button"
            onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}
            disabled={!hasPrev}
            style={hasPrev ? refreshBtn : { ...refreshBtn, opacity: 0.4, cursor: 'not-allowed' }}
            aria-label="Previous page"
          >
            ← Prev
          </button>
          <div style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
            Page {Math.floor(offset / PAGE_SIZE) + 1} of {Math.max(1, Math.ceil(total / PAGE_SIZE))}
          </div>
          <button
            type="button"
            onClick={() => setOffset(offset + PAGE_SIZE)}
            disabled={!hasNext}
            style={hasNext ? refreshBtn : { ...refreshBtn, opacity: 0.4, cursor: 'not-allowed' }}
            aria-label="Next page"
          >
            Next →
          </button>
        </div>
      )}

      {creating && (
        <div
          onClick={(e) => { if (e.target === e.currentTarget) closeDrawer(); }}
          role="presentation"
          style={{
            position: 'fixed',
            inset: 0,
            background: 'rgba(0,0,0,0.75)',
            backdropFilter: 'blur(4px)',
            WebkitBackdropFilter: 'blur(4px)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 1000,
            padding: '1rem',
          }}
        >
          <form
            onSubmit={submitCreate}
            className="card"
            style={drawerStyle}
            aria-labelledby="visa-create-drawer-title"
          >
            <div
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                marginBottom: 16,
              }}
            >
              <h2
                id="visa-create-drawer-title"
                style={{ margin: 0, fontSize: 18, fontWeight: 600 }}
              >
                New Visa Application
              </h2>
              <button
                type="button"
                onClick={closeDrawer}
                aria-label="Close"
                style={iconBtn}
              >
                <X size={16} />
              </button>
            </div>

            <p
              style={{
                margin: 0,
                marginBottom: 16,
                fontSize: 12,
                color: 'var(--text-secondary)',
              }}
            >
              Creates an application in <strong>intake</strong> state. You can select an existing contact or enter a new applicant here and the CRM will create or reuse the contact automatically.</p>

            {formError && !formError.field && (
              <div style={errorBanner} role="alert">
                {formError.message}
                {formError.code && (
                  <span style={{ marginLeft: 6, opacity: 0.7, fontSize: 11 }}>
                    [{formError.code}]
                  </span>
                )}
              </div>
            )}

            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              <label style={fieldLabel}>
                Contact
                <select
                  value={form.contactId}
                  onChange={(e) => onContactChange(e.target.value)}
                  style={inputStyle}
                  aria-invalid={formError?.field === 'contactId' ? 'true' : undefined}
                >
                  <option value="">
                    {contactsLoading
                      ? 'Loading contacts...'
                      : contacts.length === 0
                        ? '(no contacts found)'
                        : 'Create new applicant manually'}
                  </option>
                  {contacts.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name || c.email || `Contact #${c.id}`}
                      {c.email ? ` - ${c.email}` : ''}
                    </option>
                  ))}
                </select>
                {formError?.field === 'contactId' && (
                  <span style={fieldErrorText} role="alert">
                    {formError.message}
                  </span>
                )}
                {!contactsLoading && contacts.length === 0 && (
                  <span style={fieldHintText}>
                    No contacts were returned in the most recent 200. You can still continue by entering the applicant details below.
                  </span>
                )}
              </label>

              {selectedContact ? (
                <div
                  data-testid="selected-contact-summary"
                  style={{
                    padding: '10px 12px',
                    borderRadius: 8,
                    border: '1px solid var(--border-color)',
                    background: 'var(--subtle-bg)',
                    display: 'grid',
                    gap: 4,
                    fontSize: 12,
                    color: 'var(--text-secondary)',
                  }}
                >
                  <strong style={{ color: 'var(--text-primary)' }}>
                    Using existing contact details
                  </strong>
                  <span>{selectedContact.name || `Contact #${selectedContact.id}`}</span>
                  {selectedContact.email && <span>{selectedContact.email}</span>}
                  {selectedContact.phone && <span>{selectedContact.phone}</span>}
                </div>
              ) : (
                <div
                  style={{
                    padding: '10px 12px',
                    borderRadius: 8,
                    border: '1px solid var(--border-color)',
                    background: 'var(--subtle-bg)',
                    display: 'grid',
                    gap: 12,
                  }}
                >
                  <div style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
                    New applicant details
                  </div>
                  <label style={fieldLabel}>
                    Applicant name
                    <input
                      type="text"
                      value={form.applicantName}
                      onChange={(e) => setForm({ ...form, applicantName: e.target.value })}
                      style={inputStyle}
                      placeholder="Enter name for a new applicant"
                    />
                  </label>
                  <label style={fieldLabel}>
                    Applicant email
                    <input
                      type="email"
                      value={form.applicantEmail}
                      onChange={(e) => setForm({ ...form, applicantEmail: e.target.value })}
                      style={inputStyle}
                      placeholder="Optional"
                    />
                  </label>
                  <label style={fieldLabel}>
                    Applicant phone
                    <input
                      type="text"
                      value={form.applicantPhone}
                      onChange={(e) => setForm({ ...form, applicantPhone: e.target.value })}
                      style={inputStyle}
                      placeholder="Optional"
                    />
                  </label>
                  <label style={fieldLabel}>
                    Applicant date of birth
                    <input
                      type="date"
                      value={form.applicantBirthDate}
                      onChange={(e) => setForm({ ...form, applicantBirthDate: e.target.value })}
                      style={inputStyle}
                    />
                  </label>
                </div>
              )}

              <label style={fieldLabel}>
                Trip
                <select
                  data-testid="create-trip-select"
                  value={form.tripId}
                  onChange={(e) => onTripChange(e.target.value)}
                  style={inputStyle}
                  aria-invalid={formError?.field === 'tripId' ? 'true' : undefined}
                >
                  <option value="">
                    {tripsLoading
                      ? 'Loading trips...'
                      : trips.length === 0
                        ? '(no trips found)'
                        : 'Select a trip'}
                  </option>
                  {trips.map((trip) => (
                    <option key={trip.id} value={trip.id}>
                      {formatTripLabel(trip)}
                    </option>
                  ))}
                </select>
                {formError?.field === 'tripId' && (
                  <span style={fieldErrorText} role="alert">
                    {formError.message}
                  </span>
                )}
              </label>

              {selectedTrip && (
                <div
                  style={{
                    padding: '8px 10px',
                    borderRadius: 8,
                    background: 'var(--subtle-bg)',
                    color: 'var(--text-secondary)',
                    fontSize: 12,
                  }}
                >
                  Destination will default to <strong>{selectedTrip.destination || 'the selected trip destination'}</strong>.
                </div>
              )}

              <label style={fieldLabel}>
                Participant
                {needsParticipantChoice ? (
                  <select
                    data-testid="create-participant-select"
                    value={form.participantId}
                    onChange={(e) => setForm({ ...form, participantId: e.target.value })}
                    style={inputStyle}
                    disabled={!form.tripId || participantsLoading}
                    aria-invalid={formError?.field === 'participantId' ? 'true' : undefined}
                  >
                    <option value="">
                      {!form.tripId
                        ? 'Select a trip first'
                        : participantsLoading
                          ? 'Loading participants...'
                          : participants.length === 0
                            ? '(no participants found)'
                            : 'Select a participant'}
                    </option>
                    {participants.map((participant) => (
                      <option key={participant.id} value={participant.id}>
                        {participant.fullName || `Participant #${participant.id}`}
                      </option>
                    ))}
                  </select>
                ) : (
                  <div
                    data-testid="selected-participant-summary"
                    style={{
                      padding: '10px 12px',
                      borderRadius: 8,
                      border: '1px solid var(--border-color)',
                      background: 'var(--subtle-bg)',
                      display: 'grid',
                      gap: 4,
                      fontSize: 12,
                      color: 'var(--text-secondary)',
                    }}
                  >
                    <strong style={{ color: 'var(--text-primary)' }}>
                      {resolvedParticipant
                        ? 'Using matching participant details'
                        : 'Participant will be chosen after a trip is selected'}
                    </strong>
                    {resolvedParticipant ? (
                      <span>{resolvedParticipant.fullName || `Participant #${resolvedParticipant.id}`}</span>
                    ) : (
                      <span>Select a trip to auto-fill the participant.</span>
                    )}
                    {resolvedParticipant && (
                      <span style={{ fontSize: 11, opacity: 0.82 }}>
                        The advisor can still change the participant later if needed.
                      </span>
                    )}
                  </div>
                )}
                {formError?.field === 'participantId' && (
                  <span style={fieldErrorText} role="alert">
                    {formError.message}
                  </span>
                )}
              </label>

              <label style={fieldLabel}>
                Application type
                <select
                  value={form.applicationType}
                  onChange={(e) => setForm({ ...form, applicationType: e.target.value })}
                  style={inputStyle}
                  aria-invalid={formError?.field === 'applicationType' ? 'true' : undefined}
                  required
                >
                  {APPLICATION_TYPES.map((t) => (
                    <option key={t.value} value={t.value}>
                      {t.label}
                    </option>
                  ))}
                </select>
                {formError?.field === 'applicationType' && (
                  <span style={fieldErrorText} role="alert">
                    {formError.message}
                  </span>
                )}
              </label>

              <label style={fieldLabel}>
                Destination country
                <input
                  type="text"
                  value={form.destinationCountry}
                  onChange={(e) => setForm({ ...form, destinationCountry: e.target.value })}
                  style={inputStyle}
                  placeholder='e.g. "United Kingdom", "Saudi Arabia", "Canada"'
                  maxLength={200}
                  aria-invalid={formError?.field === 'destinationCountry' ? 'true' : undefined}
                  required
                />
                {formError?.field === 'destinationCountry' && (
                  <span style={fieldErrorText} role="alert">
                    {formError.message}
                  </span>
                )}
              </label>
            </div>

            <div
              style={{
                display: 'flex',
                justifyContent: 'flex-end',
                gap: 8,
                marginTop: 20,
              }}
            >
              <button type="button" onClick={closeDrawer} style={refreshBtn}>
                Cancel
              </button>
              <button type="submit" disabled={saving} style={primaryBtn}>
                {saving ? 'Creating...' : 'Create Application'}
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}

const selectStyle = {
  padding: '6px 10px',
  borderRadius: 6,
  border: '1px solid var(--border-color)',
  background: 'var(--surface-color)',
  color: 'var(--text-primary)',
  minWidth: 160,
  fontSize: 13,
};

const refreshBtn = {
  padding: '6px 12px',
  borderRadius: 6,
  border: '1px solid var(--border-color)',
  background: 'var(--surface-color)',
  color: 'var(--text-primary)',
  fontSize: 13,
  cursor: 'pointer',
};

const primaryBtn = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 6,
  padding: '6px 12px',
  borderRadius: 6,
  fontWeight: 600,
  fontSize: 13,
  background: 'var(--primary-color, var(--accent-color))',
  color: 'var(--accent-text, #fff)',
  border: '1px solid var(--primary-color, var(--accent-color))',
  cursor: 'pointer',
};

// Centred modal — mirrors the travel/Leads.jsx New Travel Lead pattern.
// `.card` (set on the form element) supplies border-radius, border, blur
// and lifted shadow; we force opaque `--bg-color` here so the panel
// doesn't read as glassmorphic over the page content behind it.
const drawerStyle = {
  background: 'var(--bg-color)',
  color: 'var(--text-primary)',
  width: '100%',
  maxWidth: 480,
  maxHeight: '90vh',
  overflowY: 'auto',
  padding: 24,
};

const iconBtn = {
  background: 'transparent',
  border: 'none',
  color: 'var(--text-secondary)',
  cursor: 'pointer',
  padding: 4,
};

const fieldLabel = {
  display: 'flex',
  flexDirection: 'column',
  gap: 4,
  fontSize: 12,
  color: 'var(--text-secondary)',
  fontWeight: 500,
};

const inputStyle = {
  padding: '8px 10px',
  borderRadius: 6,
  border: '1px solid var(--border-color)',
  background: 'var(--input-bg, var(--surface-color))',
  color: 'var(--text-primary)',
  fontSize: 14,
};

const errorBanner = {
  padding: '8px 12px',
  borderRadius: 6,
  background: 'rgba(168,50,63,0.10)',
  border: '1px solid rgba(168,50,63,0.35)',
  color: '#A8323F',
  fontSize: 13,
  marginBottom: 16,
};

const fieldErrorText = {
  color: '#A8323F',
  fontSize: 11,
  fontWeight: 500,
  marginTop: 2,
};

const fieldHintText = {
  color: 'var(--text-secondary)',
  fontSize: 11,
  marginTop: 2,
  fontStyle: 'italic',
};

const empty = {
  padding: 32,
  textAlign: 'center',
  color: 'var(--text-secondary)',
  fontSize: 14,
};

const th = {
  textAlign: 'left',
  padding: '10px 12px',
  fontSize: 12,
  textTransform: 'uppercase',
  letterSpacing: 0.5,
  color: 'var(--text-secondary)',
  borderBottom: '1px solid var(--border-color)',
  background: 'var(--subtle-bg)',
};

const td = {
  padding: '10px 12px',
  fontSize: 14,
  color: 'var(--text-primary)',
};



