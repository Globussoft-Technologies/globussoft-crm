/**
 * CSPViolations.jsx — ADMIN-only operator-inspect UI for CSP violation
 * reports captured by the slice-2 ingest (`POST /api/csp/report`).
 *
 * Consumes `GET /api/csp/violations` (backend route shipped slice 3,
 * commit d7167c72). Per PRD_TRAVEL_SECURITY_ARCHITECTURE §9 — the
 * security-audit team uses this surface to triage whether a candidate
 * CSP tightening is safe to flip from Report-Only to enforce. A noisy
 * directive (lots of legitimate violations) needs widening first; a
 * clean directive can flip.
 *
 * Endpoint shape (from backend/routes/csp.js):
 *   GET /api/csp/violations?limit=&offset=&from=&to=&directive=
 *     → {
 *         total: number,                  // total rows in scope (pre-paging)
 *         violations: [
 *           {
 *             at: ISO string,             // AuditLog.createdAt
 *             directive: string|null,     // violated-directive
 *             blockedUri: string|null,
 *             documentUri: string|null,
 *             sourceFile: string|null,
 *             lineNumber: number|null,
 *             columnNumber: number|null,
 *             tenantId: number,
 *             originalPolicy: string|null, // truncated to 200 chars
 *             _raw?: string,              // present when details JSON was malformed
 *           }
 *         ],
 *         limit: number,
 *         offset: number,
 *       }
 *
 * RBAC
 *   The backend route is verifyToken + verifyRole(['ADMIN']). The
 *   <Route> in App.jsx wraps this page in <RoleGuard allow={["ADMIN"]}>
 *   so non-admin requests never get here. We DO surface a graceful
 *   "Access restricted" panel when the fetch 403s anyway (defense-in-
 *   depth — mirrors the BrandKits pattern at admin/BrandKits.jsx:114).
 *
 * Tenant scoping is enforced server-side via req.user.tenantId — ADMIN
 * in tenant A cannot see tenant B's violations even by tweaking query.
 *
 * Pagination is prev/next over `offset += limit`; we cap `limit` at the
 * default 100 (backend max is 500 but the table layout works best at 100).
 *
 * The directive filter is server-side (backend parses the JSON details
 * column and filters in-memory). We debounce the input by 300ms so a
 * typist doesn't fire one fetch per keystroke. The from/to date inputs
 * refetch on blur — date-picker change events fire on every keystroke,
 * which would be noisy.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ShieldAlert, Filter, ChevronLeft, ChevronRight, AlertCircle } from "lucide-react";
import { fetchApi } from "../../utils/api";
import { useNotify } from "../../utils/notify";

const DEFAULT_LIMIT = 100;
const DEBOUNCE_MS = 300;

export default function CSPViolations() {
  const notify = useNotify();
  const [violations, setViolations] = useState([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [errorMsg, setErrorMsg] = useState(null);
  const [permissionDenied, setPermissionDenied] = useState(false);

  // Filter inputs.
  const [directive, setDirective] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [debouncedDirective, setDebouncedDirective] = useState("");

  // Pagination.
  const [offset, setOffset] = useState(0);
  const limit = DEFAULT_LIMIT;

  // Debounce directive — 300ms after the user stops typing.
  const debounceTimerRef = useRef(null);
  useEffect(() => {
    if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current);
    debounceTimerRef.current = setTimeout(() => {
      setDebouncedDirective(directive.trim());
      // Reset to first page whenever the directive filter changes — paging
      // through a stale filter would be confusing.
      setOffset(0);
    }, DEBOUNCE_MS);
    return () => {
      if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current);
    };
  }, [directive]);

  const load = useCallback(() => {
    setLoading(true);
    setErrorMsg(null);
    const qs = new URLSearchParams();
    qs.set("limit", String(limit));
    if (offset > 0) qs.set("offset", String(offset));
    if (debouncedDirective) qs.set("directive", debouncedDirective);
    if (from) qs.set("from", from);
    if (to) qs.set("to", to);
    fetchApi(`/api/csp/violations?${qs.toString()}`)
      .then((d) => {
        setViolations(Array.isArray(d?.violations) ? d.violations : []);
        setTotal(Number.isFinite(d?.total) ? d.total : 0);
        setPermissionDenied(false);
      })
      .catch((err) => {
        setViolations([]);
        setTotal(0);
        if (err?.status === 403) {
          setPermissionDenied(true);
        } else {
          const msg = err?.body?.error || err?.message || "Failed to load CSP violations";
          setErrorMsg(msg);
          notify.error(msg);
        }
      })
      .finally(() => setLoading(false));
  }, [limit, offset, debouncedDirective, from, to, notify]);

  useEffect(() => {
    load();
  }, [load]);

  const canPrev = offset > 0;
  const canNext = offset + limit < total;

  const pageInfo = useMemo(() => {
    if (total === 0) return "0 results";
    const start = offset + 1;
    const end = Math.min(offset + violations.length, total);
    return `${start.toLocaleString()}–${end.toLocaleString()} of ${total.toLocaleString()}`;
  }, [offset, violations.length, total]);

  const handlePrev = () => {
    if (!canPrev) return;
    setOffset(Math.max(0, offset - limit));
  };
  const handleNext = () => {
    if (!canNext) return;
    setOffset(offset + limit);
  };

  return (
    <div
      style={{
        padding: "2rem",
        height: "100%",
        overflowY: "auto",
        animation: "fadeIn 0.4s ease-out",
      }}
    >
      <header style={{ marginBottom: 16 }}>
        <h1
          style={{
            display: "flex",
            alignItems: "center",
            gap: 10,
            margin: 0,
            fontSize: "1.75rem",
            fontWeight: 600,
          }}
        >
          <ShieldAlert size={26} color="var(--primary-color, var(--accent-color))" aria-hidden />{" "}
          CSP Violations
        </h1>
        <p
          style={{
            color: "var(--text-secondary)",
            marginTop: 4,
            fontSize: "0.9rem",
            maxWidth: 720,
          }}
        >
          Operator-inspect surface for the Content-Security-Policy Report-Only header.
          Use to triage whether a candidate CSP tightening is safe to enforce — a noisy
          directive needs widening first; a clean directive can flip.
        </p>
        <p
          style={{
            color: "var(--text-secondary)",
            marginTop: 4,
            fontSize: "0.82rem",
          }}
        >
          {pageInfo}
        </p>
      </header>

      {/* Filter bar */}
      <div
        className="glass"
        style={{
          padding: 12,
          marginBottom: 16,
          display: "flex",
          alignItems: "center",
          gap: 12,
          flexWrap: "wrap",
        }}
      >
        <Filter size={14} color="var(--text-secondary)" aria-hidden />
        <label
          style={{ display: "flex", flexDirection: "column", gap: 4, minWidth: 220 }}
        >
          <span style={labelStyle}>Directive</span>
          <input
            type="text"
            placeholder="e.g. script-src"
            value={directive}
            onChange={(e) => setDirective(e.target.value)}
            style={inputStyle}
            aria-label="Filter by directive"
            data-testid="csp-violations-filter-directive"
          />
        </label>
        <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          <span style={labelStyle}>From (ISO)</span>
          <input
            type="datetime-local"
            value={from}
            onChange={(e) => setFrom(e.target.value)}
            onBlur={() => setOffset(0)}
            style={inputStyle}
            aria-label="Filter from date"
            data-testid="csp-violations-filter-from"
          />
        </label>
        <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          <span style={labelStyle}>To (ISO)</span>
          <input
            type="datetime-local"
            value={to}
            onChange={(e) => setTo(e.target.value)}
            onBlur={() => setOffset(0)}
            style={inputStyle}
            aria-label="Filter to date"
            data-testid="csp-violations-filter-to"
          />
        </label>
      </div>

      {loading ? (
        <div
          className="card"
          style={{ padding: "3rem", textAlign: "center", color: "var(--text-secondary)" }}
        >
          Loading CSP violations&hellip;
        </div>
      ) : permissionDenied ? (
        <div
          className="card"
          style={{
            padding: "3rem 2rem",
            textAlign: "center",
            color: "var(--warning-color, #f59e0b)",
          }}
        >
          <AlertCircle size={28} style={{ opacity: 0.7, marginBottom: 10 }} />
          <div style={{ fontWeight: 600 }}>Access restricted.</div>
          <div
            style={{ fontSize: "0.9rem", marginTop: "0.5rem", color: "var(--text-secondary)" }}
          >
            Your role does not have permission to view CSP violations. Ask an Admin to grant access.
          </div>
        </div>
      ) : errorMsg ? (
        <div
          className="card"
          style={{
            padding: "3rem 2rem",
            textAlign: "center",
            color: "var(--danger-color, #f43f5e)",
          }}
          data-testid="csp-violations-error"
        >
          <AlertCircle size={28} style={{ opacity: 0.7, marginBottom: 10 }} />
          <div style={{ fontWeight: 600 }}>Failed to load CSP violations.</div>
          <div
            style={{ fontSize: "0.9rem", marginTop: "0.5rem", color: "var(--text-secondary)" }}
          >
            {errorMsg}
          </div>
        </div>
      ) : violations.length === 0 ? (
        <div
          className="card"
          style={{
            padding: "3rem 2rem",
            textAlign: "center",
            color: "var(--text-secondary)",
          }}
          data-testid="csp-violations-empty"
        >
          <ShieldAlert size={28} style={{ opacity: 0.5, marginBottom: 10 }} />
          <div style={{ fontWeight: 600 }}>No CSP violations recorded</div>
          <div style={{ fontSize: "0.9rem", marginTop: "0.5rem" }}>
            Either the policy is clean across the active filters, or the Report-Only header
            isn&apos;t live in this environment yet.
          </div>
        </div>
      ) : (
        <div className="card" style={{ padding: 0, overflowX: "auto" }}>
          <table
            style={{
              width: "100%",
              borderCollapse: "collapse",
              fontSize: 13,
            }}
            data-testid="csp-violations-table"
          >
            <thead>
              <tr>
                <th style={thStyle}>At</th>
                <th style={thStyle}>Directive</th>
                <th style={thStyle}>Blocked URI</th>
                <th style={thStyle}>Document URI</th>
                <th style={thStyle}>Source File</th>
                <th style={thStyle}>Line:Col</th>
              </tr>
            </thead>
            <tbody>
              {violations.map((v, idx) => (
                <tr key={`${v.at}-${idx}`} data-testid={`csp-violations-row-${idx}`}>
                  <td style={tdStyle}>
                    <code style={codeStyle}>{formatAt(v.at)}</code>
                  </td>
                  <td style={tdStyle}>
                    {v.directive ? (
                      <code style={codeStyle}>{v.directive}</code>
                    ) : (
                      <span style={mutedStyle}>—</span>
                    )}
                  </td>
                  <td style={tdStyle}>{truncate(v.blockedUri)}</td>
                  <td style={tdStyle}>{truncate(v.documentUri)}</td>
                  <td style={tdStyle}>{truncate(v.sourceFile)}</td>
                  <td style={tdStyle}>
                    {v.lineNumber != null || v.columnNumber != null ? (
                      <code style={codeStyle}>
                        {v.lineNumber ?? "?"}:{v.columnNumber ?? "?"}
                      </code>
                    ) : (
                      <span style={mutedStyle}>—</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Pagination */}
      {!loading && !permissionDenied && total > 0 && (
        <div
          style={{
            display: "flex",
            justifyContent: "flex-end",
            alignItems: "center",
            gap: 8,
            marginTop: 16,
          }}
        >
          <button
            type="button"
            onClick={handlePrev}
            disabled={!canPrev}
            style={{ ...secondaryBtn, opacity: canPrev ? 1 : 0.4, cursor: canPrev ? "pointer" : "not-allowed" }}
            aria-label="Previous page"
            data-testid="csp-violations-prev"
          >
            <ChevronLeft size={14} /> Prev
          </button>
          <span style={{ fontSize: 12, color: "var(--text-secondary)", padding: "0 8px" }}>
            {pageInfo}
          </span>
          <button
            type="button"
            onClick={handleNext}
            disabled={!canNext}
            style={{ ...secondaryBtn, opacity: canNext ? 1 : 0.4, cursor: canNext ? "pointer" : "not-allowed" }}
            aria-label="Next page"
            data-testid="csp-violations-next"
          >
            Next <ChevronRight size={14} />
          </button>
        </div>
      )}
    </div>
  );
}

/* ────────────────────────────────────────────────────────────────────────
 * Helpers
 * ──────────────────────────────────────────────────────────────────────── */
function formatAt(at) {
  if (!at) return "";
  try {
    const d = new Date(at);
    if (isNaN(d.getTime())) return String(at);
    return d.toISOString().replace("T", " ").slice(0, 19) + "Z";
  } catch {
    return String(at);
  }
}

function truncate(s, max = 80) {
  if (!s) return <span style={mutedStyle}>—</span>;
  const str = String(s);
  if (str.length <= max) return <span title={str}>{str}</span>;
  return <span title={str}>{str.slice(0, max)}&hellip;</span>;
}

/* ────────────────────────────────────────────────────────────────────────
 * Styles
 * ──────────────────────────────────────────────────────────────────────── */
const inputStyle = {
  padding: "6px 10px",
  borderRadius: 6,
  border: "1px solid var(--border-color)",
  background: "var(--bg-color, rgba(255,255,255,0.05))",
  color: "var(--text-primary)",
  fontSize: 13,
  outline: "none",
  minWidth: 160,
  boxSizing: "border-box",
};
const labelStyle = {
  fontSize: 11,
  color: "var(--text-secondary)",
  fontWeight: 600,
  textTransform: "uppercase",
  letterSpacing: 0.4,
};
const thStyle = {
  padding: "10px 12px",
  textAlign: "left",
  fontSize: 11,
  fontWeight: 600,
  textTransform: "uppercase",
  letterSpacing: 0.4,
  color: "var(--text-secondary)",
  borderBottom: "1px solid var(--border-color)",
  background: "var(--surface-color)",
  position: "sticky",
  top: 0,
};
const tdStyle = {
  padding: "8px 12px",
  borderBottom: "1px solid var(--border-color)",
  color: "var(--text-primary)",
  verticalAlign: "top",
  fontSize: 12,
  maxWidth: 280,
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};
const codeStyle = {
  fontFamily: "monospace",
  fontSize: 12,
  background: "rgba(255,255,255,0.05)",
  padding: "1px 6px",
  borderRadius: 3,
};
const mutedStyle = {
  color: "var(--text-secondary)",
  fontStyle: "italic",
};
const secondaryBtn = {
  display: "inline-flex",
  alignItems: "center",
  gap: 6,
  padding: "6px 12px",
  borderRadius: 6,
  fontWeight: 600,
  fontSize: 12,
  background: "var(--surface-color)",
  color: "var(--text-primary)",
  border: "1px solid var(--border-color)",
};
