import { useContext, useEffect, useMemo, useState } from "react";
import { AlertCircle, Globe, Plus, Save, Shield, X } from "lucide-react";
import { fetchApi } from "../utils/api";
import { useNotify } from "../utils/notify";
import { AuthContext } from "../App";

const HTTPS_ORIGIN_RE_V2 = /^https:\/\/(\*\.)?[^\s/*]+(:\d+)?(\/.*)?$/;

function isValidOrigin(origin) {
  return typeof origin === "string" && HTTPS_ORIGIN_RE_V2.test(origin.trim());
}

export default function LeadSourceAllowlistCard({ tenantId }) {
  const notify = useNotify();
  const { user } = useContext(AuthContext) || {};
  const activeTenantId = tenantId ?? user?.tenant?.id ?? null;

  const [loading, setLoading] = useState(true);
  const [accessible, setAccessible] = useState(true);
  const [origins, setOrigins] = useState([]);
  const [inputValue, setInputValue] = useState("");
  const [loadError, setLoadError] = useState("");
  const [inputError, setInputError] = useState("");
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [lastSavedJson, setLastSavedJson] = useState("[]");

  const originCount = useMemo(() => origins.length, [origins]);

  const syncDirty = (nextOrigins) => {
    setDirty(JSON.stringify(nextOrigins) !== lastSavedJson);
  };

  const load = async () => {
    if (!activeTenantId) {
      setAccessible(false);
      setLoading(false);
      return;
    }

    setLoading(true);
    setLoadError("");
    try {
      const data = await fetchApi(
        `/api/admin/tenants/${activeTenantId}/embed-allowlist`,
        { silent: true },
      );
      const next = Array.isArray(data?.origins) ? data.origins : [];
      setOrigins(next);
      setLastSavedJson(JSON.stringify(next));
      setDirty(false);
      setAccessible(true);
    } catch (err) {
      if (err?.status === 401 || err?.status === 403) {
        setAccessible(false);
      } else {
        setLoadError(err?.message || "Failed to load lead-source allowlist");
      }
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTenantId]);

  const handleAdd = () => {
    const trimmed = inputValue.trim();
    if (!trimmed) {
      setInputError("Origin cannot be empty");
      return;
    }
    if (!isValidOrigin(trimmed)) {
      setInputError("Origin must be a valid HTTPS URL (e.g. https://mysite.com)");
      return;
    }
    if (origins.includes(trimmed)) {
      setInputError("This origin is already in the allowlist");
      return;
    }
    if (origins.length >= 100) {
      setInputError("Allowlist is at the 100-entry cap - remove an entry first");
      return;
    }

    const next = [...origins, trimmed];
    setOrigins(next);
    setInputValue("");
    setInputError("");
    syncDirty(next);
  };

  const handleRemove = (origin) => {
    const next = origins.filter((item) => item !== origin);
    setOrigins(next);
    syncDirty(next);
  };

  const handleSave = async () => {
    if (!activeTenantId) return;
    setSaving(true);
    setInputError("");
    try {
      const data = await fetchApi(
        `/api/admin/tenants/${activeTenantId}/embed-allowlist`,
        {
          method: "PATCH",
          body: JSON.stringify({ origins }),
        },
      );
      const next = Array.isArray(data?.origins) ? data.origins : [];
      setOrigins(next);
      setLastSavedJson(JSON.stringify(next));
      setDirty(false);
      notify.success(
        next.length === 0
          ? "Lead-source allowlist cleared"
          : `Lead-source allowlist updated (${next.length} origin${next.length === 1 ? "" : "s"})`,
      );
    } catch (err) {
      if (err?.status === 401 || err?.status === 403) {
        setAccessible(false);
        return;
      }
      notify.error(err?.body?.error || err?.message || "Failed to save allowlist");
    } finally {
      setSaving(false);
    }
  };

  const inputIsValid = useMemo(
    () => inputValue.trim() === "" || isValidOrigin(inputValue.trim()),
    [inputValue],
  );

  if (!accessible) return null;

  return (
    <div className="card" style={{ padding: "clamp(1.25rem, 3vw, 2rem)" }}>
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
        <Shield size={20} color="var(--primary-color, var(--accent-color))" />
        External Lead Domains
      </h3>
      <p style={{ color: "var(--text-secondary)", fontSize: "0.875rem", marginBottom: "1rem" }}>
        Allow partner websites to embed CRM lead capture surfaces for this tenant.
        This applies across travel, wellness, and generic tenants. Use one HTTPS
        origin per line, for example <code>https://globussoft.com</code> and{" "}
        <code>https://*.globussoft.com</code>.
      </p>

      <div
        style={{
          marginBottom: "1rem",
          padding: "0.85rem 1rem",
          borderRadius: "8px",
          border: "1px solid rgba(59, 130, 246, 0.25)",
          background: "rgba(59, 130, 246, 0.08)",
          color: "var(--text-primary)",
        }}
      >
        <div style={{ fontSize: "0.78rem", color: "var(--text-secondary)", fontWeight: 600 }}>
          Use this API
        </div>
        <div style={{ marginTop: "0.25rem", fontSize: "0.92rem" }}>
          <code>/api/v1/external/leads</code> is used for lead submission.
          Allow the domains that should be able to submit leads through this API.
        </div>
        <div style={{ marginTop: "0.35rem", fontSize: "0.8rem", color: "var(--text-secondary)" }}>
          If a blocked origin tries to submit, admin notifications will appear in the bell.
        </div>
      </div>

      {loading ? (
        <div style={{ padding: "0.9rem 0", color: "var(--text-secondary)" }}>
          Loading external lead domains...
        </div>
      ) : loadError ? (
        <div
          style={{
            padding: "0.9rem 1rem",
            borderRadius: "8px",
            border: "1px solid rgba(239,68,68,0.35)",
            background: "rgba(239,68,68,0.08)",
            color: "var(--text-primary)",
            display: "flex",
            alignItems: "center",
            gap: "0.6rem",
          }}
        >
          <AlertCircle size={16} color="#ef4444" />
          <div style={{ flex: 1 }}>{loadError}</div>
          <button type="button" className="btn-primary" onClick={load}>
            Retry
          </button>
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: "0.9rem" }}>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              gap: "0.75rem",
              padding: "0.85rem 1rem",
              borderRadius: "8px",
              background: "rgba(255,255,255,0.03)",
              border: "1px solid var(--border-color, rgba(255,255,255,0.08))",
            }}
          >
            <div>
              <div style={{ fontSize: "0.82rem", color: "var(--text-secondary)" }}>
                Allowed origins
              </div>
              <div style={{ fontSize: "1rem", fontWeight: 700 }}>{originCount}</div>
            </div>
          </div>

          <div>
            <div
              style={{
                fontSize: "0.82rem",
                color: "var(--text-secondary)",
                fontWeight: 600,
                marginBottom: "0.5rem",
              }}
            >
              Origins
            </div>
            {origins.length === 0 ? (
              <div
                style={{
                  padding: "1rem",
                  border: "1px dashed var(--border-color, rgba(255,255,255,0.18))",
                  borderRadius: "8px",
                  color: "var(--text-secondary)",
                  fontSize: "0.88rem",
                  fontStyle: "italic",
                }}
              >
                No allowlist set - partner sites can embed the lead form without restrictions.
              </div>
            ) : (
              <div style={{ display: "flex", flexWrap: "wrap", gap: "0.5rem" }}>
                {origins.map((origin) => (
                  <span
                    key={origin}
                    style={{
                      display: "inline-flex",
                      alignItems: "center",
                      gap: "0.4rem",
                      padding: "0.35rem 0.6rem 0.35rem 0.8rem",
                      borderRadius: "999px",
                      background: "rgba(59, 130, 246, 0.10)",
                      border: "1px solid rgba(59, 130, 246, 0.35)",
                      color: "var(--text-primary)",
                      fontSize: "0.82rem",
                      fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
                    }}
                  >
                    <Globe size={12} />
                    <span>{origin}</span>
                    <button
                      type="button"
                      onClick={() => handleRemove(origin)}
                      aria-label={`Deny ${origin}`}
                      style={{
                        background: "transparent",
                        border: "none",
                        color: "var(--text-secondary)",
                        cursor: "pointer",
                        padding: "0.1rem",
                        display: "inline-flex",
                        alignItems: "center",
                      }}
                    >
                      <X size={13} />
                    </button>
                  </span>
                ))}
              </div>
            )}
          </div>

          <div>
            <label
              htmlFor="lead-source-allowlist-input"
              style={{ fontSize: "0.82rem", color: "var(--text-secondary)", fontWeight: 600 }}
            >
              Allow origin
            </label>
            <div style={{ display: "flex", gap: "0.6rem", marginTop: "0.4rem" }}>
              <input
                id="lead-source-allowlist-input"
                value={inputValue}
                onChange={(e) => {
                  setInputValue(e.target.value);
                  if (inputError) setInputError("");
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    handleAdd();
                  }
                }}
                placeholder="https://mysite.com"
                spellCheck={false}
                style={{
                  flex: 1,
                  padding: "0.8rem 0.9rem",
                  borderRadius: "8px",
                  border: inputError
                    ? "1px solid #ef4444"
                    : "1px solid var(--border-color, rgba(255,255,255,0.12))",
                  background: "var(--surface-color, rgba(255,255,255,0.04))",
                  color: "var(--text-primary)",
                  fontSize: "0.9rem",
                  fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
                  outline: "none",
                }}
              />
              <button
                type="button"
                className="btn-primary"
                onClick={handleAdd}
                disabled={!inputValue.trim() || !inputIsValid}
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: "0.4rem",
                  opacity: !inputValue.trim() || !inputIsValid ? 0.6 : 1,
                  cursor: !inputValue.trim() || !inputIsValid ? "not-allowed" : "pointer",
                }}
              >
                <Plus size={14} />
                Allow
              </button>
            </div>
            {inputError && (
              <div style={{ color: "#ef4444", fontSize: "0.82rem", marginTop: "0.35rem" }}>
                {inputError}
              </div>
            )}
          </div>

          <div
            style={{
              fontSize: "0.75rem",
              color: "var(--text-secondary)",
              display: "flex",
              flexWrap: "wrap",
              gap: "0.75rem",
            }}
          >
            <span>HTTPS only.</span>
            <span>Up to 100 origins.</span>
            <span>An empty list means unrestricted embedding.</span>
          </div>

          <div style={{ display: "flex", justifyContent: "flex-end" }}>
            <button
              type="button"
              className="btn-primary"
              onClick={handleSave}
              disabled={!dirty || saving}
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: "0.4rem",
                opacity: !dirty || saving ? 0.6 : 1,
                cursor: !dirty || saving ? "not-allowed" : "pointer",
              }}
            >
              <Save size={14} />
              {saving ? "Saving..." : "Save domains"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
