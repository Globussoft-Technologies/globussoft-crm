/**
 * BrandKits.jsx — ADMIN-only operator UI for per-sub-brand BrandKit assets.
 *
 * Consumes /api/brand-kits CRUD (backend route commit e4783e0, Prisma model
 * commit 5060dda). Per PRD_TRAVEL_PER_SUBBRAND_BRANDING DD-5.2 — operator
 * manages logo / colors / font / tagline per (subBrand, version) pair, with
 * "one active version per (tenantId, subBrand)" semantics enforced by
 * backend transaction.
 *
 * Endpoint shape (from backend/routes/brand_kits.js):
 *   GET    /api/brand-kits?subBrand=&isActive=    → { brandKits:[...], total }
 *   POST   /api/brand-kits                        → 201 created row
 *   PUT    /api/brand-kits/:id                    → 200 updated row
 *   DELETE /api/brand-kits/:id                    → 204 (refuses if active → 422 ACTIVE_KIT_LOCKED)
 *
 * Activation flow: to activate a non-active version, PUT { isActive: true }
 * — backend atomically demotes the prior active row for the same
 * (tenantId, subBrand) inside a prisma.$transaction. No separate /activate
 * endpoint exists; the PUT does it all.
 *
 * Immutable fields after create: subBrand + version. The edit modal disables
 * the subBrand select on edit and surfaces the version number read-only.
 *
 * Layout choice — card grid (not table). Brand kits are inherently visual
 * (color swatches, logo previews, font samples). A table would collapse them
 * to text. The grid uses the same responsive pattern as SuppliersAdmin
 * (`repeat(auto-fit, minmax(min(100%, 320px), 1fr))`) so it works at 1440px
 * and 375px without media queries.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import {
  Palette,
  Plus,
  Pencil,
  Trash2,
  Check,
  AlertCircle,
  Upload,
  History,
  Copy as CopyIcon,
  ChevronDown,
  ChevronRight,
} from "lucide-react";
import { fetchApi, getAuthToken } from "../../utils/api";
import { useNotify } from "../../utils/notify";
import {
  SUB_BRAND_BG,
  SUB_BRAND_IDS,
  subBrandLabel,
} from "../../utils/travelSubBrand";

// Sub-brand select options. The first entry maps to the "tenant-wide"
// (subBrand=null) case — backend normalises empty-string + null + undefined
// to NULL and treats it as a per-tenant default kit (covers generic +
// wellness verticals too, not just travel sub-brands).
const FILTER_SUB_BRANDS = [
  { value: "__all__", label: "All sub-brands" },
  { value: "__none__", label: "Tenant-wide (no sub-brand)" },
  ...SUB_BRAND_IDS.map((id) => ({ value: id, label: subBrandLabel(id) })),
];

const FORM_SUB_BRANDS = [
  { value: "__none__", label: "Tenant-wide (no sub-brand)" },
  ...SUB_BRAND_IDS.map((id) => ({ value: id, label: subBrandLabel(id) })),
];

const EMPTY_FORM = {
  subBrand: "__none__",
  logoUrl: "",
  logoDarkUrl: "",
  faviconUrl: "",
  primaryColor: "#265855",
  secondaryColor: "#CD9481",
  accentColor: "#C89A4E",
  bgColor: "#FFFFFF",
  textColor: "#1A1A1A",
  fontFamily: "",
  fontUrl: "",
  tagline: "",
  isActive: false,
  // W4.A G089 — extended branding fields (FR-3.1.a-g)
  wordmarkUrl: "",
  heroUrl: "",
  successBadge: "",
  warningBadge: "",
  headingFontFamily: "",
  headingFontUrl: "",
  bodyFontFamily: "",
  bodyFontUrl: "",
  codeFontFamily: "",
  codeFontUrl: "",
  cmykPrimary: "",
  cmykSecondary: "",
  cmykAccent: "",
  signatureTemplate: "",
  headerImageUrl: "",
  footerText: "",
  invoiceStampUrl: "",
  missionStatement: "",
  supportEmail: "",
  supportPhone: "",
  socialLinksJson: "",
};

// ── W4.A G099 — WCAG contrast checker ──────────────────────────────────
// Compute relative-luminance ratio between two hex colours per WCAG 2.1
// SC 1.4.3 (AA = 4.5:1 for normal text, 3:1 for large/UI components).
// Returns null when either hex string is invalid (so the UI can render
// "n/a" rather than misleading 1.0). Used both inline in the SUT and
// exported via the standalone wcagContrastRatio() callable from tests.
function _hexToRgb(hex) {
  if (!hex || typeof hex !== "string") return null;
  let h = hex.trim().replace(/^#/, "");
  if (h.length === 3) h = h.split("").map((c) => c + c).join("");
  if (!/^[0-9a-f]{6}$/i.test(h)) return null;
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}
function _relativeLuminance(rgb) {
  const [r, g, b] = rgb.map((c) => {
    const cs = c / 255;
    return cs <= 0.03928 ? cs / 12.92 : Math.pow((cs + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
export function wcagContrastRatio(hex1, hex2) {
  const a = _hexToRgb(hex1);
  const b = _hexToRgb(hex2);
  if (!a || !b) return null;
  const l1 = _relativeLuminance(a);
  const l2 = _relativeLuminance(b);
  const [hi, lo] = l1 > l2 ? [l1, l2] : [l2, l1];
  return (hi + 0.05) / (lo + 0.05);
}

// Empty-string → null normalisation for the asset fields, mirroring the
// SuppliersAdmin payload pattern. Backend accepts both null + string but
// storing literal "" muddies downstream consumer logic.
function emptyToNull(v) {
  return v === "" || v == null ? null : v;
}

export default function BrandKits() {
  const notify = useNotify();
  const [kits, setKits] = useState([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [permissionDenied, setPermissionDenied] = useState(false);

  // Filters
  const [filterSubBrand, setFilterSubBrand] = useState("__all__");
  const [showInactive, setShowInactive] = useState(true);

  // Modal state
  const [showModal, setShowModal] = useState(false);
  const [editingKit, setEditingKit] = useState(null); // null = create, object = edit
  const [form, setForm] = useState(EMPTY_FORM);
  const [saving, setSaving] = useState(false);

  const load = () => {
    setLoading(true);
    const qs = new URLSearchParams();
    if (filterSubBrand === "__none__") {
      qs.set("subBrand", ""); // backend normalises "" to NULL
    } else if (filterSubBrand !== "__all__") {
      qs.set("subBrand", filterSubBrand);
    }
    if (!showInactive) {
      qs.set("isActive", "true");
    }
    const url = `/api/brand-kits${qs.toString() ? `?${qs.toString()}` : ""}`;
    fetchApi(url)
      .then((d) => {
        setKits(Array.isArray(d?.brandKits) ? d.brandKits : []);
        setTotal(Number.isFinite(d?.total) ? d.total : 0);
        setPermissionDenied(false);
      })
      .catch((err) => {
        setKits([]);
        setTotal(0);
        setPermissionDenied(err?.status === 403);
      })
      .finally(() => setLoading(false));
  };

  useEffect(load, [filterSubBrand, showInactive]);

  // Distinct sub-brand count (including the tenant-wide null bucket) for
  // the header caption.
  const subBrandCount = useMemo(() => {
    const seen = new Set();
    kits.forEach((k) => seen.add(k.subBrand == null ? "__none__" : k.subBrand));
    return seen.size;
  }, [kits]);

  // Group kits by sub-brand for the card grid. Within a sub-brand, the
  // backend already returns version desc — preserve that ordering.
  const grouped = useMemo(() => {
    const map = new Map();
    kits.forEach((k) => {
      const key = k.subBrand == null ? "__none__" : k.subBrand;
      if (!map.has(key)) map.set(key, []);
      map.get(key).push(k);
    });
    return Array.from(map.entries());
  }, [kits]);

  const openCreate = () => {
    setEditingKit(null);
    // Default new kits to the current filter's sub-brand when one is selected.
    const preselect =
      filterSubBrand === "__all__" || filterSubBrand === "__none__"
        ? "__none__"
        : filterSubBrand;
    setForm({ ...EMPTY_FORM, subBrand: preselect });
    setShowModal(true);
  };

  const openEdit = (kit) => {
    setEditingKit(kit);
    setForm({
      subBrand: kit.subBrand == null ? "__none__" : kit.subBrand,
      logoUrl: kit.logoUrl || "",
      logoDarkUrl: kit.logoDarkUrl || "",
      faviconUrl: kit.faviconUrl || "",
      primaryColor: kit.primaryColor || "#265855",
      secondaryColor: kit.secondaryColor || "#CD9481",
      accentColor: kit.accentColor || "#C89A4E",
      bgColor: kit.bgColor || "#FFFFFF",
      textColor: kit.textColor || "#1A1A1A",
      fontFamily: kit.fontFamily || "",
      fontUrl: kit.fontUrl || "",
      tagline: kit.tagline || "",
      isActive: Boolean(kit.isActive),
      // W4.A G089 — extended fields
      wordmarkUrl: kit.wordmarkUrl || "",
      heroUrl: kit.heroUrl || "",
      successBadge: kit.successBadge || "",
      warningBadge: kit.warningBadge || "",
      headingFontFamily: kit.headingFontFamily || "",
      headingFontUrl: kit.headingFontUrl || "",
      bodyFontFamily: kit.bodyFontFamily || "",
      bodyFontUrl: kit.bodyFontUrl || "",
      codeFontFamily: kit.codeFontFamily || "",
      codeFontUrl: kit.codeFontUrl || "",
      cmykPrimary: kit.cmykPrimary || "",
      cmykSecondary: kit.cmykSecondary || "",
      cmykAccent: kit.cmykAccent || "",
      signatureTemplate: kit.signatureTemplate || "",
      headerImageUrl: kit.headerImageUrl || "",
      footerText: kit.footerText || "",
      invoiceStampUrl: kit.invoiceStampUrl || "",
      missionStatement: kit.missionStatement || "",
      supportEmail: kit.supportEmail || "",
      supportPhone: kit.supportPhone || "",
      socialLinksJson: kit.socialLinksJson || "",
    });
    setShowModal(true);
  };

  const closeModal = () => {
    setShowModal(false);
    setEditingKit(null);
    setForm(EMPTY_FORM);
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    setSaving(true);
    try {
      const payload = {
        // subBrand only sent on create; backend rejects subBrand changes on PUT
        // with SUB_BRAND_IMMUTABLE so don't include it in edit payloads.
        ...(editingKit
          ? {}
          : { subBrand: form.subBrand === "__none__" ? null : form.subBrand }),
        logoUrl: emptyToNull(form.logoUrl),
        logoDarkUrl: emptyToNull(form.logoDarkUrl),
        faviconUrl: emptyToNull(form.faviconUrl),
        primaryColor: emptyToNull(form.primaryColor),
        secondaryColor: emptyToNull(form.secondaryColor),
        accentColor: emptyToNull(form.accentColor),
        bgColor: emptyToNull(form.bgColor),
        textColor: emptyToNull(form.textColor),
        fontFamily: emptyToNull(form.fontFamily),
        fontUrl: emptyToNull(form.fontUrl),
        tagline: emptyToNull(form.tagline),
        isActive: Boolean(form.isActive),
        // W4.A G089 — extended branding fields
        wordmarkUrl: emptyToNull(form.wordmarkUrl),
        heroUrl: emptyToNull(form.heroUrl),
        successBadge: emptyToNull(form.successBadge),
        warningBadge: emptyToNull(form.warningBadge),
        headingFontFamily: emptyToNull(form.headingFontFamily),
        headingFontUrl: emptyToNull(form.headingFontUrl),
        bodyFontFamily: emptyToNull(form.bodyFontFamily),
        bodyFontUrl: emptyToNull(form.bodyFontUrl),
        codeFontFamily: emptyToNull(form.codeFontFamily),
        codeFontUrl: emptyToNull(form.codeFontUrl),
        cmykPrimary: emptyToNull(form.cmykPrimary),
        cmykSecondary: emptyToNull(form.cmykSecondary),
        cmykAccent: emptyToNull(form.cmykAccent),
        signatureTemplate: emptyToNull(form.signatureTemplate),
        headerImageUrl: emptyToNull(form.headerImageUrl),
        footerText: emptyToNull(form.footerText),
        invoiceStampUrl: emptyToNull(form.invoiceStampUrl),
        missionStatement: emptyToNull(form.missionStatement),
        supportEmail: emptyToNull(form.supportEmail),
        supportPhone: emptyToNull(form.supportPhone),
        socialLinksJson: emptyToNull(form.socialLinksJson),
      };
      if (editingKit) {
        await fetchApi(`/api/brand-kits/${editingKit.id}`, {
          method: "PUT",
          body: JSON.stringify(payload),
        });
        notify.success(
          `Brand kit v${editingKit.version} updated (${subBrandLabel(editingKit.subBrand)})`,
        );
      } else {
        await fetchApi("/api/brand-kits", {
          method: "POST",
          body: JSON.stringify(payload),
        });
        notify.success(
          `New brand kit created for ${subBrandLabel(payload.subBrand)}`,
        );
      }
      closeModal();
      load();
    } catch (err) {
      notify.error(err?.body?.error || err?.message || "Save failed");
    } finally {
      setSaving(false);
    }
  };

  const handleActivate = async (kit) => {
    const ok = await notify.confirm(
      `Activate brand kit v${kit.version} for ${subBrandLabel(kit.subBrand)}? The current active version (if any) will be automatically demoted.`,
    );
    if (!ok) return;
    try {
      await fetchApi(`/api/brand-kits/${kit.id}`, {
        method: "PUT",
        body: JSON.stringify({ isActive: true }),
      });
      notify.success(
        `Brand kit v${kit.version} is now active for ${subBrandLabel(kit.subBrand)}`,
      );
      load();
    } catch (err) {
      notify.error(err?.body?.error || err?.message || "Activation failed");
    }
  };

  const handleDelete = async (kit) => {
    if (kit.isActive) {
      // Backend will return 422 ACTIVE_KIT_LOCKED — short-circuit client-side
      // with the same message so the user doesn't see a confirm-then-error.
      notify.error(
        "Cannot delete an active brand kit. Activate a different version first.",
      );
      return;
    }
    const ok = await notify.confirm(
      `Delete brand kit v${kit.version} for ${subBrandLabel(kit.subBrand)}? This cannot be undone.`,
    );
    if (!ok) return;
    try {
      await fetchApi(`/api/brand-kits/${kit.id}`, { method: "DELETE" });
      notify.success(`Brand kit v${kit.version} deleted`);
      load();
    } catch (err) {
      notify.error(err?.body?.error || err?.message || "Delete failed");
    }
  };

  // ── W4.A G099 — extended controls (versions / revert / copy-from / upload) ──

  const [showAdvanced, setShowAdvanced] = useState(false);
  const [versionsKit, setVersionsKit] = useState(null);
  const [versionsList, setVersionsList] = useState([]);
  const [copyFromOpen, setCopyFromOpen] = useState(false);
  const [copyFromAnchor, setCopyFromAnchor] = useState(null);
  const [copyFromSourceId, setCopyFromSourceId] = useState("");
  const fileInputs = useRef({});

  const openVersions = async (kit) => {
    try {
      const res = await fetchApi(`/api/brand-kits/${kit.id}/versions`);
      setVersionsKit(kit);
      setVersionsList(Array.isArray(res?.versions) ? res.versions : []);
    } catch (err) {
      notify.error(err?.body?.error || err?.message || "Failed to load versions");
    }
  };

  const closeVersions = () => {
    setVersionsKit(null);
    setVersionsList([]);
  };

  const handleRevert = async (version) => {
    if (!versionsKit) return;
    const ok = await notify.confirm(
      `Revert to v${version.version}? A new active version will be created copying these assets. The current active version will be demoted.`,
    );
    if (!ok) return;
    try {
      await fetchApi(`/api/brand-kits/${versionsKit.id}/revert/${version.version}`, {
        method: "POST",
      });
      notify.success(`Reverted — new active version copies v${version.version}`);
      closeVersions();
      load();
    } catch (err) {
      notify.error(err?.body?.error || err?.message || "Revert failed");
    }
  };

  const openCopyFrom = (kit) => {
    setCopyFromAnchor(kit);
    setCopyFromSourceId("");
    setCopyFromOpen(true);
  };

  const handleCopyFromSubmit = async () => {
    if (!copyFromAnchor || !copyFromSourceId) return;
    try {
      await fetchApi(
        `/api/brand-kits/${copyFromAnchor.id}/copy-from/${copyFromSourceId}`,
        { method: "POST" },
      );
      notify.success(`Assets copied. A new draft version was created — activate it when ready.`);
      setCopyFromOpen(false);
      setCopyFromAnchor(null);
      setCopyFromSourceId("");
      load();
    } catch (err) {
      notify.error(err?.body?.error || err?.message || "Copy-from failed");
    }
  };

  // Direct upload to /api/brand-kits/upload. Returns the resolved URL or
  // null on failure. Used by the per-field "Upload" buttons next to logo /
  // wordmark / favicon / hero / header / stamp URL inputs.
  const handleUpload = async (fieldKey, assetType, file) => {
    if (!file) return;
    try {
      const fd = new FormData();
      fd.append("file", file);
      fd.append("assetType", assetType);
      if (form.subBrand && form.subBrand !== "__none__") {
        fd.append("subBrand", form.subBrand);
      }
      const token = getAuthToken && getAuthToken();
      const headers = {};
      if (token) headers.Authorization = `Bearer ${token}`;
      const res = await fetch("/api/brand-kits/upload", {
        method: "POST",
        body: fd,
        headers,
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body?.error || `Upload failed (${res.status})`);
      }
      const body = await res.json();
      setForm((f) => ({ ...f, [fieldKey]: body.url }));
      notify.success(`${assetType} uploaded`);
    } catch (err) {
      notify.error(err?.message || "Upload failed");
    }
  };

  // WCAG contrast: text vs background; primary vs background (chip text).
  const wcagTextBg = wcagContrastRatio(form.textColor, form.bgColor);
  const wcagPrimaryBg = wcagContrastRatio(form.primaryColor, form.bgColor);

  return (
    <div style={{ padding: "2rem", height: "100%", overflowY: "auto", animation: "fadeIn 0.4s ease-out" }}>
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
            <Palette size={26} color="var(--primary-color, var(--accent-color))" aria-hidden /> Brand Kits
          </h1>
          <p style={{ color: "var(--text-secondary)", marginTop: 4, fontSize: "0.9rem", maxWidth: 720 }}>
            Per-sub-brand brand assets — logos, colors, fonts, tagline. Active version drives all consumer surfaces.
          </p>
          <p style={{ color: "var(--text-secondary)", marginTop: 4, fontSize: "0.82rem" }}>
            {total.toLocaleString()} brand kit{total === 1 ? "" : "s"} across {subBrandCount} sub-brand{subBrandCount === 1 ? "" : "s"}.
          </p>
        </div>
        <button type="button" onClick={openCreate} style={primaryBtn} data-testid="brand-kits-new-btn">
          <Plus size={14} /> New Brand Kit
        </button>
      </header>

      {/* Filter bar */}
      <div
        className="glass"
        style={{
          padding: 12,
          marginBottom: 16,
          display: "flex",
          alignItems: "center",
          gap: 16,
          flexWrap: "wrap",
        }}
      >
        <select
          value={filterSubBrand}
          onChange={(e) => setFilterSubBrand(e.target.value)}
          style={selectStyle}
          aria-label="Filter by sub-brand"
          data-testid="brand-kits-filter-subbrand"
        >
          {FILTER_SUB_BRANDS.map((s) => (
            <option key={s.value} value={s.value}>{s.label}</option>
          ))}
        </select>
        <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13, color: "var(--text-secondary)", cursor: "pointer" }}>
          <input
            type="checkbox"
            checked={showInactive}
            onChange={(e) => setShowInactive(e.target.checked)}
            data-testid="brand-kits-show-inactive"
          />
          Show inactive versions
        </label>
      </div>

      {loading ? (
        <div className="card" style={{ padding: "3rem", textAlign: "center", color: "var(--text-secondary)" }}>
          Loading brand kits&hellip;
        </div>
      ) : kits.length === 0 ? (
        <div
          className="card"
          style={{
            padding: "3rem 2rem",
            textAlign: "center",
            color: permissionDenied ? "var(--warning-color, #f59e0b)" : "var(--text-secondary)",
          }}
        >
          {permissionDenied ? (
            <>
              <AlertCircle size={28} style={{ opacity: 0.7, marginBottom: 10 }} />
              <div style={{ fontWeight: 600 }}>Access restricted.</div>
              <div style={{ fontSize: "0.9rem", marginTop: "0.5rem", color: "var(--text-secondary)" }}>
                Your role does not have permission to view brand kits. Ask an Admin to grant access.
              </div>
            </>
          ) : (
            <>
              <Palette size={28} style={{ opacity: 0.5, marginBottom: 10 }} />
              <div style={{ fontWeight: 600 }}>No brand kits configured.</div>
              <div style={{ fontSize: "0.9rem", marginTop: "0.5rem" }}>
                Click &quot;+ New Brand Kit&quot; to create the first version for a sub-brand.
              </div>
            </>
          )}
        </div>
      ) : (
        // Two-level layout: per-sub-brand section heading, then card grid
        // of versions within that sub-brand.
        <div style={{ display: "flex", flexDirection: "column", gap: 24 }}>
          {grouped.map(([sbKey, kitList]) => (
            <section key={sbKey}>
              <h2
                style={{
                  fontSize: "1.1rem",
                  fontWeight: 600,
                  margin: "0 0 0.75rem",
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  color: "var(--text-primary)",
                }}
              >
                <span
                  style={{
                    ...brandBadge,
                    background: SUB_BRAND_BG[sbKey] || "rgba(255,255,255,0.08)",
                    padding: "4px 10px",
                    fontSize: 12,
                  }}
                >
                  {sbKey === "__none__" ? "Tenant-wide" : subBrandLabel(sbKey)}
                </span>
                <span style={{ color: "var(--text-secondary)", fontSize: "0.85rem", fontWeight: 400 }}>
                  ({kitList.length} version{kitList.length === 1 ? "" : "s"})
                </span>
              </h2>
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 320px), 1fr))",
                  gap: 16,
                }}
              >
                {kitList.map((kit) => (
                  <BrandKitCard
                    key={kit.id}
                    kit={kit}
                    onActivate={handleActivate}
                    onEdit={openEdit}
                    onDelete={handleDelete}
                    onVersions={openVersions}
                    onCopyFrom={openCopyFrom}
                  />
                ))}
              </div>
            </section>
          ))}
        </div>
      )}

      {/* New / Edit modal */}
      {showModal && (
        <div style={modalOverlay} onClick={closeModal}>
          <div
            style={modalBody}
            onClick={(e) => e.stopPropagation()}
            role="dialog"
            aria-modal="true"
            aria-label={editingKit ? "Edit brand kit" : "New brand kit"}
          >
            <header style={{ marginBottom: 12 }}>
              <h2 style={{ margin: 0, fontSize: "1.25rem", fontWeight: 600 }}>
                {editingKit
                  ? `Edit brand kit v${editingKit.version} — ${subBrandLabel(editingKit.subBrand)}`
                  : "New brand kit"}
              </h2>
              <p style={{ margin: "4px 0 0", fontSize: "0.85rem", color: "var(--text-secondary)" }}>
                {editingKit
                  ? "Sub-brand + version are immutable after create. Changing isActive will atomically demote the prior active version."
                  : "Version is auto-assigned per sub-brand. Activating this version will demote any current active kit for the same sub-brand."}
              </p>
            </header>

            <form onSubmit={handleSubmit} style={{ display: "flex", flexDirection: "column", gap: 14 }}>
              {/* Sub-brand select (read-only on edit) */}
              <div style={fieldRow}>
                <label htmlFor="bk-subbrand" style={labelStyle}>Sub-brand</label>
                <select
                  id="bk-subbrand"
                  value={form.subBrand}
                  onChange={(e) => setForm({ ...form, subBrand: e.target.value })}
                  style={inputStyle}
                  disabled={Boolean(editingKit)}
                  aria-label="Sub-brand"
                >
                  {FORM_SUB_BRANDS.map((s) => (
                    <option key={s.value} value={s.value}>{s.label}</option>
                  ))}
                </select>
                {editingKit && (
                  <small style={hintStyle}>
                    Immutable. To move assets to a different sub-brand, create a new kit there and delete the inactive one here.
                  </small>
                )}
              </div>

              {/* Asset URLs — each pair (URL input + Upload widget) */}
              <UploadableUrlField
                id="bk-logo"
                label="Logo URL"
                placeholder="https://cdn.example.com/logo.png"
                value={form.logoUrl}
                onChange={(v) => setForm({ ...form, logoUrl: v })}
                assetType="logo"
                onUpload={(file) => handleUpload("logoUrl", "logo", file)}
                fileInputRef={fileInputs}
              />
              <UploadableUrlField
                id="bk-logo-dark"
                label="Dark-mode logo URL"
                placeholder="https://cdn.example.com/logo-dark.png"
                value={form.logoDarkUrl}
                onChange={(v) => setForm({ ...form, logoDarkUrl: v })}
                assetType="logo"
                onUpload={(file) => handleUpload("logoDarkUrl", "logo", file)}
                fileInputRef={fileInputs}
              />
              <div style={fieldRow}>
                <label htmlFor="bk-favicon" style={labelStyle}>Favicon URL</label>
                <input
                  id="bk-favicon"
                  type="url"
                  placeholder="https://cdn.example.com/favicon.ico"
                  value={form.faviconUrl}
                  onChange={(e) => setForm({ ...form, faviconUrl: e.target.value })}
                  style={inputStyle}
                />
              </div>

              {/* Color pickers — native input[type=color] is good enough for v1
                  (pre-WCAG-contrast-checker per DD-5.5e future-slice note). */}
              <div>
                <label style={{ ...labelStyle, marginBottom: 6, display: "block" }}>Brand colors</label>
                <div
                  style={{
                    display: "grid",
                    gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 110px), 1fr))",
                    gap: 8,
                  }}
                >
                  {[
                    ["primaryColor", "Primary"],
                    ["secondaryColor", "Secondary"],
                    ["accentColor", "Accent"],
                    ["bgColor", "Background"],
                    ["textColor", "Text"],
                  ].map(([key, label]) => (
                    <ColorPickerField
                      key={key}
                      id={`bk-color-${key}`}
                      label={label}
                      value={form[key] || "#000000"}
                      onChange={(v) => setForm({ ...form, [key]: v })}
                    />
                  ))}
                </div>
              </div>

              {/* Font */}
              <div style={fieldRow}>
                <label htmlFor="bk-font-family" style={labelStyle}>Font family (CSS value)</label>
                <input
                  id="bk-font-family"
                  type="text"
                  placeholder="Inter, system-ui, sans-serif"
                  value={form.fontFamily}
                  onChange={(e) => setForm({ ...form, fontFamily: e.target.value })}
                  style={inputStyle}
                />
              </div>
              <div style={fieldRow}>
                <label htmlFor="bk-font-url" style={labelStyle}>Font URL (CSS @import / WOFF2)</label>
                <input
                  id="bk-font-url"
                  type="url"
                  placeholder="https://fonts.googleapis.com/css2?family=Inter"
                  value={form.fontUrl}
                  onChange={(e) => setForm({ ...form, fontUrl: e.target.value })}
                  style={inputStyle}
                />
              </div>

              {/* Tagline */}
              <div style={fieldRow}>
                <label htmlFor="bk-tagline" style={labelStyle}>Tagline</label>
                <textarea
                  id="bk-tagline"
                  rows={2}
                  placeholder="Where every journey begins"
                  value={form.tagline}
                  onChange={(e) => setForm({ ...form, tagline: e.target.value })}
                  style={{ ...inputStyle, resize: "vertical", minHeight: 60 }}
                />
              </div>

              {/* WCAG contrast checker — W4.A G099 (FR-3.5.e) */}
              <div
                className="card"
                data-testid="brand-kits-wcag-checker"
                style={{
                  padding: 10,
                  background: "rgba(255,255,255,0.04)",
                  border: "1px solid var(--border-color)",
                }}
              >
                <div style={{ fontWeight: 600, fontSize: 13, marginBottom: 6 }}>WCAG contrast</div>
                <WcagRow label="Text vs Background" ratio={wcagTextBg} />
                <WcagRow label="Primary vs Background" ratio={wcagPrimaryBg} />
              </div>

              {/* Live preview pane — W4.A G099 (FR-3.2.f) */}
              <LivePreview form={form} />

              {/* Advanced fields — W4.A G089 (FR-3.1.a-g) */}
              <div>
                <button
                  type="button"
                  onClick={() => setShowAdvanced((v) => !v)}
                  data-testid="brand-kits-advanced-toggle"
                  style={{
                    ...secondaryBtn,
                    padding: "6px 8px",
                    fontSize: 12,
                    width: "100%",
                    justifyContent: "flex-start",
                  }}
                >
                  {showAdvanced ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                  Advanced branding fields (wordmark / hero / typography slots / CMYK / signature / footer / mission / social)
                </button>
                {showAdvanced && (
                  <div
                    style={{ display: "flex", flexDirection: "column", gap: 10, marginTop: 10 }}
                    data-testid="brand-kits-advanced-section"
                  >
                    <UploadableUrlField
                      id="bk-wordmark"
                      label="Wordmark URL"
                      placeholder="https://cdn.example.com/wordmark.svg"
                      value={form.wordmarkUrl}
                      onChange={(v) => setForm({ ...form, wordmarkUrl: v })}
                      assetType="wordmark"
                      onUpload={(file) => handleUpload("wordmarkUrl", "wordmark", file)}
                      fileInputRef={fileInputs}
                    />
                    <UploadableUrlField
                      id="bk-hero"
                      label="Hero image URL (1:1 to 3:1 aspect)"
                      placeholder="https://cdn.example.com/hero.jpg"
                      value={form.heroUrl}
                      onChange={(v) => setForm({ ...form, heroUrl: v })}
                      assetType="hero"
                      onUpload={(file) => handleUpload("heroUrl", "hero", file)}
                      fileInputRef={fileInputs}
                    />
                    <UploadableUrlField
                      id="bk-header-image"
                      label="Invoice header image URL"
                      placeholder="https://cdn.example.com/header.png"
                      value={form.headerImageUrl}
                      onChange={(v) => setForm({ ...form, headerImageUrl: v })}
                      assetType="headerImage"
                      onUpload={(file) => handleUpload("headerImageUrl", "headerImage", file)}
                      fileInputRef={fileInputs}
                    />
                    <UploadableUrlField
                      id="bk-stamp"
                      label="Invoice stamp URL"
                      placeholder="https://cdn.example.com/stamp.png"
                      value={form.invoiceStampUrl}
                      onChange={(v) => setForm({ ...form, invoiceStampUrl: v })}
                      assetType="stamp"
                      onUpload={(file) => handleUpload("invoiceStampUrl", "stamp", file)}
                      fileInputRef={fileInputs}
                    />
                    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
                      <div style={fieldRow}>
                        <label htmlFor="bk-success-badge" style={labelStyle}>Success badge (hex)</label>
                        <input id="bk-success-badge" type="text" placeholder="#22c55e" value={form.successBadge} onChange={(e) => setForm({ ...form, successBadge: e.target.value })} style={inputStyle} maxLength={9} />
                      </div>
                      <div style={fieldRow}>
                        <label htmlFor="bk-warning-badge" style={labelStyle}>Warning badge (hex)</label>
                        <input id="bk-warning-badge" type="text" placeholder="#f59e0b" value={form.warningBadge} onChange={(e) => setForm({ ...form, warningBadge: e.target.value })} style={inputStyle} maxLength={9} />
                      </div>
                    </div>
                    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
                      <div style={fieldRow}>
                        <label htmlFor="bk-heading-font" style={labelStyle}>Heading font family</label>
                        <input id="bk-heading-font" type="text" placeholder="Cardo, serif" value={form.headingFontFamily} onChange={(e) => setForm({ ...form, headingFontFamily: e.target.value })} style={inputStyle} />
                      </div>
                      <div style={fieldRow}>
                        <label htmlFor="bk-heading-font-url" style={labelStyle}>Heading font URL</label>
                        <input id="bk-heading-font-url" type="url" placeholder="https://fonts.googleapis.com/..." value={form.headingFontUrl} onChange={(e) => setForm({ ...form, headingFontUrl: e.target.value })} style={inputStyle} />
                      </div>
                    </div>
                    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
                      <div style={fieldRow}>
                        <label htmlFor="bk-body-font" style={labelStyle}>Body font family</label>
                        <input id="bk-body-font" type="text" placeholder="Inter, sans-serif" value={form.bodyFontFamily} onChange={(e) => setForm({ ...form, bodyFontFamily: e.target.value })} style={inputStyle} />
                      </div>
                      <div style={fieldRow}>
                        <label htmlFor="bk-body-font-url" style={labelStyle}>Body font URL</label>
                        <input id="bk-body-font-url" type="url" placeholder="https://fonts.googleapis.com/..." value={form.bodyFontUrl} onChange={(e) => setForm({ ...form, bodyFontUrl: e.target.value })} style={inputStyle} />
                      </div>
                    </div>
                    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
                      <div style={fieldRow}>
                        <label htmlFor="bk-code-font" style={labelStyle}>Code font family</label>
                        <input id="bk-code-font" type="text" placeholder="JetBrains Mono" value={form.codeFontFamily} onChange={(e) => setForm({ ...form, codeFontFamily: e.target.value })} style={inputStyle} />
                      </div>
                      <div style={fieldRow}>
                        <label htmlFor="bk-code-font-url" style={labelStyle}>Code font URL</label>
                        <input id="bk-code-font-url" type="url" placeholder="https://fonts.googleapis.com/..." value={form.codeFontUrl} onChange={(e) => setForm({ ...form, codeFontUrl: e.target.value })} style={inputStyle} />
                      </div>
                    </div>
                    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8 }}>
                      <div style={fieldRow}>
                        <label htmlFor="bk-cmyk-primary" style={labelStyle}>CMYK primary</label>
                        <input id="bk-cmyk-primary" type="text" placeholder="C,M,Y,K" value={form.cmykPrimary} onChange={(e) => setForm({ ...form, cmykPrimary: e.target.value })} style={inputStyle} />
                      </div>
                      <div style={fieldRow}>
                        <label htmlFor="bk-cmyk-secondary" style={labelStyle}>CMYK secondary</label>
                        <input id="bk-cmyk-secondary" type="text" placeholder="C,M,Y,K" value={form.cmykSecondary} onChange={(e) => setForm({ ...form, cmykSecondary: e.target.value })} style={inputStyle} />
                      </div>
                      <div style={fieldRow}>
                        <label htmlFor="bk-cmyk-accent" style={labelStyle}>CMYK accent</label>
                        <input id="bk-cmyk-accent" type="text" placeholder="C,M,Y,K" value={form.cmykAccent} onChange={(e) => setForm({ ...form, cmykAccent: e.target.value })} style={inputStyle} />
                      </div>
                    </div>
                    <div style={fieldRow}>
                      <label htmlFor="bk-signature-template" style={labelStyle}>Email signature template (HTML)</label>
                      <textarea id="bk-signature-template" rows={3} placeholder="<p>--<br/>{{name}}<br/>{{email}}</p>" value={form.signatureTemplate} onChange={(e) => setForm({ ...form, signatureTemplate: e.target.value })} style={{ ...inputStyle, resize: "vertical", minHeight: 70, fontFamily: "monospace" }} />
                    </div>
                    <div style={fieldRow}>
                      <label htmlFor="bk-footer-text" style={labelStyle}>Invoice / PDF footer text</label>
                      <textarea id="bk-footer-text" rows={2} placeholder="GST 27ABCDE1234F1Z5 · CIN U63040..." value={form.footerText} onChange={(e) => setForm({ ...form, footerText: e.target.value })} style={{ ...inputStyle, resize: "vertical", minHeight: 50 }} />
                    </div>
                    <div style={fieldRow}>
                      <label htmlFor="bk-mission" style={labelStyle}>Mission statement (portal/microsite)</label>
                      <textarea id="bk-mission" rows={2} placeholder="Empower curriculum-aligned learning journeys" value={form.missionStatement} onChange={(e) => setForm({ ...form, missionStatement: e.target.value })} style={{ ...inputStyle, resize: "vertical", minHeight: 50 }} />
                    </div>
                    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
                      <div style={fieldRow}>
                        <label htmlFor="bk-support-email" style={labelStyle}>Support email</label>
                        <input id="bk-support-email" type="email" placeholder="support@example.com" value={form.supportEmail} onChange={(e) => setForm({ ...form, supportEmail: e.target.value })} style={inputStyle} />
                      </div>
                      <div style={fieldRow}>
                        <label htmlFor="bk-support-phone" style={labelStyle}>Support phone</label>
                        <input id="bk-support-phone" type="tel" placeholder="+91-9999999999" value={form.supportPhone} onChange={(e) => setForm({ ...form, supportPhone: e.target.value })} style={inputStyle} />
                      </div>
                    </div>
                    <div style={fieldRow}>
                      <label htmlFor="bk-social-links" style={labelStyle}>Social links JSON</label>
                      <textarea id="bk-social-links" rows={2} placeholder='[{"network":"instagram","url":"https://ig/..."}]' value={form.socialLinksJson} onChange={(e) => setForm({ ...form, socialLinksJson: e.target.value })} style={{ ...inputStyle, resize: "vertical", minHeight: 50, fontFamily: "monospace" }} />
                    </div>
                  </div>
                )}
              </div>

              {/* Active toggle */}
              <label style={{ display: "flex", alignItems: "flex-start", gap: 10, cursor: "pointer", padding: "8px 0" }}>
                <input
                  type="checkbox"
                  checked={form.isActive}
                  onChange={(e) => setForm({ ...form, isActive: e.target.checked })}
                  style={{ marginTop: 3 }}
                />
                <span>
                  <span style={{ fontSize: 14, fontWeight: 600 }}>Active version</span>
                  {form.isActive && (
                    <span style={{ display: "block", fontSize: 12, color: "var(--warning-color, #f59e0b)", marginTop: 2 }}>
                      Activating this version will demote the current active brand kit for this sub-brand.
                    </span>
                  )}
                </span>
              </label>

              {/* Actions */}
              <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 4 }}>
                <button type="button" onClick={closeModal} style={secondaryBtn} disabled={saving}>
                  Cancel
                </button>
                <button type="submit" style={primaryBtn} disabled={saving}>
                  {saving ? "Saving…" : editingKit ? "Save Changes" : "Create Brand Kit"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* W4.A G099 — Version history modal */}
      {versionsKit && (
        <div style={modalOverlay} onClick={closeVersions} data-testid="brand-kits-versions-modal">
          <div
            style={modalBody}
            onClick={(e) => e.stopPropagation()}
            role="dialog"
            aria-modal="true"
            aria-label="Brand kit version history"
          >
            <header style={{ marginBottom: 12 }}>
              <h2 style={{ margin: 0, fontSize: "1.25rem", fontWeight: 600 }}>
                Version history — {subBrandLabel(versionsKit.subBrand)}
              </h2>
              <p style={{ margin: "4px 0 0", fontSize: "0.85rem", color: "var(--text-secondary)" }}>
                Revert creates a new active version copying the chosen historical shape (non-destructive).
              </p>
            </header>
            {versionsList.length === 0 ? (
              <p style={{ color: "var(--text-secondary)", fontSize: 13 }}>No versions found.</p>
            ) : (
              <ul style={{ listStyle: "none", padding: 0, margin: 0, display: "flex", flexDirection: "column", gap: 8 }}>
                {versionsList.map((v) => (
                  <li
                    key={v.id}
                    style={{
                      padding: 10,
                      border: "1px solid var(--border-color)",
                      borderRadius: 6,
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "space-between",
                      gap: 8,
                    }}
                    data-testid={`brand-kits-version-row-${v.version}`}
                  >
                    <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                      <strong style={{ fontSize: 14 }}>v{v.version}</strong>
                      {v.isActive ? (
                        <span style={activeBadge}>
                          <Check size={11} /> Active
                        </span>
                      ) : (
                        <span style={inactiveBadge}>Inactive</span>
                      )}
                      <small style={{ color: "var(--text-secondary)", fontSize: 11 }}>
                        {v.updatedAt ? new Date(v.updatedAt).toLocaleString() : ""}
                      </small>
                    </div>
                    <button
                      type="button"
                      onClick={() => handleRevert(v)}
                      style={{ ...primaryBtn, padding: "4px 8px", fontSize: 11 }}
                      data-testid={`brand-kits-revert-${v.version}`}
                      disabled={v.isActive}
                      title={v.isActive ? "This is the active version" : `Revert to v${v.version}`}
                    >
                      Revert
                    </button>
                  </li>
                ))}
              </ul>
            )}
            <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 12 }}>
              <button type="button" onClick={closeVersions} style={secondaryBtn}>
                Close
              </button>
            </div>
          </div>
        </div>
      )}

      {/* W4.A G099 — Copy-from-sub-brand modal */}
      {copyFromOpen && copyFromAnchor && (
        <div
          style={modalOverlay}
          onClick={() => setCopyFromOpen(false)}
          data-testid="brand-kits-copy-from-modal"
        >
          <div
            style={modalBody}
            onClick={(e) => e.stopPropagation()}
            role="dialog"
            aria-modal="true"
            aria-label="Copy assets from another brand kit"
          >
            <header style={{ marginBottom: 12 }}>
              <h2 style={{ margin: 0, fontSize: "1.25rem", fontWeight: 600 }}>
                Copy assets — {subBrandLabel(copyFromAnchor.subBrand)}
              </h2>
              <p style={{ margin: "4px 0 0", fontSize: "0.85rem", color: "var(--text-secondary)" }}>
                Pick a source brand kit. A new draft version will be created copying its asset fields.
                You can preview and activate it from the card grid.
              </p>
            </header>
            <div style={fieldRow}>
              <label htmlFor="bk-copy-source" style={labelStyle}>Source brand kit</label>
              <select
                id="bk-copy-source"
                value={copyFromSourceId}
                onChange={(e) => setCopyFromSourceId(e.target.value)}
                style={inputStyle}
                data-testid="brand-kits-copy-from-source"
              >
                <option value="">— Select a source —</option>
                {kits
                  .filter((k) => k.id !== copyFromAnchor.id)
                  .map((k) => (
                    <option key={k.id} value={k.id}>
                      {subBrandLabel(k.subBrand)} v{k.version}{k.isActive ? " (active)" : ""}
                    </option>
                  ))}
              </select>
            </div>
            <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 12 }}>
              <button type="button" onClick={() => setCopyFromOpen(false)} style={secondaryBtn}>
                Cancel
              </button>
              <button
                type="button"
                onClick={handleCopyFromSubmit}
                style={primaryBtn}
                disabled={!copyFromSourceId}
                data-testid="brand-kits-copy-from-submit"
              >
                Copy assets
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ── W4.A G099 — UI helper subcomponents ────────────────────────────────

