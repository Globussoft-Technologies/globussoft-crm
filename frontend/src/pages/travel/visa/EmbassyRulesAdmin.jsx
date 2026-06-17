/**
 * EmbassyRulesAdmin.jsx — ADMIN-only CRUD admin page for the Visa Sure
 * embassy-rules catalogue (Phase 3, PC-3 + PC-7 resolved tick #175).
 *
 * Consumes /api/embassy-rules (backend commit 05587ac7, route at
 * backend/routes/embassy_rules.js — 5 endpoints: list, get, create,
 * update, delete-soft). The route gates POST / PUT / DELETE on ADMIN
 * role; GET is verifyToken-only. This page mirrors that contract:
 * the New / Edit / Delete CTAs are hidden for non-ADMIN users.
 *
 * Backend contract pinned (per backend/routes/embassy_rules.js):
 *   GET    /api/embassy-rules?destinationCountry&applicationType&ruleType
 *                            &severity&isActive&limit&offset
 *          → { rules:[…], total, limit, offset }
 *   GET    /api/embassy-rules/:id          → single rule
 *   POST   /api/embassy-rules              → 201 created (ADMIN-only)
 *          body: { ruleType, destinationCountry, applicationType?,
 *                  conditionJson?, actionLabel, severity, isActive? }
 *   PUT    /api/embassy-rules/:id          → 200 updated (ADMIN-only)
 *   DELETE /api/embassy-rules/:id          → 200 soft-deleted, isActive=false
 *
 * Error codes mapped to user-friendly messages (per route header):
 *   INVALID_DESTINATION_COUNTRY → "Destination country must be a 2-letter
 *                                  ISO code (e.g. US, GB, AE)"
 *   INVALID_SEVERITY            → "Severity must be info, warning, or blocker"
 *   INVALID_RULE_TYPE           → "Rule type is required"
 *   MISSING_FIELDS              → backend's message (names the field)
 *   EMPTY_BODY                  → "No updatable fields provided"
 *   INVALID_ID                  → "Invalid rule id"
 *   RBAC_DENIED                 → "Only admins can modify embassy rules"
 *   EMBASSY_RULE_NOT_FOUND      → "Rule no longer exists (refresh)"
 *   EMBASSY_RULE_DUPLICATE      → "A rule with that country + type +
 *                                  application-type combination already exists"
 *
 * Sub-brand context: Visa Sure-implicit. Backend scopes by req.user.tenantId
 * with no sub-brand discriminator in the EmbassyRule model, so no
 * sub-brand selector is rendered on this page.
 *
 * Severity badge colors via CSS classes (per tick #116 Itineraries.jsx
 * className-not-inline-hex pattern). The classes are defined inline at
 * the bottom of the module via a <style> block; the wellness theme +
 * generic theme both pick them up unchanged.
 *
 * Path: frontend/src/pages/travel/visa/EmbassyRulesAdmin.jsx — sibling
 * to Applications.jsx / Dashboard.jsx / Checklists.jsx in the same
 * Phase 3 Visa Sure folder.
 */
import { useContext, useEffect, useState } from 'react';
import { Shield, Plus, Edit2, Trash2, X, AlertTriangle } from 'lucide-react';
import { fetchApi } from '../../../utils/api';
import { useNotify } from '../../../utils/notify';
import { AuthContext } from '../../../App';

const SEVERITIES = ['info', 'warning', 'blocker'];

// Common rule-type tokens the embassy advisor-head curates. The
// backend accepts arbitrary non-empty strings; the dropdown is a
// suggestion list. Operators can free-type other values via the input.
const RULE_TYPE_SUGGESTIONS = [
  'document_required',
  'cooldown_period',
  'interview_required',
  'minimum_funds',
  'photo_specification',
  'sponsor_documentation',
];

// Application types pinned to the Visa Sure schema (backend routes/
// travel_visa.js VALID_APPLICATION_TYPES). null/empty = "applies to
// all application types" per the route's nullable applicationType
// column convention.
const APPLICATION_TYPES = [
  { value: '', label: 'All application types' },
  { value: 'tourist', label: 'Tourist' },
  { value: 'business', label: 'Business' },
  { value: 'student', label: 'Student' },
  { value: 'work', label: 'Work' },
  { value: 'umrah', label: 'Umrah' },
  { value: 'hajj', label: 'Hajj' },
];

