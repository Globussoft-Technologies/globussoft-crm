// Travel CRM  Diagnostic Detail (advisor brief surface, PRD 4.1 + 4.2 + 7).
//
// Lands at /travel/diagnostics/:id. Closes the loop on two LLM-router
// consumer endpoints that have shipped backend-only:
//
//    POST /api/travel/diagnostics/:id/talking-points/regen
//       commit cf876af  writes TravelDiagnostic.talkingPointsJson envelope
//       { text, model, generatedAt, stub }
//    POST /api/travel/diagnostics/:id/form-vs-call/compare
//       commits 4a7c623 + 8b97fd5  returns { classification, scorePercent,
//       summary, model, stub, perFieldDiff }
//
// Page layout (top  bottom):
//   1. Header: id, sub-brand badge, classification chip, back link
//   2. Answers + classification  question/answer joined from the bank
//      snapshot stored in TravelDiagnostic.questionsJson + answersJson;
//      score + recommendedTier line; optional report PDF download link
//   3. Talking-points brief  renders the persisted envelope or shows
//      an empty-state Generate button. Stub badge surfaces when the LLM
//      router returned a synthetic response (Q11 keys not yet wired).
//      Regenerate button is ADMIN/MANAGER only.
//   4. Form-vs-call comparison  textarea for the call transcript +
//      Compare button POSTs the comparison endpoint and renders the
//      classification badge (color-coded match/review/mismatch/unknown),
//      scorePercent, summary prose, and perFieldDiff table.
//
//  TMC 3.3.7 human_pick recorder (PRD T11 / DD-5.7) 
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

import { useEffect, useState, useContext } from "react";
import { Link, useParams } from "react-router-dom";
import {
  ChevronLeft, ClipboardCheck, RefreshCw, FileText, Send, Copy, Share2,
  AlertTriangle, CheckCircle, Eye, EyeOff, UserCheck, Heart, UserRound, Mail, Phone, Hash,
} from "lucide-react";
import { fetchApi, getAuthToken } from "../../utils/api";
import { useNotify } from "../../utils/notify";
import { AuthContext } from "../../App";

const SUB_BRAND_LABEL = {
  tmc: "TMC (schools)",
  rfu: "RFU (Umrah)",
  travelstall: "Travel Stall",
  visasure: "Visa Sure",
};

const DIAGNOSTICS_LAST_LIST_URL_KEY = "travel.diagnostics.lastListUrl";

function getDiagnosticsListUrl() {
  try {
    const savedUrl = window.sessionStorage.getItem(DIAGNOSTICS_LAST_LIST_URL_KEY);
    return savedUrl && savedUrl.startsWith("/travel/diagnostics")
      ? savedUrl
      : "/travel/diagnostics";
  } catch {
    return "/travel/diagnostics";
  }
}

