/**
 * CallifiedCalls.jsx — operator-facing Callified.ai AI outbound calling.
 *
 * Consumes /api/callified (backend route commit cdad62d, tick #104 — thin
 * wrapper over backend/services/callifiedClient.js). Endpoints:
 *   POST /api/callified/calls/initiate   (ADMIN/MANAGER)
 *     Body: { subBrand?, toPhone (required), leadId?, intent?, persona? }
 *     → 200 { stub, callId, status, ... }
 *     → 400 { error, code: "MISSING_TO_PHONE" }
 *     → 402 { error, code: "AI_CALLING_BUDGET_EXCEEDED", spentCents, capCents }
 *     → 403 { error, code: "AI_CALLING_DISABLED" }  ← per-tenant feature flag
 *   GET /api/callified/calls/:callId/result
 *     → 200 { stub, callId, status, recordingUrl?, transcript?, summary?, outcome?, ... }
 *   GET /api/callified/cap-status   (ADMIN-only)
 *     → 200 { spentCents, capCents, percent, withinCap, alertThreshold }
 *     → 402 { error, code: "AI_CALLING_BUDGET_EXCEEDED", spentCents, capCents }
 *   GET /api/callified/enabled
 *     → 200 { enabled: boolean }
 *
 * Per-tenant feature flag (DC-7 per-tenant disable toggle): GET /enabled is
 * called on mount. If disabled, the entire page renders a "feature disabled"
 * state pointing at Tenant Settings rather than the action form. A 403
 * AI_CALLING_DISABLED returned from initiate is also treated as a fallback
 * re-check (e.g. flag flipped mid-session).
 *
 * STUB-mode caveat: the backend client is in stub mode (Q1 cred-blocked per
 * docs/CREDS_TRACKER.md Cat 1 — Yasin's Callified.ai handover). Today every
 * initiate/result response carries `stub: true`. When the cred swap lands
 * (single-point in backend/services/callifiedClient.js `initiateCall` +
 * `fetchCallResult` bodies), this UI continues to work unchanged — the stub
 * banner just stops rendering.
 *
 * Pattern mirror: header + cap-status pill + stub banner + cap-exceeded
 * banner all clone RateHawkSearch.jsx (commit f4268c1) and AdsGPTReports.jsx
 * (commit 850391d). This is the 3rd cap-consumer UI — rule-of-3 extraction
 * is primed but DELIBERATELY held until a follow-up tick (per tick #104 spec)
 * so all 3 callers stay byte-identical for the cleanup retrofit. The inlined
 * shape here matches the other two verbatim.
 *
 * Access: ADMIN + MANAGER (outbound calls reach real customers + cost real
 * money). The /cap-status call is ADMIN-only on the backend; MANAGER users
 * get a 403 there which is swallowed silently (the cap-status pill simply
 * does not render).
 */

import { useEffect, useState } from "react";
import { Link as RouterLink } from "react-router-dom";
import {
  Phone,
  PhoneCall,
  AlertCircle,
  PhoneOff,
  Download,
  FileText,
  Sparkles,
} from "lucide-react";
import { fetchApi } from "../../utils/api";
import { useNotify } from "../../utils/notify";
import { SUB_BRAND_IDS, subBrandLabel } from "../../utils/travelSubBrand";
import {
  CapStatusPill,
  StubModeBanner,
  CapExceededBanner,
} from "../../components/CapBanners";

// Sub-brand options — "(no sub-brand)" maps to the tenant-wide bucket.
const SUB_BRAND_OPTIONS = [
  { value: "", label: "(no sub-brand)" },
  ...SUB_BRAND_IDS.map((id) => ({ value: id, label: subBrandLabel(id) })),
];

