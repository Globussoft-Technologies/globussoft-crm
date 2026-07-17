import { fetchApi } from '../utils/api';
import { useNotify } from '../utils/notify';
import { formatDateMedium as formatDate } from '../utils/date';
import React, { useState, useEffect, useContext } from 'react';
import { useNavigate } from 'react-router-dom';
import { UserPlus, Search, ArrowRightCircle, UserCheck, Users, Plus, X, Pencil, Trash2, RefreshCw } from 'lucide-react';
import { AuthContext } from '../App';

const SOURCE_OPTIONS = ['Organic', 'Referral', 'LinkedIn', 'Cold Call', 'Website', 'Event', 'Other'];
// #600 — wellness vertical replaces the generic CRM source taxonomy with one
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
// Reject all C0 controls (NUL/BEL/etc.) + DEL. \t \n \r are intentionally
// included — text inputs shouldn't carry them either, and any paste-from-
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
  // #600 — vertical-aware Lead form. Wellness tenants get the Patient-intake
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
  const [selectedLeads, setSelectedLeads] = useState([]);
  const [bulkAgent, setBulkAgent] = useState('');
  // #892 — Create Lead surface is a header CTA + drawer (not the inline
  // always-visible form). `creating` drives whether the drawer is rendered.
  const [creating, setCreating] = useState(false);
  const [sourceFilter, setSourceFilter] = useState('');
  const [subBrandFilter, setSubBrandFilter] = useState('');
  const [stageFilter, setStageFilter] = useState('');
  const [pipelineStages, setPipelineStages] = useState([]);
  const [dealsByContact, setDealsByContact] = useState({});
  const [bookingValueByContact, setBookingValueByContact] = useState({});
  // TMC instalment paid totals keyed by parent contact email — supplements
  // itinerary advancePaidAmount for leads that have no itinerary row yet.
  const [tmcPaidByEmail, setTmcPaidByEmail] = useState({});
  const [editing, setEditing] = useState(null);
  const [editForm, setEditForm] = useState({ name: '', email: '', company: '', title: '', source: '' });
  const [editSaving, setEditSaving] = useState(false);
  // #600 — Initial source defaults differ per vertical: wellness leads
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
  });

  const fetchLeads = () => {
    setLoading(true);
    fetchApi('/api/contacts?status=Lead')
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
      // Booking value from itineraries — show what the customer has actually paid.
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
      // Fetch TMC paid instalment totals keyed by parent email — covers leads
      // whose parent contact has no Itinerary row (common for TMC school trips).
      fetchApi('/api/travel/trip-billing/paid-by-contact')
        .then(res => setTmcPaidByEmail(res?.byEmail || {}))
        .catch(() => setTmcPaidByEmail({}));
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // #600 — load wellness service catalogue + clinic locations only when the
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

  // #892 — close the Create drawer on Escape. Attached only while the drawer
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

    // #557 (HI-08) — client-side hardening. Order:
    //   1. Trim required fields + reject whitespace-only (preserves #337).
    //   2. Per-field length caps (rejects, doesn't silently truncate, so the
    //      user knows they need to shorten the input).
    //   3. Control-character rejection (NUL, BEL, VT, DEL, etc.) — these are
    //      never legitimate in name/email/company/title and usually signal a
    //      paste-from-malicious-source.
    //   4. HTML/script tag pre-strip (defence-in-depth — backend's
    //      sanitizeBody also strips, but surfacing a notice is better UX
    //      than the user wondering why their input looks different).
    //   5. Email shape sanity check (cheap regex — backend stays the source
    //      of truth for the strict validation).
    // The backend at routes/contacts.js + sanitizeBody is still the source
    // of truth; these are just guard rails for fast feedback.
    const trimmedName = (newLead.name || '').trim();
    if (trimmedName.length < 1) {
      // #337: reject whitespace-only names. Toast via global notify helper.
      notify.error('Name is required');
      return;
    }

    // 2. Length caps — match backend Contact column limits (191) for name/
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

    // 4. HTML/script tag pre-strip — surface what was removed so the user
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
    // whitespace (e.g. the user submitted JUST `<img onerror=…>`). Use
    // nullish-coalesce, NOT logical-OR, so an empty-string result of the
    // strip falls through to the empty-name guard rather than reverting
    // to the un-stripped original.
    const finalName = String(stripped.name ?? trimmedName).trim();
    if (finalName.length < 1) {
      notify.error('Name is required');
      return;
    }

    // 5. Email shape — basic regex (matches backend lib/validateContactInput
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
    //   wellness — required, validated against Indian-mobile pattern
    //   travel   — optional, free-form (prepend country code if provided)
    //   generic  — optional, free-form (prepend country code if provided)
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
      // the +91-optional regex above — store as-is.
      const phoneOut = isWellness
        ? phone
        : (newLead.phone ? `${newLead.countryCode} ${newLead.phone}` : '');
      await fetchApi('/api/contacts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...newLead, name: trimmedName, phone: phoneOut, countryCode: undefined }),
      });
      setNewLead({ name: '', email: '', company: '', title: '', countryCode: '+1', phone: '', source: 'Organic', status: 'Lead' });
      // #892 — close the drawer on successful create; the list refresh
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

  const filteredLeads = leads.filter(lead => {
    const term = searchTerm.toLowerCase();
    const matchesSearch = (
      lead.name.toLowerCase().includes(term) ||
      (lead.email && lead.email.toLowerCase().includes(term)) ||
      (lead.company && lead.company.toLowerCase().includes(term))
    );
    const matchesSource = !sourceFilter || (lead.source || '').toLowerCase() === sourceFilter.toLowerCase();
    const matchesSubBrand = !subBrandFilter || (lead.subBrand || '') === subBrandFilter;
    // Stage filter: match against the contact's linked deal stage slugs
    const matchesStage = !stageFilter || (dealsByContact[lead.id] || []).some(
      d => (d.stage || '') === stageFilter
    );
    return matchesSearch && matchesSource && matchesSubBrand && matchesStage;
  });

  // Source chip options and counts derived from the full unfiltered leads list
  const sourceOptions = isTravel ? TRAVEL_SOURCE_OPTIONS : isWellness ? WELLNESS_SOURCE_OPTIONS : SOURCE_OPTIONS.map(s => ({ value: s, label: s }));
  const sourceCounts = leads.reduce((acc, lead) => {
    const src = (lead.source || '').toLowerCase();
    acc[src] = (acc[src] || 0) + 1;
    return acc;
  }, {});


  return (
    <div style={{ padding: '2rem', animation: 'fadeIn 0.3s ease' }}>
      <style>{`
        .leads-table-wrapper {
          overflow-x: auto;
        }
        .leads-table {
          width: 100%;
        }
      `}</style>
      <header style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '2rem' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
          <UserPlus size={24} style={{ color: 'var(--primary-color, var(--accent-color))' }} />
          <div>
            <h2 style={{ fontSize: '1.5rem', fontWeight: 'bold' }}>Leads</h2>
            <p style={{ color: 'var(--text-secondary)', fontSize: '0.875rem' }}>
              {searchTerm
                ? `${filteredLeads.length} of ${leads.length} lead${leads.length !== 1 ? 's' : ''} match "${searchTerm}"`
                : `${leads.length} lead${leads.length !== 1 ? 's' : ''} in pipeline`}
            </p>
          </div>
        </div>
        {/* #892 — Create Lead is now a header CTA + drawer (was an inline
            always-visible form to the left of the table). Right-aligned so
            it sits alongside future header controls; primary styling per
            the c031ba0 travel/Leads pattern. */}
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <button
            type="button"
            onClick={fetchLeads}
            style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '0.5rem 0.875rem', borderRadius: 6, fontWeight: 500, fontSize: '0.875rem', background: 'var(--surface-color)', color: 'var(--text-secondary)', border: '1px solid var(--border-color)', cursor: 'pointer' }}
            aria-label="Refresh leads"
          >
            <RefreshCw size={14} /> Refresh
          </button>
          <button
            type="button"
            className="btn-primary"
            onClick={openCreate}
            style={{ display: 'inline-flex', alignItems: 'center', gap: '0.5rem', padding: '0.5rem 1rem', fontSize: '0.875rem' }}
            aria-label="Create a new lead"
          >
            <Plus size={16} />
            Create Lead
          </button>
        </div>
      </header>

      {/* Bulk Assign Bar — admin only */}
      {isAdmin && selectedLeads.length > 0 && (
        <div className="card" style={{ padding: '0.75rem 1.25rem', marginBottom: '1rem', display: 'flex', alignItems: 'center', gap: '1rem', background: 'rgba(59, 130, 246, 0.08)', border: '1px solid rgba(59, 130, 246, 0.2)', flexWrap: 'wrap' }}>
          <Users size={18} color="var(--primary-color, var(--accent-color))" />
          <span style={{ fontWeight: '500', fontSize: '0.875rem' }}>{selectedLeads.length} lead{selectedLeads.length !== 1 ? 's' : ''} selected</span>
          <select
            className="input-field"
            value={bulkAgent}
            onChange={e => setBulkAgent(e.target.value)}
            style={{ width: '200px', padding: '0.5rem' }}
          >
            <option value="">Unassign</option>
            {staff.map(s => (
              <option key={s.id} value={s.id}>{s.name || s.email}</option>
            ))}
          </select>
          <button className="btn-primary" onClick={handleBulkAssign} style={{ padding: '0.5rem 1rem', fontSize: '0.875rem' }}>
            <UserCheck size={15} style={{ marginRight: '0.375rem', verticalAlign: 'middle' }} />
            Assign
          </button>
          {/* #334: Clear must (a) drop the underlying selection so checkbox
              rows un-tick, AND (b) reset the bulk-agent dropdown so a
              re-selection doesn't pick up the previously-chosen agent.
              One handler, both effects, so the action bar's hidden state
              and the row state stay in lock-step. */}
          <button onClick={() => { setSelectedLeads([]); setBulkAgent(''); }} style={{ background: 'none', border: 'none', color: 'var(--text-secondary)', cursor: 'pointer', fontSize: '0.875rem' }}>
            Clear
          </button>
        </div>
      )}

      {/* Source filter chips — travel vertical shows travel-specific sources */}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 12, padding: 8, borderRadius: 8, background: 'var(--subtle-bg, rgba(255,255,255,0.04))', border: '1px solid var(--border-color)' }} role="toolbar" aria-label="Filter by source">
        <button
          type="button"
          onClick={() => setSourceFilter('')}
          style={!sourceFilter ? chipActiveStyle : chipStyle}
          aria-pressed={!sourceFilter}
        >
          All <span style={chipCountStyle}>{leads.length}</span>
        </button>
        {sourceOptions.map(opt => {
          const val = opt.value || opt;
          const label = opt.label || opt;
          const count = sourceCounts[(val || '').toLowerCase()] || 0;
          return (
            <button
              key={val}
              type="button"
              onClick={() => setSourceFilter(sourceFilter === val ? '' : val)}
              style={sourceFilter === val ? chipActiveStyle : chipStyle}
              aria-pressed={sourceFilter === val}
            >
              {label} <span style={chipCountStyle}>{count}</span>
            </button>
          );
        })}
      </div>

      {/* Sub-brand + Stage filter bar — travel vertical only, synced with pipeline stages */}
      {isTravel && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: 12, marginBottom: 12, background: 'var(--subtle-bg, rgba(255,255,255,0.04))', borderRadius: 8, border: '1px solid var(--border-color)' }}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ color: 'var(--text-secondary)', flexShrink: 0 }}><polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3"/></svg>
          <select
            value={subBrandFilter}
            onChange={e => setSubBrandFilter(e.target.value)}
            style={filterSelectStyle}
            aria-label="Filter by sub-brand"
          >
            <option value="">All sub-brands</option>
            <option value="tmc">TMC</option>
            <option value="rfu">RFU</option>
            <option value="travelstall">Travel Stall</option>
            <option value="visasure">Visa Sure</option>
          </select>
          <select
            value={stageFilter}
            onChange={e => setStageFilter(e.target.value)}
            style={filterSelectStyle}
            aria-label="Filter by stage"
          >
            <option value="">All stages</option>
            {pipelineStages.length > 0
              ? pipelineStages.map(s => {
                  const slug = String(s.name || '').toLowerCase().trim().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
                  return <option key={s.id} value={slug}>{s.name}</option>;
                })
              : ['Lead', 'Contacted', 'Proposal', 'Won', 'Lost'].map(s => (
                  <option key={s} value={s.toLowerCase()}>{s}</option>
                ))
            }
          </select>
          <span style={{ color: 'var(--text-secondary)', fontSize: 12, marginLeft: 'auto' }}>
            {filteredLeads.length} {filteredLeads.length === 1 ? 'lead' : 'leads'}
          </span>
        </div>
      )}

      {/* #892 — Leads Table (full-width; Create Lead form now lives in the
          drawer below, triggered by the header CTA). */}
      <div className="card leads-table-wrapper" style={{ overflow: 'visible' }}>
          <div style={{ padding: '1rem', borderBottom: '1px solid var(--border-color)' }}>
            <div style={{ position: 'relative', maxWidth: '300px' }}>
              <Search size={18} style={{ position: 'absolute', left: '1rem', top: '50%', transform: 'translateY(-50%)', color: 'var(--text-secondary)' }} />
              <input
                type="text"
                className="input-field"
                placeholder="Search leads..."
                value={searchTerm}
                onChange={e => setSearchTerm(e.target.value)}
                style={{ paddingLeft: '2.5rem', backgroundColor: 'var(--surface-hover)' }}
              />
            </div>
          </div>

          <div style={{ overflowX: 'auto' }}>
          <table className="leads-table" style={{ width: '100%', minWidth: '900px', borderCollapse: 'collapse', textAlign: 'left' }}>
            <thead>
              <tr style={{ borderBottom: '1px solid var(--border-color)', backgroundColor: 'var(--table-header-bg)' }}>
                {isAdmin && (
                  <th style={{ padding: '1rem', width: '40px' }}>
                    <input type="checkbox" checked={selectedLeads.length === filteredLeads.length && filteredLeads.length > 0} onChange={toggleSelectAll} style={{ cursor: 'pointer' }} />
                  </th>
                )}
                <th style={{ padding: '1rem', color: 'var(--text-secondary)', fontWeight: '500', fontSize: '0.875rem' }}>Name</th>
                <th style={{ padding: '1rem', color: 'var(--text-secondary)', fontWeight: '500', fontSize: '0.875rem' }}>Email</th>
                <th style={{ padding: '1rem', color: 'var(--text-secondary)', fontWeight: '500', fontSize: '0.875rem' }}>{isTravel ? 'Category' : 'Company'}</th>
                <th style={{ padding: '1rem', color: 'var(--text-secondary)', fontWeight: '500', fontSize: '0.875rem' }}>Phone</th>
                {/* #593: rules-based score (leadScoringEngine.js); dropped misleading "AI" prefix. */}
                <th style={{ padding: '1rem', color: 'var(--text-secondary)', fontWeight: '500', fontSize: '0.875rem' }}>Lead Score</th>
                <th style={{ padding: '1rem', color: 'var(--text-secondary)', fontWeight: '500', fontSize: '0.875rem' }}>Source</th>
                {isTravel && <th style={{ padding: '1rem', color: 'var(--text-secondary)', fontWeight: '500', fontSize: '0.875rem' }}>Sub-brand</th>}
                {isTravel && <th style={{ padding: '1rem', color: 'var(--text-secondary)', fontWeight: '500', fontSize: '0.875rem' }}>Amount</th>}
                <th style={{ padding: '1rem', color: 'var(--text-secondary)', fontWeight: '500', fontSize: '0.875rem' }}>Assigned To</th>
                <th style={{ padding: '1rem', color: 'var(--text-secondary)', fontWeight: '500', fontSize: '0.875rem' }}>Created</th>
                <th style={{ padding: '1rem', color: 'var(--text-secondary)', fontWeight: '500', fontSize: '0.875rem' }}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr><td colSpan={isAdmin ? 10 + (isTravel ? 2 : 0) : 9 + (isTravel ? 2 : 0)} style={{ padding: '2rem', textAlign: 'center', color: 'var(--text-secondary)' }}>Loading leads...</td></tr>
              ) : filteredLeads.length === 0 ? (
                <tr><td colSpan={isAdmin ? 10 + (isTravel ? 2 : 0) : 9 + (isTravel ? 2 : 0)} style={{ padding: '2rem', textAlign: 'center', color: 'var(--text-secondary)' }}>No leads found</td></tr>
              ) : filteredLeads.map(lead => (
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
                  <td style={{ padding: '1rem', color: 'var(--text-secondary)' }}>{lead.email}</td>
                  <td style={{ padding: '1rem', color: 'var(--text-secondary)' }}>{lead.company || <span style={{ color: 'var(--border-color)' }}>—</span>}</td>
                  <td style={{ padding: '1rem', color: 'var(--text-secondary)', fontSize: '0.875rem', whiteSpace: 'nowrap' }}>
                    {lead.phone || <span style={{ color: 'var(--border-color)' }}>—</span>}
                  </td>
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
                  <td style={{ padding: '1rem' }}>
                    <span style={{
                      padding: '0.25rem 0.75rem',
                      borderRadius: '999px',
                      fontSize: '0.75rem',
                      backgroundColor: 'rgba(139, 92, 246, 0.1)',
                      color: 'var(--primary-color, var(--accent-color, #8b5cf6))',
                      whiteSpace: 'nowrap',
                      display: 'inline-block',
                    }}>
                      {lead.source || 'Organic'}
                    </span>
                  </td>
                  {isTravel && (
                    <td style={{ padding: '1rem' }}>
                      {lead.subBrand ? (
                        <span style={{ padding: '2px 8px', borderRadius: 4, fontSize: 11, fontWeight: 600, background: 'var(--subtle-bg-3, rgba(99,102,241,0.1))', color: 'var(--primary-color, var(--accent-color))', textTransform: 'uppercase', letterSpacing: 0.5 }}>
                          {lead.subBrand}
                        </span>
                      ) : <span style={{ color: 'var(--text-secondary)' }}>—</span>}
                    </td>
                  )}
                  {isTravel && (() => {
                    // 1. Itinerary advancePaidAmount (highest fidelity — set by sync/webhook)
                    const bv = bookingValueByContact[lead.id];
                    if (bv && bv.value > 0) {
                      return (
                        <td style={{ padding: '1rem', fontWeight: 500, fontSize: '0.875rem' }} title="Amount paid — from instalment payments">
                          {bv.currency || 'INR'} {Number(bv.value).toLocaleString()}
                        </td>
                      );
                    }
                    // 2. TMC instalment paid totals keyed by parent email — covers leads
                    // whose parent contact has no itinerary row (common for school trips).
                    const tmcEntry = tmcPaidByEmail[lead.email];
                    if (tmcEntry && tmcEntry.paidTotal > 0) {
                      return (
                        <td style={{ padding: '1rem', fontWeight: 500, fontSize: '0.875rem' }} title="Amount paid via TMC instalments">
                          {tmcEntry.currency || 'INR'} {Number(tmcEntry.paidTotal).toLocaleString()}
                        </td>
                      );
                    }
                    const deals = dealsByContact[lead.id] || [];
                    const total = deals.reduce((s, d) => s + (Number(d.amount) || 0), 0);
                    const currency = deals[0]?.currency || 'INR';
                    return (
                      <td style={{ padding: '1rem', fontWeight: 500, fontSize: '0.875rem' }}>
                        {total > 0 ? `${currency} ${total.toLocaleString()}` : <span style={{ color: 'var(--text-secondary)' }}>—</span>}
                      </td>
                    );
                  })()}
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
                  <td style={{ padding: '1rem', color: 'var(--text-secondary)', fontSize: '0.875rem' }}>
                    {formatDate(lead.createdAt)}
                  </td>
                  <td style={{ padding: '1rem', whiteSpace: 'nowrap' }} onClick={e => e.stopPropagation()}>
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
          </div>
        </div>

        {/* #892 — Create Lead drawer. Mounted only when `creating` is true.
            Close triggers: X button, ESC keypress (handled by the useEffect
            above), and clicking on the dark overlay outside the drawer body.
            The form fields + submit handler are unchanged from the previous
            inline form — only the trigger surface moved. */}
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
                {/* Phone field — required for wellness (Indian mobile validation),
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

                {/* #600 — wellness extras: treatment of interest (dropdown of
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
                <input type="text" placeholder="Full Name" required className="input-field" value={editForm.name} onChange={e => setEditForm({ ...editForm, name: e.target.value })} />
                <input type="email" placeholder="Email Address" className="input-field" value={editForm.email} onChange={e => setEditForm({ ...editForm, email: e.target.value })} />
                <input type="text" placeholder="Company" className="input-field" value={editForm.company} onChange={e => setEditForm({ ...editForm, company: e.target.value })} />
                <input type="text" placeholder="Job Title" className="input-field" value={editForm.title} onChange={e => setEditForm({ ...editForm, title: e.target.value })} />
                <select className="input-field" value={editForm.source} onChange={e => setEditForm({ ...editForm, source: e.target.value })}>
                  {isWellness
                    ? WELLNESS_SOURCE_OPTIONS.map(opt => <option key={opt.value} value={opt.value}>{opt.label}</option>)
                    : isTravel
                    ? TRAVEL_SOURCE_OPTIONS.map(opt => <option key={opt.value} value={opt.value}>{opt.label}</option>)
                    : SOURCE_OPTIONS.map(s => <option key={s} value={s}>{s}</option>)
                  }
                </select>
                <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '0.5rem', marginTop: '0.5rem' }}>
                  <button type="button" onClick={() => setEditing(null)} style={{ padding: '0.5rem 1rem', borderRadius: 6, border: '1px solid var(--border-color)', background: 'var(--surface-color)', color: 'var(--text-secondary)', cursor: 'pointer', fontSize: '0.875rem' }}>Cancel</button>
                  <button type="submit" className="btn-primary" disabled={editSaving} style={{ padding: '0.5rem 1rem', fontSize: '0.875rem' }}>{editSaving ? 'Saving…' : 'Save Changes'}</button>
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
const filterSelectStyle = {
  padding: '6px 10px', borderRadius: 6, fontSize: 13,
  border: '1px solid var(--border-color)',
  background: 'var(--surface-color)', color: 'var(--text-primary)',
  minWidth: 140,
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
