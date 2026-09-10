import { useCallback, useEffect, useState } from "react";
import {
  Award,
  ClipboardCheck,
  Download,
  ExternalLink,
  GraduationCap,
  Loader2,
  RefreshCw,
  X,
} from "lucide-react";
import DiagnosticFormRenderer from "../../components/travel/DiagnosticFormRenderer";

const SUB_BRAND = "tmc";

async function portalApi(path, token) {
  const response = await fetch(`/api/portal/tmc${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw Object.assign(new Error(data.error || "Request failed"), {
      status: response.status,
    });
  }
  return data;
}

function formUrl(tenantSlug) {
  return `/api/travel/diagnostics/public/form/${encodeURIComponent(
    tenantSlug || "",
  )}/${SUB_BRAND}`;
}

function submitUrl(tenantSlug) {
  return `${formUrl(tenantSlug)}/submit`;
}

function reportUrl(tenantSlug, reportSlug) {
  return `/diagnostic-form/${encodeURIComponent(tenantSlug || "")}/${SUB_BRAND}/report/${encodeURIComponent(reportSlug || "")}`;
}

function isEmpty(value) {
  return (
    value == null ||
    (typeof value === "string" && value.trim() === "") ||
    (Array.isArray(value) && value.length === 0)
  );
}

function findMissingAnswer(questions, answers) {
  for (const question of questions) {
    const value = answers[question.id];
    if (question.required && isEmpty(value)) return question;
    if (
      question.type === "multi-select" &&
      Number.isInteger(question.minSelections) &&
      Array.isArray(value) &&
      value.length > 0 &&
      value.length < question.minSelections
    ) {
      return {
        ...question,
        validationMessage: `Please select at least ${question.minSelections} options for "${question.text}".`,
      };
    }
    if (
      question.type === "multi-select" &&
      Number.isInteger(question.minSelections) &&
      isEmpty(value)
    ) {
      return {
        ...question,
        validationMessage: `Please select at least ${question.minSelections} options for "${question.text}".`,
      };
    }
  }
  return null;
}

function reportFromResult(result, tenantSlug) {
  if (!result?.diagnosticId || !result?.reportSlug) return null;
  return {
    id: result.diagnosticId,
    engineState: result.classificationLabel || result.classification || null,
    createdAt: new Date().toISOString(),
    reportUrl: reportUrl(tenantSlug, result.reportSlug),
    reportPdfUrl:
      result.reportPdfUrl ||
      `/api/travel/diagnostics/public/readiness-report/${encodeURIComponent(result.reportSlug)}.pdf`,
  };
}

export default function TmcTeacherDiagnostics({
  token,
  tenantSlug,
  contact,
  onSessionExpired,
}) {
  const [formConfig, setFormConfig] = useState(null);
  const [questions, setQuestions] = useState([]);
  const [answers, setAnswers] = useState({});
  const [identity, setIdentity] = useState({});
  const [formLoading, setFormLoading] = useState(true);
  const [formError, setFormError] = useState("");
  const [reports, setReports] = useState([]);
  const [reportsLoading, setReportsLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState("");
  const [latest, setLatest] = useState(null);
  const [taking, setTaking] = useState(false);

  useEffect(() => {
    setIdentity({
      name: contact?.name || "",
      email: contact?.email || "",
      phone: contact?.phone || "",
    });
  }, [contact?.email, contact?.name, contact?.phone]);

  const loadForm = useCallback(async () => {
    if (!tenantSlug) {
      setFormLoading(false);
      setFormError("Your teacher workspace is still loading. Please refresh and try again.");
      return;
    }
    setFormLoading(true);
    setFormError("");
    try {
      const response = await fetch(formUrl(tenantSlug));
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(data.error || "The TMC diagnostic is not available right now.");
      }
      setFormConfig(data);
      setQuestions(Array.isArray(data.questions) ? data.questions : []);
    } catch (err) {
      setFormError(err.message || "Failed to load the TMC diagnostic.");
    } finally {
      setFormLoading(false);
    }
  }, [tenantSlug]);

  const loadReports = useCallback(async () => {
    setReportsLoading(true);
    try {
      const result = await portalApi("/teacher/diagnostics", token);
      setReports(Array.isArray(result.diagnostics) ? result.diagnostics : []);
    } catch (err) {
      if (err.status === 401 || err.status === 403 || err.status === 404) {
        onSessionExpired(err.message);
      } else {
        setSubmitError(err.message || "Failed to load diagnostic reports.");
      }
    } finally {
      setReportsLoading(false);
    }
  }, [onSessionExpired, token]);

  useEffect(() => {
    loadForm();
  }, [loadForm]);

  useEffect(() => {
    loadReports();
  }, [loadReports]);

  const setAnswer = (questionId, value) => {
    setAnswers((current) => ({ ...current, [questionId]: value }));
  };

  const toggleMulti = (questionId, value, max) => {
    setAnswers((current) => {
      const selected = Array.isArray(current[questionId]) ? current[questionId] : [];
      if (selected.includes(value)) {
        return { ...current, [questionId]: selected.filter((item) => item !== value) };
      }
      if (max && selected.length >= max) return current;
      return { ...current, [questionId]: [...selected, value] };
    });
  };

  const submit = async () => {
    setSubmitError("");
    const missing = findMissingAnswer(questions, answers);
    if (missing) {
      setSubmitError(
        missing.validationMessage ||
          `Please answer "${missing.text}" before submitting — it's required.`,
      );
      return;
    }

    setSubmitting(true);
    try {
      const response = await fetch(submitUrl(tenantSlug), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ answers, ...identity }),
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(result.error || "Failed to submit diagnostic.");

      const report = reportFromResult(result, tenantSlug);
      if (!report) {
        throw new Error("The diagnostic was submitted but no report link was returned.");
      }
      setLatest(report);
      setReports((current) => [report, ...current.filter((item) => item.id !== report.id)]);
      setAnswers({});
      setTaking(false);
      await loadReports();
    } catch (err) {
      setSubmitError(err.message || "Failed to submit diagnostic.");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div style={{ ...styles.page, ...(taking ? styles.pageTaking : {}) }}>
      <div style={styles.titleRow}>
        <div>
          <h1 style={styles.title}>Teacher diagnostic</h1>
          <p style={styles.muted}>
            Answer a few questions about your students and trip goals to receive your school-readiness report.
          </p>
        </div>
        <button type="button" onClick={() => { loadForm(); loadReports(); }} style={styles.secondary} disabled={formLoading || reportsLoading}>
          <RefreshCw size={15} /> Refresh
        </button>
      </div>

      {formError && (
        <div role="alert" style={styles.error}>
          {formError} <button type="button" onClick={loadForm} style={styles.inlineButton}>Try again</button>
        </div>
      )}
      {submitError && <div role="alert" style={styles.error}>{submitError}</div>}

      {formLoading ? (
        <section style={styles.card} aria-label="Loading diagnostic">
          <div style={styles.empty}><Loader2 size={18} style={styles.spin} /> Loading the current CRM diagnostic…</div>
        </section>
      ) : !formError && (
        <section style={{ ...styles.formCard, ...(taking ? styles.formCardTaking : {}) }} aria-labelledby="teacher-diagnostic-title">
          <div style={styles.diagnosticHeader}>
            <GraduationCap size={20} color="var(--tmc-primary)" />
            <div>
              <h2 id="teacher-diagnostic-title" style={styles.sectionTitle}>School readiness diagnostic</h2>
              <p style={styles.muted}>Tell us what matters most for your students and this trip.</p>
            </div>
          </div>
          {!taking ? (
            <div style={styles.diagnosticIntro}>
              <div>
                <strong style={styles.introTitle}>{latest ? "Your diagnostic is complete" : "Ready to begin?"}</strong>
                <p style={styles.introText}>
                  {latest ? "Retake the current CRM diagnostic whenever your school priorities change." : "Answer the questions to receive your school-readiness report."}
                </p>
              </div>
              <button
                type="button"
                onClick={() => {
                  setTaking(true);
                  setAnswers({});
                  setSubmitError("");
                }}
                style={styles.primary}
              >
                <ClipboardCheck size={16} /> {latest ? "Retake diagnostic" : "Take the diagnostic"}
              </button>
            </div>
          ) : (
            <div style={styles.questionScroll}>
              <div style={styles.formArea}>
                <DiagnosticFormRenderer
                  config={formConfig}
                  questions={questions}
                  answers={answers}
                  identity={identity}
                  onAnswerChange={setAnswer}
                  onToggleMulti={toggleMulti}
                  onSubmit={submit}
                  submitting={submitting}
                  submitError=""
                  submitLabel="Submit and view report"
                  preview
                  embedded
                  themeOverride={{
                    primaryColor: "var(--tmc-primary)",
                    bgColor: "transparent",
                    textColor: "var(--tmc-heading)",
                  }}
                  stylingOverride={{
                    questionCardStyle: "bordered",
                    questionBorderColor: "var(--tmc-border)",
                    questionBorderOpacity: 1,
                    questionBorderRadius: 12,
                    questionBackground: "var(--tmc-surface)",
                    questionCardShadow: "var(--tmc-question-shadow)",
                    questionOptionBackground: "var(--tmc-surface)",
                    questionOptionBorderColor: "var(--tmc-border-strong)",
                    questionOptionSelectedBackground: "var(--tmc-selected-bg)",
                    inputBackground: "var(--tmc-input-bg)",
                    inputBorderColor: "var(--tmc-border-strong)",
                    buttonTextColor: "var(--tmc-primary-contrast)",
                    questionCardMargin: "0 0 28px",
                    buttonBorderRadius: 8,
                  }}
                  secondaryAction={(
                    <button
                      type="button"
                      onClick={() => { setTaking(false); setSubmitError(""); }}
                      disabled={submitting}
                      style={styles.cancel}
                    >
                      <X size={15} aria-hidden />
                      Cancel
                    </button>
                  )}
                />
              </div>
            </div>
          )}
        </section>
      )}

      {!taking && latest && (
        <section style={styles.successCard} role="status">
          <div style={styles.cardHeading}><Award size={20} color="var(--tmc-primary)" /><strong>Your latest report is ready</strong></div>
          <p style={styles.muted}>Open the report to review the diagnostic recommendations, or download the PDF.</p>
          <div style={styles.inlineActions}>
            <a href={latest.reportUrl} style={styles.primaryLink}><ExternalLink size={15} /> View report</a>
            {latest.reportPdfUrl && <a href={latest.reportPdfUrl} target="_blank" rel="noreferrer" style={styles.secondaryLink}><Download size={15} /> Download PDF</a>}
          </div>
        </section>
      )}

      {!taking && (
      <section style={styles.card} aria-labelledby="teacher-report-history">
        <div style={styles.cardHeading}><Award size={19} color="var(--tmc-primary)" /><h2 id="teacher-report-history" style={styles.sectionTitle}>Previous reports</h2></div>
        {reportsLoading ? (
          <div style={styles.empty}><Loader2 size={18} style={styles.spin} /> Loading reports…</div>
        ) : reports.length === 0 ? (
          <div style={styles.empty}>No diagnostic reports yet. Complete the current CRM diagnostic above to create your first report.</div>
        ) : (
          <div style={styles.reportList}>
            {reports.map((report) => (
              <div key={report.id} style={styles.reportRow}>
                <div>
                  <strong>Readiness report #{report.id}</strong>
                  <div style={styles.muted}>{formatDate(report.createdAt)}{report.engineState ? ` · ${formatLabel(report.engineState)}` : ""}</div>
                </div>
                <div style={styles.inlineActions}>
                  {report.reportUrl && <a href={report.reportUrl} style={styles.textLink}>View</a>}
                  {report.reportPdfUrl && <a href={report.reportPdfUrl} target="_blank" rel="noreferrer" style={styles.textLink}>PDF</a>}
                </div>
              </div>
            ))}
          </div>
        )}
      </section>
      )}
    </div>
  );
}