function UploadableUrlField({ id, label, placeholder, value, onChange, onUpload, fileInputRef }) {
  const inputId = `${id}-file`;
  return (
    <div style={fieldRow}>
      <label htmlFor={id} style={labelStyle}>{label}</label>
      <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
        <input
          id={id}
          type="url"
          placeholder={placeholder}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          style={{ ...inputStyle, flex: 1 }}
        />
        <input
          ref={(el) => {
            if (fileInputRef && fileInputRef.current) fileInputRef.current[id] = el;
          }}
          id={inputId}
          type="file"
          accept="image/png,image/jpeg,image/webp,image/svg+xml,image/x-icon"
          style={{ display: "none" }}
          onChange={(e) => onUpload(e.target.files && e.target.files[0])}
          data-testid={`brand-kits-upload-input-${id}`}
        />
        <button
          type="button"
          onClick={() => {
            const el = fileInputRef && fileInputRef.current && fileInputRef.current[id];
            if (el) el.click();
          }}
          style={{ ...secondaryBtn, padding: "6px 10px", fontSize: 12 }}
          data-testid={`brand-kits-upload-btn-${id}`}
          title={`Upload ${label}`}
        >
          <Upload size={12} /> Upload
        </button>
      </div>
    </div>
  );
}

function WcagRow({ label, ratio }) {
  const display = ratio == null ? "n/a" : ratio.toFixed(2) + ":1";
  let status = "n/a";
  let color = "var(--text-secondary)";
  if (ratio != null) {
    if (ratio >= 7) {
      status = "AAA";
      color = "#22c55e";
    } else if (ratio >= 4.5) {
      status = "AA";
      color = "#22c55e";
    } else if (ratio >= 3) {
      status = "AA large only";
      color = "#f59e0b";
    } else {
      status = "Fail";
      color = "#f43f5e";
    }
  }
  return (
    <div
      style={{ display: "flex", alignItems: "center", justifyContent: "space-between", fontSize: 12, gap: 8 }}
      data-testid={`brand-kits-wcag-${label.replace(/\s+/g, "-").toLowerCase()}`}
    >
      <span style={{ color: "var(--text-secondary)" }}>{label}</span>
      <span>
        <span style={{ marginRight: 8 }}>{display}</span>
        <span style={{ color, fontWeight: 600 }}>{status}</span>
      </span>
    </div>
  );
}

