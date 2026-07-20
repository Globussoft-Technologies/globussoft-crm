import React, { useState, useEffect, useContext, useRef } from "react";
import { Link } from "react-router-dom";
import {
  UserPlus,
  Trash2,
  Key,
  Sun,
  Moon,
  Plus,
  ArrowUp,
  ArrowDown,
  Layers,
  Building2,
  Image as ImageIcon,
  Palette,
  Monitor,
  Mail,
  FileSignature,
  Bell,
  Eye,
  EyeOff,
  Check,
  X,
  Loader,
  PhoneCall,
  CreditCard,
  ArrowRight,
  Stethoscope,
  Sliders,
  Bot,
} from "lucide-react";
import { fetchApi, getAuthToken } from "../utils/api";
import { useNotify } from "../utils/notify";
import { usePermissions } from "../hooks/usePermissions";
import { ThemeContext, AuthContext } from "../App";
import PasswordInput from "../components/PasswordInput";
import WebhookSigningCredential from "../components/WebhookSigningCredential";
import RoleHistoryDialog from "../components/RoleHistoryDialog";
import { SUB_BRAND_IDS, subBrandShortLabel, subBrandBackground } from "../utils/travelSubBrand";
import { useActiveSubBrand } from "../utils/subBrand";
import { useEffectiveBrand, invalidateEffectiveBrandCache } from "../hooks/useEffectiveBrand";

// #391: single source of truth for the default brand color so the color
// picker swatch, the placeholder hint, and the color actually applied
// when no brand color is set all match. Mirrors --accent-color in
// index.css.
const DEFAULT_BRAND_COLOR = "#3b82f6";