function formatDate(value) {
  return value ? new Date(value).toLocaleString() : "Date unavailable";
}

function formatLabel(value) {
  return String(value).replace(/_/g, " ");
}

const styles = {
  page: { display: "grid", gap: 18 },
  pageTaking: { height: "100%", minHeight: 0, display: "flex", flexDirection: "column", overflow: "hidden" },
  titleRow: { display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 16, flexWrap: "wrap" },
  title: { margin: 0, fontSize: 26 },
  sectionTitle: { margin: 0, fontSize: 18 },
  muted: { color: "var(--tmc-muted)", fontSize: 13, lineHeight: 1.5 },
  card: { background: "var(--tmc-surface)", border: "1px solid var(--tmc-border)", borderRadius: 14, padding: 20 },
  formCard: { background: "var(--tmc-surface)", border: "1px solid var(--tmc-border)", borderRadius: 14, padding: 24, overflow: "hidden" },
  formCardTaking: { minHeight: 0, flex: "1 1 auto", display: "flex", flexDirection: "column" },
  cardHeading: { display: "flex", alignItems: "flex-start", gap: 8 },
  diagnosticHeader: { display: "flex", alignItems: "flex-start", gap: 10, paddingBottom: 22, borderBottom: "1px solid var(--tmc-border-light)", flexShrink: 0 },
  diagnosticIntro: { display: "flex", alignItems: "center", justifyContent: "space-between", gap: 18, marginTop: 22, padding: "20px 22px", border: "1px solid var(--tmc-border)", borderRadius: 12, background: "var(--tmc-surface-soft)", flexWrap: "wrap" },
  introTitle: { display: "block", color: "var(--tmc-heading)", fontSize: 15 },
  introText: { margin: "6px 0 0", color: "var(--tmc-muted)", fontSize: 13, lineHeight: 1.5 },
  questionScroll: { minHeight: 0, flex: "1 1 auto", overflowY: "auto", overflowX: "hidden", overscrollBehavior: "contain", padding: "0 2px 10px" },
  formArea: { marginTop: 26 },
  inlineActions: { display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" },
  primaryLink: { display: "inline-flex", alignItems: "center", gap: 7, borderRadius: 8, padding: "10px 13px", background: "var(--tmc-primary)", color: "var(--tmc-primary-contrast)", textDecoration: "none", fontWeight: 600, fontSize: 13 },
  secondaryLink: { display: "inline-flex", alignItems: "center", gap: 7, border: "1px solid var(--tmc-border-strong)", borderRadius: 8, padding: "9px 12px", background: "var(--tmc-surface)", color: "var(--tmc-subtle-text)", textDecoration: "none", fontWeight: 600, fontSize: 13 },
  textLink: { color: "var(--tmc-link)", fontWeight: 600, fontSize: 13, textDecoration: "none" },
  primary: { display: "inline-flex", alignItems: "center", justifyContent: "center", gap: 7, border: 0, borderRadius: 8, padding: "10px 14px", background: "var(--tmc-primary)", color: "var(--tmc-primary-contrast)", cursor: "pointer", fontWeight: 600, whiteSpace: "nowrap" },
  secondary: { display: "inline-flex", alignItems: "center", justifyContent: "center", gap: 7, border: "1px solid var(--tmc-border-strong)", borderRadius: 8, padding: "9px 12px", background: "var(--tmc-surface)", color: "var(--tmc-subtle-text)", cursor: "pointer", fontWeight: 600 },
  cancel: { display: "inline-flex", alignItems: "center", justifyContent: "center", gap: 7, minHeight: 41, border: "1px solid var(--tmc-border-strong)", borderRadius: 8, padding: "10px 14px", background: "var(--tmc-surface-soft)", color: "var(--tmc-subtle-text)", cursor: "pointer", fontWeight: 600, boxShadow: "0 1px 2px rgba(23, 43, 58, 0.06)" },
  inlineButton: { border: 0, background: "transparent", color: "inherit", textDecoration: "underline", cursor: "pointer", fontWeight: 600 },
  successCard: { background: "var(--tmc-success-bg)", border: "1px solid var(--tmc-success-text)", borderRadius: 14, padding: 20 },
  reportList: { display: "grid", gap: 4, marginTop: 14 },
  reportRow: { display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, padding: "12px 0", borderTop: "1px solid var(--tmc-border-light)" },
  empty: { display: "flex", alignItems: "center", justifyContent: "center", gap: 8, padding: "26px 10px", color: "var(--tmc-muted)", fontSize: 14, textAlign: "center" },
  error: { padding: "10px 12px", borderRadius: 8, background: "var(--tmc-error-bg)", color: "var(--tmc-error-text)", fontSize: 13 },
  spin: { animation: "spin 1s linear infinite" },
};