function LivePreview({ form }) {
  const fontStack = form.fontFamily || form.bodyFontFamily || "system-ui, sans-serif";
  const headingStack = form.headingFontFamily || fontStack;
  return (
    <div
      data-testid="brand-kits-live-preview"
      style={{
        border: "1px solid var(--border-color)",
        borderRadius: 8,
        padding: 0,
        overflow: "hidden",
        background: form.bgColor || "#fff",
        color: form.textColor || "#1a1a1a",
        fontFamily: fontStack,
      }}
    >
      <div
        style={{
          padding: "10px 14px",
          background: form.primaryColor || "#265855",
          color: "#fff",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
        }}
      >
        <strong style={{ fontFamily: headingStack, fontSize: 13 }}>
          {form.tagline || "Brand preview"}
        </strong>
        {form.supportEmail && (
          <span style={{ fontSize: 11, opacity: 0.85 }}>{form.supportEmail}</span>
        )}
      </div>
      <div style={{ padding: 12, fontSize: 13 }}>
        <p style={{ margin: "0 0 8px", fontFamily: headingStack, fontSize: 14, fontWeight: 600 }}>
          Sample heading
        </p>
        <p style={{ margin: "0 0 10px" }}>
          The quick brown fox jumps over the lazy dog.
        </p>
        <button
          type="button"
          style={{
            background: form.primaryColor || "#265855",
            color: "#fff",
            border: "none",
            padding: "6px 12px",
            borderRadius: 4,
            fontSize: 12,
            cursor: "default",
          }}
        >
          Call to action
        </button>
        {form.footerText && (
          <p style={{ margin: "10px 0 0", fontSize: 11, color: form.textColor || "var(--text-secondary)" }}>
            {form.footerText}
          </p>
        )}
      </div>
    </div>
  );
}

