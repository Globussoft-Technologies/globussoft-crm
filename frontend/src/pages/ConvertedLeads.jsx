import { fetchApi } from '../utils/api';
import { useState, useEffect, useContext } from 'react';
import { UserPlus, Search, Users, Filter, MoreVertical } from 'lucide-react';
import { useNotify } from '../utils/notify';
import { formatDateMedium as formatDate } from '../utils/date';
import { AuthContext } from '../App';
import FilterPanel from '../components/FilterPanel';
import TopScrollSync from '../components/TopScrollSync';
import Pagination from '../components/ui/Pagination';
import { useLeadCalling } from '../hooks/useLeadCalling';
import { LeadCallButton, LeadCallDialog } from '../components/wellness/LeadCallAction';

// #366: include Junk so the chip can show its count if the tenant uses it.
const STATUSES = ['Lead', 'Prospect', 'Customer', 'Churned', 'Junk'];
const DEFAULT_PAGE_SIZE = 10;
const PAGE_SIZE_OPTIONS = [10, 25, 50];
const MAX_CUSTOM_PAGE_SIZE = 200;
const TABLE_WIDTHS = {
  checkbox: 40,
  name: 220,
  email: 240,
  company: 220,
  leadScore: 120,
  source: 150,
  customField: 180,
  assignedTo: 160,
  createdAt: 140,
  actions: 120,
};
const sourceBadgeStyle = {
  padding: '0.25rem 0.75rem',
  borderRadius: '999px',
  fontSize: '0.75rem',
  fontWeight: 600,
  backgroundColor: 'var(--accent-bg, rgba(59, 130, 246, 0.15))',
  color: 'var(--accent-text, var(--primary-color, var(--accent-color, #8b5cf6)))',
  border: '1px solid var(--border-color)',
  whiteSpace: 'nowrap',
  display: 'inline-block',
};

const AVATAR_TONES = [
  { bg: 'rgba(239, 68, 68, 0.14)', fg: '#dc2626' },
  { bg: 'rgba(59, 130, 246, 0.14)', fg: '#2563eb' },
  { bg: 'rgba(16, 185, 129, 0.14)', fg: '#059669' },
  { bg: 'rgba(168, 85, 247, 0.14)', fg: '#7c3aed' },
  { bg: 'rgba(245, 158, 11, 0.16)', fg: '#d97706' },
  { bg: 'rgba(14, 165, 233, 0.14)', fg: '#0284c7' },
];

function hashString(value) {
  let hash = 0;
  const text = String(value || '');
  for (let i = 0; i < text.length; i += 1) {
    hash = (hash * 31 + text.charCodeAt(i)) >>> 0;
  }
  return hash;
}

function getLeadInitials(name) {
  const text = String(name || '').trim();
  if (!text) return '?';
  const parts = text.split(/\s+/).filter(Boolean);
  if (parts.length === 1) {
    return parts[0].slice(0, 2).toUpperCase();
  }
  return `${parts[0][0] || ''}${parts[parts.length - 1][0] || ''}`.toUpperCase();
}

function getLeadAvatarTone(name) {
  return AVATAR_TONES[hashString(name) % AVATAR_TONES.length];
}

function hasFilterValue(value) {
  if (Array.isArray(value)) return value.some((item) => hasFilterValue(item));
  if (value === 0) return true;
  return value !== null && value !== undefined && String(value).trim() !== '';
}

function normalizeFilterText(value) {
  return String(value ?? '').trim().toLowerCase();
}

function getFilterFieldValue(lead, field, customFieldDefs) {
  if (!field) return '';
  if (field.startsWith('custom_')) {
    const defId = field.slice('custom_'.length);
    const def = customFieldDefs.find((item) => String(item.id) === defId);
    return def ? lead.customFields?.[def.fieldKey] : '';
  }
  if (field === 'source') return lead.source || 'Organic';
  if (field === 'status') return lead.status || '';
  if (field === 'assignedToId') return lead.assignedToId == null ? '' : String(lead.assignedToId);
  if (field === 'createdAt') return lead.createdAt || '';
  if (field === 'name') return lead.name || '';
  if (field === 'email') return lead.email || '';
  if (field === 'company') return lead.company || '';
  if (field === 'aiScore') return lead.aiScore ?? '';
  return lead[field] ?? '';
}