function fmtDate(d) {
  if (!d) return "";
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
  if (value === null || value === undefined || value === "") return "";
  if (Array.isArray(value)) return value.join(", ");
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

// Back-compat: older diagnostics may store either /uploads/diagnostics/... or
// /api/uploads/diagnostics/... depending on when the PDF was generated.
// Normalize both forms to the canonical /api/uploads/diagnostics/... path.
function normalizeDiagnosticPdfUrl(url) {
  if (!url || typeof url !== "string") return url;
  if (url.startsWith("/uploads/diagnostics/")) {
    return `/api${url}`;
  }
  if (url.startsWith("/api/uploads/diagnostics/")) {
    return url;
  }
  return url;
}

function getDiagnosticPdfFilename(url, fallback = "diagnostic-report.pdf") {
  if (!url || typeof url !== "string") return fallback;
  try {
    const parsed = new URL(url, window.location.origin);
    return parsed.pathname.split("/").filter(Boolean).pop() || fallback;
  } catch {
    const cleaned = url.split("?")[0].split("#")[0];
    return cleaned.split("/").filter(Boolean).pop() || fallback;
  }
}

export default function DiagnosticDetail() {
  const { id } = useParams();
  const [diagnosticsListUrl] = useState(getDiagnosticsListUrl);
  const notify = useNotify();
  const { user } = useContext(AuthContext) || {};
  // PRD 3.3.7 + DD-5.7  human_pick is senior-role-gated to ADMIN only.
  // MANAGER + USER see prior pick as read-only display; only ADMIN can
  // edit. Engine output is collapsed for ADMIN until pick recorded.
  const canEditHumanPick = user?.role === "ADMIN";
  const diagId = parseInt(id, 10);

  const [diag, setDiag] = useState(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(null);

  const [pdfBusy, setPdfBusy] = useState(false);
  const [pdfDownloadBusy, setPdfDownloadBusy] = useState(false);
  const [shareOpen, setShareOpen] = useState(false);
  const [shareBusy, setShareBusy] = useState(false);
  const [shareInfo, setShareInfo] = useState(null);
  const [shareEmailEnabled, setShareEmailEnabled] = useState(false);
  const [shareWhatsappEnabled, setShareWhatsappEnabled] = useState(false);
  const [shareEmail, setShareEmail] = useState("");
  const [sharePhone, setSharePhone] = useState("");

  // human_pick recorder + collapsible engine output (TMC-only, T11).
  const [humanPickDraft, setHumanPickDraft] = useState("");
  const [humanPickSaving, setHumanPickSaving] = useState(false);
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

  useEffect(() => {
    const email = String(diag?.contact?.email || "").trim();
    const phone = String(diag?.contact?.phone || "").trim();
    if (email) {
      setShareEmail((prev) => prev || email);
      setShareEmailEnabled(true);
    }
    if (phone) {
      setSharePhone((prev) => prev || phone);
      setShareWhatsappEnabled(true);
    }
  }, [diag?.contact?.email, diag?.contact?.phone]);

  // (Re)generate the branded report PDF on demand. Submission-time generation
  // is best-effort and can leave reportPdfUrl null; this rebuilds it and opens
  // the result in a new tab.

  const copyShareLink = async () => {
    let url = shareInfo?.shareUrl;
    try {
      if (!url) {
        const res = await fetchApi(`/api/travel/diagnostics/${diagId}/share`, {
          method: "POST",
          body: JSON.stringify({ channel: "manual", frontendBase: window.location.origin }),
        });
        url = res?.shareUrl;
        if (!url) throw new Error("No share link was returned");
        setShareInfo(res);
      }
      await navigator.clipboard?.writeText(url);
      notify.success("Share link created and copied.");
    } catch (e) {
      notify.error(e?.message || "Could not create a share link.");
    }
  };

  const confirmShare = async () => {
    if (!diagId) {
      notify.error("Diagnostic not loaded.");
      return;
    }
    const email = shareEmail.trim();
    const phone = sharePhone.trim();
    const emailRequested = Boolean(shareEmailEnabled);
    const whatsappRequested = Boolean(shareWhatsappEnabled);
    const channel = emailRequested && whatsappRequested
      ? "auto"
      : emailRequested
        ? "email"
        : whatsappRequested
          ? "whatsapp"
          : "manual";

    setShareBusy(true);
    try {
      const res = await fetchApi(`/api/travel/diagnostics/${diagId}/share`, {
        method: "POST",
        body: JSON.stringify({
          channel,
          frontendBase: window.location.origin,
          email: emailRequested ? email : undefined,
          phone: whatsappRequested ? phone : undefined,
        }),
      });
      if (res?.shareUrl) setShareInfo(res);
      setShareOpen(true);
      if (res?.channel && res.channel !== "none") {
        const parts = [];
        if (res.channel.includes("email")) parts.push("email");
        if (res.channel.includes("whatsapp")) parts.push("WhatsApp");
        notify.success(`Readiness report shared via ${parts.join(" + ")}`);
      } else {
        notify.info("Share link created. Copy it and send it manually.");
      }
    } catch (e) {
      notify.error(e?.data?.error || e?.body?.error || e?.message || "Failed to share readiness report");
    } finally {
      setShareBusy(false);
    }
  };

  const fetchDiagnosticPdfBlob = async (url) => {
    const normalized = normalizeDiagnosticPdfUrl(url);
    const token = typeof getAuthToken === "function" ? getAuthToken() : null;
    const res = await fetch(normalized, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
    if (!res.ok) {
      let detail = `HTTP ${res.status}`;
      try {
        const body = await res.json();
        if (body?.error) detail = body.error;
      } catch {
        // ignore non-JSON error bodies
      }
      throw new Error(detail);
    }
    return res.blob();
  };

  const downloadBlob = (blob, filename) => {
    const objectUrl = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = objectUrl;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(objectUrl), 60_000);
  };

  const downloadReportPdf = async () => {
    const url = normalizeDiagnosticPdfUrl(diag?.reportPdfUrl);
    if (!url) {
      notify.error("No report PDF is available yet.");
      return;
    }
    setPdfDownloadBusy(true);
    try {
      const blob = await fetchDiagnosticPdfBlob(url);
      downloadBlob(blob, getDiagnosticPdfFilename(url));
    } finally {
      setPdfDownloadBusy(false);
    }
  };

  const regenReportPdf = async ({ successMessage = "Report PDF generated" } = {}) => {
    setPdfBusy(true);
    try {
      const res = await fetchApi(`/api/travel/diagnostics/${diagId}/report-pdf/regen`, {
        method: "POST",
        body: JSON.stringify({}),
      });
      if (res?.reportPdfUrl) {
        const normalized = normalizeDiagnosticPdfUrl(res.reportPdfUrl);
        setDiag((d) => (d ? { ...d, reportPdfUrl: normalized } : d));
        notify.success(successMessage);
        const blob = await fetchDiagnosticPdfBlob(normalized);
        downloadBlob(blob, getDiagnosticPdfFilename(normalized));
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
        // Server returned an envelope we don't recognize  refetch to be safe.
        setDiag((prev) => (prev ? { ...prev, humanPick: humanPickDraft } : prev));
      }
      notify.success("Human recommendation recorded. AI output unlocked.");
      setEngineExpanded(true);
    } catch (e) {
      notify.error(e?.body?.error || e?.message || "Failed to save human pick");
    } finally {
      setHumanPickSaving(false);
    }
  };

  if (loading) {
    return (
      <div style={{ padding: 24, maxWidth: 1100, margin: "0 auto" }}>
        <Link to={diagnosticsListUrl} style={backLink}>
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
        <Link to={diagnosticsListUrl} style={backLink}>
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
  const isCatalogueInterest = diag?.source === "public_catalogue_interest";
  const catalogueInterest = answers.catalogueInterest || {};
  const subBrandLabel = SUB_BRAND_LABEL[diag?.subBrand] || diag?.subBrand || "";

  return (
    <div style={{ padding: 24, maxWidth: 1100, margin: "0 auto" }}>
      <Link to={diagnosticsListUrl} style={backLink}>
        <ChevronLeft size={16} aria-hidden /> Back to diagnostics
      </Link>

      {/*  Header  */}
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

      {/*  Customer  who took this diagnostic  */}
      {(diag.contact?.name || diag.contact?.email || diag.contact?.phone || diag.contactId) && (
        <section style={card}>
          <h2 style={cardTitle}>Customer</h2>
          <div style={customerGrid}>
            <CustomerInfo icon={UserRound} label="Name" value={diag.contact?.name} />
            <CustomerInfo icon={Mail} label="Email" value={diag.contact?.email} />
            <CustomerInfo icon={Phone} label="Phone" value={diag.contact?.phone} />
            {diag.contactId && <CustomerInfo icon={Hash} label="Contact ID" value={`#${diag.contactId}`} />}
          </div>
        </section>
      )}

      {/*  Section 1: answers + classification  */}
      <section style={isCatalogueInterest ? { display: "none" } : card}>
        <h2 style={cardTitle}>
          <ClipboardCheck size={18} aria-hidden /> Answers &amp; classification
        </h2>
        <div style={summaryRow}>
          <div>
            <span style={kvLabel}>Score</span>
            <span style={{ marginLeft: 8 }}>
              {diag.score != null ? Number(diag.score).toFixed(2) : ""}
            </span>
          </div>
          <div>
            <span style={kvLabel}>Recommended tier</span>
            <span style={{ marginLeft: 8 }}>{diag.recommendedTier || ""}</span>
          </div>
          <div style={{ marginLeft: "auto", display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
            {diag.reportPdfUrl && (
              <button
                type="button"
                onClick={downloadReportPdf}
                disabled={pdfDownloadBusy}
                style={{
                  ...pdfLink,
                  cursor: pdfDownloadBusy ? "not-allowed" : "pointer",
                  opacity: pdfDownloadBusy ? 0.7 : 1,
                  background: "none",
                }}
              >
                <FileText size={14} aria-hidden /> {pdfDownloadBusy ? "Downloading..." : "Download report PDF"}
              </button>
            )}
            <button
              type="button"
              onClick={() => regenReportPdf()}
              disabled={pdfBusy}
              title="Build the branded report PDF from this diagnostic"
              style={{
                ...reportSecondaryBtn,
                cursor: pdfBusy ? "not-allowed" : "pointer",
                opacity: pdfBusy ? 0.6 : 1,
              }}
            >
              <RefreshCw size={15} aria-hidden />
              {pdfBusy
                ? "Generating..."
                : diag.reportPdfUrl
                  ? "Regenerate PDF"
                  : "Generate report PDF"}
            </button>
            <button
              type="button"
              onClick={() => setShareOpen((open) => !open)}
              title="Open the share panel"
              style={reportGhostBtn}
            >
              <Share2 size={15} aria-hidden />
              {shareOpen ? "Hide share panel" : "Share report"}
            </button>
          </div>
        </div>
        {shareOpen && (
          <section style={sharePanel} aria-label="Share readiness report">
            <div style={sharePanelHeader}>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <Share2 size={14} aria-hidden />
                <strong>Share readiness report</strong>
              </div>
              <span style={shareHint}>
                {shareInfo?.channel && shareInfo.channel !== "none"
                  ? `Delivered via ${shareInfo.channel.replace("+", " + ")}`
                  : "Create a link for manual sharing or send it directly"}
              </span>
            </div>
            <div style={shareGrid}>
              <label style={shareField}>
                <span style={kvLabel}>Email</span>
                <input
                  type="email"
                  value={shareEmail}
                  onChange={(e) => setShareEmail(e.target.value)}
                  placeholder="advisor@example.com"
                  style={input}
                />
              </label>
              <label style={shareField}>
                <span style={kvLabel}>WhatsApp number</span>
                <input
                  type="tel"
                  value={sharePhone}
                  onChange={(e) => setSharePhone(e.target.value)}
                  placeholder="+91 9876543210"
                  style={input}
                />
              </label>
            </div>
            <div style={shareToggles}>
              <label style={shareToggle}>
                <input
                  type="checkbox"
                  checked={shareEmailEnabled}
                  onChange={(e) => setShareEmailEnabled(e.target.checked)}
                />
                <span>Email delivery</span>
              </label>
              <label style={shareToggle}>
                <input
                  type="checkbox"
                  checked={shareWhatsappEnabled}
                  onChange={(e) => setShareWhatsappEnabled(e.target.checked)}
                />
                <span>WhatsApp delivery</span>
              </label>
            </div>
            <div style={shareActions}>
              <button type="button" onClick={copyShareLink} style={secondaryBtn}>
                <Copy size={14} aria-hidden /> Copy link
              </button>
              <button type="button" onClick={confirmShare} disabled={shareBusy} style={primaryBtn}>
                <Send size={14} aria-hidden />
                {shareBusy ? "Sharing..." : "Send share"}
              </button>
            </div>
            {shareInfo?.shareUrl && (
              <div style={shareResult}>
                <span style={shareResultLabel}>Public link</span>
                <code style={shareCode}>{shareInfo.shareUrl}</code>
              </div>
            )}
          </section>
        )}
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

      {isCatalogueInterest && (
        <section style={card}>
          <h2 style={cardTitle}>Catalogue interest details</h2>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 16 }}>
            {[
              ["Name", catalogueInterest.name],
              ["Email", catalogueInterest.email],
              ["Phone", catalogueInterest.phone],
              ["Dates", catalogueInterest.dates ? new Date(`${catalogueInterest.dates}T00:00:00`).toLocaleDateString() : ""],
              ["Grades", catalogueInterest.grades],
              ["Tentative no. of students", catalogueInterest.students],
            ].map(([label, value]) => (
              <div key={label}>
                <span style={kvLabel}>{label}</span>
                <div style={{ marginTop: 5, fontWeight: 600 }}>{value || "—"}</div>
              </div>
            ))}
          </div>
        </section>
      )}

      {isCatalogueInterest && catalogueInterest.files?.length > 0 && (
        <section style={card}>
          <h2 style={cardTitle}>
            <Heart size={18} aria-hidden /> Selected catalogue PDFs
          </h2>
          <div style={{ display: "grid", gap: 8 }}>
            {catalogueInterest.files.map((file, idx) => (
              <div key={file.id || idx} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, padding: "8px 12px", borderRadius: 8, background: "var(--subtle-bg-3)" }}>
                <span style={{ fontWeight: 500 }}>{file.name || `Catalogue PDF ${idx + 1}`}</span>
                {file.driveViewLink && (
                  <a href={file.driveViewLink} target="_blank" rel="noopener noreferrer" style={{ color: "var(--primary-color)", fontSize: 13, fontWeight: 600, textDecoration: "none" }}>
                    View PDF &rarr;
                  </a>
                )}
              </div>
            ))}
          </div>
        </section>
      )}

      {/* Chosen itinerary interests (2026-08-27) — trips the school checked
          off on the public report page after submitting. Reads chosenInterests
          straight off the diagnostic response (see GET /diagnostics/:id in
          travel_diagnostics.js); omitted entirely when nothing was ever
          submitted, same pattern as every other optional section here. */}
      {diag.chosenInterests?.interests?.length > 0 && (
        <section style={card}>
          <h2 style={cardTitle}>
            <Heart size={18} aria-hidden /> User&rsquo;s chosen itinerary interests
          </h2>
          <div style={{ display: "grid", gap: 8 }}>
            {diag.chosenInterests.interests.map((interest, idx) => (
              <div
                key={idx}
                style={{
                  display: "flex", justifyContent: "space-between", alignItems: "center",
                  gap: 12, padding: "8px 12px", borderRadius: 8,
                  background: "var(--subtle-bg-3)", flexWrap: "wrap",
                }}
              >
                <span style={{ fontWeight: 500 }}>{interest.name}</span>
                {interest.driveLink && (
                  <a
                    href={interest.driveLink}
                    target="_blank"
                    rel="noopener noreferrer"
                    style={{ color: "var(--primary-color)", fontSize: 13, fontWeight: 600, textDecoration: "none" }}
                  >
                    View brochure →
                  </a>
                )}
              </div>
            ))}
          </div>
          {diag.chosenInterests.submittedAt && (
            <div style={{ marginTop: 10, fontSize: 12, color: "var(--text-secondary)" }}>
              Submitted {new Date(diag.chosenInterests.submittedAt).toLocaleString()}
            </div>
          )}
        </section>
      )}


      {/*  TMC human_pick recorder + engine output (PRD T11 / DD-5.7)  */}
      {!isCatalogueInterest && diag.subBrand === "tmc" && (
        <HumanPickSection
          diag={diag}
          humanPickDraft={humanPickDraft}
          setHumanPickDraft={setHumanPickDraft}
          saveHumanPick={saveHumanPick}
          humanPickSaving={humanPickSaving}
          canEditHumanPick={canEditHumanPick}
          engineExpanded={engineExpanded}
          setEngineExpanded={setEngineExpanded}
        />
      )}

    </div>
  );
}

// ? TMC human_pick recorder + engine output (DD-5.7 collapsible) ?
//
// Senior reviewers (ADMIN) pick one of the 5 starter trips, "other", or
// "no_rec" blind to the engine's recommendation. The engine output stays
// collapsed until they save ? DD-5.7's load-bearing constraint. Once a
// pick is recorded the engine output unlocks (auto-expanded) and the
// reviewer can compare their pick against the engine's primary/alternative
// recommendations + per-signal scores for ?3.3.7 disagreement triage.

// — TMC human_pick recorder + engine output (DD-5.7 collapsible) —
//
// Senior reviewers (ADMIN) pick one of the 5 starter trips, "other", or
// "no_rec" blind to the engine's recommendation. The engine output stays
// collapsed until they save — DD-5.7's load-bearing constraint. Once a
// pick is recorded the engine output unlocks (auto-expanded) and the
// reviewer can compare their pick against the engine's primary/alternative
// recommendations + per-signal scores for §3.3.7 disagreement triage.

function HumanPickSection({
  diag,
  humanPickDraft, setHumanPickDraft, saveHumanPick, humanPickSaving,
  canEditHumanPick, engineExpanded, setEngineExpanded,
}) {
  const persisted = diag?.humanPick || "";
  const hasPick = !!persisted;
  const engineScores = parseTalkingPointsEnvelope(diag?.engineScoresJson);
  const engineFlags = parseTalkingPointsEnvelope(diag?.flagsJson);
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
        Record the trip you&rsquo;d personally recommend for this school{" "}
        <strong>before</strong> looking at the AI&rsquo;s suggestion below.
        This keeps the senior review independent and gives the team a clear
        recommendation to compare with the AI.
      </p>

      {/* Free-text recommendation (ADMIN) or read-only display (MANAGER / USER). */}
      {canEditHumanPick ? (
        <div style={{ display: "flex", flexWrap: "wrap", gap: 12, alignItems: "flex-end" }}>
          <label style={{ flex: "1 1 280px", display: "flex", flexDirection: "column", gap: 6 }}>
            <span style={kvLabel}>Your recommendation</span>
            <input
              data-testid="human-pick-input"
              type="text"
              value={humanPickDraft}
              onChange={(e) => setHumanPickDraft(e.target.value)}
              style={input}
              maxLength={120}
              placeholder="Type the trip or recommendation"
              aria-label="Human recommendation"
            />
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
          <span style={kvLabel}>Recorded recommendation</span>
          <span style={{ marginLeft: 8 }}>{persisted || "—"}</span>
          <span style={{ marginLeft: 12, color: "var(--text-secondary)", fontSize: 12 }}>
            (ADMIN only)
          </span>
        </div>
      )}

      {/* AI recommendation — stays hidden until a pick is recorded, so the
          reviewer's own read of the school's answers isn't influenced by
          what the AI suggests. */}
      <div style={{ marginTop: 16 }}>
        {hasPick && engineExpanded ? (
          <div data-testid="engine-output-expanded">
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
              <strong style={{ fontSize: 14 }}>AI recommendation</strong>
              <button
                type="button"
                onClick={() => setEngineExpanded(false)}
                style={collapseBtn}
                aria-label="Hide AI recommendation"
              >
                <EyeOff size={12} aria-hidden /> Hide
              </button>
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 180px), 1fr))", gap: 10 }}>
              <EngineKV label="Match strength" value={diag.engineState || "—"} />
              <EngineKV label="AI's top pick" value={diag.recommendedTripId ?? "—"} />
              <EngineKV label="AI's alternative pick" value={diag.alternativeTripId ?? "—"} />
              <EngineKV label="Lead tier" value={diag.icpTier || "—"} />
              <EngineKV label="Lead quality" value={diag.leadQuality || "—"} />
              <EngineKV label="Scoring version" value={diag.weightsVersion || "—"} />
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
                  Detailed scoring breakdown (advanced)
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
            aria-label="Show AI recommendation"
          >
            <Eye size={14} aria-hidden /> Show AI recommendation
          </button>
        ) : (
          <div
            data-testid="engine-output-collapsed"
            role="status"
            style={collapsedBox}
          >
            <EyeOff size={18} aria-hidden style={{ color: "var(--text-secondary)" }} />
            <div>
              <strong>AI recommendation hidden</strong> — record your own pick
              first. This keeps your judgment independent of what the AI
              suggests.
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

function CustomerInfo({ icon: Icon, label, value }) {
  return (
    <div style={customerInfoTile}>
      <Icon size={16} aria-hidden style={customerInfoIcon} />
      <div style={customerInfoContent}>
        <span style={kvLabel}>{label}</span>
        <span style={customerInfoValue} title={value || "Not provided"}>{value || "Not provided"}</span>
      </div>
    </div>
  );
}

// ? Styles ?

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

const customerGrid = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 210px), 1fr))",
  gap: 10,
};

