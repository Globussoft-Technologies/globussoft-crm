// Shared cap-status UI for cap-consumer admin pages (AdsGPT / RateHawk / Callified / BookingExpedia). Extracted from 4 byte-identical inline copies (rule-of-3 trigger fired tick #106).

import { Link as RouterLink } from "react-router-dom";
import { CheckCircle2, AlertTriangle, Info } from "lucide-react";
import { formatMoney } from "../utils/money";

function centsToUsd(cents) {
  return formatMoney((Number(cents) || 0) / 100, { currency: "USD" });
}

function formatPercent(p) {
  if (!Number.isFinite(p)) return "0%";
  return `${Math.round(p * 100)}%`;
}

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
const stubBannerStyle = {
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
const capExceededBannerStyle = {
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

export const capPillStyles = {
  base: capPillBase,
  green: capPillGreen,
  amber: capPillAmber,
  red: capPillRed,
};

export function CapStatusPill({ cap, testid, label }) {
  if (!cap) return null;
  let style = capPillGreen;
  if (!cap.withinCap) style = capPillRed;
  else if (cap.alertThreshold) style = capPillAmber;
  return (
    <div
      style={style}
      data-testid={testid}
      title={`${centsToUsd(cap.spentCents)} spent of ${centsToUsd(cap.capCents)} monthly cap`}
    >
      {cap.withinCap ? (
        <CheckCircle2 size={13} aria-hidden />
      ) : (
        <AlertTriangle size={13} aria-hidden />
      )}
      <span>
        {formatPercent(cap.percent)} of {centsToUsd(cap.capCents)}/mo {label || "cap"}
      </span>
    </div>
  );
}

export function StubModeBanner({ testid, children }) {
  return (
    <div style={stubBannerStyle} role="status" data-testid={testid}>
      <Info size={18} aria-hidden />
      <div>{children}</div>
    </div>
  );
}

export function CapExceededBanner({ cap, providerLabel, testid, settingsHref }) {
  if (!cap) return null;
  return (
    <div style={capExceededBannerStyle} role="alert" data-testid={testid}>
      <AlertTriangle size={18} aria-hidden />
      <div>
        <strong>Monthly {providerLabel} cap reached</strong> (
        {centsToUsd(cap.spentCents)} / {centsToUsd(cap.capCents)}).{" "}
        {settingsHref ? (
          <>
            Increase the cap via{" "}
            <RouterLink to={settingsHref} style={{ color: "inherit", fontWeight: 600 }}>
              Tenant Settings
            </RouterLink>
            , or wait for the monthly reset.
          </>
        ) : (
          <>Increase the cap via Tenant Settings, or wait for the monthly reset.</>
        )}
      </div>
    </div>
  );
}
