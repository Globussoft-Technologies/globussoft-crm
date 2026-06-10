// Travel CRM — TMC Trip Catalogue admin page.
//
// PRD_TMC_DIAGNOSTIC_SALES_ROUTING_ENGINE.md §10 row T16. Flagged by T11
// agent: until this slice the Promote-to-active surface lived as a tiny
// sub-panel inside DiagnosticBuilder's EngineWeights tab. This dedicated
// page at `/travel/tmc/catalogue` is the proper admin home — full list
// view split into Active / Archived tabs, create + edit modal, prominent
// Promote-to-active button on archived rows (ADMIN-only per PRD §3.2
// human-verify gate), and delete (soft-archive) action.
//
// Backend contract — backend/routes/travel_tmc_catalogue.js (T5 shipped
// 759b734a). 18 fields from TmcTripCatalogue per PRD §3.2:
//
//   GET    /api/travel-tmc-catalogue?status=active|archived|all
//          → 200 { catalogue: [...], total, limit, offset }
//   POST   /api/travel-tmc-catalogue
//          body fields per §3.2; status is ALWAYS forced to "archived"
//          server-side regardless of body (human-verify gate)
//          → 201 created row
//   PATCH  /api/travel-tmc-catalogue/:id
//          → 200 updated row; status mutation rejected (STATUS_NOT_PATCHABLE)
//   DELETE /api/travel-tmc-catalogue/:id
//          → 200 soft-deleted row (status flipped to "archived")
//   POST   /api/travel-tmc-catalogue/:id/promote-to-active
//          → 200 row with status="active"; ADMIN-only
//
// Auth model: any travel-vertical authenticated user reaches the page
// (wrapped by <TravelOnly>). Backend gates CRUD to ADMIN+MANAGER and
// promote-to-active to ADMIN-only — the page mirrors via canWrite /
// isAdmin gates so non-write users see read-only chrome (no Create /
// Edit / Delete / Promote buttons) but still browse the catalogue.

import React, { useCallback, useContext, useEffect, useState } from 'react';
import { Edit2, Plus, RotateCw, ShieldCheck, Trash2, X } from 'lucide-react';
import { fetchApi } from '../../utils/api';
import { useNotify } from '../../utils/notify';
import { AuthContext } from '../../App';

// Server-side enum values per backend/routes/travel_tmc_catalogue.js
// (STATUS_ACTIVE / STATUS_ARCHIVED constants — also exported on the
// router for tests).
const STATUS_ACTIVE = 'active';
const STATUS_ARCHIVED = 'archived';

// Sub-set of TmcTripCatalogue fields surfaced in the create/edit form.
// JSON array fields are surfaced as comma-separated strings for ease of
// authoring; we JSON.stringify them before POSTing per backend's
// normaliseJsonField acceptance contract.
const EMPTY_FORM = {
  tripId: '',
  title: '',
  tagline: '',
  tier: '',
  region: '',
  durationDays: '',
  durationNights: '',
  minGradeBand: '',
  maxGradeBand: '',
  boardsSupportedJson: '', // comma-separated -> ["CBSE","IGCSE",...]
  minGroupSize: '',
  priceBand: '',
  indicativePricePerStudent: '',
  primaryOutcomesJson: '',
  skillsDevelopedJson: '',
  subjectsTouchedJson: '',
  anchorExperiencesJson: '',
  curriculumHooksJson: '',
  reportSkillBlurb: '',
  summaryForBrief: '',
  imageUrl: '',
};

// Convert a comma-separated authoring string into a JSON array. Empty
// string → empty array. Caller may also paste raw JSON already; we try
// JSON.parse first and fall back to comma-split.
function parseListField(raw) {
  if (raw == null) return [];
  const trimmed = String(raw).trim();
  if (!trimmed) return [];
  if (trimmed.startsWith('[')) {
    try {
      const parsed = JSON.parse(trimmed);
      return Array.isArray(parsed) ? parsed : [trimmed];
    } catch {
      // fall through to comma split
    }
  }
  return trimmed
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

// Convert stored JSON-string column back into the comma-separated string
// authoring shape on edit-load.
function stringifyListField(raw) {
  if (raw == null) return '';
  if (Array.isArray(raw)) return raw.join(', ');
  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (!trimmed) return '';
    if (trimmed.startsWith('[')) {
      try {
        const parsed = JSON.parse(trimmed);
        if (Array.isArray(parsed)) return parsed.join(', ');
      } catch {
        return trimmed;
      }
    }
    return trimmed;
  }
  return '';
}

