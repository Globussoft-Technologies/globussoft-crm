import { useEffect, useState } from "react";
import { Key, Plus, Edit2, Trash2, Save, X, Power } from "lucide-react";
import { superAdminFetch } from "../../utils/superAdminApi";

const PROVIDER_OPTIONS = [
  { id: "openai", label: "OpenAI", defaultBaseUrl: "https://api.openai.com/v1", defaultModel: "gpt-4o-mini" },
  { id: "gemini", label: "Google Gemini", defaultBaseUrl: "https://generativelanguage.googleapis.com", defaultModel: "gemini-2.5-flash-lite" },
  { id: "claude", label: "Claude", defaultBaseUrl: "https://api.anthropic.com", defaultModel: "claude-3-5-sonnet-latest" },
  { id: "groq", label: "Groq", defaultBaseUrl: "https://api.groq.com/openai/v1", defaultModel: "llama-3.3-70b-versatile" },
  { id: "deepseek", label: "DeepSeek", defaultBaseUrl: "https://api.deepseek.com", defaultModel: "deepseek-chat" },
  { id: "mistral", label: "Mistral", defaultBaseUrl: "https://api.mistral.ai/v1", defaultModel: "mistral-small-latest" },
  { id: "openrouter", label: "OpenRouter", defaultBaseUrl: "https://openrouter.ai/api/v1", defaultModel: "gpt-4o-mini" },
  { id: "cohere", label: "Cohere", defaultBaseUrl: "https://api.cohere.com/compatibility/v1", defaultModel: "command-r-plus" },
  { id: "moonshot", label: "Moonshot", defaultBaseUrl: "https://api.moonshot.cn/v1", defaultModel: "moonshot-v1-8k" },
  { id: "xai", label: "xAI", defaultBaseUrl: "https://api.x.ai/v1", defaultModel: "grok-2-latest" },
];

const EMPTY_FORM = {
  providerId: "openai",
  label: "",
  apiKey: "",
  baseUrl: "",
  model: "",
  isEnabled: true,
};

function providerLabel(id) {
  return PROVIDER_OPTIONS.find((p) => p.id === id)?.label || id;
}

function providerDefaultBaseUrl(id) {
  return PROVIDER_OPTIONS.find((p) => p.id === id)?.defaultBaseUrl || "";
}

function providerDefaultModel(id) {
  return PROVIDER_OPTIONS.find((p) => p.id === id)?.defaultModel || "";
}

