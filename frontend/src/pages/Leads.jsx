import { fetchApi } from '../utils/api';
import { useNotify } from '../utils/notify';
import { formatDateMedium as formatDate } from '../utils/date';
import { useState, useEffect, useContext } from 'react';
import { useNavigate } from 'react-router-dom';
import { UserPlus, Search, ArrowRightCircle, Plus, X, Pencil, Trash2, RefreshCw, ChevronLeft, ChevronRight, Filter } from 'lucide-react';
import { AuthContext } from '../App';
import ColumnPicker from '../components/ColumnPicker';
import TopScrollSync from '../components/TopScrollSync';
import { SUB_BRAND_IDS, subBrandShortLabel } from '../utils/travelSubBrand';

const SOURCE_OPTIONS = ['Organic', 'Referral', 'LinkedIn', 'Cold Call', 'Website', 'Event', 'Other'];
// #600  wellness vertical replaces the generic CRM source taxonomy with one
// that matches Patient-intake channels. WhatsApp is the dominant inbound
// channel for clinics; LinkedIn / Cold Call don't apply.
const TRAVEL_SOURCE_OPTIONS = [
  { value: 'tmc_registration', label: 'TMC Registration' },
  { value: 'brochure_request', label: 'Brochure Request' },
  { value: 'whatsapp', label: 'WhatsApp' },
  { value: 'referral', label: 'Referral' },
  { value: 'website', label: 'Website' },
  { value: 'phone', label: 'Phone Call' },
  { value: 'event', label: 'Event / Expo' },
  { value: 'other', label: 'Other' },
];
const WELLNESS_SOURCE_OPTIONS = [
  { value: 'walk-in', label: 'Walk-in' },
  { value: 'whatsapp', label: 'WhatsApp' },
  { value: 'phone', label: 'Phone' },
  { value: 'website', label: 'Website' },
  { value: 'referral', label: 'Referral' },
  { value: 'organic', label: 'Organic' },
  { value: 'event', label: 'Event' },
  { value: 'other', label: 'Other' },
];
// Accept either a bare 10-digit Indian mobile (starting 6-9) OR with
// an optional `+91` / `91` prefix. The wellness phone validator strips
// whitespace/dashes/parens before testing.
const INDIAN_MOBILE_RE = /^(?:\+?91)?[6-9]\d{9}$/;
const FIELD_LIMITS = { name: 191, email: 191, company: 191, title: 200, phone: 20 };
const LEADS_PAGE_SIZE_OPTIONS = [25, 50, 100];
const sourceBadgeStyle = {
  padding: '0.25rem 0.75rem',
  borderRadius: '999px',
  fontSize: '0.75rem',
  fontWeight: 600,
  backgroundColor: 'var(--source-badge-bg, rgba(139, 92, 246, 0.16))',
  color: 'var(--source-badge-text, var(--text-primary))',
  border: '1px solid var(--border-color)',
  whiteSpace: 'nowrap',
  display: 'inline-block',
};
// Reject all C0 controls (NUL/BEL/etc.) + DEL. \t \n \r are intentionally
// included  text inputs shouldn't carry them either, and any paste-from-
// malicious-source typically smuggles via NUL or BEL. Detecting control
// chars requires control chars in the pattern; the eslint rule is for
// preventing accidental control chars, so disable it here intentionally.
// eslint-disable-next-line no-control-regex
const CONTROL_CHAR_RE = /[\x00-\x1F\x7F]/;
const EMAIL_RE = /^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]{2,}$/;
const stripDangerousTags = (str) => {
  const DANGEROUS_TAG_RE = /<(script|iframe|object|embed|style|link|meta|form|svg|img|video|audio|source|applet|base|input|textarea)[^>]*>/gi;
  const stripped = str.replace(DANGEROUS_TAG_RE, '');
  return { value: stripped, stripped: stripped !== str };
};

const COUNTRY_CODES = [
  { code: '+1', country: 'USA' },
  { code: '+44', country: 'UK' },
  { code: '+91', country: 'India' },
  { code: '+61', country: 'Australia' },
  { code: '+33', country: 'France' },
  { code: '+49', country: 'Germany' },
  { code: '+39', country: 'Italy' },
  { code: '+34', country: 'Spain' },
  { code: '+81', country: 'Japan' },
  { code: '+86', country: 'China' },
  { code: '+55', country: 'Brazil' },
  { code: '+27', country: 'South Africa' },
  { code: '+971', country: 'UAE' },
  { code: '+65', country: 'Singapore' },
  { code: '+60', country: 'Malaysia' },
];

