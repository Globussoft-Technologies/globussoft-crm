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
import { useEffect, useState, useContext, useMemo, useRef } from "react";
import { useNavigate } from "react-router-dom";
import { FileImage, Plus, Pencil, Trash2, Copy, CopyPlus, Search, Download, ChevronDown, Eye, X } from "lucide-react";
import { fetchApi, getAuthToken, getActiveTenantId } from "../../utils/api";
import { useNotify } from "../../utils/notify";
import {
  SUB_BRAND_BG,
  SUB_BRAND_LABEL,
  accessibleSubBrands,
  defaultSubBrandFor,
  subBrandShortLabel,
} from "../../utils/travelSubBrand";
import { useActiveSubBrand } from "../../utils/subBrand";
import { AuthContext } from "../../App";

const SUB_BRANDS = [
  { value: "", label: "All sub-brands" },
  { value: "tmc", label: "TMC (schools)" },
  { value: "rfu", label: "RFU (Umrah)" },
  { value: "travelstall", label: "Travel Stall" },
  { value: "visasure", label: "Visa Sure" },
];

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

// PRD_TRAVEL_MARKETING_FLYER.md FR-3.4 / FR-3.5 — 5-format render menu
// (slice S77 — Wave 17 — Download dropdown on each template row).
//
// Each item maps to a `format` value the backend's POST /:id/render route
// (slice S17) accepts. The extension column drives the file-save filename
// suffix (`.pdf` for the two pdf-* formats; `.png` for the three png-*
// formats). MIME isn't used client-side — the backend sets Content-Type
// on the response, and `Blob`/`createObjectURL` carries that through to
// the browser's save dialog.
const RENDER_FORMATS = [
  { format: "pdf-a4", label: "PDF — A4", ext: "pdf" },
  { format: "pdf-a5", label: "PDF — A5", ext: "pdf" },
  { format: "png-square", label: "Square PNG (1200×1200)", ext: "png" },
  { format: "png-portrait-ig", label: "Instagram Story (1080×1920)", ext: "png" },
  { format: "png-landscape-fb", label: "Facebook Cover (1920×1080)", ext: "png" },
];

