/**
 * FlyerTemplates.jsx — Travel-vertical operator-facing list of saved flyer
 * templates (PRD_TRAVEL_MARKETING_FLYER #908 slice 2).
 *
 * Lands at /travel/flyer-templates (wire-in DEFERRED to a separate slice).
 * Companion surface to MarketingFlyerStudio.jsx (the live composer): this
 * page is the LIST + lifecycle (create / edit metadata / delete / pick a
 * starting point), while the composer is where blocks + palette are actually
 * authored block-by-block. Operators land here to browse / reuse saved
 * templates as starting points for new flyers.
 *
 * Backend contract (STUB-mode pending slice 3):
 *   GET    /api/travel/flyer-templates                  → 200 { templates: [...], total }
 *   POST   /api/travel/flyer-templates  body:{name (required), subBrand}
 *                                                       → 201 created
 *   PUT    /api/travel/flyer-templates/:id              → 200 updated
 *   DELETE /api/travel/flyer-templates/:id              → 204 No Content
 *   POST   /api/travel/flyer-templates/:id/duplicate    → 201 created  (slice 6, 6bbad574)
 *     body (optional): { name?, subBrand? } — defaults: name = "<source.name> (copy)",
 *     subBrand = source.subBrand. ADMIN/MANAGER only.
 *
 * STUB note (slice 2): the GET endpoint above does NOT exist yet — slice 3
 * (backend route + Prisma model FlyerTemplate) is the next slice in the
 * arc. Until that lands, the GET will 404, the page renders the empty
 * state, and create/edit/delete buttons will surface notify.error from
 * fetchApi's 404 path. The slice-2 contract is purely client-shape:
 * filter / search / modal / navigate. Slice 3 wires it to real storage.
 *
 * Template shape consumed (per slice-1 backend/lib/flyerTemplateValidator.js):
 *   { id, name, subBrand, palette: { primaryHex, secondaryHex, accentHex?,
 *     textHex, bgHex }, layout: [...], assets: { logo?, hero?, footer? } }
 *
 * Page surface:
 *   - Header: "Flyer Templates" + sub-head
 *   - Filter bar: sub-brand dropdown + search input + "+ New Template" CTA
 *     (ADMIN/MANAGER only — canWrite = role === "ADMIN" || role === "MANAGER")
 *   - Card grid: one card per template — name, sub-brand badge, palette
 *     swatches (5 hex from palette object), thumbnail placeholder, action
 *     buttons (Edit / Delete / "Use as starting point")
 *   - Loading state on initial GET
 *   - Empty state when list returns []
 *   - New / Edit modals (basic name + sub-brand; full editor lives in
 *     MarketingFlyerStudio.jsx)
 *
 * Template patterns:
 *   - Cloned from SuppliersAdmin.jsx (commit 08ebe5e + slice extensions)
 *     for the canonical list-page + modal pattern (header + filter bar +
 *     create/edit modal + permission-aware empty-state).
 *   - Sub-brand helpers from utils/travelSubBrand (rule-of-3 promoted
 *     2026-05-24 tick #99).
 *   - notify.confirm for the delete action (matches the modern CRM
 *     surface; older window.confirm pattern is reserved for the parent
 *     suppliers delete which predates the migration).
 */
import { useEffect, useState, useContext, useMemo } from "react";
import { useNavigate } from "react-router-dom";
import { FileImage, Plus, Pencil, Trash2, Copy, CopyPlus, Search } from "lucide-react";
import { fetchApi } from "../../utils/api";
import { useNotify } from "../../utils/notify";
import { SUB_BRAND_BG, SUB_BRAND_LABEL } from "../../utils/travelSubBrand";
import { AuthContext } from "../../App";

const SUB_BRANDS = [
  { value: "", label: "All sub-brands" },
  { value: "tmc", label: "TMC (schools)" },
  { value: "rfu", label: "RFU (Umrah)" },
  { value: "travelstall", label: "Travel Stall" },
  { value: "visasure", label: "Visa Sure" },
];

const SUB_BRANDS_CREATE = SUB_BRANDS.filter((s) => s.value);

// Default placeholder palette used when a template's palette object is
// malformed or missing (defensive — slice-1 validator ensures shape on
// POST, but legacy/migrated rows may exist with partial data).
const PALETTE_FALLBACK = {
  primaryHex: "#122647",
  secondaryHex: "#265855",
  accentHex: "#C89A4E",
  textHex: "#222222",
  bgHex: "#FFFDF7",
};