function matchesAdvancedFilter(lead, filter, customFieldDefs) {
  const rawValue = getFilterFieldValue(lead, filter.field, customFieldDefs);
  const values = Array.isArray(filter.values) ? filter.values : [];
  const selectedValues = values.map((value) => normalizeFilterText(value)).filter(Boolean);
  const kind = filter.kind || 'text';

  if (filter.operator === 'is_empty') {
    return !hasFilterValue(rawValue);
  }

  if (filter.operator === 'is_not_empty') {
    return hasFilterValue(rawValue);
  }

  if (filter.operator === 'between') {
    const leadDate = new Date(rawValue);
    if (Number.isNaN(leadDate.getTime())) return false;
    const leadDay = leadDate.toISOString().slice(0, 10);
    const from = normalizeFilterText(values[0]).slice(0, 10);
    const to = normalizeFilterText(values[1]).slice(0, 10);
    if (from && leadDay < from) return false;
    if (to && leadDay > to) return false;
    return true;
  }

  const rawText = normalizeFilterText(rawValue);
  const rawItems = Array.isArray(rawValue)
    ? rawValue.map((value) => normalizeFilterText(value)).filter(Boolean)
    : [];
  const textLike = kind === 'text' || kind === 'textarea' || kind === 'url';

  if (filter.operator === 'contains') {
    if (rawItems.length > 0) {
      return selectedValues.some((value) => rawItems.includes(value));
    }
    if (textLike) {
      return selectedValues.some((value) => rawText.includes(value));
    }
    return selectedValues.some((value) => rawText === value);
  }

  if (filter.operator === 'not_contains') {
    if (rawItems.length > 0) {
      return selectedValues.every((value) => !rawItems.includes(value));
    }
    if (textLike) {
      return selectedValues.every((value) => !rawText.includes(value));
    }
    return selectedValues.every((value) => rawText !== value);
  }

  return true;
}

