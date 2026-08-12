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
 *   - Compact filter bar: contact search + Refresh + single Filters
 *     button. The Filters popover holds status, application type, and
 *     created date range controls, pinned to backend VALID_STATUSES /
 *     VALID_APPLICATION_TYPES.
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
import { useContext, useEffect, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { FileText, Filter, Search, AlertTriangle, ShieldAlert, Layers, Plus, X, Calendar, ChevronLeft, ChevronRight } from 'lucide-react';
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

function toStartOfDayIso(value) {
  if (!value) return '';
  const date = new Date(`${value}T00:00:00`);
  return Number.isNaN(date.getTime()) ? '' : date.toISOString();
}

function toEndOfDayIso(value) {
  if (!value) return '';
  const date = new Date(`${value}T23:59:59.999`);
  return Number.isNaN(date.getTime()) ? '' : date.toISOString();
}

function parseIsoDate(value) {
  if (!value) return null;
  const parsed = new Date(`${value}T00:00:00`);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function toYmd(date) {
  if (!date) return '';
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function sameDay(a, b) {
  return Boolean(a && b)
    && a.getFullYear() === b.getFullYear()
    && a.getMonth() === b.getMonth()
    && a.getDate() === b.getDate();
}

function isBetweenDates(day, start, end) {
  if (!start || !end) return false;
  const t = day.getTime();
  return t > Math.min(start.getTime(), end.getTime()) && t < Math.max(start.getTime(), end.getTime());
}

function buildMonthGrid(year, month) {
  const first = new Date(year, month, 1);
  const startOffset = first.getDay();
  const gridStart = new Date(year, month, 1 - startOffset);
  const days = [];
  for (let i = 0; i < 42; i += 1) {
    days.push(new Date(gridStart.getFullYear(), gridStart.getMonth(), gridStart.getDate() + i));
  }
  return days;
}

function formatDateLabel(value) {
  const date = parseIsoDate(value);
  if (!date) return '';
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

function formatDateRangeLabel(from, to) {
  if (!from && !to) return 'Custom date range';
  if (from && to && from === to) return formatDateLabel(from);
  if (from && to) return `${formatDateLabel(from)} - ${formatDateLabel(to)}`;
  return formatDateLabel(from || to);
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

function VisaDateRangePicker({ fromDate, toDate, onChange }) {
  const [open, setOpen] = useState(false);
  const committedFrom = parseIsoDate(fromDate);
  const committedTo = parseIsoDate(toDate);
  const [draftFrom, setDraftFrom] = useState(committedFrom);
  const [draftTo, setDraftTo] = useState(committedTo);
  const [viewYear, setViewYear] = useState((committedFrom || new Date()).getFullYear());
  const [viewMonth, setViewMonth] = useState((committedFrom || new Date()).getMonth());

  useEffect(() => {
    if (!open) return undefined;
    setDraftFrom(committedFrom);
    setDraftTo(committedTo);
    if (committedFrom) {
      setViewYear(committedFrom.getFullYear());
      setViewMonth(committedFrom.getMonth());
    }
    const onKey = (e) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
    };
  }, [open, committedFrom, committedTo]);

  const monthLabel = new Date(viewYear, viewMonth, 1).toLocaleDateString(undefined, {
    month: 'long',
    year: 'numeric',
  });
  const nextMonth = new Date(viewYear, viewMonth + 1, 1);
  const displayLabel = formatDateRangeLabel(fromDate, toDate);
  const canSave = Boolean(draftFrom && draftTo);

  const goMonth = (delta) => {
    const next = new Date(viewYear, viewMonth + delta, 1);
    setViewYear(next.getFullYear());
    setViewMonth(next.getMonth());
  };

  const pickDay = (day) => {
    if (!draftFrom || draftTo) {
      setDraftFrom(day);
      setDraftTo(null);
      return;
    }
    if (sameDay(day, draftFrom)) {
      setDraftTo(day);
      return;
    }
    if (day < draftFrom) {
      setDraftFrom(day);
      setDraftTo(draftFrom);
      return;
    }
    setDraftTo(day);
  };

  const save = () => {
    if (!draftFrom || !draftTo) return;
    onChange({
      from: toYmd(draftFrom),
      to: toYmd(draftTo),
    });
    setOpen(false);
  };

  const clear = () => {
    onChange({ from: '', to: '' });
  };

  const renderMonth = (monthDate) => {
    const days = buildMonthGrid(monthDate.getFullYear(), monthDate.getMonth());
    return (
      <div key={monthDate.toISOString()} style={{ marginTop: 12 }}>
        <div style={{ fontWeight: 600, textAlign: 'center', marginBottom: 8 }}>
          {monthDate.toLocaleDateString(undefined, { month: 'long', year: 'numeric' })}
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: 2, marginBottom: 4 }}>
          {['S', 'M', 'T', 'W', 'T', 'F', 'S'].map((day, index) => (
            <div
              key={`${day}-${index}`}
              style={{
                textAlign: 'center',
                fontSize: 11,
                color: 'var(--text-secondary)',
                padding: '2px 0',
              }}
            >
              {day}
            </div>
          ))}
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: 2 }}>
          {days.map((day) => {
            const inMonth = day.getMonth() === monthDate.getMonth();
            const isStart = sameDay(day, draftFrom);
            const isEnd = sameDay(day, draftTo);
            const inRange = isBetweenDates(day, draftFrom, draftTo) && !isStart && !isEnd;
            return (
              <button
                key={day.toISOString()}
                type="button"
                aria-label={toYmd(day)}
                onClick={() => pickDay(day)}
                disabled={!inMonth}
                style={{
                  padding: '6px 0',
                  fontSize: 13,
                  border: 'none',
                  borderRadius: isStart || isEnd ? 999 : 6,
                  background: isStart || isEnd
                    ? 'var(--primary-color, var(--accent-color))'
                    : inRange
                      ? 'rgba(68, 74, 214, 0.12)'
                      : 'transparent',
                  color: !inMonth
                    ? 'var(--text-secondary)'
                    : isStart || isEnd
                      ? '#fff'
                      : 'var(--text-primary)',
                  opacity: inMonth ? 1 : 0.35,
                  cursor: inMonth ? 'pointer' : 'default',
                }}
              >
                {day.getDate()}
              </button>
            );
          })}
        </div>
      </div>
    );
  };

  return (
    <div style={{ position: 'relative' }}>
      <button
        type="button"
        onClick={() => setOpen(true)}
        style={{
          ...panelFieldButton,
          justifyContent: 'space-between',
          paddingRight: fromDate || toDate ? 30 : undefined,
        }}
        aria-haspopup="dialog"
        aria-expanded={open}
      >
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
          <Calendar size={14} style={{ flexShrink: 0, color: 'var(--text-secondary)' }} />
          <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {displayLabel}
          </span>
        </span>
      </button>
      {fromDate || toDate ? (
        <button
          type="button"
          onClick={clear}
          aria-label="Clear date range"
          style={{
            position: 'absolute',
            right: 8,
            top: '50%',
            transform: 'translateY(-50%)',
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            color: 'var(--text-secondary)',
            background: 'transparent',
            border: 'none',
            padding: 2,
            cursor: 'pointer',
          }}
        >
          <X size={12} />
        </button>
      ) : null}

      {open && (
        <div
          role="dialog"
          aria-label="Select date range"
          style={dateModalOverlayStyle}
          onClick={() => setOpen(false)}
        >
          <div
            style={dateModalStyle}
            onClick={(e) => e.stopPropagation()}
          >
            <div style={dateModalHeaderStyle}>
              <button
                type="button"
                onClick={() => setOpen(false)}
                aria-label="Close date range picker"
                style={iconOnlyButtonStyle}
              >
                <X size={18} />
              </button>
              <button
                type="button"
                onClick={save}
                disabled={!canSave}
                style={{
                  ...textActionButtonStyle,
                  cursor: canSave ? 'pointer' : 'not-allowed',
                  opacity: canSave ? 1 : 0.4,
                }}
              >
                Save
              </button>
            </div>

            <div style={{ marginBottom: 14 }}>
              <div style={{ fontSize: 18, fontWeight: 600, marginBottom: 4 }}>
                Select range
              </div>
              <div style={{ color: 'var(--text-secondary)', fontSize: 14 }}>
                {displayLabel}
              </div>
            </div>

            <div style={dateNavRowStyle}>
              <button type="button" onClick={() => goMonth(-1)} aria-label="Previous month" style={navButtonStyle}>
                <ChevronLeft size={16} />
              </button>
              <div style={{ flex: 1, textAlign: 'center', fontWeight: 600, fontSize: 14 }}>
                {monthLabel}
              </div>
              <button type="button" onClick={() => goMonth(1)} aria-label="Next month" style={navButtonStyle}>
                <ChevronRight size={16} />
              </button>
            </div>

            {renderMonth(new Date(viewYear, viewMonth, 1))}
            {renderMonth(nextMonth)}
          </div>
        </div>
      )}
    </div>
  );
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
  const [applicationType, setApplicationType] = useState('');
  const [search, setSearch] = useState('');
  const [fromDate, setFromDate] = useState('');
  const [toDate, setToDate] = useState('');
  const [offset, setOffset] = useState(0);
  const [showFilters, setShowFilters] = useState(false);
  const filterWrapRef = useRef(null);

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
    if (applicationType) qs.set('applicationType', applicationType);
    const trimmedSearch = search.trim();
    if (trimmedSearch) qs.set('search', trimmedSearch);
    const fromIso = toStartOfDayIso(fromDate);
    if (fromIso) qs.set('from', fromIso);
    const toIso = toEndOfDayIso(toDate);
    if (toIso) qs.set('to', toIso);
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
  useEffect(load, [status, applicationType, search, fromDate, toDate, offset]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!showFilters) return undefined;
    const onMouseDown = (event) => {
      if (filterWrapRef.current && !filterWrapRef.current.contains(event.target)) {
        setShowFilters(false);
      }
    };
    const onKeyDown = (event) => {
      if (event.key === 'Escape') setShowFilters(false);
    };
    document.addEventListener('mousedown', onMouseDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onMouseDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [showFilters]);

  // Reset offset to 0 when status filter changes so we don't land on an
  // empty page after a narrowing filter.
  const onStatusChange = (v) => {
    setStatus(v);
    setOffset(0);
  };

  const onApplicationTypeChange = (v) => {
    setApplicationType(v);
    setOffset(0);
  };

  const onSearchChange = (v) => {
    setSearch(v);
    setOffset(0);
  };

  const onDateRangeChange = ({ from, to }) => {
    setFromDate(from || '');
    setToDate(to || '');
    setOffset(0);
  };

  const clearAllFilters = () => {
    setStatus('');
    setApplicationType('');
    setSearch('');
    setFromDate('');
    setToDate('');
    setOffset(0);
  };

  const openCreate = () => {
    setForm(EMPTY_FORM);
    setFormError(null);
    setCreating(true);
    // Backend /api/contacts doesn't support ?subBrand= today; fetch a
    // batch and filter client-side. Trip linkage is optional, but we
    // still preload the TMC trip list so school-trip applicants can be
    // linked to a participant when needed.
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
  }, [creating, form.tripId, selectedContact]);

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
    if (form.tripId && !form.participantId) {
      setFormError({ field: 'participantId', message: 'Participant is required when linking a trip' });
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
      if (form.tripId) {
        body.tripId = parseInt(form.tripId, 10);
        body.participantId = parseInt(form.participantId, 10);
      }
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
  const hasActiveFilters = Boolean(status || applicationType || search.trim() || fromDate || toDate);
  const activeFilterCount = [
    status,
    applicationType,
    search.trim(),
    fromDate,
    toDate,
  ].filter(Boolean).length;
  const emptyMessage = hasActiveFilters
    ? 'No visa applications match the current filters.'
    : 'No visa applications yet. Applications appear here once contacts in your tenant have applications created in the system.';

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
          justifyContent: 'space-between',
          background: 'var(--surface-color)',
          padding: 12,
          borderRadius: 8,
          border: '1px solid var(--border-color)',
          marginBottom: 16,
          position: 'relative',
        }}
      >
        <div
          style={{
            position: 'relative',
            display: 'flex',
            alignItems: 'center',
            flex: '1 1 360px',
            minWidth: 0,
            maxWidth: 420,
          }}
        >
          <Search
            size={16}
            aria-hidden
            style={{
              position: 'absolute',
              left: 10,
              color: 'var(--text-secondary)',
              pointerEvents: 'none',
            }}
          />
          <input
            type="search"
            value={search}
            onChange={(e) => onSearchChange(e.target.value)}
            placeholder="Search contact name"
            style={{
              ...selectStyle,
              width: '100%',
              minWidth: 0,
              paddingLeft: 32,
              paddingRight: search ? 30 : 10,
              boxSizing: 'border-box',
            }}
            aria-label="Search by contact name"
          />
          {search && (
            <button
              type="button"
              onClick={() => onSearchChange('')}
              aria-label="Clear contact search"
              style={{
                position: 'absolute',
                right: 6,
                background: 'none',
                border: 'none',
                padding: 2,
                cursor: 'pointer',
                display: 'flex',
                alignItems: 'center',
                color: 'var(--text-secondary)',
              }}
            >
              <X size={12} />
            </button>
          )}
        </div>

        <div
          ref={filterWrapRef}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            flexWrap: 'wrap',
            position: 'relative',
          }}
        >
          <button
            type="button"
            onClick={load}
            style={refreshBtn}
            aria-label="Reload list"
          >
            Refresh
          </button>
          <button
            type="button"
            onClick={() => setShowFilters((open) => !open)}
            aria-haspopup="dialog"
            aria-expanded={showFilters}
            style={{
              ...filterTriggerBtn,
              background: activeFilterCount > 0
                ? 'var(--primary-color, var(--accent-color))'
                : 'var(--surface-color)',
              color: activeFilterCount > 0 ? '#fff' : 'var(--text-primary)',
              borderColor: activeFilterCount > 0
                ? 'var(--primary-color, var(--accent-color))'
                : 'var(--border-color)',
            }}
          >
            <Filter size={14} />
            Filters
            {activeFilterCount > 0 && (
              <span style={filterBadgeStyle}>{activeFilterCount}</span>
            )}
          </button>

          {showFilters && (
            <div
              role="dialog"
              aria-label="Visa application filters"
              style={filterPanelStyle}
            >
              <div style={filterPanelHeaderStyle}>
                <div>
                  <div style={{ fontSize: 16, fontWeight: 600 }}>Filters</div>
                  <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: 2 }}>
                    Status, type and created date
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => setShowFilters(false)}
                  aria-label="Close filters"
                  style={iconOnlyButtonStyle}
                >
                  <X size={18} />
                </button>
              </div>

              <div style={filterGridStyle}>
                <label style={filterFieldLabelStyle}>
                  <span>Status</span>
                  <select
                    value={status}
                    onChange={(e) => onStatusChange(e.target.value)}
                    style={panelSelectStyle}
                    aria-label="Filter by status"
                  >
                    {STATUSES.map((s) => (
                      <option key={s.value} value={s.value}>
                        {s.label}
                      </option>
                    ))}
                  </select>
                </label>

                <label style={filterFieldLabelStyle}>
                  <span>Type</span>
                  <select
                    value={applicationType}
                    onChange={(e) => onApplicationTypeChange(e.target.value)}
                    style={panelSelectStyle}
                    aria-label="Filter by type"
                  >
                    <option value="">All types</option>
                    {APPLICATION_TYPES.map((t) => (
                      <option key={t.value} value={t.value}>
                        {t.label}
                      </option>
                    ))}
                  </select>
                </label>

                <div style={filterFieldLabelStyle}>
                  <span>Date</span>
                  <VisaDateRangePicker
                    fromDate={fromDate}
                    toDate={toDate}
                    onChange={onDateRangeChange}
                  />
                </div>
              </div>

              <div style={filterPanelFooterStyle}>
                <button
                  type="button"
                  onClick={clearAllFilters}
                  disabled={!hasActiveFilters}
                  style={{
                    ...textActionButtonStyle,
                    opacity: hasActiveFilters ? 1 : 0.45,
                    cursor: hasActiveFilters ? 'pointer' : 'default',
                  }}
                >
                  Reset filters
                </button>
                <div style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
                  {activeFilterCount} active
                </div>
              </div>
            </div>
          )}
        </div>

        <div
          style={{
            marginLeft: 'auto',
            fontSize: 12,
            color: 'var(--text-secondary)',
            flexShrink: 0,
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
            {emptyMessage}
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
                Trip linkage (optional)
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
                      : 'No trip linked'}
                  </option>
                  {trips.map((trip) => (
                    <option key={trip.id} value={trip.id}>
                      {formatTripLabel(trip)}
                    </option>
                  ))}
                </select>
                <span style={fieldHintText}>
                  Leave blank for non-TMC travel, or link a TMC trip now if the applicant is already part of one.
                </span>
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

const filterTriggerBtn = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 6,
  padding: '7px 12px',
  borderRadius: 8,
  border: '1px solid var(--border-color)',
  background: 'var(--surface-color)',
  color: 'var(--text-primary)',
  fontSize: 13,
  fontWeight: 600,
  cursor: 'pointer',
  whiteSpace: 'nowrap',
};

