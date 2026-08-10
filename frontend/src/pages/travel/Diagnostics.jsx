// Travel CRM — Diagnostics list view (operator + admin).
//
// Lands at /travel/diagnostics. Shows submitted diagnostics across all
// sub-brands the caller has access to (backend's getSubBrandAccessSet
// narrows the query for non-admins). Filter chips for sub-brand +
// classification. Click a row → opens the diagnostic detail (TBD —
// for now we surface the full data inline).
//
// Two prominent CTAs at the top:
//   • "Take diagnostic" → /travel/diagnostics/new — starts the wizard
//   • "New bank" → /travel/diagnostics/banks/new (admin only) — opens
//     the JSON-paste admin builder
//
// See backend/routes/travel_diagnostics.js for the underlying contract.

import { useEffect, useState, useContext, useCallback } from "react";
import { Link } from "react-router-dom";
import { ClipboardCheck, Plus, Compass, Filter } from "lucide-react";
import { fetchApi } from "../../utils/api";
import { useNotify } from "../../utils/notify";
import { AuthContext } from "../../App";

const SUB_BRANDS = [
  { value: "", label: "All sub-brands" },
  { value: "tmc", label: "TMC (schools)" },
  { value: "rfu", label: "RFU (Umrah)" },
  { value: "travelstall", label: "Travel Stall" },
  { value: "visasure", label: "Visa Sure" },
];

const LIST_LIMIT = 200;

function fmt(d) {
  if (!d) return "—";
  return new Date(d).toLocaleString();
}