const Leads = () => {
  const navigate = useNavigate();
  const notify = useNotify();
  // #600  vertical-aware Lead form. Wellness tenants get the Patient-intake
  // field set (Phone required, wellness sources, treatment of interest,
  // preferred location/practitioner); generic CRM keeps the original fields.
  const auth = useContext(AuthContext);
  const isWellness = auth?.tenant?.vertical === 'wellness';
  const isTravel = auth?.tenant?.vertical === 'travel';
  // Only ADMINs may assign / reassign leads. All other roles see the
  // assignee name as plain text and have no checkbox / bulk-assign surface.
  const isAdmin = auth?.user?.role === 'ADMIN';
  const [leads, setLeads] = useState([]);
  const [staff, setStaff] = useState([]);
  const [services, setServices] = useState([]);
  const [locations, setLocations] = useState([]);
  const [loading, setLoading] = useState(true);
  const [searchTerm, setSearchTerm] = useState('');
  const [leadsPage, setLeadsPage] = useState(0);
  const [leadsPageSize, setLeadsPageSize] = useState(25);
  const [pageInput, setPageInput] = useState('1');
  const [selectedLeads, setSelectedLeads] = useState([]);
  const [bulkAgent, setBulkAgent] = useState('');
  // #892  Create Lead surface is a header CTA + drawer (not the inline
  // always-visible form). `creating` drives whether the drawer is rendered.
  const [creating, setCreating] = useState(false);
  const [sourceFilter, setSourceFilter] = useState('');
  const [subBrandFilter, setSubBrandFilter] = useState('');
  const [stageFilter, setStageFilter] = useState('');
  const [pipelineStages, setPipelineStages] = useState([]);
  const [dealsByContact, setDealsByContact] = useState({});
  const [bookingValueByContact, setBookingValueByContact] = useState({});
  // TMC instalment paid totals keyed by parent contact email  supplements
  // itinerary advancePaidAmount for leads that have no itinerary row yet.
  const [tmcPaidByEmail, setTmcPaidByEmail] = useState({});
  const [editing, setEditing] = useState(null);
  const [editForm, setEditForm] = useState({ name: '', email: '', company: '', title: '', source: '', customFields: {} });
  const [editSaving, setEditSaving] = useState(false);
  // Generic-vertical-only Lead custom fields (Settings > Lead Fields).
  // Fetched once; empty array for wellness/travel (no fetch attempted) or
  // for a generic tenant that hasn't defined any fields yet.
  const [customFieldDefs, setCustomFieldDefs] = useState([]);
  // Generic-vertical-only "Customize table" column-visibility picker
  // (personal per-user preference  see components/ColumnPicker.jsx).
  // null = "not loaded yet, show every builtin column" so the table never
  // flashes empty while the preference GET is in flight.
  const [visibleColumns, setVisibleColumns] = useState(null);
  const isColVisible = (key) => visibleColumns === null || visibleColumns.includes(key);
  const handleCustomFieldChangeNew = (fieldKey, value) => {
    setNewLead((prev) => ({
      ...prev,
      customFields: {
        ...(prev.customFields || {}),
        [fieldKey]: value,
      },
    }));
  };
  const handleCustomFieldChangeEdit = (fieldKey, value) => {
    setEditForm((prev) => ({
      ...prev,
      customFields: {
        ...(prev.customFields || {}),
        [fieldKey]: value,
      },
    }));
  };
  // #600  Initial source defaults differ per vertical: wellness leads
  // typically arrive walk-in/WhatsApp; generic CRM leads default to Organic.
  const [newLead, setNewLead] = useState({
    name: '',
    email: '',
    phone: '',
    company: '',
    title: '',
    countryCode: isWellness || isTravel ? '+91' : '+1',
    source: isWellness ? 'walk-in' : isTravel ? 'tmc_registration' : 'Organic',
    status: 'Lead',
    treatmentOfInterest: '',
    preferredLocationId: '',
    preferredPractitionerId: '',
    customFields: {},
  });

  const fetchLeads = () => {
    setLoading(true);
    fetchApi('/api/contacts?status=Lead&limit=500')
      .then(data => {
        setLeads(data);
        setLoading(false);
      })
      .catch(() => setLoading(false));
  };

  const fetchStaff = () => {
    fetchApi('/api/staff')
      .then(data => setStaff(data))
      .catch(() => {});
  };

  useEffect(() => {
    fetchLeads();
    fetchStaff();
    if (isTravel) {
      fetchApi('/api/pipeline_stages')
        .then(data => setPipelineStages(Array.isArray(data) ? data : []))
        .catch(() => setPipelineStages([]));
      fetchApi('/api/deals?limit=500')
        .then(data => {
          const map = {};
          const rows = Array.isArray(data) ? data : [];
          for (const d of rows) {
            if (d.contactId) {
              if (!map[d.contactId]) map[d.contactId] = [];
              map[d.contactId].push(d);
            }
          }
          setDealsByContact(map);
        })
        .catch(() => setDealsByContact({}));
      // Booking value from itineraries  show what the customer has actually paid.
      // Priority: advancePaidAmount (actual cash received) when it's recorded and > 0.
      // Fallback: totalAmount for committed statuses (accepted/advance_paid/fully_paid)
      // so that legacy itineraries without advancePaidAmount still show their value.
      fetchApi('/api/travel/itineraries?limit=200')
        .then(res => {
          const rows = Array.isArray(res?.itineraries) ? res.itineraries : Array.isArray(res) ? res : [];
          const COMMITTED = new Set(['accepted', 'advance_paid', 'fully_paid']);
          const map = {};
          for (const it of rows) {
            if (it?.contactId == null) continue;
            const cur = it.currency || 'INR';
            const advancePaid = Number(it.advancePaidAmount || 0);
            // If advance payment is recorded, always show it (covers partial-paid leads
            // whose itinerary status hasn't been flipped yet).
            // Otherwise fall back to totalAmount for committed itineraries.
            const amt = advancePaid > 0
              ? advancePaid
              : (COMMITTED.has(it.status) ? Number(it.totalAmount) : 0);
            if (!Number.isFinite(amt) || amt <= 0) continue;
            if (!map[it.contactId]) map[it.contactId] = { value: 0, currency: cur };
            map[it.contactId].value += amt;
          }
          setBookingValueByContact(map);
        })
        .catch(() => setBookingValueByContact({}));
      // Fetch TMC paid instalment totals keyed by parent email  covers leads
      // whose parent contact has no Itinerary row (common for TMC school trips).
      fetchApi('/api/travel/trip-billing/paid-by-contact')
        .then(res => setTmcPaidByEmail(res?.byEmail || {}))
        .catch(() => setTmcPaidByEmail({}));
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // #600  load wellness service catalogue + clinic locations only when the
  // current tenant is the wellness vertical. Avoids 401 / empty-response
  // chatter from the generic tenant hitting wellness-only endpoints.
  useEffect(() => {
    if (!isWellness) return;
    fetchApi('/api/wellness/services')
      .then(d => setServices(Array.isArray(d) ? d : (d?.services || [])))
      .catch(() => setServices([]));
    fetchApi('/api/wellness/locations')
      .then(d => setLocations(Array.isArray(d) ? d : (d?.locations || [])))
      .catch(() => setLocations([]));
  }, [isWellness]);

  // Generic-vertical-only Lead custom fields (Settings > Lead Fields).
  // Skipped entirely for wellness/travel tenants.
  useEffect(() => {
    if (isWellness || isTravel) return;
    fetchApi('/api/lead-custom-fields')
      .then(d => setCustomFieldDefs(Array.isArray(d) ? d : []))
      .catch(() => setCustomFieldDefs([]));
  }, [isWellness, isTravel]);

  // #892  close the Create drawer on Escape. Attached only while the drawer
  // is open so we don't trap key events for users not actively creating.
  useEffect(() => {
    if (!creating) return undefined;
    const onKey = (e) => {
      if (e.key === 'Escape') setCreating(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [creating]);

  const openCreate = () => setCreating(true);
  const closeCreate = () => setCreating(false);

  const handleCreateLead = async (e) => {
    e.preventDefault();

    // #557 (HI-08)  client-side hardening. Order:
    //   1. Trim required fields + reject whitespace-only (preserves #337).
    //   2. Per-field length caps (rejects, doesn't silently truncate, so the
    //      user knows they need to shorten the input).
    //   3. Control-character rejection (NUL, BEL, VT, DEL, etc.)  these are
    //      never legitimate in name/email/company/title and usually signal a
    //      paste-from-malicious-source.
    //   4. HTML/script tag pre-strip (defence-in-depth  backend's
    //      sanitizeBody also strips, but surfacing a notice is better UX
    //      than the user wondering why their input looks different).
    //   5. Email shape sanity check (cheap regex  backend stays the source
    //      of truth for the strict validation).
    // The backend at routes/contacts.js + sanitizeBody is still the source
    // of truth; these are just guard rails for fast feedback.
    const trimmedName = (newLead.name || '').trim();
    if (trimmedName.length < 1) {
      // #337: reject whitespace-only names. Toast via global notify helper.
      notify.error('Name is required');
      return;
    }

    // 2. Length caps  match backend Contact column limits (191) for name/
    //    email/company; cap title at 200 (the issue ask). Reject so the user
    //    sees a clear "too long" message rather than a server-side 400.
    const lengthErrors = [];
    for (const [field, max] of Object.entries(FIELD_LIMITS)) {
      const v = String(newLead[field] || '');
      if (v.length > max) {
        lengthErrors.push(`${field} is too long (${v.length}/${max} chars)`);
      }
    }
    if (lengthErrors.length > 0) {
      notify.error(lengthErrors.join('; '));
      return;
    }

    // 3. Control-character rejection across all text fields.
    for (const field of ['name', 'email', 'company', 'title']) {
      const v = String(newLead[field] || '');
      if (v && CONTROL_CHAR_RE.test(v)) {
        notify.error(`${field} contains invalid control characters`);
        return;
      }
    }

    // 4. HTML/script tag pre-strip  surface what was removed so the user
    //    isn't surprised. We strip just the dangerous TAGS (matching the
    //    server-side sanitizeBody contract); the inner text content is kept.
    const stripped = {};
    let anyStripped = false;
    for (const field of ['name', 'company', 'title']) {
      const v = String(newLead[field] || '');
      const result = stripDangerousTags(v);
      stripped[field] = result.value;
      if (result.stripped) anyStripped = true;
    }
    if (anyStripped) {
      notify.info('HTML markup was removed from your input before submitting.');
    }
    // Re-trim the stripped name in case stripping the tags reduced it to
    // whitespace (e.g. the user submitted JUST `<img onerror=>`). Use
    // nullish-coalesce, NOT logical-OR, so an empty-string result of the
    // strip falls through to the empty-name guard rather than reverting
    // to the un-stripped original.
    const finalName = String(stripped.name ?? trimmedName).trim();
    if (finalName.length < 1) {
      notify.error('Name is required');
      return;
    }

    // 5. Email shape  basic regex (matches backend lib/validateContactInput
    //    + CSV importer). The backend rejects with 400 either way.
    //    #600: under wellness, email is OPTIONAL (Patient intake mirrors this);
    //    phone becomes the required identifier instead.
    const email = String(newLead.email || '').trim();
    if (isWellness) {
      if (email && !EMAIL_RE.test(email)) {
        notify.error('Please enter a valid email address');
        return;
      }
    } else if (!email || !EMAIL_RE.test(email)) {
      notify.error('Please enter a valid email address');
      return;
    }

    // Phone handling per vertical:
    //   wellness  required, validated against Indian-mobile pattern
    //   travel    optional, free-form (prepend country code if provided)
    //   generic   optional, free-form (prepend country code if provided)
    let phone = String(newLead.phone || '').trim();
    if (isWellness) {
      const phoneClean = phone.replace(/[\s\-()]/g, '');
      if (!phoneClean) {
        notify.error('Phone is required');
        return;
      }
      if (!INDIAN_MOBILE_RE.test(phoneClean)) {
        notify.error('Enter a valid mobile number (10 digits, starting 6-9; +91 prefix optional).');
        return;
      }
      phone = phoneClean;
    }

    // #315: refetch leads after a successful create so the "All Leads" pipeline
    // counter chip in the header (which reads `leads.length`) refreshes
    // immediately. Pre-fix the await on the create call could throw and skip
    // the refetch, leaving the header counter stuck on the stale count even
    // when the row was inserted server-side. Wrap in try/finally so the
    // refresh always runs and the form is reset on success.
    try {
      // Generic CRM: prepend the picker's country code (the input field
      // is the local-part). Wellness: phone is already canonicalised by
      // the +91-optional regex above  store as-is.
      const phoneOut = isWellness
        ? phone
        : (newLead.phone ? `${newLead.countryCode} ${newLead.phone}` : '');
      await fetchApi('/api/contacts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...newLead, name: trimmedName, phone: phoneOut, countryCode: undefined }),
      });
      setNewLead({ name: '', email: '', company: '', title: '', countryCode: '+1', phone: '', source: 'Organic', status: 'Lead', customFields: {} });
      // #892  close the drawer on successful create; the list refresh
      // below puts the new row at the top so the user sees the result.
      setCreating(false);
    } finally {
      fetchLeads();
    }
  };

  const handleConvert = async (id) => {
    // Bug #283: pipeline is Lead -> Prospect -> Customer -> Churned. The
    // Convert button must move the lead one step (to Prospect), not jump
    // straight to Customer. ConvertedLeads.jsx defaults to the "Prospect"
    // tab, so this is also where the user expects to find the row next.
    await fetchApi(`/api/contacts/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'Prospect' }),
    });
    fetchLeads();
  };

  const openEdit = (lead) => {
    setEditForm({
      name: lead.name || '',
      email: lead.email || '',
      company: lead.company || '',
      title: lead.title || '',
      source: lead.source || '',
      customFields: { ...(lead.customFields || {}) },
    });
    setEditing(lead);
  };

  const submitEdit = async (e) => {
    e.preventDefault();
    if (!editForm.name.trim()) { notify.error('Name is required'); return; }
    setEditSaving(true);
    try {
      await fetchApi(`/api/contacts/${editing.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: editForm.name.trim(),
          email: editForm.email.trim(),
          company: editForm.company.trim(),
          title: editForm.title.trim(),
          source: editForm.source,
          customFields: editForm.customFields || {},
        }),
      });
      notify.success('Lead updated');
      setEditing(null);
      fetchLeads();
    } catch (err) {
      notify.error(err?.body?.error || err?.message || 'Failed to update lead');
    } finally {
      setEditSaving(false);
    }
  };

  const handleDelete = async (lead) => {
    const ok = await notify.confirm({
      title: 'Delete lead?',
      message: `Delete "${lead.name}"? This permanently removes the contact. This can't be undone.`,
      confirmText: 'Delete',
      cancelText: 'Cancel',
      destructive: true,
    });
    if (!ok) return;
    try {
      await fetchApi(`/api/contacts/${lead.id}`, { method: 'DELETE' });
      notify.success('Lead deleted');
      fetchLeads();
    } catch (err) {
      notify.error(err?.body?.error || err?.message || 'Failed to delete lead');
    }
  };

  const handleAssign = async (contactId, assignedToId) => {
    await fetchApi(`/api/contacts/${contactId}/assign`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ assignedToId: assignedToId || null }),
    });
    fetchLeads();
  };

  const handleBulkAssign = async () => {
    if (selectedLeads.length === 0) return;
    await fetchApi('/api/contacts/bulk-assign', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contactIds: selectedLeads, assignedToId: bulkAgent || null }),
    });
    setSelectedLeads([]);
    setBulkAgent('');
    fetchLeads();
  };

  const toggleSelect = (id) => {
    setSelectedLeads(prev =>
      prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]
    );
  };

  const toggleSelectAll = () => {
    if (selectedLeads.length === filteredLeads.length) {
      setSelectedLeads([]);
    } else {
      setSelectedLeads(filteredLeads.map(l => l.id));
    }
  };

    const handleChange = (field, value) => {
    setNewLead(prev => ({ ...prev, [field]: value }));
  };

  const sourceFilterOptions = isWellness
    ? WELLNESS_SOURCE_OPTIONS
    : isTravel
    ? TRAVEL_SOURCE_OPTIONS
    : SOURCE_OPTIONS.map(src => ({ value: src, label: src }));

  const matchesSource = (leadSource, filterValue) => {
    if (!filterValue) return true;
    return String(leadSource || '').toLowerCase() === String(filterValue).toLowerCase();
  };

  const sourceCounts = sourceFilterOptions.reduce((acc, opt) => {
    acc[opt.value] = leads.filter(lead => matchesSource(lead.source, opt.value)).length;
    return acc;
  }, {});

  const travelSubBrandOptions = SUB_BRAND_IDS.map(id => ({ value: id, label: subBrandShortLabel(id) }));
  const travelStageOptions = pipelineStages.map(stage => ({
    value: String(stage.id ?? stage.name ?? stage.title),
    label: stage.title || stage.name || `Stage ${stage.id}`,
  }));
  const leadMatchesStage = (lead) => {
    if (!stageFilter) return true;
    const deals = dealsByContact[lead.id] || [];
    return deals.some(deal => [
      deal.pipelineStageId,
      deal.stageId,
      deal.stage,
      deal.pipelineStage?.id,
      deal.pipelineStage?.name,
      deal.pipelineStage?.title,
    ].some(value => String(value ?? '') === stageFilter));
  };
  const leadsTableMinWidth = isTravel
    ? '1720px'
    : isWellness
    ? '1500px'
    : customFieldDefs.length
    ? `${900 + customFieldDefs.length * 140}px`
    : undefined;

  const filteredLeads = leads.filter(lead => {
    if (!matchesSource(lead.source, sourceFilter)) return false;
    if (isTravel && subBrandFilter && lead.subBrand !== subBrandFilter) return false;
    if (isTravel && !leadMatchesStage(lead)) return false;
    const term = searchTerm.trim().toLowerCase();
    if (!term) return true;
    return [
      lead.name,
      lead.email,
      lead.company,
      lead.phone,
      lead.source,
      lead.assignedTo?.name,
      lead.assignedTo?.email,
    ].some(value => String(value || '').toLowerCase().includes(term));
  });

  const leadsPageCount = Math.max(1, Math.ceil(filteredLeads.length / leadsPageSize));
  const currentLeadsPage = Math.min(leadsPage, leadsPageCount - 1);
  const pageStart = filteredLeads.length === 0 ? 0 : currentLeadsPage * leadsPageSize + 1;
  const pageEnd = filteredLeads.length === 0 ? 0 : Math.min(filteredLeads.length, currentLeadsPage * leadsPageSize + leadsPageSize);
  const paginatedLeads = filteredLeads.slice(currentLeadsPage * leadsPageSize, currentLeadsPage * leadsPageSize + leadsPageSize);

  const goToLeadsPage = () => {
    const nextPage = Number(pageInput);
    if (!Number.isFinite(nextPage) || nextPage < 1) {
      setLeadsPage(0);
      setPageInput('1');
      return;
    }
    const clampedPage = Math.min(nextPage, leadsPageCount);
    setLeadsPage(clampedPage - 1);
    setPageInput(String(clampedPage));
  };

  useEffect(() => {
    setPageInput(String(currentLeadsPage + 1));
  }, [currentLeadsPage]);
