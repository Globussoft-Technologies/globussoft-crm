// Travel CRM — Commission Profiles admin page.
//
// PRD_TRAVEL_B2B_AGENT_PORTAL #905 slice 3 — operator-facing CRUD UI for
// TravelCommissionProfile rows. Profiles capture named agent-payout
// shapes (flat_percent / tiered / per_pax_flat / hybrid) consumed by the
// agentCommissionCalculator lib (slice 1 commit cb284098).
//
// Consumes the CRUD backend shipped in slice 2 (commit b5042743):
//   GET    /api/travel/commission-profiles                — list (filters: subBrand / profileType / isActive)
//   GET    /api/travel/commission-profiles/:id            — fetch one
//   POST   /api/travel/commission-profiles                — ADMIN/MANAGER create
//   PUT    /api/travel/commission-profiles/:id            — ADMIN/MANAGER partial update
//   DELETE /api/travel/commission-profiles/:id            — ADMIN-only hard delete (204)
//
// Body shape posted:
//   { name, subBrand, profileType, profileJson: JSON.stringify(profile), notes }
// profileJson stays a stringified blob on the wire (the backend column is
// @db.Text holding the JSON shape so the 4 calculator types can evolve
// without schema migration).
//
// Slice scope:
//   - List table with sub-brand + isActive filters
//   - Modal create / edit with type-conditional sub-form
//   - flat_percent → percent input (0-100)
//   - per_pax_flat → amountPerPax (number)
//   - hybrid → baseAmount + thresholdAmount + overagePercent
//   - tiered → dynamic list of {uptoCents, percent} rows + "Add tier"
//   - Edit pre-fills by JSON.parse-ing the row's profileJson string
//   - Delete uses notify.confirm
//
// Sidebar wire-in is a SEPARATE slice (deferred per slice-prompt).
//
// Slice 8 extension — Preview Calculator panel:
//   Each row gains a Calculator-icon button next to Edit. Clicking opens a
//   what-if panel above the table: operator enters sale amount + pax count,
//   hits "Calculate", and the panel POSTs to /commission-profiles/:id/preview
//   (slice 7, commit 52f4d53d). The server response carries
//   { commission, breakdown, ... } which we render inline — commission as
//   the large success-coloured number, breakdown as a monospace diagnostic
//   line. Lets operators sanity-check "if I sell this Umrah package at ₹2.5L,
//   what does the agent earn?" before committing to a profile assignment
//   (slice 6) or persisting a real invoice line item.
//
// Slice 10 extension — Ledger panel:
//   Each row gains a List-icon button. Clicking opens a ledger panel above
//   the table that GETs /commission-profiles/:id/ledger (slice 9, commit
//   e04c0990). Renders one row per Deal whose Contact carries this profile
//   in commissionProfileId (slice 6 bulk-assign writes that link). Columns:
//   deal id, contact name, deal value, computed commission, stage, createdAt.
//   A summary tile up top surfaces total entries + total commission (sum from
//   the server, half-up rounded to 2dp). A "Won only" toggle chip re-fetches
//   with ?stage=won. Empty / loading / 403 / error states all handled.
//   Lets operators verify "for this profile, what has each agent actually
//   earned so far?" without dropping into Deals/Contacts and aggregating
//   client-side (a structural-bug class — see CLAUDE.md standing rules).
//
// Slice 12 extension — Download CSV (this slice):
//   Ledger-panel header gains a "Download CSV" button that hits the slice-11
//   endpoint GET /commission-profiles/:id/ledger.csv (commit 75ac8390).
//   Carries the current `?stage=` filter so what the operator sees on screen
//   matches what they download. Uses the canonical Blob → createObjectURL →
//   anchor.click() pattern (cloned verbatim from Products.jsx CSV export so
//   the FE has one consistent download flow). The endpoint streams text/csv
//   server-side with a Content-Disposition filename; we override with our
//   own `<profileName>-ledger-<date>.csv` so it's friendlier when 5+ files
//   pile up in the operator's Downloads folder. fetch (not fetchApi) is used
//   because fetchApi auto-parses JSON; the CSV response is a Blob.
//
// Template: pattern-matched against SuppliersAdmin / FlyerTemplates / QuotesAdmin.

import { useEffect, useState, useContext } from "react";
import { Percent, Plus, Pencil, Trash2, Calculator, List, Download } from "lucide-react";
import { fetchApi, getAuthToken } from "../../utils/api";
import TopScrollSync from "../../components/TopScrollSync";
import { useNotify } from "../../utils/notify";
import {
  SUB_BRAND_BG,
  accessibleSubBrands,
  defaultSubBrandFor,
  subBrandShortLabel,
} from "../../utils/travelSubBrand";
import { useActiveSubBrand } from "../../utils/subBrand";
// Branding Wave 4 G102: per-sub-brand brand-kit lookup for primary CTA tint.
import { useBrandKit, brandPrimaryColor } from "../../hooks/useBrandKit";
import { AuthContext } from "../../App";

const SUB_BRANDS = [
  { value: "", label: "All sub-brands" },
  { value: "tmc", label: "TMC (schools)" },
  { value: "rfu", label: "RFU (Umrah)" },
  { value: "travelstall", label: "Travel Stall" },
  { value: "visasure", label: "Visa Sure" },
];

// Profile-type whitelist mirror — kept in lockstep with the backend
// VALID_PROFILE_TYPES constant in routes/travel_commission_profiles.js.
// If the backend grows another type, this list grows here too.
const PROFILE_TYPES = [
  { value: "flat_percent", label: "Flat %" },
  { value: "tiered", label: "Tiered" },
  { value: "per_pax_flat", label: "Per-pax flat" },
  { value: "hybrid", label: "Hybrid" },
];