const filterBadgeStyle = {
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  minWidth: 18,
  height: 18,
  padding: '0 5px',
  borderRadius: 999,
  background: 'rgba(255,255,255,0.24)',
  color: '#fff',
  fontSize: 11,
  fontWeight: 700,
};

const filterPanelStyle = {
  position: 'absolute',
  top: 'calc(100% + 10px)',
  right: 0,
  zIndex: 80,
  width: 'min(760px, calc(100vw - 48px))',
  background: 'var(--bg-color)',
  border: '1px solid var(--border-color)',
  borderRadius: 12,
  boxShadow: '0 24px 60px rgba(0,0,0,0.18)',
  padding: 16,
  color: 'var(--text-primary)',
};

const filterPanelHeaderStyle = {
  display: 'flex',
  alignItems: 'flex-start',
  justifyContent: 'space-between',
  gap: 12,
  marginBottom: 16,
};

const filterGridStyle = {
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))',
  gap: 12,
  alignItems: 'start',
};

const filterFieldLabelStyle = {
  display: 'flex',
  flexDirection: 'column',
  gap: 6,
  fontSize: 12,
  fontWeight: 600,
  color: 'var(--text-secondary)',
};

const panelSelectStyle = {
  ...selectStyle,
  width: '100%',
  minWidth: 0,
  boxSizing: 'border-box',
};

