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
// ── TMC §3.3.7 human_pick recorder (PRD T11 / DD-5.7) ──
// For TMC diagnostics (subBrand === 'tmc'), the page surfaces a
// human-pick recorder section above the talking-points brief:
//
//   - Dropdown of the 5 starter trips (sourced from
//     GET /api/travel-tmc-catalogue?status=active) + "other" + "no_rec"
//   - ADMIN-only edit; MANAGER/USER see a read-only display of any
//     prior pick.
//   - Engine output (recommendedTripId / alternativeTripId / scores) is
//     COLLAPSED behind an expand button until the senior reviewer has
//     recorded their pick (DD-5.7). The collapsed state surfaces ONLY
//     the prompt + dropdown; the engine output reveals automatically
//     after the pick is saved.
//   - Saving PATCHes /api/travel/diagnostics/:id with { humanPick: ... }
//     where the value is the catalogue tripId slug, "other", or "no_rec".
//
// Hard NOs encoded:
//   - Talking-points NEVER auto-fires on load (real Claude costs $; the
//     human chooses when to spend a token via the Regenerate button).
//   - Form-vs-call response is NOT cached/persisted in this commit; the
//     server endpoint itself is read/compute-only and persistence is a
//     P1.5 follow-up.
//   - We DO NOT mutate the diagnostic on this page; we only read +
//     forward to the two POST endpoints above.

