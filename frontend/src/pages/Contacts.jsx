import { fetchApi } from '../utils/api';
import { useNotify } from '../utils/notify';
import { formatDateMedium as formatDate } from '../utils/date';
import React, { useState, useEffect, useContext } from 'react';
import { Search, Plus, Trash2, Pencil, RefreshCw, TrendingUp, Upload, X, FileSpreadsheet, UserCheck, Users, GitMerge, EyeOff } from 'lucide-react';
import { Link } from 'react-router-dom';
import DuplicateContactModal from '../components/DuplicateContactModal';
import ColumnPicker from '../components/ColumnPicker';
import TopScrollSync from '../components/TopScrollSync';
import SavedViewsBar from '../components/SavedViewsBar';
import ScrollableSelect from '../components/ScrollableSelect';
import InlineCellEditor from '../components/InlineCellEditor';
import EditContactModal from '../components/EditContactModal';
import { AuthContext } from '../App';
import { accessibleSubBrands } from '../utils/travelSubBrand';

const parseCSV = (text) => {
  const lines = text.split(/\r?\n/).filter(l => l.trim());
  if (lines.length < 2) return [];
  const headers = lines[0].split(',').map(h => h.trim().toLowerCase().replace(/['"]/g, ''));
  return lines.slice(1).map(line => {
    // Handle quoted values with commas
    const values = [];
    let current = '';
    let inQuotes = false;
    for (let i = 0; i < line.length; i++) {
      if (line[i] === '"') { inQuotes = !inQuotes; continue; }
      if (line[i] === ',' && !inQuotes) { values.push(current.trim()); current = ''; continue; }
      current += line[i];
    }
    values.push(current.trim());
    const row = {};
    // #154: track column-count mismatch so the preview can flag short/long rows
    row.__columnCount = values.length;
    row.__expectedCount = headers.length;
    headers.forEach((h, i) => { row[h] = values[i] || ''; });
    return row;
  });
};

// Excel (.xlsx/.xls) import — reads the first sheet, treats row 1 as headers,
// and produces the exact same row shape parseCSV does (lowercased header
// keys, string values, __columnCount/__expectedCount for the same
// short/long-row validation) so the preview + validateCsvRow + handleImport
// code paths stay format-blind below this point.
// `xlsx` (SheetJS) is dynamically imported here rather than at module scope
// — it's a ~350KB library that only a small fraction of visitors to this
// page will ever need (only those who click Import CSV/Excel AND choose an
// .xlsx/.xls file), so keeping it out of Contacts.jsx's main code-split
// chunk avoids a multi-hundred-KB hit on every Contacts page load.
const parseExcel = async (arrayBuffer) => {
  const XLSX = await import('xlsx');
  const wb = XLSX.read(arrayBuffer, { type: 'array' });
  const firstSheetName = wb.SheetNames[0];
  if (!firstSheetName) return [];
  const ws = wb.Sheets[firstSheetName];
  const aoa = XLSX.utils.sheet_to_json(ws, { header: 1, raw: false, defval: '' });
  if (aoa.length < 2) return [];
  const headers = (aoa[0] || []).map(h => String(h ?? '').trim().toLowerCase().replace(/['"]/g, ''));
  return aoa.slice(1)
    .filter(cells => cells.some(c => String(c ?? '').trim() !== '')) // skip blank trailing rows
    .map(cells => {
      const row = {};
      row.__columnCount = cells.length;
      row.__expectedCount = headers.length;
      headers.forEach((h, i) => { row[h] = String(cells[i] ?? '').trim(); });
      return row;
    });
};

// #154: same validation rules as backend, run client-side so the user sees row
// errors in the preview before clicking Import.
const ALLOWED_STATUSES = new Set(['Lead', 'Prospect', 'Customer', 'Churned', 'Junk']);
const EMAIL_RE = /^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]{2,}$/;
const PHONE_RE = /^\+?[\d\s\-().]{7,15}$/;
const FORMULA_INJECTION_RE = /^[=+\-@\t\r]/;

function validateCsvRow(row) {
  const issues = [];
  if (row.__columnCount !== row.__expectedCount) {
    issues.push(`column count ${row.__columnCount} vs expected ${row.__expectedCount}`);
  }
  const email = String(row.email || row.Email || '').trim();
  if (!email) issues.push('missing email');
  else if (!EMAIL_RE.test(email)) issues.push('invalid email');
  const status = String(row.status || row.Status || 'Lead').trim();
  if (!ALLOWED_STATUSES.has(status)) issues.push(`invalid status "${status}"`);
  const name = String(row.name || row.Name || '');
  const company = String(row.company || row.Company || '');
  if (FORMULA_INJECTION_RE.test(name)) issues.push('name starts with formula char (will be sanitized)');
  if (FORMULA_INJECTION_RE.test(company)) issues.push('company starts with formula char (will be sanitized)');
  return issues;
}

const Contacts = () => {
  const notify = useNotify();
  const [contacts, setContacts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showModal, setShowModal] = useState(false);
  const [newContact, setNewContact] = useState({ name: '', email: '', phone: '', company: '', title: '', status: 'Lead' });
  const [showImportModal, setShowImportModal] = useState(false);
  const [csvRows, setCsvRows] = useState([]);
  const [csvHeaders, setCsvHeaders] = useState([]);
  const [importResult, setImportResult] = useState(null);
  const [importing, setImporting] = useState(false);

  const [staff, setStaff] = useState([]);
  // Travel vertical only — the Assigned-To dropdown is brand-scoped so a lead
  // can only be assigned to staff who have access to its sub-brand. Generic /
  // wellness tenants (isTravel false) keep the full unfiltered list.
  const { tenant, user } = useContext(AuthContext) || {};
  const isTravel = tenant?.vertical === 'travel';
  const isWellness = tenant?.vertical === 'wellness';
  const isAdmin = user?.role === 'ADMIN';
  // Bulk-select + bulk-assign — mirrors Leads.jsx exactly, same backend
  // endpoint (/api/contacts/bulk-assign), so this works unmodified across
  // all three verticals (generic/wellness/travel) with no gating beyond
  // the existing ADMIN-only role check.
  const [selectedContacts, setSelectedContacts] = useState([]);
  const [bulkAgent, setBulkAgent] = useState('');
  // Generic-vertical-only "Saved Views" — a named fixed list of contact IDs
  // (see components/SavedViewsBar.jsx). activeViewId null = "All Contacts"
  // (no filtering). activeViewMemberIds is the fetched membership of
  // whichever view is currently selected.
  const [activeViewId, setActiveViewId] = useState(null);
  const [activeViewMemberIds, setActiveViewMemberIds] = useState(null);
  useEffect(() => {
    if (isWellness || isTravel || activeViewId == null) {
      setActiveViewMemberIds(null);
      return;
    }
    fetchApi(`/api/contact-views/${activeViewId}/members`)
      .then(d => setActiveViewMemberIds(new Set(Array.isArray(d.contactIds) ? d.contactIds : [])))
      .catch(() => setActiveViewMemberIds(new Set()));
  }, [activeViewId, isWellness, isTravel]);
  // Generic-vertical-only Lead custom fields (Settings > Lead Fields).
  const [customFieldDefs, setCustomFieldDefs] = useState([]);
  // Generic-vertical-only "Customize table" column-visibility picker
  // (personal per-user preference — see components/ColumnPicker.jsx).
  // null = "not loaded yet, show every builtin column".
  const [visibleColumns, setVisibleColumns] = useState(null);
  const isColVisible = (key) => {
    if (isWellness || isTravel || visibleColumns === null) return true;
    return visibleColumns.includes(key);
  };
  const assignableStaff = (contact) => {
    if (!isTravel || !contact?.subBrand) return staff;
    return staff.filter(
      (s) => accessibleSubBrands(s).includes(contact.subBrand) || String(s.id) === String(contact.assignedToId),
    );
  };
  const [rescoring, setRescoring] = useState(false);
  const [showDupes, setShowDupes] = useState(false);
  const [dupes, setDupes] = useState([]);
  const [merging, setMerging] = useState(false);

  // #607: client-side email validation for the Add Contact form. Pre-fix the
  // form had no validator at all — invalid addresses round-tripped to the
  // server, returned a generic 400, and the user got a toast that didn't
  // point at the email field. We reuse the same EMAIL_RE the CSV importer
  // uses so the two surfaces stay consistent.
  const [emailError, setEmailError] = useState('');
  const [phoneError, setPhoneError] = useState('');

  // PRD §4.5 — duplicate-contact pop-up driven by the backend's
  // 409 DUPLICATE_CONTACT response. Backend payload populates the modal;
  // creatingContact disables the "Create anyway" button during the force-retry.
  const [dupModal, setDupModal] = useState(null);
  const [creatingContact, setCreatingContact] = useState(false);

  // Full Edit Contact modal — a second entry point alongside the inline
  // per-cell custom-field editing above, for editing everything (name,
  // email, phone, company, status, custom fields) in one place at once.
  const [editingContact, setEditingContact] = useState(null);

  // #461: search + status filter inputs were rendered without value/onChange
  // and the table read straight from `contacts`, so neither one filtered.
  // Wire both to local state and derive a filtered view client-side
  // (mirrors the existing Leads.jsx pattern). Status === 'All' = show all.
  const [searchTerm, setSearchTerm] = useState('');
  const [statusFilter, setStatusFilter] = useState('All');
  // Assigned-To + Lead Score range filters, same client-side pattern as
  // search/status above. assignedToFilter: '' = all, 'unassigned' = no
  // assignee, else a staff id (string, matches <option value>). scoreFilter:
  // '' = all, else "min-max" bucket key parsed at filter time.
  const [assignedToFilter, setAssignedToFilter] = useState('');
  const [scoreFilter, setScoreFilter] = useState('');
  const SCORE_BUCKETS = [
    { value: '0-25', label: '0 - 25', min: 0, max: 25 },
    { value: '26-50', label: '26 - 50', min: 26, max: 50 },
    { value: '51-75', label: '51 - 75', min: 51, max: 75 },
    { value: '76-100', label: '76 - 100', min: 76, max: 100 },
  ];

  const handleFindDupes = async () => {
    try {
      const data = await fetchApi('/api/contacts/duplicates/find');
      setDupes(Array.isArray(data) ? data : []);
      setShowDupes(true);
    } catch { setDupes([]); }
  };

  // #592 — Merge is destructive (irreversible from the UI; the soft-deleted
  // siblings can only be restored via the ADMIN restore endpoint). Confirm
  // before firing.
  const handleMerge = async (primaryId, secondaryIds) => {
    const ok = await notify.confirm({
      title: 'Merge duplicate contacts?',
      message: `${secondaryIds.length} duplicate contact(s) will be merged into the primary record. Activities, deals, tasks, emails and other history will be folded into the primary. The duplicate records will be removed from the list. This is irreversible from this UI.`,
      confirmText: 'Merge',
      destructive: true,
    });
    if (!ok) return;
    setMerging(true);
    try {
      await fetchApi('/api/contacts/merge', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ primaryId, secondaryIds })
      });
      handleFindDupes();
      fetchContacts();
    } catch { notify.error('Merge failed'); }
    setMerging(false);
  };

  // #592 — Dismiss a "false positive" duplicate group. The group key is a
  // stable hash of the sorted contact-id list (server-derived), so the
  // dismiss survives across re-runs of the detector. Optimistically removes
  // the group from the local list so the UI updates immediately.
  const handleDismiss = async (group) => {
    const ok = await notify.confirm({
      title: 'Dismiss this duplicate group?',
      message: 'These contacts will no longer appear in the duplicates list. You can still edit or delete them individually from the contacts table.',
      confirmText: 'Dismiss',
    });
    if (!ok) return;
    try {
      await fetchApi('/api/contacts/duplicates/dismiss', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          primaryId: group.primary.id,
          secondaryIds: group.duplicates.map(d => d.id),
        })
      });
      setDupes(prev => prev.filter(g => g !== group));
    } catch { notify.error('Dismiss failed'); }
  };

  const fetchContacts = () => {
    fetchApi('/api/contacts').then(data => {
        setContacts(Array.isArray(data) ? data : []);
        setLoading(false);
      }).catch(() => { setContacts([]); setLoading(false); });
  };

  const handleRescore = async () => {
    setRescoring(true);
    try {
      await fetchApi('/api/ai_scoring/trigger', { method: 'POST' });
      fetchContacts();
    } catch (e) {
      console.error(e);
    } finally {
      setRescoring(false);
    }
  };

  useEffect(() => {
    fetchContacts();
    fetchApi('/api/staff').then(data => setStaff(data)).catch(() => {});
  }, []);

  // Generic-vertical-only Lead custom fields (Settings > Lead Fields).
  // Own effect keyed on [isWellness, isTravel] (not the mount-only effect
  // above) so it re-fires once AuthContext's tenant finishes loading —
  // tenant can still be undefined on the very first render.
  useEffect(() => {
    if (isWellness || isTravel) return;
    fetchApi('/api/lead-custom-fields')
      .then(d => setCustomFieldDefs(Array.isArray(d) ? d : []))
      .catch(() => setCustomFieldDefs([]));
  }, [isWellness, isTravel]);

  const handleAssign = async (contactId, assignedToId) => {
    await fetchApi(`/api/contacts/${contactId}/assign`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ assignedToId: assignedToId || null }),
    });
    fetchContacts();
  };

  const handleBulkAssign = async () => {
    if (selectedContacts.length === 0) return;
    await fetchApi('/api/contacts/bulk-assign', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contactIds: selectedContacts, assignedToId: bulkAgent || null }),
    });
    setSelectedContacts([]);
    setBulkAgent('');
    fetchContacts();
  };

  const toggleSelectContact = (id) => {
    setSelectedContacts(prev =>
      prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]
    );
  };

  const toggleSelectAllContacts = () => {
    if (selectedContacts.length === visibleContacts.length) {
      setSelectedContacts([]);
    } else {
      setSelectedContacts(visibleContacts.map(c => c.id));
    }
  };

  const handleAddContact = async (e) => {
    e.preventDefault();
    // #607: block submit when the email is invalid. Surface the same inline
    // message the blur handler shows so the user sees the field-level error
    // instead of a generic server-side toast.
    const email = (newContact.email || '').trim();
    if (!email || !EMAIL_RE.test(email)) {
      setEmailError('Please enter a valid email address');
      return;
    }
    setEmailError('');
    const phone = (newContact.phone || '').trim();
    if (phone && !PHONE_RE.test(phone)) {
      setPhoneError('Enter a valid phone number (digits, +, spaces, hyphens only)');
      return;
    }
    setPhoneError('');
    await submitNewContact(false);
  };

  // Performs the actual POST. `force=true` retries past the PRD §4.5 dedup
  // preflight when the operator confirms via DuplicateContactModal.
  // On 409 DUPLICATE_CONTACT (and only the first attempt) we open the modal
  // instead of toast-erroring; any other failure falls through to a toast.
  const submitNewContact = async (force) => {
    setCreatingContact(true);
    try {
      const path = force ? '/api/contacts?force=true' : '/api/contacts';
      await fetchApi(path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(newContact),
      });
      setShowModal(false);
      setDupModal(null);
      setNewContact({ name: '', email: '', phone: '', company: '', title: '', status: 'Lead' });
      fetchContacts();
    } catch (err) {
      if (!force && err?.body?.code === 'DUPLICATE_CONTACT') {
        setDupModal({
          existingContactId: err.body.existingContactId,
          matchedBy: err.body.matchedBy,
          contact: err.body.contact,
        });
      } else {
        notify.error(err?.body?.error || 'Failed to create contact');
      }
    } finally {
      setCreatingContact(false);
    }
  };

  const handleFileSelect = (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const isExcel = /\.xlsx?$/i.test(file.name);
    const reader = new FileReader();
    reader.onload = async (ev) => {
      const rows = isExcel ? await parseExcel(ev.target.result) : parseCSV(ev.target.result);
      if (rows.length > 0) {
        setCsvHeaders(Object.keys(rows[0]));
        setCsvRows(rows);
        setImportResult(null);
      }
    };
    if (isExcel) reader.readAsArrayBuffer(file);
    else reader.readAsText(file);
  };

  const handleImport = async () => {
    if (csvRows.length === 0) return;
    setImporting(true);
    try {
      const mapped = csvRows.map(row => ({
        name: row.name || row.Name || '',
        email: row.email || row.Email || '',
        company: row.company || row.Company || '',
        title: row.title || row.Title || '',
        status: row.status || row.Status || 'Lead',
      }));
      const result = await fetchApi('/api/contacts/import-csv', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contacts: mapped })
      });
      setImportResult(result);
      fetchContacts();
    } catch (err) {
      setImportResult({ error: 'Import failed' });
    } finally {
      setImporting(false);
    }
  };

  const handleDelete = async (id) => {
    if (!await notify.confirm({
      title: 'Delete contact',
      message: 'Are you sure you want to delete this contact? This action cannot be undone.',
      confirmText: 'Delete',
      destructive: true,
    })) return;
    await fetchApi(`/api/contacts/${id}`, { method: 'DELETE' });
    fetchContacts();
  };

  // #461: derive the visible rows from `contacts` + the two filter inputs.
  // Search matches name / email / company / title (case-insensitive). The
  // dropdown supports the canonical statuses; 'All' disables status filtering.
  // A selected Saved View additionally restricts to its fixed membership
  // list — applied first so search/status still narrow within the view.
  const visibleContacts = contacts.filter((c) => {
    if (activeViewMemberIds && !activeViewMemberIds.has(c.id)) return false;
    if (statusFilter !== 'All' && c.status !== statusFilter) return false;
    if (assignedToFilter === 'unassigned' && c.assignedToId) return false;
    if (assignedToFilter && assignedToFilter !== 'unassigned' && String(c.assignedToId || '') !== assignedToFilter) return false;
    if (scoreFilter) {
      const bucket = SCORE_BUCKETS.find(b => b.value === scoreFilter);
      if (bucket && (c.aiScore < bucket.min || c.aiScore > bucket.max)) return false;
    }
    const term = searchTerm.trim().toLowerCase();
    if (!term) return true;
    return (
      (c.name || '').toLowerCase().includes(term) ||
      (c.email || '').toLowerCase().includes(term) ||
      (c.company || '').toLowerCase().includes(term) ||
      (c.title || '').toLowerCase().includes(term)
    );
  });

  // colSpan for the loading/empty-state row must track exactly how many
  // <th> render in the header above, including the generic-only optional
  // columns the "Customize table" picker can hide.
  const visibleCfCols = customFieldDefs.filter(f => isColVisible(`cf_${f.fieldKey}`)).length;
  const contactsColSpan = 2 /* Name + Actions */
    + (isAdmin ? 1 : 0) /* bulk-select checkbox column */
    + ['email', 'phone', 'company', 'aiScore', 'status', 'assignedTo', 'createdAt'].filter(isColVisible).length
    + visibleCfCols;

  return (
    <div style={{ padding: '2rem' }}>
      {/* #488: flex-wrap + gap so the action group wraps cleanly below the title
          on narrow viewports instead of stacking awkwardly over the description. */}
      <header style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '2rem', flexWrap: 'wrap', gap: '1rem' }}>
        <div style={{ minWidth: 0, flex: '1 1 240px' }}>
          <h2 style={{ fontSize: '1.5rem', fontWeight: 'bold' }}>Contacts</h2>
          {/* #143: surface the total count so the user knows what they're looking at,
              matching the parity that /wellness/patients already has. */}
          <p style={{ color: 'var(--text-secondary)', fontSize: '0.875rem' }}>
            {contacts.length.toLocaleString()} contact{contacts.length === 1 ? '' : 's'} · manage your leads and customers
          </p>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', flexWrap: 'wrap' }}>
          {/* Generic-vertical-only "Customize table" column picker — personal
              per-user preference, matches the Freshsales reference UI. */}
          {!isWellness && !isTravel && (
            <ColumnPicker tableKey="contacts" onColumnsChange={setVisibleColumns} />
          )}
          {/* Generic-vertical-only "Saved Views" — tenant-shared named lists
              of hand-picked contacts (see components/SavedViewsBar.jsx). */}
          {!isWellness && !isTravel && (
            <SavedViewsBar
              activeViewId={activeViewId}
              onSelectView={setActiveViewId}
              selectedIds={selectedContacts}
              allContacts={contacts}
            />
          )}
          <button
            onClick={handleRescore}
            disabled={rescoring}
            className="btn-secondary"
            style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', opacity: rescoring ? 0.7 : 1 }}
            title="Re-run AI scoring engine"
          >
            <RefreshCw size={15} style={{ animation: rescoring ? 'spin 1s linear infinite' : 'none' }} />
            {rescoring ? 'Scoring...' : 'AI Re-score'}
          </button>
          <button onClick={handleFindDupes} className="btn-secondary" style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <GitMerge size={15} /> Find Duplicates
          </button>
          <button onClick={() => { setShowImportModal(true); setCsvRows([]); setCsvHeaders([]); setImportResult(null); }} className="btn-secondary" style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <Upload size={15} /> Import CSV/Excel
          </button>
          <button onClick={() => setShowModal(true)} className="btn-primary" style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <Plus size={18} /> Add Contact
          </button>
        </div>
      </header>

      {/* Bulk Assign Bar — admin only, same pattern + backend endpoint as Leads.jsx */}
      {isAdmin && selectedContacts.length > 0 && (
        <div className="card" style={{ padding: '0.75rem 1.25rem', marginBottom: '1rem', display: 'flex', alignItems: 'center', gap: '1rem', background: 'rgba(59, 130, 246, 0.08)', border: '1px solid rgba(59, 130, 246, 0.2)', flexWrap: 'wrap' }}>
          <Users size={18} color="var(--primary-color, var(--accent-color))" />
          <span style={{ fontWeight: '500', fontSize: '0.875rem' }}>{selectedContacts.length} contact{selectedContacts.length !== 1 ? 's' : ''} selected</span>
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
          {/* Clear must (a) drop the underlying selection so checkbox rows
              un-tick, AND (b) reset the bulk-agent dropdown so a
              re-selection doesn't pick up the previously-chosen agent. */}
          <button onClick={() => { setSelectedContacts([]); setBulkAgent(''); }} style={{ background: 'none', border: 'none', color: 'var(--text-secondary)', cursor: 'pointer', fontSize: '0.875rem' }}>
            Clear
          </button>
        </div>
      )}

      <div className="card" style={{ overflow: 'hidden' }}>
        <div style={{ padding: '1rem', borderBottom: '1px solid var(--border-color)', display: 'flex', gap: '1rem', alignItems: 'center' }}>
          <div style={{ position: 'relative', flex: 1, maxWidth: '300px' }}>
            <Search size={18} style={{ position: 'absolute', left: '1rem', top: '50%', transform: 'translateY(-50%)', color: 'var(--text-secondary)' }} />
            <input
              type="text"
              className="input-field"
              placeholder="Search contacts..."
              value={searchTerm}
              onChange={e => setSearchTerm(e.target.value)}
              style={{ paddingLeft: '2.5rem', backgroundColor: 'var(--surface-hover)' }}
            />
          </div>
          <select
            className="input-field"
            value={statusFilter}
            onChange={e => setStatusFilter(e.target.value)}
            style={{ width: '150px' }}
          >
            <option value="All">All Statuses</option>
            <option value="Lead">Lead</option>
            <option value="Prospect">Prospect</option>
            <option value="Customer">Customer</option>
            <option value="Churned">Churned</option>
            <option value="Junk">Junk</option>
          </select>
          {/* Custom scrollable dropdown (not a native <select>) so a long
              staff list caps at ~5 visible rows and scrolls for the rest,
              instead of the browser rendering every option at once. */}
          <ScrollableSelect
            value={assignedToFilter}
            onChange={setAssignedToFilter}
            width={170}
            ariaLabel="Filter by assigned to"
            options={[
              { value: '', label: 'All Assignees' },
              { value: 'unassigned', label: 'Unassigned' },
              ...staff.map(s => ({ value: String(s.id), label: s.name || s.email })),
            ]}
          />
          <select
            className="input-field"
            value={scoreFilter}
            onChange={e => setScoreFilter(e.target.value)}
            style={{ width: '150px' }}
            aria-label="Filter by lead score"
          >
            <option value="">All Scores</option>
            {SCORE_BUCKETS.map(b => (
              <option key={b.value} value={b.value}>{b.label}</option>
            ))}
          </select>
          {(searchTerm || statusFilter !== 'All' || assignedToFilter || scoreFilter || activeViewId != null) && (
            <>
              <span style={{ fontSize: '0.8rem', color: 'var(--text-secondary)' }}>
                Showing {visibleContacts.length} of {contacts.length}
              </span>
              <button
                onClick={() => { setSearchTerm(''); setStatusFilter('All'); setAssignedToFilter(''); setScoreFilter(''); }}
                style={{ background: 'none', border: 'none', color: 'var(--accent-color)', cursor: 'pointer', fontSize: '0.8rem' }}
              >
                Clear filters
              </button>
            </>
          )}
        </div>
        
        {/* #633: stable-table — pins tableLayout=fixed so row hover never
            shifts column widths. Columns use FIXED pixel widths (not
            percentages) so a column's content (phone numbers, dates, etc.)
            gets a sane minimum instead of stretching/shrinking proportionally
            once minWidth forces the table wider than its container — that
            proportional stretch was what caused phone numbers to wrap
            awkwardly. TopScrollSync adds a second scrollbar pinned to the
            TOP of the table (mirrors the bottom one) so the user can scroll
            right from wherever they already are, without having to scroll
            all the way down the page to reach the native bottom scrollbar
            first. tableMinWidth is computed once and shared between the
            table's own minWidth and TopScrollSync's spacer so the two
            scrollbars stay in lockstep. */}
        {(() => {
          const visibleCfColsList = customFieldDefs.filter(f => isColVisible(`cf_${f.fieldKey}`));
          const colWidths = {
            name: 220, email: 220, phone: 150, company: 160,
            aiScore: 110, status: 110, assignedTo: 150, createdAt: 120,
          };
          const tableMinWidth = (isAdmin ? 40 : 0) /* bulk-select checkbox column */
            + colWidths.name
            + (isColVisible('email') ? colWidths.email : 0)
            + (isColVisible('phone') ? colWidths.phone : 0)
            + (isColVisible('company') ? colWidths.company : 0)
            + (isColVisible('aiScore') ? colWidths.aiScore : 0)
            + (isColVisible('status') ? colWidths.status : 0)
            + visibleCfColsList.length * 160
            + (isColVisible('assignedTo') ? colWidths.assignedTo : 0)
            + (isColVisible('createdAt') ? colWidths.createdAt : 0)
            + 120; /* Actions — wide enough for Edit + Delete icons and the "Actions" header without truncating */
          return (
        <TopScrollSync scrollWidth={`${tableMinWidth}px`}>
        <table className="stable-table" style={{ borderCollapse: 'collapse', textAlign: 'left', minWidth: `${tableMinWidth}px` }}>
          <colgroup>
            {isAdmin && <col style={{ width: '40px' }} />}
            <col style={{ width: `${colWidths.name}px` }} />
            {isColVisible('email') && <col style={{ width: `${colWidths.email}px` }} />}
            {isColVisible('phone') && <col style={{ width: `${colWidths.phone}px` }} />}
            {isColVisible('company') && <col style={{ width: `${colWidths.company}px` }} />}
            {isColVisible('aiScore') && <col style={{ width: `${colWidths.aiScore}px` }} />}
            {isColVisible('status') && <col style={{ width: `${colWidths.status}px` }} />}
            {visibleCfColsList.map(f => <col key={f.id} style={{ width: '160px' }} />)}
            {isColVisible('assignedTo') && <col style={{ width: `${colWidths.assignedTo}px` }} />}
            {isColVisible('createdAt') && <col style={{ width: `${colWidths.createdAt}px` }} />}
            <col style={{ width: '120px' }} />
          </colgroup>
          <thead>
            <tr style={{ borderBottom: '1px solid var(--border-color)', backgroundColor: 'var(--table-header-bg)' }}>
              {isAdmin && (
                <th style={{ padding: '1rem', width: '40px' }}>
                  <input type="checkbox" checked={selectedContacts.length === visibleContacts.length && visibleContacts.length > 0} onChange={toggleSelectAllContacts} style={{ cursor: 'pointer' }} />
                </th>
              )}
              <th style={{ padding: '1rem', color: 'var(--text-secondary)', fontWeight: '500', fontSize: '0.875rem' }}>Name</th>
              {isColVisible('email') && <th style={{ padding: '1rem', color: 'var(--text-secondary)', fontWeight: '500', fontSize: '0.875rem' }}>Email</th>}
              {isColVisible('phone') && <th style={{ padding: '1rem', color: 'var(--text-secondary)', fontWeight: '500', fontSize: '0.875rem' }}>Phone</th>}
              {isColVisible('company') && <th style={{ padding: '1rem', color: 'var(--text-secondary)', fontWeight: '500', fontSize: '0.875rem' }}>Category</th>}
              {/* #593: rules-based score (leadScoringEngine.js); dropped misleading "AI" prefix. */}
              {isColVisible('aiScore') && <th style={{ padding: '1rem', color: 'var(--text-secondary)', fontWeight: '500', fontSize: '0.875rem' }}>Lead Score</th>}
              {isColVisible('status') && <th style={{ padding: '1rem', color: 'var(--text-secondary)', fontWeight: '500', fontSize: '0.875rem' }}>Status</th>}
              {/* Generic-vertical-only Lead custom fields (Settings > Lead Fields),
                  each independently toggleable via the "Customize table" picker. */}
              {customFieldDefs.filter(f => isColVisible(`cf_${f.fieldKey}`)).map(f => (
                <th key={f.id} style={{ padding: '1rem', color: 'var(--text-secondary)', fontWeight: '500', fontSize: '0.875rem' }}>{f.label}</th>
              ))}
              {isColVisible('assignedTo') && <th style={{ padding: '1rem', color: 'var(--text-secondary)', fontWeight: '500', fontSize: '0.875rem' }}>Assigned To</th>}
              {isColVisible('createdAt') && <th style={{ padding: '1rem', color: 'var(--text-secondary)', fontWeight: '500', fontSize: '0.875rem' }}>Created</th>}
              <th style={{ padding: '1rem', textAlign: 'right', whiteSpace: 'nowrap' }}>Actions</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr><td colSpan={contactsColSpan} style={{ padding: '2rem', textAlign: 'center' }}>Loading contacts...</td></tr>
            ) : visibleContacts.length === 0 ? (
              <tr><td colSpan={contactsColSpan} style={{ padding: '2rem', textAlign: 'center', color: 'var(--text-secondary)' }}>
                {contacts.length === 0
                  ? 'No contacts yet. Click "Add Contact" or import a CSV.'
                  : `No contacts match "${searchTerm}"${statusFilter !== 'All' ? ` with status ${statusFilter}` : ''}.`}
              </td></tr>
            ) : visibleContacts.map(contact => (
              <tr key={contact.id} style={{ borderBottom: '1px solid var(--border-color)' }} className="table-row-hover">
                {isAdmin && (
                  <td style={{ padding: '1rem' }}>
                    <input type="checkbox" checked={selectedContacts.includes(contact.id)} onChange={() => toggleSelectContact(contact.id)} style={{ cursor: 'pointer' }} />
                  </td>
                )}
                <td style={{ padding: '1rem' }}>
                  <div style={{ fontWeight: '500' }}>
                    <Link to={`/contacts/${contact.id}`} style={{ color: 'var(--text-primary)', textDecoration: 'none', display: 'block', pointerEvents: 'all', position: 'relative', zIndex: 10 }} className="hover-underline">
                      {contact.name}
                    </Link>
                  </div>
                  <div style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>{contact.title}</div>
                </td>
                {/* #488: long emails (auto-generated test rows like
                    `arjun.mehta.17779656822@e2e.dev`) used to truncate mid-string
                    on narrow viewports with no affordance. Cap the cell width,
                    add ellipsis, and surface the full address via the native
                    title-attribute tooltip on hover. */}
                {isColVisible('email') && (
                  <td
                    style={{
                      padding: '1rem',
                      color: 'var(--text-secondary)',
                      maxWidth: 240,
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                    }}
                    title={contact.email || ''}
                  >
                    {contact.email}
                  </td>
                )}
                {isColVisible('phone') && <td style={{ padding: '1rem', color: 'var(--text-secondary)' }}>{contact.phone || '—'}</td>}
                {isColVisible('company') && <td style={{ padding: '1rem', color: 'var(--text-secondary)' }}>{contact.company}</td>}
                {isColVisible('aiScore') && (
                  <td style={{ padding: '1rem' }}>
                    <span style={{
                      padding: '0.25rem 0.75rem',
                      borderRadius: '999px',
                      fontSize: '0.75rem',
                      fontWeight: 'bold',
                      backgroundColor: contact.aiScore > 75 ? 'rgba(16, 185, 129, 0.1)' : contact.aiScore > 40 ? 'rgba(245, 158, 11, 0.1)' : 'rgba(239, 68, 68, 0.1)',
                      color: contact.aiScore > 75 ? 'var(--success-color)' : contact.aiScore > 40 ? 'var(--warning-color)' : '#ef4444'
                    }}>
                      {contact.aiScore}/100
                    </span>
                  </td>
                )}
                {isColVisible('status') && (
                  <td style={{ padding: '1rem' }}>
                    <span style={{
                      padding: '0.25rem 0.75rem',
                      borderRadius: '999px',
                      fontSize: '0.75rem',
                      backgroundColor: contact.status === 'Lead' ? 'rgba(59, 130, 246, 0.1)' : 'rgba(16, 185, 129, 0.1)',
                      color: contact.status === 'Lead' ? 'var(--accent-color)' : 'var(--success-color)'
                    }}>
                      {contact.status}
                    </span>
                  </td>
                )}
                {/* Generic-vertical-only Lead custom fields — inline
                    click-to-add/edit/remove directly in the cell
                    (Freshsales-style), no need to open a separate edit
                    form just to fill in one field. Each field's column is
                    independently toggleable via the picker. */}
                {customFieldDefs.filter(f => isColVisible(`cf_${f.fieldKey}`)).map(f => (
                  <td key={f.id} style={{ padding: '0.5rem 1rem', color: 'var(--text-secondary)', fontSize: '0.875rem' }}>
                    <InlineCellEditor
                      contactId={contact.id}
                      field={f}
                      value={contact.customFields?.[f.fieldKey]}
                      onSaved={(newValue) => {
                        setContacts(prev => prev.map(c => c.id === contact.id
                          ? { ...c, customFields: { ...c.customFields, [f.fieldKey]: newValue } }
                          : c));
                      }}
                    />
                  </td>
                ))}
                {isColVisible('assignedTo') && (
                  <td style={{ padding: '1rem' }}>
                    {isAdmin ? (
                      <select
                        className="input-field"
                        value={contact.assignedToId || ''}
                        onChange={e => handleAssign(contact.id, e.target.value)}
                        style={{ padding: '0.375rem 0.5rem', fontSize: '0.8rem', minWidth: '130px', background: 'var(--input-bg)' }}
                      >
                        <option value="">Unassigned</option>
                        {assignableStaff(contact).map(s => (
                          <option key={s.id} value={s.id}>{s.name || s.email}</option>
                        ))}
                      </select>
                    ) : (
                      <span style={{ fontSize: '0.875rem', color: contact.assignedToId ? 'var(--text-primary)' : 'var(--text-secondary)' }}>
                        {contact.assignedTo?.name || contact.assignedTo?.email || 'Unassigned'}
                      </span>
                    )}
                  </td>
                )}
                {isColVisible('createdAt') && (
                  <td style={{ padding: '1rem', color: 'var(--text-secondary)', fontSize: '0.875rem' }}>
                    {contact.createdAt ? formatDate(contact.createdAt) : '—'}
                  </td>
                )}
                <td style={{ padding: '1rem', textAlign: 'right', whiteSpace: 'nowrap' }}>
                  <button
                    onClick={() => setEditingContact(contact)}
                    aria-label={`Edit contact ${contact.name || contact.email || ''}`}
                    title="Edit contact"
                    style={{ background: 'none', border: 'none', color: 'var(--text-secondary)', cursor: 'pointer', marginRight: '0.5rem' }}
                  >
                    <Pencil size={16} />
                  </button>
                  <button
                    onClick={() => handleDelete(contact.id)}
                    aria-label={`Delete contact ${contact.name || contact.email || ''}`}
                    title="Delete contact"
                    style={{ background: 'none', border: 'none', color: '#ef4444', cursor: 'pointer' }}
                  >
                    <Trash2 size={18} />
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        </TopScrollSync>
          );
        })()}
      </div>

      {showImportModal && (
        <div style={{ position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, background: 'var(--overlay-bg)', backdropFilter: 'blur(5px)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 100 }}>
          <div className="card" style={{ padding: '2rem', width: '600px', maxHeight: '80vh', overflowY: 'auto' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1.5rem' }}>
              <h3 style={{ fontSize: '1.25rem', fontWeight: 'bold', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                <FileSpreadsheet size={20} color="var(--accent-color)" /> Import CSV/Excel
              </h3>
              <button onClick={() => setShowImportModal(false)} aria-label="Close import dialog" title="Close" style={{ background: 'none', border: 'none', color: 'var(--text-secondary)', cursor: 'pointer' }}><X size={20} /></button>
            </div>

            <div style={{ marginBottom: '1.5rem' }}>
              <label style={{ display: 'block', padding: '2rem', border: '2px dashed var(--border-color)', borderRadius: '12px', textAlign: 'center', cursor: 'pointer', transition: 'var(--transition)' }}>
                <Upload size={32} style={{ color: 'var(--text-secondary)', marginBottom: '0.5rem' }} />
                <p style={{ color: 'var(--text-secondary)', fontSize: '0.875rem' }}>Click to select a .csv or .xlsx/.xls file</p>
                <p style={{ color: 'var(--text-secondary)', fontSize: '0.75rem', marginTop: '0.25rem' }}>Expected columns: name, email, company, title, status</p>
                <input type="file" accept=".csv,.xlsx,.xls" onChange={handleFileSelect} style={{ display: 'none' }} />
              </label>
            </div>

            {csvRows.length > 0 && !importResult && (() => {
              // #154: validate each row up front so the user sees what'll be rejected.
              const rowIssues = csvRows.map(validateCsvRow);
              const validCount = rowIssues.filter(i => i.length === 0).length;
              const invalidCount = csvRows.length - validCount;
              const allInvalid = validCount === 0;
              return (
                <>
                  <div style={{ marginBottom: '1rem' }}>
                    <p style={{ fontSize: '0.875rem', color: 'var(--text-secondary)', marginBottom: '0.5rem' }}>
                      Detected columns: <strong>{csvHeaders.join(', ')}</strong>
                    </p>
                    <p style={{ fontSize: '0.875rem', color: 'var(--text-primary)' }}>
                      {csvRows.length} row{csvRows.length !== 1 ? 's' : ''} found — {validCount} valid, {invalidCount > 0 && (
                        <span style={{ color: '#ef4444', fontWeight: 600 }}>{invalidCount} invalid (will be skipped)</span>
                      )}{invalidCount === 0 && <span style={{ color: 'var(--success-color)' }}>0 invalid</span>}. Previewing first {Math.min(5, csvRows.length)}:
                    </p>
                  </div>
                  <div style={{ overflowX: 'auto', marginBottom: '1.5rem' }}>
                    <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.8rem' }}>
                      <thead>
                        <tr style={{ borderBottom: '1px solid var(--border-color)' }}>
                          <th style={{ padding: '0.5rem', textAlign: 'left', color: 'var(--text-secondary)', fontWeight: '500', width: 32 }}>#</th>
                          {csvHeaders.map(h => (
                            <th key={h} style={{ padding: '0.5rem', textAlign: 'left', color: 'var(--text-secondary)', fontWeight: '500' }}>{h}</th>
                          ))}
                          <th style={{ padding: '0.5rem', textAlign: 'left', color: 'var(--text-secondary)', fontWeight: '500' }}>status</th>
                        </tr>
                      </thead>
                      <tbody>
                        {csvRows.slice(0, 5).map((row, i) => {
                          const issues = rowIssues[i];
                          const bad = issues.length > 0;
                          return (
                            <tr key={i} style={{ borderBottom: '1px solid var(--border-color)', background: bad ? 'rgba(239,68,68,0.05)' : undefined }}>
                              <td style={{ padding: '0.5rem', color: bad ? '#ef4444' : 'var(--text-secondary)' }}>{i + 1}</td>
                              {csvHeaders.map(h => (
                                <td key={h} style={{ padding: '0.5rem', color: 'var(--text-primary)' }}>{row[h]}</td>
                              ))}
                              <td style={{ padding: '0.5rem', color: bad ? '#ef4444' : '#10b981', fontSize: '0.75rem' }}>
                                {bad ? issues.join('; ') : 'OK'}
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                  <button
                    onClick={handleImport}
                    disabled={importing || allInvalid}
                    className="btn-primary"
                    title={allInvalid ? 'No valid rows to import' : ''}
                    style={{ width: '100%', opacity: (importing || allInvalid) ? 0.5 : 1, cursor: allInvalid ? 'not-allowed' : 'pointer' }}
                  >
                    {importing ? 'Importing...' : `Import ${validCount} valid Contact${validCount !== 1 ? 's' : ''}${invalidCount > 0 ? ` (${invalidCount} skipped)` : ''}`}
                  </button>
                </>
              );
            })()}

            {importResult && !importResult.error && (
              <div style={{ padding: '1.5rem', background: 'rgba(16, 185, 129, 0.1)', borderRadius: '12px', border: '1px solid rgba(16, 185, 129, 0.3)' }}>
                <p style={{ fontWeight: '600', color: 'var(--success-color)', marginBottom: '0.5rem', fontSize: '1rem' }}>Import Complete</p>
                <p style={{ fontSize: '0.875rem', color: 'var(--text-primary)' }}>{importResult.imported} imported, {importResult.skipped} skipped (duplicate email)</p>
                {importResult.errors && importResult.errors.length > 0 && (
                  <div style={{ marginTop: '0.75rem', fontSize: '0.8rem', color: '#ef4444' }}>
                    {importResult.errors.map((e, i) => <p key={i}>{e}</p>)}
                  </div>
                )}
                <button onClick={() => setShowImportModal(false)} className="btn-primary" style={{ marginTop: '1rem', width: '100%' }}>Done</button>
              </div>
            )}

            {importResult && importResult.error && (
              <div style={{ padding: '1.5rem', background: 'rgba(239, 68, 68, 0.1)', borderRadius: '12px', border: '1px solid rgba(239, 68, 68, 0.3)' }}>
                <p style={{ fontWeight: '600', color: '#ef4444' }}>Import Failed</p>
                <p style={{ fontSize: '0.875rem', color: 'var(--text-secondary)', marginTop: '0.25rem' }}>{importResult.error}</p>
              </div>
            )}
          </div>
        </div>
      )}

      {showModal && (
        <div style={{ position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, background: 'var(--overlay-bg)', backdropFilter: 'blur(5px)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 100 }}>
          <div className="card" style={{ padding: '2rem', width: '400px' }}>
            <h3 style={{ marginBottom: '1.5rem', fontSize: '1.25rem', fontWeight: 'bold' }}>Add New Contact</h3>
            <form onSubmit={handleAddContact} style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
              <input type="text" placeholder="Name" required className="input-field" value={newContact.name} onChange={e => setNewContact({...newContact, name: e.target.value})} />
              <div>
                <input
                  type="email"
                  placeholder="Email"
                  required
                  className="input-field"
                  aria-invalid={emailError ? 'true' : 'false'}
                  aria-describedby={emailError ? 'contact-email-error' : undefined}
                  value={newContact.email}
                  onChange={e => {
                    setNewContact({ ...newContact, email: e.target.value });
                    if (emailError) setEmailError('');
                  }}
                  onBlur={e => {
                    const v = (e.target.value || '').trim();
                    if (v && !EMAIL_RE.test(v)) setEmailError('Please enter a valid email address');
                    else setEmailError('');
                  }}
                  style={emailError ? { borderColor: '#ef4444' } : undefined}
                />
                {emailError && (
                  <p id="contact-email-error" role="alert" style={{ color: '#ef4444', fontSize: '0.75rem', marginTop: '0.25rem' }}>
                    {emailError}
                  </p>
                )}
              </div>
              <div>
                <input
                  type="tel"
                  placeholder="Phone (e.g. +91 98765 43210)"
                  className="input-field"
                  value={newContact.phone}
                  onChange={e => {
                    const v = e.target.value.replace(/[^\d+\s\-().]/g, '');
                    setNewContact({ ...newContact, phone: v });
                    if (phoneError) setPhoneError('');
                  }}
                  onBlur={e => {
                    const v = e.target.value.trim();
                    if (v && !PHONE_RE.test(v)) setPhoneError('Enter a valid phone number (digits, +, spaces, hyphens only)');
                    else setPhoneError('');
                  }}
                  style={phoneError ? { borderColor: '#ef4444' } : undefined}
                  aria-describedby={phoneError ? 'contact-phone-error' : undefined}
                />
                {phoneError && (
                  <p id="contact-phone-error" role="alert" style={{ color: '#ef4444', fontSize: '0.75rem', marginTop: '0.25rem' }}>
                    {phoneError}
                  </p>
                )}
              </div>
              <input type="text" placeholder="Category" required className="input-field" value={newContact.company} onChange={e => setNewContact({...newContact, company: e.target.value})} />
              <select className="input-field" value={newContact.status} onChange={e => setNewContact({...newContact, status: e.target.value})}>
                <option value="Lead">Lead</option>
                <option value="Customer">Customer</option>
              </select>
              <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '1rem', marginTop: '1rem' }}>
                <button type="button" onClick={() => { setShowModal(false); setEmailError(''); setPhoneError(''); }} style={{ background: 'transparent', color: 'var(--text-secondary)', border: 'none', cursor: 'pointer' }}>Cancel</button>
                <button type="submit" className="btn-primary">Save Contact</button>
              </div>
            </form>
          </div>
        </div>
      )}
      {/* Duplicate Contacts Modal */}
      {showDupes && (
        <div style={{ position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, background: 'var(--overlay-bg)', backdropFilter: 'blur(5px)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 100 }}>
          <div className="card" style={{ padding: '2rem', width: '700px', maxHeight: '80vh', overflowY: 'auto' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1.5rem' }}>
              <h3 style={{ fontSize: '1.25rem', fontWeight: 'bold', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                <GitMerge size={20} color="var(--accent-color)" /> Duplicate Contacts ({dupes.length} groups)
              </h3>
              <button onClick={() => setShowDupes(false)} aria-label="Close duplicates dialog" title="Close" style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-secondary)' }}><X size={20} /></button>
            </div>
            {dupes.length === 0 ? (
              <p style={{ textAlign: 'center', padding: '2rem', color: 'var(--text-secondary)' }}>No duplicate contacts found. Your database is clean!</p>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
                {dupes.map((group, gi) => (
                  <div key={gi} className="card" style={{ padding: '1rem', border: '1px solid rgba(245,158,11,0.3)', background: 'rgba(245,158,11,0.03)' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.75rem' }}>
                      <span style={{ fontSize: '0.75rem', color: '#f59e0b', fontWeight: '600' }}>Match: {group.reason}</span>
                      <div style={{ display: 'flex', gap: '0.5rem' }}>
                        <button
                          onClick={() => handleDismiss(group)}
                          aria-label="Dismiss duplicate group"
                          title="Mark as not a duplicate — will not re-appear"
                          style={{ padding: '0.3rem 0.75rem', fontSize: '0.8rem', display: 'flex', alignItems: 'center', gap: '0.25rem', background: 'transparent', color: 'var(--text-secondary)', border: '1px solid var(--border-color, rgba(0,0,0,0.1))', borderRadius: '4px', cursor: 'pointer' }}
                        >
                          <EyeOff size={12} /> Dismiss
                        </button>
                        <button
                          onClick={() => handleMerge(group.primary.id, group.duplicates.map(d => d.id))}
                          disabled={merging}
                          className="btn-primary"
                          style={{ padding: '0.3rem 0.75rem', fontSize: '0.8rem', display: 'flex', alignItems: 'center', gap: '0.25rem' }}
                        >
                          <GitMerge size={12} /> Merge into Primary
                        </button>
                      </div>
                    </div>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.375rem' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', padding: '0.5rem 0.75rem', borderRadius: '6px', background: 'rgba(16,185,129,0.08)', border: '1px solid rgba(16,185,129,0.2)' }}>
                        <span style={{ fontSize: '0.65rem', fontWeight: '700', color: '#10b981', textTransform: 'uppercase' }}>Primary</span>
                        <span style={{ fontWeight: '500', fontSize: '0.85rem' }}>{group.primary.name}</span>
                        <span style={{ fontSize: '0.8rem', color: 'var(--text-secondary)' }}>{group.primary.email}</span>
                        <span style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>{group.primary.company}</span>
                        <span style={{ fontSize: '0.7rem', marginLeft: 'auto', color: 'var(--text-secondary)' }}>Score: {group.primary.aiScore}</span>
                      </div>
                      {group.duplicates.map(dup => (
                        <div key={dup.id} style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', padding: '0.5rem 0.75rem', borderRadius: '6px', background: 'rgba(239,68,68,0.05)', border: '1px solid rgba(239,68,68,0.15)' }}>
                          <span style={{ fontSize: '0.65rem', fontWeight: '700', color: '#ef4444', textTransform: 'uppercase' }}>Dup</span>
                          <span style={{ fontWeight: '500', fontSize: '0.85rem' }}>{dup.name}</span>
                          <span style={{ fontSize: '0.8rem', color: 'var(--text-secondary)' }}>{dup.email}</span>
                          <span style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>{dup.company}</span>
                          <span style={{ fontSize: '0.7rem', marginLeft: 'auto', color: 'var(--text-secondary)' }}>Score: {dup.aiScore}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      {dupModal && (
        <DuplicateContactModal
          existingContactId={dupModal.existingContactId}
          matchedBy={dupModal.matchedBy}
          contact={dupModal.contact}
          creating={creatingContact}
          onEditDetails={() => setDupModal(null)}
          onCreateAnyway={() => submitNewContact(true)}
        />
      )}

      {editingContact && (
        <EditContactModal
          contact={editingContact}
          customFieldDefs={customFieldDefs}
          onClose={() => setEditingContact(null)}
          onSaved={(updated) => {
            setContacts(prev => prev.map(c => c.id === updated.id ? { ...c, ...updated } : c));
            setEditingContact(null);
          }}
        />
      )}
    </div>
  );
};

export default Contacts;
