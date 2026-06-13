/**
 * RecoveryProgram.jsx — Visa Sure rejection-recovery program admin (G107).
 *
 * PRD_VISA_SURE_PHASE_3 §FR-7. Advisor-curated second-attempt programs for
 * previously-rejected applicants. The form below CRUDs the
 * `RejectionRecoveryProgram` Prisma model via the backend extension at
 * backend/routes/travel_visa.js:
 *
 *   GET   /api/travel/visa/recovery-programs?country=&active=
 *   POST  /api/travel/visa/recovery-programs                      (ADMIN/MANAGER)
 *   GET   /api/travel/visa/recovery-programs/:id                   (+enrolledCount)
 *   PUT   /api/travel/visa/recovery-programs/:id                   (ADMIN/MANAGER)
 *
 * Sibling AdvisorDashboard.jsx surfaces the per-application enrol CTA via
 * POST /api/travel/visa/applications/:id/enrol-recovery.
 *
 * Auth model: any travel-vertical authenticated user reaches this page
 * (wrapped by <TravelOnly>). Backend gates CRUD to ADMIN+MANAGER — this
 * page hides the CTAs (Add / Edit) for non-write users.
 */
import { useCallback, useContext, useEffect, useState } from 'react';
import { Plus, Edit2, RotateCw, ShieldAlert, X } from 'lucide-react';
import { fetchApi } from '../../../utils/api';
import { useNotify } from '../../../utils/notify';
import { AuthContext } from '../../../App';

const VISA_TYPES = [
  { value: '', label: 'All visa types' },
  { value: 'tourist', label: 'Tourist' },
  { value: 'business', label: 'Business' },
  { value: 'student', label: 'Student' },
  { value: 'work', label: 'Work' },
  { value: 'umrah', label: 'Umrah' },
  { value: 'hajj', label: 'Hajj' },
];

const EMPTY_FORM = {
  name: '',
  destinationCountry: '',
  visaType: '',
  description: '',
  durationDays: '',
  successRate: '',
  feeAmount: '',
  feeCurrency: 'USD',
  programSteps: '',
  isActive: true,
};

const FILTER_TABS = [
  { value: 'all', label: 'All programs' },
  { value: 'true', label: 'Active' },
  { value: 'false', label: 'Inactive' },
];