export default function SuperAdminApiKeyManagement() {
  const [keys, setKeys] = useState([]);
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState("");
  const [editingId, setEditingId] = useState(null); // 'new' | key.id | null
  const [form, setForm] = useState(EMPTY_FORM);
  const [saving, setSaving] = useState(false);

  const load = async () => {
    setLoading(true);
    setMessage("");
    try {
      const res = await superAdminFetch("/ai-management/api-keys");
      setKeys(Array.isArray(res?.keys) ? res.keys : []);
    } catch (err) {
      setMessage(err.message || "Failed to load API keys.");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
  }, []);

  const startCreate = () => {
    setForm({ ...EMPTY_FORM, model: providerDefaultModel(EMPTY_FORM.providerId) });
    setEditingId("new");
  };

  const startEdit = (key) => {
    setForm({
      providerId: key.providerId || "openai",
      label: key.label || "",
      apiKey: "", // never show the real key
      baseUrl: key.baseUrl || "",
      model: key.model || providerDefaultModel(key.providerId || "openai"),
      isEnabled: key.isEnabled !== false,
    });
    setEditingId(key.id);
  };

  const cancelEdit = () => {
    setEditingId(null);
    setForm(EMPTY_FORM);
  };

  const handleSave = async () => {
    if (!form.providerId || !form.label.trim()) {
      setMessage("Provider and label are required.");
      return;
    }
    if (editingId === "new" && !form.apiKey.trim()) {
      setMessage("API key is required when creating a new key.");
      return;
    }
    setSaving(true);
    setMessage("");
    try {
      const payload = {
        providerId: form.providerId,
        label: form.label.trim(),
        baseUrl: form.baseUrl.trim() || null,
        model: form.model.trim() || null,
        isEnabled: form.isEnabled,
      };
      if (form.apiKey.trim()) {
        payload.apiKey = form.apiKey.trim();
      }
      if (editingId === "new") {
        await superAdminFetch("/ai-management/api-keys", { method: "POST", body: JSON.stringify(payload) });
        setMessage("API key created successfully.");
      } else {
        await superAdminFetch(`/ai-management/api-keys/${editingId}`, { method: "PUT", body: JSON.stringify(payload) });
        setMessage("API key updated successfully.");
      }
      cancelEdit();
      await load();
    } catch (err) {
      setMessage(err.message || "Failed to save API key.");
    } finally {
      setSaving(false);
    }
  };

  const handleToggleEnabled = async (key) => {
    setMessage("");
    try {
      await superAdminFetch(`/ai-management/api-keys/${key.id}`, {
        method: "PUT",
        body: JSON.stringify({
          providerId: key.providerId,
          label: key.label,
          baseUrl: key.baseUrl || null,
          isEnabled: !key.isEnabled,
        }),
      });
      await load();
    } catch (err) {
      setMessage(err.message || "Failed to toggle key status.");
    }
  };

  const handleDelete = async (key) => {
    if (!window.confirm(`Delete "${key.label}" (${providerLabel(key.providerId)})? This will also remove it from any attached subscription plans.`)) {
      return;
    }
    setMessage("");
    try {
      await superAdminFetch(`/ai-management/api-keys/${key.id}`, { method: "DELETE" });
      setMessage("API key deleted.");
      await load();
    } catch (err) {
      setMessage(err.message || "Failed to delete API key.");
    }
  };

  return (
    <div style={{ display: "grid", gap: "1rem" }}>
      <header style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: "0.75rem" }}>
        <div>
          <h1 style={{ margin: 0, display: "flex", alignItems: "center", gap: "0.6rem" }}>
            <Key size={24} color="var(--accent-color)" /> API Key Management
          </h1>
          <p style={{ margin: "0.4rem 0 0 0", color: "var(--text-secondary)" }}>
            Create and manage CRM-managed AI provider keys. Only enabled keys can be attached to AI subscription plans.
          </p>
        </div>
        <button className="btn-primary" onClick={startCreate} style={{ display: "inline-flex", alignItems: "center", gap: "0.45rem" }}>
          <Plus size={16} /> Add Key
        </button>
      </header>

      {message && (
        <div className="card" style={{ padding: "0.85rem 1rem", borderLeft: `4px solid ${/failed|error/i.test(message) ? "#ef4444" : "#22c55e"}` }}>
          {message}
        </div>
      )}

      {editingId && (
        <div className="card" style={{ padding: "1rem", display: "grid", gap: "0.75rem" }}>
          <div style={{ fontWeight: 700 }}>{editingId === "new" ? "New API Key" : "Edit API Key"}</div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: "0.75rem" }}>
            <select
              className="input-field"
              value={form.providerId}
              onChange={(e) => {
                const providerId = e.target.value;
                setForm((p) => ({
                  ...p,
                  providerId,
                  baseUrl: providerDefaultBaseUrl(providerId),
                  model: providerDefaultModel(providerId),
                }));
              }}
              style={{ background: "var(--input-bg)" }}
            >
              {PROVIDER_OPTIONS.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.label}
                </option>
              ))}
            </select>
            <input
              className="input-field"
              type="text"
              name="managed-key-label"
              placeholder="Label (e.g. Production OpenAI)"
              autoComplete="off"
              value={form.label}
              onChange={(e) => setForm((p) => ({ ...p, label: e.target.value }))}
            />
            <input
              className="input-field"
              type="password"
              name="managed-key-secret"
              placeholder={editingId === "new" ? "API key" : "API key (leave blank to keep existing)"}
              autoComplete="new-password"
              value={form.apiKey}
              onChange={(e) => setForm((p) => ({ ...p, apiKey: e.target.value }))}
            />
            <input
              className="input-field"
              type="text"
              placeholder="Custom base URL (optional)"
              value={form.baseUrl}
              onChange={(e) => setForm((p) => ({ ...p, baseUrl: e.target.value }))}
            />
            <input
              className="input-field"
              type="text"
              placeholder="Model (optional, e.g. gpt-4o / gemini-2.5-flash)"
              value={form.model}
              onChange={(e) => setForm((p) => ({ ...p, model: e.target.value }))}
            />
            <label style={{ display: "flex", alignItems: "center", gap: "0.5rem", fontSize: "0.9rem" }}>
              <input
                type="checkbox"
                checked={form.isEnabled}
                onChange={(e) => setForm((p) => ({ ...p, isEnabled: e.target.checked }))}
              />
              Enabled (master toggle)
            </label>
          </div>
          <div style={{ display: "flex", gap: "0.6rem" }}>
            <button className="btn-primary" onClick={handleSave} disabled={saving} style={{ display: "inline-flex", alignItems: "center", gap: "0.45rem" }}>
              <Save size={15} /> {saving ? "Saving..." : "Save Key"}
            </button>
            <button className="btn-secondary" onClick={cancelEdit} style={{ display: "inline-flex", alignItems: "center", gap: "0.45rem" }}>
              <X size={15} /> Cancel
            </button>
          </div>
        </div>
      )}

      {loading ? (
        <div className="card" style={{ padding: "2rem", textAlign: "center" }}>Loading API keys...</div>
      ) : keys.length === 0 ? (
        <div className="card" style={{ padding: "1.5rem", textAlign: "center", color: "var(--text-secondary)" }}>
          No CRM-managed API keys yet. Add a key to attach it to AI subscription plans.
        </div>
      ) : (
        <div style={{ display: "grid", gap: "0.75rem" }}>
          {keys.map((key) => (
            <div key={key.id} className="card" style={{ padding: "1rem", display: "grid", gap: "0.5rem" }}>
              <div style={{ display: "flex", justifyContent: "space-between", flexWrap: "wrap", gap: "0.75rem", alignItems: "center" }}>
                <div>
                  <div style={{ fontWeight: 700, display: "flex", alignItems: "center", gap: "0.5rem" }}>
                    {key.label}
                    {!key.isEnabled && (
                      <span style={{ fontSize: "0.7rem", padding: "0.15rem 0.5rem", borderRadius: 999, background: "rgba(148,163,184,0.15)", color: "var(--text-secondary)" }}>
                        disabled
                      </span>
                    )}
                  </div>
                  <div style={{ fontSize: "0.85rem", color: "var(--text-secondary)" }}>
                    {providerLabel(key.providerId)} · {key.model || providerDefaultModel(key.providerId)} · {key.apiKey || "••••••"} · {key.baseUrl || "default provider URL"}
                  </div>
                </div>
                <div style={{ display: "flex", gap: "0.5rem", alignItems: "center" }}>
                  <button
                    title={key.isEnabled ? "Disable key" : "Enable key"}
                    onClick={() => handleToggleEnabled(key)}
                    style={{
                      padding: "0.45rem 0.7rem",
                      borderRadius: 8,
                      border: `1px solid ${key.isEnabled ? "#22c55e" : "#64748b"}`,
                      background: key.isEnabled ? "rgba(34,197,94,0.12)" : "rgba(100,116,139,0.12)",
                      color: key.isEnabled ? "#22c55e" : "#94a3b8",
                      display: "inline-flex",
                      alignItems: "center",
                      gap: "0.35rem",
                      fontSize: "0.8rem",
                      cursor: "pointer",
                    }}
                  >
                    <Power size={14} /> {key.isEnabled ? "Enabled" : "Disabled"}
                  </button>
                  <button className="btn-secondary" onClick={() => startEdit(key)} style={{ display: "inline-flex", alignItems: "center", gap: "0.4rem" }}>
                    <Edit2 size={14} /> Edit
                  </button>
                  <button
                    onClick={() => handleDelete(key)}
                    style={{
                      padding: "0.5rem 0.8rem",
                      borderRadius: 8,
                      border: "1px solid #ef4444",
                      background: "rgba(239, 68, 68, 0.1)",
                      color: "#ef4444",
                      display: "inline-flex",
                      alignItems: "center",
                      gap: "0.4rem",
                      cursor: "pointer",
                    }}
                  >
                    <Trash2 size={14} /> Delete
                  </button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