// Generic-vertical-only Lead custom fields  renders the right input
  // widget per admin-defined field type (Settings > Lead Fields). Shared
  // between the Create and Edit forms; each caller passes its own
  // `values`/`onChange` so this stays a pure render helper with no state
  // of its own.
  const renderCustomFieldInputs = (values, onChange) => {
    if (isWellness || isTravel || customFieldDefs.length === 0) return null;
    return customFieldDefs.map((f) => {
      const value = values?.[f.fieldKey] ?? '';
      const handle = (v) => onChange(f.fieldKey, v);
      const label = f.label;
      const placeholder = f.placeholder || (f.isRequired ? label : `${label} (optional)`);
      const titleAttr = f.tooltip ? { title: f.tooltip } : {};

      if (f.fieldType === 'checkbox') {
        return (
          <label key={f.id} style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }} {...titleAttr}>
            <input type="checkbox" checked={Boolean(value)} onChange={e => handle(e.target.checked)} />
            {label}
          </label>
        );
      }

      if (f.fieldType === 'dropdown' || f.fieldType === 'radio') {
        return (
          <select key={f.id} className="input-field" required={f.isRequired} value={value} onChange={e => handle(e.target.value)} {...titleAttr}>
            <option value="">{placeholder}</option>
            {(f.options || []).map((opt) => (
              <option key={opt} value={opt}>{opt}</option>
            ))}
          </select>
        );
      }

      if (f.fieldType === 'multiselect') {
        const selected = Array.isArray(value) ? value : (value ? [value] : []);
        return (
          <div key={f.id} style={{ display: 'flex', flexDirection: 'column', gap: '0.4rem' }} {...titleAttr}>
            {label}
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.4rem' }}>
              {(f.options || []).map((opt) => (
                <label key={opt} style={{ display: 'inline-flex', alignItems: 'center', gap: '0.3rem', fontSize: '0.8rem', padding: '0.2rem 0.5rem', borderRadius: 6, border: '1px solid var(--border-color)', background: 'var(--surface-color)', cursor: 'pointer' }}>
                  <input
                    type="checkbox"
                    checked={selected.includes(opt)}
                    onChange={(e) => {
                      const next = e.target.checked ? [...selected, opt] : selected.filter((s) => s !== opt);
                      handle(next);
                    }}
                  />
                  {opt}
                </label>
              ))}
            </div>
          </div>
        );
      }

      if (f.fieldType === 'textarea') {
        return (
          <textarea
            key={f.id}
            className="input-field"
            required={f.isRequired}
            value={value}
            placeholder={placeholder}
            maxLength={2000}
            rows={3}
            onChange={e => handle(e.target.value)}
            {...titleAttr}
            style={{ padding: '0.45rem', fontSize: '0.85rem' }}
          />
        );
      }

      const inputType = f.fieldType === 'date' ? 'date' : f.fieldType === 'number' ? 'number' : f.fieldType === 'url' ? 'url' : 'text';
      return (
        <input
          key={f.id}
          type={inputType}
          className="input-field"
          required={f.isRequired}
          value={value}
          placeholder={placeholder}
          onChange={e => handle(e.target.value)}
          {...titleAttr}
          style={{ padding: '0.45rem', fontSize: '0.85rem' }}
        />
      );
    });
  };

  const activeSearchTerm = searchTerm.trim();
  const leadsSummary = activeSearchTerm
    ? `${filteredLeads.length} of ${leads.length} leads match "${activeSearchTerm}"`
    : `${leads.length} leads in pipeline`;
  const leadsColSpan = 2
    + (isAdmin ? 1 : 0)
    + ['email', 'company', 'phone', 'aiScore', 'source', 'assignedTo', 'createdAt'].filter(isColVisible).length
    + (isTravel ? 2 : 0)
    + customFieldDefs.filter(f => isColVisible(`cf_${f.fieldKey}`)).length;
  return (
    <div style={{ padding: '2rem', animation: 'fadeIn 0.3s ease' }}>
      <header style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '2rem', flexWrap: 'wrap', gap: '1rem' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', minWidth: 0, flex: '1 1 240px' }}>
          <UserPlus size={24} color="var(--text-primary)" />
          <div style={{ minWidth: 0 }}>
            <h1 style={{ margin: 0, fontSize: '1.5rem', color: 'var(--text-primary)' }}>Leads</h1>
            <p style={{ margin: '0.2rem 0 0', color: 'var(--text-secondary)', fontSize: '0.875rem' }}>{leadsSummary}</p>
          </div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', flexWrap: 'wrap', justifyContent: 'flex-end' }}>
          <button type="button" className="btn-secondary" onClick={fetchLeads} style={{ display: 'inline-flex', alignItems: 'center', gap: '0.45rem' }}>
            <RefreshCw size={15} /> Refresh
          </button>
          <button type="button" className="btn-primary" aria-label="Create a new lead" onClick={openCreate} style={{ display: 'inline-flex', alignItems: 'center', gap: '0.45rem' }}>
            <Plus size={16} /> Create Lead
          </button>
        </div>
      </header>

      <div className="card" style={{ padding: '0.6rem 0.75rem', display: 'flex', alignItems: 'center', gap: '0.4rem', flexWrap: 'wrap', marginBottom: '0.75rem' }}>
        <button type="button" onClick={() => { setSourceFilter(''); setLeadsPage(0); }} style={!sourceFilter ? chipActiveStyle : chipStyle}>
          All <span style={chipCountStyle}>{leads.length}</span>
        </button>
        {sourceFilterOptions.map(opt => (
          <button key={opt.value} type="button" onClick={() => { setSourceFilter(opt.value); setLeadsPage(0); }} style={sourceFilter === opt.value ? chipActiveStyle : chipStyle}>
            {opt.label} <span style={chipCountStyle}>{sourceCounts[opt.value] || 0}</span>
          </button>
        ))}
      </div>

      {isTravel && (
        <div className="card" style={{ padding: '0.75rem 1rem', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '0.75rem', flexWrap: 'wrap', marginBottom: '0.75rem' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem', flexWrap: 'wrap' }}>
            <Filter size={15} style={{ color: 'var(--text-secondary)' }} />
            <select className="input-field" value={subBrandFilter} onChange={e => { setSubBrandFilter(e.target.value); setLeadsPage(0); }} aria-label="Filter by sub-brand" style={{ width: 'auto', minWidth: 140 }}>
              <option value="">All sub-brands</option>
              {travelSubBrandOptions.map(opt => <option key={opt.value} value={opt.value}>{opt.label}</option>)}
            </select>
            <select className="input-field" value={stageFilter} onChange={e => { setStageFilter(e.target.value); setLeadsPage(0); }} aria-label="Filter by stage" style={{ width: 'auto', minWidth: 160 }}>
              <option value="">All stages</option>
              {travelStageOptions.map(opt => <option key={opt.value} value={opt.value}>{opt.label}</option>)}
            </select>
          </div>
          <span style={{ color: 'var(--text-secondary)', fontSize: '0.8125rem' }}>{filteredLeads.length} leads</span>
        </div>
      )}

      <div className="card" style={{ overflow: 'hidden', maxHeight: 'unset', minHeight: 'auto' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '0.75rem', flexWrap: 'wrap', padding: '1rem', borderBottom: '1px solid var(--border-color)' }}>
          <div style={{ position: 'relative', width: 'min(100%, 300px)' }}>
            <Search size={18} style={{ position: 'absolute', left: '1rem', top: '50%', transform: 'translateY(-50%)', color: 'var(--text-secondary)' }} />
            <input
              type="search"
              className="input-field"
              placeholder="Search leads..."
              value={searchTerm}
              onChange={e => { setSearchTerm(e.target.value); setLeadsPage(0); }}
              style={{ paddingLeft: '2.5rem', backgroundColor: 'var(--surface-hover)' }}
            />
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap' }}>
            {!isWellness && !isTravel && <ColumnPicker tableKey="leads" onColumnsChange={setVisibleColumns} />}
            {isAdmin && selectedLeads.length > 0 && (
              <>
                <span style={{ color: 'var(--text-secondary)', fontSize: '0.85rem' }}>{selectedLeads.length} lead{selectedLeads.length === 1 ? '' : 's'} selected</span>
                <select className="input-field" value={bulkAgent} onChange={e => setBulkAgent(e.target.value)} style={{ width: 'auto', minWidth: 150 }}>
                  <option value="">Unassign</option>
                  {staff.map(s => <option key={s.id} value={s.id}>{s.name || s.email}</option>)}
                </select>
                <button type="button" className="btn-secondary" onClick={handleBulkAssign}>Assign</button>
                <button type="button" onClick={() => { setSelectedLeads([]); setBulkAgent(''); }} style={{ background: 'none', border: 'none', color: 'var(--accent-color)', cursor: 'pointer', fontSize: '0.85rem' }}>Clear</button>
              </>
            )}
          </div>
        </div>
        <TopScrollSync scrollWidth={leadsTableMinWidth} forceScrollbar>
            <table className={isTravel ? "leads-table leads-table--fit" : "leads-table"} style={{ width: '100%', borderCollapse: 'collapse', textAlign: 'left', minWidth: leadsTableMinWidth, tableLayout: isTravel ? 'fixed' : 'auto' }}>
              {isTravel && (
                <colgroup>
                  {isAdmin && <col style={{ width: '2.5%' }} />}
                  <col style={{ width: '10.5%' }} />
                  <col style={{ width: '14%' }} />
                  <col style={{ width: '14%' }} />
                  <col style={{ width: '8.5%' }} />
                  <col style={{ width: '6.5%' }} />
                  <col style={{ width: '8.5%' }} />
                  <col style={{ width: '6.5%' }} />
                  <col style={{ width: '7.5%' }} />
                  <col style={{ width: '7.5%' }} />
                  <col style={{ width: '5%' }} />
                  <col style={{ width: '8%' }} />
                </colgroup>
              )}
              <thead>
                <tr style={{ borderBottom: '1px solid var(--border-color)', backgroundColor: 'var(--table-header-bg)' }}>
                  {isAdmin && (
                    <th style={{ padding: '1rem', width: '40px' }}>
                      <input type="checkbox" checked={selectedLeads.length === filteredLeads.length && filteredLeads.length > 0} onChange={toggleSelectAll} style={{ cursor: 'pointer' }} />
                    </th>
                  )}
                  <th style={{ padding: '1rem', color: 'var(--text-secondary)', fontWeight: '500', fontSize: '0.875rem' }}>Name</th>
                  {isColVisible('email') && <th style={{ padding: '1rem', color: 'var(--text-secondary)', fontWeight: '500', fontSize: '0.875rem' }}>Email</th>}
                  {isColVisible('company') && <th style={{ padding: '1rem', color: 'var(--text-secondary)', fontWeight: '500', fontSize: '0.875rem' }}>{isTravel ? 'Category' : 'Company'}</th>}
                  {isColVisible('phone') && <th style={{ padding: '1rem', color: 'var(--text-secondary)', fontWeight: '500', fontSize: '0.875rem' }}>Phone</th>}
                  {isColVisible('aiScore') && <th style={{ padding: '1rem', color: 'var(--text-secondary)', fontWeight: '500', fontSize: '0.875rem' }}>Lead Score</th>}
                  {isColVisible('source') && <th style={{ padding: '1rem', color: 'var(--text-secondary)', fontWeight: '500', fontSize: '0.875rem' }}>Source</th>}
                  {isTravel && <th style={{ padding: '1rem', color: 'var(--text-secondary)', fontWeight: '500', fontSize: '0.875rem' }}>Sub-brand</th>}
                  {isTravel && <th style={{ padding: '1rem', color: 'var(--text-secondary)', fontWeight: '500', fontSize: '0.875rem' }}>Amount</th>}
                  {customFieldDefs.filter(f => isColVisible(`cf_${f.fieldKey}`)).map(f => (
                    <th key={f.id} style={{ padding: '1rem', color: 'var(--text-secondary)', fontWeight: '500', fontSize: '0.875rem' }}>{f.label}</th>
                  ))}
                  {isColVisible('assignedTo') && <th style={{ padding: '1rem', color: 'var(--text-secondary)', fontWeight: '500', fontSize: '0.875rem' }}>Assigned To</th>}
                  {isColVisible('createdAt') && <th style={{ padding: '1rem', color: 'var(--text-secondary)', fontWeight: '500', fontSize: '0.875rem' }}>Created</th>}
                  <th style={{ padding: '1rem 0.5rem', color: 'var(--text-secondary)', fontWeight: '500', fontSize: '0.875rem', whiteSpace: 'nowrap' }}>Actions</th>
                </tr>
              </thead>
              <tbody>
              {loading ? (
                <tr><td colSpan={leadsColSpan} style={{ padding: '2rem', textAlign: 'center', color: 'var(--text-secondary)' }}>Loading leads...</td></tr>
              ) : filteredLeads.length === 0 ? (
                <tr><td colSpan={leadsColSpan} style={{ padding: '2rem', textAlign: 'center', color: 'var(--text-secondary)' }}>No leads found</td></tr>
              ) : paginatedLeads.map(lead => (
                <tr
                  key={lead.id}
                  style={{ borderBottom: '1px solid var(--border-color)', cursor: 'pointer' }}
                  className="table-row-hover"
                  onClick={() => navigate(`/contacts/${lead.id}`)}
                  title="Open lead detail"
                >
                  {isAdmin && (
                    <td style={{ padding: '1rem' }} onClick={e => e.stopPropagation()}>
                      <input type="checkbox" checked={selectedLeads.includes(lead.id)} onChange={() => toggleSelect(lead.id)} style={{ cursor: 'pointer' }} />
                    </td>
                  )}
                  <td style={{ padding: '1rem', fontWeight: '500' }}>{lead.name}</td>
                  {isColVisible('email') && <td style={{ padding: '1rem', color: 'var(--text-secondary)' }}>{lead.email}</td>}
                  {isColVisible('company') && <td style={{ padding: '1rem', color: 'var(--text-secondary)' }}>{lead.company || <span style={{ color: 'var(--border-color)' }}>-</span>}</td>}
                  {isColVisible('phone') && (
                    <td style={{ padding: '1rem', color: 'var(--text-secondary)', fontSize: '0.875rem', whiteSpace: 'nowrap' }}>
                      {lead.phone || <span style={{ color: 'var(--border-color)' }}>-</span>}
                    </td>
                  )}
                  {isColVisible('aiScore') && (
                    <td style={{ padding: '1rem' }}>
                      <span style={{
                        padding: '0.25rem 0.75rem',
                        borderRadius: '999px',
                        fontSize: '0.75rem',
                        fontWeight: 'bold',
                        backgroundColor: lead.aiScore > 75 ? 'rgba(16, 185, 129, 0.1)' : lead.aiScore > 40 ? 'rgba(245, 158, 11, 0.1)' : 'rgba(239, 68, 68, 0.1)',
                        color: lead.aiScore > 75 ? 'var(--success-color)' : lead.aiScore > 40 ? 'var(--warning-color)' : '#ef4444',
                      }}>
                        {lead.aiScore}/100
                      </span>
                    </td>
                  )}
                  {isColVisible('source') && (
                    <td style={{ padding: '1rem' }}>
                      <span style={sourceBadgeStyle}>
                        {lead.source || 'Organic'}
                      </span>
                    </td>
                  )}
                  {isTravel && (
                    <td style={{ padding: '1rem', color: 'var(--text-secondary)', fontSize: '0.875rem', whiteSpace: 'nowrap' }}>
                      {lead.subBrand ? subBrandShortLabel(lead.subBrand) : <span style={{ color: 'var(--border-color)' }}>-</span>}
                    </td>
                  )}
                  {isTravel && (() => {
                    // 1. Itinerary advancePaidAmount (highest fidelity  set by sync/webhook)
                    const bv = bookingValueByContact[lead.id];
                    if (bv && bv.value > 0) {
                      return (
                        <td style={{ padding: '1rem', fontWeight: 500, fontSize: '0.875rem' }} title="Amount paid">
                          {bv.currency || 'INR'} {Number(bv.value).toLocaleString()}
                        </td>
                      );
                    }
                    // 2. TMC instalment paid totals keyed by parent email  covers leads
                    // whose parent contact has no itinerary row (common for school trips).
                    const tmcEntry = tmcPaidByEmail[lead.email];
                    if (tmcEntry && tmcEntry.paidTotal > 0) {
                      return (
                        <td style={{ padding: '1rem', fontWeight: 500, fontSize: '0.875rem' }} title="Amount paid">
                          {tmcEntry.currency || 'INR'} {Number(tmcEntry.paidTotal).toLocaleString()}
                        </td>
                      );
                    }
                    const deals = dealsByContact[lead.id] || [];
                    const total = deals.reduce((s, d) => s + (Number(d.amount) || 0), 0);
                    const currency = deals[0]?.currency || 'INR';
                    return (
                      <td style={{ padding: '1rem', fontWeight: 500, fontSize: '0.875rem' }}>
                        {total > 0 ? `${currency} ${total.toLocaleString()}` : <span style={{ color: 'var(--text-secondary)' }}>-</span>}
                      </td>
                    );
                  })()}
                  {/* Generic-vertical-only Lead custom fields  shows every
                      defined field's value, or a dash for leads that predate
                      the field (backend fills the key with null). Each
                      field's column is independently toggleable via the
                      "Customize table" picker (same cf_ prefix as the header). */}
                  {customFieldDefs.filter(f => isColVisible(`cf_${f.fieldKey}`)).map(f => {
                    const raw = lead.customFields?.[f.fieldKey];
                    let display;
                    if (raw === null || raw === undefined || raw === '') {
                      display = null;
                    } else if (f.fieldType === 'checkbox') {
                      display = raw ? 'Yes' : 'No';
                    } else if (f.fieldType === 'date') {
                      display = formatDate(raw);
                    } else if (f.fieldType === 'multiselect') {
                      display = Array.isArray(raw) ? raw.join(', ') : String(raw);
                    } else if (f.fieldType === 'url') {
                      display = (
                        <a href={String(raw)} target="_blank" rel="noopener noreferrer" style={{ color: 'var(--accent-color)' }}>
                          {String(raw)}
                        </a>
                      );
                    } else {
                      display = String(raw);
                    }
                    return (
                      <td key={f.id} style={{ padding: '1rem', color: 'var(--text-secondary)', fontSize: '0.875rem' }}>
                        {display ?? <span style={{ color: 'var(--border-color)' }}>-</span>}
                      </td>
                    );
                  })}
                  {isColVisible('assignedTo') && (
                    <td style={{ padding: '1rem' }} onClick={e => e.stopPropagation()}>
                      {isAdmin ? (
                        <select
                          className="input-field"
                          value={lead.assignedToId || ''}
                          onChange={e => handleAssign(lead.id, e.target.value)}
                          style={{ padding: '0.375rem 0.5rem', fontSize: '0.8rem', minWidth: '130px', background: 'var(--input-bg)' }}
                        >
                          <option value="">Unassigned</option>
                          {staff.map(s => (
                            <option key={s.id} value={s.id}>{s.name || s.email}</option>
                          ))}
                        </select>
                      ) : (
                        <span style={{ fontSize: '0.875rem', color: lead.assignedToId ? 'var(--text-primary)' : 'var(--text-secondary)' }}>
                          {lead.assignedTo?.name || lead.assignedTo?.email || 'Unassigned'}
                        </span>
                      )}
                    </td>
                  )}
                  {isColVisible('createdAt') && (
                    <td style={{ padding: '1rem', color: 'var(--text-secondary)', fontSize: '0.875rem' }}>
                      {formatDate(lead.createdAt)}
                    </td>
                  )}
                  <td style={{ padding: '0.75rem 0.5rem', whiteSpace: 'nowrap', minWidth: '88px' }} onClick={e => e.stopPropagation()}>
                    <button
                      onClick={() => openEdit(lead)}
                      title="Edit lead"
                      style={actionIconBtn}
                    >
                      <Pencil size={15} />
                    </button>
                    <button
                      onClick={() => handleConvert(lead.id)}
                      title="Convert to Prospect"
                      style={{ ...actionIconBtn, color: 'var(--success-color)', marginLeft: 6 }}
                    >
                      <ArrowRightCircle size={15} />
                    </button>
                    <button
                      onClick={() => handleDelete(lead)}
                      title="Delete lead"
                      style={{ ...actionIconBtn, color: 'var(--danger-color, #f43f5e)', marginLeft: 6 }}
                    >
                      <Trash2 size={15} />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          </TopScrollSync>
          {!loading && filteredLeads.length > 0 && (
            <div style={{
              display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '0.75rem',
              flexWrap: 'wrap', padding: '0.75rem 7.5rem 0.75rem 1rem',
              borderTop: '1px solid var(--border-color)', background: 'var(--surface-color)',
              position: 'relative', zIndex: 2,
            }}>
              <span style={{ color: 'var(--text-secondary)', fontSize: '0.8125rem', whiteSpace: 'nowrap' }}>
                Showing {pageStart}-{pageEnd} of {filteredLeads.length}
              </span>
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap' }}>
                <label htmlFor="leads-page-size" style={{ color: 'var(--text-secondary)', fontSize: '0.8125rem' }}>Rows</label>
                <select
                  id="leads-page-size" value={leadsPageSize}
                  onChange={e => { setLeadsPageSize(Number(e.target.value)); setLeadsPage(0); }}
                  className="input-field"
                  style={{ width: 'auto', minWidth: '4.5rem', padding: '0.35rem 0.5rem', fontSize: '0.8125rem' }}
                  aria-label="Rows per page"
                >
                  {LEADS_PAGE_SIZE_OPTIONS.map(size => <option key={size} value={size}>{size}</option>)}
                </select>
                <button type="button" title="Previous page" aria-label="Previous page"
                  onClick={() => setLeadsPage(currentLeadsPage - 1)} disabled={currentLeadsPage === 0}
                  style={{ ...actionIconBtn, opacity: currentLeadsPage === 0 ? 0.45 : 1 }}>
                  <ChevronLeft size={16} />
                </button>
                <form onSubmit={e => { e.preventDefault(); goToLeadsPage(); }} style={{ display: 'flex', alignItems: 'center', gap: '0.35rem' }}>
                  <label htmlFor="leads-page-number" style={{ color: 'var(--text-secondary)', fontSize: '0.8125rem' }}>Page</label>
                  <input id="leads-page-number" type="number" min="1" max={leadsPageCount} value={pageInput}
                    onChange={e => setPageInput(e.target.value)} onBlur={goToLeadsPage}
                    style={{ width: '3.5rem', padding: '0.35rem 0.4rem', textAlign: 'center', border: '1px solid var(--border-color)', borderRadius: 6, background: 'var(--input-bg)', color: 'var(--text-primary)' }}
                    aria-label="Page number" />
                  <span style={{ color: 'var(--text-secondary)', fontSize: '0.8125rem' }}>of {leadsPageCount}</span>
                </form>
                <button type="button" title="Next page" aria-label="Next page"
                  onClick={() => setLeadsPage(currentLeadsPage + 1)} disabled={currentLeadsPage >= leadsPageCount - 1}
                  style={{ ...actionIconBtn, opacity: currentLeadsPage >= leadsPageCount - 1 ? 0.45 : 1 }}>
                  <ChevronRight size={16} />
                </button>
              </div>
            </div>
          )}
        </div>

        {/* #892  Create Lead drawer. Mounted only when `creating` is true.
            Close triggers: X button, ESC keypress (handled by the useEffect
            above), and clicking on the dark overlay outside the drawer body.
            The form fields + submit handler are unchanged from the previous
            inline form  only the trigger surface moved. */}
        {creating && (
          <div
            onClick={(e) => { if (e.target === e.currentTarget) closeCreate(); }}
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
            role="dialog"
            aria-modal="true"
            aria-label="Create Lead"
          >
            <div
              className="card"
              style={{
                background: 'var(--bg-color)',
                color: 'var(--text-primary)',
                width: '100%',
                maxWidth: 480,
                maxHeight: '90vh',
                overflowY: 'auto',
                padding: '1.5rem',
              }}
            >
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1rem' }}>
                <h3 style={{ margin: 0, fontSize: '1.1rem', fontWeight: 600 }}>Create Lead</h3>
                <button
                  type="button"
                  onClick={closeCreate}
                  aria-label="Close"
                  style={{ background: 'transparent', border: 'none', color: 'var(--text-secondary)', cursor: 'pointer', padding: 4 }}
                >
                  <X size={18} />
                </button>
              </div>
              {/* #557: noValidate so the JS handler in handleCreateLead runs the
                  client-side validation (length caps, control-char rejection,
                  HTML strip, email shape). Native HTML5 validation would block
                  submit without giving us a chance to surface the targeted toasts. */}
              <form onSubmit={handleCreateLead} noValidate style={{ display: 'flex', flexDirection: 'column', gap: '0.875rem' }}>
                <input type="text" placeholder="Full Name" required maxLength={191} className="input-field" value={newLead.name} onChange={e => handleChange('name', e.target.value)} />
                <input type="email" placeholder="Email Address" required={!isWellness} maxLength={191} className="input-field" value={newLead.email} onChange={e => handleChange('email', e.target.value)} />
                <input type="text" placeholder={isTravel ? 'Category (e.g. School Trip, Umrah, Family Holiday)' : 'Company'} maxLength={191} className="input-field" value={newLead.company} onChange={e => handleChange('company', e.target.value)} />
                {!isTravel && (
                  <input type="text" placeholder="Job Title" maxLength={200} className="input-field" value={newLead.title} onChange={e => handleChange('title', e.target.value)} />
                )}
                {/* Phone field  required for wellness (Indian mobile validation),
                    optional for travel (any format accepted). */}
                {(isWellness || isTravel) && (
                  <div style={{ display: 'flex', gap: '0.5rem' }}>
                    <select className="input-field" value={newLead.countryCode} onChange={e => handleChange('countryCode', e.target.value)} style={{ width: '100px' }}>
                      {COUNTRY_CODES.map(cc => (
                        <option key={cc.code} value={cc.code}>{cc.code}</option>
                      ))}
                    </select>
                    <input
                      type="tel"
                      placeholder={isWellness ? 'Phone (10-digit mobile, e.g. 9876543210)' : 'Phone (optional)'}
                      required={isWellness}
                      className="input-field"
                      value={newLead.phone}
                      onChange={e => handleChange('phone', e.target.value)}
                      style={{ flex: 1 }}
                    />
                  </div>
                )}
                <select
                  className="input-field"
                  name="source"
                  value={newLead.source}
                  onChange={e => handleChange('source', e.target.value)}
                >
                  {isWellness
                    ? WELLNESS_SOURCE_OPTIONS.map(opt => (
                        <option key={opt.value} value={opt.value}>{opt.label}</option>
                      ))
                    : isTravel
                    ? TRAVEL_SOURCE_OPTIONS.map(opt => (
                        <option key={opt.value} value={opt.value}>{opt.label}</option>
                      ))
                    : SOURCE_OPTIONS.map(src => (
                        <option key={src} value={src}>{src}</option>
                      ))}
                </select>

                {/* #600  wellness extras: treatment of interest (dropdown of
                    catalog services + a free-text "Other" fallback if the
                    catalogue is empty), preferred clinic, preferred
                    practitioner. All three persist on Contact and feed
                    marketing-attribution + lead-routing downstream. */}
                {isWellness && (
                  <>
                    {services.length > 0 ? (
                      <select
                        className="input-field"
                        name="treatmentOfInterest"
                        value={newLead.treatmentOfInterest}
                        onChange={e => handleChange('treatmentOfInterest', e.target.value)}
                      >
                        <option value="">Treatment of interest (optional)</option>
                        {services.map(svc => (
                          <option key={svc.id} value={svc.name || svc.title}>
                            {svc.name || svc.title}
                          </option>
                        ))}
                      </select>
                    ) : (
                      <input
                        type="text"
                        name="treatmentOfInterest"
                        placeholder="Treatment of interest (optional)"
                        maxLength={191}
                        className="input-field"
                        value={newLead.treatmentOfInterest}
                        onChange={e => handleChange('treatmentOfInterest', e.target.value)}
                      />
                    )}
                    {locations.length > 0 && (
                      <select
                        className="input-field"
                        name="preferredLocationId"
                        value={newLead.preferredLocationId}
                        onChange={e => handleChange('preferredLocationId', e.target.value)}
                      >
                        <option value="">Preferred clinic (optional)</option>
                        {locations.map(loc => (
                          <option key={loc.id} value={loc.id}>{loc.name}</option>
                        ))}
                      </select>
                    )}
                    {staff.filter(s => (s.wellnessRole || '').toLowerCase() === 'doctor').length > 0 && (
                      <select
                        className="input-field"
                        name="preferredPractitionerId"
                        value={newLead.preferredPractitionerId}
                        onChange={e => handleChange('preferredPractitionerId', e.target.value)}
                      >
                        <option value="">Preferred practitioner (optional)</option>
                        {staff
                          .filter(s => (s.wellnessRole || '').toLowerCase() === 'doctor')
                          .map(doc => (
                            <option key={doc.id} value={doc.id}>{doc.name || doc.email}</option>
                          ))}
                      </select>
                    )}
                  </>
                )}

                {renderCustomFieldInputs(newLead.customFields, handleCustomFieldChangeNew)}

                <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '0.5rem', marginTop: '0.5rem' }}>
                  <button
                    type="button"
                    onClick={closeCreate}
                    style={{ padding: '0.5rem 1rem', borderRadius: 6, border: '1px solid var(--border-color)', background: 'var(--surface-color)', color: 'var(--text-secondary)', cursor: 'pointer', fontSize: '0.875rem' }}
                  >
                    Cancel
                  </button>
                  <button type="submit" className="btn-primary" style={{ padding: '0.5rem 1rem', fontSize: '0.875rem' }}>
                    Add Lead
                  </button>
                </div>
              </form>
            </div>
          </div>
        )}

        {editing && (
          <div
            onClick={(e) => { if (e.target === e.currentTarget) setEditing(null); }}
            style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.75)', backdropFilter: 'blur(4px)', WebkitBackdropFilter: 'blur(4px)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000, padding: '1rem' }}
            role="dialog"
            aria-modal="true"
            aria-label="Edit Lead"
          >
            <div className="card" style={{ background: 'var(--bg-color)', color: 'var(--text-primary)', width: '100%', maxWidth: 480, maxHeight: '90vh', overflowY: 'auto', padding: '1.5rem' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1rem' }}>
                <h3 style={{ margin: 0, fontSize: '1.1rem', fontWeight: 600 }}>Edit Lead</h3>
                <button type="button" onClick={() => setEditing(null)} aria-label="Close" style={{ background: 'transparent', border: 'none', color: 'var(--text-secondary)', cursor: 'pointer', padding: 4 }}>
                  <X size={18} />
                </button>
              </div>
              <form onSubmit={submitEdit} style={{ display: 'flex', flexDirection: 'column', gap: '0.875rem' }}>
                <input type="text" placeholder="Full Name" required className="input-field" value={editForm.name} onChange={e => setEditForm(prev => ({ ...prev, name: e.target.value }))} />
                <input type="email" placeholder="Email Address" className="input-field" value={editForm.email} onChange={e => setEditForm(prev => ({ ...prev, email: e.target.value }))} />
                <input type="text" placeholder="Company" className="input-field" value={editForm.company} onChange={e => setEditForm(prev => ({ ...prev, company: e.target.value }))} />
                <input type="text" placeholder="Job Title" className="input-field" value={editForm.title} onChange={e => setEditForm(prev => ({ ...prev, title: e.target.value }))} />
                <select className="input-field" value={editForm.source} onChange={e => setEditForm(prev => ({ ...prev, source: e.target.value }))}>
                  {isWellness
                    ? WELLNESS_SOURCE_OPTIONS.map(opt => <option key={opt.value} value={opt.value}>{opt.label}</option>)
                    : isTravel
                    ? TRAVEL_SOURCE_OPTIONS.map(opt => <option key={opt.value} value={opt.value}>{opt.label}</option>)
                    : SOURCE_OPTIONS.map(s => <option key={s} value={s}>{s}</option>)
                  }
                </select>
                {renderCustomFieldInputs(editForm.customFields, handleCustomFieldChangeEdit)}
                <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '0.5rem', marginTop: '0.5rem' }}>
                  <button type="button" onClick={() => setEditing(null)} style={{ padding: '0.5rem 1rem', borderRadius: 6, border: '1px solid var(--border-color)', background: 'var(--surface-color)', color: 'var(--text-secondary)', cursor: 'pointer', fontSize: '0.875rem' }}>Cancel</button>
                  <button type="submit" className="btn-primary" disabled={editSaving} style={{ padding: '0.5rem 1rem', fontSize: '0.875rem' }}>{editSaving ? 'Saving...' : 'Save Changes'}</button>
                </div>
              </form>
            </div>
          </div>
        )}
    </div>
  );
};

const actionIconBtn = {
  background: 'transparent', border: 'none', cursor: 'pointer', padding: 4,
  color: 'var(--text-secondary)', display: 'inline-flex', alignItems: 'center',
};
const chipStyle = {
  display: 'inline-flex', alignItems: 'center', gap: 4,
  padding: '4px 10px', borderRadius: 999, fontSize: 12, fontWeight: 500,
  background: 'var(--surface-color)', color: 'var(--text-secondary)',
  border: '1px solid var(--border-color)', cursor: 'pointer',
};
const chipActiveStyle = {
  ...chipStyle,
  background: 'var(--primary-color, var(--accent-color))',
  color: 'var(--accent-text, #fff)',
  border: '1px solid var(--primary-color, var(--accent-color))',
};
const chipCountStyle = { fontSize: 11, fontWeight: 600, opacity: 0.8, marginLeft: 2 };

export default Leads;