export default function Diagnostics() {
  const notify = useNotify();
  const { user } = useContext(AuthContext) || {};
  const isAdmin = user?.role === "ADMIN";

  const [diagnostics, setDiagnostics] = useState([]);
  const [loading, setLoading] = useState(true);
  const [subBrand, setSubBrand] = useState("");
  const [classification, setClassification] = useState("");

  const load = useCallback(
    async ({ reset = false } = {}) => {
      if (reset) {
        setLoading(true);
        setDiagnostics([]);
      }

      const qs = new URLSearchParams();
      if (subBrand) qs.set("subBrand", subBrand);
      if (classification) qs.set("classification", classification);
      qs.set("limit", String(LIST_LIMIT));

      try {
        const res = await fetchApi(`/api/travel/diagnostics?${qs.toString()}`);
        const rows = Array.isArray(res?.diagnostics) ? res.diagnostics : [];
        setDiagnostics(rows);
      } catch (e) {
        notify.error(e?.body?.error || "Failed to load diagnostics");
        setDiagnostics([]);
      } finally {
        setLoading(false);
      }
    },
    [subBrand, classification, notify],
  );

  useEffect(() => {
    load({ reset: true });
  }, [load]);

  const reload = useCallback(() => {
    load({ reset: true });
  }, [load]);

  return (
    <div
      style={{
        padding: 24,
        width: "100%",
        maxWidth: 1480,
        margin: "0 auto",
        boxSizing: "border-box",
      }}
    >
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "flex-start",
          gap: 16,
          marginBottom: 4,
        }}
      >
        <h1
          style={{ display: "flex", alignItems: "center", gap: 10, margin: 0 }}
        >
          <ClipboardCheck size={28} aria-hidden /> Diagnostics
        </h1>
        <div style={{ display: "flex", gap: 8 }}>
          {isAdmin && (
            <Link
              to="/travel/diagnostics/banks/new"
              style={ctaSecondary}
              aria-label="Create new diagnostic bank (admin)"
            >
              <Plus size={16} aria-hidden /> New bank
            </Link>
          )}
          {!isAdmin && (
            <Link
              to="/travel/diagnostics/new"
              style={ctaPrimary}
              aria-label="Take a diagnostic"
            >
              <Compass size={16} aria-hidden /> Take diagnostic
            </Link>
          )}
        </div>
      </div>
      <p style={{ color: "var(--text-secondary)", marginTop: 0 }}>
        Weighted-scoring assessments classify leads into tiers before any quote
        is shown.
      </p>

      <div
        style={{
          display: "flex",
          gap: 12,
          flexWrap: "wrap",
          alignItems: "center",
          background: "var(--surface-color)",
          padding: 12,
          borderRadius: 8,
          border: "1px solid var(--border-color)",
          marginBottom: 16,
        }}
      >
        <Filter
          size={16}
          aria-hidden
          style={{ color: "var(--text-secondary)" }}
        />
        <select
          value={subBrand}
          onChange={(e) => {
            setSubBrand(e.target.value);
          }}
          style={selectStyle}
          aria-label="Filter by sub-brand"
        >
          {SUB_BRANDS.map((s) => (
            <option key={s.value} value={s.value}>
              {s.label}
            </option>
          ))}
        </select>
        <select
          value={classification}
          onChange={(e) => {
            setClassification(e.target.value);
          }}
          style={selectStyle}
          aria-label="Filter by classification"
        >
          <option value="">All classifications</option>
          <option value="level_1">Level 1</option>
          <option value="level_2">Level 2</option>
          <option value="level_3">Level 3</option>
          <option value="level_4">Level 4</option>
        </select>
        <button
          type="button"
          onClick={reload}
          style={refreshBtn}
          aria-label="Reload list"
        >
          Refresh
        </button>
      </div>

      <div
        style={{
          background: "var(--surface-color)",
          borderRadius: 8,
          border: "1px solid var(--border-color)",
        }}
      >
        {loading && diagnostics.length === 0 ? (
          <div style={empty}>Loading&hellip;</div>
        ) : diagnostics.length === 0 ? (
          <div style={empty}>
            {isAdmin ? (
              "No diagnostics submitted yet."
            ) : (
              <>
                No diagnostics submitted yet. Click{" "}
                <strong>Take diagnostic</strong> to start.
              </>
            )}
          </div>
        ) : (
          <div
            data-testid="diagnostics-table-scroll"
            style={{
              overflowX: "scroll",
              overflowY: "visible",
            }}
          >
            <div style={{ minWidth: "calc(100% + 1px)" }}>
            <table
              aria-label="Diagnostics results"
              style={{
                width: "100%",
                minWidth: 760,
                borderCollapse: "collapse",
                tableLayout: "fixed",
              }}
            >
              <colgroup>
                <col style={{ width: "150px" }} />
                <col style={{ width: "120px" }} />
                <col style={{ width: "190px" }} />
                <col style={{ width: "90px" }} />
                <col style={{ width: "120px" }} />
                <col style={{ width: "90px" }} />
              </colgroup>
              <thead>
                <tr>
                  <th style={th}>Submitted</th>
                  <th style={th}>Sub-brand</th>
                  <th style={th}>Contact</th>
                  <th style={th}>Score</th>
                  <th style={th}>Classification</th>
                  <th style={th}>Tier</th>
                </tr>
              </thead>
              <tbody>
                {diagnostics.map((d) => {
                  const tier = (d.recommendedTier || "").toLowerCase();
                  const tierClass = ["entry", "primary", "premium"].includes(
                    tier,
                  )
                    ? `tier-badge tier-badge--${tier}`
                    : "tier-badge";
                  return (
                    <tr
                      key={d.id}
                      style={{ borderTop: "1px solid var(--border-light)" }}
                    >
                      <td style={td}>
                        <Link
                          to={`/travel/diagnostics/${d.id}`}
                          style={rowLink}
                          aria-label={`Open diagnostic #${d.id}`}
                        >
                          {fmt(d.createdAt)}
                        </Link>
                      </td>
                      <td style={td}>
                        <span style={brandBadge}>{d.subBrand}</span>
                      </td>
                      <td style={td}>
                        {d.contact?.name || d.contact?.email ? (
                          <span>
                            {d.contact.name || d.contact.email}
                            {d.contact.name && d.contact.email && (
                              <span
                                style={{
                                  display: "block",
                                  fontSize: 11,
                                  color: "var(--text-secondary)",
                                }}
                              >
                                {d.contact.email}
                              </span>
                            )}
                          </span>
                        ) : d.contactId ? (
                          `#${d.contactId}`
                        ) : (
                          "—"
                        )}
                      </td>
                      <td style={td}>
                        {d.score !== null ? Number(d.score).toFixed(2) : "—"}
                      </td>
                      <td style={td}>
                        {d.classificationLabel || d.classification || "—"}
                      </td>
                      <td style={td}>
                        <span className={tierClass}>
                          {d.recommendedTier || "—"}
                        </span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
const ctaPrimary = {
  display: "inline-flex",
  alignItems: "center",
  gap: 6,
  padding: "8px 14px",
  borderRadius: 8,
  fontWeight: 600,
  fontSize: 14,
  background: "var(--primary-color, var(--accent-color))",
  color: "#fff",
  textDecoration: "none",
  border: "none",
};

const ctaSecondary = {
  display: "inline-flex",
  alignItems: "center",
  gap: 6,
  padding: "8px 14px",
  borderRadius: 8,
  fontWeight: 600,
  fontSize: 14,
  background: "var(--surface-color)",
  color: "var(--primary-color)",
  textDecoration: "none",
  border: "1px solid var(--primary-color)",
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

const refreshBtn = {
  padding: "6px 12px",
  borderRadius: 6,
  border: "1px solid var(--border-color)",
  background: "var(--surface-color)",
  color: "var(--text-primary)",
  fontSize: 13,
  cursor: "pointer",
};

const empty = {
  padding: 32,
  textAlign: "center",
  color: "var(--text-secondary)",
  fontSize: 14,
};

const th = {
  position: "sticky",
  top: 0,
  zIndex: 3,
  textAlign: "left",
  padding: "8px 10px",
  fontSize: 12,
  textTransform: "uppercase",
  letterSpacing: 0.5,
  color: "var(--text-secondary)",
  borderBottom: "1px solid var(--border-color)",
  background: "var(--modal-bg, var(--bg-color))",
  boxShadow: "inset 0 -1px 0 var(--border-color)",
  whiteSpace: "nowrap",
};

const td = {
  padding: "10px 12px",
  fontSize: 14,
  color: "var(--text-primary)",
  minWidth: 0,
};

const brandBadge = {
  padding: "2px 8px",
  borderRadius: 4,
  fontSize: 11,
  fontWeight: 600,
  background: "var(--subtle-bg-3)",
  color: "var(--primary-color)",
  textTransform: "uppercase",
  letterSpacing: 0.5,
};

const rowLink = {
  color: "var(--primary-color, var(--accent-color))",
  textDecoration: "none",
  fontWeight: 500,
};