export default function Settings() {
  const notify = useNotify();
  const { theme, setTheme, toggleTheme } = useContext(ThemeContext);
  const { tenant: ctxTenant, setTenant } = useContext(AuthContext);
  const { isOwner, hasPermission } = usePermissions();

  // Branding refactor (2026-07-08): the Branding card follows whichever
  // sub-brand is currently selected in the sidebar dropdown — travel
  // tenants only; non-travel tenants always get activeSubBrand=null (the
  // context defaults to null anyway when unmounted, so this is a no-op
  // there) and the card behaves exactly as it always has (Tenant.logoUrl /
  // brandColor, edited via /api/wellness/branding*).
  const { activeSubBrand } = useActiveSubBrand();
  const brandingSubBrand = ctxTenant?.vertical === "travel" ? activeSubBrand : null;
  // Only `reload` is consumed here (busts the shared cache Sidebar also
  // reads from after a save/delete) — the card displays the brand's OWN
  // values via `branding` state, not the fallback-resolved `effective`.
  const { reload: reloadEffectiveBrand } = useEffectiveBrand(brandingSubBrand);

  // ── Role Recovery section ────────────────────────────────────────
  // Lockout-scenario recovery surface. Reuses the existing /api/roles
  // listing + /api/roles/:id/permissions/versions + /restore endpoints.
  // The OR-gate on those routes (roles.* OR settings.manage) means
  // this section works even after `roles.read` is lost — admins who
  // can administer settings can recover RBAC through here without
  // needing to first restore `roles.read`. See routes/roles.js +
  // backend/middleware/requirePermission.js requireAnyPermission().
  const [recoveryRoles, setRecoveryRoles] = useState([]);
  const [recoveryLoading, setRecoveryLoading] = useState(false);
  const [recoveryError, setRecoveryError] = useState("");
  const [recoveryDialogRole, setRecoveryDialogRole] = useState(null);
  // Restore button visibility — gated on the same OR-pair the
  // backend POST /restore endpoint enforces. settings.manage admins
  // can restore even if they don't hold roles.manage (the recovery
  // path). roles.manage admins keep the same restore power they had
  // inside the Roles & Permissions page.
  const canRecover =
    hasPermission("roles", "manage") || hasPermission("settings", "manage");
  const canSeeRecoverySection =
    hasPermission("roles", "read") || hasPermission("settings", "manage");
  const loadRecoveryRoles = async () => {
    setRecoveryLoading(true);
    setRecoveryError("");
    try {
      const res = await fetchApi("/api/roles");
      setRecoveryRoles(Array.isArray(res?.roles) ? res.roles : []);
    } catch (err) {
      setRecoveryError(err.message || "Could not load roles");
    } finally {
      setRecoveryLoading(false);
    }
  };
  useEffect(() => {
    if (canSeeRecoverySection) loadRecoveryRoles();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canSeeRecoverySection]);
  const [newUser, setNewUser] = useState({
    name: "",
    email: "",
    password: "",
    role: "USER",
  });
  const [pipelineStages, setPipelineStages] = useState([]);
  const [newStage, setNewStage] = useState({ name: "", color: "#3b82f6" });
  const [stagesLoading, setStagesLoading] = useState(true);
  const [tenant, setTenantState] = useState(ctxTenant || null);
  const [tenantSaving, setTenantSaving] = useState(false);
  // #611: email-message retention toggle. Industry-default ON for any CRM
  // that claims to track customer comms. Pre-fix the default was OFF, sent
  // emails vanished, Sent folder stayed empty, threading broke.
  const [emailRetentionSaving, setEmailRetentionSaving] = useState(false);
  // Branding (logo + brand color) — backed by /api/wellness/branding
  const [branding, setBranding] = useState({ logoUrl: null, brandColor: "" });
  const [brandingSaving, setBrandingSaving] = useState(false);
  // Logo upload UX: pick a file → preview it locally → click "Save logo"
  // to actually upload. Previously the upload fired on file-pick which
  // gave no way to review before commit + no preview of the picked file.
  const [stagedLogo, setStagedLogo] = useState(null); // File or null
  const [stagedPreviewUrl, setStagedPreviewUrl] = useState(null);
  const [logoBroken, setLogoBroken] = useState(false);
  const logoInputRef = useRef(null);
  const [logoUploading, setLogoUploading] = useState(false);
  const [brandingMsg, setBrandingMsg] = useState("");
  // Multi-brand (BrandKit) — travel-vertical only. "Your Brands" list below
  // the default-brand card, backed by the existing /api/brand-kits CRUD
  // (same system /admin/brand-kits already manages). Settings only ever
  // touches the ACTIVE kit per sub-brand; version history / advanced fields
  // stay on the dedicated admin page.
  const [brandKits, setBrandKits] = useState([]);
  const [brandKitsLoading, setBrandKitsLoading] = useState(false);
  const [showAddBrand, setShowAddBrand] = useState(false);
  const [addBrandForm, setAddBrandForm] = useState({ subBrand: "", logoUrl: "", primaryColor: "" });
  const [addBrandFile, setAddBrandFile] = useState(null);
  const [addBrandFilePreviewUrl, setAddBrandFilePreviewUrl] = useState(null);
  const pickAddBrandFile = (file) => {
    if (addBrandFilePreviewUrl) URL.revokeObjectURL(addBrandFilePreviewUrl);
    setAddBrandFile(file || null);
    setAddBrandFilePreviewUrl(file ? URL.createObjectURL(file) : null);
  };
  const [addBrandSaving, setAddBrandSaving] = useState(false);
  const [addBrandError, setAddBrandError] = useState("");
  // AdsGPT configuration
  const [adsgptLogin, setAdsgptLogin] = useState("");
  const [adsgptSaving, setAdsgptSaving] = useState(false);
  const [adsgptMsg, setAdsgptMsg] = useState("");
  // Callified integration
  const [callifiedApiKey, setCallifiedApiKey] = useState("");
  const [callifiedShowKey, setCallifiedShowKey] = useState(false);
  const [callifiedLoading, setCallifiedLoading] = useState(true);
  const [callifiedSaving, setCallifiedSaving] = useState(false);
  const [callifiedConnected, setCallifiedConnected] = useState(false);
  const [callifiedMsg, setCallifiedMsg] = useState("");
  const [callifiedUpdatedAt, setCallifiedUpdatedAt] = useState(null);

  useEffect(() => {
    fetchApi("/api/tenants/current")
      .then((res) => {
        setTenantState(res);
        if (setTenant) setTenant(res);
      })
      .catch(() => {
        /* tenant endpoint may not be reachable */
      });
    // Branding lives under /api/wellness/branding (works for any tenant — only the
    // sidebar conditionally surfaces it on wellness verticals today).
    fetchApi("/api/wellness/branding")
      .then((res) =>
        setBranding({
          logoUrl: res.logoUrl || null,
          brandColor: res.brandColor || "",
        }),
      )
      .catch(() => {
        /* branding endpoint may be unavailable for non-wellness tenants */
      });
    // Fetch AdsGPT login configuration
    fetchApi("/api/integrations/adsgpt/config")
      .then((res) => setAdsgptLogin(res.adsgptLogin || ""))
      .catch(() => {
        /* adsgpt config may not be available */
      });
    // Fetch Callified integration status
    fetchApi("/api/integrations")
      .then((integrations) => {
        const callifiedIntegration = integrations.find(
          (i) => i.provider === "callified",
        );
        if (callifiedIntegration && callifiedIntegration.isActive) {
          setCallifiedConnected(true);
          setCallifiedUpdatedAt(callifiedIntegration.updatedAt);
          setCallifiedApiKey("••••••••••••••••");
        }
        setCallifiedLoading(false);
      })
      .catch(() => setCallifiedLoading(false));
  }, []);

  // Multi-brand (BrandKit) list — travel vertical only (sub-brands are a
  // travel-only concept; generic/wellness tenants only ever have the
  // tenant-wide default kit, which the Branding card above already covers).
  const loadBrandKits = () => {
    setBrandKitsLoading(true);
    fetchApi("/api/brand-kits?isActive=true")
      .then((res) => setBrandKits(Array.isArray(res?.brandKits) ? res.brandKits : []))
      .catch(() => setBrandKits([]))
      .finally(() => setBrandKitsLoading(false));
  };

  useEffect(() => {
    if (ctxTenant?.vertical === "travel") loadBrandKits();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ctxTenant?.vertical]);

  // The BrandKit row (if any) for whichever sub-brand is currently active —
  // this drives what the Branding card shows/edits when brandingSubBrand is
  // set. Sourced from the same brandKits list "Your Brands" already loads
  // (no extra fetch); its OWN logoUrl/primaryColor (not the fallback-
  // resolved effectiveBrand) are what "Save" should read/write, so an
  // unmodified save never accidentally writes a borrowed fallback value
  // onto this sub-brand.
  const activeBrandKitRow = brandingSubBrand
    ? brandKits.find((k) => k.subBrand === brandingSubBrand) || null
    : null;

  // Sync the editable branding fields whenever the selected brand changes
  // (dropdown switch, or the kit list finishes loading). Default-brand mode
  // (brandingSubBrand null) is untouched — it keeps loading from
  // /api/wellness/branding, exactly as before.
  useEffect(() => {
    if (!brandingSubBrand) return; // default-brand fetch effect handles this case
    setBranding({
      logoUrl: activeBrandKitRow?.logoUrl || null,
      brandColor: activeBrandKitRow?.primaryColor || "",
    });
    setLogoBroken(false);
    setBrandingMsg("");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [brandingSubBrand, activeBrandKitRow?.id, activeBrandKitRow?.logoUrl, activeBrandKitRow?.primaryColor]);

  // Stage a picked file locally — render a preview, wait for the user to
  // hit "Save logo" before doing the actual upload. URL.createObjectURL
  // returns a blob: URL we must revoke when replacing or unmounting to
  // avoid leaking the blob.
  const handlePickLogo = (e) => {
    const file = e.target.files && e.target.files[0];
    // Reset the input so picking the same file twice fires onChange again.
    if (e.target) e.target.value = "";
    if (!file) return;
    if (file.size > 20 * 1024 * 1024) {
      setBrandingMsg("Image too large — max 20 MB.");
      return;
    }
    if (stagedPreviewUrl) URL.revokeObjectURL(stagedPreviewUrl);
    setStagedLogo(file);
    setStagedPreviewUrl(URL.createObjectURL(file));
    setBrandingMsg("");
  };

  const cancelStagedLogo = () => {
    if (stagedPreviewUrl) URL.revokeObjectURL(stagedPreviewUrl);
    setStagedLogo(null);
    setStagedPreviewUrl(null);
    setBrandingMsg("");
  };

  // Create-or-update the active sub-brand's BrandKit row with a patch of
  // asset fields. Shared by the logo save/delete and color save paths below
  // so there's exactly one place that knows "POST when no kit exists yet,
  // PUT when one does."
  const upsertActiveBrandKit = async (patch) => {
    if (activeBrandKitRow) {
      return fetchApi(`/api/brand-kits/${activeBrandKitRow.id}`, {
        method: "PUT",
        body: JSON.stringify(patch),
      });
    }
    return fetchApi("/api/brand-kits", {
      method: "POST",
      body: JSON.stringify({ subBrand: brandingSubBrand, isActive: true, ...patch }),
    });
  };

  const handleSaveLogo = async () => {
    if (!stagedLogo) return;
    setLogoUploading(true);
    setBrandingMsg("");
    try {
      let logoUrl;
      if (brandingSubBrand) {
        const fd = new FormData();
        fd.append("file", stagedLogo);
        fd.append("assetType", "logo");
        fd.append("subBrand", brandingSubBrand);
        const uploadRes = await fetchApi("/api/brand-kits/upload", { method: "POST", body: fd });
        logoUrl = uploadRes?.url || null;
        await upsertActiveBrandKit({ logoUrl });
        loadBrandKits();
        reloadEffectiveBrand();
      } else {
        const fd = new FormData();
        fd.append("logo", stagedLogo);
        const token = getAuthToken();
        const resp = await fetch("/api/wellness/branding/logo", {
          method: "POST",
          headers: token ? { Authorization: `Bearer ${token}` } : {},
          body: fd,
        });
        const json = await resp.json().catch(() => ({}));
        if (!resp.ok) throw new Error(json.error || "Upload failed");
        logoUrl = json.logoUrl;
        // Reflect into sidebar instantly
        if (setTenant && ctxTenant) setTenant({ ...ctxTenant, logoUrl });
        reloadEffectiveBrand();
      }
      setBranding((b) => ({ ...b, logoUrl }));
      setLogoBroken(false);
      setBrandingMsg("Logo updated.");
      cancelStagedLogo();
    } catch (err) {
      setBrandingMsg(err?.body?.error || err?.message || "Logo upload failed");
    } finally {
      setLogoUploading(false);
    }
  };

  // Delete Logo (2026-07-08) — clears the current brand's logo (BrandKit.logoUrl
  // for a sub-brand, or Tenant.logoUrl for the default brand) and removes the
  // underlying file from S3/disk. Immediately falls back to whatever the next
  // link in the chain resolves to (default brand → system logo) with no
  // reload — reloadEffectiveBrand() busts the shared cache Sidebar reads too.
  const [logoDeleting, setLogoDeleting] = useState(false);
  const handleDeleteLogo = async () => {
    if (!branding.logoUrl) return;
    const ok = await notify.confirm("Delete this logo? This removes the file permanently.");
    if (!ok) return;
    setLogoDeleting(true);
    setBrandingMsg("");
    try {
      if (brandingSubBrand && activeBrandKitRow) {
        await fetchApi(`/api/brand-kits/${activeBrandKitRow.id}/logo`, { method: "DELETE" });
        loadBrandKits();
      } else if (!brandingSubBrand) {
        await fetchApi("/api/wellness/branding/logo", { method: "DELETE" });
        if (setTenant && ctxTenant) setTenant({ ...ctxTenant, logoUrl: null });
      }
      setBranding((b) => ({ ...b, logoUrl: null }));
      setLogoBroken(false);
      reloadEffectiveBrand();
      setBrandingMsg("Logo deleted.");
    } catch (err) {
      setBrandingMsg(err?.body?.error || err?.message || "Failed to delete logo");
    } finally {
      setLogoDeleting(false);
    }
  };

  // Revoke the staged blob URL on unmount so we don't leak it.
  useEffect(() => {
    return () => {
      if (stagedPreviewUrl) URL.revokeObjectURL(stagedPreviewUrl);
      if (addBrandFilePreviewUrl) URL.revokeObjectURL(addBrandFilePreviewUrl);
    };
  }, []);

  const handleSaveBrandColor = async () => {
    setBrandingSaving(true);
    setBrandingMsg("");
    try {
      const value = branding.brandColor || "";
      if (value && !/^#[0-9a-fA-F]{6}$/.test(value)) {
        throw new Error("Brand color must be a 6-digit hex (e.g. #265855).");
      }
      if (brandingSubBrand) {
        const updated = await upsertActiveBrandKit({ primaryColor: value || null });
        setBranding((b) => ({ ...b, brandColor: updated?.primaryColor || "" }));
        loadBrandKits();
      } else {
        const res = await fetchApi("/api/wellness/branding/color", {
          method: "PUT",
          body: JSON.stringify({ brandColor: value || null }),
        });
        setBranding((b) => ({ ...b, brandColor: res.brandColor || "" }));
        if (setTenant && ctxTenant)
          setTenant({ ...ctxTenant, brandColor: res.brandColor || null });
      }
      reloadEffectiveBrand();
      setBrandingMsg("Brand color saved.");
    } catch (err) {
      setBrandingMsg(err?.body?.error || err?.message || "Failed to save brand color");
    } finally {
      setBrandingSaving(false);
    }
  };

  // Sub-brands that don't yet have an active BrandKit — offered in the
  // "Add Another Brand" picker. Sub-brands that already have one are edited
  // in place (same modal, pre-filled, PUT instead of POST) rather than
  // re-created.
  const brandKitSubBrands = new Set(brandKits.map((k) => k.subBrand));
  const availableSubBrands = SUB_BRAND_IDS.filter((id) => !brandKitSubBrands.has(id));

  // `editingKit` is null when adding a brand new-to-this-tenant, or the
  // existing BrandKit row when editing one that already exists.
  const [editingKit, setEditingKit] = useState(null);

  const openAddBrand = () => {
    setEditingKit(null);
    setAddBrandForm({ subBrand: availableSubBrands[0] || "", logoUrl: "", primaryColor: "" });
    pickAddBrandFile(null);
    setAddBrandError("");
    setShowAddBrand(true);
  };

  const openEditBrand = (kit) => {
    setEditingKit(kit);
    setAddBrandForm({
      subBrand: kit.subBrand,
      logoUrl: kit.logoUrl || "",
      primaryColor: kit.primaryColor || "",
    });
    pickAddBrandFile(null);
    setAddBrandError("");
    setShowAddBrand(true);
  };

  const handleAddBrandSubmit = async (e) => {
    e.preventDefault();
    if (!addBrandForm.subBrand) {
      setAddBrandError("Brand name is required.");
      return;
    }
    setAddBrandSaving(true);
    setAddBrandError("");
    try {
      let logoUrl = editingKit ? addBrandForm.logoUrl || null : null;
      if (addBrandFile) {
        const form = new FormData();
        form.append("file", addBrandFile);
        form.append("assetType", "logo");
        form.append("subBrand", addBrandForm.subBrand);
        const uploadRes = await fetchApi("/api/brand-kits/upload", {
          method: "POST",
          body: form,
        });
        logoUrl = uploadRes?.url || null;
      }
      const color = addBrandForm.primaryColor || "";
      if (color && !/^#[0-9a-fA-F]{6}$/.test(color)) {
        throw new Error("Brand color must be a 6-digit hex (e.g. #265855).");
      }
      if (editingKit) {
        await fetchApi(`/api/brand-kits/${editingKit.id}`, {
          method: "PUT",
          body: JSON.stringify({
            logoUrl,
            primaryColor: color || null,
          }),
        });
        notify.success(`${subBrandShortLabel(addBrandForm.subBrand)} brand updated.`);
      } else {
        await fetchApi("/api/brand-kits", {
          method: "POST",
          body: JSON.stringify({
            subBrand: addBrandForm.subBrand,
            logoUrl,
            primaryColor: color || null,
            isActive: true,
          }),
        });
        notify.success(`${subBrandShortLabel(addBrandForm.subBrand)} brand added.`);
      }
      setShowAddBrand(false);
      loadBrandKits();
      invalidateEffectiveBrandCache(addBrandForm.subBrand);
      reloadEffectiveBrand();
    } catch (err) {
      setAddBrandError(err?.body?.error || err?.message || "Failed to save brand.");
    } finally {
      setAddBrandSaving(false);
    }
  };

  // "Set as Default" (2026-07-08) — marks a sub-brand as the tenant-wide
  // fallback (Tenant.defaultSubBrand) that every consumer surface falls back
  // to before the system default, once its own sub-brand has no branding.
  // Only one brand can be default at a time; the backend clears
  // defaultSubBrand entirely to restore old behaviour if this ever needs
  // to point back at the plain default-brand card instead of a sub-brand.
  const [settingDefaultId, setSettingDefaultId] = useState(null);
  const handleSetDefaultBrand = async (kit) => {
    setSettingDefaultId(kit.id);
    try {
      await fetchApi(`/api/brand-kits/${kit.id}/set-default`, { method: "POST" });
      setTenantState((t) => (t ? { ...t, defaultSubBrand: kit.subBrand } : t));
      if (setTenant && ctxTenant) setTenant({ ...ctxTenant, defaultSubBrand: kit.subBrand });
      invalidateEffectiveBrandCache();
      reloadEffectiveBrand();
      notify.success(`${subBrandShortLabel(kit.subBrand)} is now the default brand.`);
    } catch (err) {
      notify.error(err?.body?.error || err?.message || "Failed to set default brand.");
    } finally {
      setSettingDefaultId(null);
    }
  };

  const handleSaveTenant = async (e) => {
    e.preventDefault();
    setTenantSaving(true);
    try {
      const updated = await fetchApi("/api/tenants/current", {
        method: "PUT",
        body: JSON.stringify({
          name: tenant.name,
          ownerEmail: tenant.ownerEmail,
        }),
      });
      setTenantState(updated);
      if (setTenant) setTenant(updated);
    } catch (err) {
      notify.error("Failed to update organization");
    }
    setTenantSaving(false);
  };

  // #611: toggle EmailMessage retention. Optimistic UI — we flip first, then
  // PUT; revert on failure so the toggle always matches what's persisted.
  const handleToggleEmailRetention = async (next) => {
    if (!tenant) return;
    const prevValue = tenant.emailRetention !== false; // default true
    setTenantState({ ...tenant, emailRetention: next });
    setEmailRetentionSaving(true);
    try {
      const updated = await fetchApi("/api/tenants/current", {
        method: "PUT",
        body: JSON.stringify({ emailRetention: next }),
      });
      setTenantState(updated);
      if (setTenant) setTenant(updated);
      notify.success(
        next
          ? "Sent emails will now be stored (Sent folder + audit trail)."
          : "Sent emails will not be stored. Threading will be limited.",
      );
    } catch (err) {
      // Revert optimistic flip
      setTenantState({ ...tenant, emailRetention: prevValue });
      notify.error("Failed to update email retention");
    } finally {
      setEmailRetentionSaving(false);
    }
  };

  const handleSaveAdsgptLogin = async () => {
    setAdsgptSaving(true);
    setAdsgptMsg("");
    try {
      if (!adsgptLogin.trim()) {
        throw new Error("Username or email is required");
      }
      await fetchApi("/api/integrations/adsgpt/config", {
        method: "PUT",
        body: JSON.stringify({ adsgptLogin: adsgptLogin.trim() }),
      });
      notify.success("AdsGPT login updated");
      setAdsgptMsg("✓ Saved");
      // Notify other components to refetch the config
      window.dispatchEvent(
        new CustomEvent("adsgpt:config-updated", {
          detail: { adsgptLogin: adsgptLogin.trim() },
        }),
      );
    } catch (err) {
      const msg = err.message || "Failed to save AdsGPT login";
      setAdsgptMsg(msg);
      notify.error(msg);
    } finally {
      setAdsgptSaving(false);
    }
  };

  const handleSaveCallifiedKey = async (e) => {
    e.preventDefault();
    if (!callifiedApiKey || callifiedApiKey.length < 10) {
      setCallifiedMsg("Please enter a valid API key");
      return;
    }
    if (callifiedApiKey === "••••••••••••••••") {
      setCallifiedMsg("Please enter the actual API key");
      return;
    }
    setCallifiedSaving(true);
    setCallifiedMsg("");
    try {
      await fetchApi("/api/integrations/connect", {
        method: "POST",
        body: JSON.stringify({ provider: "callified", token: callifiedApiKey }),
      });
      notify.success("Callified API key saved successfully");
      setCallifiedConnected(true);
      setCallifiedUpdatedAt(new Date().toISOString());
      setCallifiedApiKey("••••••••••••••••");
      setCallifiedMsg("✓ Connected to Callified");
    } catch (err) {
      const msg = err.message || "Failed to save API key";
      setCallifiedMsg(msg);
      notify.error(msg);
    } finally {
      setCallifiedSaving(false);
    }
  };

  const handleDisconnectCallified = async () => {
    const ok = await notify.confirm({
      title: "Disconnect Callified",
      message: "Are you sure you want to disconnect Callified?",
      confirmText: "Disconnect",
      destructive: true,
    });
    if (!ok) return;
    setCallifiedSaving(true);
    try {
      await fetchApi("/api/integrations/disconnect", {
        method: "POST",
        body: JSON.stringify({ provider: "callified" }),
      });
      notify.success("Callified integration disconnected");
      setCallifiedConnected(false);
      setCallifiedApiKey("");
      setCallifiedUpdatedAt(null);
      setCallifiedMsg("");
    } catch (err) {
      notify.error("Failed to disconnect Callified");
    } finally {
      setCallifiedSaving(false);
    }
  };

  const fetchStages = () => {
    fetchApi("/api/pipeline_stages")
      .then((res) => {
        setPipelineStages(Array.isArray(res) ? res : []);
        setStagesLoading(false);
      })
      .catch(() => setStagesLoading(false));
  };

  useEffect(() => {
    fetchStages();
  }, []);

  const handleAddStage = async (e) => {
    e.preventDefault();
    if (!newStage.name.trim()) return;
    try {
      await fetchApi("/api/pipeline_stages", {
        method: "POST",
        body: JSON.stringify({
          name: newStage.name,
          color: newStage.color,
          position: pipelineStages.length,
        }),
      });
      setNewStage({ name: "", color: "#3b82f6" });
      fetchStages();
    } catch (err) {
      notify.error("Failed to add stage");
    }
  };

  const handleDeleteStage = async (id) => {
    if (await notify.confirm("Delete this pipeline stage?")) {
      await fetchApi(`/api/pipeline_stages/${id}`, { method: "DELETE" });
      fetchStages();
    }
  };

  // #390: persist reorder to the backend. Optimistic UI update first, then
  // PUT /api/pipeline_stages/reorder with the new {id, position} pairs. The
  // server returns the canonical sorted list which we adopt as ground truth
  // (so any server-side dedup / clamp wins). On failure we reload to undo
  // the optimistic swap and notify the user — silent failures previously
  // looked like "snap back on refresh" because the PUT errored without
  // surfacing.
  const handleMoveStage = async (index, direction) => {
    const newStages = [...pipelineStages];
    const swapIndex = index + direction;
    if (swapIndex < 0 || swapIndex >= newStages.length) return;
    [newStages[index], newStages[swapIndex]] = [
      newStages[swapIndex],
      newStages[index],
    ];
    const reordered = newStages.map((s, i) => ({ id: s.id, position: i }));
    // Reflect new positions locally so the optimistic UI matches what we
    // POST (previously items kept their old position values).
    const optimistic = newStages.map((s, i) => ({ ...s, position: i }));
    setPipelineStages(optimistic);
    try {
      const updated = await fetchApi("/api/pipeline_stages/reorder", {
        method: "PUT",
        body: JSON.stringify({ stages: reordered }),
      });
      if (Array.isArray(updated)) {
        setPipelineStages(updated);
      } else {
        fetchStages();
      }
    } catch (err) {
      notify.error("Failed to save stage order");
      fetchStages();
    }
  };

  const handleCreateUser = async (e) => {
    e.preventDefault();
    try {
      await fetchApi("/api/auth/register", {
        method: "POST",
        body: JSON.stringify(newUser),
      });
      setNewUser({ name: "", email: "", password: "", role: "USER" });
      notify.success("Team member invited.");
    } catch (err) {
      notify.error("Failed to create user.");
    }
  };

  // #479/#484: clamp horizontal padding so narrow viewports get 1rem of
  // breathing room instead of the desktop 2rem (which eats ~64px of a
  // 425px viewport before any content gets to render).
  return (
    <div
      style={{
        padding: "clamp(1rem, 4vw, 2rem)",
        height: "100%",
        overflowY: "auto",
        animation: "fadeIn 0.5s ease-out",
      }}
    >
      <header style={{ marginBottom: "2.5rem" }}>
        <h1 style={{ fontSize: "2rem", fontWeight: "bold" }}>
          Organization Settings
        </h1>
        <p style={{ color: "var(--text-secondary)", marginTop: "0.25rem" }}>
          Manage team members, roles, and administrative security.
        </p>
        {/* Owner-only quick-link to the subscription catalog editor. Hidden
            for non-owners — the ManagePlans page itself also gates render
            on isOwner so a direct URL hit shows the access-denied panel. */}
        {isOwner && (
          <Link
            to="/manage-plans"
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 8,
              marginTop: "1rem",
              padding: "8px 14px",
              fontSize: "0.85rem",
              fontWeight: 600,
              background: "var(--accent-color)",
              color: "#fff",
              borderRadius: 8,
              textDecoration: "none",
            }}
          >
            <CreditCard size={14} /> Manage Subscription Plans{" "}
            <ArrowRight size={13} />
          </Link>
        )}
        {/* Lead custom fields — generic vertical only. LeadFields.jsx itself
            also redirects a direct URL hit from wellness/travel tenants. */}
        {ctxTenant?.vertical !== "wellness" && ctxTenant?.vertical !== "travel" && (
          <Link
            to="/settings/lead-fields"
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 8,
              marginTop: "1rem",
              marginLeft: "0.75rem",
              padding: "8px 14px",
              fontSize: "0.85rem",
              fontWeight: 600,
              background: "var(--primary-color, var(--accent-color))",
              color: "#fff",
              borderRadius: 8,
              textDecoration: "none",
            }}
          >
            <Sliders size={14} /> Lead Fields <ArrowRight size={13} />
          </Link>
        )}
      </header>

      {/* Cards flow through a CSS multi-column container so heights balance
          automatically across the two columns instead of pooling into two
          fixed lists (which left a tall empty gutter on the right whenever
          the wellness-only cards on the left pushed that column past the
          right one). Each card carries `break-inside: avoid` + its own
          bottom margin via the `.settings-grid > .card` rule in index.css.
          Below ~720px the columns collapse to a single column. */}
      <div className="settings-grid">
          {/* Organization Card */}
          <div
            className="card"
            style={{ padding: "clamp(1.25rem, 3vw, 2rem)" }}
          >
            <h3
              style={{
                fontSize: "1.25rem",
                fontWeight: "600",
                marginBottom: "1.5rem",
                display: "flex",
                alignItems: "center",
                gap: "0.5rem",
              }}
            >
              <Building2 size={20} color="var(--accent-color)" /> Organization
            </h3>
            {tenant ? (
              // #484: form grid uses auto-fit + minmax(min(100%, 240px)) so on
              // narrow viewports columns stack instead of squeezing inputs to
              // truncation width. min(100%, 240px) keeps the form single-column
              // on phones while staying two-column on tablets/desktop.
              <form
                onSubmit={handleSaveTenant}
                style={{
                  display: "grid",
                  gridTemplateColumns:
                    "repeat(auto-fit, minmax(min(100%, 240px), 1fr))",
                  gap: "1rem",
                }}
              >
                <div style={{ minWidth: 0 }}>
                  <label
                    style={{
                      display: "block",
                      marginBottom: "0.4rem",
                      fontSize: "0.875rem",
                      color: "var(--text-secondary)",
                    }}
                  >
                    Organization Name
                  </label>
                  <input
                    type="text"
                    required
                    className="input-field"
                    value={tenant.name || ""}
                    onChange={(e) =>
                      setTenantState({ ...tenant, name: e.target.value })
                    }
                  />
                </div>
                <div style={{ minWidth: 0 }}>
                  <label
                    style={{
                      display: "block",
                      marginBottom: "0.4rem",
                      fontSize: "0.875rem",
                      color: "var(--text-secondary)",
                    }}
                  >
                    Slug
                  </label>
                  {/* #715 — slug is read-only after organization creation. Render
                    with `readOnly` + muted background + cursor-not-allowed so
                    the input visibly signals the locked state; pre-fix the
                    `disabled` attr alone left users typing into a field
                    whose changes were silently stripped by the backend PUT
                    handler (routes/tenants.js doesn't accept `slug` in
                    update bodies). The helper text under the input makes
                    the read-only state explicit without requiring a hover
                    tooltip. */}
                  <input
                    type="text"
                    readOnly
                    className="input-field"
                    value={tenant.slug || ""}
                    title="Slug is read-only after organization creation."
                    aria-readonly="true"
                    style={{
                      background:
                        "var(--card-bg-secondary, rgba(255,255,255,0.05))",
                      cursor: "not-allowed",
                      opacity: 0.75,
                    }}
                  />
                  <p
                    style={{
                      marginTop: "0.4rem",
                      fontSize: "0.75rem",
                      color: "var(--text-secondary)",
                    }}
                  >
                    Slug is read-only after organization creation.
                  </p>
                </div>
                {/* #441: surface the public booking URL with a one-click copy
                  button. Pre-fix the owner had to view-source / DOM-inspect
                  to retrieve the URL — friction at the "send me your booking
                  link" moment. The URL is built from window.location.origin
                  + slug; SSR doesn't apply (Settings is auth-required, never
                  rendered server-side). */}
                {tenant.slug && (
                  // #484: gridColumn:'1 / -1' (full row) replaces 'span 2' so
                  // the cell still spans every column whether the auto-fit grid
                  // resolved to 1, 2, or more columns. flexWrap on the inner
                  // row lets the Copy URL button drop below the input on
                  // narrow viewports instead of squeezing the URL input.
                  <div style={{ gridColumn: "1 / -1", minWidth: 0 }}>
                    <label
                      style={{
                        display: "block",
                        marginBottom: "0.4rem",
                        fontSize: "0.875rem",
                        color: "var(--text-secondary)",
                      }}
                    >
                      Public Booking URL
                    </label>
                    <div
                      style={{
                        display: "flex",
                        gap: "0.5rem",
                        flexWrap: "wrap",
                      }}
                    >
                      <input
                        type="text"
                        readOnly
                        className="input-field"
                        value={`${window.location.origin}/book/${tenant.slug}`}
                        style={{ flex: "1 1 200px", minWidth: 0 }}
                        onFocus={(e) => e.target.select()}
                      />
                      <button
                        type="button"
                        className="btn-secondary"
                        onClick={() => {
                          const url = `${window.location.origin}/book/${tenant.slug}`;
                          navigator.clipboard?.writeText(url).then(
                            () =>
                              notify.success(
                                "Public booking URL copied to clipboard",
                              ),
                            () =>
                              notify.error(
                                "Could not copy — please select and copy manually",
                              ),
                          );
                        }}
                        style={{ padding: "0.5rem 1rem", whiteSpace: "nowrap" }}
                      >
                        Copy URL
                      </button>
                    </div>
                    <p
                      style={{
                        marginTop: "0.4rem",
                        fontSize: "0.75rem",
                        color: "var(--text-secondary)",
                      }}
                    >
                      Share this with{" "}
                      {tenant.vertical === "wellness"
                        ? "patients"
                        : "customers"}{" "}
                      to let them self-book without logging in.
                    </p>
                  </div>
                )}
                <div style={{ minWidth: 0 }}>
                  <label
                    style={{
                      display: "block",
                      marginBottom: "0.4rem",
                      fontSize: "0.875rem",
                      color: "var(--text-secondary)",
                    }}
                  >
                    Owner Email
                  </label>
                  <input
                    type="email"
                    className="input-field"
                    value={tenant.ownerEmail || ""}
                    onChange={(e) =>
                      setTenantState({ ...tenant, ownerEmail: e.target.value })
                    }
                  />
                </div>
                <div style={{ minWidth: 0 }}>
                  <label
                    style={{
                      display: "block",
                      marginBottom: "0.4rem",
                      fontSize: "0.875rem",
                      color: "var(--text-secondary)",
                    }}
                  >
                    Plan
                  </label>
                  <input
                    type="text"
                    disabled
                    className="input-field"
                    value={tenant.plan || "starter"}
                  />
                </div>
                <button
                  type="submit"
                  className="btn-primary"
                  disabled={tenantSaving}
                  style={{ gridColumn: "1 / -1" }}
                >
                  {tenantSaving ? "Saving..." : "Save Organization Details"}
                </button>
              </form>
            ) : (
              <p style={{ color: "var(--text-secondary)" }}>
                Loading organization details…
              </p>
            )}
          </div>

          {/* Appearance Card */}
          <div
            className="card"
            style={{ padding: "clamp(1.25rem, 3vw, 2rem)" }}
          >
            <h3
              style={{
                fontSize: "1.25rem",
                fontWeight: "600",
                marginBottom: "1.5rem",
                display: "flex",
                alignItems: "center",
                gap: "0.5rem",
              }}
            >
              <Sun size={20} color="var(--warning-color)" /> Appearance
            </h3>
            <div style={{ minWidth: 0 }}>
              <p
                id="appearance-theme-label"
                style={{
                  fontWeight: "500",
                  fontSize: "1rem",
                  marginBottom: "1rem",
                }}
              >
                Theme
              </p>
              <p
                style={{
                  color: "var(--text-secondary)",
                  fontSize: "0.875rem",
                  marginBottom: "1rem",
                }}
              >
                Choose how the interface should appear.
              </p>
              {/* #874 — role="radiogroup" + aria-labelledby gives screen readers
                proper group semantics on the three theme options. Native
                same-name radio inputs already handle arrow-key navigation
                between options (one Tab stop into the group; arrows cycle). */}
              <div
                role="radiogroup"
                aria-labelledby="appearance-theme-label"
                style={{
                  display: "flex",
                  flexDirection: "column",
                  gap: "0.75rem",
                }}
              >
                {[
                  { value: "light", label: "Light mode", icon: Sun },
                  { value: "dark", label: "Dark mode", icon: Moon },
                  {
                    value: "system",
                    label: "Based on system preference",
                    icon: Monitor,
                  },
                ].map(({ value, label, icon: IconComponent }) => (
                  <label
                    key={value}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: "0.75rem",
                      padding: "0.75rem 1rem",
                      borderRadius: "8px",
                      border: `2px solid ${theme === value ? "var(--accent-color)" : "var(--border-color)"}`,
                      background:
                        theme === value
                          ? "rgba(59, 130, 246, 0.1)"
                          : "rgba(59, 130, 246, 0.02)",
                      cursor: "pointer",
                      transition: "all 0.2s ease",
                    }}
                    className="theme-option"
                    data-selected={theme === value}
                    onMouseEnter={(e) => {
                      if (theme !== value) {
                        e.currentTarget.style.borderColor = "#3b82f6";
                        e.currentTarget.style.background =
                          "rgba(59, 130, 246, 0.08)";
                      }
                    }}
                    onMouseLeave={(e) => {
                      if (theme !== value) {
                        e.currentTarget.style.borderColor =
                          "var(--border-color)";
                        e.currentTarget.style.background =
                          "rgba(59, 130, 246, 0.02)";
                      }
                    }}
                  >
                    <input
                      type="radio"
                      name="theme"
                      value={value}
                      checked={theme === value}
                      onChange={(e) => {
                        if (e.target.checked) {
                          setTheme(value);
                          // #875 — confirm the preference landed. setTheme writes
                          // to local state + localStorage synchronously, so by the
                          // time this fires the choice is persisted.
                          notify.success(`Theme set to ${label}`);
                        }
                      }}
                      style={{ cursor: "pointer" }}
                    />
                    {IconComponent && <IconComponent size={18} />}
                    <span
                      style={{ fontWeight: theme === value ? "600" : "500" }}
                    >
                      {label}
                    </span>
                  </label>
                ))}
              </div>
            </div>
          </div>

          {/* Email Messages Card — #611 retention toggle */}
          {tenant && (
            <div
              className="card"
              style={{ padding: "clamp(1.25rem, 3vw, 2rem)" }}
              data-testid="email-retention-card"
            >
              <h3
                style={{
                  fontSize: "1.25rem",
                  fontWeight: "600",
                  marginBottom: "1rem",
                  display: "flex",
                  alignItems: "center",
                  gap: "0.5rem",
                }}
              >
                <Mail size={20} color="var(--accent-color)" /> Email Messages
              </h3>
              <p
                style={{
                  color: "var(--text-secondary)",
                  fontSize: "0.875rem",
                  marginBottom: "1.25rem",
                }}
              >
                Store sent messages so they appear in the Sent folder, the
                contact's activity timeline, and so reply threading works.
                Recommended for any team that needs an audit trail of customer
                comms.
              </p>
              <label
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: "0.75rem",
                  cursor: "pointer",
                }}
              >
                <input
                  type="checkbox"
                  checked={tenant.emailRetention !== false}
                  disabled={emailRetentionSaving}
                  onChange={(e) => handleToggleEmailRetention(e.target.checked)}
                  aria-label="Store sent email messages"
                  data-testid="email-retention-toggle"
                  style={{ width: 18, height: 18, cursor: "pointer" }}
                />
                <span style={{ fontWeight: 500 }}>
                  Store sent messages
                  {emailRetentionSaving && (
                    <span
                      style={{
                        marginLeft: "0.5rem",
                        color: "var(--text-secondary)",
                        fontSize: "0.8rem",
                      }}
                    >
                      (saving…)
                    </span>
                  )}
                </span>
              </label>
              {tenant.emailRetention === false && (
                <p
                  style={{
                    marginTop: "0.75rem",
                    padding: "0.6rem 0.85rem",
                    background: "rgba(245,158,11,0.1)",
                    border: "1px solid rgba(245,158,11,0.3)",
                    borderRadius: 8,
                    color: "#d97706",
                    fontSize: "0.8rem",
                  }}
                >
                  Retention is OFF. Sent emails won't appear in the Sent folder,
                  the contact timeline body will be blank, and reply threading
                  will not link replies to their parent.
                </p>
              )}
            </div>
          )}

          {/* Consent Templates — wellness only (#612) */}
          {tenant && tenant.vertical === "wellness" && (
            <ConsentTemplatesCard notify={notify} />
          )}

          {/* Wellness Role Types — wellness only (Option B) */}
          {tenant && tenant.vertical === "wellness" && (
            <WellnessRoleTypesCard notify={notify} />
          )}

          {/* Pipeline Stages Card */}
          <div
            className="card"
            style={{ padding: "clamp(1.25rem, 3vw, 2rem)" }}
          >
            <h3
              style={{
                fontSize: "1.25rem",
                fontWeight: "600",
                marginBottom: "1.5rem",
                display: "flex",
                alignItems: "center",
                gap: "0.5rem",
              }}
            >
              <Layers size={20} color="var(--accent-color)" /> Pipeline Stages
            </h3>

            {stagesLoading ? (
              <p>Loading stages...</p>
            ) : (
              <div
                style={{
                  display: "flex",
                  flexDirection: "column",
                  gap: "0.75rem",
                  marginBottom: "1.5rem",
                }}
              >
                {pipelineStages.length === 0 && (
                  <p
                    style={{
                      color: "var(--text-secondary)",
                      fontSize: "0.875rem",
                    }}
                  >
                    No custom stages configured. The pipeline uses default
                    stages.
                  </p>
                )}
                {pipelineStages.map((stage, index) => (
                  <div
                    key={stage.id}
                    style={{
                      display: "flex",
                      justifyContent: "space-between",
                      alignItems: "center",
                      background: "var(--surface-color)",
                      border: "1px solid var(--border-color)",
                      padding: "1rem 1.25rem",
                      borderRadius: "8px",
                    }}
                  >
                    <div
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: "0.75rem",
                      }}
                    >
                      <div
                        style={{
                          width: "20px",
                          height: "20px",
                          borderRadius: "6px",
                          backgroundColor: stage.color,
                          flexShrink: 0,
                        }}
                      />
                      <span style={{ fontWeight: "500" }}>{stage.name}</span>
                      <span
                        style={{
                          fontSize: "0.75rem",
                          color: "var(--text-secondary)",
                        }}
                      >
                        Position {index + 1}
                      </span>
                    </div>
                    <div
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: "0.5rem",
                      }}
                    >
                      <button
                        onClick={() => handleMoveStage(index, -1)}
                        disabled={index === 0}
                        style={{
                          background: "none",
                          border: "none",
                          color:
                            index === 0
                              ? "var(--border-color)"
                              : "var(--text-secondary)",
                          cursor: index === 0 ? "default" : "pointer",
                          padding: "0.25rem",
                        }}
                      >
                        <ArrowUp size={16} />
                      </button>
                      <button
                        onClick={() => handleMoveStage(index, 1)}
                        disabled={index === pipelineStages.length - 1}
                        style={{
                          background: "none",
                          border: "none",
                          color:
                            index === pipelineStages.length - 1
                              ? "var(--border-color)"
                              : "var(--text-secondary)",
                          cursor:
                            index === pipelineStages.length - 1
                              ? "default"
                              : "pointer",
                          padding: "0.25rem",
                        }}
                      >
                        <ArrowDown size={16} />
                      </button>
                      <button
                        onClick={() => handleDeleteStage(stage.id)}
                        style={{
                          background: "none",
                          border: "none",
                          color: "var(--danger-color)",
                          cursor: "pointer",
                          padding: "0.25rem",
                        }}
                      >
                        <Trash2 size={16} />
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}

            {/* #479: flexWrap so the color picker + Add button drop below the
              stage-name input on narrow viewports rather than truncating it. */}
            <form
              onSubmit={handleAddStage}
              style={{
                display: "flex",
                gap: "0.75rem",
                alignItems: "center",
                flexWrap: "wrap",
              }}
            >
              <input
                type="text"
                placeholder="Stage name"
                required
                className="input-field"
                style={{ flex: "1 1 180px", minWidth: 0 }}
                value={newStage.name}
                onChange={(e) =>
                  setNewStage({ ...newStage, name: e.target.value })
                }
              />
              <input
                type="color"
                value={newStage.color}
                onChange={(e) =>
                  setNewStage({ ...newStage, color: e.target.value })
                }
                style={{
                  width: "40px",
                  height: "40px",
                  border: "1px solid var(--border-color)",
                  borderRadius: "8px",
                  cursor: "pointer",
                  padding: "2px",
                  background: "var(--input-bg)",
                }}
              />
              <button
                type="submit"
                className="btn-primary"
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: "0.5rem",
                  whiteSpace: "nowrap",
                }}
              >
                <Plus size={16} /> Add Stage
              </button>
            </form>
          </div>

          {/* Invite User Card */}
          <div
            className="card"
            style={{ padding: "clamp(1.25rem, 3vw, 2rem)" }}
          >
            <h3
              style={{
                fontSize: "1.25rem",
                fontWeight: "600",
                marginBottom: "1.5rem",
                display: "flex",
                alignItems: "center",
                gap: "0.5rem",
              }}
            >
              <UserPlus size={20} color="var(--accent-color)" /> Invite Team
              Member
            </h3>
            {/* #484: Invite form uses auto-fit + minmax so fields stack on
              narrow viewports rather than truncating placeholders/values. */}
            <form
              onSubmit={handleCreateUser}
              style={{
                display: "grid",
                gridTemplateColumns:
                  "repeat(auto-fit, minmax(min(100%, 200px), 1fr))",
                gap: "1rem",
              }}
            >
              <input
                type="text"
                placeholder="Full Name"
                required
                className="input-field"
                style={{ minWidth: 0 }}
                value={newUser.name}
                onChange={(e) =>
                  setNewUser({ ...newUser, name: e.target.value })
                }
              />
              <input
                type="email"
                placeholder="Email Address"
                required
                className="input-field"
                style={{ minWidth: 0 }}
                value={newUser.email}
                onChange={(e) =>
                  setNewUser({ ...newUser, email: e.target.value })
                }
              />
              <PasswordInput
                placeholder="Temporary Password"
                required
                style={{ minWidth: 0 }}
                value={newUser.password}
                onChange={(e) =>
                  setNewUser({ ...newUser, password: e.target.value })
                }
                autoComplete="new-password"
              />
              <select
                className="input-field"
                value={newUser.role}
                onChange={(e) =>
                  setNewUser({ ...newUser, role: e.target.value })
                }
                style={{ background: "var(--input-bg)", minWidth: 0 }}
              >
                <option value="USER">Standard Rep</option>
                <option value="MANAGER">Sales Manager</option>
                <option value="ADMIN">System Administrator</option>
              </select>
              <button
                type="submit"
                className="btn-primary"
                style={{ gridColumn: "1 / -1" }}
              >
                Send Invitation & Create Account
              </button>
            </form>
          </div>

          {/* AdsGPT Configuration Card */}
          <div
            className="card"
            style={{ padding: "clamp(1.25rem, 3vw, 2rem)" }}
          >
            <h3
              style={{
                fontSize: "1.25rem",
                fontWeight: "600",
                marginBottom: "1rem",
                display: "flex",
                alignItems: "center",
                gap: "0.5rem",
              }}
            >
              <Key size={20} color="var(--accent-color)" /> AdsGPT Login
            </h3>
            <p
              style={{
                color: "var(--text-secondary)",
                fontSize: "0.875rem",
                marginBottom: "1.25rem",
              }}
            >
              Enter your AdsGPT aMember username or email. Users will be
              auto-logged in via SSO when accessing AdsGPT.
            </p>
            <div
              style={{ display: "flex", gap: "0.75rem", marginBottom: "1rem" }}
            >
              <input
                type="text"
                className="input-field"
                placeholder="Username or email (e.g. enhanceranchi or user@email.com)"
                value={adsgptLogin}
                onChange={(e) => setAdsgptLogin(e.target.value)}
                disabled={adsgptSaving}
                style={{ flex: 1, minWidth: 0 }}
              />
              <button
                type="button"
                className="btn-primary"
                disabled={adsgptSaving || !adsgptLogin.trim()}
                onClick={handleSaveAdsgptLogin}
                style={{ whiteSpace: "nowrap" }}
              >
                {adsgptSaving ? "Saving..." : "Save"}
              </button>
            </div>
            {adsgptMsg && (
              <p
                style={{
                  fontSize: "0.85rem",
                  color: adsgptMsg.includes("✓")
                    ? "var(--accent-color)"
                    : "var(--danger-color)",
                }}
              >
                {adsgptMsg}
              </p>
            )}
          </div>

          {/* Callified Integration Card */}
          <div
            className="card"
            style={{ padding: "clamp(1.25rem, 3vw, 2rem)" }}
          >
            <h3
              style={{
                fontSize: "1.25rem",
                fontWeight: "600",
                marginBottom: "1rem",
                display: "flex",
                alignItems: "center",
                gap: "0.5rem",
              }}
            >
              <PhoneCall size={20} color="var(--accent-color)" /> Callified
              Integration
            </h3>

            {/* Status Card */}
            {!callifiedLoading && (
              <div
                style={{
                  padding: "1rem",
                  marginBottom: "1.25rem",
                  borderRadius: "8px",
                  background: callifiedConnected
                    ? "rgba(16, 185, 129, 0.1)"
                    : "rgba(239, 68, 68, 0.1)",
                  border: `1px solid ${callifiedConnected ? "#10b981" : "#ef4444"}`,
                  display: "flex",
                  alignItems: "center",
                  gap: "0.75rem",
                }}
              >
                {callifiedConnected ? (
                  <>
                    <Check size={20} color="#10b981" />
                    <div style={{ flex: 1 }}>
                      <p
                        style={{
                          fontWeight: "500",
                          color: "#10b981",
                          margin: 0,
                        }}
                      >
                        ✓ Connected to Callified
                      </p>
                      {callifiedUpdatedAt && (
                        <p
                          style={{
                            color: "var(--text-secondary)",
                            fontSize: "0.75rem",
                            margin: "0.25rem 0 0 0",
                          }}
                        >
                          Connected since:{" "}
                          {new Date(callifiedUpdatedAt).toLocaleDateString()}
                        </p>
                      )}
                    </div>
                  </>
                ) : (
                  <>
                    <X size={20} color="#ef4444" />
                    <div style={{ flex: 1 }}>
                      <p
                        style={{
                          fontWeight: "500",
                          color: "#ef4444",
                          margin: 0,
                        }}
                      >
                        Not Connected
                      </p>
                      <p
                        style={{
                          color: "var(--text-secondary)",
                          fontSize: "0.75rem",
                          margin: "0.25rem 0 0 0",
                        }}
                      >
                        Add your API key to get started
                      </p>
                    </div>
                  </>
                )}
              </div>
            )}

            <p
              style={{
                color: "var(--text-secondary)",
                fontSize: "0.875rem",
                marginBottom: "1.25rem",
              }}
            >
              {callifiedConnected
                ? "Your Callified account is connected and ready to use."
                : "Enter your Callified API key to enable voice and WhatsApp integration."}
            </p>

            <form
              onSubmit={handleSaveCallifiedKey}
              style={{
                display: "flex",
                flexDirection: "column",
                gap: "0.75rem",
              }}
            >
              <div
                style={{
                  display: "flex",
                  gap: "0.75rem",
                  alignItems: "center",
                }}
              >
                <div style={{ position: "relative", flex: 1, minWidth: 0 }}>
                  <input
                    type={callifiedShowKey ? "text" : "password"}
                    className="input-field"
                    placeholder="callified_live_..."
                    value={callifiedApiKey}
                    onChange={(e) => setCallifiedApiKey(e.target.value)}
                    disabled={callifiedSaving}
                    style={{ width: "100%", minWidth: 0, paddingRight: "40px" }}
                  />
                  <button
                    type="button"
                    onClick={() => setCallifiedShowKey(!callifiedShowKey)}
                    disabled={callifiedSaving}
                    style={{
                      position: "absolute",
                      right: "0.75rem",
                      top: "50%",
                      transform: "translateY(-50%)",
                      background: "transparent",
                      border: "none",
                      color: "var(--text-secondary)",
                      cursor: "pointer",
                      padding: "0.25rem",
                      display: "flex",
                      alignItems: "center",
                    }}
                  >
                    {callifiedShowKey ? (
                      <EyeOff size={18} />
                    ) : (
                      <Eye size={18} />
                    )}
                  </button>
                </div>
                <button
                  type="submit"
                  className="btn-primary"
                  disabled={callifiedSaving || !callifiedApiKey.trim()}
                  style={{ whiteSpace: "nowrap" }}
                >
                  {callifiedSaving ? (
                    <>
                      <Loader
                        size={16}
                        style={{ animation: "spin 1s linear infinite" }}
                      />{" "}
                      {callifiedConnected ? "Updating..." : "Connecting..."}
                    </>
                  ) : callifiedConnected ? (
                    "Update Key"
                  ) : (
                    "Connect to Callified"
                  )}
                </button>
              </div>

              {callifiedConnected && (
                <button
                  type="button"
                  onClick={handleDisconnectCallified}
                  disabled={callifiedSaving}
                  style={{
                    padding: "0.75rem 1rem",
                    borderRadius: "6px",
                    background: "rgba(239, 68, 68, 0.1)",
                    color: "#ef4444",
                    border: "1px solid #ef4444",
                    cursor: "pointer",
                    fontSize: "0.875rem",
                    fontWeight: "500",
                    whiteSpace: "nowrap",
                  }}
                >
                  {callifiedSaving ? "Disconnecting..." : "Disconnect"}
                </button>
              )}
            </form>

            {callifiedMsg && (
              <p
                style={{
                  marginTop: "1rem",
                  fontSize: "0.85rem",
                  color:
                    callifiedMsg.includes("✓") ||
                    callifiedMsg.includes("Connected")
                      ? "var(--accent-color)"
                      : "var(--danger-color)",
                }}
              >
                {callifiedMsg}
              </p>
            )}
          </div>

          {/* AI Provider (Support Chatbot) — wellness-vertical BYOK card.
              Mounted only for wellness tenants whose user holds
              settings.manage (the catalog-backed gate for the wellness
              settings surface; there is no separate wellness_settings
              module in the permission catalog). The backend route
              (/api/wellness/ai-provider-config) enforces the same gate
              authoritatively. */}
          {ctxTenant?.vertical === "wellness" &&
            hasPermission("settings", "manage") && (
              <AiProviderConfigCard notify={notify} />
            )}

          {/* Webhook Signing Credential — per-tenant HMAC secret for outbound
              webhooks (GlobusPhone lead-sync). Self-contained admin component;
              ADMIN-only + subscription-gated server-side. */}
          <WebhookSigningCredential />

          {/* Notification Preferences Card */}
          <NotificationPreferencesCard notify={notify} />

          {/* Branding Card */}
          <div
            className="card"
            style={{ padding: "clamp(1.25rem, 3vw, 2rem)" }}
          >
            <h3
              style={{
                fontSize: "1.25rem",
                fontWeight: "600",
                marginBottom: "0.35rem",
                display: "flex",
                alignItems: "center",
                gap: "0.5rem",
              }}
            >
              <Palette size={20} color="var(--accent-color)" />
              {brandingSubBrand ? `Branding — ${subBrandShortLabel(brandingSubBrand)}` : "Branding"}
            </h3>
            <p
              style={{
                color: "var(--text-secondary)",
                fontSize: "0.875rem",
                marginBottom: "1.25rem",
              }}
            >
              {brandingSubBrand
                ? `Editing the logo and color for ${subBrandShortLabel(brandingSubBrand)}. Switch the Sub Brand dropdown in the sidebar to edit a different brand.`
                : "Upload your default logo and pick a brand color. These are the company-wide fallback shown in the sidebar and on branded PDFs whenever a sub-brand has no branding of its own."}
            </p>

            {/* #479: Branding two-column (Logo | Brand color) collapses to
              single-column under ~360px-each via auto-fit + minmax, fixing
              the "B colo..." label clip + "Save c..." button-text clip on
              ~425px viewports. */}
            <div
              style={{
                display: "grid",
                gridTemplateColumns:
                  "repeat(auto-fit, minmax(min(100%, 240px), 1fr))",
                gap: "2rem",
                alignItems: "start",
              }}
            >
              {/* Logo */}
              <div style={{ minWidth: 0 }}>
                <label
                  style={{
                    display: "block",
                    marginBottom: "0.5rem",
                    fontSize: "0.875rem",
                    color: "var(--text-secondary)",
                    fontWeight: 500,
                  }}
                >
                  <ImageIcon
                    size={14}
                    style={{ verticalAlign: "middle", marginRight: "0.35rem" }}
                  />{" "}
                  Logo
                </label>
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: "1rem",
                    marginBottom: "0.75rem",
                    flexWrap: "wrap",
                  }}
                >
                  {/* Preview tile — staged file wins over saved logo so the
                    user can see what they're about to commit. Broken
                    logoUrl falls back to a dashed placeholder instead of
                    leaving the classic broken-image icon in place. */}
                  {stagedPreviewUrl ? (
                    <div style={{ position: "relative" }}>
                      <img
                        src={stagedPreviewUrl}
                        alt="New logo preview"
                        style={{
                          width: 80,
                          height: 80,
                          borderRadius: 8,
                          objectFit: "cover",
                          border: "2px solid var(--accent-color)",
                        }}
                      />
                      <span
                        style={{
                          position: "absolute",
                          bottom: -8,
                          left: "50%",
                          transform: "translateX(-50%)",
                          background: "var(--accent-color)",
                          color: "#fff",
                          fontSize: "0.65rem",
                          padding: "0.1rem 0.45rem",
                          borderRadius: 999,
                          whiteSpace: "nowrap",
                          fontWeight: 600,
                        }}
                      >
                        Pending
                      </span>
                    </div>
                  ) : branding.logoUrl && !logoBroken ? (
                    <img
                      src={branding.logoUrl}
                      alt="Current logo"
                      onError={() => setLogoBroken(true)}
                      style={{
                        width: 80,
                        height: 80,
                        borderRadius: 8,
                        objectFit: "cover",
                        border: "1px solid var(--border-color)",
                      }}
                    />
                  ) : (
                    <div
                      style={{
                        width: 80,
                        height: 80,
                        borderRadius: 8,
                        border: "1px dashed var(--border-color)",
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "center",
                        color: "var(--text-secondary)",
                        fontSize: "0.7rem",
                        textAlign: "center",
                        flexDirection: "column",
                        gap: "0.2rem",
                      }}
                    >
                      <ImageIcon size={22} />
                      <span>{logoBroken ? "Image broken" : "No logo"}</span>
                    </div>
                  )}

                  {/* Hidden native input; visible buttons trigger it. */}
                  <input
                    ref={logoInputRef}
                    type="file"
                    accept="image/png,image/jpeg,image/gif,image/webp,image/svg+xml"
                    onChange={handlePickLogo}
                    style={{ display: "none" }}
                  />

                  <div
                    style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap" }}
                  >
                    {stagedLogo ? (
                      <>
                        <button
                          type="button"
                          className="btn-primary"
                          onClick={handleSaveLogo}
                          disabled={logoUploading}
                          style={{ whiteSpace: "nowrap" }}
                        >
                          {logoUploading ? "Uploading…" : "Save logo"}
                        </button>
                        <button
                          type="button"
                          onClick={() => logoInputRef.current?.click()}
                          disabled={logoUploading}
                          style={{
                            padding: "0.5rem 0.9rem",
                            background: "transparent",
                            border: "1px solid var(--border-color)",
                            borderRadius: 6,
                            color: "var(--text-primary)",
                            cursor: "pointer",
                            whiteSpace: "nowrap",
                          }}
                        >
                          Pick another
                        </button>
                        <button
                          type="button"
                          onClick={cancelStagedLogo}
                          disabled={logoUploading}
                          style={{
                            padding: "0.5rem 0.9rem",
                            background: "transparent",
                            border: "1px solid var(--border-color)",
                            borderRadius: 6,
                            color: "var(--danger-color, #ef4444)",
                            cursor: "pointer",
                            whiteSpace: "nowrap",
                          }}
                        >
                          Cancel
                        </button>
                      </>
                    ) : (
                      <>
                        <button
                          type="button"
                          className="btn-primary"
                          onClick={() => logoInputRef.current?.click()}
                          disabled={logoUploading}
                          style={{ whiteSpace: "nowrap" }}
                        >
                          {branding.logoUrl && !logoBroken
                            ? "Replace logo"
                            : "Upload logo"}
                        </button>
                        {branding.logoUrl && !logoBroken && (
                          <button
                            type="button"
                            onClick={handleDeleteLogo}
                            disabled={logoDeleting}
                            style={{
                              padding: "0.5rem 0.9rem",
                              background: "transparent",
                              border: "1px solid var(--border-color)",
                              borderRadius: 6,
                              color: "var(--danger-color, #ef4444)",
                              cursor: "pointer",
                              whiteSpace: "nowrap",
                            }}
                          >
                            {logoDeleting ? "Deleting…" : "Delete logo"}
                          </button>
                        )}
                      </>
                    )}
                  </div>
                </div>
                <p
                  style={{
                    color: "var(--text-secondary)",
                    fontSize: "0.75rem",
                  }}
                >
                  PNG, JPG, GIF, WEBP or SVG. Max 20 MB. Square works best.
                </p>
              </div>

              {/* Brand color */}
              <div style={{ minWidth: 0 }}>
                <label
                  style={{
                    display: "block",
                    marginBottom: "0.5rem",
                    fontSize: "0.875rem",
                    color: "var(--text-secondary)",
                    fontWeight: 500,
                  }}
                >
                  <Palette
                    size={14}
                    style={{ verticalAlign: "middle", marginRight: "0.35rem" }}
                  />{" "}
                  Brand color
                </label>
                {/* #479: flexWrap + whiteSpace:nowrap on the Save button so the
                  button stays as one piece ("Save c..." → "Save color") even
                  when wrapped to its own line. min-width:0 on the hex input
                  lets it shrink instead of pushing the button off-screen. */}
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: "0.75rem",
                    marginBottom: "0.75rem",
                    flexWrap: "wrap",
                  }}
                >
                  <input
                    type="color"
                    value={
                      /^#[0-9a-fA-F]{6}$/.test(branding.brandColor || "")
                        ? branding.brandColor
                        : DEFAULT_BRAND_COLOR
                    }
                    onChange={(e) =>
                      setBranding({ ...branding, brandColor: e.target.value })
                    }
                    style={{
                      width: 48,
                      height: 40,
                      border: "1px solid var(--border-color)",
                      borderRadius: 8,
                      cursor: "pointer",
                      padding: 2,
                      background: "var(--input-bg)",
                    }}
                  />
                  <input
                    type="text"
                    className="input-field"
                    placeholder={DEFAULT_BRAND_COLOR}
                    value={branding.brandColor || ""}
                    onChange={(e) =>
                      setBranding({ ...branding, brandColor: e.target.value })
                    }
                    style={{ flex: "1 1 120px", minWidth: 0 }}
                  />
                  <button
                    type="button"
                    className="btn-primary"
                    disabled={brandingSaving}
                    onClick={handleSaveBrandColor}
                    style={{ whiteSpace: "nowrap" }}
                  >
                    {brandingSaving ? "Saving..." : "Save color"}
                  </button>
                </div>
                <p
                  style={{
                    color: "var(--text-secondary)",
                    fontSize: "0.75rem",
                  }}
                >
                  6-digit hex. Leave blank to fall back to the default theme
                  accent.
                </p>
              </div>
            </div>

            {brandingMsg && (
              <p
                style={{
                  marginTop: "1rem",
                  fontSize: "0.85rem",
                  color: "var(--accent-color)",
                }}
              >
                {brandingMsg}
              </p>
            )}
          </div>

          {/* Your Brands — multi-brand (BrandKit) management. Travel-vertical
              only: sub-brands (TMC / RFU / Travel Stall / Visa Sure) are a
              travel-only concept, so generic/wellness tenants never see this
              card and their experience is byte-for-byte unchanged (single
              default brand above, no "Add Another Brand" affordance). Reuses
              the same /api/brand-kits backend the full /admin/brand-kits
              page manages — this card only handles the common "add a new
              brand with a logo + color" path; version history / advanced
              fields (fonts, PDF headers, etc.) stay on the dedicated page. */}
          {ctxTenant?.vertical === "travel" && (
            <div className="card" style={{ padding: "clamp(1.25rem, 3vw, 2rem)" }}>
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  marginBottom: "1rem",
                  flexWrap: "wrap",
                  gap: "0.75rem",
                }}
              >
                <h3
                  style={{
                    fontSize: "1.25rem",
                    fontWeight: "600",
                    display: "flex",
                    alignItems: "center",
                    gap: "0.5rem",
                    margin: 0,
                  }}
                >
                  <Palette size={20} color="var(--accent-color)" /> Your Brands
                </h3>
                <div style={{ display: "flex", alignItems: "center", gap: "0.75rem" }}>
                  <Link
                    to="/admin/brand-kits"
                    style={{ fontSize: "0.8rem", color: "var(--accent-color)", display: "inline-flex", alignItems: "center", gap: 4 }}
                  >
                    Manage all brands <ArrowRight size={13} />
                  </Link>
                  {availableSubBrands.length > 0 && (
                    <button
                      type="button"
                      className="btn-primary"
                      onClick={openAddBrand}
                      style={{ display: "inline-flex", alignItems: "center", gap: 6, whiteSpace: "nowrap" }}
                    >
                      <Plus size={15} /> Add Another Brand
                    </button>
                  )}
                </div>
              </div>
              <p style={{ color: "var(--text-secondary)", fontSize: "0.875rem", marginBottom: "1.25rem" }}>
                Give each sub-brand its own logo and color. The sidebar shows a brand's own
                logo when set, and falls back to the default brand above otherwise.
              </p>

              {brandKitsLoading ? (
                <p style={{ color: "var(--text-secondary)", fontSize: "0.85rem" }}>Loading…</p>
              ) : (
                <div style={{ display: "flex", flexDirection: "column", gap: "0.5rem" }}>
                  {SUB_BRAND_IDS.map((id) => {
                    const kit = brandKits.find((k) => k.subBrand === id);
                    return (
                      <div
                        key={id}
                        style={{
                          display: "flex",
                          alignItems: "center",
                          gap: "0.75rem",
                          padding: "0.6rem 0.85rem",
                          borderRadius: 8,
                          border: "1px solid var(--border-color)",
                          background: subBrandBackground(id),
                        }}
                      >
                        {kit?.logoUrl ? (
                          <img
                            src={kit.logoUrl}
                            alt=""
                            style={{ width: 32, height: 32, borderRadius: 6, objectFit: "cover" }}
                          />
                        ) : (
                          <div
                            style={{
                              width: 32,
                              height: 32,
                              borderRadius: 6,
                              border: "1px dashed var(--border-color)",
                              display: "flex",
                              alignItems: "center",
                              justifyContent: "center",
                              color: "var(--text-secondary)",
                            }}
                          >
                            <ImageIcon size={14} />
                          </div>
                        )}
                        <span style={{ display: "flex", alignItems: "center", gap: "0.5rem", fontWeight: 500, fontSize: "0.9rem", flex: 1 }}>
                          {subBrandShortLabel(id)}
                          {ctxTenant?.defaultSubBrand === id && (
                            <span
                              style={{
                                fontSize: "0.65rem", fontWeight: 700, textTransform: "uppercase",
                                padding: "0.15rem 0.45rem", borderRadius: 999,
                                background: "var(--accent-color)", color: "#fff",
                              }}
                            >
                              Default
                            </span>
                          )}
                        </span>
                        {kit ? (
                          <div style={{ display: "flex", alignItems: "center", gap: "0.75rem" }}>
                            {ctxTenant?.defaultSubBrand !== id && (
                              <button
                                type="button"
                                onClick={() => handleSetDefaultBrand(kit)}
                                disabled={settingDefaultId === kit.id}
                                style={{ fontSize: "0.8rem", color: "var(--text-secondary)", background: "none", border: "none", cursor: "pointer", padding: 0 }}
                              >
                                {settingDefaultId === kit.id ? "Setting…" : "Set as Default"}
                              </button>
                            )}
                            <button
                              type="button"
                              onClick={() => openEditBrand(kit)}
                              style={{ fontSize: "0.8rem", color: "var(--accent-color)", background: "none", border: "none", cursor: "pointer", padding: 0 }}
                            >
                              Edit logo / color
                            </button>
                          </div>
                        ) : (
                          <button
                            type="button"
                            onClick={() => {
                              setEditingKit(null);
                              setAddBrandForm({ subBrand: id, logoUrl: "", primaryColor: "" });
                              pickAddBrandFile(null);
                              setAddBrandError("");
                              setShowAddBrand(true);
                            }}
                            style={{ fontSize: "0.8rem", color: "var(--accent-color)", background: "none", border: "none", cursor: "pointer", padding: 0 }}
                          >
                            + Set up
                          </button>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          )}

          {/* Add Another Brand — compact modal. Uploads a logo (optional) via
              /api/brand-kits/upload, then creates the active BrandKit row.
              Advanced fields stay on /admin/brand-kits. */}
          {showAddBrand && (
            <div
              onClick={() => !addBrandSaving && setShowAddBrand(false)}
              style={{
                position: "fixed",
                inset: 0,
                background: "rgba(0,0,0,0.5)",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                zIndex: 1000,
              }}
            >
              <form
                onClick={(e) => e.stopPropagation()}
                onSubmit={handleAddBrandSubmit}
                className="card"
                style={{ width: "min(94vw, 420px)", padding: "1.5rem" }}
              >
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "1rem" }}>
                  <h3 style={{ margin: 0, fontSize: "1.1rem", fontWeight: 600 }}>
                    {editingKit ? `Edit ${subBrandShortLabel(editingKit.subBrand)} branding` : "Add Another Brand"}
                  </h3>
                  <button
                    type="button"
                    onClick={() => setShowAddBrand(false)}
                    disabled={addBrandSaving}
                    style={{ background: "none", border: "none", cursor: "pointer", color: "var(--text-secondary)" }}
                  >
                    <X size={18} />
                  </button>
                </div>

                <label style={{ display: "block", marginBottom: "0.4rem", fontSize: "0.85rem", fontWeight: 500 }}>
                  Brand Name *
                </label>
                {editingKit ? (
                  <input
                    className="input-field"
                    disabled
                    value={subBrandShortLabel(editingKit.subBrand)}
                    style={{ width: "100%", marginBottom: "1rem" }}
                  />
                ) : (
                  <select
                    className="input-field"
                    required
                    value={addBrandForm.subBrand}
                    onChange={(e) => setAddBrandForm({ ...addBrandForm, subBrand: e.target.value })}
                    style={{ width: "100%", marginBottom: "1rem" }}
                  >
                    {availableSubBrands.map((id) => (
                      <option key={id} value={id}>{subBrandShortLabel(id)}</option>
                    ))}
                  </select>
                )}

                <label style={{ display: "block", marginBottom: "0.4rem", fontSize: "0.85rem", fontWeight: 500 }}>
                  Brand Logo {editingKit ? "" : "(optional)"}
                </label>
                <div style={{ display: "flex", alignItems: "center", gap: "0.75rem", marginBottom: "1rem" }}>
                  {addBrandFilePreviewUrl ? (
                    <img
                      src={addBrandFilePreviewUrl}
                      alt="New logo preview"
                      style={{ width: 44, height: 44, borderRadius: 6, objectFit: "cover", border: "1px solid var(--accent-color)" }}
                    />
                  ) : addBrandForm.logoUrl ? (
                    <img
                      src={addBrandForm.logoUrl}
                      alt="Current logo"
                      style={{ width: 44, height: 44, borderRadius: 6, objectFit: "cover", border: "1px solid var(--border-color)" }}
                    />
                  ) : (
                    <div
                      style={{
                        width: 44, height: 44, borderRadius: 6, border: "1px dashed var(--border-color)",
                        display: "flex", alignItems: "center", justifyContent: "center", color: "var(--text-secondary)",
                      }}
                    >
                      <ImageIcon size={16} />
                    </div>
                  )}
                  <input
                    type="file"
                    accept="image/png,image/jpeg,image/webp,image/svg+xml"
                    onChange={(e) => pickAddBrandFile(e.target.files?.[0] || null)}
                    style={{ flex: 1, minWidth: 0, fontSize: "0.85rem" }}
                  />
                </div>

                <label style={{ display: "block", marginBottom: "0.4rem", fontSize: "0.85rem", fontWeight: 500 }}>
                  Brand Color (optional)
                </label>
                <div style={{ display: "flex", gap: "0.5rem", marginBottom: "1rem" }}>
                  <input
                    type="color"
                    value={/^#[0-9a-fA-F]{6}$/.test(addBrandForm.primaryColor) ? addBrandForm.primaryColor : DEFAULT_BRAND_COLOR}
                    onChange={(e) => setAddBrandForm({ ...addBrandForm, primaryColor: e.target.value })}
                    style={{ width: 44, height: 38, border: "1px solid var(--border-color)", borderRadius: 6, cursor: "pointer", padding: 2 }}
                  />
                  <input
                    type="text"
                    className="input-field"
                    placeholder={DEFAULT_BRAND_COLOR}
                    value={addBrandForm.primaryColor}
                    onChange={(e) => setAddBrandForm({ ...addBrandForm, primaryColor: e.target.value })}
                    style={{ flex: 1, minWidth: 0 }}
                  />
                </div>

                {addBrandError && (
                  <p style={{ color: "var(--danger-color, #ef4444)", fontSize: "0.8rem", marginBottom: "1rem" }}>
                    {addBrandError}
                  </p>
                )}

                <div style={{ display: "flex", gap: "0.5rem", justifyContent: "flex-end" }}>
                  <button
                    type="button"
                    onClick={() => setShowAddBrand(false)}
                    disabled={addBrandSaving}
                    style={{ padding: "0.5rem 1rem", background: "transparent", border: "1px solid var(--border-color)", borderRadius: 6, color: "var(--text-primary)", cursor: "pointer" }}
                  >
                    Cancel
                  </button>
                  <button type="submit" className="btn-primary" disabled={addBrandSaving}>
                    {addBrandSaving ? "Saving…" : editingKit ? "Save changes" : "Save Brand"}
                  </button>
                </div>
              </form>
            </div>
          )}

          {/* Role Recovery — secondary entry point for the version-history /
              restore flow. Reuses the same backend endpoints the Roles &
              Permissions page uses; lives here so it stays reachable when
              `roles.read` has been lost on the user's role. Renders only
              when the user holds either roles.read OR settings.manage — the
              same OR-gate the backend endpoints enforce, so a render here
              and a successful API call always agree. */}
          {canSeeRecoverySection && (
            <div
              className="card"
              data-testid="settings-role-recovery-card"
              style={{ padding: "clamp(1.25rem, 3vw, 2rem)" }}
            >
              <h3
                style={{
                  fontSize: "1.25rem",
                  fontWeight: "600",
                  marginBottom: "0.5rem",
                  display: "flex",
                  alignItems: "center",
                  gap: "0.5rem",
                }}
              >
                <FileSignature size={18} /> Role Recovery
              </h3>
              <p
                style={{
                  color: "var(--text-secondary)",
                  fontSize: "0.85rem",
                  marginTop: 0,
                  marginBottom: "1rem",
                }}
              >
                Roll back a role's permissions to a previous saved version.
                Useful when a role's critical permissions are accidentally
                removed and the Roles &amp; Permissions page is no longer
                reachable.
                {!canRecover && (
                  <>
                    {" "}
                    You can review history here, but restoring a version
                    requires either <code>roles.manage</code> or{" "}
                    <code>settings.manage</code>.
                  </>
                )}
              </p>

              {recoveryLoading && (
                <p style={{ color: "var(--text-secondary)", fontSize: "0.85rem" }}>
                  Loading roles…
                </p>
              )}
              {recoveryError && !recoveryLoading && (
                <p
                  role="alert"
                  style={{
                    color: "#ef4444",
                    fontSize: "0.85rem",
                    background: "rgba(239,68,68,0.08)",
                    border: "1px solid rgba(239,68,68,0.4)",
                    borderRadius: 6,
                    padding: "0.5rem 0.7rem",
                  }}
                >
                  {recoveryError}
                </p>
              )}
              {!recoveryLoading && !recoveryError && recoveryRoles.length === 0 && (
                <p style={{ color: "var(--text-secondary)", fontSize: "0.85rem" }}>
                  No roles found for this tenant.
                </p>
              )}
              {!recoveryLoading && recoveryRoles.length > 0 && (
                <ul
                  data-testid="settings-role-recovery-list"
                  style={{
                    listStyle: "none",
                    padding: 0,
                    margin: 0,
                    display: "flex",
                    flexDirection: "column",
                    gap: "0.4rem",
                  }}
                >
                  {recoveryRoles.map((r) => (
                    <li
                      key={r.id}
                      style={{
                        padding: "0.55rem 0.7rem",
                        border: "1px solid var(--border-color)",
                        borderRadius: 8,
                        background: "var(--subtle-bg-1)",
                        display: "flex",
                        alignItems: "center",
                        gap: "0.75rem",
                      }}
                    >
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontWeight: 600, fontSize: "0.9rem" }}>
                          {r.name}
                          <code
                            style={{
                              marginLeft: "0.5rem",
                              fontSize: "0.72rem",
                              color: "var(--text-secondary)",
                            }}
                          >
                            {r.key}
                          </code>
                        </div>
                        {r.description && (
                          <div
                            style={{
                              fontSize: "0.75rem",
                              color: "var(--text-secondary)",
                              marginTop: "0.15rem",
                            }}
                          >
                            {r.description}
                          </div>
                        )}
                      </div>
                      <button
                        type="button"
                        className="btn-secondary"
                        style={{ fontSize: "0.78rem", padding: "0.3rem 0.7rem" }}
                        onClick={() => setRecoveryDialogRole(r)}
                        data-testid={`settings-role-recovery-open-${r.key}`}
                      >
                        View history
                      </button>
                    </li>
                  ))}
                </ul>
              )}

              <RoleHistoryDialog
                role={recoveryDialogRole}
                canManage={canRecover}
                open={!!recoveryDialogRole}
                onClose={() => setRecoveryDialogRole(null)}
                onRestored={() => {
                  setRecoveryDialogRole(null);
                  loadRecoveryRoles();
                }}
              />
            </div>
          )}
      </div>
    </div>
  );
}

// #612: per-tenant consent template CRUD. Wellness-only — gated by
// tenant.vertical === 'wellness' at the call site. Pre-fix the consent
// dropdown was hardcoded to 5 procedure types; clinics with paediatric or
// procedure-specific flows had no way to add their own legally-vetted
// wording. The first GET auto-seeds the 5 starter rows server-side.
function ConsentTemplatesCard({ notify }) {
  const [templates, setTemplates] = useState([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [newTemplate, setNewTemplate] = useState({
    key: "",
    label: "",
    body: "",
  });

  const load = () => {
    fetchApi("/api/wellness/consent-templates")
      .then((res) => {
        setTemplates(Array.isArray(res) ? res : []);
        setLoading(false);
      })
      .catch(() => setLoading(false));
  };
  useEffect(() => {
    load();
  }, []);

  const create = async (e) => {
    e.preventDefault();
    if (!newTemplate.key.trim() || !newTemplate.label.trim()) return;
    setCreating(true);
    try {
      await fetchApi("/api/wellness/consent-templates", {
        method: "POST",
        body: JSON.stringify(newTemplate),
      });
      setNewTemplate({ key: "", label: "", body: "" });
      load();
      notify.success("Consent template created");
    } catch (err) {
      notify.error(err?.message || "Failed to create template");
    } finally {
      setCreating(false);
    }
  };

  const toggleActive = async (t) => {
    try {
      await fetchApi(`/api/wellness/consent-templates/${t.id}`, {
        method: "PUT",
        body: JSON.stringify({ isActive: !t.isActive }),
      });
      load();
    } catch {
      notify.error("Failed to update template");
    }
  };

  const remove = async (t) => {
    if (
      !(await notify.confirm({
        title: "Delete consent template?",
        message: `"${t.label}" will be removed from the dropdown. Already-signed forms keep their original template name.`,
        confirmText: "Delete",
        destructive: true,
      }))
    )
      return;
    try {
      await fetchApi(`/api/wellness/consent-templates/${t.id}`, {
        method: "DELETE",
      });
      load();
    } catch {
      notify.error("Failed to delete template");
    }
  };

  return (
    <div
      className="card"
      style={{ padding: "clamp(1.25rem, 3vw, 2rem)" }}
      data-testid="consent-templates-card"
    >
      <h3
        style={{
          fontSize: "1.25rem",
          fontWeight: "600",
          marginBottom: "1rem",
          display: "flex",
          alignItems: "center",
          gap: "0.5rem",
        }}
      >
        <FileSignature size={20} color="var(--accent-color)" /> Consent
        Templates
      </h3>
      <p
        style={{
          color: "var(--text-secondary)",
          fontSize: "0.875rem",
          marginBottom: "1.25rem",
        }}
      >
        Manage the consent forms shown when capturing patient signatures. Add
        procedure-specific or paediatric variants. Templates are tenant-scoped.
      </p>
      {loading ? (
        <p>Loading…</p>
      ) : (
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            gap: "0.5rem",
            marginBottom: "1.5rem",
          }}
        >
          {templates.length === 0 && (
            <p style={{ color: "var(--text-secondary)", fontSize: "0.875rem" }}>
              No templates yet.
            </p>
          )}
          {templates.map((t) => (
            <div
              key={t.id}
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                gap: "0.75rem",
                padding: "0.75rem 1rem",
                background: "var(--surface-color)",
                border: "1px solid var(--border-color)",
                borderRadius: 8,
                opacity: t.isActive ? 1 : 0.55,
              }}
            >
              <div style={{ minWidth: 0, flex: 1 }}>
                <div style={{ fontWeight: 500 }}>
                  {t.label}{" "}
                  {t.isSeed && (
                    <span
                      style={{
                        fontSize: "0.7rem",
                        color: "var(--text-secondary)",
                        marginLeft: "0.5rem",
                      }}
                    >
                      (starter)
                    </span>
                  )}
                </div>
                <div
                  style={{
                    color: "var(--text-secondary)",
                    fontSize: "0.75rem",
                  }}
                >
                  key: {t.key}
                </div>
              </div>
              <button
                type="button"
                onClick={() => toggleActive(t)}
                style={{
                  background: "transparent",
                  border: "1px solid var(--border-color)",
                  color: "var(--text-secondary)",
                  padding: "0.3rem 0.65rem",
                  borderRadius: 6,
                  cursor: "pointer",
                  fontSize: "0.75rem",
                }}
              >
                {t.isActive ? "Disable" : "Enable"}
              </button>
              <button
                type="button"
                onClick={() => remove(t)}
                aria-label={`Delete template ${t.label}`}
                style={{
                  background: "transparent",
                  border: "none",
                  color: "var(--danger-color)",
                  cursor: "pointer",
                  padding: "0.25rem",
                }}
              >
                <Trash2 size={16} />
              </button>
            </div>
          ))}
        </div>
      )}
      <form
        onSubmit={create}
        style={{
          display: "grid",
          gridTemplateColumns:
            "repeat(auto-fit, minmax(min(100%, 200px), 1fr))",
          gap: "0.75rem",
        }}
      >
        <input
          type="text"
          placeholder="Key (e.g. paediatric)"
          required
          className="input-field"
          value={newTemplate.key}
          onChange={(e) =>
            setNewTemplate({ ...newTemplate, key: e.target.value })
          }
        />
        <input
          type="text"
          placeholder="Label (e.g. Paediatric Consent)"
          required
          className="input-field"
          value={newTemplate.label}
          onChange={(e) =>
            setNewTemplate({ ...newTemplate, label: e.target.value })
          }
        />
        <button
          type="submit"
          className="btn-primary"
          disabled={creating}
          style={{
            gridColumn: "1 / -1",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            gap: "0.5rem",
            whiteSpace: "nowrap",
          }}
        >
          <Plus size={16} /> {creating ? "Adding…" : "Add Template"}
        </button>
      </form>
    </div>
  );
}