export default function FlyerTemplates() {
  const notify = useNotify();
  const navigate = useNavigate();
  const { user } = useContext(AuthContext) || {};
  const canWrite = user?.role === "ADMIN" || user?.role === "MANAGER";
  const { activeSubBrand } = useActiveSubBrand();
  // Sub-brands this user may create/edit templates for. ADMIN (or any user
  // with all 4) gets a full dropdown; a user restricted to exactly one brand
  // gets that brand auto-selected + a read-only field (no dropdown).
  const myBrands = accessibleSubBrands(user);
  const lockedBrand = myBrands.length === 1 ? myBrands[0] : null;

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
  // Currently-previewing template (drives FlyerPreviewModal). null = no modal.
  const [previewTemplate, setPreviewTemplate] = useState(null);

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
    setEditingId(null);
    setForm({ ...EMPTY_FORM, subBrand: defaultSubBrandFor(user, activeSubBrand) });
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

  // Download dispatcher consumes POST /api/travel/flyer-templates/:id/render
  // (slice S17 — backend route, 5-format synchronous render). Returns a
  // binary buffer (PDF or PNG) on the wire, NOT JSON — so we MUST bypass
  // the existing fetchApi helper (which always calls response.json() and
  // would corrupt the buffer). Raw fetch + response.blob() + a synthetic
  // <a download> click is the canonical browser save-buffer-as-file flow.
  //
  // Filename derivation: `${template.name}-${format}.${ext}`. Spaces +
  // unicode in the name are fine (the browser save-dialog handles them
  // verbatim); the backend's own Content-Disposition is overridden by
  // the <a download> attribute on the client side, which is what we want
  // so the file lands with the operator-friendly name not the backend's
  // `flyer-501-pdf-a4.pdf`.
  //
  // Errors: 4xx + 5xx surface via notify.error with the route's `error`
  // string if the response is JSON, or a generic "Render failed" fallback
  // otherwise. We do NOT auto-redirect on 401 here (unlike fetchApi) —
  // the next foreground fetchApi call will surface the real 401 + redirect.
  const handleDownload = async (t, format, ext) => {
    try {
      const token = getAuthToken();
      const activeTenantId = getActiveTenantId();
      const headers = { "Content-Type": "application/json" };
      if (token) headers.Authorization = `Bearer ${token}`;
      if (activeTenantId != null) headers["X-Active-Tenant"] = String(activeTenantId);
      const response = await fetch(
        `/api/travel/flyer-templates/${t.id}/render`,
        {
          method: "POST",
          headers,
          body: JSON.stringify({ format }),
        },
      );
      if (!response.ok) {
        let msg = `Render failed (${response.status}).`;
        try {
          const errData = await response.json();
          if (errData && (errData.error || errData.message)) {
            msg = errData.error || errData.message;
          }
        } catch (_e) { /* non-JSON error body — keep generic msg */ }
        notify.error(msg);
        return;
      }
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      try {
        const a = document.createElement("a");
        a.href = url;
        a.download = `${(t.name || "flyer").trim() || "flyer"}-${format}.${ext}`;
        // The element doesn't need to be in the DOM for .click() to trigger
        // the browser save dialog, but appending makes the spec test path
        // observable + sidesteps some browser quirks.
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
      } finally {
        URL.revokeObjectURL(url);
      }
    } catch (err) {
      notify.error(err?.message || "Render failed");
    }
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
          {lockedBrand ? (
            <input
              type="text"
              value={subBrandShortLabel(form.subBrand || lockedBrand)}
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
              {myBrands.map((b) => (
                <option key={b} value={b}>{subBrandShortLabel(b)}</option>
              ))}
            </select>
          )}
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
            // auto-fill (not auto-fit) so a single card stays at its
            // ~280px width instead of stretching to fill the row — gives
            // the page a proper "card library" feel instead of one huge
            // horizontal panel.
            gridTemplateColumns: "repeat(auto-fill, minmax(260px, 280px))",
            gap: 16,
            justifyContent: "start",
          }}
          data-testid="flyer-template-grid"
        >
          {filteredTemplates.map((t) => {
            const palette = t.palette && typeof t.palette === "object" ? t.palette : PALETTE_FALLBACK;
            const layout = Array.isArray(t.layout) ? t.layout : [];
            return (
              <article
                key={t.id}
                className="glass"
                data-testid={`flyer-template-card-${t.id}`}
                style={{
                  padding: 12,
                  display: "flex",
                  flexDirection: "column",
                  gap: 10,
                  minWidth: 0,
                }}
              >
                <FlyerThumbnail templateId={t.id} palette={palette} layout={layout} />

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
                          width: 16,
                          height: 16,
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
                    onClick={() => setPreviewTemplate(t)}
                    style={smallSecondaryBtn}
                    title={`Preview ${t.name}`}
                    aria-label={`Preview ${t.name}`}
                    data-testid={`flyer-preview-${t.id}`}
                  >
                    <Eye size={12} /> Preview
                  </button>
                  <button
                    type="button"
                    onClick={() => handleUseAsStartingPoint(t)}
                    style={smallPrimaryBtn}
                    title={`Use ${t.name} as starting point`}
                    aria-label={`Use ${t.name} as starting point`}
                  >
                    <Copy size={12} /> Use
                  </button>
                  <DownloadDropdown template={t} onDownload={handleDownload} />
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

      {previewTemplate && (
        <FlyerPreviewModal
          template={previewTemplate}
          onClose={() => setPreviewTemplate(null)}
        />
      )}
    </div>
  );
}

// FlyerThumbnail — renders a scaled-down preview of the template's
// composed canvas. The MarketingFlyerStudio canvas is 540×720 (3:4
// portrait); the thumbnail keeps that exact aspect ratio (CSS
// `aspectRatio: '540 / 720'`) so the scaling is UNIFORM in both axes
// — images and text land at exactly the proportions the operator
// composed, with no horizontal stretching. The previous independent
// X/Y scaling stretched a square temple photo into a thin horizontal
// strip; uniform scaling fixes that.
//
// Falls back to a centered FileImage icon when the layout is empty
// (legacy rows pre-canvas-editor) so the card still has visual weight.
//
// Used by:
//   - FlyerTemplates card grid (small, ~280×373 thumbnail)
//   - FlyerPreviewModal (large, fills available modal area)
//
// `size` prop ('card' | 'modal') tunes only the maxWidth so the same
// component handles both surfaces.
const CANVAS_W_PREVIEW = 540;
const CANVAS_H_PREVIEW = 720;

function FlyerThumbnail({ templateId, palette, layout, size = "card" }) {
  const containerRef = useRef(null);
  const [containerWidth, setContainerWidth] = useState(size === "modal" ? 540 : 256);

  // Measure the rendered width so the scale stays accurate as the card
  // resizes. ResizeObserver fires on every parent-width change.
  useEffect(() => {
    if (!containerRef.current) return;
    const el = containerRef.current;
    setContainerWidth(el.clientWidth);
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const w = Math.max(0, Math.round(entry.contentRect.width));
        if (w > 0) setContainerWidth(w);
      }
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // UNIFORM scale (single factor for both axes). The container itself
  // is locked to the canvas aspect ratio via `aspectRatio` CSS, so
  // height == width × 720/540 — meaning scaleX == scaleY exactly.
  const scale = containerWidth / CANVAS_W_PREVIEW;
  const hasBlocks = Array.isArray(layout) && layout.length > 0;

  return (
    <div
      ref={containerRef}
      aria-hidden={size === "card" ? true : undefined}
      data-testid={`flyer-template-thumb-${templateId}`}
      style={{
        position: "relative",
        width: "100%",
        aspectRatio: `${CANVAS_W_PREVIEW} / ${CANVAS_H_PREVIEW}`,
        borderRadius: 6,
        background: palette.bgHex || PALETTE_FALLBACK.bgHex,
        border: `1px solid ${palette.primaryHex || PALETTE_FALLBACK.primaryHex}`,
        overflow: "hidden",
      }}
    >
      {hasBlocks ? (
        layout.map((b, i) => {
          if (!b || typeof b !== "object") return null;
          const left = Math.round((Number(b.x) || 0) * scale);
          const top = Math.round((Number(b.y) || 0) * scale);
          const w = Math.round((Number(b.width) || 0) * scale);
          const h = Math.round((Number(b.height) || 0) * scale);
          const base = {
            position: "absolute",
            left,
            top,
            width: w,
            height: h,
            overflow: "hidden",
          };
          if (b.type === "image" && typeof b.src === "string" && b.src) {
            return (
              <img
                key={i}
                src={b.src}
                alt=""
                style={{ ...base, objectFit: "contain" }}
                // Broken / expired DALL-E URLs render an empty box; hide
                // the broken-image icon by clearing on error.
                onError={(e) => { e.currentTarget.style.display = "none"; }}
              />
            );
          }
          if (b.type === "text" || b.type === "price" || b.type === "cta") {
            const content = typeof b.content === "string" ? b.content : "";
            if (!content) return null;
            const color = b.type === "price" ? (palette.secondaryHex || PALETTE_FALLBACK.secondaryHex)
              : b.type === "cta" ? (palette.accentHex || PALETTE_FALLBACK.accentHex)
                : (typeof b.color === "string" ? b.color : (palette.textHex || PALETTE_FALLBACK.textHex));
            // Scale font size; clamp to a readable minimum. The 'card'
            // size needs the floor to keep tiny text visible; the
            // 'modal' size produces real-readable text at native scale.
            const fs = Math.max(size === "modal" ? 10 : 6, Math.round(((Number(b.fontSize) || 18)) * scale));
            return (
              <div
                key={i}
                style={{
                  ...base,
                  color,
                  fontSize: fs,
                  fontWeight: 600,
                  lineHeight: 1.2,
                  display: "flex",
                  alignItems: "center",
                }}
              >
                {content}
              </div>
            );
          }
          return null;
        })
      ) : (
        <div
          style={{
            position: "absolute",
            inset: 0,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            color: palette.textHex || PALETTE_FALLBACK.textHex,
            opacity: 0.4,
          }}
        >
          <FileImage size={size === "modal" ? 48 : 24} aria-hidden />
        </div>
      )}
    </div>
  );
}

// FlyerPreviewModal — large, in-browser preview of the template's
// composed canvas. Renders the SAME FlyerThumbnail component at a
// bigger width so the operator can see what's actually on the flyer
// before downloading. No backend round-trip — every block is already
// in the loaded template payload (palette + layout + assets).
//
// Closes on:
//   - Cancel / X button
//   - Escape key
//   - Click on the backdrop (outside the dialog)
function FlyerPreviewModal({ template, onClose }) {
  const palette = template.palette && typeof template.palette === "object" ? template.palette : PALETTE_FALLBACK;
  const layout = Array.isArray(template.layout) ? template.layout : [];

  useEffect(() => {
    const onKey = (e) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={`Preview of ${template.name || "flyer"}`}
      data-testid="flyer-preview-modal"
      onClick={onClose}
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.75)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 1000,
        padding: 24,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: "var(--surface-color, #1f2937)",
          border: "1px solid var(--border-color)",
          borderRadius: 10,
          padding: 16,
          maxWidth: "min(95vw, 600px)",
          width: "100%",
          display: "flex",
          flexDirection: "column",
          gap: 12,
          maxHeight: "95vh",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <strong style={{ flex: 1, fontSize: 16 }}>
            {template.name || "Untitled"}
            {template.subBrand && (
              <span style={{ fontWeight: 400, fontSize: 12, opacity: 0.7, marginLeft: 8 }}>
                {SUB_BRAND_LABEL[template.subBrand] || template.subBrand}
              </span>
            )}
          </strong>
          <button
            type="button"
            onClick={onClose}
            style={{
              padding: 6,
              borderRadius: 4,
              background: "transparent",
              color: "var(--text-primary)",
              border: "1px solid var(--border-color)",
              cursor: "pointer",
              display: "inline-flex",
            }}
            aria-label="Close preview"
            data-testid="flyer-preview-close"
          >
            <X size={16} />
          </button>
        </div>
        <div style={{ overflow: "auto", display: "flex", justifyContent: "center" }}>
          <div style={{ width: "100%", maxWidth: 540 }}>
            <FlyerThumbnail
              templateId={template.id}
              palette={palette}
              layout={layout}
              size="modal"
            />
          </div>
        </div>
        <p style={{ margin: 0, fontSize: 11, color: "var(--text-secondary)" }}>
          This is the live composer preview — download PDF or PNG below for the print-quality version.
        </p>
      </div>
    </div>
  );
}

// DownloadDropdown — slice S77 (Wave 17) per-card menu trigger.
//
// Why a sub-component (and not inline state on the parent):
//   - Open/close + in-flight `loading` state is per-row. Hoisting either
//     to the parent would force the parent to key by template id with
//     two more useState dictionaries; the cost-of-a-component is lower.
//   - Click-outside / Esc-to-close fire on `document` listeners; binding
//     them inside the component scopes the listeners to mount/unmount
//     so they self-clean on row removal.
//
// Accessibility surface:
//   - Trigger is role=button (default for <button>) with aria-haspopup=menu
//     and aria-expanded reflecting open/closed.
//   - Open menu has role=menu; items have role=menuitem.
//   - Arrow keys + Enter + Esc handled at the menu level via onKeyDown.
//   - Click outside the menu closes it (mousedown listener on document).
function DownloadDropdown({ template, onDownload }) {
  const [open, setOpen] = useState(false);
  const [loadingFormat, setLoadingFormat] = useState(null);
  const wrapperRef = useRef(null);
  const itemRefs = useRef([]);

  // Click-outside + Esc-to-close. mousedown (not click) so the trigger's
  // own click event doesn't race the listener and immediately re-close.
  useEffect(() => {
    if (!open) return;
    const onDocMouseDown = (e) => {
      if (wrapperRef.current && !wrapperRef.current.contains(e.target)) {
        setOpen(false);
      }
    };
    const onDocKey = (e) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", onDocMouseDown);
    document.addEventListener("keydown", onDocKey);
    return () => {
      document.removeEventListener("mousedown", onDocMouseDown);
      document.removeEventListener("keydown", onDocKey);
    };
  }, [open]);

  const fire = async (format, ext) => {
    if (loadingFormat) return; // Suppress concurrent clicks across items.
    setLoadingFormat(format);
    try {
      await onDownload(template, format, ext);
    } finally {
      setLoadingFormat(null);
      setOpen(false);
    }
  };

  const onMenuKeyDown = (e, idx) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      const next = (idx + 1) % RENDER_FORMATS.length;
      itemRefs.current[next]?.focus();
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      const prev = (idx - 1 + RENDER_FORMATS.length) % RENDER_FORMATS.length;
      itemRefs.current[prev]?.focus();
    } else if (e.key === "Home") {
      e.preventDefault();
      itemRefs.current[0]?.focus();
    } else if (e.key === "End") {
      e.preventDefault();
      itemRefs.current[RENDER_FORMATS.length - 1]?.focus();
    }
  };

  return (
    <div ref={wrapperRef} style={{ position: "relative", display: "inline-block" }}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        disabled={loadingFormat != null}
        aria-haspopup="menu"
        aria-expanded={open ? "true" : "false"}
        aria-label={`Download ${template.name || "flyer"}`}
        title={`Download ${template.name || "flyer"}`}
        style={{
          ...smallPrimaryBtn,
          background: "var(--surface-color)",
          color: "var(--text-primary)",
          border: "1px solid var(--border-color)",
          opacity: loadingFormat != null ? 0.7 : 1,
        }}
        data-testid={`flyer-download-trigger-${template.id}`}
      >
        <Download size={12} aria-hidden />
        {loadingFormat ? "Rendering…" : "Download"}
        <ChevronDown size={12} aria-hidden />
      </button>
      {open && (
        <div
          role="menu"
          aria-label={`Download formats for ${template.name || "flyer"}`}
          data-testid={`flyer-download-menu-${template.id}`}
          style={{
            position: "absolute",
            top: "calc(100% + 4px)",
            right: 0,
            minWidth: 220,
            background: "var(--surface-color, #1f2937)",
            border: "1px solid var(--border-color)",
            borderRadius: 6,
            padding: 4,
            zIndex: 20,
            boxShadow: "0 8px 24px rgba(0,0,0,0.2)",
            display: "flex",
            flexDirection: "column",
          }}
        >
          {RENDER_FORMATS.map(({ format, label, ext }, idx) => (
            <button
              key={format}
              type="button"
              role="menuitem"
              ref={(el) => { itemRefs.current[idx] = el; }}
              disabled={loadingFormat != null}
              onClick={() => fire(format, ext)}
              onKeyDown={(e) => onMenuKeyDown(e, idx)}
              data-testid={`flyer-download-item-${template.id}-${format}`}
              style={{
                padding: "8px 10px",
                background: "transparent",
                color: "var(--text-primary)",
                border: "none",
                cursor: loadingFormat != null ? "wait" : "pointer",
                fontSize: 13,
                textAlign: "left",
                borderRadius: 4,
                opacity: loadingFormat != null && loadingFormat !== format ? 0.5 : 1,
              }}
            >
              {loadingFormat === format ? `${label} — rendering…` : label}
            </button>
          ))}
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
const smallSecondaryBtn = {
  display: "inline-flex",
  alignItems: "center",
  gap: 4,
  padding: "6px 10px",
  borderRadius: 6,
  fontWeight: 600,
  fontSize: 12,
  background: "var(--surface-color)",
  color: "var(--text-primary)",
  border: "1px solid var(--border-color)",
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
