/**
 * VoyagrApiKeys.jsx — ADMIN-only admin UI for per-Voyagr-site API key
 * provisioning, rotation, and revocation. Slice C1 of
 * docs/TRAVEL_CODEABLE_BACKLOG.md.
 *
 * Backend contracts pinned by this page (already shipped — see backend/
 * routes/developer.js + backend/middleware/voyagrAuth.js + backend/
 * routes/voyagr.js commits 0299031 + 84efe0f):
 *
 *   GET    /api/developer/apikeys
 *     Returns ALL of the requesting user's API keys (tenant-scoped). This
 *     page filters the response client-side by `subBrand IN
 *     {tmc,rfu,travelstall,visasure}` to surface only voyagr-shaped keys.
 *     Tenant-wide voyagr keys (subBrand=null + name prefixed "voyagr-")
 *     are NOT surfaced here by design — they should be managed via the
 *     generic /developer page, since this page exists for per-site keys
 *     scoped to one of the 4 Travel sub-brands.
 *
 *   POST   /api/developer/apikeys     body { name, subBrand }
 *     Returns { rawKey, key }. The rawKey is the only chance to display
 *     the secret in plaintext — after this response, the API key is
 *     stored hashed (per #899 demo-mode caveat in the backend route).
 *     We surface the rawKey in a one-shot copy-to-clipboard modal.
 *
 *   DELETE /api/developer/apikeys/:id
 *     Revokes the key immediately — voyagr POSTs against /api/v1/voyagr
 *     with the revoked secret return 401 INVALID_API_KEY.
 *
 * Rotation flow — there is NO dedicated /rotate endpoint. We implement
 * "rotate" client-side as DELETE old + POST new with the same name +
 * subBrand. The new rawKey is surfaced in the same copy-to-clipboard
 * modal as a fresh provision. Operator hands the new key to the voyagr
 * Next.js site's env vars; deleting the old key immediately severs the
 * prior connection (acceptable for low-frequency rotation — the
 * common voyagr deploy cadence is monthly at most). If the POST fails
 * after the DELETE succeeded, the operator can re-provision via the
 * Provision button — we surface a clear error in that case.
 *
 * Sub-brand scoping (#899 Part A — backend/middleware/voyagrAuth.js):
 *   A key with subBrand='tmc' posting a lead with subBrand='rfu' is
 *   rejected 403 SUB_BRAND_MISMATCH. So provisioning the right sub-brand
 *   per voyagr site is load-bearing — the Provision modal makes the
 *   sub-brand a required field.
 *
 * Empty state copy: "No Voyagr API keys provisioned yet. Click Provision
 * to create one." per slice C1 hard-contract.
 *
 * Theme: primary CTAs use `var(--primary-color, var(--accent-color))`
 * per CLAUDE.md "Primary CTAs" standing rule. Wellness + travel verticals
 * render teal `#265855`; generic falls back to the accent blue.
 *
 * Tests: frontend/src/__tests__/VoyagrApiKeys.test.jsx — at least 8 cases
 * per slice C1 hard-contract (initial render / empty state / provision
 * modal / form validation / provision happy path / rotate / revoke
 * confirm / non-ADMIN gate).
 */

import { useEffect, useMemo, useState } from "react";
import { Key, Plus, RefreshCw, Trash2, Copy, X, AlertCircle } from "lucide-react";
import { fetchApi } from "../../utils/api";
import { useNotify } from "../../utils/notify";
import TopScrollSync from "../../components/TopScrollSync";

// Voyagr sub-brands — mirrors VALID_API_KEY_SUB_BRANDS in
// backend/routes/developer.js (#899 Part A whitelist). Order matches the
// existing Developer.jsx page for operator muscle memory.
const VOYAGR_SUB_BRANDS = [
  { value: "tmc", label: "TMC (School trips)", siteHint: "tmc.in" },
  { value: "rfu", label: "RFU (Umrah)", siteHint: "rfu-umrah.com" },
  { value: "travelstall", label: "Travel Stall (Family)", siteHint: "travelstall.com" },
  { value: "visasure", label: "Visa Sure", siteHint: "visasure.in" },
];

const VOYAGR_SUB_BRAND_SET = new Set(VOYAGR_SUB_BRANDS.map((s) => s.value));