// Option B: per-tenant wellness role catalog. Admins add roles like
// "nurse" or "physiotherapist" here; the Calendar grid + Staff edit form
// read from this catalog so a new role surfaces immediately without a
// code change. canTakeVisits controls whether the role appears as a
// column on the Calendar (doctors/nurses yes, telecallers/helpers no).
function WellnessRoleTypesCard({ notify }) {
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [newRow, setNewRow] = useState({
    key: "",
    label: "",
    canTakeVisits: true,
  });

  const load = () => {
    fetchApi("/api/wellness/role-types")
      .then((res) => {
        setRows(Array.isArray(res) ? res : []);
        setLoading(false);
      })
      .catch(() => setLoading(false));
  };
  useEffect(() => {
    load();
  }, []);

  const create = async (e) => {
    e.preventDefault();
    const key = newRow.key.trim();
    const label = newRow.label.trim();
    if (!key || !label) return;
    setCreating(true);
    try {
      await fetchApi("/api/wellness/role-types", {
        method: "POST",
        body: JSON.stringify({
          key,
          label,
          canTakeVisits: newRow.canTakeVisits,
        }),
      });
      setNewRow({ key: "", label: "", canTakeVisits: true });
      load();
      notify.success(`Role "${label}" added`);
    } catch (err) {
      notify.error(err?.message || "Failed to add role");
    } finally {
      setCreating(false);
    }
  };

  const toggleActive = async (r) => {
    try {
      await fetchApi(`/api/wellness/role-types/${r.id}`, {
        method: "PUT",
        body: JSON.stringify({ isActive: !r.isActive }),
      });
      load();
    } catch {
      notify.error("Failed to update role");
    }
  };

  const toggleCanTakeVisits = async (r) => {
    try {
      await fetchApi(`/api/wellness/role-types/${r.id}`, {
        method: "PUT",
        body: JSON.stringify({ canTakeVisits: !r.canTakeVisits }),
      });
      load();
    } catch {
      notify.error("Failed to update role");
    }
  };

  const remove = async (r) => {
    if (
      !(await notify.confirm({
        title: "Delete role?",
        message: `"${r.label}" will be removed from the catalog. Staff currently assigned to this role will block the delete.`,
        confirmText: "Delete",
        destructive: true,
      }))
    )
      return;
    try {
      await fetchApi(`/api/wellness/role-types/${r.id}`, { method: "DELETE" });
      load();
    } catch (err) {
      // Backend returns 409 ROLE_IN_USE with an "in use by N staff" message
      // when applicable — surface that directly so the admin knows what to
      // do next (reassign or deactivate instead).
      notify.error(err?.message || "Failed to delete role");
    }
  };

  return (
    <div
      className="card"
      style={{ padding: "clamp(1.25rem, 3vw, 2rem)" }}
      data-testid="wellness-role-types-card"
    >
      <h3
        style={{
          fontSize: "1.25rem",
          fontWeight: "600",
          marginBottom: "1rem",
          display: "flex",
          alignItems: "center",
          gap: "0.5rem",
        }}
      >
        <Stethoscope size={20} color="var(--accent-color)" /> Wellness Role
        Types
      </h3>
      <p
        style={{
          color: "var(--text-secondary)",
          fontSize: "0.875rem",
          marginBottom: "1.25rem",
        }}
      >
        Define the staff roles available in your clinic (doctor, nurse,
        telecaller, etc.). Roles with <strong>Takes visits</strong> appear as
        columns on the Calendar grid.
      </p>
      {loading ? (
        <p>Loading…</p>
      ) : (
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            gap: "0.5rem",
            marginBottom: "1.5rem",
          }}
        >
          {rows.length === 0 && (
            <p style={{ color: "var(--text-secondary)", fontSize: "0.875rem" }}>
              No roles yet.
            </p>
          )}
          {rows.map((r) => (
            <div
              key={r.id}
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                gap: "0.75rem",
                padding: "0.75rem 1rem",
                background: "var(--surface-color)",
                border: "1px solid var(--border-color)",
                borderRadius: 8,
                opacity: r.isActive ? 1 : 0.55,
              }}
            >
              <div style={{ minWidth: 0, flex: 1 }}>
                <div style={{ fontWeight: 500 }}>{r.label}</div>
                <div
                  style={{
                    color: "var(--text-secondary)",
                    fontSize: "0.75rem",
                  }}
                >
                  key: {r.key}
                  {r.canTakeVisits
                    ? " · takes visits"
                    : " · operational (no calendar column)"}
                </div>
              </div>
              <button
                type="button"
                onClick={() => toggleCanTakeVisits(r)}
                style={{
                  background: "transparent",
                  border: "1px solid var(--border-color)",
                  color: "var(--text-secondary)",
                  padding: "0.3rem 0.65rem",
                  borderRadius: 6,
                  cursor: "pointer",
                  fontSize: "0.75rem",
                }}
              >
                {r.canTakeVisits ? "Hide from calendar" : "Show on calendar"}
              </button>
              <button
                type="button"
                onClick={() => toggleActive(r)}
                style={{
                  background: "transparent",
                  border: "1px solid var(--border-color)",
                  color: "var(--text-secondary)",
                  padding: "0.3rem 0.65rem",
                  borderRadius: 6,
                  cursor: "pointer",
                  fontSize: "0.75rem",
                }}
              >
                {r.isActive ? "Deactivate" : "Activate"}
              </button>
              <button
                type="button"
                onClick={() => remove(r)}
                aria-label={`Delete role ${r.label}`}
                style={{
                  background: "transparent",
                  border: "none",
                  color: "var(--danger-color)",
                  cursor: "pointer",
                  padding: "0.25rem",
                }}
              >
                <Trash2 size={16} />
              </button>
            </div>
          ))}
        </div>
      )}
      <form
        onSubmit={create}
        style={{
          display: "grid",
          gridTemplateColumns:
            "repeat(auto-fit, minmax(min(100%, 200px), 1fr))",
          gap: "0.75rem",
          alignItems: "center",
        }}
      >
        <input
          type="text"
          placeholder="Key (e.g. nurse)"
          required
          pattern="^[a-z][a-z0-9]*(-[a-z0-9]+)*$"
          title="Lowercase letters, digits, hyphens. Must start with a letter."
          className="input-field"
          value={newRow.key}
          onChange={(e) => setNewRow({ ...newRow, key: e.target.value })}
        />
        <input
          type="text"
          placeholder="Label (e.g. Nurse)"
          required
          className="input-field"
          value={newRow.label}
          onChange={(e) => setNewRow({ ...newRow, label: e.target.value })}
        />
        <label
          style={{
            display: "flex",
            alignItems: "center",
            gap: "0.5rem",
            fontSize: "0.85rem",
            color: "var(--text-primary)",
          }}
        >
          <input
            type="checkbox"
            checked={newRow.canTakeVisits}
            onChange={(e) =>
              setNewRow({ ...newRow, canTakeVisits: e.target.checked })
            }
          />
          Takes visits
        </label>
        <button
          type="submit"
          className="btn-primary"
          disabled={creating}
          style={{
            gridColumn: "1 / -1",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            gap: "0.5rem",
            whiteSpace: "nowrap",
          }}
        >
          <Plus size={16} /> {creating ? "Adding…" : "Add Role"}
        </button>
      </form>
    </div>
  );
}