/* ────────────────────────────────────────────────────────────────────────
 * Card subcomponent — the visual summary of one BrandKit row.
 * ──────────────────────────────────────────────────────────────────────── */
function BrandKitCard({ kit, onActivate, onEdit, onDelete, onVersions, onCopyFrom }) {
  const swatches = [
    ["primary", kit.primaryColor],
    ["secondary", kit.secondaryColor],
    ["accent", kit.accentColor],
    ["bg", kit.bgColor],
    ["text", kit.textColor],
  ];
  return (
    <div
      className="card"
      style={{
        padding: 16,
        display: "flex",
        flexDirection: "column",
        gap: 10,
        border: kit.isActive ? "1px solid var(--primary-color, var(--accent-color))" : "1px solid var(--border-color)",
      }}
      data-testid={`brand-kit-card-${kit.id}`}
    >
      {/* Header — version + active badge */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
        <strong style={{ fontSize: "1rem" }}>Version {kit.version}</strong>
        {kit.isActive ? (
          <span style={activeBadge}>
            <Check size={11} /> Active
          </span>
        ) : (
          <span style={inactiveBadge}>Inactive</span>
        )}
      </div>

      {/* Logo preview */}
      <div
        style={{
          background: kit.bgColor || "rgba(255,255,255,0.04)",
          border: "1px solid var(--border-color)",
          borderRadius: 6,
          padding: 10,
          minHeight: 64,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        {kit.logoUrl ? (
          <img
            src={kit.logoUrl}
            alt={`Logo for ${subBrandLabel(kit.subBrand)} v${kit.version}`}
            style={{ maxHeight: 48, maxWidth: "100%", objectFit: "contain" }}
            onError={(e) => {
              e.currentTarget.style.display = "none";
            }}
          />
        ) : (
          <span style={{ color: "var(--text-secondary)", fontSize: 12, fontStyle: "italic" }}>
            No logo
          </span>
        )}
      </div>

      {/* Color swatches */}
      <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
        {swatches.map(([name, value]) => (
          <div
            key={name}
            title={`${name}: ${value || "(unset)"}`}
            style={{
              width: 28,
              height: 28,
              borderRadius: 4,
              background: value || "transparent",
              border: "1px solid var(--border-color)",
            }}
            aria-label={`${name} color ${value || "unset"}`}
          />
        ))}
      </div>

      {/* Font preview */}
      {kit.fontFamily ? (
        <div
          style={{
            fontFamily: kit.fontFamily,
            fontSize: 14,
            color: kit.textColor || "var(--text-primary)",
            padding: "4px 0",
          }}
        >
          The quick brown fox
        </div>
      ) : (
        <div style={{ fontSize: 12, color: "var(--text-secondary)", fontStyle: "italic" }}>
          No font set
        </div>
      )}

      {/* Tagline */}
      {kit.tagline && (
        <div style={{ fontSize: 13, fontStyle: "italic", color: "var(--text-secondary)" }}>
          &ldquo;{kit.tagline}&rdquo;
        </div>
      )}

      {/* Actions */}
      <div style={{ display: "flex", gap: 6, marginTop: "auto", paddingTop: 8, flexWrap: "wrap" }}>
        {!kit.isActive && (
          <button
            type="button"
            onClick={() => onActivate(kit)}
            style={{ ...primaryBtn, padding: "6px 10px", fontSize: 12 }}
            data-testid={`brand-kit-activate-${kit.id}`}
          >
            <Check size={12} /> Activate
          </button>
        )}
        <button
          type="button"
          onClick={() => onEdit(kit)}
          style={{ ...secondaryBtn, padding: "6px 10px", fontSize: 12 }}
          title={`Edit version ${kit.version}`}
          aria-label={`Edit version ${kit.version}`}
          data-testid={`brand-kit-edit-${kit.id}`}
        >
          <Pencil size={12} /> Edit
        </button>
        <button
          type="button"
          onClick={() => onDelete(kit)}
          disabled={kit.isActive}
          title={kit.isActive ? "Active versions cannot be deleted. Activate a different version first." : `Delete version ${kit.version}`}
          aria-label={kit.isActive ? `Cannot delete active version ${kit.version}` : `Delete version ${kit.version}`}
          style={{
            ...secondaryBtn,
            padding: "6px 10px",
            fontSize: 12,
            color: kit.isActive ? "var(--text-secondary)" : "var(--danger-color, #f43f5e)",
            opacity: kit.isActive ? 0.5 : 1,
            cursor: kit.isActive ? "not-allowed" : "pointer",
          }}
          data-testid={`brand-kit-delete-${kit.id}`}
        >
          <Trash2 size={12} /> Delete
        </button>
        <button
          type="button"
          onClick={() => onVersions(kit)}
          style={{ ...secondaryBtn, padding: "6px 10px", fontSize: 12 }}
          data-testid={`brand-kit-versions-${kit.id}`}
          title={`View version history for ${subBrandLabel(kit.subBrand)}`}
        >
          <History size={12} /> Versions
        </button>
        <button
          type="button"
          onClick={() => onCopyFrom(kit)}
          style={{ ...secondaryBtn, padding: "6px 10px", fontSize: 12 }}
          data-testid={`brand-kit-copy-from-${kit.id}`}
          title="Copy assets from another sub-brand's kit"
        >
          <CopyIcon size={12} /> Copy from
        </button>
      </div>
    </div>
  );
}

function ColorPickerField({ id, label, value, onChange }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      <label htmlFor={id} style={{ fontSize: 11, color: "var(--text-secondary)" }}>
        {label}
      </label>
      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
        <input
          id={id}
          type="color"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          style={{
            width: 36,
            height: 32,
            border: "1px solid var(--border-color)",
            borderRadius: 4,
            cursor: "pointer",
            padding: 2,
            background: "transparent",
          }}
          aria-label={`${label} color picker`}
        />
        <input
          type="text"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          style={{ ...inputStyle, padding: "4px 6px", fontSize: 12, fontFamily: "monospace" }}
          aria-label={`${label} color hex value`}
          maxLength={9}
        />
      </div>
    </div>
  );
}

/* ────────────────────────────────────────────────────────────────────────
 * Styles
 * ──────────────────────────────────────────────────────────────────────── */
const inputStyle = {
  padding: "8px 10px",
  borderRadius: 6,
  border: "1px solid var(--border-color)",
  background: "var(--bg-color, rgba(255,255,255,0.05))",
  color: "var(--text-primary)",
  fontSize: 13,
  outline: "none",
  width: "100%",
  boxSizing: "border-box",
};
const selectStyle = {
  padding: "6px 10px",
  borderRadius: 6,
  border: "1px solid var(--border-color)",
  background: "var(--surface-color)",
  color: "var(--text-primary)",
  minWidth: 200,
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
const activeBadge = {
  display: "inline-flex",
  alignItems: "center",
  gap: 4,
  padding: "2px 8px",
  borderRadius: 999,
  background: "rgba(34, 197, 94, 0.18)",
  color: "#22c55e",
  border: "1px solid #22c55e",
  fontSize: 11,
  fontWeight: 600,
  textTransform: "uppercase",
  letterSpacing: 0.4,
};
const inactiveBadge = {
  display: "inline-block",
  padding: "2px 8px",
  borderRadius: 999,
  background: "rgba(120, 120, 120, 0.18)",
  color: "var(--text-secondary)",
  border: "1px solid rgba(160,160,160,0.4)",
  fontSize: 11,
  fontWeight: 600,
  textTransform: "uppercase",
  letterSpacing: 0.4,
};
const fieldRow = { display: "flex", flexDirection: "column", gap: 4 };
const labelStyle = { fontSize: 12, color: "var(--text-secondary)", fontWeight: 600 };
const hintStyle = { fontSize: 11, color: "var(--text-secondary)", fontStyle: "italic", marginTop: 2 };
const modalOverlay = {
  position: "fixed",
  inset: 0,
  background: "rgba(0,0,0,0.55)",
  display: "flex",
  alignItems: "flex-start",
  justifyContent: "center",
  padding: "5vh 1rem 2rem",
  zIndex: 1000,
  overflowY: "auto",
};
const modalBody = {
  background: "var(--surface-color, #1a1f2e)",
  borderRadius: 10,
  border: "1px solid var(--border-color)",
  padding: 20,
  maxWidth: 640,
  width: "100%",
  boxShadow: "0 20px 60px rgba(0,0,0,0.5)",
};