const panelFieldButton = {
  ...selectStyle,
  width: '100%',
  minWidth: 0,
  boxSizing: 'border-box',
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  justifyContent: 'flex-start',
};

const filterPanelFooterStyle = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: 12,
  marginTop: 14,
  paddingTop: 14,
  borderTop: '1px solid var(--border-color)',
};

const iconOnlyButtonStyle = {
  background: 'transparent',
  border: 'none',
  color: 'var(--text-secondary)',
  cursor: 'pointer',
  padding: 4,
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  lineHeight: 1,
};

const textActionButtonStyle = {
  background: 'transparent',
  border: 'none',
  color: 'var(--primary-color, var(--accent-color))',
  cursor: 'pointer',
  padding: '4px 0',
  fontSize: 13,
  fontWeight: 600,
};

const dateModalOverlayStyle = {
  position: 'fixed',
  inset: 0,
  zIndex: 1400,
  background: 'rgba(0,0,0,0.62)',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  padding: 16,
};

const dateModalStyle = {
  width: 'min(440px, calc(100vw - 32px))',
  maxHeight: '88vh',
  overflowY: 'auto',
  background: 'var(--bg-color)',
  border: '1px solid var(--border-color)',
  borderRadius: 16,
  boxShadow: '0 24px 60px rgba(0,0,0,0.38)',
  padding: 18,
  color: 'var(--text-primary)',
};

const dateModalHeaderStyle = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: 12,
  marginBottom: 10,
};

const dateNavRowStyle = {
  display: 'flex',
  alignItems: 'center',
  gap: 10,
  marginTop: 8,
};

const navButtonStyle = {
  background: 'transparent',
  border: '1px solid var(--border-color)',
  borderRadius: 8,
  padding: '4px 8px',
  color: 'var(--text-primary)',
  cursor: 'pointer',
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
};