// ─── AI Provider (Support Chatbot) ──────────────────────────────────────────
// BYOK management for the Wellness Admin Support Chatbot. Backs
// /api/wellness/ai-provider-config (GET/POST/POST test/DELETE). The stored
// apiKey is AES-256-GCM encrypted server-side; this card only ever sees the
// masked form (sk-...XXXX). Saving with the masked placeholder still in the
// key field keeps the stored key (server-side behaviour), so model/baseUrl
// can be edited without re-entering the secret.
function AiProviderConfigCard({ notify }) {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [configured, setConfigured] = useState(false);
  const [fallback, setFallback] = useState(null); // 'internal' | 'none' when unconfigured
  const [maskedKey, setMaskedKey] = useState(null);
  const [provider, setProvider] = useState("gemini");
  const [apiKey, setApiKey] = useState("");
  const [model, setModel] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [showKey, setShowKey] = useState(false);
  const [msg, setMsg] = useState("");

  const load = async () => {
    try {
      const res = await fetchApi("/api/wellness/ai-provider-config");
      if (res.configured) {
        setConfigured(true);
        setProvider(res.provider || "gemini");
        setModel(res.model || "");
        setBaseUrl(res.baseUrl || "");
        setMaskedKey(res.maskedApiKey || null);
        setApiKey(res.maskedApiKey || "");
      } else {
        setConfigured(false);
        setFallback(res.fallback || "none");
      }
    } catch (_err) {
      setMsg("Could not load the current AI provider config.");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleSave = async (e) => {
    e.preventDefault();
    setSaving(true);
    setMsg("");
    try {
      const res = await fetchApi("/api/wellness/ai-provider-config", {
        method: "POST",
        body: JSON.stringify({
          provider,
          apiKey: apiKey.trim(),
          model: model.trim(),
          baseUrl: baseUrl.trim(),
        }),
      });
      setConfigured(true);
      setMaskedKey(res.maskedApiKey || null);
      setApiKey(res.maskedApiKey || "");
      setMsg("✓ AI provider saved — the support chatbot will use it for new chats.");
    } catch (err) {
      setMsg(err.message || "Failed to save AI provider config.");
    } finally {
      setSaving(false);
    }
  };

  const handleTest = async () => {
    setTesting(true);
    setMsg("");
    try {
      const res = await fetchApi("/api/wellness/ai-provider-config/test", {
        method: "POST",
        body: JSON.stringify(
          apiKey.trim() && !apiKey.includes("...")
            ? { provider, apiKey: apiKey.trim(), model: model.trim(), baseUrl: baseUrl.trim() }
            : {},
        ),
      });
      setMsg(`✓ Connection OK (${res.provider} / ${res.model}, ${res.latencyMs} ms).`);
    } catch (err) {
      setMsg(err.message || "Provider test failed.");
    } finally {
      setTesting(false);
    }
  };

  const handleRemove = async () => {
    setRemoving(true);
    setMsg("");
    try {
      await fetchApi("/api/wellness/ai-provider-config", { method: "DELETE" });
      setConfigured(false);
      setMaskedKey(null);
      setApiKey("");
      setModel("");
      setBaseUrl("");
      setMsg("✓ AI provider removed.");
      await load();
    } catch (err) {
      setMsg(err.message || "Failed to remove AI provider config.");
    } finally {
      setRemoving(false);
    }
  };

  return (
    <div
      className="card"
      data-testid="ai-provider-config-card"
      style={{ padding: "clamp(1.25rem, 3vw, 2rem)" }}
    >
      <h3
        style={{
          fontSize: "1.25rem",
          fontWeight: "600",
          marginBottom: "1rem",
          display: "flex",
          alignItems: "center",
          gap: "0.5rem",
        }}
      >
        <Bot size={20} color="var(--accent-color)" /> AI Provider (Support
        Chatbot)
      </h3>

      {!loading && (
        <div
          style={{
            padding: "1rem",
            marginBottom: "1.25rem",
            borderRadius: "8px",
            background: configured ? "rgba(16, 185, 129, 0.1)" : "rgba(245, 158, 11, 0.1)",
            border: `1px solid ${configured ? "#10b981" : "#f59e0b"}`,
            display: "flex",
            alignItems: "center",
            gap: "0.75rem",
          }}
        >
          {configured ? (
            <>
              <Check size={20} color="#10b981" />
              <div style={{ flex: 1 }}>
                <p style={{ fontWeight: "500", color: "#10b981", margin: 0 }}>
                  ✓ {provider === "gemini" ? "Gemini" : "OpenAI-compatible"} key configured
                </p>
                <p style={{ color: "var(--text-secondary)", fontSize: "0.75rem", margin: "0.25rem 0 0 0" }}>
                  {maskedKey ? `Key: ${maskedKey}` : ""}
                  {model ? `${maskedKey ? " · " : ""}Model: ${model}` : ""}
                </p>
              </div>
            </>
          ) : (
            <>
              <X size={20} color="#f59e0b" />
              <div style={{ flex: 1 }}>
                <p style={{ fontWeight: "500", color: "#f59e0b", margin: 0 }}>
                  {fallback === "internal"
                    ? "Using the shared internal provider (non-production fallback)"
                    : "No AI provider configured"}
                </p>
                <p style={{ color: "var(--text-secondary)", fontSize: "0.75rem", margin: "0.25rem 0 0 0" }}>
                  {fallback === "internal"
                    ? "Add your own key below to take control of model and spend."
                    : "The support chatbot is disabled until a provider key is added."}
                </p>
              </div>
            </>
          )}
        </div>
      )}

      <p style={{ color: "var(--text-secondary)", fontSize: "0.875rem", marginBottom: "1.25rem" }}>
        Powers the floating support assistant for clinic staff. The key is
        stored encrypted and never shown again after saving.
      </p>

      <form onSubmit={handleSave} style={{ display: "flex", flexDirection: "column", gap: "0.75rem" }}>
        <select
          className="input-field"
          data-testid="ai-provider-select"
          value={provider}
          onChange={(e) => setProvider(e.target.value)}
          disabled={saving}
          style={{ background: "var(--input-bg)" }}
        >
          <option value="gemini">Gemini (Google generateContent)</option>
          <option value="openai-compatible">OpenAI-compatible (chat completions)</option>
        </select>

        <div style={{ position: "relative" }}>
          <input
            type={showKey ? "text" : "password"}
            className="input-field"
            data-testid="ai-provider-key-input"
            placeholder={provider === "gemini" ? "AIza..." : "sk-..."}
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            disabled={saving}
            autoComplete="new-password"
            style={{ width: "100%", minWidth: 0, paddingRight: "40px" }}
          />
          <button
            type="button"
            onClick={() => setShowKey(!showKey)}
            disabled={saving}
            aria-label={showKey ? "Hide API key" : "Show API key"}
            style={{
              position: "absolute",
              right: "0.75rem",
              top: "50%",
              transform: "translateY(-50%)",
              background: "transparent",
              border: "none",
              color: "var(--text-secondary)",
              cursor: "pointer",
              padding: "0.25rem",
              display: "flex",
              alignItems: "center",
            }}
          >
            {showKey ? <EyeOff size={18} /> : <Eye size={18} />}
          </button>
        </div>

        <input
          type="text"
          className="input-field"
          data-testid="ai-provider-model-input"
          placeholder={provider === "gemini" ? "Model (default: gemini-2.5-flash-lite)" : "Model (e.g. gpt-4o-mini)"}
          value={model}
          onChange={(e) => setModel(e.target.value)}
          disabled={saving}
        />
        <input
          type="text"
          className="input-field"
          placeholder="Base URL (optional — custom/proxy endpoint)"
          value={baseUrl}
          onChange={(e) => setBaseUrl(e.target.value)}
          disabled={saving}
        />

        <div style={{ display: "flex", gap: "0.75rem", flexWrap: "wrap" }}>
          <button type="submit" className="btn-primary" disabled={saving || !apiKey.trim()} style={{ whiteSpace: "nowrap" }}>
            {saving ? "Saving..." : configured ? "Update Provider" : "Save Provider"}
          </button>
          <button
            type="button"
            className="btn-secondary"
            data-testid="ai-provider-test-btn"
            onClick={handleTest}
            disabled={testing || (!configured && !apiKey.trim())}
            style={{ whiteSpace: "nowrap" }}
          >
            {testing ? "Testing..." : "Test Connection"}
          </button>
          {configured && (
            <button
              type="button"
              onClick={handleRemove}
              disabled={removing}
              style={{
                padding: "0.75rem 1rem",
                borderRadius: "6px",
                background: "rgba(239, 68, 68, 0.1)",
                color: "#ef4444",
                border: "1px solid #ef4444",
                cursor: "pointer",
                fontSize: "0.875rem",
                fontWeight: "500",
                whiteSpace: "nowrap",
              }}
            >
              {removing ? "Removing..." : "Remove"}
            </button>
          )}
        </div>
      </form>

      {msg && (
        <p
          data-testid="ai-provider-msg"
          style={{
            marginTop: "1rem",
            fontSize: "0.85rem",
            color: msg.startsWith("✓") ? "var(--accent-color)" : "var(--danger-color)",
          }}
        >
          {msg}
        </p>
      )}
    </div>
  );
}

// Notification Preferences — per-user opt-in/out of categories, channels, and quiet hours
function NotificationPreferencesCard({ notify }) {
  const [prefs, setPrefs] = useState(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  // Category and channel options
  const categoryOptions = [
    { key: "deal", label: "Deals & Opportunities" },
    { key: "task", label: "Tasks" },
    { key: "ticket", label: "Support Tickets" },
    { key: "lead", label: "Leads" },
    { key: "approval", label: "Approvals" },
    { key: "leave", label: "Leave Requests" },
    { key: "expense", label: "Expense Reports" },
  ];

  const channelOptions = [
    { key: "db", label: "In-App Bell" },
    { key: "socket", label: "Real-Time Updates" },
    { key: "push", label: "Browser Push" },
    { key: "email", label: "Email" },
  ];

  // Timezone list
  const timezones = [
    "UTC",
    "Asia/Kolkata",
    "Asia/Dubai",
    "Asia/Bangkok",
    "Asia/Singapore",
    "Asia/Hong_Kong",
    "America/New_York",
    "America/Chicago",
    "America/Denver",
    "America/Los_Angeles",
    "Europe/London",
    "Europe/Paris",
    "Europe/Berlin",
    "Australia/Sydney",
  ];

  const load = async () => {
    try {
      const data = await fetchApi("/api/notifications/preferences");
      setPrefs(data);
    } catch (err) {
      console.error("Failed to load preferences:", err);
      notify.error("Failed to load notification preferences");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
  }, []);

  const handleCategoryToggle = (category) => {
    setPrefs({
      ...prefs,
      categoryToggles: {
        ...prefs.categoryToggles,
        [category]: !prefs.categoryToggles[category],
      },
    });
  };

  const handleChannelToggle = (channel) => {
    setPrefs({
      ...prefs,
      channels: {
        ...prefs.channels,
        [channel]: !prefs.channels[channel],
      },
    });
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      await fetchApi("/api/notifications/preferences", {
        method: "PUT",
        body: JSON.stringify(prefs),
      });
      notify.success("Notification preferences saved");
    } catch (err) {
      notify.error("Failed to save notification preferences");
    } finally {
      setSaving(false);
    }
  };

  const handleReset = async () => {
    if (!(await notify.confirm("Reset notification preferences to defaults?")))
      return;
    setSaving(true);
    try {
      await fetchApi("/api/notifications/preferences/reset", {
        method: "POST",
      });
      load();
      notify.success("Preferences reset to defaults");
    } catch (err) {
      notify.error("Failed to reset preferences");
    } finally {
      setSaving(false);
    }
  };

  if (loading)
    return (
      <div className="card" style={{ padding: "1.5rem" }}>
        Loading preferences…
      </div>
    );
  // Defensive: existing Settings tests mock fetchApi to return `{}` or
  // `[]` for unrecognised URLs (most existing settings cards don't read
  // categoryToggles/channels). Without this guard, the render below
  // throws "Cannot read properties of undefined (reading 'deal')" inside
  // the categoryOptions.map. Treating a malformed prefs row as
  // not-yet-loaded matches the intent — show nothing until a real
  // preference shape arrives.
  if (!prefs || !prefs.categoryToggles || !prefs.channels) return null;

  return (
    <div className="card" style={{ padding: "clamp(1.25rem, 3vw, 2rem)" }}>
      <h3
        style={{
          fontSize: "1.25rem",
          fontWeight: "600",
          marginBottom: "1.5rem",
          display: "flex",
          alignItems: "center",
          gap: "0.5rem",
        }}
      >
        <Bell size={20} color="var(--accent-color)" /> Notification Preferences
      </h3>

      <div style={{ marginBottom: "2rem" }}>
        <h4
          style={{
            fontSize: "0.95rem",
            fontWeight: "600",
            marginBottom: "1rem",
            color: "var(--text-primary)",
          }}
        >
          Notification Categories
        </h4>
        <p
          style={{
            color: "var(--text-secondary)",
            fontSize: "0.85rem",
            marginBottom: "1rem",
          }}
        >
          Choose which types of notifications you want to receive.
        </p>
        <div
          style={{
            display: "grid",
            gridTemplateColumns:
              "repeat(auto-fit, minmax(min(100%, 200px), 1fr))",
            gap: "0.75rem",
          }}
        >
          {categoryOptions.map((cat) => (
            <label
              key={cat.key}
              style={{
                display: "flex",
                alignItems: "center",
                gap: "0.5rem",
                cursor: "pointer",
                padding: "0.5rem",
                borderRadius: 6,
                background: "var(--surface-color)",
                border: "1px solid var(--border-color)",
              }}
            >
              <input
                type="checkbox"
                checked={prefs.categoryToggles[cat.key] !== false}
                onChange={() => handleCategoryToggle(cat.key)}
                style={{ cursor: "pointer" }}
              />
              <span style={{ fontSize: "0.9rem" }}>{cat.label}</span>
            </label>
          ))}
        </div>
      </div>

      <div style={{ marginBottom: "2rem" }}>
        <h4
          style={{
            fontSize: "0.95rem",
            fontWeight: "600",
            marginBottom: "1rem",
            color: "var(--text-primary)",
          }}
        >
          Delivery Channels
        </h4>
        <p
          style={{
            color: "var(--text-secondary)",
            fontSize: "0.85rem",
            marginBottom: "1rem",
          }}
        >
          Select how you want to receive notifications.
        </p>
        <div
          style={{
            display: "grid",
            gridTemplateColumns:
              "repeat(auto-fit, minmax(min(100%, 200px), 1fr))",
            gap: "0.75rem",
          }}
        >
          {channelOptions.map((ch) => (
            <label
              key={ch.key}
              style={{
                display: "flex",
                alignItems: "center",
                gap: "0.5rem",
                cursor: "pointer",
                padding: "0.5rem",
                borderRadius: 6,
                background: "var(--surface-color)",
                border: "1px solid var(--border-color)",
              }}
            >
              <input
                type="checkbox"
                checked={prefs.channels[ch.key] !== false}
                onChange={() => handleChannelToggle(ch.key)}
                style={{ cursor: "pointer" }}
              />
              <span style={{ fontSize: "0.9rem" }}>{ch.label}</span>
            </label>
          ))}
        </div>
      </div>

      <div style={{ marginBottom: "2rem" }}>
        <h4
          style={{
            fontSize: "0.95rem",
            fontWeight: "600",
            marginBottom: "1rem",
            color: "var(--text-primary)",
          }}
        >
          Quiet Hours
        </h4>
        <p
          style={{
            color: "var(--text-secondary)",
            fontSize: "0.85rem",
            marginBottom: "1rem",
          }}
        >
          Suppress notifications during these times in your timezone.
        </p>
        <div
          style={{
            display: "grid",
            gridTemplateColumns:
              "repeat(auto-fit, minmax(min(100%, 150px), 1fr))",
            gap: "1rem",
          }}
        >
          <div style={{ minWidth: 0 }}>
            <label
              style={{
                display: "block",
                marginBottom: "0.4rem",
                fontSize: "0.875rem",
                color: "var(--text-secondary)",
              }}
            >
              Timezone
            </label>
            <select
              className="input-field"
              value={prefs.timezone || ""}
              onChange={(e) =>
                setPrefs({ ...prefs, timezone: e.target.value || null })
              }
              style={{ background: "var(--input-bg)", minWidth: 0 }}
            >
              <option value="">—</option>
              {timezones.map((tz) => (
                <option key={tz} value={tz}>
                  {tz}
                </option>
              ))}
            </select>
          </div>
          <div style={{ minWidth: 0 }}>
            <label
              style={{
                display: "block",
                marginBottom: "0.4rem",
                fontSize: "0.875rem",
                color: "var(--text-secondary)",
              }}
            >
              Start Time (HH:MM)
            </label>
            <input
              type="time"
              className="input-field"
              value={prefs.quietHoursStart || ""}
              onChange={(e) =>
                setPrefs({ ...prefs, quietHoursStart: e.target.value || null })
              }
              style={{ minWidth: 0 }}
            />
          </div>
          <div style={{ minWidth: 0 }}>
            <label
              style={{
                display: "block",
                marginBottom: "0.4rem",
                fontSize: "0.875rem",
                color: "var(--text-secondary)",
              }}
            >
              End Time (HH:MM)
            </label>
            <input
              type="time"
              className="input-field"
              value={prefs.quietHoursEnd || ""}
              onChange={(e) =>
                setPrefs({ ...prefs, quietHoursEnd: e.target.value || null })
              }
              style={{ minWidth: 0 }}
            />
          </div>
        </div>
      </div>

      <div style={{ display: "flex", gap: "0.75rem", flexWrap: "wrap" }}>
        <button
          type="button"
          className="btn-primary"
          onClick={handleSave}
          disabled={saving}
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            gap: "0.5rem",
            whiteSpace: "nowrap",
          }}
        >
          {saving ? "Saving…" : "Save Preferences"}
        </button>
        <button
          type="button"
          className="btn-secondary"
          onClick={handleReset}
          disabled={saving}
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            gap: "0.5rem",
            whiteSpace: "nowrap",
          }}
        >
          Reset to Defaults
        </button>
      </div>
    </div>
  );
}