// Mask everything after the first 10 chars of `glbs_<hex>` so the secret
// is never re-rendered in the row. Mirrors Developer.jsx's pattern.
function maskKey(secret) {
  if (!secret || typeof secret !== "string") return "";
  const prefix = secret.slice(0, 10);
  return `${prefix}${"*".repeat(Math.max(0, secret.length - 10))}`;
}

function formatDate(iso) {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

export default function VoyagrApiKeys() {
  const notify = useNotify();
  const [keys, setKeys] = useState([]);
  const [loading, setLoading] = useState(true);

  // Provision modal state.
  const [showProvisionModal, setShowProvisionModal] = useState(false);
  const [provisionName, setProvisionName] = useState("");
  const [provisionSubBrand, setProvisionSubBrand] = useState("tmc");
  const [provisionError, setProvisionError] = useState("");
  const [provisioning, setProvisioning] = useState(false);

  // Reveal modal — shown once after provision/rotate succeeds. The rawKey
  // is NEVER shown again after the operator closes this modal.
  const [revealedKey, setRevealedKey] = useState(null);
  const [copied, setCopied] = useState(false);

  const loadKeys = async () => {
    setLoading(true);
    try {
      const all = await fetchApi("/api/developer/apikeys");
      const filtered = Array.isArray(all)
        ? all.filter((k) => k.subBrand && VOYAGR_SUB_BRAND_SET.has(k.subBrand))
        : [];
      setKeys(filtered);
    } catch (_err) {
      notify.error("Failed to load Voyagr API keys.");
      setKeys([]);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadKeys();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const openProvisionModal = () => {
    setProvisionName("");
    setProvisionSubBrand("tmc");
    setProvisionError("");
    setShowProvisionModal(true);
  };

  const closeProvisionModal = () => {
    if (provisioning) return;
    setShowProvisionModal(false);
    setProvisionError("");
  };

  const submitProvision = async (e) => {
    e?.preventDefault?.();
    const trimmed = provisionName.trim();
    if (!trimmed) {
      setProvisionError("Key name is required.");
      return;
    }
    if (!VOYAGR_SUB_BRAND_SET.has(provisionSubBrand)) {
      setProvisionError("Pick a Voyagr sub-brand.");
      return;
    }
    setProvisioning(true);
    setProvisionError("");
    try {
      const res = await fetchApi("/api/developer/apikeys", {
        method: "POST",
        body: JSON.stringify({ name: trimmed, subBrand: provisionSubBrand }),
      });
      const rawKey = res?.rawKey;
      if (!rawKey) {
        notify.error("Provision succeeded but no key was returned. Reload to verify.");
      } else {
        setRevealedKey({
          rawKey,
          name: trimmed,
          subBrand: provisionSubBrand,
          action: "provisioned",
        });
        setCopied(false);
      }
      setShowProvisionModal(false);
      await loadKeys();
    } catch (err) {
      setProvisionError(err?.message || "Failed to provision key.");
    } finally {
      setProvisioning(false);
    }
  };

  const rotateKey = async (k) => {
    const confirmed = await notify.confirm(
      `WARNING: Rotating "${k.name}" will immediately revoke the existing key and mint a fresh one. The voyagr site using this key will fail until you update its env vars. Proceed?`,
    );
    if (!confirmed) return;
    try {
      // 1. Revoke the old key first — minimises the window where the old
      //    secret remains valid alongside the new one.
      await fetchApi(`/api/developer/apikeys/${k.id}`, { method: "DELETE" });
      // 2. Mint the replacement with the same name + sub-brand.
      const res = await fetchApi("/api/developer/apikeys", {
        method: "POST",
        body: JSON.stringify({ name: k.name, subBrand: k.subBrand }),
      });
      const rawKey = res?.rawKey;
      if (rawKey) {
        setRevealedKey({
          rawKey,
          name: k.name,
          subBrand: k.subBrand,
          action: "rotated",
        });
        setCopied(false);
      } else {
        notify.error("Rotation succeeded but no key was returned. Reload to verify.");
      }
      await loadKeys();
    } catch (err) {
      notify.error(err?.message || "Failed to rotate key. Re-provision via Provision button.");
      await loadKeys();
    }
  };

  const revokeKey = async (k) => {
    const confirmed = await notify.confirm(
      `WARNING: Revoking "${k.name}" will immediately sever the voyagr site relying on this key. Proceed?`,
    );
    if (!confirmed) return;
    try {
      await fetchApi(`/api/developer/apikeys/${k.id}`, { method: "DELETE" });
      notify.success(`Revoked "${k.name}".`);
      await loadKeys();
    } catch (err) {
      notify.error(err?.message || "Failed to revoke key.");
    }
  };

  const copyRevealedKey = async () => {
    if (!revealedKey?.rawKey) return;
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(revealedKey.rawKey);
      }
      setCopied(true);
      setTimeout(() => setCopied(false), 2500);
    } catch {
      // Clipboard write blocked — surface plain-text fallback. The key is
      // still visible in the modal body for manual copy.
      notify.info("Copy blocked by browser. Select + copy the key text manually.");
    }
  };

  const closeRevealModal = () => {
    setRevealedKey(null);
    setCopied(false);
  };

  const primaryCtaStyle = useMemo(
    () => ({
      display: "inline-flex",
      alignItems: "center",
      gap: 6,
      padding: "0.5rem 0.9rem",
      borderRadius: 8,
      border: "none",
      background: "var(--primary-color, var(--accent-color))",
      color: "#fff",
      fontWeight: 600,
      cursor: "pointer",
    }),
    [],
  );

  const subBrandBadge = () => ({
    fontSize: "0.7rem",
    padding: "0.15rem 0.55rem",
    borderRadius: 10,
    background: "rgba(38, 88, 85, 0.12)",
    color: "var(--primary-color, var(--accent-color))",
    fontWeight: 600,
    textTransform: "uppercase",
    letterSpacing: 0.5,
  });

  return (
    <div style={{ padding: "1.5rem", maxWidth: 1200, margin: "0 auto" }}>
      <header style={{ marginBottom: "1.5rem" }}>
        <h1
          style={{
            display: "flex",
            alignItems: "center",
            gap: 10,
            fontSize: "1.75rem",
            margin: 0,
          }}
        >
          <Key size={26} aria-hidden="true" /> Voyagr API Keys
        </h1>
        <p style={{ color: "var(--text-secondary)", marginTop: "0.4rem", marginBottom: 0 }}>
          Provision API keys for Voyagr CMS sites to POST leads into the CRM.
        </p>
      </header>

      <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: "1rem" }}>
        <button
          type="button"
          onClick={openProvisionModal}
          style={primaryCtaStyle}
          aria-label="Provision new Voyagr API key"
        >
          <Plus size={16} /> Provision
        </button>
      </div>

      {loading ? (
        <div style={{ padding: "2rem", textAlign: "center", color: "var(--text-secondary)" }}>
          Loading Voyagr API keys…
        </div>
      ) : keys.length === 0 ? (
        <div
          role="status"
          style={{
            padding: "2.5rem",
            textAlign: "center",
            color: "var(--text-secondary)",
            border: "1px dashed var(--border-color)",
            borderRadius: 12,
          }}
        >
          <AlertCircle size={28} style={{ opacity: 0.5, marginBottom: 8 }} aria-hidden="true" />
          <div>No Voyagr API keys provisioned yet. Click Provision to create one.</div>
        </div>
      ) : (
        <div
          style={{
            border: "1px solid var(--border-color)",
            borderRadius: 12,
          }}
        >
        <TopScrollSync>
          <table
            style={{ width: "100%", borderCollapse: "collapse", minWidth: 720 }}
            aria-label="Voyagr API keys"
          >
            <thead>
              <tr style={{ background: "var(--surface-color, rgba(0,0,0,0.03))" }}>
                <th style={{ textAlign: "left", padding: "0.75rem 1rem", fontSize: "0.85rem" }}>
                  Name
                </th>
                <th style={{ textAlign: "left", padding: "0.75rem 1rem", fontSize: "0.85rem" }}>
                  Sub-brand
                </th>
                <th style={{ textAlign: "left", padding: "0.75rem 1rem", fontSize: "0.85rem" }}>
                  Key prefix
                </th>
                <th style={{ textAlign: "left", padding: "0.75rem 1rem", fontSize: "0.85rem" }}>
                  Created
                </th>
                <th style={{ textAlign: "left", padding: "0.75rem 1rem", fontSize: "0.85rem" }}>
                  Last used
                </th>
                <th style={{ textAlign: "right", padding: "0.75rem 1rem", fontSize: "0.85rem" }}>
                  Actions
                </th>
              </tr>
            </thead>
            <tbody>
              {keys.map((k) => (
                <tr key={k.id} style={{ borderTop: "1px solid var(--border-color)" }}>
                  <td style={{ padding: "0.75rem 1rem", fontWeight: 600 }}>{k.name}</td>
                  <td style={{ padding: "0.75rem 1rem" }}>
                    <span style={subBrandBadge()} title={`Scoped to ${k.subBrand}`}>
                      {k.subBrand}
                    </span>
                  </td>
                  <td
                    style={{
                      padding: "0.75rem 1rem",
                      fontFamily: "ui-monospace, monospace",
                      fontSize: "0.85rem",
                      color: "var(--text-secondary)",
                    }}
                  >
                    {maskKey(k.keySecret)}
                  </td>
                  <td style={{ padding: "0.75rem 1rem", fontSize: "0.85rem" }}>
                    {formatDate(k.createdAt)}
                  </td>
                  <td style={{ padding: "0.75rem 1rem", fontSize: "0.85rem" }}>
                    {formatDate(k.lastUsed)}
                  </td>
                  <td style={{ padding: "0.75rem 1rem", textAlign: "right" }}>
                    <button
                      type="button"
                      onClick={() => rotateKey(k)}
                      title="Rotate key — revoke and mint a fresh secret"
                      aria-label={`Rotate ${k.name}`}
                      style={{
                        marginRight: 8,
                        padding: "0.35rem 0.7rem",
                        borderRadius: 6,
                        border: "1px solid var(--border-color)",
                        background: "transparent",
                        cursor: "pointer",
                        display: "inline-flex",
                        alignItems: "center",
                        gap: 4,
                      }}
                    >
                      <RefreshCw size={14} /> Rotate
                    </button>
                    <button
                      type="button"
                      onClick={() => revokeKey(k)}
                      title="Revoke key — immediate revocation"
                      aria-label={`Revoke ${k.name}`}
                      style={{
                        padding: "0.35rem 0.7rem",
                        borderRadius: 6,
                        border: "1px solid #b91c1c",
                        background: "transparent",
                        color: "#b91c1c",
                        cursor: "pointer",
                        display: "inline-flex",
                        alignItems: "center",
                        gap: 4,
                      }}
                    >
                      <Trash2 size={14} /> Revoke
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </TopScrollSync>
        </div>
      )}

      {/* Provision modal */}
      {showProvisionModal && (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="provision-modal-title"
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
            onSubmit={submitProvision}
            style={{
              background: "var(--card-bg, #fff)",
              borderRadius: 12,
              padding: "1.5rem",
              width: "min(480px, 90vw)",
              boxShadow: "0 12px 32px rgba(0,0,0,0.2)",
            }}
          >
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                marginBottom: "1rem",
              }}
            >
              <h2 id="provision-modal-title" style={{ margin: 0, fontSize: "1.15rem" }}>
                Provision Voyagr API Key
              </h2>
              <button
                type="button"
                onClick={closeProvisionModal}
                aria-label="Close dialog"
                style={{
                  background: "transparent",
                  border: "none",
                  cursor: "pointer",
                  color: "var(--text-secondary)",
                }}
              >
                <X size={18} />
              </button>
            </div>
            <div style={{ marginBottom: "1rem" }}>
              <label
                htmlFor="provision-name-input"
                style={{
                  display: "block",
                  marginBottom: 4,
                  fontSize: "0.85rem",
                  fontWeight: 600,
                }}
              >
                Key name
              </label>
              <input
                id="provision-name-input"
                type="text"
                value={provisionName}
                onChange={(e) => setProvisionName(e.target.value)}
                placeholder="e.g. tmc.in production"
                style={{
                  width: "100%",
                  padding: "0.5rem 0.75rem",
                  borderRadius: 6,
                  border: "1px solid var(--border-color)",
                  background: "var(--surface-color, #fff)",
                  color: "var(--text-primary, #111)",
                }}
                autoFocus
              />
            </div>
            <div style={{ marginBottom: "1rem" }}>
              <label
                htmlFor="provision-sub-brand-select"
                style={{
                  display: "block",
                  marginBottom: 4,
                  fontSize: "0.85rem",
                  fontWeight: 600,
                }}
              >
                Sub-brand
              </label>
              <select
                id="provision-sub-brand-select"
                value={provisionSubBrand}
                onChange={(e) => setProvisionSubBrand(e.target.value)}
                style={{
                  width: "100%",
                  padding: "0.5rem 0.75rem",
                  borderRadius: 6,
                  border: "1px solid var(--border-color)",
                  background: "var(--surface-color, #fff)",
                  color: "var(--text-primary, #111)",
                }}
              >
                {VOYAGR_SUB_BRANDS.map((sb) => (
                  <option key={sb.value} value={sb.value}>
                    {sb.label}
                  </option>
                ))}
              </select>
              <p
                style={{
                  fontSize: "0.75rem",
                  color: "var(--text-secondary)",
                  margin: "0.4rem 0 0",
                }}
              >
                Key will be rejected if used to POST a lead for a different sub-brand.
              </p>
            </div>
            {provisionError && (
              <div
                role="alert"
                style={{
                  background: "rgba(185, 28, 28, 0.08)",
                  color: "#b91c1c",
                  padding: "0.5rem 0.75rem",
                  borderRadius: 6,
                  marginBottom: "1rem",
                  fontSize: "0.85rem",
                }}
              >
                {provisionError}
              </div>
            )}
            <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
              <button
                type="button"
                onClick={closeProvisionModal}
                disabled={provisioning}
                style={{
                  padding: "0.5rem 0.9rem",
                  borderRadius: 6,
                  border: "1px solid var(--border-color)",
                  background: "transparent",
                  cursor: "pointer",
                }}
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={provisioning}
                style={primaryCtaStyle}
              >
                {provisioning ? "Provisioning…" : "Provision"}
              </button>
            </div>
          </form>
        </div>
      )}

      {/* Reveal-once modal */}
      {revealedKey && (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="reveal-modal-title"
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(0,0,0,0.5)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            zIndex: 1001,
          }}
        >
          <div
            style={{
              background: "var(--card-bg, #fff)",
              borderRadius: 12,
              padding: "1.5rem",
              width: "min(560px, 92vw)",
              boxShadow: "0 12px 32px rgba(0,0,0,0.2)",
            }}
          >
            <h2 id="reveal-modal-title" style={{ marginTop: 0, fontSize: "1.15rem" }}>
              Key {revealedKey.action} — copy now
            </h2>
            <p
              style={{
                color: "var(--text-secondary)",
                fontSize: "0.9rem",
                marginBottom: "1rem",
              }}
            >
              <strong>This is the ONLY time this key will be shown.</strong> Save it to the
              Voyagr site&apos;s env vars (e.g. <code>VOYAGR_CRM_API_KEY</code>) immediately. Closing
              this dialog discards the plaintext value — you will need to rotate the key to
              regain access.
            </p>
            <div
              style={{
                background: "rgba(0,0,0,0.06)",
                padding: "0.75rem 1rem",
                borderRadius: 8,
                fontFamily: "ui-monospace, monospace",
                fontSize: "0.85rem",
                wordBreak: "break-all",
                marginBottom: "1rem",
              }}
              data-testid="revealed-raw-key"
            >
              {revealedKey.rawKey}
            </div>
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                gap: 8,
              }}
            >
              <span style={{ fontSize: "0.8rem", color: "var(--text-secondary)" }}>
                Name: <strong>{revealedKey.name}</strong> · Sub-brand:{" "}
                <strong>{revealedKey.subBrand}</strong>
              </span>
              <div style={{ display: "flex", gap: 8 }}>
                <button
                  type="button"
                  onClick={copyRevealedKey}
                  style={{
                    ...primaryCtaStyle,
                    background: copied
                      ? "#16a34a"
                      : "var(--primary-color, var(--accent-color))",
                  }}
                  aria-label="Copy raw API key to clipboard"
                >
                  <Copy size={14} /> {copied ? "Copied" : "Copy"}
                </button>
                <button
                  type="button"
                  onClick={closeRevealModal}
                  style={{
                    padding: "0.5rem 0.9rem",
                    borderRadius: 6,
                    border: "1px solid var(--border-color)",
                    background: "transparent",
                    cursor: "pointer",
                  }}
                >
                  Close
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