const EMPTY_FORM = {
  ruleType: '',
  destinationCountry: '',
  applicationType: '',
  conditionJson: '',
  actionLabel: '',
  severity: 'warning',
  isActive: true,
};

// Backend code → user-friendly message map. Returns the backend's own
// message as a fallback (it's already human-readable for MISSING_FIELDS).
function errorCodeToMessage(code, fallback) {
  switch (code) {
    case 'INVALID_DESTINATION_COUNTRY':
      return 'Destination country must be a 2-letter ISO code (e.g. US, GB, AE)';
    case 'INVALID_SEVERITY':
      return 'Severity must be one of: info, warning, blocker';
    case 'INVALID_RULE_TYPE':
      return 'Rule type is required';
    case 'EMPTY_BODY':
      return 'No updatable fields provided';
    case 'INVALID_ID':
      return 'Invalid rule id';
    case 'RBAC_DENIED':
      return 'Only admins can modify embassy rules';
    case 'EMBASSY_RULE_NOT_FOUND':
      return 'Rule no longer exists (refresh the page)';
    case 'EMBASSY_RULE_DUPLICATE':
      return 'A rule with that country + rule-type + application-type combination already exists';
    default:
      return fallback || 'Request failed';
  }
}

function SeverityBadge({ severity }) {
  if (!severity) return <span style={{ color: 'var(--text-secondary)' }}>—</span>;
  return (
    <span className={`embassy-rule-severity embassy-rule-severity-${severity}`}>
      {severity}
    </span>
  );
}