import { useCallback, useEffect, useState, useContext } from "react";
import { Link, useParams } from "react-router-dom";
import {
  ChevronLeft, ClipboardCheck, RefreshCw, FileText, Send,
  AlertTriangle, Sparkles, CheckCircle, XCircle, Eye, EyeOff, UserCheck,
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

// G104 — DD-5.7 blind-collapsed section parser. Splits the LLM-returned
// brief text into named sections so each can render in its own collapsed
// <details>. The brief may carry an explicit `sections` array (real LLM
// output) OR be flat prose with markdown-ish headings (`## Lead with`,
// `Lead with:`, etc.). Falls back to a single "Advisor brief" section
// when no structural cues are present.
function parseBriefSections(envelope) {
  if (!envelope) return [];
  // Explicit array — preferred shape when the LLM router returns structured JSON.
  if (Array.isArray(envelope.sections)) {
    return envelope.sections
      .filter((s) => s && (s.key || s.title) && (s.body || s.text))
      .map((s, i) => ({
        key: String(s.key || s.title || `section-${i}`).trim(),
        title: String(s.title || s.key || `Section ${i + 1}`).trim(),
        body: String(s.body || s.text || "").trim(),
      }));
  }
  const text = String(envelope.text || "").trim();
  if (!text) return [];
  // Try to split on bold/markdown-style headings.
  // Patterns:
  //   ## Section title
  //   **Section title**
  //   Section title:        (line ending with colon)
  const lines = text.split(/\r?\n/);
  const sections = [];
  let current = null;
  const headingRegex = /^(?:#{1,4}\s+)?(?:\*\*)?\s*(lead with|concerns?|objections?|next step|alternatives?|ladder|pricing|why now|skills?|outcomes?|board hook|runway|family fit|qualification|tier match)\b[:\-*\s]*$/i;
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) {
      if (current) current.body += "\n";
      continue;
    }
    const m = headingRegex.exec(line);
    if (m) {
      if (current && current.body.trim()) sections.push(current);
      const title = m[1].replace(/\b\w/g, (c) => c.toUpperCase());
      const key = title.toLowerCase().replace(/\s+/g, "_");
      current = { key, title, body: "" };
      continue;
    }
    if (!current) {
      current = { key: "advisor_brief", title: "Advisor brief", body: "" };
    }
    current.body += rawLine + "\n";
  }
  if (current && current.body.trim()) sections.push(current);
  // Trim bodies.
  for (const s of sections) s.body = s.body.trim();
  if (sections.length === 0 && text) {
    return [{ key: "advisor_brief", title: "Advisor brief", body: text }];
  }
  return sections;
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
  // PRD §3.3.7 + DD-5.7 — human_pick is senior-role-gated to ADMIN only.
  // MANAGER + USER see prior pick as read-only display; only ADMIN can
  // edit. Engine output is collapsed for ADMIN until pick recorded.
  const canEditHumanPick = user?.role === "ADMIN";
  const diagId = parseInt(id, 10);

  const [diag, setDiag] = useState(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(null);

  const [regenInFlight, setRegenInFlight] = useState(false);
  const [pdfBusy, setPdfBusy] = useState(false);

  const [callTranscript, setCallTranscript] = useState("");
  const [compareInFlight, setCompareInFlight] = useState(false);
  const [comparison, setComparison] = useState(null);

  // human_pick recorder + collapsible engine output (TMC-only, T11).
  const [humanPickDraft, setHumanPickDraft] = useState("");
  const [humanPickSaving, setHumanPickSaving] = useState(false);
  const [catalogue, setCatalogue] = useState([]);

  // G104 — DD-5.7 blind-collapsed sales brief. Each parsed section starts
  // closed; per-section reveal-click fires a fire-and-forget audit POST
  // so we can prove "advisor saw section X at time Y" without re-billing
  // the LLM. The Set tracks already-revealed keys (deduped audit emits).
  const [briefOpenKeys, setBriefOpenKeys] = useState(new Set());
  const [briefRevealedKeys, setBriefRevealedKeys] = useState(new Set());
  const [catalogueLoading, setCatalogueLoading] = useState(false);
  const [engineExpanded, setEngineExpanded] = useState(false);

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

  // (Re)generate the branded report PDF on demand. Submission-time generation
  // is best-effort and can leave reportPdfUrl null; this rebuilds it and opens
  // the result in a new tab.
  const regenReportPdf = async () => {
    setPdfBusy(true);
    try {
      const res = await fetchApi(`/api/travel/diagnostics/${diagId}/report-pdf/regen`, {
        method: "POST",
        body: JSON.stringify({}),
      });
      if (res?.reportPdfUrl) {
        setDiag((d) => (d ? { ...d, reportPdfUrl: res.reportPdfUrl } : d));
        notify.success("Report PDF generated");
        window.open(res.reportPdfUrl, "_blank", "noopener,noreferrer");
      } else {
        notify.error("PDF generation returned no URL");
      }
    } catch (e) {
      notify.error(e?.message || "Failed to generate report PDF");
    } finally {
      setPdfBusy(false);
    }
  };

  // Sync the dropdown draft with whatever's persisted on the diagnostic.
  // This intentionally re-fires when diag.humanPick changes (after a
  // successful save) so the dropdown reflects the canonical state.
  useEffect(() => {
    if (diag && typeof diag.humanPick === "string") {
      setHumanPickDraft(diag.humanPick);
    } else if (diag) {
      setHumanPickDraft("");
    }
  }, [diag?.humanPick]);

  // Once a pick is recorded, the engine output expands automatically per
  // DD-5.7 (collapsed until recorded). The senior reviewer can still
  // collapse it again via the toggle to take a second blind read on a
  // sibling diagnostic, but the default is reveal-on-record.
  useEffect(() => {
    if (diag?.humanPick) setEngineExpanded(true);
  }, [diag?.humanPick]);

  // Load the catalogue of active trips for the human_pick dropdown.
  // Only fetched once per page load AND only for TMC diagnostics; other
  // sub-brands never see the recorder section.
  const loadCatalogue = useCallback(() => {
    setCatalogueLoading(true);
    fetchApi("/api/travel-tmc-catalogue?status=active", { silent: true })
      .then((res) => {
        const items = Array.isArray(res) ? res : (res?.items || res?.catalogue || []);
        setCatalogue(items.filter((r) => r?.status === "active"));
      })
      .catch(() => {
        // Non-fatal — the dropdown still ships "other" + "no_rec" options.
        setCatalogue([]);
      })
      .finally(() => setCatalogueLoading(false));
  }, []);

  useEffect(() => {
    if (diag?.subBrand === "tmc") loadCatalogue();
  }, [diag?.subBrand, loadCatalogue]);

  const saveHumanPick = async () => {
    if (!canEditHumanPick) return;
    if (!humanPickDraft) {
      notify.error("Pick a trip, \"other\", or \"no rec\" before saving.");
      return;
    }
    setHumanPickSaving(true);
    try {
      const res = await fetchApi(`/api/travel/diagnostics/${diagId}`, {
        method: "PATCH",
        body: JSON.stringify({ humanPick: humanPickDraft }),
      });
      const next = res?.diagnostic || res;
      if (next && typeof next === "object" && next.id) {
        setDiag(next);
      } else {
        // Server returned an envelope we don't recognize — refetch to be safe.
        setDiag((prev) => (prev ? { ...prev, humanPick: humanPickDraft } : prev));
      }
      notify.success("Human pick recorded — engine output unlocked.");
      setEngineExpanded(true);
    } catch (e) {
      notify.error(e?.body?.error || e?.message || "Failed to save human pick");
    } finally {
      setHumanPickSaving(false);
    }
  };

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
        {(diag.contact?.name || diag.contact?.email || diag.contactId) && (
          <span style={classChip} aria-label="Customer">
            {diag.contact?.name || diag.contact?.email || `Contact #${diag.contactId}`}
          </span>
        )}
        <span style={{ marginLeft: "auto", color: "var(--text-secondary)", fontSize: 13 }}>
          Created {fmtDate(diag.createdAt)}
        </span>
      </header>

      {/* ── Customer — who took this diagnostic ──────────────────── */}
      {(diag.contact?.name || diag.contact?.email || diag.contact?.phone || diag.contactId) && (
        <section style={card}>
          <h2 style={cardTitle}>Customer</h2>
          <div style={summaryRow}>
            <div>
              <span style={kvLabel}>Name</span>
              <span style={{ marginLeft: 8 }}>{diag.contact?.name || "—"}</span>
            </div>
            <div>
              <span style={kvLabel}>Email</span>
              <span style={{ marginLeft: 8 }}>{diag.contact?.email || "—"}</span>
            </div>
            <div>
              <span style={kvLabel}>Phone</span>
              <span style={{ marginLeft: 8 }}>{diag.contact?.phone || "—"}</span>
            </div>
            {diag.contactId && (
              <div>
                <span style={kvLabel}>Contact ID</span>
                <span style={{ marginLeft: 8 }}>#{diag.contactId}</span>
              </div>
            )}
          </div>
        </section>
      )}

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
          <div style={{ marginLeft: "auto", display: "flex", gap: 8, alignItems: "center" }}>
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
            <button
              type="button"
              onClick={regenReportPdf}
              disabled={pdfBusy}
              title="Build the branded report PDF from this diagnostic"
              style={{
                ...pdfLink,
                background: "none",
                border: "1px solid var(--border-color, #2a2a2a)",
                cursor: pdfBusy ? "not-allowed" : "pointer",
                opacity: pdfBusy ? 0.6 : 1,
              }}
            >
              <RefreshCw size={14} aria-hidden />{" "}
              {pdfBusy
                ? "Generating…"
                : diag.reportPdfUrl
                  ? "Regenerate PDF"
                  : "Generate report PDF"}
            </button>
          </div>
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

      {/* ── TMC human_pick recorder + engine output (PRD T11 / DD-5.7) ── */}
      {diag.subBrand === "tmc" && (
        <HumanPickSection
          diag={diag}
          catalogue={catalogue}
          catalogueLoading={catalogueLoading}
          humanPickDraft={humanPickDraft}
          setHumanPickDraft={setHumanPickDraft}
          saveHumanPick={saveHumanPick}
          humanPickSaving={humanPickSaving}
          canEditHumanPick={canEditHumanPick}
          engineExpanded={engineExpanded}
          setEngineExpanded={setEngineExpanded}
        />
      )}

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
            {(() => {
              // G104 — DD-5.7 blind-collapsed UX. Each Job-B sales-brief
              // section starts CLOSED. Per-section reveal-click fires an
              // audit POST (deduped per session). Open-all / Close-all
              // toggles bulk the section state.
              const sections = parseBriefSections(envelope);
              if (sections.length === 0) {
                return (
                  <div style={emptyBox} role="status">
                    <Sparkles
                      size={18}
                      aria-hidden
                      style={{ color: "var(--text-secondary)" }}
                    />
                    <div>(no brief content returned)</div>
                  </div>
                );
              }
              const allOpen = sections.every((s) =>
                briefOpenKeys.has(s.key),
              );
              const openAll = () => {
                const next = new Set(briefOpenKeys);
                for (const s of sections) {
                  next.add(s.key);
                  if (!briefRevealedKeys.has(s.key)) {
                    fetchApi(`/api/travel/diagnostics/${diagId}/brief-reveal`, {
                      method: "POST",
                      body: JSON.stringify({ sectionKey: s.key }),
                    }).catch(() => {});
                  }
                }
                setBriefOpenKeys(next);
                setBriefRevealedKeys((prev) => {
                  const n = new Set(prev);
                  for (const s of sections) n.add(s.key);
                  return n;
                });
              };
              const closeAll = () => setBriefOpenKeys(new Set());
              return (
                <>
                  <div
                    style={{
                      display: "flex",
                      gap: 8,
                      marginBottom: 8,
                      alignItems: "center",
                    }}
                    data-testid="brief-collapse-toolbar"
                  >
                    <span
                      style={{
                        fontSize: 12,
                        color: "var(--text-secondary)",
                      }}
                    >
                      Sections start collapsed (DD-5.7 blind-collapsed UX —
                      open as you read).
                    </span>
                    {sections.length > 1 && (
                      <>
                        <button
                          type="button"
                          onClick={allOpen ? closeAll : openAll}
                          style={collapseToggleBtn}
                          aria-label={
                            allOpen ? "Close all sections" : "Open all sections"
                          }
                        >
                          {allOpen ? (
                            <>
                              <EyeOff size={12} aria-hidden /> Close all
                            </>
                          ) : (
                            <>
                              <Eye size={12} aria-hidden /> Open all
                            </>
                          )}
                        </button>
                      </>
                    )}
                  </div>
                  {sections.map((s) => (
                    <details
                      key={s.key}
                      open={briefOpenKeys.has(s.key)}
                      data-testid={`brief-section-${s.key}`}
                      style={detailsStyle}
                      onToggle={(e) => {
                        const isOpen = e.currentTarget.open;
                        setBriefOpenKeys((prev) => {
                          const next = new Set(prev);
                          if (isOpen) next.add(s.key);
                          else next.delete(s.key);
                          return next;
                        });
                        if (isOpen && !briefRevealedKeys.has(s.key)) {
                          setBriefRevealedKeys((prev) => {
                            const n = new Set(prev);
                            n.add(s.key);
                            return n;
                          });
                          fetchApi(
                            `/api/travel/diagnostics/${diagId}/brief-reveal`,
                            {
                              method: "POST",
                              body: JSON.stringify({ sectionKey: s.key }),
                            },
                          ).catch(() => {});
                        }
                      }}
                    >
                      <summary style={summaryStyle}>{s.title}</summary>
                      <div style={proseBox} data-testid={`brief-body-${s.key}`}>
                        {s.body}
                      </div>
                    </details>
                  ))}
                </>
              );
            })()}
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

// ─── TMC human_pick recorder + engine output (DD-5.7 collapsible) ────
//
// Senior reviewers (ADMIN) pick one of the 5 starter trips, "other", or
// "no_rec" BLIND to the engine's recommendation. The engine output stays
// COLLAPSED until they save — DD-5.7's load-bearing constraint. Once a
// pick is recorded the engine output unlocks (auto-expanded) and the
// reviewer can compare their pick against the engine's primary/alternative
// recommendations + per-signal scores for §3.3.7 disagreement triage.

const SPECIAL_PICK_OPTIONS = [
  { value: "other", label: "Other (not in the catalogue)" },
  { value: "no_rec", label: "No recommendation" },
];

function HumanPickSection({
  diag, catalogue, catalogueLoading,
  humanPickDraft, setHumanPickDraft, saveHumanPick, humanPickSaving,
  canEditHumanPick, engineExpanded, setEngineExpanded,
}) {
  const persisted = diag?.humanPick || "";
  const hasPick = !!persisted;
  const engineScores = parseTalkingPointsEnvelope(diag?.engineScoresJson);
  const engineFlags = parseTalkingPointsEnvelope(diag?.flagsJson);
  const labelForValue = (v) => {
    if (!v) return "—";
    const fromCatalogue = catalogue.find((c) => c.tripId === v || String(c.id) === v);
    if (fromCatalogue) return fromCatalogue.title || fromCatalogue.tripId;
    const special = SPECIAL_PICK_OPTIONS.find((o) => o.value === v);
    if (special) return special.label;
    return v;
  };

  return (
    <section style={{ ...card, marginTop: 16 }} aria-label="Human pick and engine output">
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8, flexWrap: "wrap" }}>
        <h2 style={{ ...cardTitle, margin: 0 }}>
          <UserCheck size={18} aria-hidden /> Senior reviewer — human pick
        </h2>
        {hasPick && (
          <span style={pickedBadge} aria-label="Pick recorded">
            <CheckCircle size={12} aria-hidden /> recorded
          </span>
        )}
      </div>

      <p style={{ color: "var(--text-secondary)", fontSize: 13, margin: "0 0 12px" }}>
        PRD §3.3.7 protocol — record your hand-picked trip <strong>blind</strong> to
        the engine output below. After ≥50 pilot submissions an analyst
        computes engine-vs-human agreement rate and tunes one weight at a
        time.
      </p>

      {/* Dropdown (ADMIN) or read-only display (MANAGER / USER) */}
      {canEditHumanPick ? (
        <div style={{ display: "flex", flexWrap: "wrap", gap: 12, alignItems: "flex-end" }}>
          <label style={{ flex: "1 1 280px", display: "flex", flexDirection: "column", gap: 6 }}>
            <span style={kvLabel}>Your pick</span>
            <select
              data-testid="human-pick-select"
              value={humanPickDraft}
              onChange={(e) => setHumanPickDraft(e.target.value)}
              style={input}
              aria-label="Human pick"
            >
              <option value="">— select —</option>
              {catalogueLoading && (
                <option value="" disabled>
                  Loading catalogue…
                </option>
              )}
              {catalogue.map((c) => (
                <option key={c.tripId || c.id} value={c.tripId || String(c.id)}>
                  {c.title || c.tripId}
                </option>
              ))}
              {SPECIAL_PICK_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>{o.label}</option>
              ))}
            </select>
          </label>
          <button
            type="button"
            onClick={saveHumanPick}
            disabled={humanPickSaving || !humanPickDraft}
            style={{
              ...primaryBtn,
              opacity: (humanPickSaving || !humanPickDraft) ? 0.6 : 1,
            }}
            aria-label="Save human pick"
          >
            <UserCheck size={14} aria-hidden />
            {humanPickSaving ? "Saving…" : hasPick ? "Update pick" : "Save pick"}
          </button>
        </div>
      ) : (
        <div style={{ fontSize: 14 }} data-testid="human-pick-readonly">
          <span style={kvLabel}>Recorded pick</span>
          <span style={{ marginLeft: 8 }}>{labelForValue(persisted)}</span>
          <span style={{ marginLeft: 12, color: "var(--text-secondary)", fontSize: 12 }}>
            (ADMIN only)
          </span>
        </div>
      )}

      {/* Engine output — collapsed until pick recorded (DD-5.7). */}
      <div style={{ marginTop: 16 }}>
        {hasPick && engineExpanded ? (
          <div data-testid="engine-output-expanded">
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
              <strong style={{ fontSize: 14 }}>Engine output</strong>
              <button
                type="button"
                onClick={() => setEngineExpanded(false)}
                style={collapseBtn}
                aria-label="Collapse engine output"
              >
                <EyeOff size={12} aria-hidden /> Collapse
              </button>
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 180px), 1fr))", gap: 10 }}>
              <EngineKV label="Engine state" value={diag.engineState || "—"} />
              <EngineKV label="Primary trip id" value={diag.recommendedTripId ?? "—"} />
              <EngineKV label="Alternative trip id" value={diag.alternativeTripId ?? "—"} />
              <EngineKV label="ICP tier" value={diag.icpTier || "—"} />
              <EngineKV label="Lead quality" value={diag.leadQuality || "—"} />
              <EngineKV label="Weights version" value={diag.weightsVersion || "—"} />
            </div>
            {Array.isArray(engineFlags) && engineFlags.length > 0 && (
              <div style={{ marginTop: 10, fontSize: 13 }}>
                <span style={kvLabel}>Flags</span>
                <span style={{ marginLeft: 8 }}>{engineFlags.join(", ")}</span>
              </div>
            )}
            {engineScores && (
              <details style={{ marginTop: 10 }}>
                <summary style={{ cursor: "pointer", fontSize: 13, color: "var(--text-secondary)" }}>
                  Per-signal score breakdown (raw engineScoresJson)
                </summary>
                <pre style={engineScoresPre} data-testid="engine-scores-pre">
                  {JSON.stringify(engineScores, null, 2)}
                </pre>
              </details>
            )}
          </div>
        ) : hasPick && !engineExpanded ? (
          <button
            type="button"
            onClick={() => setEngineExpanded(true)}
            style={revealBtn}
            data-testid="engine-output-reveal"
            aria-label="Reveal engine output"
          >
            <Eye size={14} aria-hidden /> Reveal engine output
          </button>
        ) : (
          <div
            data-testid="engine-output-collapsed"
            role="status"
            style={collapsedBox}
          >
            <EyeOff size={18} aria-hidden style={{ color: "var(--text-secondary)" }} />
            <div>
              <strong>Engine output hidden</strong> — record your pick first per
              PRD §3.3.7 (DD-5.7). This keeps your read of the school&rsquo;s
              answers untainted by the engine&rsquo;s recommendation.
            </div>
          </div>
        )}
      </div>
    </section>
  );
}

