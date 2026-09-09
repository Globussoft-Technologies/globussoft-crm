// Multi-stage "processing your diagnostic" overlay (2026-08-28).
//
// Every diagnostic-taking surface used to show a small spinner glued to the
// submit button for the ~20s a real submission takes (score → curriculum
// fit → RAG → PDF, all synchronous). That read as "is this stuck?" — this
// swaps it for a loading screen that narrates what's actually happening as
// a growing stack of step cards over the dimmed, still-faintly-visible
// form: card 1 appears spinning, flips to a checkmark when its stage
// elapses, card 2 appears below it, and so on through all 4 — then the
// overlay unmounts the instant the real request resolves and the result
// takes over.
//
// Shared across every diagnostic entry point: the public form
// (TravelDiagnosticPublicForm.jsx renders through the SAME
// DiagnosticFormRenderer this overlay lives in), the TMC readiness/market
// page (TmcReadiness.jsx), the customer portal (TravelCustomerPortal.jsx),
// and the internal staff wizard (DiagnosticWizard.jsx). Two more surfaces
// get this for free without any separate wiring: Landing Sites only ever
// LINK OUT to the standalone public form (no inline diagnostic block type
// exists in the landing-page builder — verified 2026-08-28), and the
// external embed widget (frontend/public/embed/diagnostic-page.html)
// iframes that exact same public form page — both land on
// DiagnosticFormRenderer, so they already show this overlay.
//
// Usage: render unconditionally near the root of the submitting view —
// it's `null` while `active` is false, and remounts its internal stage
// timer fresh each time `active` flips true → the caller doesn't manage
// timing, just the boolean.

import { useEffect, useState } from "react";
import { CheckCircle2 } from "lucide-react";

export const DEFAULT_DIAGNOSTIC_STAGES = [
  "Submitting your response…",
  "Going through all available trips…",
  "Tailoring your recommendations…",
  "Putting together your results…",
];

export default function DiagnosticSubmitOverlay({
  active,
  stages = DEFAULT_DIAGNOSTIC_STAGES,
  // Every stage gets the SAME fixed duration (no caller overrides this
  // per-stage — one interval, applied uniformly) — 4.5s × 4 stages ≈ 18s,
  // close to how long a real submission actually takes end to end, so the
  // sequence rarely stalls waiting on the last card.
  stageDurationMs = 4500,
  primaryColor = "#4f46e5",
  fullScreen = true,
  // Only meaningful when fullScreen=false — match the containing card's own
  // border-radius so the absolutely-positioned overlay's corners don't peek
  // out square against a more-rounded parent.
  borderRadius = 12,
}) {
  const [stageIndex, setStageIndex] = useState(0);

  useEffect(() => {
    if (!active) {
      setStageIndex(0);
      return undefined;
    }
    const timer = setInterval(() => {
      // Stalls on the final card rather than looping — a slow real request
      // just means the last card sits a little longer as "in progress,"
      // which reads as "almost there" instead of restarting the sequence.
      setStageIndex((i) => (i < stages.length - 1 ? i + 1 : i));
    }, stageDurationMs);
    return () => clearInterval(timer);
  }, [active, stageDurationMs, stages.length]);

  if (!active) return null;

  const visibleStages = stages.slice(0, stageIndex + 1);

  return (
    <div
      style={fullScreen ? overlayFullScreen : { ...overlayContained, borderRadius }}
      role="status"
      aria-live="polite"
    >
      <div style={stackWrap}>
        {visibleStages.map((label, i) => {
          const done = i < stageIndex;
          return (
            <div
              key={i}
              className="animate-fade-in"
              style={{
                ...stepCard,
                borderColor: done ? "rgba(34, 197, 94, 0.4)" : primaryColor,
                background: done
                  ? "#fff"
                  : `color-mix(in srgb, ${primaryColor} 7%, #fff)`,
                boxShadow: done
                  ? stepCard.boxShadow
                  : `0 12px 32px -6px color-mix(in srgb, ${primaryColor} 35%, transparent), 0 4px 14px rgba(15, 23, 42, 0.08)`,
                opacity: done ? 0.75 : 1,
                transform: done ? "scale(0.98)" : "scale(1)",
              }}
            >
              <span style={iconWrap}>
                {done ? (
                  <CheckCircle2 size={26} aria-hidden style={{ color: "#22c55e" }} />
                ) : (
                  <span style={{ ...spinnerRing, borderTopColor: primaryColor }} />
                )}
              </span>
              <span style={{ ...stepText, color: done ? "#4b5563" : primaryColor, fontWeight: done ? 600 : 700 }}>
                {label}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

const overlayFullScreen = {
  position: "fixed",
  inset: 0,
  zIndex: 9999,
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  background: "rgba(255, 255, 255, 0.62)",
  backdropFilter: "blur(1.5px)",
  WebkitBackdropFilter: "blur(1.5px)",
  padding: 20,
};
const overlayContained = {
  position: "absolute",
  inset: 0,
  zIndex: 50,
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  background: "rgba(255, 255, 255, 0.66)",
  backdropFilter: "blur(1.5px)",
  WebkitBackdropFilter: "blur(1.5px)",
  borderRadius: 12,
  padding: 20,
};
const stackWrap = {
  display: "flex",
  flexDirection: "column",
  gap: 16,
  width: "100%",
  maxWidth: 480,
};
const stepCard = {
  display: "flex",
  alignItems: "center",
  gap: 16,
  padding: "22px 28px",
  borderRadius: 18,
  background: "#fff",
  border: "2px solid",
  boxShadow: "0 10px 28px rgba(15, 23, 42, 0.10)",
  transition: "opacity 0.3s ease, border-color 0.3s ease, background 0.3s ease, box-shadow 0.3s ease, transform 0.3s ease",
};
const iconWrap = {
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  width: 28,
  height: 28,
  flexShrink: 0,
};
const spinnerRing = {
  display: "block",
  width: 24,
  height: 24,
  borderRadius: "50%",
  border: "3px solid rgba(15, 23, 42, 0.12)",
  animation: "spin 0.8s linear infinite",
};
const stepText = {
  fontSize: 18,
  lineHeight: 1.4,
  textAlign: "left",
};
