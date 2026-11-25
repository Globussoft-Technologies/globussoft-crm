import { useEffect, useState } from "react";
import { Mail, Plus, Save, X } from "lucide-react";
import { superAdminFetch } from "../../utils/superAdminApi";
import { useNotify } from "../../utils/notify";

export default function SuperAdminLandingForm() {
  const notify = useNotify();
  const [emails, setEmails] = useState([]);
  const [draft, setDraft] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    superAdminFetch("/tenant-management/landing-form")
      .then((result) => setEmails(result.emails || []))
      .catch((error) => notify.error(error.message))
      .finally(() => setLoading(false));
  }, [notify]);

  const addEmail = () => {
    const value = draft.trim().toLowerCase();
    if (!value || !value.includes("@") || emails.includes(value)) return;
    setEmails((current) => [...current, value]);
    setDraft("");
  };

  const save = async () => {
    setSaving(true);
    try {
      await superAdminFetch("/tenant-management/landing-form/emails", {
        method: "PUT",
        body: JSON.stringify({ emails: emails.join(",") }),
      });
      notify.success("Landing page permissions saved.");
    } catch (error) {
      notify.error(error.message);
    } finally {
      setSaving(false);
    }
  };

  if (loading) return <p>Loading landing page permissions...</p>;

  return (
    <div style={{ display: "grid", gap: "1rem", maxWidth: 720 }}>
      <header>
        <h1 style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <Mail size={24} /> Landing Page Permissions
        </h1>
        <p style={{ color: "var(--text-secondary)" }}>
          Only these email addresses can choose which existing web form appears on the landing page.
        </p>
      </header>

      <div className="card" style={{ padding: 20, display: "grid", gap: 14 }}>
        <label htmlFor="landing-admin-email">Allowed admin emails</label>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
          <input
            id="landing-admin-email"
            className="input-field"
            style={{ flex: "1 1 180px", minWidth: 0 }}
            placeholder="admin@example.com"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                addEmail();
              }
            }}
          />
          <button type="button" className="btn-secondary" onClick={addEmail}>
            <Plus size={15} /> Add
          </button>
        </div>

        {emails.length > 0 && (
          <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
            {emails.map((email) => (
              <span
                key={email}
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 6,
                  padding: "6px 10px",
                  borderRadius: 16,
                  background: "var(--surface-muted, #eef0f6)",
                  overflowWrap: "anywhere",
                }}
              >
                {email}
                <button
                  type="button"
                  aria-label={`Remove ${email}`}
                  onClick={() => setEmails((current) => current.filter((item) => item !== email))}
                  style={{ border: 0, background: "transparent", cursor: "pointer", padding: 0 }}
                >
                  <X size={14} />
                </button>
              </span>
            ))}
          </div>
        )}

        <button type="button" className="btn-primary" disabled={saving} onClick={save}>
          <Save size={15} /> {saving ? "Saving..." : "Save permissions"}
        </button>
      </div>
    </div>
  );
}
