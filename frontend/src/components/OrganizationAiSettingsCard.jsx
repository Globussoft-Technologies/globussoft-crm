import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { AlertTriangle, BarChart3, Bot, Check, Sparkles, Trash2, X, XCircle } from "lucide-react";
import { fetchApi } from "../utils/api";
import { tokensToCredits } from "../utils/aiCredits";

export default function OrganizationAiSettingsCard() {
  const navigate = useNavigate();
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [discoveringModels, setDiscoveringModels] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [providers, setProviders] = useState([]);
  const [availableModels, setAvailableModels] = useState([]);
  const [modelDiscoveryError, setModelDiscoveryError] = useState("");
  const [status, setStatus] = useState(null);
  const [message, setMessage] = useState("");
  const [form, setForm] = useState({
    providerId: "gemini",
    apiKey: "",
    model: "",
    baseUrl: "",
  });

  const activeProvider = providers.find((provider) => provider.id === form.providerId);
  const requiresModelSelection = form.providerId !== "other";

  const discoverModelsForForm = async (nextForm, { preserveMessage = false } = {}) => {
    if (!nextForm?.providerId || !nextForm?.apiKey) {
      setAvailableModels([]);
      setModelDiscoveryError("");
      setForm((prev) => ({ ...prev, model: "" }));
      return [];
    }

    setDiscoveringModels(true);
    setModelDiscoveryError("");
    if (!preserveMessage) {
      setMessage("");
    }

    try {
      const res = await fetchApi("/api/ai-provider-management/byok/discover-models", {
        method: "POST",
        body: JSON.stringify({
          providerId: nextForm.providerId,
          apiKey: nextForm.apiKey,
          baseUrl: nextForm.baseUrl,
        }),
      });
      const models = Array.isArray(res?.models) ? res.models.filter(Boolean) : [];
      setAvailableModels(models);
      setForm((prev) => ({
        ...prev,
        model: models.includes(prev.model) ? prev.model : "",
      }));
      if (!models.length && requiresModelSelection) {
        setModelDiscoveryError("No models were returned for this provider. Verify the API key and Base URL, then test again.");
      }
      return models;
    } catch (err) {
      setAvailableModels([]);
      setForm((prev) => ({ ...prev, model: "" }));
      setModelDiscoveryError(err.message || "Unable to load models for this provider.");
      return [];
    } finally {
      setDiscoveringModels(false);
    }
  };

  const load = async () => {
    setLoading(true);
    try {
      const [providerRes, statusRes] = await Promise.all([
        fetchApi("/api/ai-provider-management/providers"),
        fetchApi("/api/ai-provider-management/status"),
      ]);
      const loadedProviders = Array.isArray(providerRes?.providers) ? providerRes.providers : [];
      setProviders(loadedProviders);
      setStatus(statusRes);
      setForm((prev) => ({
        providerId: statusRes?.byok?.providerId || prev.providerId || loadedProviders[0]?.id || "gemini",
        apiKey: statusRes?.byok?.maskedApiKey || "",
        model: statusRes?.byok?.model || "",
        baseUrl: statusRes?.byok?.baseUrl || "",
      }));
      setAvailableModels(statusRes?.byok?.model ? [statusRes.byok.model] : []);
      setModelDiscoveryError("");
    } catch (err) {
      setMessage(err.message || "Failed to load AI settings.");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
  }, []);

  const creditWallet = status?.creditWallet || null;
  const activeSubscription = status?.activeSubscription || null;
  const byok = status?.byok || null;
  const shouldUseModelDropdown = requiresModelSelection || availableModels.length > 0;

  const handleSave = async (e) => {
    e.preventDefault();
    if (requiresModelSelection && !form.model) {
      setMessage("Please load the provider models and choose one carefully before saving.");
      return;
    }

    setSaving(true);
    setMessage("");
    try {
      const res = await fetchApi("/api/ai-provider-management/byok", {
        method: "POST",
        body: JSON.stringify(form),
      });
      setMessage("AI provider saved successfully.");
      setForm((prev) => ({ ...prev, apiKey: res.maskedApiKey || prev.apiKey }));
      await load();
    } catch (err) {
      setMessage(err.message || "Failed to save AI provider.");
    } finally {
      setSaving(false);
    }
  };

  const handleTest = async () => {
    setTesting(true);
    setMessage("");
    try {
      const models = await discoverModelsForForm(form, { preserveMessage: true });
      if (!models.length && requiresModelSelection) {
        setMessage("Connection verified, but no selectable models were returned yet. Check the provider settings and try again.");
      } else {
        setMessage(`Connection OK. ${models.length} model${models.length === 1 ? "" : "s"} loaded. Please choose one carefully.`);
      }
    } catch (err) {
      setMessage(err.message || "Provider test failed.");
    } finally {
      setTesting(false);
    }
  };

  const handleRemove = async () => {
    setRemoving(true);
    setMessage("");
    try {
      await fetchApi("/api/ai-provider-management/byok", { method: "DELETE" });
      setForm((prev) => ({ ...prev, apiKey: "", model: "", baseUrl: "" }));
      setAvailableModels([]);
      setModelDiscoveryError("");
      setMessage("AI provider removed.");
      await load();
    } catch (err) {
      setMessage(err.message || "Failed to remove AI provider.");
    } finally {
      setRemoving(false);
    }
  };

  const handleCancelSubscription = async () => {
    if (!window.confirm("Cancel your CRM-managed AI subscription? Any remaining credit balance stays available until used.")) {
      return;
    }
    setCancelling(true);
    setMessage("");
    try {
      await fetchApi("/api/ai-provider-management/crm-access/cancel", { method: "POST" });
      setMessage("CRM-managed AI subscription cancelled.");
      await load();
    } catch (err) {
      setMessage(err.message || "Failed to cancel AI subscription.");
    } finally {
      setCancelling(false);
    }
  };

  return (
    <div className="card" style={{ padding: "clamp(1.25rem, 3vw, 2rem)" }}>
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
        <Bot size={20} color="var(--accent-color)" /> AI Settings
      </h3>

      {!loading && (
        <div
          style={{
            padding: "1rem",
            marginBottom: "1rem",
            borderRadius: 8,
            border: `1px solid ${status?.resolverAccess === "none" ? "#f59e0b" : "#10b981"}`,
            background:
              status?.resolverAccess === "none"
                ? "rgba(245, 158, 11, 0.1)"
                : "rgba(16, 185, 129, 0.1)",
            display: "flex",
            gap: "0.75rem",
            alignItems: "flex-start",
          }}
        >
          {status?.resolverAccess === "none" ? (
            <X size={18} color="#f59e0b" style={{ marginTop: 2 }} />
          ) : (
            <Check size={18} color="#10b981" style={{ marginTop: 2 }} />
          )}
          <div style={{ flex: 1 }}>
            <p style={{ margin: 0, fontWeight: 600 }}>
              {status?.resolverAccess === "byok"
                ? "Using your organization's own AI provider"
                : status?.resolverAccess === "crm-managed"
                  ? "CRM-managed AI access is active"
                  : "AI access is not configured yet"}
            </p>
            <p
              style={{
                margin: "0.3rem 0 0 0",
                fontSize: "0.85rem",
                color: "var(--text-secondary)",
              }}
            >
              {status?.friendlyMessage}
            </p>
            {byok && (
              <p
                style={{
                  margin: "0.3rem 0 0 0",
                  fontSize: "0.8rem",
                  color: "var(--text-secondary)",
                }}
              >
                {byok.providerLabel} | {byok.model} | {byok.maskedApiKey}
              </p>
            )}
          </div>
        </div>
      )}

      <p style={{ color: "var(--text-secondary)", fontSize: "0.875rem", marginBottom: "1rem" }}>
        Every AI feature in the CRM resolves access through this organization-wide AI provider setup.
      </p>

      <div
        style={{
          marginBottom: "1rem",
          padding: "0.9rem 1rem",
          borderRadius: 8,
          display: "flex",
          gap: "0.7rem",
          alignItems: "flex-start",
          background: "rgba(245, 158, 11, 0.1)",
          border: "1px solid rgba(245, 158, 11, 0.35)",
        }}
      >
        <AlertTriangle size={16} color="#f59e0b" style={{ marginTop: 2, flexShrink: 0 }} />
        <div style={{ fontSize: "0.84rem", color: "var(--text-secondary)", lineHeight: 1.55 }}>
          Choose the model carefully. The selected model directly affects output quality, feature support, speed, and billing.
        </div>
      </div>

      <form onSubmit={handleSave} style={{ display: "grid", gap: "0.75rem", marginBottom: "1rem" }}>
        <select
          className="input-field"
          value={form.providerId}
          onChange={(e) => {
            const providerId = e.target.value;
            setAvailableModels([]);
            setModelDiscoveryError("");
            setForm((prev) => ({
              ...prev,
              providerId,
              model: "",
            }));
          }}
          disabled={saving}
          style={{ background: "var(--input-bg)" }}
        >
          {providers.map((provider) => (
            <option key={provider.id} value={provider.id}>
              {provider.label}
            </option>
          ))}
        </select>
        <input
          className="input-field"
          type="password"
          placeholder="API key"
          value={form.apiKey}
          onChange={(e) => {
            setAvailableModels([]);
            setModelDiscoveryError("");
            setForm((prev) => ({ ...prev, apiKey: e.target.value, model: "" }));
          }}
          disabled={saving}
        />
        {shouldUseModelDropdown ? (
          <select
            className="input-field"
            value={form.model}
            onChange={(e) => setForm((prev) => ({ ...prev, model: e.target.value }))}
            disabled={saving || discoveringModels || (requiresModelSelection && !availableModels.length)}
            style={{ background: "var(--input-bg)" }}
          >
            <option value="">
              {discoveringModels
                ? "Loading models..."
                : availableModels.length
                  ? "Select a model"
                  : "Run Test Connection to load models"}
            </option>
            {availableModels.map((model) => (
              <option key={model} value={model}>
                {model}
              </option>
            ))}
          </select>
        ) : (
          <input
            className="input-field"
            type="text"
            placeholder="Model"
            value={form.model}
            onChange={(e) => setForm((prev) => ({ ...prev, model: e.target.value }))}
            disabled={saving || discoveringModels}
          />
        )}
        <input
          className="input-field"
          type="text"
          placeholder="Base URL (optional)"
          value={form.baseUrl}
          onChange={(e) => {
            setAvailableModels([]);
            setModelDiscoveryError("");
            setForm((prev) => ({ ...prev, baseUrl: e.target.value, model: "" }));
          }}
          disabled={saving}
        />
        <div style={{ fontSize: "0.8rem", color: "var(--text-secondary)" }}>
          {discoveringModels
            ? "Loading models for the selected provider..."
            : availableModels.length
              ? "Select the exact model you want to use from the provider list."
              : "Test the connection first, then choose one model from the provider dropdown before saving."}
        </div>
        {modelDiscoveryError && (
          <p style={{ margin: 0, fontSize: "0.8rem", color: "var(--danger-color)" }}>
            {modelDiscoveryError}
          </p>
        )}
        <div style={{ display: "flex", gap: "0.75rem", flexWrap: "wrap" }}>
          <button type="submit" className="btn-primary" disabled={saving}>
            {saving ? "Saving..." : byok ? "Update AI Provider" : "Save AI Provider"}
          </button>
          <button type="button" className="btn-secondary" onClick={handleTest} disabled={testing}>
            {testing ? "Testing..." : "Test Connection"}
          </button>
          {byok && (
            <button
              type="button"
              onClick={handleRemove}
              disabled={removing}
              style={{
                padding: "0.75rem 1rem",
                borderRadius: 8,
                border: "1px solid #ef4444",
                background: "rgba(239, 68, 68, 0.1)",
                color: "#ef4444",
                display: "inline-flex",
                alignItems: "center",
                gap: "0.4rem",
              }}
            >
              <Trash2 size={16} />
              {removing ? "Removing..." : "Remove"}
            </button>
          )}
        </div>
      </form>

      {!byok && (
        <div
          style={{
            borderTop: "1px solid var(--border-color)",
            paddingTop: "1rem",
            display: "grid",
            gap: "0.75rem",
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
            <Sparkles size={16} color="var(--accent-color)" />
            <strong>CRM-Managed AI Access</strong>
          </div>

          {activeSubscription ? (
            <div
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                gap: "0.75rem",
                flexWrap: "wrap",
                padding: "0.85rem 1rem",
                borderRadius: 8,
                background:
                  creditWallet && creditWallet.balanceTokens <= 0
                    ? "rgba(239, 68, 68, 0.08)"
                    : "rgba(59,130,246,0.08)",
                border:
                  creditWallet && creditWallet.balanceTokens <= 0
                    ? "1px solid rgba(239, 68, 68, 0.35)"
                    : "1px solid rgba(59,130,246,0.35)",
              }}
            >
              <div>
                <div style={{ fontWeight: 600 }}>{activeSubscription.planName}</div>
                <div style={{ fontSize: "0.8rem", color: "var(--text-secondary)" }}>
                  {creditWallet
                    ? `${tokensToCredits(creditWallet.balanceTokens).toLocaleString()} / ${tokensToCredits(creditWallet.totalPurchasedTokens).toLocaleString()} credits remaining (${creditWallet.percentRemaining}%)`
                    : ""}
                </div>
              </div>
              <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap" }}>
                <button
                  type="button"
                  className="btn-secondary"
                  onClick={() => navigate("/settings/ai-usage")}
                  style={{ display: "inline-flex", alignItems: "center", gap: "0.4rem" }}
                >
                  <BarChart3 size={16} /> Usage
                </button>
                {creditWallet && creditWallet.balanceTokens <= 0 ? (
                  <button
                    type="button"
                    className="btn-primary"
                    onClick={() => navigate("/ai-subscription")}
                  >
                    Buy More Credits
                  </button>
                ) : (
                  <button
                    type="button"
                    onClick={handleCancelSubscription}
                    disabled={cancelling}
                    style={{
                      padding: "0.6rem 0.9rem",
                      borderRadius: 8,
                      border: "1px solid #ef4444",
                      background: "rgba(239, 68, 68, 0.1)",
                      color: "#ef4444",
                      display: "inline-flex",
                      alignItems: "center",
                      gap: "0.4rem",
                    }}
                  >
                    <XCircle size={16} /> {cancelling ? "Cancelling..." : "Cancel"}
                  </button>
                )}
              </div>
            </div>
          ) : (
            <>
              <p style={{ margin: 0, color: "var(--text-secondary)", fontSize: "0.85rem" }}>
                Your organization has not configured an AI provider yet. Configure your own AI provider above, or use
                CRM-managed AI — no billing setup on your end, pay-as-you-go credits.
              </p>
              <div>
                <button
                  type="button"
                  className="btn-primary"
                  onClick={() => navigate("/ai-subscription")}
                  style={{ display: "inline-flex", alignItems: "center", gap: "0.5rem" }}
                >
                  <Sparkles size={16} /> Use CRM Managed AI
                </button>
              </div>
            </>
          )}
        </div>
      )}

      {message && (
        <p
          style={{
            marginTop: "1rem",
            fontSize: "0.85rem",
            color: /failed|error|please/i.test(message) ? "var(--danger-color)" : "var(--accent-color)",
          }}
        >
          {message}
        </p>
      )}
    </div>
  );
}