const ConvertedLeads = () => {
  const notify = useNotify();
  const auth = useContext(AuthContext);
  const isWellness = auth?.tenant?.vertical === 'wellness';
  const isTravel = auth?.tenant?.vertical === 'travel';
  // Wellness-only Callified calling; a no-op on generic / travel tenants.
  const leadCall = useLeadCalling();
  const [leads, setLeads] = useState([]);
  const [staff, setStaff] = useState([]);
  const [loading, setLoading] = useState(true);
  const [searchTerm, setSearchTerm] = useState('');
  const [selectedStatus, setSelectedStatus] = useState('Prospect');
  const [selectedLeads, setSelectedLeads] = useState([]);
  const [bulkAgent, setBulkAgent] = useState('');
  const [sourceFilter, setSourceFilter] = useState('');
  const [advancedFilters, setAdvancedFilters] = useState([]);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(DEFAULT_PAGE_SIZE);
  const [isCustomPageSize, setIsCustomPageSize] = useState(false);
  const [customPageSize, setCustomPageSize] = useState('');
  const [statusUpdatePending, setStatusUpdatePending] = useState(false);
  // Generic-vertical-only Lead custom fields (Settings > Lead Fields).
  const [customFieldDefs, setCustomFieldDefs] = useState([]);
  // #366: per-status counts powering the chip labels, e.g. "Prospect (12)".
  const [statusCounts, setStatusCounts] = useState({});

  const fetchLeads = (status) => {
    setLoading(true);
    fetchApi(`/api/contacts/by-status?status=${encodeURIComponent(status)}`)
      .then(response => {
        // #251: backend response shape is { success, count, data: [...] }, but
        // some sister endpoints return the raw array. Be defensive and handle
        // both  the previous code only read `response.data` and silently
        // showed 0 leads when the API returned an array directly (or when
        // .data was nested one level deeper inside an axios-style envelope).
        const rows = Array.isArray(response)
          ? response
          : (Array.isArray(response?.data) ? response.data
            : (Array.isArray(response?.data?.data) ? response.data.data
              : (Array.isArray(response?.contacts) ? response.contacts : [])));
        setLeads(rows);
        setLoading(false);
      })
      .catch(() => setLoading(false));
  };

  const fetchStaff = () => {
    fetchApi('/api/staff')
      .then(data => setStaff(data))
      .catch(() => {});
  };

  // #366: fetch counts for every chip in parallel so the labels stay live.
  // Each /by-status response is normalised the same way the main fetcher does.
  const fetchStatusCounts = () => {
    Promise.all(
      STATUSES.map(status =>
        fetchApi(`/api/contacts/by-status?status=${encodeURIComponent(status)}`)
          .then(response => {
            const rows = Array.isArray(response)
              ? response
              : (Array.isArray(response?.data) ? response.data
                : (Array.isArray(response?.data?.data) ? response.data.data
                  : (Array.isArray(response?.contacts) ? response.contacts : [])));
            return [status, rows.length];
          })
          .catch(() => [status, 0])
      )
    ).then(pairs => {
      setStatusCounts(Object.fromEntries(pairs));
    });
  };

  useEffect(() => {
    fetchLeads(selectedStatus);
    fetchStaff();
    fetchStatusCounts();
  }, [selectedStatus]);

  useEffect(() => {
    if (isWellness || isTravel) return;
    fetchApi('/api/lead-custom-fields')
      .then(d => setCustomFieldDefs(Array.isArray(d) ? d : []))
      .catch(() => setCustomFieldDefs([]));
  }, [isWellness, isTravel]);

  const handleStatusChange = (status) => {
    setSelectedStatus(status);
    setSelectedLeads([]);
    setBulkAgent('');
    setPage(1);
  };

  const handleAssign = async (contactId, assignedToId) => {
    await fetchApi(`/api/contacts/${contactId}/assign`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ assignedToId: assignedToId || null }),
    });
    fetchLeads(selectedStatus);
  };

  const updateContactStatus = async (
    contactId,
    name,
    nextStatus,
    { confirm = false, currentStatus = '', refresh = true, silent = false } = {},
  ) => {
    const trimmedStatus = String(nextStatus || '').trim();
    if (!trimmedStatus || trimmedStatus === currentStatus) return false;
    if (confirm) {
      const ok = await notify.confirm({
        title: 'Revert to Lead',
        message: `This will move ${name || 'the contact'} back to /leads. Continue?`,
      });
      if (!ok) return false;
    }
    try {
      await fetchApi(`/api/contacts/${contactId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: trimmedStatus }),
      });
      if (!silent) {
        notify.success?.(trimmedStatus === 'Lead' ? 'Reverted to Lead' : `Updated status to ${trimmedStatus}`);
      }
      if (refresh) {
        fetchLeads(selectedStatus);
        fetchStatusCounts();
      }
      return true;
    } catch (err) {
      notify.error?.(`Failed to update status: ${err.message || err}`);
      return false;
    }
  };

  // #367: revert a converted contact back to Lead status. Wraps in a confirm
  // dialog because it changes the user's working surface (the row disappears
  // from /converted-leads and reappears in /leads).
  const handleRevertToLead = async (contactId, name) => {
    await updateContactStatus(contactId, name, 'Lead', { confirm: true });
  };

  const handleStatusBarClick = async (nextStatus) => {
    if (statusUpdatePending) return;
    if (selectedLeads.length === 0) {
      handleStatusChange(nextStatus);
      return;
    }
    if (nextStatus === selectedStatus) {
      setSelectedLeads([]);
      setBulkAgent('');
      return;
    }
    if (nextStatus === 'Lead') {
      const ok = await notify.confirm({
        title: 'Update selected leads',
        message: `This will move ${selectedLeads.length} selected lead${selectedLeads.length === 1 ? '' : 's'} to Lead. Continue?`,
      });
      if (!ok) return;
    }
    setStatusUpdatePending(true);
    try {
      const results = await Promise.all(
        selectedLeads.map((id) => updateContactStatus(id, null, nextStatus, {
          currentStatus: selectedStatus,
          refresh: false,
          silent: true,
        }))
      );
      if (results.some(result => !result)) {
        fetchLeads(selectedStatus);
        fetchStatusCounts();
        return;
      }
      notify.success?.(`Updated ${selectedLeads.length} lead${selectedLeads.length === 1 ? '' : 's'} to ${nextStatus}`);
      setSelectedLeads([]);
      setBulkAgent('');
      setPage(1);
      setSelectedStatus(nextStatus);
    } catch (err) {
      notify.error?.(`Failed to update status: ${err.message || err}`);
      fetchLeads(selectedStatus);
      fetchStatusCounts();
    } finally {
      setStatusUpdatePending(false);
    }
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
    fetchLeads(selectedStatus);
  };

  const handleAdvancedFiltersChange = (nextFilters) => {
    setAdvancedFilters(Array.isArray(nextFilters) ? nextFilters : []);
    setPage(1);
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

  const sourceOptions = Array.from(
    new Set(
      leads
        .map((lead) => String(lead.source || 'Organic').trim() || 'Organic')
        .filter(Boolean),
    ),
  ).sort((a, b) => a.localeCompare(b));

  const filteredLeads = leads.filter((lead) => {
    const term = searchTerm.toLowerCase().trim();
    const leadSource = String(lead.source || 'Organic').trim() || 'Organic';
    if (sourceFilter && leadSource !== sourceFilter) return false;
    if (term) {
      const matchesSearch =
        (lead.name && lead.name.toLowerCase().includes(term)) ||
        (lead.email && lead.email.toLowerCase().includes(term)) ||
        (lead.company && lead.company.toLowerCase().includes(term));
      if (!matchesSearch) return false;
    }
    if (advancedFilters.length > 0) {
      return advancedFilters.every((filter) =>
        matchesAdvancedFilter(lead, filter, customFieldDefs),
      );
    }
    return true;
  });
  const pageCount = Math.max(1, Math.ceil(filteredLeads.length / pageSize));
  const safePage = Math.min(page, pageCount);
  const pageStart = (safePage - 1) * pageSize;
  const pageEnd = Math.min(pageStart + pageSize, filteredLeads.length);
  const pageLeads = filteredLeads.slice(pageStart, pageEnd);
  const tableMinWidth =
    TABLE_WIDTHS.checkbox
    + TABLE_WIDTHS.name
    + TABLE_WIDTHS.email
    + TABLE_WIDTHS.company
    + TABLE_WIDTHS.leadScore
    + TABLE_WIDTHS.source
    + (customFieldDefs.length * TABLE_WIDTHS.customField)
    + TABLE_WIDTHS.assignedTo
    + TABLE_WIDTHS.createdAt
    + TABLE_WIDTHS.actions;

  useEffect(() => {
    setPage(1);
  }, [searchTerm, pageSize, sourceFilter, advancedFilters]);

  const handlePageSizeChange = (value) => {
    if (value === 'custom') {
      setIsCustomPageSize(true);
      setCustomPageSize(PAGE_SIZE_OPTIONS.includes(pageSize) ? '' : String(pageSize));
      return;
    }
    const nextPageSize = Number(value);
    if (!Number.isFinite(nextPageSize) || nextPageSize <= 0) return;
    setIsCustomPageSize(false);
    setCustomPageSize('');
    setPageSize(nextPageSize);
    setPage(1);
  };

  const handleCustomPageSizeChange = (value) => {
    if (value === '') {
      setCustomPageSize('');
      return;
    }
    const raw = Number.parseInt(value, 10);
    if (!Number.isFinite(raw)) {
      setCustomPageSize('');
      return;
    }
    const nextPageSize = Math.min(Math.max(raw, 1), MAX_CUSTOM_PAGE_SIZE);
    setCustomPageSize(String(nextPageSize));
    setPageSize(nextPageSize);
    setPage(1);
  };

  const getStaffName = (staffId) => {
    if (!staffId) return 'Unassigned';
    const staffMember = staff.find(s => String(s.id) === String(staffId));
    return staffMember ? (staffMember.name || staffMember.email) : 'Unassigned';
  };

  return (
    <div className="converted-leads-page" style={{ padding: '2rem', animation: 'fadeIn 0.3s ease' }}>
      <header style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '1rem', marginBottom: '2rem', flexWrap: 'wrap' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
          <UserPlus size={24} style={{ color: 'var(--accent-color)' }} />
          <div>
            <h2 style={{ fontSize: '1.5rem', fontWeight: 'bold' }}>Converted Leads</h2>
            <p style={{ color: 'var(--text-secondary)', fontSize: '0.875rem' }}>
              {leads.length} lead{leads.length !== 1 ? 's' : ''} in {selectedStatus}
            </p>
          </div>
        </div>
      </header>

      {/* Bulk Assign Bar */}
      {selectedLeads.length > 0 && (
        <div className="card" style={{ padding: '0.75rem 1.25rem', marginBottom: '1rem', display: 'flex', alignItems: 'center', gap: '1rem', background: 'rgba(59, 130, 246, 0.08)', border: '1px solid rgba(59, 130, 246, 0.2)' }}>
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
            Assign
          </button>
          <button onClick={() => setSelectedLeads([])} style={{ background: 'none', border: 'none', color: 'var(--text-secondary)', cursor: 'pointer', fontSize: '0.875rem' }}>
            Clear
          </button>
        </div>
      )}

      <div className="card converted-leads__overview-card" style={{ marginBottom: '1rem', overflow: 'hidden', maxHeight: 'unset', minHeight: 'auto' }}>
        <div className="converted-leads__overview-grid">
          <div className="converted-leads__lifecycle-panel">
            <label className="converted-leads__lifecycle-label">
              Lifecycle stage
            </label>
            <select
              className="input-field converted-leads__lifecycle-select"
              value={selectedStatus}
              onChange={e => handleStatusChange(e.target.value)}
              aria-label="Lifecycle stage"
            >
              {STATUSES.map((status) => (
                <option key={status} value={status}>
                  {status}
                </option>
              ))}
            </select>
          </div>

          <div className="converted-leads__status-panel">
            <div className="converted-leads__status-header">
              <Filter size={14} className="converted-leads__status-icon" />
              <div className="converted-leads__status-copy">
                <h3 className="converted-leads__status-title">Status</h3>
                <p className="converted-leads__status-description">
                  {selectedLeads.length > 0
                    ? `Update ${selectedLeads.length} selected lead${selectedLeads.length === 1 ? '' : 's'} with the status bar below.`
                    : 'Click a status to filter the table, or select rows first to change their status.'}
                </p>
              </div>
            </div>

            <div
              className="converted-leads__status-grid"
              role="toolbar"
              aria-label="Converted lead status filter"
            >
              {STATUSES.map((status, index) => {
                const active = selectedStatus === status;
                const count = statusCounts[status] ?? 0;
                return (
                  <button
                    key={status}
                    type="button"
                    className={`converted-leads__status-button${active ? ' is-active' : ''}`}
                    onClick={() => handleStatusBarClick(status)}
                    disabled={statusUpdatePending}
                    aria-pressed={active}
                    aria-label={`${status} (${count})`}
                    title={selectedLeads.length > 0 ? `Change selected leads to ${status}` : `Filter by ${status}`}
                    style={{ zIndex: active ? STATUSES.length + 1 : STATUSES.length - index }}
                  >
                    <span className="converted-leads__status-name">{status}</span>
                    <span className="converted-leads__status-count">
                      {count} lead{count === 1 ? '' : 's'}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>
        </div>
      </div>

      <div className="card converted-leads__controls-card" style={{ overflow: 'hidden', maxHeight: 'unset', minHeight: 'auto' }}>
        <div
          className="converted-leads__controls-row"
        >
          <div className="converted-leads__search-wrap">
            <Search
              size={18}
              className="converted-leads__search-icon"
            />
            <input
              type="text"
              className="input-field"
              placeholder="Search leads..."
              value={searchTerm}
              onChange={e => setSearchTerm(e.target.value)}
              style={{ paddingLeft: '2.5rem', backgroundColor: 'var(--surface-hover)' }}
            />
          </div>

          <div className="converted-leads__controls-actions">
            <select
              className="input-field converted-leads__source-select"
              aria-label="All sources"
              value={sourceFilter}
              onChange={(e) => {
                setSourceFilter(e.target.value);
                setPage(1);
              }}
            >
              <option value="">All sources</option>
              {sourceOptions.map((option) => (
                <option key={option} value={option}>
                  {option}
                </option>
              ))}
            </select>
            <FilterPanel
              fieldsUrl={`/api/contacts/filter-fields?status=${encodeURIComponent(selectedStatus)}`}
              valuesUrl={(field) => `/api/contacts/filter-values/${field}?status=${encodeURIComponent(selectedStatus)}`}
              filters={advancedFilters}
              onChange={handleAdvancedFiltersChange}
              triggerLabel="Filters"
              triggerIcon={<Filter size={14} />}
              showSelectedFilters={false}
              showCountBadge={false}
              buttonTitle="Filters"
              buttonAriaLabel="Filters"
              buttonStyle={{
                minWidth: '128px',
                padding: '0.75rem 1rem',
                borderRadius: '10px',
                border: '1px solid var(--border-color)',
                background: 'var(--surface-color)',
                color: 'var(--text-primary)',
                fontWeight: 500,
              }}
            />
          </div>
        </div>

        {/* overflow-x wrapper the dynamic Lead-custom-field columns can push this table wider than the viewport. */}
        <TopScrollSync scrollWidth={`${tableMinWidth}px`}>
          <table style={{ width: '100%', borderCollapse: 'collapse', textAlign: 'left', minWidth: `${tableMinWidth}px`, tableLayout: 'fixed' }}>
            <colgroup>
              <col style={{ width: `${TABLE_WIDTHS.checkbox}px` }} />
              <col style={{ width: `${TABLE_WIDTHS.name}px` }} />
              <col style={{ width: `${TABLE_WIDTHS.email}px` }} />
              <col style={{ width: `${TABLE_WIDTHS.company}px` }} />
              <col style={{ width: `${TABLE_WIDTHS.leadScore}px` }} />
              <col style={{ width: `${TABLE_WIDTHS.source}px` }} />
              {customFieldDefs.map(f => (
                <col key={f.id} style={{ width: `${TABLE_WIDTHS.customField}px` }} />
              ))}
              <col style={{ width: `${TABLE_WIDTHS.assignedTo}px` }} />
              <col style={{ width: `${TABLE_WIDTHS.createdAt}px` }} />
              <col style={{ width: `${TABLE_WIDTHS.actions}px` }} />
            </colgroup>
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
                {/* Generic-vertical-only Lead custom fields (Settings > Lead Fields). */}
                {customFieldDefs.map(f => (
                  <th key={f.id} style={{ padding: '1rem', color: 'var(--text-secondary)', fontWeight: '500', fontSize: '0.875rem' }}>{f.label}</th>
                ))}
                <th style={{ padding: '1rem', color: 'var(--text-secondary)', fontWeight: '500', fontSize: '0.875rem' }}>Assigned To</th>
                <th style={{ padding: '1rem', color: 'var(--text-secondary)', fontWeight: '500', fontSize: '0.875rem' }}>Created</th>
                {/* #367: per-row Revert to Lead control. */}
                <th style={{ padding: '1rem', color: 'var(--text-secondary)', fontWeight: '500', fontSize: '0.875rem' }}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr><td colSpan={9 + customFieldDefs.length} style={{ padding: '2rem', textAlign: 'center', color: 'var(--text-secondary)' }}>Loading leads...</td></tr>
              ) : filteredLeads.length === 0 ? (
                <tr><td colSpan={9 + customFieldDefs.length} style={{ padding: '2rem', textAlign: 'center', color: 'var(--text-secondary)' }}>No leads found</td></tr>
              ) : pageLeads.map(lead => (
                <tr key={lead.id} style={{ borderBottom: '1px solid var(--border-color)' }} className="table-row-hover">
                  <td style={{ padding: '1rem' }}>
                    <input type="checkbox" checked={selectedLeads.includes(lead.id)} onChange={() => toggleSelect(lead.id)} style={{ cursor: 'pointer' }} />
                  </td>
                  <td style={{ padding: '1rem', fontWeight: '500' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', minWidth: 0 }}>
                      <span
                        style={{
                          width: '2.25rem',
                          height: '2.25rem',
                          borderRadius: '999px',
                          display: 'inline-flex',
                          alignItems: 'center',
                          justifyContent: 'center',
                          flexShrink: 0,
                          background: getLeadAvatarTone(lead.name).bg,
                          color: getLeadAvatarTone(lead.name).fg,
                          fontSize: '0.75rem',
                          fontWeight: 700,
                          letterSpacing: '0.02em',
                        }}
                      >
                        {getLeadInitials(lead.name)}
                      </span>
                      <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {lead.name}
                      </span>
                    </div>
                  </td>
                  <td style={{ padding: '1rem', color: 'var(--text-secondary)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    {lead.email}
                  </td>
                  <td style={{ padding: '1rem', color: 'var(--text-secondary)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    {lead.company}
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
                    <span style={sourceBadgeStyle}>
                      {lead.source || 'Organic'}
                    </span>
                  </td>
                  {/* Generic-vertical-only Lead custom fields  value or a
                      dash for leads that predate the field. */}
                  {customFieldDefs.map(f => {
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
                        {display ?? <span style={{ color: 'var(--border-color)' }}></span>}
                      </td>
                    );
                  })}
                  <td style={{ padding: '1rem' }}>
                    <select
                      className="input-field"
                      value={String(lead.assignedToId || '')}
                      onChange={e => handleAssign(lead.id, e.target.value || null)}
                      style={{ padding: '0.375rem 0.5rem', fontSize: '0.8rem', minWidth: '130px', background: 'var(--input-bg)' }}
                      title={getStaffName(lead.assignedToId)}
                    >
                      <option value="">Unassigned</option>
                      {staff.map(s => (
                        <option key={s.id} value={String(s.id)}>{s.name || s.email}</option>
                      ))}
                    </select>
                  </td>
                  <td style={{ padding: '1rem', color: 'var(--text-secondary)', fontSize: '0.875rem' }}>
                    {formatDate(lead.createdAt)}
                  </td>
                  {/* #367: revert flow  confirm dialog moves the contact back to /leads. */}
                  <td style={{ padding: '1rem' }}>
                    {leadCall.enabled && (
                      <LeadCallButton lead={lead} onCall={() => leadCall.open(lead)} />
                    )}
                    <button
                      onClick={() => handleRevertToLead(lead.id, lead.name)}
                      aria-label={`Revert ${lead.name || 'lead'} to Lead`}
                      title="Revert to Lead"
                      style={{
                        background: 'transparent',
                        border: '1px solid var(--border-color)',
                        borderRadius: '10px',
                        width: '2.2rem',
                        height: '2.2rem',
                        cursor: 'pointer',
                        color: 'var(--text-secondary)',
                        display: 'inline-flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                      }}
                    >
                      <MoreVertical size={15} />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </TopScrollSync>
        {!loading && filteredLeads.length > 0 && (
          <div style={{ borderTop: '1px solid var(--border-color)', padding: '0.85rem 1rem 1rem' }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '1rem', flexWrap: 'wrap' }}>
              <label
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: '0.35rem',
                  fontSize: '0.85rem',
                  color: 'var(--text-secondary)',
                }}
              >
                Per page:
                {isCustomPageSize ? (
                  <>
                    <input
                      type="number"
                      min="1"
                      max={MAX_CUSTOM_PAGE_SIZE}
                      aria-label="Custom converted leads per page"
                      value={customPageSize}
                      onChange={(e) => handleCustomPageSizeChange(e.target.value)}
                      placeholder={`1-${MAX_CUSTOM_PAGE_SIZE}`}
                      autoFocus
                      title={`Enter a number between 1 and ${MAX_CUSTOM_PAGE_SIZE}`}
                      style={{
                        width: '88px',
                        padding: '0.35rem 0.5rem',
                        borderRadius: 6,
                        border: '1px solid var(--border-color)',
                        background: 'var(--surface-color)',
                        color: 'var(--text-primary)',
                        fontSize: '0.85rem',
                      }}
                    />
                    <button
                      type="button"
                      onClick={() => {
                        setIsCustomPageSize(false);
                        setCustomPageSize('');
                      }}
                      style={{
                        padding: '0.35rem 0.6rem',
                        borderRadius: 6,
                        border: '1px solid var(--border-color)',
                        background: 'var(--surface-color)',
                        color: 'var(--text-primary)',
                        fontSize: '0.85rem',
                        cursor: 'pointer',
                      }}
                    >
                      Back
                    </button>
                  </>
                ) : (
                  <select
                    aria-label="Converted leads per page"
                    value={PAGE_SIZE_OPTIONS.includes(pageSize) ? String(pageSize) : 'custom'}
                    onChange={(e) => handlePageSizeChange(e.target.value)}
                    style={{
                      padding: '0.35rem 0.5rem',
                      borderRadius: 6,
                      border: '1px solid var(--border-color)',
                      background: 'var(--surface-color)',
                      color: 'var(--text-primary)',
                      fontSize: '0.85rem',
                      cursor: 'pointer',
                    }}
                  >
                    {PAGE_SIZE_OPTIONS.map((n) => (
                      <option key={n} value={n}>{n}</option>
                    ))}
                    <option value="custom">Custom</option>
                  </select>
                )}
              </label>
            </div>
            <Pagination
              page={safePage}
              pageSize={pageSize}
              total={filteredLeads.length}
              onChange={setPage}
              style={{ marginTop: '0.5rem' }}
            />
          </div>
        )}
      </div>
      <LeadCallDialog lead={leadCall.target} onClose={leadCall.close} />
    </div>
  );
};

export default ConvertedLeads;