const customerInfoTile = {
  display: "flex",
  alignItems: "flex-start",
  gap: 9,
  minWidth: 0,
  padding: "10px 12px",
  border: "1px solid var(--border-light)",
  borderRadius: 8,
  background: "var(--subtle-bg)",
};

const customerInfoIcon = {
  flex: "0 0 auto",
  marginTop: 2,
  color: "var(--primary-color, var(--accent-color))",
};

const customerInfoContent = {
  display: "flex",
  flexDirection: "column",
  gap: 3,
  minWidth: 0,
};

const customerInfoValue = {
  color: "var(--text-primary)",
  fontSize: 14,
  fontWeight: 600,
  overflowWrap: "anywhere",
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

const errorBox = {
  marginTop: 16, padding: 16, borderRadius: 12,
  background: "var(--subtle-bg)", border: "1px solid var(--border-color)",
  display: "flex", alignItems: "flex-start", gap: 12,
  color: "var(--text-primary)", fontSize: 14,
};


const sharePanel = {
  marginTop: 12,
  padding: 16,
  borderRadius: 12,
  border: "1px solid var(--border-light)",
  background: "var(--subtle-bg)",
  display: "flex",
  flexDirection: "column",
  gap: 14,
};

const sharePanelHeader = {
  display: "flex",
  flexWrap: "wrap",
  alignItems: "center",
  gap: 10,
  justifyContent: "space-between",
};

const shareHint = {
  fontSize: 12,
  color: "var(--text-secondary)",
};

const shareGrid = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 260px), 1fr))",
  gap: 12,
};

