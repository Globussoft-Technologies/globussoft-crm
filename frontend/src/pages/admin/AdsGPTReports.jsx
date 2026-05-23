/**
 * AdsGPTReports.jsx — operator-facing ad-platform performance dashboard.
 *
 * Consumes /api/adsgpt (backend route commit 0d66a74, tick #102 — thin
 * wrapper over backend/services/adsGptClient.js). Endpoints:
 *   GET /api/adsgpt/reports/ads?subBrand=&fromDate=&toDate=&platform=
 *     → 200 { stub, tenantId, subBrand, platform, window:{fromDate,toDate},
 *             metrics:{spendUsdCents, impressions, clicks, conversions,
 *                      cpaCents, roas}, rows:[], note }
 *     → 402 { error, code: "ADSGPT_BUDGET_EXCEEDED", spentCents, capCents }
 *     → 400 { error, code: "INVALID_PLATFORM" }
 *   GET /api/adsgpt/cap-status   (ADMIN-only)
 *     → 200 { spentCents, capCents, percent, withinCap, alertThreshold }
 *     → 402 { error, code: "ADSGPT_BUDGET_EXCEEDED", spentCents, capCents }
 *
 * STUB-mode caveat: the backend client is in stub mode (Q1 cred-blocked per
 * docs/CREDS_TRACKER.md Cat 1 — Yasin's AdsGPT handover). Today every report
 * response carries `stub: true` + a `note` explaining the placeholder. When
 * the cred swap lands (single-point in backend/services/adsGptClient.js
 * `fetchAdReport` body), this UI continues to work unchanged — the stub
 * banner just stops rendering.
 *
 * Pattern mirror: header + cap-status pill follows TenantSettings.jsx
 * (commit 0054a03, tick #100); KPI tile rendering follows LlmSpend.jsx
 * (the closest cost-dashboard pattern); filter row + report-fetch button
 * follows the QuotesAdmin date-window pattern.
 *
 * Access: ADMIN + MANAGER (analytics, not tenant-config). The /cap-status
 * call is ADMIN-only on the backend; MANAGER users get a 403 there which
 * is swallowed silently (the cap-status pill simply does not render).
 */

import { useEffect, useState } from "react";
import {
  TrendingUp,
  AlertCircle,
  CheckCircle2,
  AlertTriangle,
  Info,
} from "lucide-react";
import { fetchApi } from "../../utils/api";
import { useNotify } from "../../utils/notify";
import { formatMoney } from "../../utils/money";
import { SUB_BRAND_IDS, subBrandLabel } from "../../utils/travelSubBrand";

// Valid platforms — must match backend VALID_PLATFORMS in routes/adsgpt.js.
const PLATFORMS = [
  { value: "all", label: "All platforms" },
  { value: "meta", label: "Meta (Facebook + Instagram)" },
  { value: "google", label: "Google Ads" },
  { value: "linkedin", label: "LinkedIn" },
  { value: "youtube", label: "YouTube" },
];

// Sub-brand options — "(no sub-brand)" maps to the tenant-wide bucket.
// Backend interprets empty string as null and applies cross-sub-brand.
const SUB_BRAND_OPTIONS = [
  { value: "", label: "All sub-brands" },
  ...SUB_BRAND_IDS.map((id) => ({ value: id, label: subBrandLabel(id) })),
];

// Default window: last 30 days. ISO yyyy-mm-dd for native <input type="date">.
function defaultFromDate() {
  const d = new Date();
  d.setDate(d.getDate() - 30);
  return d.toISOString().slice(0, 10);
}

function defaultToDate() {
  return new Date().toISOString().slice(0, 10);
}

// Cents → dollars helper (backend ships USD cents; PRD §3.4 spec).
function centsToUsd(cents) {
  return formatMoney((Number(cents) || 0) / 100, { currency: "USD" });
}

function formatPercent(p) {
  // p is a fraction (0..1) from evaluateCap.
  if (!Number.isFinite(p)) return "0%";
  return `${Math.round(p * 100)}%`;
}

