import { fetchApi } from '../utils/api';
import { useNotify } from '../utils/notify';
import { formatDateMedium as formatDate } from '../utils/date';
import { useState, useEffect, useContext, useRef, useMemo, useLayoutEffect, useCallback } from 'react';
import { Search, Plus, Trash2, Pencil, RefreshCw, Download, X, FileSpreadsheet, UserCheck, ChevronDown, ChevronUp, ArrowUpDown, SlidersHorizontal, GitMerge, EyeOff } from 'lucide-react';
import { Link, useSearchParams } from 'react-router-dom';
import ReturnToBanner from '../components/ReturnToBanner';
import DuplicateContactModal from '../components/DuplicateContactModal';
import ColumnPicker from '../components/ColumnPicker';
import FilterPanel from '../components/FilterPanel';
import TopScrollSync from '../components/TopScrollSync';
import SavedViewsBar from '../components/SavedViewsBar';
import ScrollableSelect from '../components/ScrollableSelect';
import InlineCellEditor from '../components/InlineCellEditor';
import EditContactModal from '../components/EditContactModal';
import { AuthContext } from '../App';
import { accessibleSubBrands, subBrandShortLabel } from '../utils/travelSubBrand';

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
    headers.forEach((h, i) => { row[h] = normalizeSpreadsheetValue(values[i] ?? ''); });
    return row;
  });
};

const SCI_NOTATION_RE = /^([+-]?\d+(?:\.\d+)?)e([+-]?\d+)$/i;

const normalizeSpreadsheetValue = (value) => {
  if (value === null || value === undefined) return '';
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : '';
  if (typeof value !== 'string') return String(value).trim();
  const trimmed = value.trim();
  if (!trimmed) return '';
  if (!SCI_NOTATION_RE.test(trimmed)) return trimmed;
  const match = trimmed.match(/^([+-]?)(\d+)(?:\.(\d+))?[eE]([+-]?\d+)$/);
  if (!match) return trimmed;
  const [, sign, whole, fraction = '', exponentText] = match;
  const exponent = Number(exponentText);
  if (!Number.isFinite(exponent) || exponent < 0) return trimmed;
  const digits = `${whole}${fraction}`.replace(/^0+/, '') || '0';
  const shift = exponent - fraction.length;
  if (shift < 0) return trimmed;
  return `${sign === '-' ? '-' : ''}${digits}${'0'.repeat(shift)}`;
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
      headers.forEach((h, i) => { row[h] = normalizeSpreadsheetValue(cells[i] ?? ''); });
      return row;
    });
};

