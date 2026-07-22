// Travel CRM — Cancellation Policies admin page.
//
// S54 slice (docs/TRAVEL_BIG_SCOPE_BACKLOG.md) — PRD_TRAVEL_BILLING
// FR-3.7.a. Operator-facing list of CancellationPolicy rows that drive
// the auto-issuance of CR-NOTE rows when a travel invoice is voided.
// CRUD wires to the /api/travel/cancellation-policies endpoints
// (commit S33):
//   GET    /api/travel/cancellation-policies                  list
//                                                              filters: subBrand / active
//                                                              shape: { policies, total, limit, offset }
//   POST   /api/travel/cancellation-policies                  create (ADMIN+MANAGER)
//   PATCH  /api/travel/cancellation-policies/:id              edit   (ADMIN+MANAGER)
//   DELETE /api/travel/cancellation-policies/:id              204 No Content (ADMIN only)
//
// Pattern source: cloned from frontend/src/pages/travel/QuoteTemplates.jsx
// (commit 8fb23237) — the canonical S31 admin-page pattern. Differences:
//   - No category field (CancellationPolicy has none).
//   - JSON-tier editor: structured tier-row inputs PLUS a free-form
//     fallback textarea. Each row is { daysBeforeServiceStart, refundPercent }.
//   - Tier preview rendered live, parsed from the current tiers array as
//     descending bands: "at 60+d → 100% refund; at 30-59d → 50%;
//     at 7-29d → 25%; at <7d → 0%".
//   - DELETE is ADMIN-only (backend posture — policies are legal-contract
//     terms; destructive change needs the strongest gate). MANAGERs see
//     Edit but not Delete.
//
// Backend validation (mirrors backend/routes/travel_cancellation_policies.js):
//   - name (required, non-empty)
//   - tiersJson (required, JSON array of tier shapes — each tier needs
//     non-negative integer `daysBeforeServiceStart` + numeric
//     `refundPercent` in [0..100])
//   - subBrand — optional, scoped to user's accessible sub-brands
//   - DELETE returns 204 No Content (not a row body).
//
// The tier preview helper `renderTierPreview()` parses the tiers list
// into descending-band semantics:
//   tiers = [{60d→100%}, {30d→50%}, {7d→25%}, {0d→0%}] →
//   "at 60+d → 100% refund; at 30-59d → 50% refund;
//    at 7-29d → 25% refund; at <7d → 0% refund"
// The "last" tier (lowest days threshold) is rendered as "<Nd" when N > 0
// and "<Nd" → "at <0d" when N === 0 (i.e. no refund for any cancellation
// inside the threshold). This mirrors the backend resolver's top-down
// "first tier whose threshold is <= actual days-before-start" walk.

import { useEffect, useMemo, useState, useContext } from "react";
import { ShieldOff, Plus, Pencil, Trash2, X } from "lucide-react";
import { fetchApi } from "../../utils/api";
import { useNotify } from "../../utils/notify";
import TopScrollSync from "../../components/TopScrollSync";
import {
  SUB_BRAND_BG,
  accessibleSubBrands,
  defaultSubBrandFor,
  subBrandShortLabel,
} from "../../utils/travelSubBrand";
import { useActiveSubBrand } from "../../utils/subBrand";
import { AuthContext } from "../../App";

const SUB_BRANDS = [
  { value: "", label: "All sub-brands" },
  { value: "_tenant", label: "Tenant-wide (no sub-brand)" },
  { value: "tmc", label: "TMC (schools)" },
  { value: "rfu", label: "RFU (Umrah)" },
  { value: "travelstall", label: "Travel Stall" },
  { value: "visasure", label: "Visa Sure" },
];

const ACTIVE_FILTER = [
  { value: "", label: "All (active + inactive)" },
  { value: "true", label: "Active only" },
  { value: "false", label: "Inactive only" },
];

