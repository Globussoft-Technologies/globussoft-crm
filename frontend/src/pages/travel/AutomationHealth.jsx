// Travel CRM — Web check-in automation health (PRD_AIRLINE_WEBCHECKIN_AUTOMATION
// FR-8 / AC-5).
//
// Surfaces the rolling success rate of the airline web check-in AUTOMATION
// engine (backend/cron/webCheckinAutomation.js) per airline, derived from
// WebCheckinAutomationRun rows. One card per airline shows the success rate
// over the selected window plus the success / failure / captcha /
// not-implemented breakdown and the last failure time.
//
// Endpoint consumed:
//   GET /api/travel/automation-health/per-airline?windowHours=<1..168>
//
// Reading the cards:
//   - successRate is null when the only runs are "not-implemented" (no adapter
//     live yet) — the engine routed those rows to a human, which is expected,
//     not a degradation.
//   - successRate < 60% over the window is flagged red (PRD OQ-4 alert
//     threshold) — likely a DOM change on that airline's portal.
//
// No auto-poll — operators hit Refresh.

import { useEffect, useState } from "react";
import { Activity, RefreshCw, AlertTriangle, PlaneTakeoff } from "lucide-react";
import { fetchApi } from "../../utils/api";
import { useNotify } from "../../utils/notify";

const AIRLINE_NAMES = {
  "6E": "IndiGo",
  AI: "Air India",
  UK: "Vistara",
  EK: "Emirates",
};

const WINDOWS = [
  { value: 24, label: "Last 24h" },
  { value: 48, label: "Last 48h" },
  { value: 168, label: "Last 7d" },
];

// PRD OQ-4: success rate below this over the window is a degradation signal.
const DEGRADED_THRESHOLD = 0.6;

function fmtDateTime(d) {
  if (!d) return "—";
  const dt = new Date(d);
  if (!Number.isFinite(dt.getTime())) return "—";
  return dt.toLocaleString();
}

function ratePalette(rate) {
  if (rate == null) return { bg: "rgba(120,120,120,0.12)", color: "#555" };
  if (rate < DEGRADED_THRESHOLD) return { bg: "rgba(168,50,63,0.16)", color: "#A8323F" };
  if (rate < 0.85) return { bg: "rgba(200,154,78,0.18)", color: "#9A6F2E" };
  return { bg: "rgba(47,122,77,0.16)", color: "#2F7A4D" };
}

