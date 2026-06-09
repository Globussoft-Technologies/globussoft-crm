// Travel CRM — POI rep-suggested pending-approval queue (Wave 18 slice S12).
//
// Sits on top of backend/routes/travel_pois.js. Reps suggest a POI inline
// (FR-3.7); the suggestion lands with `pendingApproval=true`; ADMIN reviews
// here and approves or rejects.
//
// Endpoints consumed:
//   GET   /api/travel/pois/pending          — list pending rows (ADMIN+MANAGER)
//   POST  /api/travel/pois/:id/approve      — ADMIN
//   POST  /api/travel/pois/:id/reject       — ADMIN (hard delete)
//
// Access: ADMIN-only page. Backend RBAC enforces the gate; this page also
// renders a graceful "access denied" surface for non-ADMIN roles instead
// of crashing on the 403.
//
// useNotify is mocked stably in tests per the CLAUDE.md feedback rule
// ("stable mock object references for hooks used in `useCallback`
// dependencies") so the dependency identity doesn't churn every render.

import { useEffect, useMemo, useState } from "react";
import {
  BadgeCheck,
  XCircle,
  RefreshCw,
  MapPin,
  ShieldAlert,
} from "lucide-react";
import { fetchApi } from "../../utils/api";
import { useNotify } from "../../utils/notify";

function fmtDateTime(d) {
  if (!d) return "—";
  const dt = new Date(d);
  if (!Number.isFinite(dt.getTime())) return "—";
  return dt.toLocaleString();
}

function fmtCoord(lat, lng) {
  if (typeof lat !== "number" || typeof lng !== "number") return "—";
  return `${lat.toFixed(4)}, ${lng.toFixed(4)}`;
}

function currentUserRole() {
  // Read role from the persisted auth surface without coupling to the
  // AuthContext (this page is reachable via direct nav; defensive read).
  try {
    const raw = typeof window !== "undefined" && window.localStorage
      ? window.localStorage.getItem("user")
      : null;
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed.role === "string" ? parsed.role : null;
  } catch (_e) {
    return null;
  }
}