// Style hint for the profile-type column badge.
const PROFILE_TYPE_BADGE_BG = {
  flat_percent: "rgba(34, 197, 94, 0.18)",
  tiered: "rgba(59, 130, 246, 0.18)",
  per_pax_flat: "rgba(245, 158, 11, 0.18)",
  hybrid: "rgba(168, 85, 247, 0.18)",
};

const EMPTY_FORM = {
  name: "",
  subBrand: "",
  profileType: "flat_percent",
  notes: "",
  // type-specific sub-form fields — only the relevant subset is consumed
  // when building profileJson at submit time. Strings throughout for
  // controlled-input ergonomics; coerced at the build step.
  percent: "",
  amountPerPax: "",
  baseAmount: "",
  thresholdAmount: "",
  overagePercent: "",
  tiers: [{ uptoCents: "", percent: "" }],
};

// Build the {profileType-specific} profileJson body. Returns null + emits a
// notify.error string when the shape is invalid (e.g. unparseable number).
// Per slice-prompt: percent=0 is a LEGITIMATE profile (operator may zero out
// commission temporarily) — only NaN / negative / non-finite gets rejected.
function buildProfileJson(form, notifyErr) {
  switch (form.profileType) {
    case "flat_percent": {
      const p = Number(form.percent);
      if (!Number.isFinite(p) || p < 0 || p > 100) {
        notifyErr("Percent must be a number between 0 and 100");
        return null;
      }
      return { percent: p };
    }
    case "per_pax_flat": {
      const a = Number(form.amountPerPax);
      if (!Number.isFinite(a) || a < 0) {
        notifyErr("Amount per pax must be a non-negative number");
        return null;
      }
      return { amountPerPax: a };
    }
    case "hybrid": {
      const base = Number(form.baseAmount);
      const thr = Number(form.thresholdAmount);
      const overage = Number(form.overagePercent);
      if (!Number.isFinite(base) || base < 0) {
        notifyErr("Base amount must be a non-negative number");
        return null;
      }
      if (!Number.isFinite(thr) || thr < 0) {
        notifyErr("Threshold amount must be a non-negative number");
        return null;
      }
      if (!Number.isFinite(overage) || overage < 0 || overage > 100) {
        notifyErr("Overage percent must be between 0 and 100");
        return null;
      }
      return {
        baseAmount: base,
        thresholdAmount: thr,
        overagePercent: overage,
      };
    }
    case "tiered": {
      const tiers = [];
      for (const row of form.tiers || []) {
        // Allow blank rows to be ignored (operator may have left an empty
        // row from clicking "Add tier" but never filled it in).
        if (
          (row.uptoCents === "" || row.uptoCents == null) &&
          (row.percent === "" || row.percent == null)
        ) {
          continue;
        }
        const upto = Number(row.uptoCents);
        const pct = Number(row.percent);
        if (!Number.isFinite(upto) || upto < 0) {
          notifyErr("Each tier's 'upto' must be a non-negative number");
          return null;
        }
        if (!Number.isFinite(pct) || pct < 0 || pct > 100) {
          notifyErr("Each tier's percent must be between 0 and 100");
          return null;
        }
        tiers.push({ uptoCents: upto, percent: pct });
      }
      if (tiers.length === 0) {
        notifyErr("At least one tier is required");
        return null;
      }
      return { tiers };
    }
    default:
      notifyErr("Unknown profile type");
      return null;
  }
}

// Parse an existing profileJson string back into the form's flat fields so
// edit pre-fill works. Defensive — partial / malformed JSON yields blank
// fields rather than throwing.
function parseProfileJsonForForm(profileType, raw) {
  let parsed = {};
  if (typeof raw === "string" && raw) {
    try {
      parsed = JSON.parse(raw);
    } catch (_e) {
      parsed = {};
    }
  } else if (raw && typeof raw === "object") {
    parsed = raw;
  }
  const out = {
    percent: "",
    amountPerPax: "",
    baseAmount: "",
    thresholdAmount: "",
    overagePercent: "",
    tiers: [{ uptoCents: "", percent: "" }],
  };
  if (profileType === "flat_percent" && parsed.percent != null) {
    out.percent = String(parsed.percent);
  } else if (profileType === "per_pax_flat" && parsed.amountPerPax != null) {
    out.amountPerPax = String(parsed.amountPerPax);
  } else if (profileType === "hybrid") {
    if (parsed.baseAmount != null) out.baseAmount = String(parsed.baseAmount);
    if (parsed.thresholdAmount != null) out.thresholdAmount = String(parsed.thresholdAmount);
    if (parsed.overagePercent != null) out.overagePercent = String(parsed.overagePercent);
  } else if (profileType === "tiered" && Array.isArray(parsed.tiers) && parsed.tiers.length > 0) {
    out.tiers = parsed.tiers.map((t) => ({
      uptoCents: t.uptoCents != null ? String(t.uptoCents) : "",
      percent: t.percent != null ? String(t.percent) : "",
    }));
  }
  return out;
}

