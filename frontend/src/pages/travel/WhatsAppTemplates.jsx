// Travel CRM — WhatsApp template library (Wati transport, Q9).
//
// Read-only list of the message templates on the connected WATI account
// (GET /api/travel/whatsapp/templates → watiClient.getMessageTemplates).
// Templates are authored + submitted for Meta approval inside the Wati
// dashboard — this surface exists so operators can see what's available
// to the chat's "Use Template" picker (only APPROVED templates send) and
// where the sub-components' "manage templates" links land for travel
// (the wellness equivalent at /wellness/whatsapp/templates manages the
// Meta Cloud track and is untouched).

import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { LayoutTemplate, RefreshCw, ArrowLeft, ExternalLink } from "lucide-react";
import { fetchApi } from "../../utils/api";

const STATUS_COLORS = {
  APPROVED: { background: "rgba(34, 197, 94, 0.18)", color: "var(--success-color, #22c55e)" },
  PENDING: { background: "rgba(245, 158, 11, 0.18)", color: "var(--warning-color, #f59e0b)" },
  REJECTED: { background: "rgba(244, 63, 94, 0.18)", color: "var(--danger-color, #f43f5e)" },
};

export default function TravelWhatsAppTemplates() {
  const [templates, setTemplates] = useState([]);
  const [stub, setStub] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);

  const load = () => {
    setLoading(true);
    setLoadError(false);
    fetchApi("/api/travel/whatsapp/templates")
      .then((d) => {
        setTemplates(Array.isArray(d?.templates) ? d.templates : []);
        setStub(d?.stub === true);
      })
      .catch(() => {
        setTemplates([]);
        setLoadError(true);
      })
      .finally(() => setLoading(false));
  };

  useEffect(load, []);

  return (
    <div style={{ padding: 24, maxWidth: 1100, margin: "0 auto", animation: "fadeIn 0.4s ease-out" }}>
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
            <LayoutTemplate size={26} aria-hidden /> WhatsApp Templates
          </h1>
          <p style={{ color: "var(--text-secondary)", marginTop: 4, fontSize: "0.9rem", maxWidth: 640 }}>
            Templates on the connected Wati account. Only{" "}
            <strong>approved</strong> templates can be sent to numbers that
            haven't messaged you in the last 24 hours. Create / edit / submit
            templates for approval in the{" "}
            <a
              href="https://app.wati.io"
              target="_blank"
              rel="noreferrer"
              style={{ color: "var(--primary-color, #25D366)" }}
            >
              Wati dashboard <ExternalLink size={11} aria-hidden style={{ verticalAlign: "middle" }} />
            </a>
            .
          </p>
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <Link to="/travel/whatsapp" style={{ ...btn, textDecoration: "none" }}>
            <ArrowLeft size={14} aria-hidden /> Back to chat
          </Link>
          <button type="button" onClick={load} style={btn} aria-label="Refresh templates">
            <RefreshCw size={14} aria-hidden /> Refresh
          </button>
        </div>
      </header>

      {stub && !loading && (
        <div
          className="glass"
          style={{ padding: "10px 14px", marginBottom: 16, fontSize: 13, color: "var(--text-secondary)" }}
          data-testid="stub-note"
        >
          Wati credentials are not configured — the template list loads from
          your Wati account once WATI_API_ENDPOINT + WATI_ACCESS_TOKEN are set
          in the backend .env.
        </div>
      )}

      <div className="glass" style={{ padding: 0, overflow: "hidden" }}>
        {loading ? (
          <div style={empty} role="status">Loading&hellip;</div>
        ) : loadError ? (
          <div style={{ ...empty, color: "var(--danger-color, #f43f5e)" }} role="alert">
            Failed to load templates from Wati. Use Refresh to retry.
          </div>
        ) : templates.length === 0 ? (
          <div style={empty}>
            No templates on the Wati account yet — create one in the Wati
            dashboard and it appears here after Meta approval.
          </div>
        ) : (
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr style={{ borderBottom: "1px solid rgba(255,255,255,0.06)" }}>
                <th style={th}>Name</th>
                <th style={th}>Status</th>
                <th style={th}>Language</th>
                <th style={th}>Category</th>
                <th style={th}>Body</th>
              </tr>
            </thead>
            <tbody>
              {templates.map((t) => (
                <tr key={t.name} style={{ borderTop: "1px solid rgba(255,255,255,0.04)" }}>
                  <td style={{ ...td, fontFamily: "monospace", fontSize: 13 }}>{t.name}</td>
                  <td style={td}>
                    <span
                      style={{
                        ...badge,
                        ...(STATUS_COLORS[t.status] || { background: "rgba(148,163,184,0.18)", color: "var(--text-secondary)" }),
                      }}
                    >
                      {t.status || "—"}
                    </span>
                  </td>
                  <td style={td}>{t.language || "—"}</td>
                  <td style={td}>{t.category || "—"}</td>
                  <td style={{ ...td, maxWidth: 420, fontSize: 13, color: "var(--text-secondary)" }}>
                    {t.body || "—"}
                  </td>
                </tr>
              ))}
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
const td = { padding: "10px 12px", fontSize: 14, color: "var(--text-primary)", verticalAlign: "top" };
const badge = {
  display: "inline-block",
  padding: "2px 8px",
  borderRadius: 10,
  fontSize: 11,
  fontWeight: 600,
};
const empty = { padding: 32, textAlign: "center", color: "var(--text-secondary)", fontSize: 14 };
const btn = {
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