// Default tier ladder for a new policy — matches the TMC Default seed in
// prisma/seed-travel.js so operators creating a new policy see a sensible
// starting point.
const DEFAULT_TIERS = [
  { daysBeforeServiceStart: 60, refundPercent: 100 },
  { daysBeforeServiceStart: 30, refundPercent: 50 },
  { daysBeforeServiceStart: 7, refundPercent: 25 },
  { daysBeforeServiceStart: 0, refundPercent: 0 },
];

const EMPTY_FORM = {
  name: "",
  description: "",
  subBrand: "tmc",
  tiers: DEFAULT_TIERS,
  isActive: true,
};

function formatDate(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toISOString().slice(0, 10);
}

// Parse a tiersJson string into a tiers array. Returns the array on
// success or null on any error. Used in the list cell tier-count column
// + the row preview.
function parseTiers(tiersJson) {
  if (!tiersJson) return null;
  try {
    const arr = JSON.parse(tiersJson);
    if (!Array.isArray(arr)) return null;
    return arr;
  } catch (_e) {
    return null;
  }
}

// Validate a tiers array for the local check before POST/PATCH. Returns
// { ok: true, normalized } on success or { ok: false, error: "<msg>" }
// on failure. The backend re-validates and canonical-sorts; this local
// check yields a faster + clearer error for operators.
export function validateTiers(tiers) {
  if (!Array.isArray(tiers) || tiers.length === 0) {
    return { ok: false, error: "Tiers must be a non-empty array" };
  }
  const normalized = [];
  for (const t of tiers) {
    if (!t || typeof t !== "object") {
      return { ok: false, error: "Each tier must be an object" };
    }
    const d = Number(t.daysBeforeServiceStart);
    const p = Number(t.refundPercent);
    if (!Number.isInteger(d) || d < 0) {
      return {
        ok: false,
        error: "daysBeforeServiceStart must be a non-negative integer",
      };
    }
    if (!Number.isFinite(p) || p < 0 || p > 100) {
      return {
        ok: false,
        error: "refundPercent must be a number in [0..100]",
      };
    }
    normalized.push({ daysBeforeServiceStart: d, refundPercent: p });
  }
  // Canonical sort: largest daysBeforeServiceStart first. The cancel-time
  // resolver walks this list top-down and picks the first tier whose
  // threshold is <= actual days-before-start.
  normalized.sort((a, b) => b.daysBeforeServiceStart - a.daysBeforeServiceStart);
  return { ok: true, normalized };
}

// Render the tier ladder into a human-friendly band-string. The tiers
// array is assumed already DESC-sorted by daysBeforeServiceStart (matches
// the backend canonical-sort + validateTiers() above).
//
// Bands form pairs of adjacent tiers:
//   tiers[0] = {60d→100%} → "at 60+d → 100% refund"   (top band, +d)
//   tiers[1] = {30d→50%}  → "at 30-59d → 50% refund"  (between bands)
//   tiers[2] = {7d→25%}   → "at 7-29d → 25% refund"
//   tiers[3] = {0d→0%}    → "at <7d → 0% refund"       (bottom band, <prev)
//
// Edge cases:
//   - Single tier {Nd→P%} → "at N+d → P% refund" (no lower band).
//   - Tier with daysBeforeServiceStart=0 at the bottom renders as
//     "at <{prev}d → P% refund" if there is a previous tier; otherwise
//     "at 0+d → P% refund" (single-tier degenerate case).
export function renderTierPreview(tiers) {
  if (!Array.isArray(tiers) || tiers.length === 0) return "(no tiers)";
  // Defensive sort copy.
  const sorted = [...tiers].sort(
    (a, b) => b.daysBeforeServiceStart - a.daysBeforeServiceStart,
  );
  const bands = [];
  for (let i = 0; i < sorted.length; i++) {
    const cur = sorted[i];
    const nextHigher = i === 0 ? null : sorted[i - 1].daysBeforeServiceStart;
    const days = cur.daysBeforeServiceStart;
    const pct = cur.refundPercent;
    let label;
    if (i === 0) {
      // Top band — "Nd or more".
      label = `at ${days}+d`;
    } else if (i === sorted.length - 1) {
      // Bottom band — "less than the prior band's threshold".
      label = `at <${nextHigher}d`;
    } else {
      // Middle band — "Nd to (nextHigher - 1)d".
      label = `at ${days}-${nextHigher - 1}d`;
    }
    bands.push(`${label} → ${pct}% refund`);
  }
  return bands.join("; ");
}