export default function CommissionProfilesAdmin() {
  const notify = useNotify();
  const { user } = useContext(AuthContext) || {};
  const { activeSubBrand } = useActiveSubBrand();
  // G102: BrandKit lookup for primary-CTA tint.
  const { brandKit } = useBrandKit(activeSubBrand);
  const primaryBtnBranded = { ...primaryBtn, background: brandPrimaryColor(brandKit) };
  const canWrite = user?.role === "ADMIN" || user?.role === "MANAGER";
  const canDelete = user?.role === "ADMIN";

  // Sub-brand access scoping (mirrors Leads.jsx). myBrands = the sub-brands
  // this user may act on (ADMIN → all 4; restricted user → their granted
  // subset). lockedBrand is non-null only when the user is pinned to exactly
  // one brand — in that case the create/edit form renders a read-only field
  // instead of a free dropdown.
  const myBrands = accessibleSubBrands(user);
  const lockedBrand = myBrands.length === 1 ? myBrands[0] : null;

  const [profiles, setProfiles] = useState([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [permissionDenied, setPermissionDenied] = useState(false);

  const [subBrandFilter, setSubBrandFilter] = useState("");
  const [activeOnly, setActiveOnly] = useState(true);

  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState(null);
  const [form, setForm] = useState(EMPTY_FORM);
  const [saving, setSaving] = useState(false);

  // Preview-calculator panel state (slice 8). Open when previewingProfile is
  // non-null. `previewForm` captures the operator-entered sale amount + pax
  // count; `previewResult` holds the server's calculated commission +
  // breakdown after a successful POST /:id/preview. `previewLoading` gates
  // the button so the operator can't double-fire.
  const [previewingProfile, setPreviewingProfile] = useState(null);
  const [previewForm, setPreviewForm] = useState({ saleAmount: "", paxCount: "1" });
  const [previewResult, setPreviewResult] = useState(null);
  const [previewLoading, setPreviewLoading] = useState(false);

  // Ledger panel state (slice 10). Open when ledgerProfile is non-null.
  // `ledgerData` holds the server's { profileId, entries, totalCommission, ...}
  // payload after a successful GET /:id/ledger. `ledgerLoading` gates the
  // re-fetch chip + initial fetch so the operator can't double-fire while a
  // request is in flight. `ledgerError` surfaces a friendly message when the
  // GET fails (network error, 403, 404 — full body text propagates via the
  // fetchApi reject path).
  const [ledgerProfile, setLedgerProfile] = useState(null);
  const [ledgerData, setLedgerData] = useState(null);
  const [ledgerLoading, setLedgerLoading] = useState(false);
  const [ledgerError, setLedgerError] = useState(null);
  const [ledgerWonOnly, setLedgerWonOnly] = useState(false);
  // Slice 12 — Download CSV in-flight gate so the operator can't double-fire
  // the export endpoint while a download is being assembled.
  const [ledgerCsvBusy, setLedgerCsvBusy] = useState(false);

  const load = () => {
    setLoading(true);
    const qs = new URLSearchParams();
    if (subBrandFilter) qs.set("subBrand", subBrandFilter);
    if (activeOnly) qs.set("isActive", "true");
    const url = `/api/travel/commission-profiles${qs.toString() ? `?${qs.toString()}` : ""}`;
    fetchApi(url)
      .then((d) => {
        setProfiles(Array.isArray(d?.profiles) ? d.profiles : []);
        setTotal(Number.isFinite(d?.total) ? d.total : 0);
        setPermissionDenied(false);
      })
      .catch((err) => {
        setProfiles([]);
        setTotal(0);
        setPermissionDenied(err?.status === 403);
      })
      .finally(() => setLoading(false));
  };

  useEffect(load, [subBrandFilter, activeOnly]);

  const resetForm = () => {
    setForm(EMPTY_FORM);
    setEditingId(null);
  };

  const openCreate = () => {
    // Default the sub-brand to the user's resolved brand (single-brand users
    // → their one brand; multi-brand → active sidebar brand when accessible,
    // else first brand) rather than the EMPTY_FORM blank.
    setForm({ ...EMPTY_FORM, subBrand: defaultSubBrandFor(user, activeSubBrand) });
    setEditingId(null);
    setShowForm(true);
  };

  const openEdit = (p) => {
    const subFields = parseProfileJsonForForm(p.profileType, p.profileJson);
    setForm({
      name: p.name || "",
      subBrand: p.subBrand || "",
      profileType: p.profileType || "flat_percent",
      notes: p.notes || "",
      ...subFields,
    });
    setEditingId(p.id);
    setShowForm(true);
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    const trimmedName = (form.name || "").trim();
    if (!trimmedName) {
      notify.error("Name is required");
      return;
    }
    const profileObj = buildProfileJson(form, notify.error);
    if (profileObj === null) return; // notify.error already fired
    setSaving(true);
    try {
      const payload = {
        name: trimmedName,
        subBrand: form.subBrand || null,
        profileType: form.profileType,
        profileJson: JSON.stringify(profileObj),
        notes: form.notes ? form.notes.trim() || null : null,
      };
      if (editingId) {
        await fetchApi(`/api/travel/commission-profiles/${editingId}`, {
          method: "PUT",
          body: JSON.stringify(payload),
        });
        notify.success(`Profile "${trimmedName}" updated`);
      } else {
        await fetchApi("/api/travel/commission-profiles", {
          method: "POST",
          body: JSON.stringify(payload),
        });
        notify.success(`Profile "${trimmedName}" created`);
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
    const ok = await notify.confirm(
      `Delete commission profile "${p.name}"? This is a hard delete and cannot be undone.`,
    );
    if (!ok) return;
    try {
      await fetchApi(`/api/travel/commission-profiles/${p.id}`, { method: "DELETE" });
      notify.success(`Profile "${p.name}" deleted`);
      load();
    } catch (err) {
      notify.error(err?.body?.error || err?.message || "Delete failed");
    }
  };

  // Open the preview-calculator panel for a row. Resets any prior result so
  // the operator doesn't see stale numbers from a different profile.
  const openPreview = (p) => {
    setPreviewingProfile(p);
    setPreviewForm({ saleAmount: "", paxCount: "1" });
    setPreviewResult(null);
  };

  const closePreview = () => {
    setPreviewingProfile(null);
    setPreviewResult(null);
  };

  // Hit POST /api/travel/commission-profiles/:id/preview with the operator-
  // entered sale amount + paxCount. The backend returns { commission, breakdown,
  // ... } — we render both. paxCount defaults to 1 server-side if omitted, but
  // we always send it so the wire shape is deterministic.
  const handlePreview = async (e) => {
    if (e?.preventDefault) e.preventDefault();
    if (!previewingProfile) return;
    // Reject blank explicitly — Number("") coerces to 0 which would pass the
    // numeric guard but the operator clearly meant "no value entered".
    const rawSale = String(previewForm.saleAmount).trim();
    if (rawSale === "") {
      notify.error("Sale amount must be a non-negative number");
      return;
    }
    const saleNum = Number(rawSale);
    if (!Number.isFinite(saleNum) || saleNum < 0) {
      notify.error("Sale amount must be a non-negative number");
      return;
    }
    const paxNum = Number(previewForm.paxCount);
    if (!Number.isFinite(paxNum) || paxNum < 0 || !Number.isInteger(paxNum)) {
      notify.error("Pax count must be a non-negative integer");
      return;
    }
    setPreviewLoading(true);
    try {
      const result = await fetchApi(
        `/api/travel/commission-profiles/${previewingProfile.id}/preview`,
        {
          method: "POST",
          body: JSON.stringify({ saleAmount: saleNum, paxCount: paxNum }),
        },
      );
      setPreviewResult(result);
    } catch (err) {
      notify.error(err?.body?.error || err?.message || "Preview failed");
      setPreviewResult(null);
    } finally {
      setPreviewLoading(false);
    }
  };

  // Open the ledger panel for a row. Resets stale data + fires the initial
  // fetch. The fetch lives in a separate effect (below) keyed on
  // (ledgerProfile?.id, ledgerWonOnly) so the toggle chip re-fetches without
  // an explicit refetch call site.
  const openLedger = (p) => {
    setLedgerProfile(p);
    setLedgerData(null);
    setLedgerError(null);
    setLedgerWonOnly(false);
  };

  const closeLedger = () => {
    setLedgerProfile(null);
    setLedgerData(null);
    setLedgerError(null);
    setLedgerWonOnly(false);
  };

  // Ledger fetch — re-runs on profile change or stage-toggle change. The
  // GET /:id/ledger contract returns { profileId, profileName, profileType,
  // entries[], totalEntries, totalCommission, limit, offset } per slice 9
  // (commit e04c0990). Errors render as a friendly message inline rather
  // than firing notify.error — the panel is the operator's focus, so the
  // message belongs there, not in a toast.
  useEffect(() => {
    if (!ledgerProfile) return undefined;
    let cancelled = false;
    setLedgerLoading(true);
    setLedgerError(null);
    const qs = new URLSearchParams();
    if (ledgerWonOnly) qs.set("stage", "won");
    const url = `/api/travel/commission-profiles/${ledgerProfile.id}/ledger${
      qs.toString() ? `?${qs.toString()}` : ""
    }`;
    fetchApi(url)
      .then((d) => {
        if (cancelled) return;
        setLedgerData(d || null);
      })
      .catch((err) => {
        if (cancelled) return;
        setLedgerData(null);
        const msg =
          err?.body?.error || err?.message || "Failed to load commission ledger";
        setLedgerError(msg);
      })
      .finally(() => {
        if (!cancelled) setLedgerLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [ledgerProfile, ledgerWonOnly]);

  // Slice 12 — Download the ledger as CSV. Hits the slice-11 export endpoint
  // GET /:id/ledger.csv, mirroring the current `?stage=` filter so the file
  // matches what the operator sees on screen. Uses the canonical Blob →
  // createObjectURL → anchor.click() pattern (Products.jsx is the reference);
  // wraps with try/finally on `ledgerCsvBusy` so repeated clicks are gated.
  const handleLedgerDownload = async () => {
    if (!ledgerProfile || ledgerCsvBusy) return;
    setLedgerCsvBusy(true);
    try {
      const qs = new URLSearchParams();
      if (ledgerWonOnly) qs.set("stage", "won");
      const url = `/api/travel/commission-profiles/${ledgerProfile.id}/ledger.csv${
        qs.toString() ? `?${qs.toString()}` : ""
      }`;
      const token = getAuthToken();
      const res = await fetch(url, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      if (!res.ok) throw new Error(`Export failed (${res.status})`);
      const blob = await res.blob();
      const objectUrl = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = objectUrl;
      // Friendlier filename than the server-supplied Content-Disposition —
      // pivots on profileName + today so multiple files don't collide.
      const safeName = (ledgerProfile.name || "ledger")
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "");
      a.download = `${safeName}-ledger-${new Date().toISOString().slice(0, 10)}.csv`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(objectUrl), 60_000);
      notify.success("Ledger CSV downloaded.");
    } catch (err) {
      notify.error(err?.message || "Ledger CSV export failed.");
    } finally {
      setLedgerCsvBusy(false);
    }
  };

  const addTier = () => {
    setForm((f) => ({
      ...f,
      tiers: [...(f.tiers || []), { uptoCents: "", percent: "" }],
    }));
  };
  const removeTier = (idx) => {
    setForm((f) => {
      const next = (f.tiers || []).filter((_, i) => i !== idx);
      return { ...f, tiers: next.length > 0 ? next : [{ uptoCents: "", percent: "" }] };
    });
  };
  const updateTier = (idx, patch) => {
    setForm((f) => ({
      ...f,
      tiers: (f.tiers || []).map((t, i) => (i === idx ? { ...t, ...patch } : t)),
    }));
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
            <Percent size={26} aria-hidden /> Commission Profiles
          </h1>
          <p style={{ color: "var(--text-secondary)", marginTop: 4, fontSize: "0.9rem" }}>
            Named agent-payout shapes consumed by the commission calculator. {total.toLocaleString()} profile
            {total === 1 ? "" : "s"}.
          </p>
        </div>
        {canWrite && (
          <button
            type="button"
            onClick={openCreate}
            style={primaryBtnBranded}
            aria-label="New profile"
          >
            <Plus size={14} /> New Profile
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
          value={subBrandFilter}
          onChange={(e) => setSubBrandFilter(e.target.value)}
          style={selectStyle}
          aria-label="Filter by sub-brand"
        >
          {SUB_BRANDS.map((s) => (
            <option key={s.value || "all"} value={s.value}>{s.label}</option>
          ))}
        </select>
        <label
          style={{
            display: "flex",
            alignItems: "center",
            gap: 6,
            fontSize: 13,
            color: "var(--text-secondary)",
            cursor: "pointer",
          }}
        >
          <input
            type="checkbox"
            checked={activeOnly}
            onChange={(e) => setActiveOnly(e.target.checked)}
            aria-label="Active profiles only"
          />
          Active only
        </label>
      </div>

      {showForm && (
        <form
          onSubmit={handleSubmit}
          data-testid="commission-profile-form"
          className="glass"
          style={{
            padding: 16,
            marginBottom: 16,
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 220px), 1fr))",
            gap: 10,
            alignItems: "end",
          }}
        >
          <label style={fieldLabel}>
            <span>Profile name *</span>
            <input
              required
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              style={inputStyle}
              aria-label="Profile name"
            />
          </label>
          <label style={fieldLabel}>
            <span>Sub-brand</span>
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
                {myBrands.map((b) => (
                  <option key={b} value={b}>{subBrandShortLabel(b)}</option>
                ))}
              </select>
            )}
          </label>
          <label style={fieldLabel}>
            <span>Profile type</span>
            <select
              value={form.profileType}
              onChange={(e) => setForm({ ...form, profileType: e.target.value })}
              style={inputStyle}
              aria-label="Profile type"
            >
              {PROFILE_TYPES.map((t) => (
                <option key={t.value} value={t.value}>{t.label}</option>
              ))}
            </select>
          </label>

          {/* Conditional sub-form based on profileType.  Each section spans
              the full row so its inputs lay out cleanly under the type
              picker without re-wrapping into adjacent columns. */}
          {form.profileType === "flat_percent" && (
            <label style={{ ...fieldLabel, gridColumn: "1 / -1" }}>
              <span>Commission percent (0-100)</span>
              <input
                type="number"
                min="0"
                max="100"
                step="0.01"
                value={form.percent}
                onChange={(e) => setForm({ ...form, percent: e.target.value })}
                style={inputStyle}
                aria-label="Commission percent"
              />
            </label>
          )}

          {form.profileType === "per_pax_flat" && (
            <label style={{ ...fieldLabel, gridColumn: "1 / -1" }}>
              <span>Amount per pax</span>
              <input
                type="number"
                min="0"
                step="0.01"
                value={form.amountPerPax}
                onChange={(e) => setForm({ ...form, amountPerPax: e.target.value })}
                style={inputStyle}
                aria-label="Amount per pax"
              />
            </label>
          )}

          {form.profileType === "hybrid" && (
            <div
              style={{
                gridColumn: "1 / -1",
                display: "grid",
                gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 200px), 1fr))",
                gap: 10,
              }}
            >
              <label style={fieldLabel}>
                <span>Base amount</span>
                <input
                  type="number"
                  min="0"
                  step="0.01"
                  value={form.baseAmount}
                  onChange={(e) => setForm({ ...form, baseAmount: e.target.value })}
                  style={inputStyle}
                  aria-label="Base amount"
                />
              </label>
              <label style={fieldLabel}>
                <span>Threshold amount</span>
                <input
                  type="number"
                  min="0"
                  step="0.01"
                  value={form.thresholdAmount}
                  onChange={(e) => setForm({ ...form, thresholdAmount: e.target.value })}
                  style={inputStyle}
                  aria-label="Threshold amount"
                />
              </label>
              <label style={fieldLabel}>
                <span>Overage percent (0-100)</span>
                <input
                  type="number"
                  min="0"
                  max="100"
                  step="0.01"
                  value={form.overagePercent}
                  onChange={(e) => setForm({ ...form, overagePercent: e.target.value })}
                  style={inputStyle}
                  aria-label="Overage percent"
                />
              </label>
            </div>
          )}

          {form.profileType === "tiered" && (
            <div
              style={{
                gridColumn: "1 / -1",
                display: "flex",
                flexDirection: "column",
                gap: 8,
              }}
              data-testid="tier-editor"
            >
              <div style={{ fontSize: 12, color: "var(--text-secondary)" }}>
                Tier ladder — sales up to <em>upto</em> earn the row's percent.
              </div>
              {(form.tiers || []).map((tier, idx) => (
                <div
                  key={idx}
                  data-testid={`tier-row-${idx}`}
                  style={{
                    display: "grid",
                    gridTemplateColumns: "1fr 1fr auto",
                    gap: 8,
                    alignItems: "end",
                  }}
                >
                  <label style={fieldLabel}>
                    <span>Tier {idx + 1} — upto</span>
                    <input
                      type="number"
                      min="0"
                      step="1"
                      value={tier.uptoCents}
                      onChange={(e) => updateTier(idx, { uptoCents: e.target.value })}
                      style={inputStyle}
                      aria-label={`Tier ${idx + 1} upto`}
                    />
                  </label>
                  <label style={fieldLabel}>
                    <span>Tier {idx + 1} — percent</span>
                    <input
                      type="number"
                      min="0"
                      max="100"
                      step="0.01"
                      value={tier.percent}
                      onChange={(e) => updateTier(idx, { percent: e.target.value })}
                      style={inputStyle}
                      aria-label={`Tier ${idx + 1} percent`}
                    />
                  </label>
                  <button
                    type="button"
                    onClick={() => removeTier(idx)}
                    style={{ ...iconBtn, color: "var(--danger-color, #f43f5e)" }}
                    title={`Remove tier ${idx + 1}`}
                    aria-label={`Remove tier ${idx + 1}`}
                  >
                    <Trash2 size={15} />
                  </button>
                </div>
              ))}
              <button
                type="button"
                onClick={addTier}
                style={{ ...secondaryBtn, alignSelf: "flex-start" }}
                aria-label="Add tier"
              >
                <Plus size={13} /> Add tier
              </button>
            </div>
          )}

          <label style={{ ...fieldLabel, gridColumn: "1 / -1" }}>
            <span>Notes</span>
            <textarea
              rows={3}
              value={form.notes}
              onChange={(e) => setForm({ ...form, notes: e.target.value })}
              style={{ ...inputStyle, resize: "vertical" }}
              aria-label="Notes"
            />
          </label>

          <div style={{ display: "flex", gap: 8, gridColumn: "1 / -1" }}>
            <button
              type="submit"
              disabled={saving}
              style={{ ...primaryBtn, background: "var(--success-color, var(--primary-color))" }}
            >
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
        </form>
      )}

      {previewingProfile && (
        <form
          onSubmit={handlePreview}
          data-testid="commission-profile-preview-panel"
          className="glass"
          style={{
            padding: 16,
            marginBottom: 16,
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 200px), 1fr))",
            gap: 10,
            alignItems: "end",
          }}
        >
          <div style={{ gridColumn: "1 / -1", display: "flex", alignItems: "center", gap: 8 }}>
            <Calculator size={18} aria-hidden />
            <strong>Preview commission</strong>
            <span style={{ color: "var(--text-secondary)", fontSize: 13 }}>
              — {previewingProfile.name} ({previewingProfile.profileType})
            </span>
          </div>
          <label style={fieldLabel}>
            <span>Sale amount *</span>
            <input
              type="number"
              min="0"
              step="0.01"
              value={previewForm.saleAmount}
              onChange={(e) => setPreviewForm({ ...previewForm, saleAmount: e.target.value })}
              style={inputStyle}
              aria-label="Sale amount"
            />
          </label>
          <label style={fieldLabel}>
            <span>Pax count</span>
            <input
              type="number"
              min="0"
              step="1"
              value={previewForm.paxCount}
              onChange={(e) => setPreviewForm({ ...previewForm, paxCount: e.target.value })}
              style={inputStyle}
              aria-label="Pax count"
            />
          </label>
          <div style={{ display: "flex", gap: 8, gridColumn: "1 / -1" }}>
            <button
              type="submit"
              disabled={previewLoading}
              style={{ ...primaryBtn, background: "var(--primary-color, var(--accent-color))" }}
            >
              {previewLoading ? "Calculating…" : "Calculate"}
            </button>
            <button
              type="button"
              onClick={closePreview}
              style={secondaryBtn}
            >
              Close
            </button>
          </div>
          {previewResult && (
            <div
              data-testid="commission-profile-preview-result"
              style={{
                gridColumn: "1 / -1",
                padding: 12,
                borderRadius: 6,
                background: "var(--subtle-bg, rgba(255,255,255,0.04))",
                border: "1px solid var(--border-color)",
                display: "flex",
                flexDirection: "column",
                gap: 6,
              }}
            >
              <div style={{ fontSize: 13, color: "var(--text-secondary)" }}>
                Calculated commission
              </div>
              <div
                data-testid="commission-profile-preview-amount"
                style={{ fontSize: 22, fontWeight: 700, color: "var(--success-color, #22c55e)" }}
              >
                {Number(previewResult.commission || 0).toLocaleString(undefined, {
                  minimumFractionDigits: 2,
                  maximumFractionDigits: 2,
                })}
              </div>
              {previewResult.breakdown && (
                <div
                  data-testid="commission-profile-preview-breakdown"
                  style={{ fontSize: 12, color: "var(--text-secondary)", fontFamily: "monospace" }}
                >
                  {previewResult.breakdown}
                </div>
              )}
            </div>
          )}
        </form>
      )}

      {ledgerProfile && (
        <div
          data-testid="commission-profile-ledger-panel"
          className="glass"
          style={{
            padding: 16,
            marginBottom: 16,
            display: "flex",
            flexDirection: "column",
            gap: 12,
          }}
        >
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 10,
              flexWrap: "wrap",
            }}
          >
            <List size={18} aria-hidden />
            <strong>Commission ledger</strong>
            <span style={{ color: "var(--text-secondary)", fontSize: 13 }}>
              — {ledgerProfile.name} ({ledgerProfile.profileType})
            </span>
            <label
              style={{
                marginLeft: "auto",
                display: "inline-flex",
                alignItems: "center",
                gap: 6,
                fontSize: 13,
                color: "var(--text-secondary)",
                cursor: "pointer",
              }}
            >
              <input
                type="checkbox"
                checked={ledgerWonOnly}
                onChange={(e) => setLedgerWonOnly(e.target.checked)}
                aria-label="Won deals only"
                data-testid="commission-profile-ledger-won-toggle"
              />
              Won deals only
            </label>
            <button
              type="button"
              onClick={handleLedgerDownload}
              disabled={ledgerCsvBusy || ledgerLoading}
              style={secondaryBtn}
              aria-label="Download ledger CSV"
              data-testid="commission-profile-ledger-download-csv"
              title="Download the ledger as CSV (mirrors the current stage filter)"
            >
              <Download size={14} /> {ledgerCsvBusy ? "Downloading…" : "Download CSV"}
            </button>
            <button
              type="button"
              onClick={closeLedger}
              style={secondaryBtn}
              aria-label="Close ledger"
            >
              Close
            </button>
          </div>

          {/* Summary tile — total commission across the displayed page.
              `totalCommission` is the SERVER-computed sum from slice 9 (half-up
              rounded to 2dp). `totalEntries` is the full filtered count, which
              may exceed the page (limit 50 default). */}
          {ledgerData && !ledgerLoading && !ledgerError && (
            <div
              data-testid="commission-profile-ledger-summary"
              style={{
                padding: 12,
                borderRadius: 6,
                background: "var(--subtle-bg, rgba(255,255,255,0.04))",
                border: "1px solid var(--border-color)",
                display: "flex",
                gap: 24,
                flexWrap: "wrap",
              }}
            >
              <div>
                <div style={{ fontSize: 12, color: "var(--text-secondary)" }}>
                  Total commission (page)
                </div>
                <div
                  data-testid="commission-profile-ledger-total"
                  style={{ fontSize: 22, fontWeight: 700, color: "var(--success-color, #22c55e)" }}
                >
                  {Number(ledgerData.totalCommission || 0).toLocaleString(undefined, {
                    minimumFractionDigits: 2,
                    maximumFractionDigits: 2,
                  })}
                </div>
              </div>
              <div>
                <div style={{ fontSize: 12, color: "var(--text-secondary)" }}>
                  Deals counted
                </div>
                <div style={{ fontSize: 22, fontWeight: 700 }}>
                  {(ledgerData.entries || []).length.toLocaleString()}
                  {Number.isFinite(ledgerData.totalEntries)
                    && ledgerData.totalEntries > (ledgerData.entries || []).length && (
                    <span style={{ fontSize: 13, color: "var(--text-secondary)", marginLeft: 6 }}>
                      / {ledgerData.totalEntries.toLocaleString()} total
                    </span>
                  )}
                </div>
              </div>
            </div>
          )}

          {ledgerLoading && (
            <div style={{ padding: 16, textAlign: "center", color: "var(--text-secondary)" }}>
              Loading commission ledger&hellip;
            </div>
          )}

          {ledgerError && !ledgerLoading && (
            <div
              data-testid="commission-profile-ledger-error"
              role="alert"
              style={{
                padding: 12,
                borderRadius: 6,
                background: "rgba(244, 63, 94, 0.10)",
                border: "1px solid var(--danger-color, #f43f5e)",
                color: "var(--danger-color, #f43f5e)",
                fontSize: 13,
              }}
            >
              {ledgerError}
            </div>
          )}

          {!ledgerLoading && !ledgerError && ledgerData
            && (ledgerData.entries || []).length === 0 && (
            <div
              data-testid="commission-profile-ledger-empty"
              style={{
                padding: 24,
                textAlign: "center",
                color: "var(--text-secondary)",
                fontSize: 13,
              }}
            >
              <List size={20} style={{ opacity: 0.4, marginBottom: 6 }} />
              <div>
                {ledgerWonOnly
                  ? "No won deals yet for this profile."
                  : "No deals yet under this profile — assign agents via the contacts admin to populate."}
              </div>
            </div>
          )}

          {!ledgerLoading && !ledgerError && ledgerData
            && (ledgerData.entries || []).length > 0 && (
            <TopScrollSync>
              <table
                data-testid="commission-profile-ledger-table"
                style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}
              >
                <thead>
                  <tr style={{ borderBottom: "1px solid rgba(255,255,255,0.06)" }}>
                    <th style={th}>Deal</th>
                    <th style={th}>Contact</th>
                    <th style={th}>Stage</th>
                    <th style={{ ...th, textAlign: "right" }}>Deal value</th>
                    <th style={{ ...th, textAlign: "right" }}>Commission</th>
                    <th style={th}>Created</th>
                  </tr>
                </thead>
                <tbody>
                  {ledgerData.entries.map((entry) => (
                    <tr
                      key={entry.dealId}
                      data-testid={`commission-profile-ledger-row-${entry.dealId}`}
                      style={{ borderTop: "1px solid rgba(255,255,255,0.04)" }}
                    >
                      <td style={td}>
                        <strong>#{entry.dealId}</strong>
                        {entry.dealTitle && (
                          <div style={{ fontSize: 11, color: "var(--text-secondary)", marginTop: 2 }}>
                            {entry.dealTitle}
                          </div>
                        )}
                      </td>
                      <td style={td}>{entry.contactName || "(unknown)"}</td>
                      <td style={td}>
                        <span
                          style={{
                            ...statusBadge,
                            background:
                              entry.dealStage === "won"
                                ? "rgba(34, 197, 94, 0.18)"
                                : entry.dealStage === "lost"
                                  ? "rgba(244, 63, 94, 0.18)"
                                  : "rgba(255,255,255,0.08)",
                          }}
                        >
                          {entry.dealStage || "—"}
                        </span>
                      </td>
                      <td style={{ ...td, textAlign: "right", fontVariantNumeric: "tabular-nums" }}>
                        {Number(entry.dealAmount || 0).toLocaleString(undefined, {
                          minimumFractionDigits: 2,
                          maximumFractionDigits: 2,
                        })}
                        {entry.dealCurrency && (
                          <span style={{ marginLeft: 4, color: "var(--text-secondary)", fontSize: 11 }}>
                            {entry.dealCurrency}
                          </span>
                        )}
                      </td>
                      <td
                        style={{ ...td, textAlign: "right", fontVariantNumeric: "tabular-nums", fontWeight: 600 }}
                        data-testid={`commission-profile-ledger-commission-${entry.dealId}`}
                      >
                        {Number(entry.commission || 0).toLocaleString(undefined, {
                          minimumFractionDigits: 2,
                          maximumFractionDigits: 2,
                        })}
                      </td>
                      <td style={{ ...td, color: "var(--text-secondary)", fontSize: 12 }}>
                        {entry.createdAt
                          ? new Date(entry.createdAt).toLocaleDateString()
                          : "—"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </TopScrollSync>
          )}
        </div>
      )}

      <div className="glass" style={{ padding: 0, overflow: "hidden" }}>
        {loading ? (
          <div style={empty}>Loading&hellip;</div>
        ) : (
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr style={{ borderBottom: "1px solid rgba(255,255,255,0.06)" }}>
                <th style={th}>Name</th>
                <th style={th}>Type</th>
                <th style={th}>Sub-brand</th>
                <th style={th}>Status</th>
                {canWrite && <th style={{ ...th, textAlign: "center" }}>Actions</th>}
              </tr>
            </thead>
            <tbody>
              {profiles.map((p) => (
                <tr
                  key={p.id}
                  data-testid={`commission-profile-row-${p.id}`}
                  style={{ borderTop: "1px solid rgba(255,255,255,0.04)" }}
                >
                  <td style={td}>
                    <strong>{p.name}</strong>
                    {p.notes && (
                      <div style={{ fontSize: 11, color: "var(--text-secondary)", marginTop: 2 }}>
                        {p.notes}
                      </div>
                    )}
                  </td>
                  <td style={td}>
                    <span
                      data-testid={`commission-profile-type-${p.id}`}
                      style={{
                        ...statusBadge,
                        background:
                          PROFILE_TYPE_BADGE_BG[p.profileType] || "rgba(255,255,255,0.08)",
                        color: "var(--text-primary)",
                      }}
                    >
                      {(PROFILE_TYPES.find((t) => t.value === p.profileType) || {}).label
                        || p.profileType}
                    </span>
                  </td>
                  <td style={td}>
                    <span
                      style={{
                        ...brandBadge,
                        background: p.subBrand
                          ? SUB_BRAND_BG[p.subBrand] || "rgba(255,255,255,0.08)"
                          : "rgba(255,255,255,0.04)",
                      }}
                    >
                      {p.subBrand || "all"}
                    </span>
                  </td>
                  <td style={td}>
                    <span
                      style={{
                        ...statusBadge,
                        background: p.isActive
                          ? "rgba(34, 197, 94, 0.18)"
                          : "rgba(244, 63, 94, 0.18)",
                        color: p.isActive
                          ? "var(--success-color, #22c55e)"
                          : "var(--danger-color, #f43f5e)",
                      }}
                    >
                      {p.isActive ? "Active" : "Inactive"}
                    </span>
                  </td>
                  {canWrite && (
                    <td style={{ ...td, textAlign: "center", whiteSpace: "nowrap" }}>
                      <button
                        type="button"
                        onClick={() => openPreview(p)}
                        title={`Preview commission for ${p.name}`}
                        aria-label={`Preview ${p.name}`}
                        style={iconBtn}
                        data-testid={`commission-profile-preview-${p.id}`}
                      >
                        <Calculator size={16} />
                      </button>
                      <button
                        type="button"
                        onClick={() => openLedger(p)}
                        title={`View commission ledger for ${p.name}`}
                        aria-label={`View ledger ${p.name}`}
                        style={iconBtn}
                        data-testid={`commission-profile-ledger-${p.id}`}
                      >
                        <List size={16} />
                      </button>
                      <button
                        type="button"
                        onClick={() => openEdit(p)}
                        title={`Edit ${p.name}`}
                        aria-label={`Edit ${p.name}`}
                        style={iconBtn}
                      >
                        <Pencil size={16} />
                      </button>
                      {canDelete && (
                        <button
                          type="button"
                          onClick={() => handleDelete(p)}
                          title={`Delete ${p.name}`}
                          aria-label={`Delete ${p.name}`}
                          style={{ ...iconBtn, color: "var(--danger-color, #f43f5e)" }}
                        >
                          <Trash2 size={16} />
                        </button>
                      )}
                    </td>
                  )}
                </tr>
              ))}
              {profiles.length === 0 && (
                <tr>
                  <td
                    colSpan={canWrite ? 5 : 4}
                    style={{
                      ...td,
                      textAlign: "center",
                      color: permissionDenied
                        ? "var(--warning-color, #f59e0b)"
                        : "var(--text-secondary)",
                      padding: permissionDenied ? "2rem 1rem" : "1.5rem 1rem",
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
                          Your role does not have permission to view commission profiles.
                          Ask an Admin to grant access if you need it.
                        </div>
                      </>
                    ) : (
                      <>
                        <Percent size={20} style={{ opacity: 0.4, marginBottom: 6 }} />
                        <div>
                          No commission profiles yet — create one to define agent payouts.
                        </div>
                      </>
                    )}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
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
const fieldLabel = {
  display: "flex",
  flexDirection: "column",
  gap: 4,
  fontSize: 12,
  color: "var(--text-secondary)",
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