export default function AdsGPTReports() {
  const notify = useNotify();

  // Cap-status (loaded on mount; ADMIN-only on backend so MANAGER gets 403
  // and we render no pill at all rather than an error toast).
  const [capStatus, setCapStatus] = useState(null);
  const [capStatusLoading, setCapStatusLoading] = useState(true);

  // Filter state.
  const [subBrand, setSubBrand] = useState("");
  const [fromDate, setFromDate] = useState(defaultFromDate());
  const [toDate, setToDate] = useState(defaultToDate());
  const [platform, setPlatform] = useState("all");

  // Report state.
  const [report, setReport] = useState(null);
  const [reportLoading, setReportLoading] = useState(false);
  const [capExceeded, setCapExceeded] = useState(null); // { spentCents, capCents } when 402

  // Load cap-status on mount. Swallow 403 silently (MANAGER role).
  useEffect(() => {
    let cancelled = false;
    setCapStatusLoading(true);
    fetchApi("/api/adsgpt/cap-status")
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
          // Other errors are logged but don't block the dashboard.
          // console.warn is allowed by the frontend ESLint config (warn/error only).
          console.warn("[AdsGPTReports] cap-status load failed:", err?.message);
        }
      })
      .finally(() => {
        if (!cancelled) setCapStatusLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const fetchReport = async () => {
    setReportLoading(true);
    setCapExceeded(null);
    try {
      const qs = new URLSearchParams();
      if (subBrand) qs.set("subBrand", subBrand);
      if (fromDate) qs.set("fromDate", fromDate);
      if (toDate) qs.set("toDate", toDate);
      if (platform) qs.set("platform", platform);
      const res = await fetchApi(`/api/adsgpt/reports/ads?${qs.toString()}`);
      setReport(res);
    } catch (err) {
      if (err?.status === 402 && err?.body?.code === "ADSGPT_BUDGET_EXCEEDED") {
        setCapExceeded({
          spentCents: err.body.spentCents,
          capCents: err.body.capCents,
        });
        setReport(null);
        return;
      }
      const msg = err?.body?.error || err?.message || "Failed to fetch report";
      notify.error(msg);
      setReport(null);
    } finally {
      setReportLoading(false);
    }
  };

  const metrics = report?.metrics || {};

  // Cap pill color: green if <50%, amber if alertThreshold (80%+), red if !withinCap.
  let capPillStyle = capPillGreen;
  if (capStatus) {
    if (!capStatus.withinCap) capPillStyle = capPillRed;
    else if (capStatus.alertThreshold) capPillStyle = capPillAmber;
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
            <TrendingUp
              size={26}
              color="var(--primary-color, var(--accent-color))"
              aria-hidden
            />{" "}
            AdsGPT Reports
          </h1>
          <p
            style={{
              color: "var(--text-secondary)",
              marginTop: 4,
              fontSize: "0.9rem",
              maxWidth: 720,
            }}
          >
            Per-platform ad performance — spend / impressions / clicks /
            conversions / CPA / ROAS.
          </p>
        </div>
        {/* Cap-status pill (ADMIN-only; silent for MANAGER) */}
        {capStatusLoading ? null : capStatus ? (
          <div
            style={capPillStyle}
            data-testid="adsgpt-cap-pill"
            title={`${centsToUsd(capStatus.spentCents)} spent of ${centsToUsd(capStatus.capCents)} monthly cap`}
          >
            {capStatus.withinCap ? (
              <CheckCircle2 size={13} aria-hidden />
            ) : (
              <AlertTriangle size={13} aria-hidden />
            )}
            <span>
              {formatPercent(capStatus.percent)} of{" "}
              {centsToUsd(capStatus.capCents)}/mo cap
            </span>
          </div>
        ) : null}
      </header>

      {/* Cap-exceeded banner — fires when fetch returns 402 */}
      {capExceeded && (
        <div
          style={capExceededBanner}
          role="alert"
          data-testid="adsgpt-cap-exceeded-banner"
        >
          <AlertTriangle size={18} aria-hidden />
          <div>
            <strong>Monthly AdsGPT cap reached</strong> (
            {centsToUsd(capExceeded.spentCents)} /{" "}
            {centsToUsd(capExceeded.capCents)}). Increase the cap via Tenant
            Settings, or wait for the monthly reset.
          </div>
        </div>
      )}

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
        <div style={filterField}>
          <label htmlFor="adsgpt-subbrand" style={filterLabel}>
            Sub-brand
          </label>
          <select
            id="adsgpt-subbrand"
            value={subBrand}
            onChange={(e) => setSubBrand(e.target.value)}
            style={selectStyle}
            data-testid="adsgpt-filter-subbrand"
          >
            {SUB_BRAND_OPTIONS.map((o) => (
              <option key={o.value || "__all__"} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </div>
        <div style={filterField}>
          <label htmlFor="adsgpt-platform" style={filterLabel}>
            Platform
          </label>
          <select
            id="adsgpt-platform"
            value={platform}
            onChange={(e) => setPlatform(e.target.value)}
            style={selectStyle}
            data-testid="adsgpt-filter-platform"
          >
            {PLATFORMS.map((p) => (
              <option key={p.value} value={p.value}>
                {p.label}
              </option>
            ))}
          </select>
        </div>
        <div style={filterField}>
          <label htmlFor="adsgpt-from" style={filterLabel}>
            From
          </label>
          <input
            id="adsgpt-from"
            type="date"
            value={fromDate}
            onChange={(e) => setFromDate(e.target.value)}
            style={inputStyle}
            data-testid="adsgpt-filter-from"
          />
        </div>
        <div style={filterField}>
          <label htmlFor="adsgpt-to" style={filterLabel}>
            To
          </label>
          <input
            id="adsgpt-to"
            type="date"
            value={toDate}
            onChange={(e) => setToDate(e.target.value)}
            style={inputStyle}
            data-testid="adsgpt-filter-to"
          />
        </div>
        <button
          type="button"
          onClick={fetchReport}
          disabled={reportLoading}
          style={primaryBtn}
          data-testid="adsgpt-fetch-btn"
        >
          {reportLoading ? "Fetching…" : "Fetch report"}
        </button>
      </div>

      {/* Stub-mode banner — surfaces when backend client is still pre-cred */}
      {report?.stub && (
        <div
          style={stubBanner}
          role="status"
          data-testid="adsgpt-stub-banner"
        >
          <Info size={18} aria-hidden />
          <div>
            <strong>Stub-mode response</strong> — AdsGPT integration pending
            Q1 cred (Yasin&apos;s AdsGPT handover). Real metrics will populate
            here once the swap is done; the dashboard layout and contract
            won&apos;t change.
          </div>
        </div>
      )}

      {/* Report card */}
      {reportLoading ? (
        <div
          className="card"
          style={{
            padding: "3rem",
            textAlign: "center",
            color: "var(--text-secondary)",
          }}
        >
          Loading report&hellip;
        </div>
      ) : capExceeded ? null : !report ? (
        <div
          className="card"
          style={{
            padding: "3rem 2rem",
            textAlign: "center",
            color: "var(--text-secondary)",
          }}
        >
          <AlertCircle
            size={28}
            style={{ opacity: 0.5, marginBottom: 10 }}
            aria-hidden
          />
          <div style={{ fontWeight: 600 }}>No report loaded.</div>
          <div style={{ fontSize: "0.9rem", marginTop: "0.5rem" }}>
            Pick a date range + platform + sub-brand and click &quot;Fetch
            report&quot; to load metrics.
          </div>
        </div>
      ) : (
        <div className="card" style={{ padding: "1.5rem" }}>
          {/* Window summary */}
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              flexWrap: "wrap",
              gap: 8,
              marginBottom: 16,
            }}
          >
            <h2 style={{ margin: 0, fontSize: "1.1rem", fontWeight: 600 }}>
              {platform === "all"
                ? "All platforms"
                : PLATFORMS.find((p) => p.value === platform)?.label ||
                  platform}{" "}
              · {report.window?.fromDate || fromDate} →{" "}
              {report.window?.toDate || toDate}
            </h2>
            {report.subBrand && (
              <span style={subBrandBadge}>{subBrandLabel(report.subBrand)}</span>
            )}
          </div>

          {/* KPI grid */}
          <div
            style={{
              display: "grid",
              gridTemplateColumns:
                "repeat(auto-fit, minmax(min(100%, 180px), 1fr))",
              gap: 12,
            }}
          >
            <KpiTile
              label="Spend"
              value={centsToUsd(metrics.spendUsdCents)}
              testid="adsgpt-kpi-spend"
            />
            <KpiTile
              label="Impressions"
              value={Number(metrics.impressions || 0).toLocaleString()}
              testid="adsgpt-kpi-impressions"
            />
            <KpiTile
              label="Clicks"
              value={Number(metrics.clicks || 0).toLocaleString()}
              testid="adsgpt-kpi-clicks"
            />
            <KpiTile
              label="Conversions"
              value={Number(metrics.conversions || 0).toLocaleString()}
              testid="adsgpt-kpi-conversions"
            />
            <KpiTile
              label="CPA"
              value={centsToUsd(metrics.cpaCents)}
              sub="per acquisition"
              testid="adsgpt-kpi-cpa"
            />
            <KpiTile
              label="ROAS"
              value={Number(metrics.roas || 0).toFixed(2)}
              sub="return on ad spend"
              testid="adsgpt-kpi-roas"
            />
          </div>

          {/* Optional note from backend */}
          {report.note && (
            <p
              style={{
                marginTop: 16,
                marginBottom: 0,
                fontSize: "0.82rem",
                color: "var(--text-secondary)",
                fontStyle: "italic",
              }}
            >
              {report.note}
            </p>
          )}
        </div>
      )}
    </div>
  );
}

/* ────────────────────────────────────────────────────────────────────────
 * KPI tile subcomponent — mirrors LlmSpend.jsx Tile shape for visual
 * consistency across cost dashboards.
 * ──────────────────────────────────────────────────────────────────────── */
function KpiTile({ label, value, sub, testid }) {
  return (
    <div
      style={{
        background: "var(--surface-color, rgba(255,255,255,0.04))",
        border: "1px solid var(--border-color, rgba(255,255,255,0.08))",
        borderRadius: 10,
        padding: "1rem 1.25rem",
        display: "flex",
        flexDirection: "column",
        gap: "0.35rem",
        minWidth: 0,
      }}
      data-testid={testid}
    >
      <div
        style={{
          fontSize: "0.75rem",
          color: "var(--text-secondary)",
          textTransform: "uppercase",
          letterSpacing: "0.05em",
        }}
      >
        {label}
      </div>
      <div
        style={{
          fontSize: "1.4rem",
          fontWeight: 600,
          lineHeight: 1.2,
        }}
      >
        {value}
      </div>
      {sub && (
        <div style={{ fontSize: "0.75rem", color: "var(--text-secondary)" }}>
          {sub}
        </div>
      )}
    </div>
  );
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
  alignSelf: "flex-end",
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
const capPillBase = {
  display: "inline-flex",
  alignItems: "center",
  gap: 6,
  padding: "6px 12px",
  borderRadius: 999,
  fontSize: 12,
  fontWeight: 600,
};
const capPillGreen = {
  ...capPillBase,
  background: "rgba(34, 197, 94, 0.18)",
  color: "#22c55e",
  border: "1px solid #22c55e",
};
const capPillAmber = {
  ...capPillBase,
  background: "rgba(245, 158, 11, 0.18)",
  color: "#f59e0b",
  border: "1px solid #f59e0b",
};
const capPillRed = {
  ...capPillBase,
  background: "rgba(244, 63, 94, 0.18)",
  color: "#f43f5e",
  border: "1px solid #f43f5e",
};
const stubBanner = {
  display: "flex",
  alignItems: "flex-start",
  gap: 10,
  padding: "12px 14px",
  marginBottom: 16,
  borderRadius: 8,
  background: "rgba(99, 102, 241, 0.12)",
  border: "1px solid rgba(99, 102, 241, 0.45)",
  color: "var(--text-primary)",
  fontSize: 13,
};
const capExceededBanner = {
  display: "flex",
  alignItems: "flex-start",
  gap: 10,
  padding: "12px 14px",
  marginBottom: 16,
  borderRadius: 8,
  background: "rgba(244, 63, 94, 0.12)",
  border: "1px solid rgba(244, 63, 94, 0.45)",
  color: "var(--text-primary)",
  fontSize: 13,
};