export default function TmcCatalogueAdmin() {
  const notify = useNotify();
  const { user } = useContext(AuthContext) || {};
  const role = user?.role || 'USER';
  const isAdmin = role === 'ADMIN';
  const canWrite = isAdmin || role === 'MANAGER';

  const [tab, setTab] = useState(STATUS_ACTIVE); // active | archived
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(null);

  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState(null);
  const [form, setForm] = useState(EMPTY_FORM);
  const [saving, setSaving] = useState(false);
  const [promotingId, setPromotingId] = useState(null);
  const [deletingId, setDeletingId] = useState(null);

  const load = useCallback(() => {
    setLoading(true);
    setLoadError(null);
    fetchApi(`/api/travel-tmc-catalogue?status=${tab}`)
      .then((res) => {
        // Tolerate both shaped + bare list shapes (sibling pages do the
        // same for resilience against future shape evolution).
        const items = Array.isArray(res)
          ? res
          : Array.isArray(res?.catalogue)
            ? res.catalogue
            : Array.isArray(res?.items)
              ? res.items
              : [];
        setRows(items);
      })
      .catch((e) => {
        const msg = e?.body?.error || e?.message || 'Failed to load catalogue';
        setLoadError(msg);
        notify.error(msg);
        setRows([]);
      })
      .finally(() => setLoading(false));
  }, [tab, notify]);

  useEffect(() => {
    load();
  }, [load]);

  const resetForm = () => {
    setForm(EMPTY_FORM);
    setEditingId(null);
    setShowForm(false);
  };

  const handleAdd = () => {
    if (!canWrite) {
      notify.error('Create requires ADMIN or MANAGER role.');
      return;
    }
    setForm(EMPTY_FORM);
    setEditingId(null);
    setShowForm(true);
  };

  const handleEdit = (row) => {
    if (!canWrite) {
      notify.error('Edit requires ADMIN or MANAGER role.');
      return;
    }
    setForm({
      tripId: row.tripId || '',
      title: row.title || '',
      tagline: row.tagline || '',
      tier: row.tier || '',
      region: row.region || '',
      durationDays: row.durationDays != null ? String(row.durationDays) : '',
      durationNights: row.durationNights != null ? String(row.durationNights) : '',
      minGradeBand: row.minGradeBand || '',
      maxGradeBand: row.maxGradeBand || '',
      boardsSupportedJson: stringifyListField(row.boardsSupportedJson),
      minGroupSize: row.minGroupSize != null ? String(row.minGroupSize) : '',
      priceBand: row.priceBand || '',
      indicativePricePerStudent:
        row.indicativePricePerStudent != null ? String(row.indicativePricePerStudent) : '',
      primaryOutcomesJson: stringifyListField(row.primaryOutcomesJson),
      skillsDevelopedJson: stringifyListField(row.skillsDevelopedJson),
      subjectsTouchedJson: stringifyListField(row.subjectsTouchedJson),
      anchorExperiencesJson: stringifyListField(row.anchorExperiencesJson),
      curriculumHooksJson: stringifyListField(row.curriculumHooksJson),
      reportSkillBlurb: row.reportSkillBlurb || '',
      summaryForBrief: row.summaryForBrief || '',
      imageUrl: row.imageUrl || '',
    });
    setEditingId(row.id);
    setShowForm(true);
  };

  const handleSubmit = async (e) => {
    if (e?.preventDefault) e.preventDefault();

    // Required fields per backend MISSING_FIELDS guard.
    const required = ['tripId', 'title', 'tier', 'minGradeBand', 'maxGradeBand', 'priceBand', 'reportSkillBlurb', 'summaryForBrief'];
    for (const f of required) {
      if (!String(form[f] || '').trim()) {
        notify.error(`${f} is required`);
        return;
      }
    }
    if (!String(form.durationDays).trim()) {
      notify.error('durationDays is required');
      return;
    }
    if (!String(form.minGroupSize).trim()) {
      notify.error('minGroupSize is required');
      return;
    }

    const payload = {
      tripId: form.tripId.trim(),
      title: form.title.trim(),
      tagline: form.tagline.trim() || null,
      tier: form.tier.trim(),
      region: form.region.trim() || null,
      durationDays: Number(form.durationDays),
      durationNights: form.durationNights ? Number(form.durationNights) : 0,
      minGradeBand: form.minGradeBand.trim(),
      maxGradeBand: form.maxGradeBand.trim(),
      boardsSupportedJson: parseListField(form.boardsSupportedJson),
      minGroupSize: Number(form.minGroupSize),
      priceBand: form.priceBand.trim(),
      indicativePricePerStudent: form.indicativePricePerStudent
        ? Number(form.indicativePricePerStudent)
        : null,
      primaryOutcomesJson: parseListField(form.primaryOutcomesJson),
      skillsDevelopedJson: parseListField(form.skillsDevelopedJson),
      subjectsTouchedJson: parseListField(form.subjectsTouchedJson),
      anchorExperiencesJson: parseListField(form.anchorExperiencesJson),
      curriculumHooksJson: parseListField(form.curriculumHooksJson),
      reportSkillBlurb: form.reportSkillBlurb.trim(),
      summaryForBrief: form.summaryForBrief.trim(),
      imageUrl: form.imageUrl.trim() || null,
    };

    setSaving(true);
    try {
      if (editingId) {
        await fetchApi(`/api/travel-tmc-catalogue/${editingId}`, {
          method: 'PATCH',
          body: JSON.stringify(payload),
        });
        notify.success('Catalogue entry updated');
      } else {
        await fetchApi('/api/travel-tmc-catalogue', {
          method: 'POST',
          body: JSON.stringify(payload),
        });
        // Human-verify gate surface: every POST lands archived, regardless
        // of body. Surface that to the user so they understand WHY their
        // newly-created row is in the Archived tab.
        notify.info('Created. Per the human-verify gate, the entry lands in Archived. Use Promote to active when reviewed.');
      }
      resetForm();
      // If we just created, the row is in Archived; switch tabs so the
      // user sees their work (load() re-fires via tab dep).
      if (!editingId && tab !== STATUS_ARCHIVED) {
        setTab(STATUS_ARCHIVED);
      } else {
        load();
      }
    } catch (err) {
      notify.error(err?.body?.error || err?.message || 'Failed to save catalogue entry');
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (row) => {
    if (!canWrite) {
      notify.error('Delete requires ADMIN or MANAGER role.');
      return;
    }
    const ok = await notify.confirm(
      `Archive "${row.title || row.tripId}"? It will be soft-deleted (status=archived) but remains queryable for audit.`,
    );
    if (!ok) return;
    setDeletingId(row.id);
    try {
      await fetchApi(`/api/travel-tmc-catalogue/${row.id}`, { method: 'DELETE' });
      notify.success('Catalogue entry archived');
      load();
    } catch (err) {
      notify.error(err?.body?.error || err?.message || 'Failed to archive entry');
    } finally {
      setDeletingId(null);
    }
  };

  const handlePromote = async (row) => {
    if (!isAdmin) {
      notify.error('Promote-to-active is ADMIN-only.');
      return;
    }
    setPromotingId(row.id);
    try {
      await fetchApi(`/api/travel-tmc-catalogue/${row.id}/promote-to-active`, {
        method: 'POST',
        body: JSON.stringify({}),
      });
      notify.success(`Promoted "${row.title || row.tripId}" to active.`);
      // Drop the promoted row from this tab's view; the user can flip to
      // Active to see it in its new home.
      setRows((prev) => prev.filter((r) => r.id !== row.id));
    } catch (err) {
      notify.error(err?.body?.error || err?.message || 'Failed to promote entry');
    } finally {
      setPromotingId(null);
    }
  };

  // ── Render ───────────────────────────────────────────────────────────

  return (
    <div style={{ padding: 24, maxWidth: 1200, margin: '0 auto' }}>
      {/* Heading + Add CTA */}
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'flex-start',
          flexWrap: 'wrap',
          gap: 12,
          marginBottom: 12,
        }}
      >
        <div>
          <h1 style={{ display: 'flex', alignItems: 'center', gap: 10, margin: 0, fontSize: 22 }}>
            <ShieldCheck size={26} aria-hidden /> TMC Trip Catalogue
          </h1>
          <p style={{ color: 'var(--text-secondary)', marginTop: 4, marginBottom: 0, maxWidth: 720 }}>
            Manage the TMC diagnostic engine's recommendation set. New rows land in <strong>Archived</strong>
            {' '}per the human-verify gate; an ADMIN <em>Promote to active</em> flips a reviewed row into
            {' '}the engine's matching pool.
          </p>
        </div>
        {canWrite && !showForm && (
          <button type="button" onClick={handleAdd} style={primaryBtn} aria-label="Add catalogue entry">
            <Plus size={14} /> Add catalogue entry
          </button>
        )}
      </div>

      {/* Tabs */}
      <div role="tablist" aria-label="Catalogue status tabs" style={tabRow}>
        <button
          type="button"
          role="tab"
          aria-selected={tab === STATUS_ACTIVE}
          onClick={() => setTab(STATUS_ACTIVE)}
          style={tab === STATUS_ACTIVE ? tabActive : tabIdle}
        >
          Active
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === STATUS_ARCHIVED}
          onClick={() => setTab(STATUS_ARCHIVED)}
          style={tab === STATUS_ARCHIVED ? tabActive : tabIdle}
        >
          Archived
        </button>
        <button
          type="button"
          onClick={load}
          style={{ ...secondaryBtn, marginLeft: 'auto' }}
          aria-label="Refresh list"
        >
          <RotateCw size={14} /> Refresh
        </button>
      </div>

      {/* Create / edit form */}
      {showForm && (
        <form
          onSubmit={handleSubmit}
          style={{
            background: 'var(--surface-color)',
            padding: 16,
            borderRadius: 8,
            border: '1px solid var(--border-color)',
            marginBottom: 16,
          }}
        >
          <div
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              marginBottom: 12,
            }}
          >
            <h2 style={{ margin: 0, fontSize: 18 }}>
              {editingId ? 'Edit catalogue entry' : 'Add catalogue entry'}
            </h2>
            <button type="button" onClick={resetForm} style={iconBtn} aria-label="Close form">
              <X size={18} />
            </button>
          </div>

          <div
            style={{
              display: 'grid',
              gap: 12,
              gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 240px), 1fr))',
            }}
          >
            <Field label="tripId *">
              <input
                value={form.tripId}
                onChange={(e) => setForm({ ...form, tripId: e.target.value })}
                placeholder="e.g. golden-triangle"
                aria-label="tripId"
                style={inputStyle}
              />
            </Field>
            <Field label="Title *">
              <input
                value={form.title}
                onChange={(e) => setForm({ ...form, title: e.target.value })}
                placeholder="Golden Triangle Heritage Trail"
                aria-label="title"
                style={inputStyle}
              />
            </Field>
            <Field label="Tagline">
              <input
                value={form.tagline}
                onChange={(e) => setForm({ ...form, tagline: e.target.value })}
                placeholder="Optional one-liner"
                aria-label="tagline"
                style={inputStyle}
              />
            </Field>
            <Field label="Tier *">
              <input
                value={form.tier}
                onChange={(e) => setForm({ ...form, tier: e.target.value })}
                placeholder="domestic | international | premium"
                aria-label="tier"
                style={inputStyle}
              />
            </Field>
            <Field label="Region">
              <input
                value={form.region}
                onChange={(e) => setForm({ ...form, region: e.target.value })}
                placeholder="e.g. North India"
                aria-label="region"
                style={inputStyle}
              />
            </Field>
            <Field label="durationDays *">
              <input
                type="number"
                min={0}
                value={form.durationDays}
                onChange={(e) => setForm({ ...form, durationDays: e.target.value })}
                placeholder="6"
                aria-label="durationDays"
                style={inputStyle}
              />
            </Field>
            <Field label="durationNights">
              <input
                type="number"
                min={0}
                value={form.durationNights}
                onChange={(e) => setForm({ ...form, durationNights: e.target.value })}
                placeholder="5"
                aria-label="durationNights"
                style={inputStyle}
              />
            </Field>
            <Field label="minGradeBand *">
              <input
                value={form.minGradeBand}
                onChange={(e) => setForm({ ...form, minGradeBand: e.target.value })}
                placeholder="grade-6"
                aria-label="minGradeBand"
                style={inputStyle}
              />
            </Field>
            <Field label="maxGradeBand *">
              <input
                value={form.maxGradeBand}
                onChange={(e) => setForm({ ...form, maxGradeBand: e.target.value })}
                placeholder="grade-10"
                aria-label="maxGradeBand"
                style={inputStyle}
              />
            </Field>
            <Field label="boardsSupported (comma-separated)">
              <input
                value={form.boardsSupportedJson}
                onChange={(e) => setForm({ ...form, boardsSupportedJson: e.target.value })}
                placeholder="CBSE, ICSE, IGCSE, IB"
                aria-label="boardsSupportedJson"
                style={inputStyle}
              />
            </Field>
            <Field label="minGroupSize *">
              <input
                type="number"
                min={1}
                value={form.minGroupSize}
                onChange={(e) => setForm({ ...form, minGroupSize: e.target.value })}
                placeholder="20"
                aria-label="minGroupSize"
                style={inputStyle}
              />
            </Field>
            <Field label="priceBand *">
              <input
                value={form.priceBand}
                onChange={(e) => setForm({ ...form, priceBand: e.target.value })}
                placeholder="low | mid | high"
                aria-label="priceBand"
                style={inputStyle}
              />
            </Field>
            <Field label="indicativePricePerStudent">
              <input
                type="number"
                min={0}
                value={form.indicativePricePerStudent}
                onChange={(e) =>
                  setForm({ ...form, indicativePricePerStudent: e.target.value })
                }
                placeholder="35000"
                aria-label="indicativePricePerStudent"
                style={inputStyle}
              />
            </Field>
            <Field label="imageUrl">
              <input
                value={form.imageUrl}
                onChange={(e) => setForm({ ...form, imageUrl: e.target.value })}
                placeholder="https://…"
                aria-label="imageUrl"
                style={inputStyle}
              />
            </Field>
          </div>

          <div
            style={{
              display: 'grid',
              gap: 12,
              gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 240px), 1fr))',
              marginTop: 12,
            }}
          >
            <Field label="primaryOutcomes (comma-separated)">
              <textarea
                rows={2}
                value={form.primaryOutcomesJson}
                onChange={(e) => setForm({ ...form, primaryOutcomesJson: e.target.value })}
                placeholder="global_awareness, leadership"
                aria-label="primaryOutcomesJson"
                style={{ ...inputStyle, resize: 'vertical' }}
              />
            </Field>
            <Field label="skillsDeveloped (comma-separated)">
              <textarea
                rows={2}
                value={form.skillsDevelopedJson}
                onChange={(e) => setForm({ ...form, skillsDevelopedJson: e.target.value })}
                placeholder="communication, problem-solving"
                aria-label="skillsDevelopedJson"
                style={{ ...inputStyle, resize: 'vertical' }}
              />
            </Field>
            <Field label="subjectsTouched (comma-separated)">
              <textarea
                rows={2}
                value={form.subjectsTouchedJson}
                onChange={(e) => setForm({ ...form, subjectsTouchedJson: e.target.value })}
                placeholder="History, Civics"
                aria-label="subjectsTouchedJson"
                style={{ ...inputStyle, resize: 'vertical' }}
              />
            </Field>
            <Field label="anchorExperiences (JSON or comma-separated)">
              <textarea
                rows={2}
                value={form.anchorExperiencesJson}
                onChange={(e) => setForm({ ...form, anchorExperiencesJson: e.target.value })}
                placeholder='[{"name":"Taj Mahal sunrise"}]'
                aria-label="anchorExperiencesJson"
                style={{ ...inputStyle, resize: 'vertical' }}
              />
            </Field>
            <Field label="curriculumHooks (JSON or comma-separated)">
              <textarea
                rows={2}
                value={form.curriculumHooksJson}
                onChange={(e) => setForm({ ...form, curriculumHooksJson: e.target.value })}
                placeholder='[{"board":"CBSE","topic":"Mughal Empire"}]'
                aria-label="curriculumHooksJson"
                style={{ ...inputStyle, resize: 'vertical' }}
              />
            </Field>
          </div>

          <div style={{ marginTop: 12 }}>
            <Field label="reportSkillBlurb *">
              <textarea
                rows={2}
                value={form.reportSkillBlurb}
                onChange={(e) => setForm({ ...form, reportSkillBlurb: e.target.value })}
                placeholder="Short blurb shown in the readiness report's skill panel."
                aria-label="reportSkillBlurb"
                style={{ ...inputStyle, resize: 'vertical' }}
              />
            </Field>
          </div>
          <div style={{ marginTop: 12 }}>
            <Field label="summaryForBrief *">
              <textarea
                rows={2}
                value={form.summaryForBrief}
                onChange={(e) => setForm({ ...form, summaryForBrief: e.target.value })}
                placeholder="One-paragraph summary shown to the sales executive."
                aria-label="summaryForBrief"
                style={{ ...inputStyle, resize: 'vertical' }}
              />
            </Field>
          </div>

          {!editingId && (
            <p style={{ marginTop: 12, color: 'var(--text-secondary)', fontSize: 12 }}>
              Per PRD §3.2, every catalogue row lands in <strong>Archived</strong>. An ADMIN
              must Promote-to-active before the engine matches against it.
            </p>
          )}

          <div style={{ marginTop: 12, display: 'flex', gap: 8 }}>
            <button type="submit" style={saving ? primaryBtnDisabled : primaryBtn} disabled={saving}>
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
        <div role="alert" style={{ ...emptyStyle, color: 'var(--danger-color)' }}>
          {loadError}
        </div>
      ) : rows.length === 0 ? (
        <div style={emptyStyle}>
          {tab === STATUS_ACTIVE
            ? 'No active catalogue entries. Newly-created rows land in Archived — promote them to active here.'
            : 'No archived catalogue entries. New entries appear here for review before promotion.'}
        </div>
      ) : (
        <div
          role="list"
          aria-label={`${tab} catalogue entries`}
          style={{
            display: 'grid',
            gap: 12,
            gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 240px), 1fr))',
          }}
        >
          {rows.map((row) => (
            <div
              key={row.id}
              role="listitem"
              style={{
                background: 'var(--surface-color)',
                border: '1px solid var(--border-color)',
                borderRadius: 8,
                padding: 14,
                display: 'flex',
                flexDirection: 'column',
                gap: 8,
              }}
            >
              <div>
                <div style={{ fontWeight: 600, fontSize: 15 }}>{row.title || row.tripId}</div>
                <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: 2 }}>
                  <code>{row.tripId}</code> · {row.tier || 'tier?'}
                  {row.region ? ` · ${row.region}` : ''}
                </div>
              </div>
              <div style={{ fontSize: 13, color: 'var(--text-primary)' }}>
                Grades <strong>{row.minGradeBand}</strong>–<strong>{row.maxGradeBand}</strong>
                {row.minGroupSize != null && (
                  <> · min group <strong>{row.minGroupSize}</strong></>
                )}
              </div>
              {row.indicativePricePerStudent != null && (
                <div style={{ fontSize: 13, color: 'var(--text-secondary)' }}>
                  ~₹{Number(row.indicativePricePerStudent).toLocaleString()}/student
                </div>
              )}
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 'auto' }}>
                {tab === STATUS_ARCHIVED && isAdmin && (
                  <button
                    type="button"
                    onClick={() => handlePromote(row)}
                    disabled={promotingId === row.id}
                    style={promotingId === row.id ? primaryBtnDisabled : primaryBtn}
                    aria-label={`Promote ${row.title || row.tripId} to active`}
                  >
                    {promotingId === row.id ? 'Promoting…' : 'Promote to active'}
                  </button>
                )}
                {tab === STATUS_ARCHIVED && !isAdmin && (
                  <span style={{ color: 'var(--text-secondary)', fontSize: 12, padding: '6px 0' }}>
                    Promote-to-active is ADMIN-only.
                  </span>
                )}
                {canWrite && (
                  <button
                    type="button"
                    onClick={() => handleEdit(row)}
                    style={iconBtn}
                    aria-label={`Edit ${row.title || row.tripId}`}
                  >
                    <Edit2 size={16} />
                  </button>
                )}
                {canWrite && tab === STATUS_ACTIVE && (
                  <button
                    type="button"
                    onClick={() => handleDelete(row)}
                    disabled={deletingId === row.id}
                    style={iconBtn}
                    aria-label={`Archive ${row.title || row.tripId}`}
                  >
                    <Trash2 size={16} />
                  </button>
                )}
              </div>
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
      <span style={{ color: 'var(--text-secondary)', fontWeight: 500 }}>{label}</span>
      {children}
    </label>
  );
}

// ── Shared styles ──────────────────────────────────────────────────────

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
const tabRow = {
  display: 'flex',
  gap: 0,
  alignItems: 'center',
  marginBottom: 12,
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
const emptyStyle = {
  padding: 32,
  textAlign: 'center',
  color: 'var(--text-secondary)',
  fontSize: 14,
  background: 'var(--surface-color)',
  border: '1px solid var(--border-color)',
  borderRadius: 8,
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