export default function CallifiedCalls() {
  const notify = useNotify();

  // Feature-flag (DC-7 per-tenant disable toggle). Loaded on mount via
  // GET /api/callified/enabled.
  const [enabled, setEnabled] = useState(null); // null = loading, true/false = resolved
  const [enabledLoading, setEnabledLoading] = useState(true);

  // Cap-status (loaded on mount; ADMIN-only on backend so MANAGER gets 403
  // and we render no pill at all rather than an error toast).
  const [capStatus, setCapStatus] = useState(null);
  const [capStatusLoading, setCapStatusLoading] = useState(true);

  // Form state for initiate.
  const [subBrand, setSubBrand] = useState("");
  const [toPhone, setToPhone] = useState("");
  const [leadId, setLeadId] = useState("");
  const [intent, setIntent] = useState("");
  const [persona, setPersona] = useState("");

  // Call lifecycle state.
  const [lastCall, setLastCall] = useState(null); // initiate response
  const [initiateLoading, setInitiateLoading] = useState(false);
  const [lastResult, setLastResult] = useState(null); // result fetch response
  const [resultLoading, setResultLoading] = useState(false);
  const [capExceeded, setCapExceeded] = useState(null); // { spentCents, capCents } when 402

  // Load feature-flag + cap-status on mount.
  useEffect(() => {
    let cancelled = false;
    setEnabledLoading(true);
    setCapStatusLoading(true);

    fetchApi("/api/callified/enabled")
      .then((res) => {
        if (cancelled) return;
        setEnabled(Boolean(res?.enabled));
      })
      .catch((err) => {
        if (cancelled) return;
        // Network / other error — assume enabled and let the initiate-time
        // 403 handler catch the real state if it differs.
        console.warn("[CallifiedCalls] enabled load failed:", err?.message);
        setEnabled(true);
      })
      .finally(() => {
        if (!cancelled) setEnabledLoading(false);
      });

    fetchApi("/api/callified/cap-status")
      .then((res) => {
        if (cancelled) return;
        setCapStatus(res);
      })
      .catch((err) => {
        if (cancelled) return;
        // 402 → cap already exceeded; surface in the pill as 100%.
        if (err?.status === 402 && err?.body) {
          setCapStatus({
            spentCents: err.body.spentCents,
            capCents: err.body.capCents,
            percent: 1,
            withinCap: false,
            alertThreshold: true,
          });
          return;
        }
        // 403 → MANAGER role; render no pill (silent).
        if (err?.status !== 403) {
          console.warn(
            "[CallifiedCalls] cap-status load failed:",
            err?.message,
          );
        }
      })
      .finally(() => {
        if (!cancelled) setCapStatusLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, []);

  const refetchEnabled = () => {
    fetchApi("/api/callified/enabled")
      .then((res) => setEnabled(Boolean(res?.enabled)))
      .catch(() => setEnabled(false));
  };

  const initiateCall = async () => {
    const trimmedPhone = toPhone.trim();
    if (!trimmedPhone) {
      notify.error("Destination phone (E.164) is required");
      return;
    }
    // Light E.164 sanity check: leading + and 8-15 digits. Backend has the
    // canonical validation; this is just a UX nudge.
    if (!/^\+\d{8,15}$/.test(trimmedPhone)) {
      notify.error("Phone must be E.164 format, e.g. +919876543210");
      return;
    }

    setInitiateLoading(true);
    setCapExceeded(null);
    setLastResult(null);
    try {
      const body = { toPhone: trimmedPhone };
      if (subBrand) body.subBrand = subBrand;
      if (leadId.trim()) {
        const n = Number(leadId.trim());
        if (Number.isFinite(n)) body.leadId = n;
      }
      if (intent.trim()) body.intent = intent.trim();
      if (persona.trim()) body.persona = persona.trim();

      const res = await fetchApi("/api/callified/calls/initiate", {
        method: "POST",
        body: JSON.stringify(body),
      });
      setLastCall(res);
      notify.success(`Call initiated — id ${res.callId || "(pending)"}`);
    } catch (err) {
      if (
        err?.status === 402 &&
        err?.body?.code === "AI_CALLING_BUDGET_EXCEEDED"
      ) {
        setCapExceeded({
          spentCents: err.body.spentCents,
          capCents: err.body.capCents,
        });
        setLastCall(null);
        return;
      }
      if (
        err?.status === 403 &&
        err?.body?.code === "AI_CALLING_DISABLED"
      ) {
        // Flag flipped mid-session — re-fetch /enabled and let the disabled-
        // state surface re-render.
        refetchEnabled();
        setLastCall(null);
        return;
      }
      const msg =
        err?.body?.error || err?.message || "Failed to initiate AI call";
      notify.error(msg);
      setLastCall(null);
    } finally {
      setInitiateLoading(false);
    }
  };

  const fetchResult = async () => {
    if (!lastCall?.callId) {
      notify.error("No active call to fetch");
      return;
    }
    setResultLoading(true);
    try {
      const res = await fetchApi(
        `/api/callified/calls/${encodeURIComponent(lastCall.callId)}/result`,
      );
      setLastResult(res);
    } catch (err) {
      const msg =
        err?.body?.error || err?.message || "Failed to fetch call result";
      notify.error(msg);
    } finally {
      setResultLoading(false);
    }
  };

  // ── Feature-flag disabled state ────────────────────────────────────────
  // If GET /enabled returned { enabled: false }, render a full-page state
  // pointing at Tenant Settings rather than the action form.
  if (!enabledLoading && enabled === false) {
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
            <PhoneCall
              size={26}
              color="var(--primary-color, var(--accent-color))"
              aria-hidden
            />{" "}
            Callified AI Calls
          </h1>
          <p
            style={{
              color: "var(--text-secondary)",
              marginTop: 4,
              fontSize: "0.9rem",
              maxWidth: 720,
            }}
          >
            AI-driven outbound calls — multilingual, per-sub-brand personas,
            recording + transcript + summary.
          </p>
        </header>
        <div
          className="card"
          style={{
            padding: "2.5rem 2rem",
            textAlign: "center",
            color: "var(--text-secondary)",
            maxWidth: 640,
            margin: "2rem auto",
          }}
          data-testid="callified-disabled-state"
        >
          <PhoneOff
            size={32}
            style={{ opacity: 0.6, marginBottom: 12 }}
            aria-hidden
          />
          <div style={{ fontWeight: 600, fontSize: "1.05rem", marginBottom: 8 }}>
            AI calling is disabled for this tenant.
          </div>
          <div style={{ fontSize: "0.9rem", marginBottom: 18 }}>
            An ADMIN can enable it via{" "}
            <RouterLink
              to="/admin/tenant-settings"
              style={{
                color: "var(--primary-color, var(--accent-color))",
                fontWeight: 600,
              }}
            >
              Tenant Settings → AI Calling toggle
            </RouterLink>
            .
          </div>
        </div>
      </div>
    );
  }

  return (
    <div
      style={{
        padding: "2rem",
        height: "100%",
        overflowY: "auto",
        animation: "fadeIn 0.4s ease-out",
      }}
    >
      {/* Header row */}
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
            <PhoneCall
              size={26}
              color="var(--primary-color, var(--accent-color))"
              aria-hidden
            />{" "}
            Callified AI Calls
          </h1>
          <p
            style={{
              color: "var(--text-secondary)",
              marginTop: 4,
              fontSize: "0.9rem",
              maxWidth: 720,
            }}
          >
            AI-driven outbound calls — multilingual, per-sub-brand personas,
            recording + transcript + summary.
          </p>
        </div>
        {/* Cap-status pill (ADMIN-only; silent for MANAGER) */}
        {capStatusLoading ? null : (
          <CapStatusPill cap={capStatus} testid="callified-cap-pill" />
        )}
      </header>

      {/* Cap-exceeded banner — fires when initiate returns 402 */}
      <CapExceededBanner
        cap={capExceeded}
        providerLabel="AI calling"
        testid="callified-cap-exceeded-banner"
      />

      {/* Initiate form */}
      <div
        className="glass"
        style={{
          padding: 12,
          marginBottom: 16,
          display: "flex",
          alignItems: "flex-end",
          gap: 12,
          flexWrap: "wrap",
        }}
      >
        <div style={{ ...filterField, flex: "1 1 200px", minWidth: 180 }}>
          <label htmlFor="callified-to-phone" style={filterLabel}>
            Destination phone (E.164){" "}
            <span style={{ color: "#f43f5e" }}>*</span>
          </label>
          <input
            id="callified-to-phone"
            type="tel"
            value={toPhone}
            onChange={(e) => setToPhone(e.target.value)}
            placeholder="+919876543210"
            style={inputStyle}
            data-testid="callified-filter-tophone"
          />
        </div>
        <div style={filterField}>
          <label htmlFor="callified-subbrand" style={filterLabel}>
            Sub-brand
          </label>
          <select
            id="callified-subbrand"
            value={subBrand}
            onChange={(e) => setSubBrand(e.target.value)}
            style={selectStyle}
            data-testid="callified-filter-subbrand"
          >
            {SUB_BRAND_OPTIONS.map((o) => (
              <option key={o.value || "__none__"} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </div>
        <div style={filterField}>
          <label htmlFor="callified-lead-id" style={filterLabel}>
            Lead ID
          </label>
          <input
            id="callified-lead-id"
            type="number"
            min={1}
            value={leadId}
            onChange={(e) => setLeadId(e.target.value)}
            placeholder="(optional)"
            style={{ ...inputStyle, width: 120 }}
            data-testid="callified-filter-leadid"
          />
        </div>
        <div style={{ ...filterField, flex: "1 1 200px", minWidth: 160 }}>
          <label htmlFor="callified-intent" style={filterLabel}>
            Intent
          </label>
          <input
            id="callified-intent"
            type="text"
            value={intent}
            onChange={(e) => setIntent(e.target.value)}
            placeholder="e.g. follow-up, qualify-lead"
            style={inputStyle}
            data-testid="callified-filter-intent"
          />
        </div>
        <div style={{ ...filterField, flex: "1 1 200px", minWidth: 160 }}>
          <label htmlFor="callified-persona" style={filterLabel}>
            Persona override
          </label>
          <input
            id="callified-persona"
            type="text"
            value={persona}
            onChange={(e) => setPersona(e.target.value)}
            placeholder="(default: sub-brand persona)"
            style={inputStyle}
            data-testid="callified-filter-persona"
          />
        </div>
        <button
          type="button"
          onClick={initiateCall}
          disabled={initiateLoading}
          style={primaryBtn}
          data-testid="callified-initiate-btn"
        >
          <Phone size={14} aria-hidden />
          {initiateLoading ? "Initiating…" : "Initiate call"}
        </button>
      </div>

      {/* Stub-mode banner — surfaces when backend client is still pre-cred */}
      {(lastCall?.stub || lastResult?.stub) && (
        <StubModeBanner testid="callified-stub-banner">
          <strong>Stub-mode response</strong> (Q1 cred pending) — Yasin&apos;s
          Callified.ai handover lands here. Real call initiation will populate
          the callId + recording URL + transcript once the swap is done. The
          dashboard layout and contract won&apos;t change.
        </StubModeBanner>
      )}

      {/* Result area */}
      {initiateLoading ? (
        <div
          className="card"
          style={{
            padding: "3rem",
            textAlign: "center",
            color: "var(--text-secondary)",
          }}
        >
          Initiating call&hellip;
        </div>
      ) : capExceeded ? null : !lastCall ? (
        <div
          className="card"
          style={{
            padding: "3rem 2rem",
            textAlign: "center",
            color: "var(--text-secondary)",
          }}
          data-testid="callified-empty-state"
        >
          <AlertCircle
            size={28}
            style={{ opacity: 0.5, marginBottom: 10 }}
            aria-hidden
          />
          <div style={{ fontWeight: 600 }}>No calls initiated yet.</div>
          <div style={{ fontSize: "0.9rem", marginTop: "0.5rem" }}>
            Use this page to initiate AI calls via Callified.ai. Calls are
            sub-brand-aware — the persona auto-adapts to TMC / RFU / Travel
            Stall / Visa Sure context.
          </div>
        </div>
      ) : (
        <div>
          {/* Call summary card */}
          <div
            className="card"
            style={{ padding: "1.25rem 1.5rem", marginBottom: 12 }}
            data-testid="callified-call-summary"
          >
            <div
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                flexWrap: "wrap",
                gap: 12,
                marginBottom: 12,
              }}
            >
              <h2 style={{ margin: 0, fontSize: "1.05rem", fontWeight: 600 }}>
                Call {lastCall.callId || "(pending)"}
              </h2>
              <div
                style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}
              >
                {lastCall.subBrand && (
                  <span style={subBrandBadge}>
                    {subBrandLabel(lastCall.subBrand)}
                  </span>
                )}
                <span style={statusBadge}>
                  {lastCall.status || "initiated"}
                </span>
                <button
                  type="button"
                  onClick={fetchResult}
                  disabled={resultLoading || !lastCall.callId}
                  style={secondaryBtn}
                  data-testid="callified-fetch-result-btn"
                >
                  {resultLoading ? "Fetching…" : "Fetch result"}
                </button>
              </div>
            </div>

            <div
              style={{
                display: "grid",
                gridTemplateColumns:
                  "repeat(auto-fit, minmax(min(100%, 180px), 1fr))",
                gap: 12,
              }}
            >
              <KpiTile
                label="To"
                value={lastCall.toPhone || toPhone || "—"}
                testid="callified-kpi-tophone"
              />
              {lastCall.intent && (
                <KpiTile
                  label="Intent"
                  value={lastCall.intent}
                  testid="callified-kpi-intent"
                />
              )}
              {lastCall.persona && (
                <KpiTile
                  label="Persona"
                  value={lastCall.persona}
                  testid="callified-kpi-persona"
                />
              )}
              {lastCall.leadId != null && (
                <KpiTile
                  label="Lead"
                  value={`#${lastCall.leadId}`}
                  testid="callified-kpi-leadid"
                />
              )}
            </div>

            {lastCall.note && (
              <p
                style={{
                  marginTop: 12,
                  marginBottom: 0,
                  fontSize: "0.82rem",
                  color: "var(--text-secondary)",
                  fontStyle: "italic",
                }}
              >
                {lastCall.note}
              </p>
            )}
          </div>

          {/* Fetched result */}
          {lastResult && (
            <div
              className="card"
              style={{ padding: "1.25rem 1.5rem" }}
              data-testid="callified-result-card"
            >
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  flexWrap: "wrap",
                  gap: 8,
                  marginBottom: 12,
                }}
              >
                <h3
                  style={{
                    margin: 0,
                    fontSize: "0.95rem",
                    fontWeight: 600,
                    display: "flex",
                    alignItems: "center",
                    gap: 6,
                  }}
                >
                  <Sparkles size={14} aria-hidden /> Call result
                </h3>
                <span style={statusBadge}>{lastResult.status || "—"}</span>
              </div>

              {lastResult.outcome && (
                <div style={{ marginBottom: 10, fontSize: 13 }}>
                  <strong>Outcome:</strong> {lastResult.outcome}
                </div>
              )}

              {lastResult.recordingUrl ? (
                <div style={{ marginBottom: 10 }}>
                  <a
                    href={lastResult.recordingUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    style={{
                      display: "inline-flex",
                      alignItems: "center",
                      gap: 6,
                      fontSize: 13,
                      color: "var(--primary-color, var(--accent-color))",
                      fontWeight: 600,
                    }}
                    data-testid="callified-result-recording-link"
                  >
                    <Download size={13} aria-hidden /> Recording
                  </a>
                </div>
              ) : null}

              {lastResult.summary && (
                <div style={{ marginBottom: 10 }}>
                  <div
                    style={{
                      fontSize: 11,
                      color: "var(--text-secondary)",
                      fontWeight: 600,
                      textTransform: "uppercase",
                      letterSpacing: "0.05em",
                      marginBottom: 4,
                    }}
                  >
                    Summary
                  </div>
                  <div style={{ fontSize: 13, lineHeight: 1.5 }}>
                    {lastResult.summary}
                  </div>
                </div>
              )}

              {lastResult.transcript && (
                <details style={{ marginTop: 8 }}>
                  <summary
                    style={{
                      cursor: "pointer",
                      fontSize: 12,
                      color: "var(--text-secondary)",
                      fontWeight: 600,
                      display: "inline-flex",
                      alignItems: "center",
                      gap: 6,
                    }}
                  >
                    <FileText size={13} aria-hidden /> Transcript
                  </summary>
                  <pre
                    style={{
                      marginTop: 8,
                      padding: "10px 12px",
                      borderRadius: 6,
                      background: "rgba(255,255,255,0.04)",
                      border: "1px solid var(--border-color)",
                      fontSize: 12,
                      lineHeight: 1.5,
                      whiteSpace: "pre-wrap",
                      wordBreak: "break-word",
                      maxHeight: 320,
                      overflowY: "auto",
                    }}
                    data-testid="callified-result-transcript"
                  >
                    {typeof lastResult.transcript === "string"
                      ? lastResult.transcript
                      : JSON.stringify(lastResult.transcript, null, 2)}
                  </pre>
                </details>
              )}

              {lastResult.note && (
                <p
                  style={{
                    marginTop: 12,
                    marginBottom: 0,
                    fontSize: "0.82rem",
                    color: "var(--text-secondary)",
                    fontStyle: "italic",
                  }}
                >
                  {lastResult.note}
                </p>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/* ────────────────────────────────────────────────────────────────────────
 * KPI tile subcomponent — mirrors LlmSpend.jsx / AdsGPTReports KpiTile shape
 * for visual consistency across cap-consumer admin pages.
 * ──────────────────────────────────────────────────────────────────────── */
function KpiTile({ label, value, sub, testid }) {
  return (
    <div
      style={{
        background: "var(--surface-color, rgba(255,255,255,0.04))",
        border: "1px solid var(--border-color, rgba(255,255,255,0.08))",
        borderRadius: 10,
        padding: "0.85rem 1rem",
        display: "flex",
        flexDirection: "column",
        gap: "0.3rem",
        minWidth: 0,
      }}
      data-testid={testid}
    >
      <div
        style={{
          fontSize: "0.7rem",
          color: "var(--text-secondary)",
          textTransform: "uppercase",
          letterSpacing: "0.05em",
        }}
      >
        {label}
      </div>
      <div
        style={{
          fontSize: "1rem",
          fontWeight: 600,
          lineHeight: 1.2,
          wordBreak: "break-word",
        }}
      >
        {value}
      </div>
      {sub && (
        <div style={{ fontSize: "0.7rem", color: "var(--text-secondary)" }}>
          {sub}
        </div>
      )}
    </div>
  );
}

/* ────────────────────────────────────────────────────────────────────────
 * Styles — match RateHawkSearch / AdsGPTReports verbatim for visual
 * consistency across cap-consumer admin pages. The cap-pill / stub-banner /
 * cap-exceeded-banner shapes are inlined byte-identical here so a future
 * rule-of-3 extraction tick can retrofit all 3 callers in one shot.
 * ──────────────────────────────────────────────────────────────────────── */
const inputStyle = {
  padding: "6px 10px",
  borderRadius: 6,
  border: "1px solid var(--border-color)",
  background: "var(--bg-color, rgba(255,255,255,0.05))",
  color: "var(--text-primary)",
  fontSize: 13,
  outline: "none",
};
const selectStyle = {
  ...inputStyle,
  background: "var(--surface-color)",
  minWidth: 160,
};
const primaryBtn = {
  display: "inline-flex",
  alignItems: "center",
  gap: 6,
  padding: "8px 14px",
  borderRadius: 6,
  fontWeight: 600,
  fontSize: 13,
  background: "var(--primary-color, var(--accent-color))",
  color: "#fff",
  border: "none",
  cursor: "pointer",
};
const secondaryBtn = {
  display: "inline-flex",
  alignItems: "center",
  gap: 6,
  padding: "6px 12px",
  borderRadius: 6,
  fontWeight: 600,
  fontSize: 12,
  background: "rgba(255,255,255,0.06)",
  color: "var(--text-primary)",
  border: "1px solid var(--border-color)",
  cursor: "pointer",
};
const filterField = { display: "flex", flexDirection: "column", gap: 4 };
const filterLabel = {
  fontSize: 11,
  color: "var(--text-secondary)",
  fontWeight: 600,
  textTransform: "uppercase",
  letterSpacing: "0.05em",
};
const subBrandBadge = {
  display: "inline-block",
  padding: "3px 10px",
  borderRadius: 999,
  fontSize: 11,
  fontWeight: 600,
  background: "rgba(255,255,255,0.08)",
  color: "var(--text-primary)",
  textTransform: "uppercase",
  letterSpacing: 0.4,
};
const statusBadge = {
  display: "inline-block",
  padding: "3px 10px",
  borderRadius: 999,
  fontSize: 11,
  fontWeight: 600,
  background: "rgba(99, 102, 241, 0.18)",
  color: "var(--text-primary)",
  border: "1px solid rgba(99, 102, 241, 0.45)",
  textTransform: "uppercase",
  letterSpacing: 0.4,
};