const shareField = {
  display: "flex",
  flexDirection: "column",
  gap: 6,
};

const shareToggles = {
  display: "flex",
  flexWrap: "wrap",
  gap: 16,
  alignItems: "center",
};

const shareToggle = {
  display: "inline-flex",
  alignItems: "center",
  gap: 8,
  fontSize: 13,
  color: "var(--text-primary)",
};

const shareActions = {
  display: "flex",
  flexWrap: "wrap",
  gap: 8,
  alignItems: "center",
};

const shareResult = {
  display: "flex",
  flexDirection: "column",
  gap: 6,
  paddingTop: 4,
};

const shareResultLabel = {
  ...kvLabel,
};

const shareCode = {
  display: "block",
  padding: "8px 10px",
  borderRadius: 6,
  border: "1px solid var(--border-color)",
  background: "var(--bg-color)",
  fontSize: 12,
  wordBreak: "break-all",
};
const reportActionsCard = {
  marginTop: 14,
  padding: 18,
  borderRadius: 16,
  border: "1px solid color-mix(in srgb, var(--primary-color) 24%, var(--border-color))",
  background: "linear-gradient(135deg, color-mix(in srgb, var(--primary-color) 12%, var(--surface-color)) 0%, var(--surface-color) 58%, color-mix(in srgb, var(--accent-color, var(--primary-color)) 8%, var(--surface-color)) 100%)",
  display: "flex",
  flexWrap: "wrap",
  gap: 18,
  alignItems: "center",
  justifyContent: "space-between",
};
const reportEyebrow = {
  ...kvLabel,
  color: "var(--primary-color)",
};
const reportTitleRow = {
  display: "flex",
  flexWrap: "wrap",
  gap: 10,
  alignItems: "center",
};
const reportHelperText = {
  margin: 0,
  color: "var(--text-secondary)",
  fontSize: 13,
  lineHeight: 1.5,
  maxWidth: 560,
};
const reportPillBase = {
  display: "inline-flex",
  alignItems: "center",
  padding: "4px 10px",
  borderRadius: 999,
  fontSize: 11,
  fontWeight: 700,
  letterSpacing: 0.3,
  whiteSpace: "nowrap",
};
const reportReadyPill = {
  ...reportPillBase,
  background: "rgba(47, 122, 77, 0.14)",
  color: "#2F7A4D",
  border: "1px solid rgba(47, 122, 77, 0.32)",
};
const reportDraftPill = {
  ...reportPillBase,
  background: "rgba(200, 154, 78, 0.16)",
  color: "#9A6F2E",
  border: "1px solid rgba(154, 111, 46, 0.3)",
};
const reportActionsRow = {
  display: "flex",
  flexWrap: "wrap",
  gap: 10,
  alignItems: "center",
  justifyContent: "flex-end",
};
const reportButtonBase = {
  display: "inline-flex",
  alignItems: "center",
  gap: 8,
  minHeight: 42,
  padding: "9px 14px",
  borderRadius: 999,
  fontWeight: 700,
  fontSize: 13,
  textDecoration: "none",
  whiteSpace: "nowrap",
};
const reportPrimaryLink = {
  ...reportButtonBase,
  background: "var(--primary-color, var(--accent-color))",
  color: "#fff",
  border: "1px solid transparent",
};
const reportSecondaryBtn = {
  ...reportButtonBase,
  background: "var(--surface-color)",
  color: "var(--text-primary)",
  border: "1px solid var(--border-color)",
};
const reportGhostBtn = {
  ...reportButtonBase,
  background: "transparent",
  color: "var(--primary-color)",
  border: "1px dashed color-mix(in srgb, var(--primary-color) 44%, var(--border-color))",
  cursor: "pointer",
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
