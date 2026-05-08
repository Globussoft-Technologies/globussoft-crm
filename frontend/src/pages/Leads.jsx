import { fetchApi } from '../utils/api';
import { useNotify } from '../utils/notify';
import { formatDateMedium as formatDate } from '../utils/date';
import React, { useState, useEffect, useContext } from 'react';
import { useNavigate } from 'react-router-dom';
import { UserPlus, Search, ArrowRightCircle, UserCheck, Users } from 'lucide-react';
import { AuthContext } from '../App';

const SOURCE_OPTIONS = ['Organic', 'Referral', 'LinkedIn', 'Cold Call', 'Website', 'Event', 'Other'];
const FIELD_LIMITS = { name: 191, email: 191, company: 191, title: 200, phone: 20 };
const CONTROL_CHAR_RE = /[\t\n\r\f\v]/;
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
  const [leads, setLeads] = useState([]);
  const [staff, setStaff] = useState([]);
  const [services, setServices] = useState([]);
  const [locations, setLocations] = useState([]);
  const [loading, setLoading] = useState(true);
  const [searchTerm, setSearchTerm] = useState('');
  const [selectedLeads, setSelectedLeads] = useState([]);
  const [bulkAgent, setBulkAgent] = useState('');
  const [newLead, setNewLead] = useState({
    name: '',
    email: '',
    phone: '',
    company: '',
    title: '',
    countryCode: '+1',
    phone: '',
    source: 'Organic',
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
  }, []);

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

    // #600 — phone is REQUIRED on wellness leads (mirrors Patients.jsx
    // intake), shape-checked against the Indian-mobile pattern. Generic
    // tenants pass through whatever the user typed (free-form, optional).
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
      const phoneWithCode = newLead.phone ? `${newLead.countryCode} ${newLead.phone}` : '';
      await fetchApi('/api/contacts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...newLead, name: trimmedName, phone: phoneWithCode, countryCode: undefined }),
      });
      setNewLead({ name: '', email: '', company: '', title: '', countryCode: '+1', phone: '', source: 'Organic', status: 'Lead' });
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
    return (
      lead.name.toLowerCase().includes(term) ||
      (lead.email && lead.email.toLowerCase().includes(term)) ||
      (lead.company && lead.company.toLowerCase().includes(term))
    );
  });


  return (
    <div style={{ padding: '2rem', animation: 'fadeIn 0.3s ease' }}>
      <style>{`
        .leads-table-wrapper {
          overflow-x: auto;
        }
        .leads-table {
          width: 100%;
        }
        @media (min-width: 1600px) {
          .leads-layout {
            grid-template-columns: 340px 1fr !important;
          }
        }
        @media (max-width: 1599px) {
          .leads-layout {
            grid-template-columns: 1fr !important;
          }
        }
      `}</style>
      <header style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '2rem' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
          <UserPlus size={24} style={{ color: 'var(--accent-color)' }} />
          <div>
            <h2 style={{ fontSize: '1.5rem', fontWeight: 'bold' }}>Leads</h2>
            <p style={{ color: 'var(--text-secondary)', fontSize: '0.875rem' }}>
              {leads.length} lead{leads.length !== 1 ? 's' : ''} in pipeline
            </p>
          </div>
        </div>
      </header>

      {/* Bulk Assign Bar */}
      {selectedLeads.length > 0 && (
        <div className="card" style={{ padding: '0.75rem 1.25rem', marginBottom: '1rem', display: 'flex', alignItems: 'center', gap: '1rem', background: 'rgba(59, 130, 246, 0.08)', border: '1px solid rgba(59, 130, 246, 0.2)', flexWrap: 'wrap' }}>
          <Users size={18} color="var(--accent-color)" />
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

      <div className="leads-layout" style={{ display: 'grid', gridTemplateColumns: '340px 1fr', gap: '1.5rem', alignItems: 'start' }}>
        {/* Left Panel: Create Lead Form */}
        <div className="card" style={{ padding: '1.5rem' }}>
          <h3 style={{ fontSize: '1.1rem', fontWeight: '600', marginBottom: '1.25rem' }}>Create Lead</h3>
          <form onSubmit={handleCreateLead} style={{ display: 'flex', flexDirection: 'column', gap: '0.875rem' }}>
            <input type="text" placeholder="Full Name" required className="input-field" value={newLead.name} onChange={e => handleChange('name', e.target.value)} />
            <input type="email" placeholder="Email Address" required className="input-field" value={newLead.email} onChange={e => handleChange('email', e.target.value)} />
            <input type="text" placeholder="Company" className="input-field" value={newLead.company} onChange={e => handleChange('company', e.target.value)} />
            <input type="text" placeholder="Job Title" className="input-field" value={newLead.title} onChange={e => handleChange('title', e.target.value)} />
            <div style={{ display: 'flex', gap: '0.5rem' }}>
              <select className="input-field" value={newLead.countryCode} onChange={e => handleChange('countryCode', e.target.value)} style={{ width: '100px' }}>
                {COUNTRY_CODES.map(cc => (
                  <option key={cc.code} value={cc.code}>{cc.code}</option>
                ))}
              </select>
              <input type="tel" placeholder="Phone Number" className="input-field" value={newLead.phone} onChange={e => handleChange('phone', e.target.value)} style={{ flex: 1 }} />
            </div>
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

            <button type="submit" className="btn-primary" style={{ marginTop: '0.5rem' }}>
              Add Lead
            </button>
          </form>
        </div>

        {/* Right Panel: Leads Table */}
        <div className="card leads-table-wrapper" style={{ overflow: 'hidden' }}>
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

          <table className="leads-table" style={{ width: '100%', borderCollapse: 'collapse', textAlign: 'left' }}>
            <thead>
              <tr style={{ borderBottom: '1px solid var(--border-color)', backgroundColor: 'var(--table-header-bg)' }}>
                <th style={{ padding: '1rem', width: '40px' }}>
                  <input type="checkbox" checked={selectedLeads.length === filteredLeads.length && filteredLeads.length > 0} onChange={toggleSelectAll} style={{ cursor: 'pointer' }} />
                </th>
                <th style={{ padding: '1rem', color: 'var(--text-secondary)', fontWeight: '500', fontSize: '0.875rem' }}>Name</th>
                <th style={{ padding: '1rem', color: 'var(--text-secondary)', fontWeight: '500', fontSize: '0.875rem' }}>Email</th>
                <th style={{ padding: '1rem', color: 'var(--text-secondary)', fontWeight: '500', fontSize: '0.875rem' }}>Company</th>
                {/* #593: rules-based score (leadScoringEngine.js); dropped misleading "AI" prefix. */}
                <th style={{ padding: '1rem', color: 'var(--text-secondary)', fontWeight: '500', fontSize: '0.875rem' }}>Lead Score</th>
                <th style={{ padding: '1rem', color: 'var(--text-secondary)', fontWeight: '500', fontSize: '0.875rem' }}>Source</th>
                <th style={{ padding: '1rem', color: 'var(--text-secondary)', fontWeight: '500', fontSize: '0.875rem' }}>Assigned To</th>
                <th style={{ padding: '1rem', color: 'var(--text-secondary)', fontWeight: '500', fontSize: '0.875rem' }}>Created</th>
                <th style={{ padding: '1rem', color: 'var(--text-secondary)', fontWeight: '500', fontSize: '0.875rem', textAlign: 'right' }}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr><td colSpan="9" style={{ padding: '2rem', textAlign: 'center', color: 'var(--text-secondary)' }}>Loading leads...</td></tr>
              ) : filteredLeads.length === 0 ? (
                <tr><td colSpan="9" style={{ padding: '2rem', textAlign: 'center', color: 'var(--text-secondary)' }}>No leads found</td></tr>
              ) : filteredLeads.map(lead => (
                <tr
                  key={lead.id}
                  style={{ borderBottom: '1px solid var(--border-color)', cursor: 'pointer' }}
                  className="table-row-hover"
                  onClick={() => navigate(`/contacts/${lead.id}`)}
                  title="Open lead detail"
                >
                  <td style={{ padding: '1rem' }} onClick={e => e.stopPropagation()}>
                    <input type="checkbox" checked={selectedLeads.includes(lead.id)} onChange={() => toggleSelect(lead.id)} style={{ cursor: 'pointer' }} />
                  </td>
                  <td style={{ padding: '1rem', fontWeight: '500' }}>{lead.name}</td>
                  <td style={{ padding: '1rem', color: 'var(--text-secondary)' }}>{lead.email}</td>
                  <td style={{ padding: '1rem', color: 'var(--text-secondary)' }}>{lead.company}</td>
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
                      color: '#8b5cf6',
                      whiteSpace: 'nowrap',
                      display: 'inline-block',
                    }}>
                      {lead.source || 'Organic'}
                    </span>
                  </td>
                  <td style={{ padding: '1rem' }} onClick={e => e.stopPropagation()}>
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
                  </td>
                  <td style={{ padding: '1rem', color: 'var(--text-secondary)', fontSize: '0.875rem' }}>
                    {formatDate(lead.createdAt)}
                  </td>
                  <td style={{ padding: '1rem', textAlign: 'right' }} onClick={e => e.stopPropagation()}>
                    <button
                      onClick={() => handleConvert(lead.id)}
                      title="Convert to Customer"
                      style={{
                        background: 'none',
                        border: 'none',
                        color: 'var(--success-color)',
                        cursor: 'pointer',
                        display: 'inline-flex',
                        alignItems: 'center',
                        gap: '0.375rem',
                        fontSize: '0.8rem',
                        fontWeight: '500',
                      }}
                    >
                      <ArrowRightCircle size={16} />
                      Convert
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
};

export default Leads;