function EngineKV({ label, value }) {
  return (
    <div>
      <div style={kvLabel}>{label}</div>
      <div style={{ fontSize: 14, marginTop: 2 }}>{String(value)}</div>
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

// G104 — DD-5.7 blind-collapsed UX styles.
const detailsStyle = {
  border: "1px solid var(--border-light)",
  borderRadius: 8,
  background: "var(--bg-color)",
  marginBottom: 8,
  padding: "8px 12px",
};

const summaryStyle = {
  cursor: "pointer",
  fontSize: 14,
  fontWeight: 600,
  padding: "4px 0",
  color: "var(--text-primary)",
  listStyle: "revert",
};

const collapseToggleBtn = {
  display: "inline-flex",
  alignItems: "center",
  gap: 4,
  marginLeft: "auto",
  padding: "4px 10px",
  borderRadius: 6,
  fontSize: 12,
  fontWeight: 500,
  background: "transparent",
  color: "var(--text-secondary)",
  border: "1px solid var(--border-color)",
  cursor: "pointer",
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

const input = {
  width: "100%", boxSizing: "border-box",
  padding: "8px 10px", borderRadius: 6,
  border: "1px solid var(--border-color)",
  background: "var(--surface-color)", color: "var(--text-primary)",
  fontSize: 13, fontFamily: "inherit",
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

const pickedBadge = {
  display: "inline-flex", alignItems: "center", gap: 4,
  padding: "2px 8px", borderRadius: 999, fontSize: 11, fontWeight: 600,
  background: "rgba(47, 122, 77, 0.14)", color: "#2F7A4D",
  border: "1px solid #2F7A4D",
};

const collapsedBox = {
  padding: 14, borderRadius: 8,
  background: "var(--subtle-bg)",
  border: "1px dashed var(--border-color)",
  display: "flex", alignItems: "flex-start", gap: 10,
  color: "var(--text-primary)", fontSize: 14, lineHeight: 1.4,
};

const revealBtn = {
  display: "inline-flex", alignItems: "center", gap: 6,
  padding: "6px 12px", borderRadius: 6, fontWeight: 600, fontSize: 13,
  background: "var(--surface-color)", color: "var(--primary-color, var(--accent-color))",
  border: "1px solid var(--primary-color, var(--accent-color))", cursor: "pointer",
};

const collapseBtn = {
  display: "inline-flex", alignItems: "center", gap: 4,
  padding: "2px 8px", borderRadius: 6, fontSize: 11, fontWeight: 500,
  background: "transparent", color: "var(--text-secondary)",
  border: "1px solid var(--border-color)", cursor: "pointer",
};

const engineScoresPre = {
  marginTop: 6, padding: 10, borderRadius: 6,
  background: "var(--bg-color)", border: "1px solid var(--border-light)",
  fontSize: 12, fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
  whiteSpace: "pre-wrap", maxHeight: 240, overflow: "auto",
};
