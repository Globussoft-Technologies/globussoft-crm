import { useEffect, useState, useMemo } from "react";
import { Phone, X, Loader, RefreshCw, Trash2, Clock, AlertCircle, CheckCircle2, PhoneOff } from "lucide-react";
import { fetchApi } from "../utils/api";
import { useNotify } from "../utils/notify";

const STATUS_META = {
  INITIATED: { label: "Calling…", color: "var(--warning-color)", bg: "rgba(245, 158, 11, 0.12)", icon: Phone },
  RINGING: { label: "Ringing…", color: "var(--warning-color)", bg: "rgba(245, 158, 11, 0.12)", icon: Phone },
  CONNECTED: { label: "On call", color: "var(--accent-color)", bg: "rgba(59, 130, 246, 0.12)", icon: Phone },
  COMPLETED: { label: "Call completed", color: "var(--success-color)", bg: "rgba(16, 185, 129, 0.12)", icon: CheckCircle2 },
  MISSED: { label: "Lead hung up / did not answer", color: "#ef4444", bg: "rgba(239, 68, 68, 0.12)", icon: PhoneOff },
  FAILED: { label: "Call failed", color: "#ef4444", bg: "rgba(239, 68, 68, 0.12)", icon: AlertCircle },
};

export default function CallifiedCallStatusDrawer({ onClose }) {
  const notify = useNotify();
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [history, setHistory] = useState([]);
  const [clearing, setClearing] = useState(false);

  const syncAndLoad = async ({ silent = false } = {}) => {
    if (!silent) setSyncing(true);
    try {
      await fetchApi("/api/callified/leads/sync-call-statuses", { method: "POST" });
    } catch (err) {
      console.error("[call-status] sync failed:", err?.message);
    } finally {
      if (!silent) setSyncing(false);
    }
    await loadHistory({ silent });
  };

  const loadHistory = async ({ silent = false } = {}) => {
    if (!silent) setRefreshing(true);
    try {
      const res = await fetchApi("/api/callified/leads/call-status-history");
      setHistory(Array.isArray(res?.history) ? res.history : []);
    } catch (err) {
      notify.error(err?.message || "Failed to load call status history");
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  };

  useEffect(() => {
    syncAndLoad();
    // Keep statuses fluid while the drawer is open.
    const interval = setInterval(() => syncAndLoad({ silent: true }), 5000);
    return () => clearInterval(interval);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleClear = async () => {
    if (!window.confirm("Clear all Callified call status history? This cannot be undone.")) return;
    setClearing(true);
    try {
      await fetchApi("/api/callified/leads/call-status-history", { method: "DELETE" });
      setHistory([]);
      notify.success("Call status history cleared");
    } catch (err) {
      notify.error(err?.message || "Failed to clear history");
    } finally {
      setClearing(false);
    }
  };

  const formatTime = (iso) => {
    if (!iso) return "Unknown";
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    return d.toLocaleString(undefined, {
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    });
  };

  const formatDuration = (s) => {
    const seconds = Math.round(Number(s) || 0);
    if (seconds <= 0) return null;
    if (seconds < 60) return `${seconds}s`;
    const m = Math.floor(seconds / 60);
    const rem = seconds % 60;
    return `${m}m ${rem}s`;
  };

  const formatElapsed = (iso) => {
    if (!iso) return null;
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return null;
    const elapsed = Math.max(0, Math.round((Date.now() - d.getTime()) / 1000));
    if (elapsed < 60) return `${elapsed}s ago`;
    const m = Math.floor(elapsed / 60);
    const s = elapsed % 60;
    return `${m}m ${s}s ago`;
  };

  const campaignName = (item) => {
    try {
      const notes = typeof item.notes === "object" && item.notes !== null ? item.notes : JSON.parse(item.notes || "{}");
      return notes.campaignName || notes.campaign?.name || (notes.campaignId ? `Campaign #${notes.campaignId}` : null);
    } catch (_) {
      return null;
    }
  };

  const scoreText = (item) => {
    try {
      const notes = typeof item.notes === "object" && item.notes !== null ? item.notes : JSON.parse(item.notes || "{}");
      const review = Array.isArray(notes.reviews) ? notes.reviews.find((r) => r && !r.error) : null;
      if (review && typeof review.quality_score === "number") {
        return `${review.quality_score}/5`;
      }
      return null;
    } catch (_) {
      return null;
    }
  };

  const sortedHistory = useMemo(() => {
    const order = (status) => {
      if (status === "CONNECTED" || status === "RINGING" || status === "INITIATED") return 0;
      if (status === "COMPLETED") return 1;
      return 2;
    };
    return [...history].sort((a, b) => {
      const oa = order(a.status);
      const ob = order(b.status);
      if (oa !== ob) return oa - ob;
      return new Date(b.createdAt || 0).getTime() - new Date(a.createdAt || 0).getTime();
    });
  }, [history]);

  const activeCount = history.filter((h) => ["INITIATED", "RINGING", "CONNECTED"].includes(h.status)).length;
  const completedCount = history.filter((h) => h.status === "COMPLETED").length;
  const missedCount = history.filter((h) => ["MISSED", "FAILED"].includes(h.status)).length;

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 1000,
        display: "flex",
        justifyContent: "flex-end",
      }}
    >
      <div
        onClick={onClose}
        style={{
          position: "absolute",
          inset: 0,
          background: "rgba(0,0,0,0.5)",
        }}
      />
      <div
        className="card"
        style={{
          position: "relative",
          width: "100%",
          maxWidth: "520px",
          height: "100vh",
          background: "var(--bg-color)",
          borderLeft: "1px solid var(--border-color)",
          overflowY: "auto",
          padding: "1.25rem",
          zIndex: 1,
        }}
      >
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "1rem" }}>
          <h3 style={{ margin: 0, fontSize: "1.125rem", fontWeight: 600, display: "flex", alignItems: "center", gap: "0.5rem" }}>
            <Phone size={20} color="var(--accent-color)" /> Call Status
            {(syncing || refreshing) && <Loader size={16} style={{ animation: "spin 1s linear infinite", color: "var(--text-secondary)" }} />}
          </h3>
          <div style={{ display: "flex", gap: "0.5rem", alignItems: "center" }}>
            <button
              onClick={() => syncAndLoad()}
              disabled={refreshing || loading || syncing}
              title="Refresh"
              style={{ background: "transparent", border: "none", color: "var(--text-secondary)", cursor: "pointer" }}
            >
              <RefreshCw size={18} style={refreshing || syncing ? { animation: "spin 1s linear infinite" } : {}} />
            </button>
            <button
              onClick={handleClear}
              disabled={clearing || loading || history.length === 0}
              title="Clear history"
              style={{ background: "transparent", border: "none", color: history.length === 0 ? "var(--text-secondary)" : "var(--danger-color, #ef4444)", cursor: history.length === 0 ? "default" : "pointer" }}
            >
              <Trash2 size={18} />
            </button>
            <button
              onClick={onClose}
              style={{ background: "transparent", border: "none", color: "var(--text-secondary)", cursor: "pointer" }}
            >
              <X size={20} />
            </button>
          </div>
        </div>

        {history.length > 0 && (
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(3, 1fr)",
              gap: "0.5rem",
              marginBottom: "1rem",
            }}
          >
            {[
              { label: "Active", count: activeCount, color: "var(--warning-color)" },
              { label: "Completed", count: completedCount, color: "var(--success-color)" },
              { label: "Missed / Failed", count: missedCount, color: "#ef4444" },
            ].map((stat) => (
              <div
                key={stat.label}
                style={{
                  padding: "0.625rem",
                  borderRadius: "8px",
                  background: "var(--subtle-bg)",
                  border: "1px solid var(--border-color)",
                  textAlign: "center",
                }}
              >
                <div style={{ fontSize: "1.125rem", fontWeight: 700, color: stat.color }}>{stat.count}</div>
                <div style={{ fontSize: "0.7rem", color: "var(--text-secondary)" }}>{stat.label}</div>
              </div>
            ))}
          </div>
        )}

        {loading ? (
          <div style={{ display: "flex", alignItems: "center", gap: "0.5rem", color: "var(--text-secondary)", padding: "2rem 0" }}>
            <Loader size={18} style={{ animation: "spin 1s linear infinite" }} /> Loading call status history…
          </div>
        ) : history.length === 0 ? (
          <div style={{ color: "var(--text-secondary)", padding: "1rem 0" }}>
            No Callified calls yet. History appears here as calls are made.
          </div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: "0.75rem" }}>
            {sortedHistory.map((item) => {
              const meta = STATUS_META[item.status] || STATUS_META.INITIATED;
              const Icon = meta.icon;
              const elapsed = ["INITIATED", "RINGING", "CONNECTED"].includes(item.status) ? formatElapsed(item.createdAt) : null;
              const cName = campaignName(item);
              const score = scoreText(item);
              return (
                <div
                  key={item.id}
                  style={{
                    padding: "0.875rem 1rem",
                    borderRadius: "10px",
                    background: "var(--subtle-bg)",
                    border: "1px solid var(--border-color)",
                  }}
                >
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: "0.5rem" }}>
                    <div style={{ minWidth: 0 }}>
                      <div style={{ fontWeight: 600, fontSize: "0.95rem", marginBottom: "0.15rem", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        {item.contact?.name || item.contact?.email || `Lead #${item.contactId}`}
                      </div>
                      <div style={{ fontSize: "0.8rem", color: "var(--text-secondary)" }}>
                        {item.contact?.phone || item.calleeNumber || "—"}
                      </div>
                    </div>
                    <span
                      style={{
                        fontSize: "0.75rem",
                        fontWeight: 600,
                        padding: "0.3rem 0.7rem",
                        borderRadius: "999px",
                        background: meta.bg,
                        color: meta.color,
                        whiteSpace: "nowrap",
                        display: "flex",
                        alignItems: "center",
                        gap: "0.35rem",
                      }}
                    >
                      <Icon size={12} /> {meta.label}
                    </span>
                  </div>
                  <div style={{ display: "flex", alignItems: "center", flexWrap: "wrap", gap: "0.75rem", marginTop: "0.5rem", fontSize: "0.8rem", color: "var(--text-secondary)" }}>
                    <span style={{ display: "flex", alignItems: "center", gap: "0.25rem" }}>
                      <Clock size={12} /> {formatTime(item.createdAt)}
                    </span>
                    {elapsed && (
                      <span style={{ color: meta.color, fontWeight: 600 }}>{elapsed}</span>
                    )}
                    {formatDuration(item.duration) && (
                      <span>Duration: {formatDuration(item.duration)}</span>
                    )}
                    {cName && (
                      <span style={{ color: "var(--text-secondary)" }}>• {cName}</span>
                    )}
                    {score && (
                      <span style={{ color: "var(--accent-color)", fontWeight: 600 }}>Score: {score}</span>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