export default function EmbassyRulesAdmin() {
  const notify = useNotify();
  const { user } = useContext(AuthContext) || {};
  const isAdmin = user?.role === 'ADMIN';

  const [rules, setRules] = useState([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');

  // Filter state.
  const [filterCountry, setFilterCountry] = useState('');
  const [filterRuleType, setFilterRuleType] = useState('');
  const [filterSeverity, setFilterSeverity] = useState('');
  const [filterIsActive, setFilterIsActive] = useState('all'); // all | true | false

  // Modal state.
  const [modalOpen, setModalOpen] = useState(false);
  const [editingId, setEditingId] = useState(null);
  const [form, setForm] = useState(EMPTY_FORM);
  const [formError, setFormError] = useState(null);
  const [submitting, setSubmitting] = useState(false);

  const buildQuery = () => {
    const qs = new URLSearchParams();
    if (filterCountry.trim()) qs.set('destinationCountry', filterCountry.trim().toUpperCase());
    if (filterRuleType.trim()) qs.set('ruleType', filterRuleType.trim());
    if (filterSeverity) qs.set('severity', filterSeverity);
    if (filterIsActive !== 'all') qs.set('isActive', filterIsActive);
    return qs.toString();
  };

  const load = async () => {
    setLoading(true);
    setLoadError('');
    const qs = buildQuery();
    const url = `/api/embassy-rules${qs ? `?${qs}` : ''}`;
    try {
      const res = await fetchApi(url);
      setRules(Array.isArray(res?.rules) ? res.rules : []);
    } catch (e) {
      setLoadError(e?.message || 'Failed to load embassy rules');
      setRules([]);
    } finally {
      setLoading(false);
    }
  };

  // Initial + filter-change load. We intentionally pass the filter
  // state as deps so changing any filter re-fetches with the new query.
  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filterCountry, filterRuleType, filterSeverity, filterIsActive]);

  const openCreate = () => {
    setEditingId(null);
    setForm(EMPTY_FORM);
    setFormError(null);
    setModalOpen(true);
  };

  const openEdit = (rule) => {
    setEditingId(rule.id);
    setForm({
      ruleType: rule.ruleType || '',
      destinationCountry: rule.destinationCountry || '',
      applicationType: rule.applicationType || '',
      conditionJson: rule.conditionJson || '',
      actionLabel: rule.actionLabel || '',
      severity: rule.severity || 'warning',
      isActive: rule.isActive !== false,
    });
    setFormError(null);
    setModalOpen(true);
  };

  const closeModal = () => {
    setModalOpen(false);
    setFormError(null);
  };

  // Client-side JSON validation so the operator gets feedback before
  // a round-trip. Empty string → null (backend treats it as "no
  // condition" per the column nullable contract).
  const validateConditionJson = (raw) => {
    const trimmed = (raw || '').trim();
    if (!trimmed) return { ok: true, value: null };
    try {
      JSON.parse(trimmed);
      return { ok: true, value: trimmed };
    } catch {
      return { ok: false, error: 'Condition JSON is not valid JSON. Check for missing quotes or commas.' };
    }
  };

  const submit = async (e) => {
    e.preventDefault();
    setFormError(null);

    // Client-side gates mirroring backend MISSING_FIELDS /
    // INVALID_DESTINATION_COUNTRY / INVALID_SEVERITY checks. Backend
    // remains the source of truth.
    const country = (form.destinationCountry || '').trim().toUpperCase();
    if (!country) {
      setFormError({ field: 'destinationCountry', message: 'Destination country is required' });
      return;
    }
    if (!/^[A-Z]{2}$/.test(country)) {
      setFormError({
        field: 'destinationCountry',
        message: 'Destination country must be a 2-letter ISO code (e.g. US, GB, AE)',
      });
      return;
    }
    // Note: ruleType + actionLabel missing-field cases are covered by the
    // HTML5 `required` attribute on the corresponding <input> elements (the
    // browser pre-empts submit and shows a native validation tooltip). No
    // custom JS gate needed here. See closed issue #978.
    if (!SEVERITIES.includes(form.severity)) {
      setFormError({ field: 'severity', message: 'Pick a severity' });
      return;
    }
    const jsonCheck = validateConditionJson(form.conditionJson);
    if (!jsonCheck.ok) {
      setFormError({ field: 'conditionJson', message: jsonCheck.error });
      return;
    }

    const body = {
      ruleType: form.ruleType.trim(),
      destinationCountry: country,
      applicationType: form.applicationType ? form.applicationType : null,
      conditionJson: jsonCheck.value,
      actionLabel: form.actionLabel.trim(),
      severity: form.severity,
      isActive: Boolean(form.isActive),
    };

    setSubmitting(true);
    try {
      const url = editingId
        ? `/api/embassy-rules/${editingId}`
        : '/api/embassy-rules';
      const method = editingId ? 'PUT' : 'POST';
      await fetchApi(url, {
        method,
        body: JSON.stringify(body),
        silent: true,
      });
      notify.success(editingId ? 'Embassy rule updated' : 'Embassy rule created');
      closeModal();
      load();
    } catch (err) {
      const code = err?.code || err?.data?.code;
      const backendMsg = err?.data?.error || err?.message || 'Save failed';
      const userMsg = errorCodeToMessage(code, backendMsg);
      let field = null;
      switch (code) {
        case 'INVALID_DESTINATION_COUNTRY':
          field = 'destinationCountry';
          break;
        case 'INVALID_SEVERITY':
          field = 'severity';
          break;
        case 'INVALID_RULE_TYPE':
          field = 'ruleType';
          break;
        case 'MISSING_FIELDS':
          field = null;
          break;
        default:
          field = null;
      }
      setFormError({ field, code: code || null, message: userMsg });
      notify.error(userMsg);
    } finally {
      setSubmitting(false);
    }
  };

  const handleDelete = (rule) => {
    if (!isAdmin) return;
    // Wellness pattern (per CLAUDE.md): native confirm for hard-stop ops.
    // Embassy rules are soft-deleted (set isActive=false) so the wording
    // names that explicitly.
    const ok = window.confirm(
      `Deactivate embassy rule "${rule.actionLabel}" (${rule.destinationCountry} / ${rule.ruleType})?\n\nThis is a soft delete — the rule will be marked inactive but kept in the audit history.`,
    );
    if (!ok) return;
    fetchApi(`/api/embassy-rules/${rule.id}`, { method: 'DELETE', silent: true })
      .then(() => {
        notify.success('Embassy rule deactivated');
        load();
      })
      .catch((err) => {
        const code = err?.code || err?.data?.code;
        const userMsg = errorCodeToMessage(code, err?.message || 'Delete failed');
        notify.error(userMsg);
      });
  };

  return (
    <div style={{ padding: 24, maxWidth: 1200, margin: '0 auto' }}>
      {/* Inline style block for the severity badge classes. Keeps the
          theme-friendly color values in one place + avoids spraying
          hex codes through inline styles (per Itineraries.jsx pattern). */}
      <style>{`
        .embassy-rule-severity {
          display: inline-block;
          padding: 2px 8px;
          border-radius: 4px;
          font-size: 11px;
          font-weight: 600;
          text-transform: uppercase;
          letter-spacing: 0.5px;
        }
        .embassy-rule-severity-info {
          background: rgba(38, 88, 85, 0.14);
          color: #265855;
        }
        .embassy-rule-severity-warning {
          background: rgba(200, 154, 78, 0.16);
          color: #9A6F2E;
        }
        .embassy-rule-severity-blocker {
          background: rgba(168, 50, 63, 0.16);
          color: #A8323F;
        }
      `}</style>

      <header
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'flex-start',
          flexWrap: 'wrap',
          gap: 12,
          marginBottom: 16,
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
            <Shield size={28} aria-hidden /> Embassy Rules
          </h1>
          <p style={{ color: 'var(--text-secondary)', margin: 0 }}>
            Per-destination quirks for the Visa Sure risk-flag engine. Rules drive
            the advisor warnings that surface on each application
            (cooldown periods, document gaps, sponsor requirements, &amp; more).
          </p>
        </div>
        {isAdmin && (
          <button
            type="button"
            onClick={openCreate}
            style={primaryBtn}
            aria-label="Create a new embassy rule"
            data-testid="embassy-rule-new"
          >
            <Plus size={14} /> New Rule
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
        <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12, color: 'var(--text-secondary)' }}>
          Country (ISO-2)
          <input
            type="text"
            value={filterCountry}
            onChange={(e) => setFilterCountry(e.target.value)}
            placeholder="e.g. US"
            maxLength={2}
            aria-label="Filter by destination country"
            style={{ ...inputStyle, minWidth: 80, width: 90, textTransform: 'uppercase' }}
          />
        </label>
        <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12, color: 'var(--text-secondary)' }}>
          Rule type
          <input
            type="text"
            value={filterRuleType}
            onChange={(e) => setFilterRuleType(e.target.value)}
            placeholder="e.g. document_required"
            aria-label="Filter by rule type"
            list="embassy-rule-type-suggestions"
            style={{ ...inputStyle, minWidth: 160 }}
          />
          <datalist id="embassy-rule-type-suggestions">
            {RULE_TYPE_SUGGESTIONS.map((t) => <option key={t} value={t} />)}
          </datalist>
        </label>
        <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12, color: 'var(--text-secondary)' }}>
          Severity
          <select
            value={filterSeverity}
            onChange={(e) => setFilterSeverity(e.target.value)}
            aria-label="Filter by severity"
            style={selectStyle}
          >
            <option value="">All severities</option>
            {SEVERITIES.map((s) => (
              <option key={s} value={s}>{s}</option>
            ))}
          </select>
        </label>
        <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12, color: 'var(--text-secondary)' }}>
          Active
          <select
            value={filterIsActive}
            onChange={(e) => setFilterIsActive(e.target.value)}
            aria-label="Filter by active state"
            style={selectStyle}
          >
            <option value="all">All</option>
            <option value="true">Active only</option>
            <option value="false">Inactive only</option>
          </select>
        </label>
      </div>

      {loadError && (
        <div role="alert" style={errorBanner}>
          <AlertTriangle size={16} /> {loadError}
          <button onClick={load} type="button" style={{ ...refreshBtn, marginLeft: 'auto' }}>
            Retry
          </button>
        </div>
      )}

      <div
        style={{
          background: 'var(--surface-color)',
          borderRadius: 8,
          border: '1px solid var(--border-color)',
          overflow: 'hidden',
        }}
      >
        {loading ? (
          <div style={empty}>Loading&hellip;</div>
        ) : rules.length === 0 ? (
          <div style={empty}>
            No embassy rules match the current filters. Add a rule with
            &ldquo;New Rule&rdquo; or clear the filters to widen the search.
          </div>
        ) : (
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr>
                <th style={th}>Country</th>
                <th style={th}>Rule type</th>
                <th style={th}>Application type</th>
                <th style={th}>Advisor warning</th>
                <th style={th}>Severity</th>
                <th style={th}>Active</th>
                {isAdmin && <th style={th}>Actions</th>}
              </tr>
            </thead>
            <tbody>
              {rules.map((r) => (
                <tr key={r.id} style={{ borderTop: '1px solid var(--border-light)' }} data-testid={`embassy-rule-row-${r.id}`}>
                  <td style={td}><strong>{r.destinationCountry}</strong></td>
                  <td style={td}>{r.ruleType}</td>
                  <td style={td}>{r.applicationType || <span style={{ color: 'var(--text-secondary)' }}>all</span>}</td>
                  <td style={td}>{r.actionLabel}</td>
                  <td style={td}><SeverityBadge severity={r.severity} /></td>
                  <td style={td}>
                    {r.isActive ? 'Yes' : <span style={{ color: 'var(--text-secondary)' }}>No</span>}
                  </td>
                  {isAdmin && (
                    <td style={td}>
                      <div style={{ display: 'flex', gap: 6 }}>
                        <button
                          type="button"
                          onClick={() => openEdit(r)}
                          style={iconActionBtn}
                          aria-label={`Edit rule ${r.id}`}
                          data-testid={`embassy-rule-edit-${r.id}`}
                        >
                          <Edit2 size={14} /> Edit
                        </button>
                        <button
                          type="button"
                          onClick={() => handleDelete(r)}
                          style={{ ...iconActionBtn, color: '#A8323F', borderColor: 'rgba(168,50,63,0.4)' }}
                          aria-label={`Delete rule ${r.id}`}
                          data-testid={`embassy-rule-delete-${r.id}`}
                        >
                          <Trash2 size={14} /> Delete
                        </button>
                      </div>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {modalOpen && (
        <div
          onClick={(e) => { if (e.target === e.currentTarget) closeModal(); }}
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
            onSubmit={submit}
            className="card"
            style={drawerStyle}
            aria-labelledby="embassy-rule-modal-title"
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
              <h2 id="embassy-rule-modal-title" style={{ margin: 0, fontSize: 18, fontWeight: 600 }}>
                {editingId ? 'Edit Embassy Rule' : 'New Embassy Rule'}
              </h2>
              <button type="button" onClick={closeModal} aria-label="Close" style={iconBtn}>
                <X size={16} />
              </button>
            </div>

            {formError && !formError.field && (
              <div role="alert" style={errorBanner}>
                {formError.message}
                {formError.code && (
                  <span style={{ marginLeft: 6, opacity: 0.7, fontSize: 11 }}>[{formError.code}]</span>
                )}
              </div>
            )}

            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              <label style={fieldLabel}>
                Destination country (ISO-2)
                <input
                  type="text"
                  value={form.destinationCountry}
                  onChange={(e) => setForm({ ...form, destinationCountry: e.target.value.toUpperCase() })}
                  placeholder="e.g. US"
                  maxLength={2}
                  aria-invalid={formError?.field === 'destinationCountry' ? 'true' : undefined}
                  required
                  style={{ ...inputStyle, textTransform: 'uppercase' }}
                  data-testid="embassy-rule-form-country"
                />
                {formError?.field === 'destinationCountry' && (
                  <span style={fieldErrorText} role="alert">{formError.message}</span>
                )}
              </label>

              <label style={fieldLabel}>
                Rule type
                <input
                  type="text"
                  value={form.ruleType}
                  onChange={(e) => setForm({ ...form, ruleType: e.target.value })}
                  list="embassy-rule-form-type-suggestions"
                  placeholder="e.g. document_required"
                  aria-invalid={formError?.field === 'ruleType' ? 'true' : undefined}
                  required
                  style={inputStyle}
                  data-testid="embassy-rule-form-rule-type"
                />
                <datalist id="embassy-rule-form-type-suggestions">
                  {RULE_TYPE_SUGGESTIONS.map((t) => <option key={t} value={t} />)}
                </datalist>
                {formError?.field === 'ruleType' && (
                  <span style={fieldErrorText} role="alert">{formError.message}</span>
                )}
              </label>

              <label style={fieldLabel}>
                Application type
                <select
                  value={form.applicationType}
                  onChange={(e) => setForm({ ...form, applicationType: e.target.value })}
                  style={inputStyle}
                  data-testid="embassy-rule-form-app-type"
                >
                  {APPLICATION_TYPES.map((t) => (
                    <option key={t.value} value={t.value}>{t.label}</option>
                  ))}
                </select>
              </label>

              <label style={fieldLabel}>
                Advisor warning (action label)
                <input
                  type="text"
                  value={form.actionLabel}
                  onChange={(e) => setForm({ ...form, actionLabel: e.target.value })}
                  placeholder="e.g. Sponsor income proof required (last 6 months)"
                  aria-invalid={formError?.field === 'actionLabel' ? 'true' : undefined}
                  required
                  style={inputStyle}
                  data-testid="embassy-rule-form-action-label"
                />
                {formError?.field === 'actionLabel' && (
                  <span style={fieldErrorText} role="alert">{formError.message}</span>
                )}
              </label>

              <label style={fieldLabel}>
                Severity
                <select
                  value={form.severity}
                  onChange={(e) => setForm({ ...form, severity: e.target.value })}
                  aria-invalid={formError?.field === 'severity' ? 'true' : undefined}
                  required
                  style={inputStyle}
                  data-testid="embassy-rule-form-severity"
                >
                  {SEVERITIES.map((s) => (
                    <option key={s} value={s}>{s}</option>
                  ))}
                </select>
                {formError?.field === 'severity' && (
                  <span style={fieldErrorText} role="alert">{formError.message}</span>
                )}
              </label>

              <label style={fieldLabel}>
                Condition JSON (optional)
                <textarea
                  value={form.conditionJson}
                  onChange={(e) => setForm({ ...form, conditionJson: e.target.value })}
                  placeholder='e.g. {"requiresCooldownDays": 30, "appliesIf": {"prevRejected": true}}'
                  rows={5}
                  aria-invalid={formError?.field === 'conditionJson' ? 'true' : undefined}
                  style={{ ...inputStyle, fontFamily: 'monospace', fontSize: 12 }}
                  data-testid="embassy-rule-form-condition-json"
                />
                {formError?.field === 'conditionJson' && (
                  <span style={fieldErrorText} role="alert">{formError.message}</span>
                )}
                <span style={fieldHintText}>
                  Free-form JSON consumed by the risk-flag engine. Leave blank if
                  the rule applies unconditionally on country + application type.
                </span>
              </label>

              <label style={{ ...fieldLabel, flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                <input
                  type="checkbox"
                  checked={form.isActive}
                  onChange={(e) => setForm({ ...form, isActive: e.target.checked })}
                  data-testid="embassy-rule-form-active"
                />
                Active (uncheck to soft-disable without deleting)
              </label>
            </div>

            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 20 }}>
              <button type="button" onClick={closeModal} style={refreshBtn}>
                Cancel
              </button>
              <button type="submit" disabled={submitting} style={primaryBtn} data-testid="embassy-rule-form-submit">
                {submitting ? 'Saving…' : editingId ? 'Save changes' : 'Create rule'}
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
  minWidth: 140,
  fontSize: 13,
};

const inputStyle = {
  padding: '8px 10px',
  borderRadius: 6,
  border: '1px solid var(--border-color)',
  background: 'var(--input-bg, var(--surface-color))',
  color: 'var(--text-primary)',
  fontSize: 14,
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

const iconActionBtn = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 4,
  padding: '4px 8px',
  borderRadius: 4,
  border: '1px solid var(--border-color)',
  background: 'var(--surface-color)',
  color: 'var(--text-primary)',
  fontSize: 12,
  cursor: 'pointer',
};

const iconBtn = {
  background: 'transparent',
  border: 'none',
  color: 'var(--text-secondary)',
  cursor: 'pointer',
  padding: 4,
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

const fieldLabel = {
  display: 'flex',
  flexDirection: 'column',
  gap: 4,
  fontSize: 12,
  color: 'var(--text-secondary)',
  fontWeight: 500,
};

const errorBanner = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
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
