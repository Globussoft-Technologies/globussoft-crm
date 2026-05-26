// Travel CRM — Diagnostic Detail (advisor brief surface, PRD §4.1 + §4.2 + §7).
//
// Lands at /travel/diagnostics/:id. Closes the loop on two LLM-router
// consumer endpoints that have shipped backend-only:
//
//   • POST /api/travel/diagnostics/:id/talking-points/regen
//       commit cf876af — writes TravelDiagnostic.talkingPointsJson envelope
//       { text, model, generatedAt, stub }
//   • POST /api/travel/diagnostics/:id/form-vs-call/compare
//       commits 4a7c623 + 8b97fd5 — returns { classification, scorePercent,
//       summary, model, stub, perFieldDiff }
//
// Page layout (top → bottom):
//   1. Header: id, sub-brand badge, classification chip, back link
//   2. Answers + classification — question/answer joined from the bank
//      snapshot stored in TravelDiagnostic.questionsJson + answersJson;
//      score + recommendedTier line; optional report PDF download link
//   3. Talking-points brief — renders the persisted envelope or shows
//      an empty-state Generate button. Stub badge surfaces when the LLM
//      router returned a synthetic response (Q11 keys not yet wired).
//      Regenerate button is ADMIN/MANAGER only.
//   4. Form-vs-call comparison — textarea for the call transcript +
//      Compare button POSTs the comparison endpoint and renders the
//      classification badge (color-coded match/review/mismatch/unknown),
//      scorePercent, summary prose, and perFieldDiff table.
//
// Hard NOs encoded:
//   - Talking-points NEVER auto-fires on load (real Claude costs $; the
//     human chooses when to spend a token via the Regenerate button).
//   - Form-vs-call response is NOT cached/persisted in this commit; the
//     server endpoint itself is read/compute-only and persistence is a
//     P1.5 follow-up.
//   - We DO NOT mutate the diagnostic on this page; we only read +
//     forward to the two POST endpoints above.

import { useEffect, useState, useContext } from "react";
import { Link, useParams } from "react-router-dom";
import {
  ChevronLeft, ClipboardCheck, RefreshCw, FileText, Send,
  AlertTriangle, Sparkles, CheckCircle, XCircle,
} from "lucide-react";
import { fetchApi } from "../../utils/api";
import { useNotify } from "../../utils/notify";
import { AuthContext } from "../../App";

const SUB_BRAND_LABEL = {
  tmc: "TMC (schools)",
  rfu: "RFU (Umrah)",
  travelstall: "Travel Stall",
  visasure: "Visa Sure",
};

const CLASS_COLORS = {
  match: { bg: "rgba(47, 122, 77, 0.14)", color: "#2F7A4D", border: "#2F7A4D" },
  review: { bg: "rgba(200, 154, 78, 0.18)", color: "#9A6F2E", border: "#9A6F2E" },
  mismatch: { bg: "rgba(190, 50, 50, 0.14)", color: "#A33636", border: "#A33636" },
  unknown: { bg: "rgba(95, 110, 130, 0.12)", color: "#5C6E82", border: "#5C6E82" },
};

function fmtDate(d) {
  if (!d) return "—";
  try {
    return new Date(d).toLocaleString();
  } catch {
    return String(d);
  }
}

// The diagnostic's questionsJson is a snapshot envelope:
//   { bankId, bankVersion, questionsJson: <string>, scoringRulesJson, scoringWarnings }
// where the inner `questionsJson` is the bank's own stringified payload
// shaped like { questions: [{ id, text, ... }] }. We tolerate either
// shape (already-parsed object OR raw string) so this renders cleanly
// against fixtures and live data alike.
function parseQuestionList(rawSnapshot) {
  if (!rawSnapshot) return [];
  let snapshot = rawSnapshot;
  if (typeof snapshot === "string") {
    try { snapshot = JSON.parse(snapshot); } catch { return []; }
  }
  let inner = snapshot?.questionsJson;
  if (typeof inner === "string") {
    try { inner = JSON.parse(inner); } catch { return []; }
  }
  if (Array.isArray(inner?.questions)) return inner.questions;
  if (Array.isArray(snapshot?.questions)) return snapshot.questions;
  return [];
}

function parseAnswers(raw) {
  if (!raw) return {};
  if (typeof raw === "object") return raw;
  try { return JSON.parse(raw); } catch { return {}; }
}

function parseTalkingPointsEnvelope(raw) {
  if (!raw) return null;
  if (typeof raw === "object") return raw;
  try { return JSON.parse(raw); } catch { return null; }
}