export default function CancellationPolicies() {
  const notify = useNotify();
  const { user } = useContext(AuthContext) || {};
  const { activeSubBrand } = useActiveSubBrand();
  const canWrite = user?.role === "ADMIN" || user?.role === "MANAGER";
  // Per backend posture: DELETE is ADMIN-only (verifyRole(["ADMIN"])).
  const canDelete = user?.role === "ADMIN";

  // Sub-brand the create/edit form may assign. Mirrors QuoteTemplates.
  const myBrands = accessibleSubBrands(user);
  const lockedBrand = myBrands.length === 1 ? myBrands[0] : null;

  const [policies, setPolicies] = useState([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [permissionDenied, setPermissionDenied] = useState(false);

  const [subBrand, setSubBrand] = useState("");
  const [activeFilter, setActiveFilter] = useState("true");

  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState(null);
  const [form, setForm] = useState(EMPTY_FORM);
  const [saving, setSaving] = useState(false);

  const load = () => {
    setLoading(true);
    const qs = new URLSearchParams();
    if (subBrand) qs.set("subBrand", subBrand);
    if (activeFilter) qs.set("active", activeFilter);
    const url = `/api/travel/cancellation-policies${qs.toString() ? `?${qs.toString()}` : ""}`;
    fetchApi(url)
      .then((d) => {
        const rows = Array.isArray(d?.policies) ? d.policies : [];
        setPolicies(rows);
        setTotal(Number.isFinite(d?.total) ? d.total : rows.length);
        setPermissionDenied(false);
      })
      .catch((err) => {
        setPolicies([]);
        setTotal(0);
        setPermissionDenied(err?.status === 403);
      })
      .finally(() => setLoading(false));
  };

  useEffect(load, [subBrand, activeFilter]);

  const resetForm = () => {
    setForm(EMPTY_FORM);
    setEditingId(null);
  };

  const openCreate = () => {
    setEditingId(null);
    setForm({
      ...EMPTY_FORM,
      tiers: DEFAULT_TIERS.map((t) => ({ ...t })),
      subBrand: defaultSubBrandFor(user, activeSubBrand) || "tmc",
    });
    setShowForm(true);
  };

  const openEdit = (p) => {
    const parsed = parseTiers(p.tiersJson) || [];
    setForm({
      name: p.name || "",
      description: p.description || "",
      subBrand: p.subBrand || "",
      tiers: parsed.length ? parsed : DEFAULT_TIERS.map((t) => ({ ...t })),
      isActive: p.isActive !== false,
    });
    setEditingId(p.id);
    setShowForm(true);
  };

  // Tier row helpers — used by the create/edit form.
  const addTierRow = () => {
    setForm((f) => ({
      ...f,
      tiers: [...f.tiers, { daysBeforeServiceStart: 0, refundPercent: 0 }],
    }));
  };
  const removeTierRow = (idx) => {
    setForm((f) => ({
      ...f,
      tiers: f.tiers.filter((_, i) => i !== idx),
    }));
  };
  const updateTierField = (idx, field, raw) => {
    // Permit empty string while editing — coerce to 0 only on save.
    const num = raw === "" ? "" : Number(raw);
    setForm((f) => ({
      ...f,
      tiers: f.tiers.map((t, i) => (i === idx ? { ...t, [field]: num } : t)),
    }));
  };

  const previewString = useMemo(() => {
    // Coerce any "" strings to 0 for preview rendering; validation happens
    // on save.
    const coerced = form.tiers.map((t) => ({
      daysBeforeServiceStart:
        typeof t.daysBeforeServiceStart === "number"
          ? t.daysBeforeServiceStart
          : Number(t.daysBeforeServiceStart) || 0,
      refundPercent:
        typeof t.refundPercent === "number"
          ? t.refundPercent
          : Number(t.refundPercent) || 0,
    }));
    return renderTierPreview(coerced);
  }, [form.tiers]);

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!form.name.trim()) {
      notify.error("Name is required");
      return;
    }
    // Coerce any "" string fields to 0 before validation.
    const coerced = form.tiers.map((t) => ({
      daysBeforeServiceStart:
        typeof t.daysBeforeServiceStart === "number"
          ? t.daysBeforeServiceStart
          : Number(t.daysBeforeServiceStart) || 0,
      refundPercent:
        typeof t.refundPercent === "number"
          ? t.refundPercent
          : Number(t.refundPercent) || 0,
    }));
    const result = validateTiers(coerced);
    if (!result.ok) {
      notify.error(result.error);
      return;
    }
    setSaving(true);
    try {
      const payload = {
        name: form.name.trim(),
        description: form.description || null,
        subBrand: form.subBrand || null,
        tiersJson: JSON.stringify(result.normalized),
        isActive: !!form.isActive,
      };
      if (editingId) {
        await fetchApi(`/api/travel/cancellation-policies/${editingId}`, {
          method: "PATCH",
          body: JSON.stringify(payload),
        });
        notify.success(`Policy #${editingId} updated`);
      } else {
        await fetchApi("/api/travel/cancellation-policies", {
          method: "POST",
          body: JSON.stringify(payload),
        });
        notify.success(`Policy "${payload.name}" created`);
      }
      setShowForm(false);
      resetForm();
      load();
    } catch (err) {
      notify.error(err?.body?.error || err?.message || "Save failed");
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (p) => {
    if (
      !confirm(
        `Delete policy "${p.name}"? This permanently removes the policy ladder — operators relying on it will need a replacement.`,
      )
    )
      return;
    try {
      await fetchApi(`/api/travel/cancellation-policies/${p.id}`, {
        method: "DELETE",
      });
      notify.success(`Policy "${p.name}" deleted`);
      load();
    } catch (err) {
      notify.error(err?.body?.error || err?.message || "Delete failed");
    }
  };

  return (
    <div
      style={{
        padding: 24,
        maxWidth: 1200,
        margin: "0 auto",
        animation: "fadeIn 0.4s ease-out",
      }}
    >
      <header
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "flex-start",
          flexWrap: "wrap",
          gap: 12,
          marginBottom: 16,
        }}
      >
        <div>
          <h1
            style={{
              display: "flex",
              alignItems: "center",
              gap: 10,
              margin: 0,
              fontSize: "1.75rem",
              fontWeight: 600,
            }}
          >
            <ShieldOff size={26} aria-hidden /> Cancellation Policies
          </h1>
          <p
            style={{
              color: "var(--text-secondary)",
              marginTop: 4,
              fontSize: "0.9rem",
            }}
          >
            Per-sub-brand refund ladders for travel invoice voids.{" "}
            {total.toLocaleString()} polic{total === 1 ? "y" : "ies"}.
          </p>
        </div>
        {canWrite && (
          <button type="button" onClick={openCreate} style={primaryBtn}>
            <Plus size={14} /> New Policy
          </button>
        )}
      </header>

      <div
        className="glass"
        style={{
          padding: 12,
          marginBottom: 16,
          display: "flex",
          alignItems: "center",
          gap: 12,
          flexWrap: "wrap",
        }}
      >
        <select
          value={subBrand}
          onChange={(e) => setSubBrand(e.target.value)}
          style={selectStyle}
          aria-label="Filter by sub-brand"
        >
          {SUB_BRANDS.map((s) => (
            <option key={s.value} value={s.value}>
              {s.label}
            </option>
          ))}
        </select>
        <select
          value={activeFilter}
          onChange={(e) => setActiveFilter(e.target.value)}
          style={selectStyle}
          aria-label="Filter by active status"
        >
          {ACTIVE_FILTER.map((a) => (
            <option key={a.value} value={a.value}>
              {a.label}
            </option>
          ))}
        </select>
      </div>

      {showForm && (
        <form
          onSubmit={handleSubmit}
          className="glass"
          style={{
            padding: 16,
            marginBottom: 16,
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 220px), 1fr))",
            gap: 10,
            alignItems: "start",
          }}
        >
          <input
            placeholder="Policy name *"
            required
            type="text"
            value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
            style={inputStyle}
            aria-label="Policy name"
          />
          {lockedBrand ? (
            <input
              type="text"
              value={subBrandShortLabel(lockedBrand)}
              readOnly
              disabled
              aria-label="Sub-brand (locked to your assigned brand)"
              style={{ ...inputStyle, opacity: 0.7, cursor: "not-allowed" }}
            />
          ) : (
            <select
              value={form.subBrand}
              onChange={(e) => setForm({ ...form, subBrand: e.target.value })}
              style={inputStyle}
              aria-label="Sub-brand"
            >
              <option value="">Tenant-wide (no sub-brand)</option>
              {myBrands.map((b) => (
                <option key={b} value={b}>
                  {subBrandShortLabel(b)}
                </option>
              ))}
            </select>
          )}
          <label
            style={{
              ...inputStyle,
              display: "flex",
              alignItems: "center",
              gap: 8,
            }}
          >
            <input
              type="checkbox"
              checked={!!form.isActive}
              onChange={(e) => setForm({ ...form, isActive: e.target.checked })}
              aria-label="Active"
            />
            <span>Active</span>
          </label>
          <textarea
            placeholder="Description (optional)"
            value={form.description}
            onChange={(e) =>
              setForm({ ...form, description: e.target.value })
            }
            style={{ ...inputStyle, gridColumn: "1 / -1", minHeight: 60 }}
            aria-label="Description"
          />

          <fieldset
            style={{
              gridColumn: "1 / -1",
              border: "1px solid var(--border-color)",
              borderRadius: 6,
              padding: 12,
              margin: 0,
            }}
          >
            <legend
              style={{
                padding: "0 6px",
                fontSize: 13,
                fontWeight: 600,
                color: "var(--text-primary)",
              }}
            >
              Refund Tiers *
            </legend>
            <div
              style={{
                fontSize: 12,
                color: "var(--text-secondary)",
                marginBottom: 8,
              }}
            >
              At cancellation time, the engine walks tiers top-down (largest
              days-before first) and picks the first tier whose threshold is
              ≤ the actual days-before-service-start.
            </div>
            <TopScrollSync>
            <table style={{ width: "100%", borderCollapse: "collapse" }}>
              <thead>
                <tr>
                  <th style={th}>Days before service start</th>
                  <th style={th}>Refund %</th>
                  <th style={{ ...th, width: 40 }} aria-label="Remove" />
                </tr>
              </thead>
              <tbody>
                {form.tiers.map((t, idx) => (
                  <tr key={idx}>
                    <td style={td}>
                      <input
                        type="number"
                        min={0}
                        step={1}
                        value={t.daysBeforeServiceStart}
                        onChange={(e) =>
                          updateTierField(
                            idx,
                            "daysBeforeServiceStart",
                            e.target.value,
                          )
                        }
                        style={tierInputStyle}
                        aria-label={`Tier ${idx + 1} days`}
                      />
                    </td>
                    <td style={td}>
                      <input
                        type="number"
                        min={0}
                        max={100}
                        step={1}
                        value={t.refundPercent}
                        onChange={(e) =>
                          updateTierField(idx, "refundPercent", e.target.value)
                        }
                        style={tierInputStyle}
                        aria-label={`Tier ${idx + 1} refund percent`}
                      />
                    </td>
                    <td style={{ ...td, textAlign: "center" }}>
                      <button
                        type="button"
                        onClick={() => removeTierRow(idx)}
                        title="Remove tier"
                        aria-label={`Remove tier ${idx + 1}`}
                        style={iconBtn}
                      >
                        <X size={14} />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            </TopScrollSync>
            <button
              type="button"
              onClick={addTierRow}
              style={{ ...secondaryBtn, marginTop: 8 }}
            >
              <Plus size={12} /> Add tier
            </button>
            <div
              data-testid="tier-preview"
              style={{
                marginTop: 12,
                padding: "8px 10px",
                borderRadius: 6,
                background: "var(--subtle-bg, rgba(255,255,255,0.04))",
                fontSize: 12,
                color: "var(--text-secondary)",
                fontFamily: "monospace",
              }}
            >
              <strong style={{ color: "var(--text-primary)" }}>
                Preview:
              </strong>{" "}
              {previewString}
            </div>
          </fieldset>

          <div style={{ display: "flex", gap: 8, gridColumn: "1 / -1" }}>
            <button
              type="submit"
              disabled={saving}
              style={{
                ...primaryBtn,
                background: "var(--success-color, var(--primary-color))",
              }}
            >
              {saving ? "Saving…" : editingId ? "Save Changes" : "Save"}
            </button>
            <button
              type="button"
              onClick={() => {
                setShowForm(false);
                resetForm();
              }}
              style={secondaryBtn}
            >
              Cancel
            </button>
          </div>
        </form>
      )}

      <div className="glass" style={{ padding: 0, overflow: "visible" }}>
        {loading ? (
          <div style={empty}>Loading&hellip;</div>
        ) : (
          <TopScrollSync>
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr style={{ borderBottom: "1px solid rgba(255,255,255,0.06)" }}>
                <th style={th}>Name</th>
                <th style={th}>Sub-brand</th>
                <th style={th}>Tiers</th>
                <th style={th}>Preview</th>
                <th style={th}>Active</th>
                <th style={th}>Updated</th>
                {canWrite && (
                  <th style={{ ...th, textAlign: "center" }}>Actions</th>
                )}
              </tr>
            </thead>
            <tbody>
              {policies.map((p) => {
                const parsed = parseTiers(p.tiersJson);
                const tierCount = parsed ? parsed.length : "—";
                const preview = parsed ? renderTierPreview(parsed) : "—";
                return (
                  <tr
                    key={p.id}
                    style={{ borderTop: "1px solid rgba(255,255,255,0.04)" }}
                  >
                    <td style={td}>
                      <strong>{p.name}</strong>
                    </td>
                    <td style={td}>
                      <span
                        style={{
                          ...brandBadge,
                          background:
                            SUB_BRAND_BG[p.subBrand] ||
                            "rgba(255,255,255,0.08)",
                        }}
                      >
                        {p.subBrand || "tenant"}
                      </span>
                    </td>
                    <td style={td}>{tierCount}</td>
                    <td
                      style={{
                        ...td,
                        fontFamily: "monospace",
                        fontSize: 12,
                        color: "var(--text-secondary)",
                        maxWidth: 360,
                      }}
                    >
                      {preview}
                    </td>
                    <td style={td}>
                      <span
                        style={{
                          ...statusBadge,
                          background: p.isActive
                            ? "rgba(34, 197, 94, 0.18)"
                            : "rgba(148, 163, 184, 0.18)",
                          color: p.isActive
                            ? "var(--success-color, #22c55e)"
                            : "var(--text-secondary)",
                        }}
                      >
                        {p.isActive ? "Active" : "Inactive"}
                      </span>
                    </td>
                    <td style={td}>{formatDate(p.updatedAt || p.createdAt)}</td>
                    {canWrite && (
                      <td
                        style={{
                          ...td,
                          textAlign: "center",
                          whiteSpace: "nowrap",
                        }}
                      >
                        <button
                          type="button"
                          onClick={() => openEdit(p)}
                          title={`Edit policy ${p.name}`}
                          aria-label={`Edit policy ${p.name}`}
                          style={iconBtn}
                        >
                          <Pencil size={16} />
                        </button>
                        {canDelete && (
                          <button
                            type="button"
                            onClick={() => handleDelete(p)}
                            title={`Delete policy ${p.name}`}
                            aria-label={`Delete policy ${p.name}`}
                            style={{
                              ...iconBtn,
                              color: "var(--danger-color, #f43f5e)",
                            }}
                          >
                            <Trash2 size={16} />
                          </button>
                        )}
                      </td>
                    )}
                  </tr>
                );
              })}
              {policies.length === 0 && (
                <tr>
                  <td
                    colSpan={canWrite ? 7 : 6}
                    style={{
                      ...td,
                      textAlign: "center",
                      color: permissionDenied
                        ? "var(--warning-color, #f59e0b)"
                        : "var(--text-secondary)",
                      padding: permissionDenied
                        ? "2rem 1rem"
                        : "1.5rem 1rem",
                    }}
                  >
                    {permissionDenied ? (
                      <>
                        <strong>Access restricted.</strong>
                        <div
                          style={{
                            fontSize: "0.85rem",
                            marginTop: "0.5rem",
                            color: "var(--text-secondary)",
                          }}
                        >
                          Your role does not have permission to view
                          cancellation policies. Ask an Admin to grant access
                          if you need it.
                        </div>
                      </>
                    ) : (
                      <>
                        <ShieldOff
                          size={20}
                          style={{ opacity: 0.4, marginBottom: 6 }}
                        />
                        <div>No policies match.</div>
                      </>
                    )}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
          </TopScrollSync>
        )}
      </div>
    </div>
  );
}

const th = {
  textAlign: "left",
  padding: "10px 12px",
  fontSize: 12,
  textTransform: "uppercase",
  letterSpacing: 0.5,
  color: "var(--text-secondary)",
  borderBottom: "1px solid var(--border-color)",
  background: "var(--subtle-bg)",
  fontWeight: 600,
};
const td = { padding: "10px 12px", fontSize: 14, color: "var(--text-primary)" };
const empty = {
  padding: 32,
  textAlign: "center",
  color: "var(--text-secondary)",
  fontSize: 14,
};
const inputStyle = {
  padding: "8px 10px",
  borderRadius: 6,
  border: "1px solid var(--border-color)",
  background: "var(--bg-color, rgba(255,255,255,0.05))",
  color: "var(--text-primary)",
  fontSize: 13,
  outline: "none",
};
const tierInputStyle = {
  ...inputStyle,
  width: "100%",
  padding: "6px 8px",
};
const selectStyle = {
  padding: "6px 10px",
  borderRadius: 6,
  border: "1px solid var(--border-color)",
  background: "var(--surface-color)",
  color: "var(--text-primary)",
  minWidth: 160,
  fontSize: 13,
};
const primaryBtn = {
  display: "inline-flex",
  alignItems: "center",
  gap: 6,
  padding: "8px 14px",
  borderRadius: 6,
  fontWeight: 600,
  fontSize: 13,
  background: "var(--primary-color, var(--accent-color))",
  color: "#fff",
  border: "none",
  cursor: "pointer",
};
const secondaryBtn = {
  display: "inline-flex",
  alignItems: "center",
  gap: 6,
  padding: "8px 14px",
  borderRadius: 6,
  fontWeight: 600,
  fontSize: 13,
  background: "var(--surface-color)",
  color: "var(--text-primary)",
  border: "1px solid var(--border-color)",
  cursor: "pointer",
};
const iconBtn = {
  padding: 6,
  borderRadius: 4,
  background: "transparent",
  color: "var(--text-secondary)",
  border: "none",
  cursor: "pointer",
  marginRight: 4,
};
const brandBadge = {
  display: "inline-block",
  padding: "2px 8px",
  borderRadius: 10,
  fontSize: 11,
  fontWeight: 600,
  textTransform: "uppercase",
  letterSpacing: 0.4,
  color: "var(--text-primary)",
};
const statusBadge = {
  display: "inline-block",
  padding: "2px 8px",
  borderRadius: 10,
  fontSize: 11,
  fontWeight: 600,
};