export default function RecoveryProgram() {
  const notify = useNotify();
  const { user } = useContext(AuthContext) || {};
  const role = user?.role || 'USER';
  const canWrite = role === 'ADMIN' || role === 'MANAGER';

  const [programs, setPrograms] = useState([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(null);
  const [activeTab, setActiveTab] = useState('all');
  const [countryFilter, setCountryFilter] = useState('');

  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState(null);
  const [form, setForm] = useState(EMPTY_FORM);
  const [saving, setSaving] = useState(false);

  const load = useCallback(() => {
    setLoading(true);
    setLoadError(null);
    const qs = new URLSearchParams();
    if (countryFilter.trim()) qs.set('country', countryFilter.trim());
    if (activeTab !== 'all') qs.set('active', activeTab);
    const suffix = qs.toString();
    const url = `/api/travel/visa/recovery-programs${suffix ? `?${suffix}` : ''}`;
    fetchApi(url)
      .then((res) => {
        setPrograms(Array.isArray(res?.programs) ? res.programs : []);
      })
      .catch((err) => {
        setLoadError(
          err?.body?.error ||
            err?.message ||
            'Failed to load recovery programs',
        );
        setPrograms([]);
      })
      .finally(() => setLoading(false));
  }, [countryFilter, activeTab]);

  useEffect(() => {
    load();
  }, [load]);

  const handleAdd = () => {
    setEditingId(null);
    setForm(EMPTY_FORM);
    setShowForm(true);
  };

  const handleEdit = (row) => {
    setEditingId(row.id);
    setForm({
      name: row.name || '',
      destinationCountry: row.destinationCountry || '',
      visaType: row.visaType || '',
      description: row.description || '',
      durationDays: row.durationDays != null ? String(row.durationDays) : '',
      successRate: row.successRate != null ? String(row.successRate) : '',
      feeAmount: row.feeAmount != null ? String(row.feeAmount) : '',
      feeCurrency: row.feeCurrency || 'USD',
      programSteps: row.programSteps || '',
      isActive: row.isActive !== false,
    });
    setShowForm(true);
  };

  const resetForm = () => {
    setShowForm(false);
    setEditingId(null);
    setForm(EMPTY_FORM);
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!canWrite) {
      notify.error('Only admins and managers can edit recovery programs.');
      return;
    }
    setSaving(true);
    try {
      const data = {
        name: form.name.trim(),
        destinationCountry: form.destinationCountry.trim(),
        visaType: form.visaType || null,
        description: form.description.trim() || null,
        durationDays:
          form.durationDays === '' ? null : Number(form.durationDays),
        successRate:
          form.successRate === '' ? null : Number(form.successRate),
        feeAmount: form.feeAmount === '' ? null : Number(form.feeAmount),
        feeCurrency: form.feeCurrency || null,
        programSteps: form.programSteps.trim() || null,
        isActive: form.isActive,
      };
      const url = editingId
        ? `/api/travel/visa/recovery-programs/${editingId}`
        : '/api/travel/visa/recovery-programs';
      const method = editingId ? 'PUT' : 'POST';
      await fetchApi(url, {
        method,
        body: JSON.stringify(data),
      });
      notify.success(
        editingId ? 'Recovery program updated' : 'Recovery program created',
      );
      resetForm();
      load();
    } catch (err) {
      notify.error(
        err?.body?.error || err?.message || 'Failed to save program',
      );
    } finally {
      setSaving(false);
    }
  };

  return (
    <div style={{ padding: 24, maxWidth: 1100, margin: '0 auto' }}>
      <div style={headingRow}>
        <div>
          <h1 style={titleRow}>
            <ShieldAlert size={26} aria-hidden /> Rejection Recovery Programs
          </h1>
          <p style={subtitleText}>
            Curate second-attempt programs for previously-refused applicants.
            Programs are linked to visa applications via the &ldquo;Enrol in
            recovery&rdquo; button on the Advisor Dashboard.
          </p>
        </div>
        {canWrite && !showForm && (
          <button
            type="button"
            onClick={handleAdd}
            style={primaryBtn}
            aria-label="Add recovery program"
          >
            <Plus size={14} /> Add program
          </button>
        )}
      </div>

      {/* Filters */}
      <div style={filterRow}>
        <div role="tablist" aria-label="Active filter" style={tabsRow}>
          {FILTER_TABS.map((t) => (
            <button
              key={t.value}
              type="button"
              role="tab"
              aria-selected={activeTab === t.value}
              onClick={() => setActiveTab(t.value)}
              style={activeTab === t.value ? tabActive : tabIdle}
            >
              {t.label}
            </button>
          ))}
        </div>
        <input
          value={countryFilter}
          onChange={(e) => setCountryFilter(e.target.value)}
          placeholder="Filter by destination country"
          aria-label="country filter"
          style={{ ...inputStyle, maxWidth: 240 }}
        />
        <button
          type="button"
          onClick={load}
          style={secondaryBtn}
          aria-label="Refresh list"
        >
          <RotateCw size={14} /> Refresh
        </button>
      </div>

      {/* Form */}
      {showForm && (
        <form onSubmit={handleSubmit} style={formCard}>
          <div style={formHeader}>
            <h2 style={{ margin: 0, fontSize: 18 }}>
              {editingId ? 'Edit program' : 'Add program'}
            </h2>
            <button
              type="button"
              onClick={resetForm}
              style={iconBtn}
              aria-label="Close form"
            >
              <X size={18} />
            </button>
          </div>

          <div style={fieldGrid}>
            <Field label="Name *">
              <input
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
                placeholder="USA B1/B2 second-attempt program"
                aria-label="name"
                style={inputStyle}
                required
              />
            </Field>
            <Field label="Destination country *">
              <input
                value={form.destinationCountry}
                onChange={(e) =>
                  setForm({ ...form, destinationCountry: e.target.value })
                }
                placeholder="US"
                aria-label="destinationCountry"
                style={inputStyle}
                required
              />
            </Field>
            <Field label="Visa type">
              <select
                value={form.visaType}
                onChange={(e) =>
                  setForm({ ...form, visaType: e.target.value })
                }
                aria-label="visaType"
                style={inputStyle}
              >
                {VISA_TYPES.map((v) => (
                  <option key={v.value} value={v.value}>
                    {v.label}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Duration (days)">
              <input
                type="number"
                min={0}
                value={form.durationDays}
                onChange={(e) =>
                  setForm({ ...form, durationDays: e.target.value })
                }
                placeholder="30"
                aria-label="durationDays"
                style={inputStyle}
              />
            </Field>
            <Field label="Historical success rate (%)">
              <input
                type="number"
                min={0}
                max={100}
                value={form.successRate}
                onChange={(e) =>
                  setForm({ ...form, successRate: e.target.value })
                }
                placeholder="65"
                aria-label="successRate"
                style={inputStyle}
              />
            </Field>
            <Field label="Fee amount">
              <input
                type="number"
                min={0}
                value={form.feeAmount}
                onChange={(e) =>
                  setForm({ ...form, feeAmount: e.target.value })
                }
                placeholder="5000"
                aria-label="feeAmount"
                style={inputStyle}
              />
            </Field>
            <Field label="Fee currency">
              <input
                value={form.feeCurrency}
                onChange={(e) =>
                  setForm({ ...form, feeCurrency: e.target.value.toUpperCase() })
                }
                placeholder="USD"
                aria-label="feeCurrency"
                style={inputStyle}
              />
            </Field>
            <Field label="Active">
              <label style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <input
                  type="checkbox"
                  checked={form.isActive}
                  onChange={(e) =>
                    setForm({ ...form, isActive: e.target.checked })
                  }
                  aria-label="isActive"
                />
                <span style={{ fontSize: 13, color: 'var(--text-secondary)' }}>
                  Enrolment open
                </span>
              </label>
            </Field>
          </div>

          <div style={{ marginTop: 12 }}>
            <Field label="Description">
              <textarea
                rows={3}
                value={form.description}
                onChange={(e) =>
                  setForm({ ...form, description: e.target.value })
                }
                placeholder="Short narrative for the advisor — what this program does, who it's for, expected runway."
                aria-label="description"
                style={{ ...inputStyle, resize: 'vertical' }}
              />
            </Field>
          </div>
          <div style={{ marginTop: 12 }}>
            <Field label="Program steps (markdown checklist)">
              <textarea
                rows={5}
                value={form.programSteps}
                onChange={(e) =>
                  setForm({ ...form, programSteps: e.target.value })
                }
                placeholder={'- Initial advisor consultation\n- Cover letter rewrite\n- Mock interview round'}
                aria-label="programSteps"
                style={{ ...inputStyle, resize: 'vertical' }}
              />
            </Field>
          </div>

          <div style={{ marginTop: 12, display: 'flex', gap: 8 }}>
            <button
              type="submit"
              style={saving ? primaryBtnDisabled : primaryBtn}
              disabled={saving}
            >
              {saving ? 'Saving…' : editingId ? 'Save changes' : 'Create'}
            </button>
            <button type="button" onClick={resetForm} style={secondaryBtn}>
              Cancel
            </button>
          </div>
        </form>
      )}

      {/* List */}
      {loading ? (
        <div style={emptyStyle}>Loading&hellip;</div>
      ) : loadError ? (
        <div role="alert" style={{ ...emptyStyle, color: 'var(--danger-color, #c33)' }}>
          {loadError}
        </div>
      ) : programs.length === 0 ? (
        <div style={emptyStyle}>
          No recovery programs match the current filter.
          {canWrite && ' Create one with “Add program” above.'}
        </div>
      ) : (
        <div
          role="list"
          aria-label="Recovery programs"
          style={{
            display: 'grid',
            gap: 12,
            gridTemplateColumns:
              'repeat(auto-fit, minmax(min(100%, 280px), 1fr))',
          }}
        >
          {programs.map((row) => (
            <div
              key={row.id}
              role="listitem"
              style={programCard}
              aria-label={`Program ${row.name}`}
            >
              <div>
                <div style={{ fontWeight: 600, fontSize: 15 }}>{row.name}</div>
                <div
                  style={{
                    fontSize: 12,
                    color: 'var(--text-secondary)',
                    marginTop: 2,
                  }}
                >
                  <code>{row.destinationCountry}</code>
                  {row.visaType ? ` · ${row.visaType}` : ''}
                  {row.isActive === false ? ' · inactive' : ''}
                </div>
              </div>
              {row.description && (
                <div style={{ fontSize: 13, color: 'var(--text-primary)' }}>
                  {row.description}
                </div>
              )}
              <div style={metaRow}>
                {row.durationDays != null && (
                  <span>~{row.durationDays} days</span>
                )}
                {row.successRate != null && (
                  <span>{Number(row.successRate)}% success</span>
                )}
                {row.feeAmount != null && (
                  <span>
                    {row.feeCurrency || ''} {Number(row.feeAmount).toLocaleString()}
                  </span>
                )}
              </div>
              {canWrite && (
                <div style={{ display: 'flex', gap: 6, marginTop: 'auto' }}>
                  <button
                    type="button"
                    onClick={() => handleEdit(row)}
                    style={iconBtn}
                    aria-label={`Edit ${row.name}`}
                  >
                    <Edit2 size={16} />
                  </button>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function Field({ label, children }) {
  return (
    <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 13 }}>
      <span style={{ color: 'var(--text-secondary)', fontWeight: 500 }}>
        {label}
      </span>
      {children}
    </label>
  );
}

// ── Shared styles ──────────────────────────────────────────────────────

const headingRow = {
  display: 'flex',
  justifyContent: 'space-between',
  alignItems: 'flex-start',
  flexWrap: 'wrap',
  gap: 12,
  marginBottom: 12,
};
const titleRow = {
  display: 'flex',
  alignItems: 'center',
  gap: 10,
  margin: 0,
  fontSize: 22,
};
const subtitleText = {
  color: 'var(--text-secondary)',
  marginTop: 4,
  marginBottom: 0,
  maxWidth: 720,
};
const filterRow = {
  display: 'flex',
  flexWrap: 'wrap',
  alignItems: 'center',
  gap: 12,
  marginBottom: 12,
};
const tabsRow = {
  display: 'flex',
  gap: 0,
  alignItems: 'center',
  borderBottom: '1px solid var(--border-color)',
};
const tabIdle = {
  padding: '8px 14px',
  fontWeight: 500,
  fontSize: 13,
  background: 'transparent',
  color: 'var(--text-secondary)',
  border: 'none',
  borderBottom: '2px solid transparent',
  cursor: 'pointer',
};
const tabActive = {
  ...tabIdle,
  color: 'var(--primary-color, var(--accent-color))',
  borderBottom: '2px solid var(--primary-color, var(--accent-color))',
};
const inputStyle = {
  padding: '8px 10px',
  borderRadius: 6,
  border: '1px solid var(--border-color)',
  background: 'var(--bg-color)',
  color: 'var(--text-primary)',
  fontSize: 13,
  width: '100%',
  boxSizing: 'border-box',
};
const primaryBtn = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 6,
  padding: '8px 14px',
  borderRadius: 6,
  fontWeight: 600,
  fontSize: 13,
  background: 'var(--primary-color, var(--accent-color))',
  color: '#fff',
  border: 'none',
  cursor: 'pointer',
};
const primaryBtnDisabled = {
  ...primaryBtn,
  opacity: 0.5,
  cursor: 'not-allowed',
};
const secondaryBtn = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 6,
  padding: '8px 14px',
  borderRadius: 6,
  fontWeight: 600,
  fontSize: 13,
  background: 'var(--surface-color)',
  color: 'var(--text-primary)',
  border: '1px solid var(--border-color)',
  cursor: 'pointer',
};
const iconBtn = {
  padding: 6,
  borderRadius: 4,
  background: 'transparent',
  color: 'var(--text-secondary)',
  border: '1px solid var(--border-color)',
  cursor: 'pointer',
};
const emptyStyle = {
  padding: 32,
  textAlign: 'center',
  color: 'var(--text-secondary)',
  fontSize: 14,
  background: 'var(--surface-color)',
  border: '1px solid var(--border-color)',
  borderRadius: 8,
};
const formCard = {
  background: 'var(--surface-color)',
  padding: 16,
  borderRadius: 8,
  border: '1px solid var(--border-color)',
  marginBottom: 16,
};
const formHeader = {
  display: 'flex',
  justifyContent: 'space-between',
  alignItems: 'center',
  marginBottom: 12,
};
const fieldGrid = {
  display: 'grid',
  gap: 12,
  gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 240px), 1fr))',
};
const programCard = {
  background: 'var(--surface-color)',
  border: '1px solid var(--border-color)',
  borderRadius: 8,
  padding: 14,
  display: 'flex',
  flexDirection: 'column',
  gap: 8,
};
const metaRow = {
  display: 'flex',
  flexWrap: 'wrap',
  gap: 10,
  fontSize: 12,
  color: 'var(--text-secondary)',
};