function formatAnswer(value) {
  if (value === null || value === undefined || value === "") return "—";
  if (Array.isArray(value)) return value.join(", ");
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

export default function DiagnosticDetail() {
  const { id } = useParams();
  const notify = useNotify();
  const { user } = useContext(AuthContext) || {};
  const canRegen = user?.role === "ADMIN" || user?.role === "MANAGER";
  const diagId = parseInt(id, 10);

  const [diag, setDiag] = useState(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(null);

  const [regenInFlight, setRegenInFlight] = useState(false);

  const [callTranscript, setCallTranscript] = useState("");
  const [compareInFlight, setCompareInFlight] = useState(false);
  const [comparison, setComparison] = useState(null);

  const load = () => {
    if (!Number.isFinite(diagId)) {
      setLoadError({ status: 400, message: "Invalid diagnostic id" });
      setLoading(false);
      return;
    }
    setLoading(true);
    setLoadError(null);
    fetchApi(`/api/travel/diagnostics/${diagId}`, { silent: true })
      .then((res) => {
        setDiag(res);
      })
      .catch((e) => {
        setLoadError({
          status: e?.status || 500,
          code: e?.code || e?.data?.code || null,
          message: e?.message || "Failed to load diagnostic",
        });
        setDiag(null);
      })
      .finally(() => setLoading(false));
  };
  useEffect(load, [diagId]);

  const regenTalkingPoints = async () => {
    if (!canRegen) return;
    setRegenInFlight(true);
    try {
      const res = await fetchApi(
        `/api/travel/diagnostics/${diagId}/talking-points/regen`,
        { method: "POST", body: JSON.stringify({}) },
      );
      // Server returns { diagnostic, talkingPoints }; we just update the
      // local diag so the brief block re-renders from the canonical
      // persisted envelope.
      if (res?.diagnostic) {
        setDiag(res.diagnostic);
      } else {
        load();
      }
      notify.success("Talking-points brief regenerated");
    } catch (e) {
      notify.error(e?.message || "Failed to regenerate talking points");
    } finally {
      setRegenInFlight(false);
    }
  };

  const runCompare = async () => {
    const transcript = callTranscript.trim();
    if (!transcript) {
      notify.error("Paste the call transcript before comparing");
      return;
    }
    setCompareInFlight(true);
    try {
      const res = await fetchApi(
        `/api/travel/diagnostics/${diagId}/form-vs-call/compare`,
        {
          method: "POST",
          body: JSON.stringify({ callTranscript: transcript }),
        },
      );
      setComparison(res);
    } catch (e) {
      notify.error(e?.message || "Failed to compare form vs call");
      setComparison(null);
    } finally {
      setCompareInFlight(false);
    }
  };

  if (loading) {
    return (
      <div style={{ padding: 24, maxWidth: 1100, margin: "0 auto" }}>
        <Link to="/travel/diagnostics" style={backLink}>
          <ChevronLeft size={16} aria-hidden /> Back to diagnostics
        </Link>
        <p style={{ color: "var(--text-secondary)" }}>Loading&hellip;</p>
      </div>
    );
  }

  if (loadError) {
    const is404 = loadError.status === 404;
    const isForbidden = loadError.status === 403 || loadError.code === "SUB_BRAND_DENIED";
    return (
      <div style={{ padding: 24, maxWidth: 1100, margin: "0 auto" }}>
        <Link to="/travel/diagnostics" style={backLink}>
          <ChevronLeft size={16} aria-hidden /> Back to diagnostics
        </Link>
        <div style={errorBox} role="alert">
          <AlertTriangle size={18} aria-hidden style={{ color: "var(--warning-color)" }} />
          <div>
            {is404 ? (
              <>
                <strong>Diagnostic not found.</strong>{" "}
                It may have been deleted, or you don&rsquo;t have access to it.
              </>
            ) : isForbidden ? (
              <>
                <strong>You don&rsquo;t have access to this sub-brand.</strong>{" "}
                Ask an admin to extend your <code>subBrandAccess</code>.
              </>
            ) : (
              <>
                <strong>Failed to load diagnostic.</strong>{" "}
                {loadError.message}
              </>
            )}
            <div style={{ marginTop: 12 }}>
              <button type="button" onClick={load} style={secondaryBtn}>
                <RefreshCw size={14} aria-hidden /> Retry
              </button>
            </div>
          </div>
        </div>
      </div>
    );
  }

  const questions = parseQuestionList(diag?.questionsJson);
  const answers = parseAnswers(diag?.answersJson);
  const envelope = parseTalkingPointsEnvelope(diag?.talkingPointsJson);
  const subBrandLabel = SUB_BRAND_LABEL[diag?.subBrand] || diag?.subBrand || "—";
  const classKey = (comparison?.classification || "unknown").toLowerCase();
  const classColor = CLASS_COLORS[classKey] || CLASS_COLORS.unknown;

  return (
    <div style={{ padding: 24, maxWidth: 1100, margin: "0 auto" }}>
      <Link to="/travel/diagnostics" style={backLink}>
        <ChevronLeft size={16} aria-hidden /> Back to diagnostics
      </Link>

      {/* ── Header ─────────────────────────────────────────────────── */}
      <header style={{ display: "flex", flexWrap: "wrap", gap: 12, alignItems: "center", margin: "8px 0 16px" }}>
        <h1 style={{ display: "flex", alignItems: "center", gap: 10, margin: 0 }}>
          <ClipboardCheck size={28} aria-hidden /> Diagnostic #{diag.id}
        </h1>
        <span style={brandBadge} aria-label={`Sub-brand ${subBrandLabel}`}>
          {subBrandLabel}
        </span>
        {(diag.classificationLabel || diag.classification) && (
          <span style={classChip} aria-label="Classification">
            {diag.classificationLabel || diag.classification}
          </span>
        )}
        <span style={{ marginLeft: "auto", color: "var(--text-secondary)", fontSize: 13 }}>
          Created {fmtDate(diag.createdAt)}
        </span>
      </header>

      {/* ── Section 1: answers + classification ──────────────────── */}
      <section style={card}>
        <h2 style={cardTitle}>
          <ClipboardCheck size={18} aria-hidden /> Answers &amp; classification
        </h2>
        <div style={summaryRow}>
          <div>
            <span style={kvLabel}>Score</span>
            <span style={{ marginLeft: 8 }}>
              {diag.score != null ? Number(diag.score).toFixed(2) : "—"}
            </span>
          </div>
          <div>
            <span style={kvLabel}>Recommended tier</span>
            <span style={{ marginLeft: 8 }}>{diag.recommendedTier || "—"}</span>
          </div>
          {diag.reportPdfUrl && (
            <a
              href={diag.reportPdfUrl}
              target="_blank"
              rel="noopener noreferrer"
              style={pdfLink}
            >
              <FileText size={14} aria-hidden /> Download report PDF
            </a>
          )}
        </div>
        {questions.length === 0 ? (
          <div style={{ color: "var(--text-secondary)", fontSize: 13, padding: "12px 0" }}>
            No question snapshot found on this diagnostic. Answers map:{" "}
            {Object.keys(answers).length === 0 ? "(empty)" : Object.keys(answers).join(", ")}.
          </div>
        ) : (
          <table style={{ width: "100%", borderCollapse: "collapse", marginTop: 8 }}>
            <thead>
              <tr>
                <th style={th}>Question</th>
                <th style={th}>Answer</th>
              </tr>
            </thead>
            <tbody>
              {questions.map((q) => {
                const qid = q?.id || q?.qid;
                const text = q?.text || q?.label || qid || "(untitled question)";
                const ans = qid != null ? answers[qid] : undefined;
                return (
                  <tr key={String(qid)} style={{ borderTop: "1px solid var(--border-light)" }}>
                    <td style={{ ...td, fontWeight: 500 }}>{text}</td>
                    <td style={td}>{formatAnswer(ans)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </section>

      {/* ── Section 2: talking-points brief ──────────────────────── */}
      <section style={{ ...card, marginTop: 16 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
          <h2 style={{ ...cardTitle, margin: 0 }}>
            <Sparkles size={18} aria-hidden /> Advisor talking-points brief
          </h2>
          {envelope?.stub && (
            <span style={stubPill} aria-label="Synthetic stub output (Q11 keys not yet wired)">
              STUB
            </span>
          )}
          {canRegen && (
            <button
              type="button"
              onClick={regenTalkingPoints}
              disabled={regenInFlight}
              style={{ ...primaryBtn, marginLeft: "auto", opacity: regenInFlight ? 0.6 : 1 }}
              aria-label={envelope ? "Regenerate talking points" : "Generate talking points"}
            >
              <RefreshCw size={14} aria-hidden />
              {regenInFlight
                ? "Working…"
                : envelope
                ? "Regenerate"
                : "Generate brief"}
            </button>
          )}
        </div>
        {envelope ? (
          <>
            <div style={proseBox} data-testid="talking-points-text">
              {envelope.text || "(no text returned)"}
            </div>
            <div style={metaLine}>
              Generated by <strong>{envelope.model || "unknown model"}</strong>
              {" "}on {fmtDate(envelope.generatedAt)} &middot;{" "}
              stub: {envelope.stub ? "yes" : "no"}
            </div>
          </>
        ) : (
          <div style={emptyBox} role="status">
            <Sparkles size={18} aria-hidden style={{ color: "var(--text-secondary)" }} />
            <div>
              No brief generated yet.{" "}
              {canRegen
                ? "Click Generate brief to ask the LLM router for an advisor-ready summary."
                : "Ask an admin or manager to generate one."}
            </div>
          </div>
        )}
      </section>

      {/* ── Section 3: form-vs-call comparison ───────────────────── */}
      <section style={{ ...card, marginTop: 16 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
          <h2 style={{ ...cardTitle, margin: 0 }}>
            <Send size={18} aria-hidden /> Form-vs-call comparison
          </h2>
          <span
            style={{
              fontSize: 12, color: "var(--text-secondary)",
              cursor: "help",
            }}
            title="Paste the AI qualification call transcript and we'll reconcile it against the form answers above (PRD §4.1 80/60 threshold ladder)."
            aria-label="What is this?"
          >
            (what is this?)
          </span>
        </div>
        <p style={{ color: "var(--text-secondary)", fontSize: 13, margin: "0 0 8px" }}>
          Paste the call transcript and click Compare. The LLM router reconciles
          it against the form answers and surfaces a match / review / mismatch
          recommendation per the 80/60% ladder.
        </p>
        <textarea
          value={callTranscript}
          onChange={(e) => setCallTranscript(e.target.value)}
          rows={6}
          placeholder="Paste the call transcript here…"
          style={textarea}
          aria-label="Call transcript"
        />
        <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 8 }}>
          <button
            type="button"
            onClick={runCompare}
            disabled={compareInFlight || !callTranscript.trim()}
            style={{
              ...primaryBtn,
              opacity: (compareInFlight || !callTranscript.trim()) ? 0.6 : 1,
            }}
            aria-label="Compare form vs call"
          >
            <Send size={14} aria-hidden />
            {compareInFlight ? "Comparing…" : "Compare"}
          </button>
        </div>

        {comparison && (
          <div style={{ marginTop: 16 }} data-testid="comparison-result">
            <div style={{ display: "flex", flexWrap: "wrap", gap: 12, alignItems: "center" }}>
              <span
                data-testid="comparison-classification-badge"
                style={{
                  padding: "6px 14px", borderRadius: 999, fontWeight: 700,
                  fontSize: 13, letterSpacing: 0.5, textTransform: "uppercase",
                  background: classColor.bg, color: classColor.color,
                  border: `1px solid ${classColor.border}`,
                }}
              >
                {comparison.classification || "unknown"}
              </span>
              <span style={{ fontSize: 14 }}>
                <strong>{comparison.scorePercent != null ? `${comparison.scorePercent}%` : "—"}</strong>{" "}
                <span style={{ color: "var(--text-secondary)" }}>confidence</span>
              </span>
              {comparison.stub && (
                <span style={stubPill} aria-label="Synthetic stub output">STUB</span>
              )}
              <span style={{ marginLeft: "auto", color: "var(--text-secondary)", fontSize: 12 }}>
                {comparison.model || "unknown model"} &middot; {fmtDate(comparison.generatedAt)}
              </span>
            </div>
            {comparison.summary && (
              <div style={{ ...proseBox, marginTop: 12 }} data-testid="comparison-summary">
                {comparison.summary}
              </div>
            )}
            {Array.isArray(comparison.perFieldDiff) && comparison.perFieldDiff.length > 0 && (
              <table style={{ width: "100%", borderCollapse: "collapse", marginTop: 12 }} data-testid="comparison-table">
                <thead>
                  <tr>
                    <th style={th}>Question</th>
                    <th style={th}>Form answer</th>
                    <th style={th}>Call answer</th>
                    <th style={{ ...th, textAlign: "center" }}>Match</th>
                  </tr>
                </thead>
                <tbody>
                  {comparison.perFieldDiff.map((row, idx) => (
                    <tr key={`${row.question}-${idx}`} style={{ borderTop: "1px solid var(--border-light)" }}>
                      <td style={{ ...td, fontWeight: 500 }}>{row.question}</td>
                      <td style={td}>{formatAnswer(row.formValue)}</td>
                      <td style={td}>{formatAnswer(row.callValue)}</td>
                      <td style={{ ...td, textAlign: "center" }}>
                        {row.matched ? (
                          <CheckCircle
                            size={18}
                            aria-label="Matched"
                            data-testid={`match-${idx}`}
                            style={{ color: "#2F7A4D" }}
                          />
                        ) : (
                          <XCircle
                            size={18}
                            aria-label="Mismatched"
                            data-testid={`mismatch-${idx}`}
                            style={{ color: "#A33636" }}
                          />
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        )}
      </section>
    </div>
  );
}

// ─── Styles ──────────────────────────────────────────────────────────

const backLink = {
  display: "inline-flex", alignItems: "center", gap: 4,
  fontSize: 13, color: "var(--text-secondary)", textDecoration: "none",
  padding: "4px 8px", borderRadius: 4,
};

const card = {
  background: "var(--surface-color)",
  borderRadius: 12,
  padding: 16,
  border: "1px solid var(--border-color)",
};

const cardTitle = {
  display: "flex", alignItems: "center", gap: 8,
  margin: "0 0 12px", fontSize: 15,
};

const summaryRow = {
  display: "flex", flexWrap: "wrap", gap: 16, alignItems: "center",
  padding: "8px 0 12px", borderBottom: "1px solid var(--border-light)",
  fontSize: 14,
};

const kvLabel = {
  color: "var(--text-secondary)", fontWeight: 600, fontSize: 12,
  textTransform: "uppercase", letterSpacing: 0.5,
};

const brandBadge = {
  padding: "2px 8px", borderRadius: 4, fontSize: 11, fontWeight: 600,
  background: "var(--subtle-bg-3)", color: "var(--primary-color)",
  textTransform: "uppercase", letterSpacing: 0.5,
};

const classChip = {
  padding: "2px 10px", borderRadius: 999, fontSize: 12, fontWeight: 600,
  background: "var(--subtle-bg)", color: "var(--text-primary)",
  border: "1px solid var(--border-color)",
};

const stubPill = {
  padding: "2px 8px", borderRadius: 999, fontSize: 10, fontWeight: 700,
  letterSpacing: 0.8,
  background: "rgba(200, 154, 78, 0.18)", color: "#9A6F2E",
  border: "1px solid #9A6F2E",
};

const proseBox = {
  background: "var(--bg-color)",
  border: "1px solid var(--border-light)",
  borderRadius: 8,
  padding: 12,
  fontSize: 14,
  lineHeight: 1.55,
  whiteSpace: "pre-wrap",
  color: "var(--text-primary)",
};

const metaLine = {
  marginTop: 8,
  fontSize: 12,
  color: "var(--text-secondary)",
};

const emptyBox = {
  padding: 16, borderRadius: 8,
  background: "var(--subtle-bg)", border: "1px dashed var(--border-color)",
  display: "flex", alignItems: "center", gap: 10,
  color: "var(--text-secondary)", fontSize: 14,
};

const errorBox = {
  marginTop: 16, padding: 16, borderRadius: 12,
  background: "var(--subtle-bg)", border: "1px solid var(--border-color)",
  display: "flex", alignItems: "flex-start", gap: 12,
  color: "var(--text-primary)", fontSize: 14,
};

const pdfLink = {
  marginLeft: "auto",
  display: "inline-flex", alignItems: "center", gap: 6,
  padding: "6px 10px", borderRadius: 6,
  background: "var(--surface-color)", color: "var(--primary-color)",
  border: "1px solid var(--primary-color)",
  textDecoration: "none", fontSize: 13, fontWeight: 600,
};

const primaryBtn = {
  display: "inline-flex", alignItems: "center", gap: 6,
  padding: "8px 14px", borderRadius: 6, fontWeight: 600, fontSize: 13,
  background: "var(--primary-color, var(--accent-color))", color: "#fff",
  border: "none", cursor: "pointer",
};

const secondaryBtn = {
  display: "inline-flex", alignItems: "center", gap: 6,
  padding: "6px 12px", borderRadius: 6, fontWeight: 600, fontSize: 13,
  background: "var(--surface-color)", color: "var(--text-primary)",
  border: "1px solid var(--border-color)", cursor: "pointer",
};

const textarea = {
  width: "100%", boxSizing: "border-box",
  padding: 10, borderRadius: 6,
  border: "1px solid var(--border-color)",
  background: "var(--bg-color)", color: "var(--text-primary)",
  fontSize: 13, resize: "vertical",
  fontFamily: "inherit",
};

const th = {
  textAlign: "left", padding: "10px 12px", fontSize: 12,
  textTransform: "uppercase", letterSpacing: 0.5,
  color: "var(--text-secondary)", borderBottom: "1px solid var(--border-color)",
  background: "var(--subtle-bg)",
};

const td = {
  padding: "10px 12px", fontSize: 14,
  color: "var(--text-primary)", verticalAlign: "top",
};
