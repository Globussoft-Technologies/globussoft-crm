import { useEffect, useState } from "react";
import { Bot, Save, Upload } from "lucide-react";
import { superAdminFetch, superAdminUpload } from "../../utils/superAdminApi";
import { useNotify } from "../../utils/notify";

export default function SuperAdminGenericChatKnowledge() {
  const notify = useNotify();
  const [content, setContent] = useState("");
  const [settings, setSettings] = useState({ generalResponsesEnabled: true, businessFallback: "", unrelatedFallback: "", aiUnavailableFallback: "" });
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    Promise.all([
      superAdminFetch("/tenant-management/generic-chat-knowledge"),
      superAdminFetch("/tenant-management/generic-chat-settings"),
    ])
      .then(([knowledge, config]) => { setContent(knowledge.content || ""); setSettings(config.settings || settings); })
      .catch((error) => notify.error(error.message))
      .finally(() => setLoading(false));
  }, [notify]);

  const saveText = async () => {
    setSaving(true);
    try {
      await superAdminFetch("/tenant-management/generic-chat-knowledge", {
        method: "POST",
        body: JSON.stringify({ content }),
      });
      notify.success("Generic CRM chatbot knowledge saved.");
    } catch (error) {
      notify.error(error.message);
    } finally {
      setSaving(false);
    }
  };

  const saveSettings = async () => {
    setSaving(true);
    try {
      await superAdminFetch("/tenant-management/generic-chat-settings", { method: "POST", body: JSON.stringify(settings) });
      notify.success("Generic CRM chatbot settings saved.");
    } catch (error) {
      notify.error(error.message);
    } finally {
      setSaving(false);
    }
  };

  const uploadFile = async (event) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    setSaving(true);
    try {
      const result = await superAdminUpload("/tenant-management/generic-chat-knowledge", file);
      setContent(await file.text());
      notify.success(`Knowledge uploaded (${result.characters} characters).`);
    } catch (error) {
      notify.error(error.message);
    } finally {
      setSaving(false);
    }
  };

  if (loading) return <p>Loading Generic CRM chatbot knowledge...</p>;
  return (
    <div style={{ display: "grid", gap: "1rem", maxWidth: 900 }}>
      <header>
        <h1 style={{ display: "flex", alignItems: "center", gap: 10 }}><Bot size={24} /> CRM Chatbox Knowledge</h1>
        <p style={{ color: "var(--text-secondary)" }}>Upload approved information used by the CRM chatbox.</p>
      </header>
      <div className="card" style={{ padding: 20, display: "grid", gap: 14 }}>
        <label htmlFor="generic-chat-knowledge">Knowledge content</label>
        <textarea id="generic-chat-knowledge" className="input-field" rows={18} value={content} onChange={(event) => setContent(event.target.value)} placeholder="Add product, pricing, feature, and support information..." />
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
          <button type="button" className="btn-primary" disabled={saving} onClick={saveText}><Save size={15} /> {saving ? "Saving..." : "Save knowledge"}</button>
          <label className="btn-secondary" style={{ display: "inline-flex", alignItems: "center", gap: 6, cursor: saving ? "wait" : "pointer" }}>
            <Upload size={15} /> Upload TXT/MD/CSV/JSON
            <input type="file" accept=".txt,.md,.csv,.json,text/plain,text/markdown,application/json,text/csv" hidden disabled={saving} onChange={uploadFile} />
          </label>
        </div>
      </div>
      <div className="card" style={{ padding: 20, display: "grid", gap: 14 }}>
        <h2>Response behaviour</h2>
        <label style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <input type="checkbox" checked={settings.generalResponsesEnabled} onChange={(event) => setSettings((current) => ({ ...current, generalResponsesEnabled: event.target.checked }))} />
          Allow general AI responses for calculations and casual questions
        </label>
        <label>Business knowledge unavailable fallback<textarea className="input-field" rows={3} value={settings.businessFallback} onChange={(event) => setSettings((current) => ({ ...current, businessFallback: event.target.value }))} /></label>
        <label>Unrelated question redirect<textarea className="input-field" rows={3} value={settings.unrelatedFallback} onChange={(event) => setSettings((current) => ({ ...current, unrelatedFallback: event.target.value }))} /></label>
        <label>AI unavailable fallback<textarea className="input-field" rows={3} value={settings.aiUnavailableFallback} onChange={(event) => setSettings((current) => ({ ...current, aiUnavailableFallback: event.target.value }))} /></label>
        <button type="button" className="btn-primary" disabled={saving} onClick={saveSettings}><Save size={15} /> Save response settings</button>
      </div>
    </div>
  );
}