const PALETTE_KEYS = ["primaryHex", "secondaryHex", "accentHex", "textHex", "bgHex"];

const EMPTY_FORM = {
  name: "",
  subBrand: "tmc",
};

export default function FlyerTemplates() {
  const notify = useNotify();
  const navigate = useNavigate();
  const { user } = useContext(AuthContext) || {};
  const canWrite = user?.role === "ADMIN" || user?.role === "MANAGER";

  const [templates, setTemplates] = useState([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [permissionDenied, setPermissionDenied] = useState(false);

  const [subBrand, setSubBrand] = useState("");
  const [search, setSearch] = useState("");

  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState(null);
  const [form, setForm] = useState(EMPTY_FORM);
  const [saving, setSaving] = useState(false);
  // Per-card in-flight Duplicate guard — keyed by source template id so
  // a duplicate on row A doesn't disable the button on row B (and a
  // concurrent double-click on row A is suppressed by the disabled state).
  const [duplicatingId, setDuplicatingId] = useState(null);

  const load = () => {
    setLoading(true);
    const qs = new URLSearchParams();
    if (subBrand) qs.set("subBrand", subBrand);
    // STUB: GET /api/travel/flyer-templates endpoint deferred to slice 3.
    // Until then this returns 404 and the page surfaces the empty state.
    // Search is performed client-side to keep the slice-2 backend stub
    // simple (slice 3 may add ?q= for server-side filtering when the row
    // count justifies it).
    const url = `/api/travel/flyer-templates${qs.toString() ? `?${qs.toString()}` : ""}`;
    fetchApi(url, { silent: true })
      .then((d) => {
        setTemplates(Array.isArray(d?.templates) ? d.templates : []);
        setTotal(Number.isFinite(d?.total) ? d.total : 0);
        setPermissionDenied(false);
      })
      .catch((err) => {
        setTemplates([]);
        setTotal(0);
        setPermissionDenied(err?.status === 403);
      })
      .finally(() => setLoading(false));
  };

  useEffect(load, [subBrand]);

  // Client-side search filter — case-insensitive substring on name.
  // Kept client-side so slice-2 contract stays minimal (a single GET
  // hydrates everything for the selected sub-brand).
  const filteredTemplates = useMemo(() => {
    const q = (search || "").trim().toLowerCase();
    if (!q) return templates;
    return templates.filter(
      (t) => typeof t?.name === "string" && t.name.toLowerCase().includes(q),
    );
  }, [templates, search]);

  const resetForm = () => {
    setForm(EMPTY_FORM);
    setEditingId(null);
  };

  const openCreate = () => {
    resetForm();
    setShowForm(true);
  };

  const openEdit = (t) => {
    setForm({
      name: t.name || "",
      subBrand: t.subBrand || "tmc",
    });
    setEditingId(t.id);
    setShowForm(true);
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    const trimmedName = (form.name || "").trim();
    if (!trimmedName) {
      notify.error("Name is required");
      return;
    }
    setSaving(true);
    try {
      const payload = {
        name: trimmedName,
        subBrand: form.subBrand || "tmc",
      };
      if (editingId) {
        await fetchApi(`/api/travel/flyer-templates/${editingId}`, {
          method: "PUT",
          body: JSON.stringify(payload),
        });
        notify.success(`Template "${trimmedName}" updated`);
      } else {
        await fetchApi("/api/travel/flyer-templates", {
          method: "POST",
          body: JSON.stringify(payload),
        });
        notify.success(`Template "${trimmedName}" created`);
      }
      setShowForm(false);
      resetForm();
      load();
    } catch (err) {
      notify.error(err?.message || "Save failed");
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (t) => {
    const ok = await notify.confirm(
      `Delete template "${t.name}"? This cannot be undone.`,
    );
    if (!ok) return;
    try {
      await fetchApi(`/api/travel/flyer-templates/${t.id}`, { method: "DELETE" });
      notify.success(`Template "${t.name}" deleted`);
      load();
    } catch (err) {
      notify.error(err?.message || "Delete failed");
    }
  };

  const handleUseAsStartingPoint = (t) => {
    navigate(`/travel/marketing-flyer-studio?template=${t.id}`);
  };

  // Duplicate consumes POST /api/travel/flyer-templates/:id/duplicate (slice
  // 6, commit 6bbad574). Empty body → backend defaults: name becomes
  // "<source.name> (copy)", subBrand inherits from source. The new template
  // is spliced into local list state so the operator sees it immediately
  // without waiting on a full re-fetch. duplicatingId guards against
  // concurrent double-fires (per-row disabled state).
  const handleDuplicate = async (t) => {
    if (duplicatingId === t.id) return;
    setDuplicatingId(t.id);
    try {
      const created = await fetchApi(
        `/api/travel/flyer-templates/${t.id}/duplicate`,
        { method: "POST", body: JSON.stringify({}) },
      );
      if (created && typeof created === "object" && created.id) {
        setTemplates((prev) => [created, ...prev]);
        setTotal((prev) => prev + 1);
      }
      notify.success(`Template "${t.name}" duplicated`);
    } catch (err) {
      notify.error(err?.message || "Duplicate failed");
    } finally {
      setDuplicatingId(null);
    }
  };

  return (
    <div style={{ padding: 24, maxWidth: 1200, margin: "0 auto", animation: "fadeIn 0.4s ease-out" }}>
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
          <h1 style={{ display: "flex", alignItems: "center", gap: 10, margin: 0, fontSize: "1.75rem", fontWeight: 600 }}>
            <FileImage size={26} aria-hidden /> Flyer Templates
          </h1>
          <p style={{ color: "var(--text-secondary)", marginTop: 4, fontSize: "0.9rem" }}>
            Reusable flyer designs for marketing campaigns.
            {total > 0 && ` ${total.toLocaleString()} template${total === 1 ? "" : "s"}.`}
          </p>
        </div>
        {canWrite && (
          <button type="button" onClick={openCreate} style={primaryBtn}>
            <Plus size={14} /> New Template
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
            <option key={s.value || "all"} value={s.value}>{s.label}</option>
          ))}
        </select>
        <div style={{ display: "flex", alignItems: "center", gap: 6, flex: "1 1 200px", minWidth: 200 }}>
          <Search size={14} aria-hidden style={{ color: "var(--text-secondary)" }} />
          <input
            type="search"
            placeholder="Search templates by name"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            style={{ ...inputStyle, flex: 1 }}
            aria-label="Search templates"
          />
        </div>
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
            alignItems: "end",
          }}
          data-testid="flyer-template-form"
        >
          <input
            placeholder="Template name *"
            required
            value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
            style={inputStyle}
            aria-label="Template name"
          />
          <select
            value={form.subBrand}
            onChange={(e) => setForm({ ...form, subBrand: e.target.value })}
            style={inputStyle}
            aria-label="Sub-brand"
          >
            {SUB_BRANDS_CREATE.map((s) => (
              <option key={s.value} value={s.value}>{s.label}</option>
            ))}
          </select>
          <div style={{ display: "flex", gap: 8 }}>
            <button type="submit" disabled={saving} style={{ ...primaryBtn, background: "var(--success-color, var(--primary-color))" }}>
              {saving ? "Saving…" : editingId ? "Save Changes" : "Save"}
            </button>
            <button
              type="button"
              onClick={() => { setShowForm(false); resetForm(); }}
              style={secondaryBtn}
            >
              Cancel
            </button>
          </div>
          <p style={{ gridColumn: "1 / -1", margin: 0, fontSize: 11, color: "var(--text-secondary)" }}>
            Note: palette + layout blocks are edited in the live composer at
            Marketing Flyer Studio. This form only captures metadata.
          </p>
        </form>
      )}

      {loading ? (
        <div className="glass" style={empty}>Loading&hellip;</div>
      ) : filteredTemplates.length === 0 ? (
        <div
          className="glass"
          style={{
            ...empty,
            color: permissionDenied ? "var(--warning-color, #f59e0b)" : "var(--text-secondary)",
          }}
        >
          {permissionDenied ? (
            <>
              <strong>Access restricted.</strong>
              <div style={{ fontSize: "0.85rem", marginTop: "0.5rem", color: "var(--text-secondary)" }}>
                Your role does not have permission to view flyer templates. Ask an Admin to grant access if you need it.
              </div>
            </>
          ) : templates.length === 0 ? (
            <>
              <FileImage size={28} style={{ opacity: 0.4, marginBottom: 6 }} aria-hidden />
              <div>No templates yet — create one to get started.</div>
            </>
          ) : (
            <>
              <Search size={20} style={{ opacity: 0.4, marginBottom: 6 }} aria-hidden />
              <div>No templates match your search.</div>
            </>
          )}
        </div>
      ) : (
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 260px), 1fr))",
            gap: 12,
          }}
          data-testid="flyer-template-grid"
        >
          {filteredTemplates.map((t) => {
            const palette = t.palette && typeof t.palette === "object" ? t.palette : PALETTE_FALLBACK;
            return (
              <article
                key={t.id}
                className="glass"
                data-testid={`flyer-template-card-${t.id}`}
                style={{
                  padding: 14,
                  display: "flex",
                  flexDirection: "column",
                  gap: 10,
                  minWidth: 0,
                }}
              >
                {/* Thumbnail placeholder — uses palette.bgHex + accent for a tiny preview chip. */}
                <div
                  aria-hidden
                  data-testid={`flyer-template-thumb-${t.id}`}
                  style={{
                    height: 80,
                    borderRadius: 6,
                    background: palette.bgHex || PALETTE_FALLBACK.bgHex,
                    border: `2px solid ${palette.primaryHex || PALETTE_FALLBACK.primaryHex}`,
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    color: palette.textHex || PALETTE_FALLBACK.textHex,
                    fontSize: 12,
                    fontWeight: 600,
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                  }}
                >
                  <FileImage size={20} aria-hidden style={{ opacity: 0.6 }} />
                </div>

                <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", minWidth: 0 }}>
                  <strong
                    style={{
                      fontSize: 14,
                      flex: 1,
                      minWidth: 0,
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                    title={t.name}
                  >
                    {t.name || "Untitled"}
                  </strong>
                  <span
                    style={{
                      ...brandBadge,
                      background: SUB_BRAND_BG[t.subBrand] || "rgba(255,255,255,0.08)",
                    }}
                    title={SUB_BRAND_LABEL[t.subBrand] || t.subBrand}
                  >
                    {t.subBrand || "—"}
                  </span>
                </div>

                {/* Palette swatches — 5 hex chips from palette object. */}
                <div
                  data-testid={`flyer-template-palette-${t.id}`}
                  style={{ display: "flex", gap: 4, alignItems: "center" }}
                  aria-label={`Palette colors for ${t.name || "template"}`}
                >
                  {PALETTE_KEYS.map((key) => {
                    const hex = palette[key];
                    if (!hex) return null;
                    return (
                      <span
                        key={key}
                        data-testid={`swatch-${t.id}-${key}`}
                        title={`${key}: ${hex}`}
                        style={{
                          width: 18,
                          height: 18,
                          borderRadius: 4,
                          background: hex,
                          border: "1px solid rgba(255,255,255,0.15)",
                          display: "inline-block",
                        }}
                      />
                    );
                  })}
                </div>

                <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: "auto" }}>
                  <button
                    type="button"
                    onClick={() => handleUseAsStartingPoint(t)}
                    style={smallPrimaryBtn}
                    title={`Use ${t.name} as starting point`}
                    aria-label={`Use ${t.name} as starting point`}
                  >
                    <Copy size={12} /> Use as starting point
                  </button>
                  {canWrite && (
                    <>
                      <button
                        type="button"
                        onClick={() => handleDuplicate(t)}
                        disabled={duplicatingId === t.id}
                        style={iconBtn}
                        title={`Duplicate ${t.name}`}
                        aria-label={`Duplicate ${t.name}`}
                      >
                        <CopyPlus size={14} />
                      </button>
                      <button
                        type="button"
                        onClick={() => openEdit(t)}
                        style={iconBtn}
                        title={`Edit ${t.name}`}
                        aria-label={`Edit ${t.name}`}
                      >
                        <Pencil size={14} />
                      </button>
                      <button
                        type="button"
                        onClick={() => handleDelete(t)}
                        style={{ ...iconBtn, color: "var(--danger-color, #f43f5e)" }}
                        title={`Delete ${t.name}`}
                        aria-label={`Delete ${t.name}`}
                      >
                        <Trash2 size={14} />
                      </button>
                    </>
                  )}
                </div>
              </article>
            );
          })}
        </div>
      )}
    </div>
  );
}

const empty = { padding: 32, textAlign: "center", color: "var(--text-secondary)", fontSize: 14 };
const inputStyle = {
  padding: "8px 10px",
  borderRadius: 6,
  border: "1px solid var(--border-color)",
  background: "var(--bg-color, rgba(255,255,255,0.05))",
  color: "var(--text-primary)",
  fontSize: 13,
  outline: "none",
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
const smallPrimaryBtn = {
  ...primaryBtn,
  padding: "6px 10px",
  fontSize: 12,
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