export default function AutomationHealth() {
  const notify = useNotify();
  const [windowHours, setWindowHours] = useState(24);
  const [perAirline, setPerAirline] = useState([]);
  const [loading, setLoading] = useState(true);

  const load = () => {
    setLoading(true);
    fetchApi(`/api/travel/automation-health/per-airline?windowHours=${windowHours}`)
      .then((res) => {
        setPerAirline(Array.isArray(res?.perAirline) ? res.perAirline : []);
      })
      .catch((e) => {
        // fetchApi already toasted; just zero the state.
        if (e?.status !== 401) setPerAirline([]);
      })
      .finally(() => setLoading(false));
  };

  useEffect(load, [windowHours]);

  const anyDegraded = perAirline.some(
    (a) => a.successRate != null && a.successRate < DEGRADED_THRESHOLD,
  );

  return (
    <div style={pageStyle}>
      <div style={headerRowStyle}>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <Activity size={22} color="#1F5DAA" />
          <h1 style={titleStyle}>Web check-in automation health</h1>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <select
            value={windowHours}
            onChange={(e) => setWindowHours(Number(e.target.value))}
            style={selectStyle}
            aria-label="Time window"
          >
            {WINDOWS.map((w) => (
              <option key={w.value} value={w.value}>{w.label}</option>
            ))}
          </select>
          <button onClick={load} style={refreshBtnStyle} disabled={loading}>
            <RefreshCw size={15} style={{ marginRight: 6 }} />
            Refresh
          </button>
        </div>
      </div>

      {anyDegraded && (
        <div style={alertBannerStyle}>
          <AlertTriangle size={16} style={{ marginRight: 8, flexShrink: 0 }} />
          One or more airlines are below the {Math.round(DEGRADED_THRESHOLD * 100)}% success
          threshold for this window — likely an airline portal/DOM change. Check the adapter owner.
        </div>
      )}

      {loading ? (
        <p style={mutedStyle}>Loading…</p>
      ) : perAirline.length === 0 ? (
        <div style={emptyStyle}>
          <PlaneTakeoff size={28} color="#9aa0a6" style={{ marginBottom: 10 }} />
          <p style={{ margin: 0, fontWeight: 600 }}>No automation runs in this window</p>
          <p style={mutedStyle}>
            The automation engine records a run per check-in attempt. Airline adapters
            ship stubbed (not-implemented) until rollout, so until then rows route to
            manual fallback and won't appear here.
          </p>
        </div>
      ) : (
        <div style={cardGridStyle}>
          {perAirline.map((a) => {
            const pal = ratePalette(a.successRate);
            const ratePct = a.successRate == null ? "N/A" : `${Math.round(a.successRate * 100)}%`;
            return (
              <div key={a.airlineCode} style={cardStyle}>
                <div style={cardHeadStyle}>
                  <div>
                    <div style={airlineNameStyle}>{AIRLINE_NAMES[a.airlineCode] || a.airlineCode}</div>
                    <div style={airlineCodeStyle}>{a.airlineCode}</div>
                  </div>
                  <span style={{ ...rateBadgeStyle, background: pal.bg, color: pal.color }}>
                    {ratePct}
                  </span>
                </div>
                <div style={statRowStyle}>
                  <Stat label="Attempts" value={a.total} />
                  <Stat label="Success" value={a.success} color="#2F7A4D" />
                  <Stat label="Failure" value={a.failure} color="#A8323F" />
                </div>
                <div style={statRowStyle}>
                  <Stat label="Captcha" value={a.captcha} color="#9A6F2E" />
                  <Stat label="No adapter" value={a.notImplemented} color="#555" />
                  <Stat label="Last fail" value={fmtDateTime(a.lastFailureAt)} small />
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function Stat({ label, value, color, small }) {
  return (
    <div style={{ flex: 1, minWidth: 0 }}>
      <div style={statLabelStyle}>{label}</div>
      <div style={{ ...statValueStyle, color: color || "#222", fontSize: small ? 12 : 18 }}>
        {value}
      </div>
    </div>
  );
}

// ─── styles ──────────────────────────────────────────────────────────
const pageStyle = { padding: 24, maxWidth: 1100, margin: "0 auto" };
const headerRowStyle = { display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 12, marginBottom: 18 };
const titleStyle = { margin: 0, fontSize: 22, fontWeight: 700, color: "var(--text-primary)" };
const selectStyle = { padding: "7px 10px", borderRadius: 8, border: "1px solid var(--border-color)", fontSize: 14, background: "var(--input-bg)", color: "var(--text-primary)" };
const refreshBtnStyle = { display: "inline-flex", alignItems: "center", padding: "7px 14px", borderRadius: 8, border: "1px solid #1F5DAA", background: "#1F5DAA", color: "#fff", fontSize: 14, cursor: "pointer" };
const alertBannerStyle = { display: "flex", alignItems: "center", padding: "10px 14px", borderRadius: 8, background: "rgba(168,50,63,0.10)", color: "#A8323F", fontSize: 13.5, marginBottom: 16 };
const mutedStyle = { color: "var(--text-secondary)", fontSize: 13.5, marginTop: 8 };
const emptyStyle = { textAlign: "center", padding: "48px 20px", border: "1px dashed var(--border-color)", borderRadius: 12, color: "var(--text-secondary)" };
const cardGridStyle = { display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(300px, 1fr))", gap: 16 };
const cardStyle = { border: "1px solid var(--border-color)", borderRadius: 12, padding: 16, background: "var(--surface-color)", boxShadow: "0 1px 2px rgba(0,0,0,0.04)" };
const cardHeadStyle = { display: "flex", alignItems: "flex-start", justifyContent: "space-between", marginBottom: 14 };
const airlineNameStyle = { fontSize: 16, fontWeight: 700, color: "var(--text-primary)" };
const airlineCodeStyle = { fontSize: 12, color: "var(--text-secondary)", fontWeight: 600, letterSpacing: 0.5 };
const rateBadgeStyle = { padding: "4px 12px", borderRadius: 999, fontSize: 15, fontWeight: 700 };
const statRowStyle = { display: "flex", gap: 12, marginTop: 10 };
const statLabelStyle = { fontSize: 11, color: "var(--text-secondary)", textTransform: "uppercase", letterSpacing: 0.4 };
const statValueStyle = { fontWeight: 700, marginTop: 2, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" };