export default function PoiPendingApprovalQueue() {
  const notify = useNotify();
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [busyId, setBusyId] = useState(null);

  const role = useMemo(() => currentUserRole(), []);
  const isAdmin = role === "ADMIN";

  const load = () => {
    setLoading(true);
    setError(null);
    fetchApi("/api/travel/pois/pending")
      .then((data) => {
        setRows(Array.isArray(data?.pending) ? data.pending : []);
        setLoading(false);
      })
      .catch((e) => {
        setError(e?.message || "Failed to load pending POI queue");
        setLoading(false);
      });
  };

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleApprove = (row) => {
    setBusyId(row.id);
    fetchApi(`/api/travel/pois/${row.id}/approve`, { method: "POST" })
      .then(() => {
        notify.success(`Approved POI: ${row.name}`);
        setRows((prev) => prev.filter((r) => r.id !== row.id));
      })
      .catch((e) => notify.error(e?.message || "Failed to approve POI"))
      .finally(() => setBusyId(null));
  };

  const handleReject = async (row) => {
    const ok = await notify.confirm({
      title: "Reject POI suggestion?",
      message: `"${row.name}" will be permanently deleted from the queue.`,
      confirmText: "Reject",
      cancelText: "Cancel",
      destructive: true,
    });
    if (!ok) return;
    setBusyId(row.id);
    fetchApi(`/api/travel/pois/${row.id}/reject`, { method: "POST" })
      .then(() => {
        notify.info(`Rejected POI: ${row.name}`);
        setRows((prev) => prev.filter((r) => r.id !== row.id));
      })
      .catch((e) => notify.error(e?.message || "Failed to reject POI"))
      .finally(() => setBusyId(null));
  };

  // ─── Styles ─────────────────────────────────────────────────────────

  const wrap = { padding: 24, maxWidth: 1200, margin: "0 auto" };
  const headerStyle = {
    display: "flex", alignItems: "center", gap: 12, marginBottom: 8,
  };
  const subStyle = {
    color: "var(--text-secondary)", fontSize: 13, marginBottom: 24,
  };
  const card = {
    background: "var(--surface-color)",
    border: "1px solid var(--border-color)",
    borderRadius: 8,
    padding: 16,
    marginBottom: 12,
  };
  const fieldGrid = {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 200px), 1fr))",
    gap: 8,
    marginTop: 12,
  };
  const fieldBox = {
    background: "var(--subtle-bg, var(--bg-color))",
    padding: "8px 10px",
    borderRadius: 4,
    fontSize: 13,
  };
  const labelStyle = {
    fontSize: 11, color: "var(--text-secondary)",
    textTransform: "uppercase", letterSpacing: 0.5,
  };
  const actionRow = {
    display: "flex", gap: 8, flexWrap: "wrap",
    alignItems: "center", marginTop: 12,
  };
  const primaryBtn = {
    display: "inline-flex", alignItems: "center", gap: 4,
    padding: "6px 12px",
    background: "var(--primary-color, var(--accent-color))",
    color: "white", border: "none", borderRadius: 4,
    fontSize: 13, fontWeight: 600, cursor: "pointer",
  };
  const secondaryBtn = {
    display: "inline-flex", alignItems: "center", gap: 4,
    padding: "6px 12px",
    background: "transparent",
    color: "var(--text-primary)",
    border: "1px solid var(--border-color)", borderRadius: 4,
    fontSize: 13, fontWeight: 500, cursor: "pointer",
  };
  const dangerBtn = {
    display: "inline-flex", alignItems: "center", gap: 4,
    padding: "6px 12px",
    background: "transparent",
    color: "#A8323F",
    border: "1px solid #A8323F", borderRadius: 4,
    fontSize: 13, fontWeight: 600, cursor: "pointer",
  };
  const categoryBadge = {
    display: "inline-block",
    background: "rgba(38,88,85,0.10)",
    color: "var(--primary-color, var(--accent-color))",
    fontSize: 11, fontWeight: 600,
    padding: "2px 8px", borderRadius: 12,
    textTransform: "uppercase", letterSpacing: 0.5,
  };

  // ─── Render — defensive ADMIN gate ───────────────────────────────────

  if (role && !isAdmin) {
    return (
      <div style={wrap}>
        <div style={headerStyle}>
          <ShieldAlert size={22} aria-hidden style={{ color: "#A8323F" }} />
          <h1 style={{ margin: 0, fontSize: 22 }}>POI approval queue</h1>
        </div>
        <div
          style={{
            ...card,
            background: "rgba(168,50,63,0.08)",
            borderColor: "#A8323F",
            color: "#A8323F",
          }}
          role="alert"
        >
          This page is restricted to ADMIN users. Your current role is{" "}
          <strong>{role}</strong>.
        </div>
      </div>
    );
  }

  return (
    <div style={wrap}>
      <div style={headerStyle}>
        <MapPin
          size={22}
          aria-hidden
          style={{ color: "var(--primary-color, var(--accent-color))" }}
        />
        <h1 style={{ margin: 0, fontSize: 22 }}>POI approval queue</h1>
        <button
          type="button"
          onClick={load}
          style={{ ...secondaryBtn, marginLeft: "auto" }}
          aria-label="Refresh queue"
        >
          <RefreshCw size={14} aria-hidden /> Refresh
        </button>
      </div>
      <p style={subStyle}>
        Rep-suggested points of interest awaiting review. Approve to publish
        to the tenant catalog, or reject to discard.
      </p>

      {loading && <div style={card} role="status">Loading pending POI queue&hellip;</div>}

      {error && (
        <div
          style={{
            ...card,
            background: "rgba(168,50,63,0.08)",
            borderColor: "#A8323F",
            color: "#A8323F",
          }}
          role="alert"
        >
          <ShieldAlert size={14} aria-hidden style={{ marginRight: 4 }} />
          {error}
        </div>
      )}

      {!loading && !error && rows.length === 0 && (
        <div
          style={{
            ...card,
            textAlign: "center",
            color: "var(--text-secondary)",
          }}
        >
          No POIs pending approval.
        </div>
      )}

      {!loading && !error && rows.map((row) => {
        const isBusy = busyId === row.id;
        return (
          <div key={row.id} style={card}>
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "flex-start",
                gap: 12,
                flexWrap: "wrap",
              }}
            >
              <div>
                <div style={{ fontSize: 16, fontWeight: 600, color: "var(--text-primary)" }}>
                  {row.name}
                  {row.category && (
                    <span style={{ ...categoryBadge, marginLeft: 8 }}>
                      {row.category}
                    </span>
                  )}
                </div>
                {row.nameLocal && (
                  <div style={{ fontSize: 13, color: "var(--text-secondary)", marginTop: 2 }}>
                    {row.nameLocal}
                  </div>
                )}
                <div style={{ fontSize: 12, color: "var(--text-secondary)", marginTop: 4 }}>
                  Suggested {fmtDateTime(row.createdAt)}
                  {row.externalSource ? ` · source: ${row.externalSource}` : ""}
                </div>
              </div>
            </div>

            <div style={fieldGrid}>
              <div style={fieldBox}>
                <div style={labelStyle}>Destination</div>
                <div>{row.destinationSlug || "—"}</div>
              </div>
              <div style={fieldBox}>
                <div style={labelStyle}>Country</div>
                <div>{row.country || "—"}</div>
              </div>
              <div style={fieldBox}>
                <div style={labelStyle}>Coordinates</div>
                <div>{fmtCoord(row.latitude, row.longitude)}</div>
              </div>
              <div style={fieldBox}>
                <div style={labelStyle}>Image URL</div>
                <div style={{ wordBreak: "break-all" }}>{row.imageUrl || "—"}</div>
              </div>
            </div>

            {row.descriptionShort && (
              <div
                style={{
                  ...fieldBox,
                  marginTop: 8,
                  background: "var(--subtle-bg, var(--bg-color))",
                }}
              >
                <div style={labelStyle}>Description</div>
                <div style={{ marginTop: 4 }}>{row.descriptionShort}</div>
              </div>
            )}

            <div style={actionRow}>
              <button
                type="button"
                onClick={() => handleApprove(row)}
                style={primaryBtn}
                disabled={isBusy}
                aria-label={`Approve POI ${row.name}`}
              >
                <BadgeCheck size={14} aria-hidden />
                {isBusy ? "Working…" : "Approve"}
              </button>
              <button
                type="button"
                onClick={() => handleReject(row)}
                style={dangerBtn}
                disabled={isBusy}
                aria-label={`Reject POI ${row.name}`}
              >
                <XCircle size={14} aria-hidden /> Reject
              </button>
            </div>
          </div>
        );
      })}
    </div>
  );
}