// #154: same validation rules as backend, run client-side so the user sees row
// errors in the preview before clicking Import.
const ALLOWED_STATUSES = new Set(['Lead', 'Prospect', 'Customer', 'Churned', 'Junk']);
const EMAIL_RE = /^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]{2,}$/;
const PHONE_RE = /^\+?[\d\s\-().]{7,15}$/;
const FORMULA_INJECTION_RE = /^[=+\-@\t\r]/;
const CONTACTS_COLUMN_LAYOUT_STORAGE_KEY = 'globuscrm.contacts.columnLayout.v1';
const CONTACTS_COLUMN_MIN_WIDTH = 72;
const CONTACTS_SELECT_COLUMN_WIDTH = 48;
const CONTACTS_NAME_COLUMN_MIN_WIDTH = 220;
const CONTACTS_NAME_COLUMN_MAX_WIDTH = 380;
const CONTACTS_ACTIONS_COLUMN_WIDTH = 120;
const CONTACTS_COLUMN_DEFAULT_WIDTHS = {
  select: CONTACTS_SELECT_COLUMN_WIDTH,
  name: 240,
  email: 220,
  phone: 150,
  company: 180,
  aiScore: 118,
  status: 110,
  assignedTo: 170,
  createdAt: 145,
  actions: CONTACTS_ACTIONS_COLUMN_WIDTH,
};
const CONTACTS_SCORE_BUCKETS = [
  { value: '0-25', label: '0 - 25', min: 0, max: 25 },
  { value: '26-50', label: '26 - 50', min: 26, max: 50 },
  { value: '51-75', label: '51 - 75', min: 51, max: 75 },
  { value: '76-100', label: '76 - 100', min: 76, max: 100 },
];

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
  const [contactsBulkActionsOpen, setContactsBulkActionsOpen] = useState(false);
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
  const isColVisible = useCallback((key) => {
    if (isWellness || isTravel || visibleColumns === null) return true;
    return visibleColumns.includes(key);
  }, [isTravel, isWellness, visibleColumns]);
  const staffBrandSuffix = (member) => {
    if (!isTravel) return '';
    const brands = accessibleSubBrands(member).map(subBrandShortLabel);
    return brands.length ? ' (' + brands.join(', ') + ')' : '';
  };
  const staffOptionLabel = (member) => (member.name || member.email) + staffBrandSuffix(member);
  const assignableStaff = (contact) => {
    let rows = staff;
    if (isTravel && !isAdmin) {
      rows = rows.filter((s) => s.role !== 'ADMIN');
    }
    if (!isTravel || !contact?.subBrand) return rows;
    return rows.filter(
      (s) => accessibleSubBrands(s).includes(contact.subBrand) || String(s.id) === String(contact.assignedToId),
    );
  };
  const canEditAssignedTo = isAdmin || isTravel;
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

  // Drill-down entry from the Lead Reports cluster — e.g. the funnel's
  // "Converted" stage links to /contacts?status=Customer. Seeds the existing
  // status dropdown so the applied filter is visible and clearable.
  const [drillParams] = useSearchParams();
  useEffect(() => {
    const status = drillParams.get('status');
    if (status) setStatusFilter(status);
  }, [drillParams]);
  // Assigned-To + Lead Score range filters, same client-side pattern as
  // search/status above. assignedToFilter: '' = all, 'unassigned' = no
  // assignee, else a staff id (string, matches <option value>). scoreFilter:
  // '' = all, else "min-max" bucket key parsed at filter time.
  const [assignedToFilter, setAssignedToFilter] = useState('');
  const [scoreFilter, setScoreFilter] = useState('');
  // Freshsales-style "Filter by" panel (components/FilterPanel.jsx) — a
  // dynamic field-picker + operator + checkbox-values panel, separate from
  // the fixed dropdowns above. Applied server-side via ?filters=<JSON>
  // (backend/routes/contacts.js FILTERABLE_FIELDS) so it isn't bounded by
  // the same-page 500-row client cap the way the dropdowns above are.
  const [advancedFilters, setAdvancedFilters] = useState([]);
  const [sortConfig, setSortConfig] = useState({ key: null, direction: null });
  const [columnLayout, setColumnLayout] = useState(() => {
    if (typeof window === 'undefined') return { widths: {} };
    try {
      const saved = window.localStorage.getItem(CONTACTS_COLUMN_LAYOUT_STORAGE_KEY);
      if (!saved) return { widths: {} };
      const parsed = JSON.parse(saved);
      return {
        widths: parsed?.widths && typeof parsed.widths === 'object' ? parsed.widths : {},
      };
    } catch (_err) {
      return { widths: {} };
    }
  });
  const resizeStateRef = useRef(null);
  const contactsFrozenTableRef = useRef(null);
  const contactsScrollableTableRef = useRef(null);

  useEffect(() => {
    try {
      window.localStorage.setItem(
        CONTACTS_COLUMN_LAYOUT_STORAGE_KEY,
        JSON.stringify(columnLayout),
      );
    } catch (_err) {
      // Table interaction should continue even if layout persistence fails.
    }
  }, [columnLayout]);

  useEffect(
    () => () => {
      if (!resizeStateRef.current) return;
      window.removeEventListener('mousemove', resizeStateRef.current.onMove);
      window.removeEventListener('mouseup', resizeStateRef.current.onUp);
    },
    [],
  );

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

  const getColumnDefaultWidth = (key) =>
    CONTACTS_COLUMN_DEFAULT_WIDTHS[key] || (key.startsWith('cf_') ? 160 : 140);
  const getColumnWidth = (key) => {
    const savedWidth = Number(columnLayout.widths?.[key]) || getColumnDefaultWidth(key);
    if (key === 'select') return CONTACTS_SELECT_COLUMN_WIDTH;
    if (key === 'name') {
      return Math.max(
        CONTACTS_NAME_COLUMN_MIN_WIDTH,
        Math.min(savedWidth, CONTACTS_NAME_COLUMN_MAX_WIDTH),
      );
    }
    if (key === 'actions') {
      return Math.max(CONTACTS_ACTIONS_COLUMN_WIDTH, savedWidth);
    }
    if (key === 'assignedTo') {
      return Math.max(150, savedWidth);
    }
    return Math.max(CONTACTS_COLUMN_MIN_WIDTH, savedWidth);
  };
  const setColumnWidth = (key, width) => {
    const minWidth =
      key === 'select'
        ? CONTACTS_SELECT_COLUMN_WIDTH
        : key === 'name'
          ? CONTACTS_NAME_COLUMN_MIN_WIDTH
          : key === 'actions'
            ? CONTACTS_ACTIONS_COLUMN_WIDTH
            : key === 'assignedTo'
              ? 150
              : CONTACTS_COLUMN_MIN_WIDTH;
    const maxWidth = key === 'name' ? CONTACTS_NAME_COLUMN_MAX_WIDTH : Number.POSITIVE_INFINITY;
    const nextWidth = Math.max(minWidth, Math.min(Math.round(width), maxWidth));
    setColumnLayout((prev) => ({
      widths: { ...(prev.widths || {}), [key]: nextWidth },
    }));
  };
  const startColumnResize = (key, event) => {
    event.preventDefault();
    event.stopPropagation();
    const startX = event.clientX;
    const startWidth = getColumnWidth(key);
    const onMove = (moveEvent) => {
      setColumnWidth(key, startWidth + moveEvent.clientX - startX);
    };
    const onUp = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      resizeStateRef.current = null;
    };
    resizeStateRef.current = { onMove, onUp };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };
  const toggleContactSort = (key) => {
    setSortConfig((prev) => {
      if (prev.key !== key) return { key, direction: 'asc' };
      if (prev.direction === 'asc') return { key, direction: 'desc' };
      if (prev.direction === 'desc') return { key: null, direction: null };
      return { key, direction: 'asc' };
    });
  };
  const getContactSortValue = useCallback((contact, key) => {
    if (key === 'name') return contact.name || '';
    if (key === 'email') return contact.email || '';
    if (key === 'phone') return contact.phone || '';
    if (key === 'company') return contact.company || '';
    if (key === 'aiScore') return Number.isFinite(Number(contact.aiScore)) ? Number(contact.aiScore) : null;
    if (key === 'status') return contact.status || '';
    if (key === 'assignedTo') return contact.assignedTo?.name || contact.assignedTo?.email || '';
    if (key === 'createdAt') return contact.createdAt ? new Date(contact.createdAt).getTime() : null;
    if (key.startsWith('cf_')) {
      const fieldKey = key.slice(3);
      const raw = contact.customFields?.[fieldKey];
      if (Array.isArray(raw)) return raw.join(', ');
      return raw ?? '';
    }
    return '';
  }, []);

  const fetchContacts = useCallback(() => {
    const qs = advancedFilters.length > 0
      ? `?filters=${encodeURIComponent(JSON.stringify(advancedFilters.map(({ field, operator, values }) => ({ field, operator, values }))))}`
      : '';
    fetchApi(`/api/contacts${qs}`).then(data => {
        setContacts(Array.isArray(data) ? data : []);
        setLoading(false);
      }).catch(() => { setContacts([]); setLoading(false); });
  }, [advancedFilters]);

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
  }, [fetchContacts]);

  // Refetch (server-side) whenever the FilterPanel's filter set changes.
  // Skips the very first render — the mount effect above already fetched
  // once with the (empty) initial advancedFilters.
  const isFirstFiltersRender = useRef(true);
  useEffect(() => {
    if (isFirstFiltersRender.current) { isFirstFiltersRender.current = false; return; }
    fetchContacts();
  }, [fetchContacts]);

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
    const result = await fetchApi('/api/contacts/bulk-assign', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contactIds: selectedContacts, assignedToId: bulkAgent || null }),
    });
    if (result?.updated > 0) {
      notify.success?.(
        result.updated === 1
          ? 'Assigned 1 contact successfully'
          : 'Assigned ' + result.updated + ' contacts successfully'
      );
    }
    if (result?.skipped > 0) {
      const firstSkipped = result.skippedDetails?.[0];
      const why = firstSkipped?.subBrand
        ? ' because ' + firstSkipped.subBrand.toUpperCase() + ' is not allowed for the selected staff'
        : '';
      notify.info?.(
        result.skipped === 1
          ? '1 contact was skipped' + why + '.'
          : result.skipped + ' contacts were skipped' + why + '.'
      );
    }
    setSelectedContacts([]);
    setBulkAgent('');
    fetchContacts();
  };

  const handleBulkDelete = async () => {
    if (selectedContacts.length === 0) return;

    const ok = await notify.confirm({
      title: 'Delete selected contacts?',
      message: `Delete ${selectedContacts.length} selected contact${selectedContacts.length === 1 ? '' : 's'}? This can't be undone.`,
      confirmText: 'Delete',
      cancelText: 'Cancel',
      destructive: true,
    });
    if (!ok) return;

    setContactsBulkActionsOpen(false);
    try {
      const res = await fetchApi('/api/contacts/bulk-delete', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contactIds: selectedContacts }),
      });
      const deletedCount = Number.isFinite(Number(res?.deleted))
        ? Number(res.deleted)
        : selectedContacts.length;
      notify.success(
        `Deleted ${deletedCount} contact${deletedCount === 1 ? '' : 's'}`,
      );
      setSelectedContacts([]);
      setBulkAgent('');
      fetchContacts();
    } catch (err) {
      notify.error(err?.body?.error || err?.message || 'Failed to delete contacts');
    }
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
        phone: normalizeSpreadsheetValue(
          row.phone || row.phone_number || row.sms_number || row.Phone || row.PhoneNumber || row.smsNumber || '',
        ),
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
    } catch {
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

  // #461: derive the visible rows from `contacts` + the filter inputs, then
  // optionally apply the current header sort. Search matches name / email /
  // company / title (case-insensitive). The dropdown supports the canonical
  // statuses; 'All' disables status filtering. A selected Saved View
  // additionally restricts to its fixed membership list first so
  // search/status still narrow within the view.
  const visibleContacts = useMemo(() => {
    const term = searchTerm.trim().toLowerCase();
    return contacts.filter((c) => {
      if (activeViewMemberIds && !activeViewMemberIds.has(c.id)) return false;
      if (statusFilter !== 'All' && c.status !== statusFilter) return false;
      if (assignedToFilter === 'unassigned' && c.assignedToId) return false;
      if (assignedToFilter && assignedToFilter !== 'unassigned' && String(c.assignedToId || '') !== assignedToFilter) return false;
      if (scoreFilter) {
        const bucket = CONTACTS_SCORE_BUCKETS.find(b => b.value === scoreFilter);
        if (bucket && (c.aiScore < bucket.min || c.aiScore > bucket.max)) return false;
      }
      if (!term) return true;
      return (
        (c.name || '').toLowerCase().includes(term) ||
        (c.email || '').toLowerCase().includes(term) ||
        (c.company || '').toLowerCase().includes(term) ||
        (c.title || '').toLowerCase().includes(term)
      );
    });
  }, [activeViewMemberIds, assignedToFilter, contacts, scoreFilter, searchTerm, statusFilter]);

  const sortedContacts = useMemo(() => {
    if (!sortConfig.key || !sortConfig.direction) return visibleContacts;
    const direction = sortConfig.direction === 'desc' ? -1 : 1;
    const collator = new Intl.Collator(undefined, {
      numeric: true,
      sensitivity: 'base',
    });
    return [...visibleContacts].sort((a, b) => {
      const aValue = getContactSortValue(a, sortConfig.key);
      const bValue = getContactSortValue(b, sortConfig.key);
      const aNull = aValue === null || aValue === undefined || aValue === '';
      const bNull = bValue === null || bValue === undefined || bValue === '';
      if (aNull && bNull) return 0;
      if (aNull) return 1;
      if (bNull) return -1;
      if (typeof aValue === 'number' && typeof bValue === 'number') {
        return (aValue - bValue) * direction;
      }
      return collator.compare(String(aValue), String(bValue)) * direction;
    });
  }, [getContactSortValue, sortConfig.direction, sortConfig.key, visibleContacts]);

  const visibleCustomFieldDefs = useMemo(
    () =>
      customFieldDefs.filter((f) =>
        isWellness || isTravel || visibleColumns === null
          ? true
          : visibleColumns.includes(`cf_${f.fieldKey}`),
      ),
    [customFieldDefs, isTravel, isWellness, visibleColumns],
  );

  const contactsFrozenColumnDefs = useMemo(
    () => [
      ...(isAdmin
        ? [
            {
              key: 'select',
              label: '',
              sortable: false,
              resizable: false,
            },
          ]
        : []),
      {
        key: 'name',
        label: 'Name',
        sortable: true,
        resizable: true,
      },
    ],
    [isAdmin],
  );

  const contactsScrollableColumnDefs = useMemo(
    () => [
      ...(isColVisible('email')
        ? [
            {
              key: 'email',
              label: 'Email',
              sortable: true,
              resizable: true,
            },
          ]
        : []),
      ...(isColVisible('phone')
        ? [
            {
              key: 'phone',
              label: 'Phone',
              sortable: true,
              resizable: true,
            },
          ]
        : []),
      ...(isColVisible('company')
        ? [
            {
              key: 'company',
              label: 'Category',
              sortable: true,
              resizable: true,
            },
          ]
        : []),
      ...(isColVisible('aiScore')
        ? [
            {
              key: 'aiScore',
              label: 'Lead Score',
              sortable: true,
              resizable: true,
            },
          ]
        : []),
      ...(isColVisible('status')
        ? [
            {
              key: 'status',
              label: 'Status',
              sortable: true,
              resizable: true,
            },
          ]
        : []),
      ...visibleCustomFieldDefs.map((field) => ({
        key: `cf_${field.fieldKey}`,
        label: field.label,
        sortable: true,
        resizable: true,
        field,
        customField: true,
      })),
      ...(isColVisible('assignedTo')
        ? [
            {
              key: 'assignedTo',
              label: 'Assigned To',
              sortable: true,
              resizable: true,
            },
          ]
        : []),
      ...(isColVisible('createdAt')
        ? [
            {
              key: 'createdAt',
              label: 'Created',
              sortable: true,
              resizable: true,
            },
          ]
        : []),
      {
        key: 'actions',
        label: 'Actions',
        sortable: false,
        resizable: true,
      },
    ],
    [isColVisible, visibleCustomFieldDefs],
  );

  const contactsFrozenTableWidth = contactsFrozenColumnDefs.reduce(
    (sum, column) => sum + getColumnWidth(column.key),
    0,
  );
  const contactsScrollableTableWidth = contactsScrollableColumnDefs.reduce(
    (sum, column) => sum + getColumnWidth(column.key),
    0,
  );
  const contactsScrollableTableBaseWidth = contactsScrollableColumnDefs.reduce(
    (sum, column) => sum + getColumnDefaultWidth(column.key),
    0,
  );
  const contactsScrollableTableMinWidth = `${Math.max(
    contactsScrollableTableWidth,
    contactsScrollableTableBaseWidth,
  )}px`;
  const contactsFrozenTableWidthPx = `${contactsFrozenTableWidth}px`;
  const contactsRowSyncSignature = useMemo(
    () =>
      sortedContacts
        .map((contact) =>
          [
            contact.id,
            contact.name,
            contact.title,
            contact.email,
            contact.phone,
            contact.company,
            contact.aiScore ?? '',
            contact.status ?? '',
            contact.assignedToId ?? '',
            contact.createdAt ?? '',
            JSON.stringify(contact.customFields || {}),
          ].join('|'),
        )
        .concat(JSON.stringify(columnLayout), contactsScrollableColumnDefs.map((column) => column.key).join(','))
        .join('::'),
    [columnLayout, contactsScrollableColumnDefs, sortedContacts],
  );

  useLayoutEffect(() => {
    if (sortedContacts.length === 0) return undefined;
    const frozenTable = contactsFrozenTableRef.current;
    const scrollableTable = contactsScrollableTableRef.current;
    if (!frozenTable || !scrollableTable) return undefined;

    const syncTablePairHeight = (leftRow, rightRow) => {
      if (!leftRow || !rightRow) return;
      const height = Math.max(
        Math.ceil(leftRow.getBoundingClientRect().height),
        Math.ceil(rightRow.getBoundingClientRect().height),
      );
      const nextHeight = `${height}px`;
      if (leftRow.style.height !== nextHeight) {
        leftRow.style.height = nextHeight;
      }
      if (rightRow.style.height !== nextHeight) {
        rightRow.style.height = nextHeight;
      }
    };

    const syncSplitTableRowHeights = () => {
      const frozenHeaderRow = frozenTable.querySelector('thead tr');
      const scrollHeaderRow = scrollableTable.querySelector('thead tr');
      const frozenRows = Array.from(frozenTable.querySelectorAll('tbody tr'));
      const scrollRows = Array.from(scrollableTable.querySelectorAll('tbody tr'));
      if (
        frozenRows.length === 0 ||
        frozenRows.length !== scrollRows.length ||
        !frozenHeaderRow ||
        !scrollHeaderRow
      ) {
        return;
      }

      syncTablePairHeight(frozenHeaderRow, scrollHeaderRow);
      frozenRows.forEach((frozenRow, index) => {
        const scrollRow = scrollRows[index];
        if (!scrollRow) return;
        syncTablePairHeight(frozenRow, scrollRow);
      });
    };

    syncSplitTableRowHeights();
    return () => {
      frozenTable?.querySelectorAll('thead tr, tbody tr').forEach((row) => {
        row.style.height = '';
      });
      scrollableTable?.querySelectorAll('thead tr, tbody tr').forEach((row) => {
        row.style.height = '';
      });
    };
  }, [contactsRowSyncSignature, sortedContacts.length]);

  const getContactHeaderCellStyle = (extra = {}) => ({
    padding: '1rem',
    color: 'var(--text-secondary)',
    fontWeight: '500',
    fontSize: '0.875rem',
    verticalAlign: 'middle',
    overflow: 'hidden',
    position: 'relative',
    ...extra,
  });
  const getContactBodyCellStyle = (extra = {}) => ({
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    padding: '1rem',
    ...extra,
  });
  const renderContactsHeaderCell = (column, extra = {}, cellProps = {}, leadingControls = null) => {
    const { key, label, sortable = true, resizable = true, align = 'left' } = column;
    const active = sortConfig.key === key && sortConfig.direction;
    const ariaSort = active
      ? sortConfig.direction === 'asc'
        ? 'ascending'
        : 'descending'
      : 'none';
    const controls = sortable ? (
      <button
        type="button"
        onClick={() => toggleContactSort(key)}
        aria-label={`Sort by ${label || key}`}
        title={`Sort by ${label || key}`}
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: '0.3rem',
          border: 'none',
          background: 'transparent',
          padding: 0,
          color: 'inherit',
          cursor: 'pointer',
          minWidth: 0,
          textAlign: align,
        }}
      >
        <span
          style={{
            minWidth: 0,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {label}
        </span>
        <span
          style={{
            display: 'inline-flex',
            flexShrink: 0,
            color: active ? 'var(--text-primary)' : 'var(--text-secondary)',
          }}
        >
          {active ? (
            sortConfig.direction === 'asc' ? (
              <ChevronUp size={12} />
            ) : (
              <ChevronDown size={12} />
            )
          ) : (
            <ArrowUpDown size={12} />
          )}
        </span>
      </button>
    ) : (
      <span
        style={{
          minWidth: 0,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}
      >
        {label}
      </span>
    );

    return (
      <th
        {...cellProps}
        style={getContactHeaderCellStyle({
          textAlign: align,
          ...extra,
        })}
        aria-sort={sortable ? ariaSort : undefined}
      >
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: align === 'right' ? 'flex-end' : 'flex-start',
            gap: '0.4rem',
            minWidth: 0,
            width: '100%',
          }}
        >
          {leadingControls}
          {controls}
        </div>
        {resizable && key !== 'select' && (
          <span
            role="separator"
            aria-label={`Resize ${label} column`}
            aria-orientation="vertical"
            title={`Drag to resize ${label}`}
            onMouseDown={(e) => startColumnResize(key, e)}
            style={{
              position: 'absolute',
              top: 0,
              right: 0,
              width: 8,
              height: '100%',
              cursor: 'col-resize',
              touchAction: 'none',
              borderRight: '2px solid transparent',
            }}
          />
        )}
      </th>
    );
  };
  const renderFrozenContactRow = (contact) => (
    <tr
      key={contact.id}
      className="table-row-hover"
      style={{ borderBottom: '1px solid var(--border-color)' }}
    >
      {isAdmin && (
        <td style={getContactBodyCellStyle({ padding: '1rem' })}>
          <input
            type="checkbox"
            checked={selectedContacts.includes(contact.id)}
            onChange={() => toggleSelectContact(contact.id)}
            style={{ cursor: 'pointer' }}
            aria-label={`Select ${contact.name || contact.email || 'contact'}`}
          />
        </td>
      )}
      <td style={getContactBodyCellStyle({ padding: '1rem' })}>
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '0.5rem',
            minWidth: 0,
          }}
        >
          <div style={{ minWidth: 0, flex: 1 }}>
            <Link
              to={`/contacts/${contact.id}`}
              style={{
                color: 'var(--text-primary)',
                textDecoration: 'none',
                display: 'block',
                pointerEvents: 'all',
                position: 'relative',
                zIndex: 10,
                minWidth: 0,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
                fontWeight: 600,
              }}
              className="hover-underline"
            >
              {contact.name || 'Unnamed contact'}
            </Link>
            <div
              style={{
                fontSize: '0.75rem',
                color: 'var(--text-secondary)',
                minWidth: 0,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}
              title={contact.title || ''}
            >
              {contact.title || ''}
            </div>
          </div>
        </div>
      </td>
    </tr>
  );
  const renderScrollableContactCell = (contact, column) => {
    switch (column.key) {
      case 'email':
        return (
          <td
            key={column.key}
            style={getContactBodyCellStyle({
              color: 'var(--text-secondary)',
            })}
            title={contact.email || ''}
          >
            {contact.email || '\u2014'}
          </td>
        );
      case 'phone':
        return (
          <td
            key={column.key}
            style={getContactBodyCellStyle({ color: 'var(--text-secondary)' })}
          >
            {contact.phone || '\u2014'}
          </td>
        );
      case 'company':
        return (
          <td
            key={column.key}
            style={getContactBodyCellStyle({ color: 'var(--text-secondary)' })}
            title={contact.company || ''}
          >
            {contact.company || '\u2014'}
          </td>
        );
      case 'aiScore':
        return (
          <td key={column.key} style={getContactBodyCellStyle()}>
            <span
              style={{
                padding: '0.25rem 0.75rem',
                borderRadius: '999px',
                fontSize: '0.75rem',
                fontWeight: 'bold',
                backgroundColor:
                  contact.aiScore > 75
                    ? 'rgba(16, 185, 129, 0.1)'
                    : contact.aiScore > 40
                      ? 'rgba(245, 158, 11, 0.1)'
                      : 'rgba(239, 68, 68, 0.1)',
                color:
                  contact.aiScore > 75
                    ? 'var(--success-color)'
                    : contact.aiScore > 40
                      ? 'var(--warning-color)'
                      : '#ef4444',
              }}
            >
              {contact.aiScore}/100
            </span>
          </td>
        );
      case 'status':
        return (
          <td key={column.key} style={getContactBodyCellStyle()}>
            <span
              style={{
                padding: '0.25rem 0.75rem',
                borderRadius: '999px',
                fontSize: '0.75rem',
                backgroundColor:
                  contact.status === 'Lead'
                    ? 'rgba(59, 130, 246, 0.1)'
                    : 'rgba(16, 185, 129, 0.1)',
                color:
                  contact.status === 'Lead'
                    ? 'var(--accent-color)'
                    : 'var(--success-color)',
              }}
            >
              {contact.status || '\u2014'}
            </span>
          </td>
        );
      case 'assignedTo':
        return (
          <td key={column.key} style={getContactBodyCellStyle()}>
            {canEditAssignedTo ? (
              <select
                className="input-field"
                value={contact.assignedToId || ''}
                onChange={(e) => handleAssign(contact.id, e.target.value)}
                style={{
                  padding: '0.375rem 0.5rem',
                  fontSize: '0.8rem',
                  minWidth: '130px',
                  background: 'var(--input-bg)',
                }}
              >
                <option value="">Unassigned</option>
                {assignableStaff(contact).map((s) => (
                  <option key={s.id} value={s.id}>
                    {staffOptionLabel(s)}
                  </option>
                ))}
              </select>
            ) : (
              <span
                style={{
                  fontSize: '0.875rem',
                  color: contact.assignedToId
                    ? 'var(--text-primary)'
                    : 'var(--text-secondary)',
                }}
                title={contact.assignedTo?.name || contact.assignedTo?.email || 'Unassigned'}
              >
                {contact.assignedTo?.name || contact.assignedTo?.email || 'Unassigned'}
              </span>
            )}
          </td>
        );
      case 'createdAt':
        return (
          <td
            key={column.key}
            style={getContactBodyCellStyle({ color: 'var(--text-secondary)', fontSize: '0.875rem' })}
            title={contact.createdAt ? formatDate(contact.createdAt) : ''}
          >
            {contact.createdAt ? formatDate(contact.createdAt) : '\u2014'}
          </td>
        );
      case 'actions':
        return (
          <td
            key={column.key}
            style={getContactBodyCellStyle({ textAlign: 'right', whiteSpace: 'nowrap' })}
          >
            <button
              onClick={() => setEditingContact(contact)}
              aria-label={`Edit contact ${contact.name || contact.email || ''}`}
              title="Edit contact"
              style={{
                background: 'none',
                border: 'none',
                color: 'var(--text-secondary)',
                cursor: 'pointer',
                marginRight: '0.5rem',
              }}
            >
              <Pencil size={16} />
            </button>
            <button
              onClick={() => handleDelete(contact.id)}
              aria-label={`Delete contact ${contact.name || contact.email || ''}`}
              title="Delete contact"
              style={{
                background: 'none',
                border: 'none',
                color: '#ef4444',
                cursor: 'pointer',
              }}
            >
              <Trash2 size={18} />
            </button>
          </td>
        );
      default:
        if (column.key.startsWith('cf_') && column.field) {
          return (
            <td
              key={column.key}
              style={getContactBodyCellStyle({
                padding: '0.5rem 1rem',
                color: 'var(--text-secondary)',
                fontSize: '0.875rem',
              })}
            >
              <InlineCellEditor
                contactId={contact.id}
                field={column.field}
                value={contact.customFields?.[column.field.fieldKey]}
                onSaved={(newValue) => {
                  setContacts((prev) =>
                    prev.map((c) =>
                      c.id === contact.id
                        ? {
                            ...c,
                            customFields: {
                              ...c.customFields,
                              [column.field.fieldKey]: newValue,
                            },
                          }
                        : c,
                    ),
                  );
                }}
              />
            </td>
          );
        }
        return null;
    }
  };
  const renderScrollableContactRow = (contact) => (
    <tr
      key={contact.id}
      style={{ borderBottom: '1px solid var(--border-color)' }}
      className="table-row-hover"
    >
      {contactsScrollableColumnDefs.map((column) =>
        renderScrollableContactCell(contact, column),
      )}
    </tr>
  );

  return (
    <div style={{ padding: '2rem' }}>
      {/* Renders only when this page was opened as a drill-down from a report. */}
      <ReturnToBanner />
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
          {isAdmin && (
            <div style={{ position: 'relative' }}>
              <button
                type="button"
                className="btn-secondary"
                onClick={() => setContactsBulkActionsOpen(prev => !prev)}
                aria-haspopup="menu"
                aria-expanded={contactsBulkActionsOpen}
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: '0.5rem',
                  justifyContent: 'center',
                }}
              >
                <SlidersHorizontal size={15} />
                Bulk actions
                {contactsBulkActionsOpen ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
                {selectedContacts.length > 0 && (
                  <span
                    style={{
                      minWidth: 18,
                      height: 18,
                      padding: '0 5px',
                      borderRadius: 999,
                      background: 'var(--accent-color)',
                      color: '#fff',
                      fontSize: '0.7rem',
                      fontWeight: 600,
                      display: 'inline-flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                    }}
                  >
                    {selectedContacts.length}
                  </span>
                )}
              </button>
              {contactsBulkActionsOpen && (
                <>
                  <div
                    style={{
                      position: 'fixed',
                      inset: 0,
                      zIndex: 1088,
                      background: 'transparent',
                    }}
                    onClick={() => setContactsBulkActionsOpen(false)}
                  />
                  <div
                    role="menu"
                    aria-label="Bulk actions"
                    onMouseDown={(e) => e.stopPropagation()}
                    style={{
                      position: 'absolute',
                      top: 'calc(100% + 4px)',
                      right: 0,
                      left: 'auto',
                      zIndex: 1089,
                      width: 'min(420px, 92vw)',
                      padding: '0.85rem',
                      background: 'var(--bg-color)',
                      border: '1px solid var(--border-color)',
                      borderRadius: 12,
                      boxShadow: '0 12px 32px rgba(0,0,0,0.2)',
                      display: 'grid',
                      gap: '0.75rem',
                    }}
                  >
                    <div
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'space-between',
                        gap: '0.5rem',
                      }}
                    >
                      <strong style={{ fontSize: '0.9rem', color: 'var(--text-primary)' }}>
                        Bulk actions
                      </strong>
                      <span style={{ fontSize: '0.78rem', color: 'var(--text-secondary)' }}>
                        {selectedContacts.length} selected
                      </span>
                    </div>
                    {selectedContacts.length === 0 ? (
                      <div style={{ fontSize: '0.85rem', color: 'var(--text-secondary)', lineHeight: 1.5 }}>
                        Select one or more contacts to use bulk actions.
                      </div>
                    ) : (
                      <div style={{ display: 'grid', gap: '0.65rem' }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap' }}>
                          <select
                            className="input-field"
                            value={bulkAgent}
                            onChange={e => setBulkAgent(e.target.value)}
                            style={{ flex: 1, minWidth: 180, padding: '0.5rem' }}
                            aria-label="Bulk assign staff"
                          >
                            <option value="">Unassign</option>
                            {staff.map(s => (
                              <option key={s.id} value={s.id}>{staffOptionLabel(s)}</option>
                            ))}
                          </select>
                          <button
                            type="button"
                            className="btn-secondary"
                            onClick={() => {
                              setContactsBulkActionsOpen(false);
                              handleBulkAssign();
                            }}
                            style={{
                              display: 'inline-flex',
                              alignItems: 'center',
                              justifyContent: 'center',
                              gap: '0.35rem',
                              fontSize: '0.85rem',
                            }}
                          >
                            <UserCheck size={14} /> Assign to staff
                          </button>
                        </div>
                        <button
                          type="button"
                          className="btn-danger"
                          onClick={handleBulkDelete}
                          style={{
                            display: 'inline-flex',
                            alignItems: 'center',
                            justifyContent: 'center',
                            gap: '0.35rem',
                            fontSize: '0.85rem',
                          }}
                        >
                          <Trash2 size={14} /> Delete selected contacts
                        </button>
                        <button
                          type="button"
                          className="btn-secondary"
                          onClick={() => {
                            setSelectedContacts([]);
                            setBulkAgent('');
                            setContactsBulkActionsOpen(false);
                          }}
                          style={{
                            display: 'inline-flex',
                            alignItems: 'center',
                            justifyContent: 'center',
                            gap: '0.35rem',
                            fontSize: '0.85rem',
                          }}
                        >
                          Clear selection
                        </button>
                      </div>
                    )}
                  </div>
                </>
              )}
            </div>
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
            <Download size={15} /> Import CSV/Excel
          </button>
          <button onClick={() => setShowModal(true)} className="btn-primary" style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <Plus size={18} /> Add Contact
          </button>
        </div>
      </header>

      <div className="card" style={{ overflow: 'hidden' }}>
        <div style={{ padding: '1rem', borderBottom: '1px solid var(--border-color)', display: 'flex', gap: '1rem', alignItems: 'center', flexWrap: 'wrap' }}>
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
              ...staff.map(s => ({ value: String(s.id), label: staffOptionLabel(s) })),
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
            {CONTACTS_SCORE_BUCKETS.map(b => (
              <option key={b.value} value={b.value}>{b.label}</option>
            ))}
          </select>
          <FilterPanel
            fieldsUrl="/api/contacts/filter-fields"
            valuesUrl={(field) => `/api/contacts/filter-values/${field}`}
            filters={advancedFilters}
            onChange={setAdvancedFilters}
          />
          {(searchTerm || statusFilter !== 'All' || assignedToFilter || scoreFilter || activeViewId != null || advancedFilters.length > 0) && (
            <>
              <span style={{ fontSize: '0.8rem', color: 'var(--text-secondary)' }}>
                Showing {visibleContacts.length} of {contacts.length}
              </span>
              <button
                onClick={() => { setSearchTerm(''); setStatusFilter('All'); setAssignedToFilter(''); setScoreFilter(''); setAdvancedFilters([]); }}
                style={{ background: 'none', border: 'none', color: 'var(--accent-color)', cursor: 'pointer', fontSize: '0.8rem' }}
              >
                Clear filters
              </button>
            </>
          )}
        </div>
        
        {/* Split-table layout: freeze the name column, keep the rest in a
            synced scrollable pane, and preserve the existing filters and
            row actions without changing the fetch or CRUD flows. */}
        <div className="contacts-split-table">
          <div
            className="contacts-table-frozen-pane"
            style={{ width: contactsFrozenTableWidthPx }}
          >
            <div className="contacts-table-frozen-spacer" />
            <table
              ref={contactsFrozenTableRef}
              className="contacts-table contacts-table--frozen"
              style={{
                width: contactsFrozenTableWidthPx,
                minWidth: contactsFrozenTableWidthPx,
                borderCollapse: 'separate',
                borderSpacing: 0,
                textAlign: 'left',
                tableLayout: 'fixed',
              }}
            >
              <colgroup>
                {contactsFrozenColumnDefs.map((column) => (
                  <col
                    key={column.key}
                    style={{ width: `${getColumnWidth(column.key)}px` }}
                  />
                ))}
              </colgroup>
              <thead>
                <tr style={{ backgroundColor: 'var(--table-header-bg)' }}>
                  {contactsFrozenColumnDefs.map((column) =>
                    column.key === 'select'
                      ? renderContactsHeaderCell(
                          column,
                          {},
                          { key: column.key },
                          <input
                            type="checkbox"
                            checked={
                              selectedContacts.length === sortedContacts.length &&
                              sortedContacts.length > 0
                            }
                            onChange={toggleSelectAllContacts}
                            onClick={(e) => e.stopPropagation()}
                            aria-label="Select all contacts"
                            style={{ cursor: 'pointer', margin: 0 }}
                          />,
                        )
                      : renderContactsHeaderCell(
                          column,
                          { paddingRight: '2rem' },
                          { key: column.key },
                        ),
                  )}
                </tr>
              </thead>
              <tbody>
                {loading ? (
                  <tr>
                    {contactsFrozenColumnDefs.map((column) => (
                      <td
                        key={column.key}
                        style={getContactBodyCellStyle({ padding: '2rem' })}
                      />
                    ))}
                  </tr>
                ) : sortedContacts.length === 0 ? (
                  <tr>
                    {contactsFrozenColumnDefs.map((column) => (
                      <td
                        key={column.key}
                        style={getContactBodyCellStyle({ padding: '2rem' })}
                      />
                    ))}
                  </tr>
                ) : (
                  sortedContacts.map(renderFrozenContactRow)
                )}
              </tbody>
            </table>
          </div>
          <div className="contacts-table-scroll-pane">
            <TopScrollSync
              forceScrollbar
              scrollWidth={contactsScrollableTableMinWidth}
              stickyTop
              stickyTopOffset={0}
              hideBottomScrollbar
            >
              <table
                ref={contactsScrollableTableRef}
                className="contacts-table contacts-table--scrollable"
                style={{
                  width: '100%',
                  minWidth: contactsScrollableTableMinWidth,
                  borderCollapse: 'separate',
                  borderSpacing: 0,
                  textAlign: 'left',
                  tableLayout: 'fixed',
                }}
              >
                <colgroup>
                  {contactsScrollableColumnDefs.map((column) => (
                    <col
                      key={column.key}
                      style={{ width: `${getColumnWidth(column.key)}px` }}
                    />
                  ))}
                </colgroup>
                <thead>
                  <tr style={{ backgroundColor: 'var(--table-header-bg)' }}>
                    {contactsScrollableColumnDefs.map((column) =>
                      renderContactsHeaderCell(
                        column,
                        column.key === 'actions'
                          ? { textAlign: 'right', paddingRight: '2rem' }
                          : { paddingRight: '2rem' },
                        { key: column.key },
                      ),
                    )}
                  </tr>
                </thead>
                <tbody>
                  {loading ? (
                    <tr>
                      <td
                        colSpan={contactsScrollableColumnDefs.length}
                        style={{
                          padding: '2rem',
                          textAlign: 'center',
                        }}
                      >
                        Loading contacts...
                      </td>
                    </tr>
                  ) : sortedContacts.length === 0 ? (
                    <tr>
                      <td
                        colSpan={contactsScrollableColumnDefs.length}
                        style={{
                          padding: '2rem',
                          textAlign: 'center',
                          color: 'var(--text-secondary)',
                        }}
                      >
                        {contacts.length === 0
                          ? 'No contacts yet. Click "Add Contact" or import a CSV.'
                          : `No contacts match "${searchTerm}"${statusFilter !== 'All' ? ` with status ${statusFilter}` : ''}.`}
                      </td>
                    </tr>
                  ) : (
                    sortedContacts.map(renderScrollableContactRow)
                  )}
                </tbody>
              </table>
            </TopScrollSync>
          </div>
        </div>
      </div>
      {showImportModal && (
        <div style={{ position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, background: 'var(--catalogue-modal-backdrop)', backdropFilter: 'blur(5px)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 100 }}>
          <div className="card" style={{ padding: '2rem', width: '600px', maxHeight: '80vh', overflowY: 'auto' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1.5rem' }}>
              <h3 style={{ fontSize: '1.25rem', fontWeight: 'bold', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                <FileSpreadsheet size={20} color="var(--accent-color)" /> Import CSV/Excel
              </h3>
              <button onClick={() => setShowImportModal(false)} aria-label="Close import dialog" title="Close" style={{ background: 'none', border: 'none', color: 'var(--text-secondary)', cursor: 'pointer' }}><X size={20} /></button>
            </div>

            <div style={{ marginBottom: '1.5rem' }}>
              <label style={{ display: 'block', padding: '2rem', border: '2px dashed var(--border-color)', borderRadius: '12px', textAlign: 'center', cursor: 'pointer', transition: 'var(--transition)' }}>
                <Download size={32} style={{ color: 'var(--text-secondary)', marginBottom: '0.5rem' }} />
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
