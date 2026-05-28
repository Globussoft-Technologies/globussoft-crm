import React, { useState, useEffect, useContext, useRef } from "react";
import { Link } from "react-router-dom";
import {
  Shield,
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
} from "lucide-react";
import { fetchApi, getAuthToken } from "../utils/api";
import { useNotify } from "../utils/notify";
import { usePermissions } from "../hooks/usePermissions";
import { ThemeContext, AuthContext } from "../App";

// #391: single source of truth for the default brand color so the color
// picker swatch, the placeholder hint, and the color actually applied
// when no brand color is set all match. Mirrors --accent-color in
// index.css.
const DEFAULT_BRAND_COLOR = "#3b82f6";

export default function Settings() {
  const notify = useNotify();
  const { theme, setTheme, toggleTheme } = useContext(ThemeContext);
  const { tenant: ctxTenant, setTenant } = useContext(AuthContext);
  const { isOwner } = usePermissions();
  const [users, setUsers] = useState([]);
  const [loading, setLoading] = useState(true);
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

  const handleSaveLogo = async () => {
    if (!stagedLogo) return;
    setLogoUploading(true);
    setBrandingMsg("");
    try {
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
      setBranding((b) => ({ ...b, logoUrl: json.logoUrl }));
      setLogoBroken(false);
      // Reflect into sidebar instantly
      if (setTenant && ctxTenant)
        setTenant({ ...ctxTenant, logoUrl: json.logoUrl });
      setBrandingMsg("Logo updated.");
      cancelStagedLogo();
    } catch (err) {
      setBrandingMsg(err.message || "Logo upload failed");
    } finally {
      setLogoUploading(false);
    }
  };

  // Revoke the staged blob URL on unmount so we don't leak it.
  useEffect(() => {
    return () => {
      if (stagedPreviewUrl) URL.revokeObjectURL(stagedPreviewUrl);
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
      const res = await fetchApi("/api/wellness/branding/color", {
        method: "PUT",
        body: JSON.stringify({ brandColor: value || null }),
      });
      setBranding((b) => ({ ...b, brandColor: res.brandColor || "" }));
      if (setTenant && ctxTenant)
        setTenant({ ...ctxTenant, brandColor: res.brandColor || null });
      setBrandingMsg("Brand color saved.");
    } catch (err) {
      setBrandingMsg(err.message || "Failed to save brand color");
    } finally {
      setBrandingSaving(false);
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
    fetchApi("/api/auth/users")
      .then((res) => {
        setUsers(res);
        setLoading(false);
      })
      .catch((err) => console.error(err));
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
      const data = await fetchApi("/api/auth/users");
      setUsers(data);
      setNewUser({ name: "", email: "", password: "", role: "USER" });
    } catch (err) {
      notify.error("Failed to create user.");
    }
  };

  const handleDelete = async (id) => {
    if (await notify.confirm("Delete this user?")) {
      await fetchApi(`/api/auth/users/${id}`, { method: "DELETE" });
      setUsers(users.filter((u) => u.id !== id));
    }
  };

  const handleChangeRole = async (id, newRole) => {
    await fetchApi(`/api/auth/users/${id}/role`, {
      method: "PUT",
      body: JSON.stringify({ role: newRole }),
    });
    setUsers(users.map((u) => (u.id === id ? { ...u, role: newRole } : u)));
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
      </header>

      {/* #479/#484: outer two-column grid uses auto-fit + minmax so the
          right column collapses below the second card under ~700px viewports
          rather than squeezing both columns until labels/buttons clip.
          alignItems:'start' keeps each column at its natural height so the
          shorter column's cards don't get spread apart vertically to match
          the taller column's stretch height. */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns:
            "repeat(auto-fit, minmax(min(100%, 320px), 1fr))",
          gap: "1.5rem",
          maxWidth: "1400px",
          alignItems: "start",
        }}
      >
        {/* Left Column */}
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "1fr",
            gap: "1.5rem",
            minWidth: 0,
          }}
        >
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

          {/* Branding Card */}
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
              <Palette size={20} color="var(--accent-color)" /> Branding
            </h3>
            <p
              style={{
                color: "var(--text-secondary)",
                fontSize: "0.875rem",
                marginBottom: "1.25rem",
              }}
            >
              Upload your clinic logo and pick a brand color. These appear in
              the sidebar and on branded PDFs.
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
        </div>

        {/* Right Column - Roster */}
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "1fr",
            gap: "1.5rem",
            minWidth: 0,
          }}
        >
          {/* User Roster */}
          <div
            className="card"
            style={{
              padding: "clamp(1.25rem, 3vw, 2rem)",
              height: "fit-content",
            }}
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
              <Shield size={20} color="var(--success-color)" /> Access Control
              Roster
            </h3>

            {loading ? (
              <p>Loading team...</p>
            ) : (
              <div
                style={{
                  display: "flex",
                  flexDirection: "column",
                  gap: "1rem",
                  maxHeight: "700px",
                  overflowY: "auto",
                }}
              >
                {users.map((u) => (
                  // #479: roster row wraps on narrow viewports so the role
                  // dropdown + delete button drop below the name/email block
                  // instead of squeezing the email into truncation.
                  <div
                    key={u.id}
                    style={{
                      display: "flex",
                      justifyContent: "space-between",
                      alignItems: "center",
                      background: "var(--surface-color)",
                      border: "1px solid var(--border-color)",
                      padding: "1.25rem",
                      borderRadius: "8px",
                      flexWrap: "wrap",
                      gap: "0.75rem",
                    }}
                  >
                    <div style={{ minWidth: 0, flex: "1 1 180px" }}>
                      <h4
                        style={{
                          fontWeight: "600",
                          fontSize: "1.1rem",
                          wordBreak: "break-word",
                        }}
                      >
                        {u.name || "Unknown User"}{" "}
                        <span
                          style={{
                            fontSize: "0.75rem",
                            padding: "0.2rem 0.6rem",
                            background:
                              u.role === "ADMIN"
                                ? "rgba(239, 68, 68, 0.2)"
                                : "rgba(59, 130, 246, 0.2)",
                            color: u.role === "ADMIN" ? "#ef4444" : "#3b82f6",
                            borderRadius: "12px",
                            marginLeft: "0.5rem",
                          }}
                        >
                          {u.role}
                        </span>
                      </h4>
                      <p
                        style={{
                          color: "var(--text-secondary)",
                          fontSize: "0.875rem",
                          marginTop: "0.25rem",
                          wordBreak: "break-all",
                        }}
                      >
                        {u.email}
                      </p>
                    </div>

                    <div
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: "1rem",
                      }}
                    >
                      <select
                        value={u.role}
                        onChange={(e) => handleChangeRole(u.id, e.target.value)}
                        style={{
                          padding: "0.5rem",
                          borderRadius: "4px",
                          background: "var(--input-bg)",
                          color: "var(--text-primary)",
                          border: "1px solid var(--border-color)",
                        }}
                      >
                        <option value="USER">Standard Rep</option>
                        <option value="MANAGER">Manager</option>
                        <option value="ADMIN">Admin</option>
                      </select>
                      {u.role !== "ADMIN" ? (
                        <button
                          onClick={() => handleDelete(u.id)}
                          style={{
                            background: "transparent",
                            border: "none",
                            color: "var(--danger-color)",
                            cursor: "pointer",
                            padding: "0.5rem",
                          }}
                        >
                          <Trash2 size={18} />
                        </button>
                      ) : (
                        <span
                          style={{
                            color: "var(--text-secondary)",
                            fontSize: "0.875rem",
                          }}
                        >
                          —
                        </span>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}
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
              <input
                type="password"
                placeholder="Temporary Password"
                required
                className="input-field"
                style={{ minWidth: 0 }}
                value={newUser.password}
                onChange={(e) =>
                  setNewUser({ ...newUser, password: e.target.value })
                }
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

          {/* Notification Preferences Card */}
          <NotificationPreferencesCard notify={notify} />
        </div>
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
