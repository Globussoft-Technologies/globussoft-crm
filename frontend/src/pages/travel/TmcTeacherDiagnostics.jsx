import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Award,
  CheckCircle2,
  ClipboardCheck,
  Download,
  GraduationCap,
  Loader2,
  RefreshCw,
  X,
} from "lucide-react";
import DiagnosticSubmitOverlay from "../../components/travel/DiagnosticSubmitOverlay";

async function portalApi(path, token, options = {}) {
  const response = await fetch(`/api/portal/tmc${path}`, {
    method: options.method || "GET",
    headers: {
      Authorization: `Bearer ${token}`,
      ...(options.body ? { "Content-Type": "application/json" } : {}),
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw Object.assign(new Error(data.error || "Request failed"), {
      status: response.status,
    });
  }
  return data;
}

function questionField(question) {
  return question?.field || question?.id;
}

function emptyValue(value) {
  return (
    value == null ||
    (typeof value === "string" && value.trim() === "") ||
    (Array.isArray(value) && value.length === 0) ||
    (value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      Object.keys(value).length === 0)
  );
}

function normalizedType(question) {
  const type = String(question?.type || "single")
    .trim()
    .toLowerCase();
  if (
    [
      "multi",
      "multiple",
      "multi-select",
      "multi-choice",
      "multiple-choice",
      "checkbox",
      "checkboxes",
      "select-multiple",
    ].includes(type)
  )
    return "multi";
  if (["group", "fieldset", "object"].includes(type)) return "group";
  if (
    [
      "single",
      "single-choice",
      "single-mapped",
      "radio",
      "select",
      "dropdown",
      "select-one",
    ].includes(type)
  ) {
    return type === "single-mapped" ? "single-mapped" : "single";
  }
  if (
    [
      "text",
      "textarea",
      "email",
      "tel",
      "number",
      "date",
      "time",
      "url",
    ].includes(type)
  )
    return type;
  return "single";
}

function selectionLimit(question, key) {
  const value = question?.[key] ?? question?.[`${key}Selections`];
  if (value === "" || value == null) return null;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : null;
}

function inputType(type) {
  return ["email", "tel", "number", "date", "time", "url"].includes(type)
    ? type
    : "text";
}

function isTextType(type) {
  return [
    "text",
    "textarea",
    "email",
    "tel",
    "number",
    "date",
    "time",
    "url",
  ].includes(type);
}

function optionError(question, value, label) {
  const options = Array.isArray(question?.options) ? question.options : [];
  if (!options.length || emptyValue(value)) return "";
  const allowed = new Set(options.map((option) => String(option.value)));
  const values = Array.isArray(value) ? value : [value];
  return values.some((item) => !allowed.has(String(item)))
    ? `${label} contains an invalid option.`
    : "";
}

function validateSelection(question, value, label) {
  if (!Array.isArray(value) || value.length === 0) return "";
  const min = selectionLimit(question, "min");
  const max = selectionLimit(question, "max");
  if (min != null && value.length < min)
    return `${label} requires at least ${min} selection${min === 1 ? "" : "s"}.`;
  if (max != null && value.length > max)
    return `${label} allows at most ${max} selection${max === 1 ? "" : "s"}.`;
  return "";
}

function validateDynamicQuestion(question, value, label, isTopLevel) {
  const type = normalizedType(question);
  if (question.required && emptyValue(value))
    return isTopLevel ? `"${label}" is required.` : `${label} is required.`;
  if (type === "group") {
    const group =
      value && typeof value === "object" && !Array.isArray(value) ? value : {};
    for (const child of question.fields || []) {
      const childError = validateDynamicQuestion(
        child,
        group[child.id],
        child.label || child.id,
        false,
      );
      if (childError) return childError;
    }
    return "";
  }
  if (type === "multi") {
    const selectionError = validateSelection(question, value, label);
    if (selectionError) return selectionError;
  }
  if (
    type === "email" &&
    !emptyValue(value) &&
    !/^\S+@\S+\.\S+$/.test(String(value).trim())
  ) {
    return `${label} must be a valid email address.`;
  }
  return optionError(question, value, label);
}

function friendlyValidationMessage(question, value) {
  const type = normalizedType(question);
  if (type === "group") {
    if (question.required && emptyValue(value)) return "Please answer this question.";
    const group =
      value && typeof value === "object" && !Array.isArray(value) ? value : {};
    for (const child of question.fields || []) {
      const childMessage = friendlyValidationMessage(child, group[child.id]);
      if (childMessage) return childMessage;
    }
    return "";
  }
  if (type === "multi") {
    const selected = Array.isArray(value) ? value : [];
    const min = selectionLimit(question, "min");
    const max = selectionLimit(question, "max");
    if (min != null && selected.length < min)
      return `You need to choose at least ${min} option${min === 1 ? "" : "s"}.`;
    if (max != null && selected.length > max)
      return `You can choose at most ${max} option${max === 1 ? "" : "s"}.`;
  }
  if (question.required && emptyValue(value)) return "Please answer this question.";
  if (
    type === "email" &&
    !emptyValue(value) &&
    !/^\S+@\S+\.\S+$/.test(String(value).trim())
  ) {
    return "Please enter a valid email address.";
  }
  if (optionError(question, value, "This answer"))
    return "Please choose one of the available options.";
  return "";
}

function selectionGuidanceMessage(question, value) {
  if (normalizedType(question) !== "multi") return "";
  const min = selectionLimit(question, "min");
  const selected = Array.isArray(value) ? value : [];
  if (min == null || selected.length >= min) return "";
  return `Choose at least ${min} option${min === 1 ? "" : "s"}.`;
}

function validateDynamicAnswers(questions, answers) {
  for (const question of questions) {
    const field = questionField(question);
    const validationError = validateDynamicQuestion(
      question,
      answers[field],
      question.text || field,
      true,
    );
    if (validationError) return validationError;
  }
  return "";
}

function readContact(contact, fields = []) {
  const values = {
    contact_name: contact?.name || "",
    email: contact?.email || "",
    phone: contact?.phone || "",
  };
  if (!fields.length) return values;
  return fields.reduce((result, field) => {
    if (field?.id) result[field.id] = values[field.id] || "";
    return result;
  }, {});
}

function reportFromResult(result) {
  if (!result?.id && !result?.diagnosticId) return null;
  const id = result.id || result.diagnosticId;
  return {
    id,
    engineState: result.engineState || null,
    classificationLabel: result.classificationLabel || "Routed by TMC Engine",
    recommendedTier: result.recommendedTier || "engine",
    createdAt: result.createdAt || new Date().toISOString(),
    recommendations: Array.isArray(result.recommendations)
      ? result.recommendations.map((recommendation) => ({
          ...recommendation,
          driveLink:
            recommendation.driveLink ||
            recommendation.brochurePdfUrl ||
            recommendation.driveViewLink ||
            "",
        }))
      : [],
    chosenInterests: result.chosenInterests || null,
    reportPdfUrl: result.reportPdfUrl || null,
    reportReady:
      result.reportReady === true || Boolean(result.reportPdfUrl),
  };
}

function formatDate(value) {
  return value ? new Date(value).toLocaleString() : "Date unavailable";
}

function formatLabel(value) {
  return String(value || "").replace(/_/g, " ");
}

export default function TmcTeacherDiagnostics({
  token,
  contact,
  onSessionExpired,
}) {
  const [questions, setQuestions] = useState([]);
  const [formLoading, setFormLoading] = useState(true);
  const [formError, setFormError] = useState("");
  const [answers, setAnswers] = useState({});
  const [reports, setReports] = useState([]);
  const [reportsLoading, setReportsLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState("");
  const [validationAttempted, setValidationAttempted] = useState(false);
  const [touchedFields, setTouchedFields] = useState(() => new Set());
  const [latest, setLatest] = useState(null);
  const [taking, setTaking] = useState(false);
  const [selectedNames, setSelectedNames] = useState(() => new Set());
  const [interestsSubmitting, setInterestsSubmitting] = useState(false);
  const [interestsSubmittedAt, setInterestsSubmittedAt] = useState(null);
  const [interestsError, setInterestsError] = useState("");

  const loadForm = useCallback(async () => {
    setFormLoading(true);
    setFormError("");
    try {
      const result = await portalApi("/teacher/diagnostic", token);
      setQuestions(Array.isArray(result.questions) ? result.questions : []);
    } catch (err) {
      if ([401, 403, 404].includes(err.status)) onSessionExpired(err.message);
      else setFormError(err.message || "Failed to load the TMC diagnostic.");
    } finally {
      setFormLoading(false);
    }
  }, [onSessionExpired, token]);

  const loadReports = useCallback(async () => {
    setReportsLoading(true);
    try {
      const result = await portalApi("/teacher/diagnostics", token);
      setReports(Array.isArray(result.diagnostics) ? result.diagnostics : []);
    } catch (err) {
      if ([401, 403, 404].includes(err.status)) onSessionExpired(err.message);
      else setSubmitError(err.message || "Failed to load diagnostic reports.");
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

  useEffect(() => {
    const contactQuestion = questions.find(
      (question) => questionField(question) === "contact",
    );
    if (!contactQuestion) return;
    const fields = Array.isArray(contactQuestion.fields)
      ? contactQuestion.fields
      : [];
    setAnswers((current) => ({
      ...current,
      contact: { ...readContact(contact, fields), ...(current.contact || {}) },
    }));
  }, [contact, questions]);

  const recommendations = useMemo(
    () =>
      Array.isArray(latest?.recommendations) ? latest.recommendations : [],
    [latest?.recommendations],
  );
  const groupedRecommendations = useMemo(
    () =>
      recommendations.reduce((groups, recommendation) => {
        const category =
          String(recommendation.category || "Recommended trips").trim() ||
          "Recommended trips";
        if (!groups[category]) groups[category] = [];
        groups[category].push(recommendation);
        return groups;
      }, {}),
    [recommendations],
  );
  const interestsComplete =
    Boolean(latest?.reportReady) || Boolean(interestsSubmittedAt);

  const markFieldTouched = (field) => {
    setTouchedFields((current) => {
      if (current.has(field)) return current;
      return new Set([...current, field]);
    });
  };

  const setGroupField = (field, subField, value) => {
    markFieldTouched(field);
    setAnswers((current) => ({
      ...current,
      [field]: { ...(current[field] || {}), [subField]: value },
    }));
  };

  const setAnswer = (field, value) => {
    markFieldTouched(field);
    setAnswers((current) => ({ ...current, [field]: value }));
  };

  const toggleMulti = (field, value, max) => {
    markFieldTouched(field);
    setAnswers((current) => {
      const selected = Array.isArray(current[field]) ? current[field] : [];
      if (selected.includes(value))
        return {
          ...current,
          [field]: selected.filter((item) => item !== value),
        };
      if (max != null && selected.length >= max) return current;
      return { ...current, [field]: [...selected, value] };
    });
  };

  const selectOption = (question, option) => {
    const field = questionField(question);
    markFieldTouched(field);
    setAnswers((current) => {
      const next = { ...current, [field]: option.value };
      if (option.mappedSkill) next[`${field}_skill`] = option.mappedSkill;
      else delete next[`${field}_skill`];
      return next;
    });
  };

  const buildAnswersPayload = () => {
    const out = {};
    for (const question of questions) {
      const field = questionField(question);
      const value = answers[field];
      if (value == null) continue;
      const type = normalizedType(question);
      if (type === "multi") {
        if (Array.isArray(value) && value.length) out[field] = value;
      } else if (type === "group") {
        if (value && typeof value === "object" && Object.keys(value).length) {
          const configuredFields = Array.isArray(question.fields)
            ? question.fields
            : [];
          out[field] = configuredFields.reduce((group, child) => {
            if (Object.prototype.hasOwnProperty.call(value, child.id))
              group[child.id] = value[child.id];
            return group;
          }, {});
        }
      } else if (!emptyValue(value)) {
        out[field] = value;
        if (type === "single-mapped" && answers[`${field}_skill`])
          out[`${field}_skill`] = answers[`${field}_skill`];
      }
    }
    return out;
  };

  const startDiagnostic = () => {
    setLatest(null);
    const contactQuestion = questions.find(
      (question) => questionField(question) === "contact",
    );
    const fields = Array.isArray(contactQuestion?.fields)
      ? contactQuestion.fields
      : [];
    setAnswers((current) =>
      contactQuestion
        ? {
            ...current,
            contact: {
              ...readContact(contact, fields),
              ...(current.contact || {}),
            },
          }
        : current,
    );
    setSelectedNames(new Set());
    setInterestsSubmittedAt(null);
    setInterestsError("");
    setSubmitError("");
    setValidationAttempted(false);
    setTouchedFields(new Set());
    setTaking(true);
  };

  const submit = async () => {
    setSubmitError("");
    setValidationAttempted(true);
    const payload = buildAnswersPayload();
    const validationError = validateDynamicAnswers(questions, payload);
    if (validationError) return;
    setSubmitting(true);
    try {
      const result = await portalApi("/teacher/diagnostics", token, {
        method: "POST",
        body: { answers: payload },
      });
      const report = reportFromResult(result);
      if (!report)
        throw new Error(
          "The diagnostic was submitted but no report was returned.",
        );
      setLatest(report);
      setReports((current) => [
        report,
        ...current.filter((item) => item.id !== report.id),
      ]);
      setTaking(false);
      setSelectedNames(new Set());
      setInterestsSubmittedAt(null);
      setInterestsError("");
      setValidationAttempted(false);
      setTouchedFields(new Set());
      await loadReports();
    } catch (err) {
      if ([401, 403, 404].includes(err.status)) onSessionExpired(err.message);
      else setSubmitError(err.message || "Failed to submit diagnostic.");
    } finally {
      setSubmitting(false);
    }
  };

  const openReport = async (report) => {
    setSubmitError("");
    try {
      const result = await portalApi(
        `/teacher/diagnostics/${report.id}`,
        token,
      );
      const detail = reportFromResult(result.diagnostic);
      setLatest(detail);
      const prior = detail?.chosenInterests?.interests || [];
      setSelectedNames(new Set(prior.map((interest) => interest.name)));
      setInterestsSubmittedAt(detail?.chosenInterests?.submittedAt || null);
      setInterestsError("");
      setTaking(false);
    } catch (err) {
      if ([401, 403, 404].includes(err.status)) onSessionExpired(err.message);
      else
        setSubmitError(err.message || "Failed to load the diagnostic report.");
    }
  };

  const toggleRecommendation = (name) => {
    setSelectedNames((current) => {
      const next = new Set(current);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
    setInterestsError("");
  };

  const saveInterests = async () => {
    const chosen = recommendations
      .filter((recommendation) => selectedNames.has(recommendation.name))
      .map((recommendation) => ({
        name: recommendation.name,
        driveLink: recommendation.driveLink || "",
      }));
    if (!chosen.length || !latest?.id) return;
    setInterestsSubmitting(true);
    setInterestsError("");
    try {
      const result = await portalApi(
        `/teacher/diagnostics/${latest.id}/interests`,
        token,
        { method: "POST", body: { interests: chosen } },
      );
      setInterestsSubmittedAt(result.submittedAt || new Date().toISOString());
      setLatest((current) => ({
        ...current,
        chosenInterests: result,
        reportReady: result.reportReady === true || Boolean(result.reportPdfUrl),
        reportPdfUrl: result.reportPdfUrl || current?.reportPdfUrl || null,
      }));
    } catch (err) {
      if ([401, 403, 404].includes(err.status)) onSessionExpired(err.message);
      else
        setInterestsError(err.message || "Failed to save your trip choices.");
    } finally {
      setInterestsSubmitting(false);
    }
  };

  return (
    <div style={{ ...styles.page, ...(taking ? styles.pageTaking : {}) }}>
      <DiagnosticSubmitOverlay
        active={submitting}
        primaryColor="var(--tmc-primary, #365d7a)"
      />
      <div style={styles.titleRow}>
        <div>
          <h1 style={styles.title}>Teacher diagnostic</h1>
          <p style={styles.muted}>
            Answer a few questions about your students and trip goals to receive
            your school-readiness report.
          </p>
        </div>
        <button
          type="button"
          onClick={() => {
            loadForm();
            loadReports();
          }}
          style={styles.secondary}
          disabled={formLoading || reportsLoading}
        >
          <RefreshCw size={15} /> Refresh
        </button>
      </div>

      {formError && (
        <div role="alert" style={styles.error}>
          {formError}{" "}
          <button type="button" onClick={loadForm} style={styles.inlineButton}>
            Try again
          </button>
        </div>
      )}
      {submitError && !taking && (
        <div role="alert" style={styles.error}>
          {submitError}
        </div>
      )}
      {formLoading ? (
        <section style={styles.card} aria-label="Loading diagnostic">
          <div style={styles.empty}>
            <Loader2 size={18} style={styles.spin} /> Loading the current TMC
            diagnostic...
          </div>
        </section>
      ) : (
        !formError && (
          <section
            style={{
              ...styles.formCard,
              ...(taking ? styles.formCardTaking : {}),
            }}
            aria-labelledby="teacher-diagnostic-title"
          >
            <div style={styles.diagnosticHeader}>
              <GraduationCap size={20} color="var(--tmc-primary)" />
              <div>
                <h2 id="teacher-diagnostic-title" style={styles.sectionTitle}>
                  School readiness diagnostic
                </h2>
                <p style={styles.muted}>
                  Tell us what matters most for your students and this trip.
                </p>
              </div>
            </div>
            {taking && submitError && (
              <div
                id="teacher-diagnostic-error"
                role="alert"
                style={styles.formError}
              >
                {submitError}
              </div>
            )}
            {!taking && !latest && (
              <div style={styles.diagnosticIntro}>
                <div>
                  <strong style={styles.introTitle}>Ready to begin?</strong>
                  <p style={styles.introText}>
                    Answer the questions to receive your school-readiness
                    report.
                  </p>
                </div>
                <button
                  type="button"
                  onClick={startDiagnostic}
                  style={styles.primary}
                >
                  <ClipboardCheck size={16} /> Take the diagnostic
                </button>
              </div>
            )}
            {taking && (
              <NativeQuestionForm
                questions={questions}
                answers={answers}
                submitting={submitting}
                onSelect={selectOption}
                onToggleMulti={toggleMulti}
                onAnswerChange={setAnswer}
                onGroupField={setGroupField}
                validationAttempted={validationAttempted}
                touchedFields={touchedFields}
                onSubmit={submit}
                onCancel={() => {
                  setTaking(false);
                  setSubmitError("");
                  setValidationAttempted(false);
                  setTouchedFields(new Set());
                }}
              />
            )}
          </section>
        )
      )}

      {!taking && latest && (
        <NativeDiagnosticResult
          latest={latest}
          recommendations={recommendations}
          groupedRecommendations={groupedRecommendations}
          selectedNames={selectedNames}
          interestsComplete={interestsComplete}
          interestsSubmitting={interestsSubmitting}
          interestsSubmittedAt={interestsSubmittedAt}
          interestsError={interestsError}
          onToggle={toggleRecommendation}
          onSave={saveInterests}
          onRetake={startDiagnostic}
        />
      )}

      {!taking && (
        <section style={styles.card} aria-labelledby="teacher-report-history">
          <div style={styles.cardHeading}>
            <Award size={19} color="var(--tmc-primary)" />
            <h2 id="teacher-report-history" style={styles.sectionTitle}>
              Previous reports
            </h2>
          </div>
          {reportsLoading ? (
            <div style={styles.empty}>
              <Loader2 size={18} style={styles.spin} /> Loading reports...
            </div>
          ) : reports.length === 0 ? (
            <div style={styles.empty}>
              No diagnostic reports yet. Complete the current TMC diagnostic
              above to create your first report.
            </div>
          ) : (
            <div style={styles.reportList}>
              {reports.map((report) => (
                <div key={report.id} style={styles.reportRow}>
                  <div>
                    <strong>Readiness report #{report.id}</strong>
                    <div style={styles.muted}>
                      {formatDate(report.createdAt)}
                      {report.engineState
                        ? ` · ${formatLabel(report.engineState)}`
                        : ""}
                    </div>
                  </div>
                  <div style={styles.inlineActions}>
                    <button
                      type="button"
                      onClick={() => openReport(report)}
                      style={styles.textButton}
                    >
                      View trips
                    </button>
                    {report.reportPdfUrl && (
                      <a
                        href={report.reportPdfUrl}
                        target="_blank"
                        rel="noreferrer"
                        style={styles.textLink}
                      >
                        PDF
                      </a>
                    )}
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

function NativeQuestionForm({
  questions,
  answers,
  submitting,
  onSelect,
  onToggleMulti,
  onAnswerChange,
  onGroupField,
  validationAttempted,
  touchedFields,
  onSubmit,
  onCancel,
}) {
  return (
    <>
      <div style={styles.formSummary}>
        <strong>Complete the questions below</strong>
        <span>{questions.length} questions</span>
      </div>
      <div
        style={styles.wizard}
        data-testid="teacher-diagnostic-question-scroll"
      >
        <div style={styles.questionList}>
          {questions.map((question, index) => (
            <NativeQuestionBlock
              key={question.id || question.field || index}
              question={question}
              answers={answers}
              onSelect={onSelect}
              onToggleMulti={onToggleMulti}
              onAnswerChange={onAnswerChange}
              onGroupField={onGroupField}
              showValidation={
                validationAttempted || touchedFields.has(questionField(question))
              }
            />
          ))}
        </div>
        <nav style={styles.wizardNav} aria-label="Diagnostic actions">
          <button
            type="button"
            onClick={onSubmit}
            disabled={submitting}
            style={styles.primary}
          >
            {submitting ? (
              <>
                <Loader2 size={16} style={styles.spin} /> Analyzing...
              </>
            ) : (
              <>
                <ClipboardCheck size={16} /> Complete diagnostic
              </>
            )}
          </button>
          <button
            type="button"
            onClick={onCancel}
            disabled={submitting}
            style={styles.cancel}
          >
            <X size={15} /> Cancel
          </button>
        </nav>
        <p style={styles.fineprint}>
          <CheckCircle2 size={12} /> Your answers stay inside the teacher portal
          and are only saved when you complete the diagnostic.
        </p>
      </div>
    </>
  );
}

function NativeQuestionBlock({
  question,
  answers,
  onSelect,
  onToggleMulti,
  onAnswerChange,
  onGroupField,
  showValidation,
}) {
  const field = questionField(question);
  const value = answers[field];
  const type = normalizedType(question);
  const options = Array.isArray(question.options) ? question.options : [];
  const validationMessage = showValidation
    ? friendlyValidationMessage(question, value)
    : selectionGuidanceMessage(question, value);
  const validationIsActive = showValidation && Boolean(validationMessage);
  return (
    <section
      style={styles.questionCard}
      aria-labelledby={`teacher-question-${question.id || field}`}
    >
      <h3
        id={`teacher-question-${question.id || field}`}
        style={styles.questionTitle}
      >
        {question.text}
        {question.required && <span aria-hidden> *</span>}
      </h3>
      {question.helper && <p style={styles.helper}>{question.helper}</p>}
      {type === "group" ? (
        <GroupFields
          question={question}
          value={value || {}}
          onChange={onGroupField}
        />
      ) : type === "multi" ? (
        <div style={styles.optionGrid}>
          {options.map((option) => {
            const selected = Array.isArray(value) ? value : [];
            const checked = selected.includes(option.value);
            const max = selectionLimit(question, "max");
            const disabled = !checked && max != null && selected.length >= max;
            return (
              <label
                key={option.value}
                style={{
                  ...styles.optionRow,
                  ...(checked ? styles.optionSelected : {}),
                  opacity: disabled ? 0.55 : 1,
                }}
              >
                <input
                  type="checkbox"
                  checked={checked}
                  disabled={disabled}
                  onChange={() => onToggleMulti(field, option.value, max)}
                />
                {option.label}
              </label>
            );
          })}
        </div>
      ) : isTextType(type) ? (
        <DynamicInput
          field={question}
          value={value}
          onChange={(nextValue) => onAnswerChange(field, nextValue)}
        />
      ) : options.length > 0 ? (
        <div role="radiogroup" style={styles.optionGrid}>
          {options.map((option) => {
            const checked = value === option.value;
            return (
              <label
                key={option.value}
                style={{
                  ...styles.optionRow,
                  ...(checked ? styles.optionSelected : {}),
                }}
              >
                <input
                  type="radio"
                  name={field}
                  checked={checked}
                  onChange={() => onSelect(question, option)}
                />
                {option.label}
              </label>
            );
          })}
        </div>
      ) : null}
      {validationMessage && (
        <p
          role={validationIsActive ? "alert" : undefined}
          style={
            validationIsActive
              ? styles.questionError
              : styles.questionGuidance
          }
        >
          {validationIsActive ? "* " : ""}
          {validationIsActive ? validationMessage : selectionGuidanceMessage(question, value)}
        </p>
      )}
    </section>
  );
}

function GroupFields({ question, value, onChange }) {
  return (
    <div style={styles.groupGrid}>
      {(question.fields || []).map((field) => {
        const fieldType = normalizedType(field);
        const fieldValue = value[field.id];
        if (fieldType === "single" || fieldType === "single-mapped") {
          return (
            <fieldset key={field.id} style={styles.groupFieldset}>
              <legend style={styles.groupLegend}>
                {field.label}
                {field.required && " *"}
              </legend>
              {field.helper && <p style={styles.helper}>{field.helper}</p>}
              <div role="radiogroup" style={styles.optionGrid}>
                {(field.options || []).map((option) => (
                  <label
                    key={option.value}
                    style={{
                      ...styles.optionRow,
                      ...(fieldValue === option.value
                        ? styles.optionSelected
                        : {}),
                    }}
                  >
                    <input
                      type="radio"
                      name={`${questionField(question)}-${field.id}`}
                      checked={fieldValue === option.value}
                      onChange={() =>
                        onChange(
                          questionField(question),
                          field.id,
                          option.value,
                        )
                      }
                    />
                    {option.label}
                  </label>
                ))}
              </div>
            </fieldset>
          );
        }
        if (fieldType === "multi") {
          const selected = Array.isArray(fieldValue) ? fieldValue : [];
          const max = selectionLimit(field, "max");
          return (
            <fieldset key={field.id} style={styles.groupFieldset}>
              <legend style={styles.groupLegend}>
                {field.label}
                {field.required && " *"}
              </legend>
              {field.helper && <p style={styles.helper}>{field.helper}</p>}
              <div style={styles.optionGrid}>
                {(field.options || []).map((option) => {
                  const checked = selected.includes(option.value);
                  const disabled =
                    !checked && max != null && selected.length >= max;
                  const next = checked
                    ? selected.filter((item) => item !== option.value)
                    : [...selected, option.value];
                  return (
                    <label
                      key={option.value}
                      style={{
                        ...styles.optionRow,
                        ...(checked ? styles.optionSelected : {}),
                        opacity: disabled ? 0.55 : 1,
                      }}
                    >
                      <input
                        type="checkbox"
                        checked={checked}
                        disabled={disabled}
                        onChange={() =>
                          onChange(questionField(question), field.id, next)
                        }
                      />
                      {option.label}
                    </label>
                  );
                })}
              </div>
            </fieldset>
          );
        }
        return (
          <DynamicInput
            key={field.id}
            field={field}
            value={fieldValue}
            onChange={(nextValue) =>
              onChange(questionField(question), field.id, nextValue)
            }
          />
        );
      })}
    </div>
  );
}

function DynamicInput({ field, value, onChange }) {
  const type = normalizedType(field);
  const label = field.label || field.text || "Answer";
  const commonProps = {
    value: value ?? "",
    onChange: (event) => onChange(event.target.value),
    style: styles.input,
    "aria-label": label,
    required: Boolean(field.required),
  };
  return (
    <label style={styles.fieldLabel}>
      <span>
        {field.label ? `${field.label}${field.required ? " *" : ""}` : ""}
      </span>
      {type === "textarea" ? (
        <textarea {...commonProps} rows={4} />
      ) : (
        <input {...commonProps} type={inputType(type)} />
      )}
    </label>
  );
}

function NativeDiagnosticResult({
  latest,
  recommendations,
  groupedRecommendations,
  selectedNames,
  interestsComplete,
  interestsSubmitting,
  interestsSubmittedAt,
  interestsError,
  onToggle,
  onSave,
  onRetake,
}) {
  return (
    <section
      style={styles.resultStack}
      aria-labelledby="teacher-diagnostic-result"
    >
      <section style={styles.successCard} role="status">
        <div style={styles.cardHeading}>
          <Award size={20} color="var(--tmc-primary)" />
          <div>
            <strong id="teacher-diagnostic-result">
              {interestsComplete
                ? "Your readiness report is ready"
                : "Your trip recommendations are ready"}
            </strong>
            {interestsComplete && <div style={styles.muted}>
              {latest.classificationLabel} · {formatLabel(latest.engineState)}
            </div>}
          </div>
        </div>
        <p style={styles.muted}>
          {interestsComplete
            ? "Your selected trips have been saved in this teacher portal."
            : "Choose the trip options you want to discuss with the travel team, then submit your choices to receive the readiness report."}
        </p>
      </section>
      {recommendations.length > 0 ? (
        <section
          style={styles.card}
          aria-labelledby="teacher-trip-choice-heading"
        >
          <div style={styles.cardHeading}>
            <ClipboardCheck size={19} color="var(--tmc-primary)" />
            <div>
              <h2 id="teacher-trip-choice-heading" style={styles.sectionTitle}>
                Recommended trips for your school
              </h2>
              <p style={styles.muted}>
                Select the trips you are actually interested in.
              </p>
            </div>
          </div>
          <div style={styles.recommendationGroups}>
            {Object.entries(groupedRecommendations).map(
              ([category, categoryRecommendations]) => (
                <div key={category}>
                  <h3 style={styles.categoryTitle}>{category}</h3>
                  <div style={styles.recommendationList}>
                    {categoryRecommendations.map((recommendation) => (
                      <label
                        key={recommendation.name}
                        style={{
                          ...styles.tripCard,
                          ...(selectedNames.has(recommendation.name)
                            ? styles.tripSelected
                            : {}),
                        }}
                      >
                        <input
                          type="checkbox"
                          checked={selectedNames.has(recommendation.name)}
                          onChange={() => onToggle(recommendation.name)}
                          aria-label={`I'm interested in ${recommendation.name}`}
                        />
                        <div style={styles.tripBody}>
                          <strong>{recommendation.name}</strong>
                          {recommendation.summary && (
                            <p style={styles.tripSummary}>
                              {recommendation.summary}
                            </p>
                          )}
                          {Array.isArray(recommendation.learnings) &&
                            recommendation.learnings.length > 0 && (
                              <ul style={styles.learnings}>
                                {recommendation.learnings.map(
                                  (learning, index) => (
                                    <li key={index}>{learning}</li>
                                  ),
                                )}
                              </ul>
                            )}
                          {recommendation.driveLink && (
                            <a
                              href={recommendation.driveLink}
                              target="_blank"
                              rel="noopener noreferrer"
                              onClick={(event) => event.stopPropagation()}
                              style={styles.brochureLink}
                            >
                              View brochure
                            </a>
                          )}
                        </div>
                      </label>
                    ))}
                  </div>
                </div>
              ),
            )}
          </div>
          <div style={styles.choiceFooter}>
            {!interestsComplete && (
              <button
                type="button"
                onClick={onSave}
                disabled={!selectedNames.size || interestsSubmitting}
                style={styles.primary}
              >
                {interestsSubmitting
                  ? "Saving..."
                  : `Submit chosen interests (${selectedNames.size})`}
              </button>
            )}
            {interestsSubmittedAt && (
              <span role="status" style={styles.completeMessage}>
                <CheckCircle2 size={15} /> Trip choices saved. You can update
                them anytime.
              </span>
            )}
            {interestsError && (
              <span role="alert" style={styles.interestsError}>
                {interestsError}
              </span>
            )}
          </div>
        </section>
      ) : (
        <section style={styles.card}>
          <div style={styles.empty}>
            No matching trips were found. Your diagnostic has been recorded and
            the travel team can follow up with you.
          </div>
        </section>
      )}
      <section style={styles.downloadCard}>
        <div>
          <strong>
            {interestsComplete
              ? "Diagnostic complete"
              : "Choose trips to receive your report"}
          </strong>
          <p style={styles.muted}>
            {interestsComplete
              ? "Download the PDF report for your school records."
              : "Your readiness report will be available after you submit your trip choices."}
          </p>
        </div>
        <div style={styles.inlineActions}>
          {interestsComplete && latest.reportPdfUrl && (
            <a
              href={latest.reportPdfUrl}
              target="_blank"
              rel="noreferrer"
              style={styles.primaryLink}
            >
              <Download size={15} /> Download report PDF
            </a>
          )}
          <button type="button" onClick={onRetake} style={styles.secondary}>
            <RefreshCw size={15} /> Retake diagnostic
          </button>
        </div>
      </section>
    </section>
  );
}

const styles = {
  page: { display: "grid", gap: 18 },
  pageTaking: {
    height: "100%",
    minHeight: 0,
    gridTemplateRows: "auto minmax(0, 1fr)",
  },
  titleRow: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "flex-start",
    gap: 16,
    flexWrap: "wrap",
  },
  title: { margin: 0, fontSize: 26 },
  sectionTitle: { margin: 0, fontSize: 18 },
  muted: { color: "var(--tmc-muted)", fontSize: 13, lineHeight: 1.5 },
  card: {
    background: "var(--tmc-surface)",
    border: "1px solid var(--tmc-border)",
    borderRadius: 14,
    padding: 20,
  },
  formCard: {
    background: "var(--tmc-surface)",
    border: "1px solid var(--tmc-border)",
    borderRadius: 14,
    padding: 24,
    overflow: "hidden",
  },
  formCardTaking: { minHeight: 0, display: "flex", flexDirection: "column" },
  cardHeading: { display: "flex", alignItems: "flex-start", gap: 8 },
  diagnosticHeader: {
    display: "flex",
    alignItems: "flex-start",
    gap: 10,
    paddingBottom: 22,
    borderBottom: "1px solid var(--tmc-border-light)",
  },
  diagnosticIntro: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 18,
    marginTop: 22,
    padding: "20px 22px",
    border: "1px solid var(--tmc-border)",
    borderRadius: 12,
    background: "var(--tmc-surface-soft)",
    flexWrap: "wrap",
  },
  introTitle: { display: "block", color: "var(--tmc-heading)", fontSize: 15 },
  introText: {
    margin: "6px 0 0",
    color: "var(--tmc-muted)",
    fontSize: 13,
    lineHeight: 1.5,
  },
  primary: {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    gap: 7,
    border: 0,
    borderRadius: 8,
    padding: "10px 14px",
    background: "var(--tmc-primary)",
    color: "var(--tmc-primary-contrast)",
    cursor: "pointer",
    fontWeight: 600,
    whiteSpace: "nowrap",
  },
  primaryLink: {
    display: "inline-flex",
    alignItems: "center",
    gap: 7,
    borderRadius: 8,
    padding: "10px 13px",
    background: "var(--tmc-primary)",
    color: "var(--tmc-primary-contrast)",
    textDecoration: "none",
    fontWeight: 600,
    fontSize: 13,
  },
  secondary: {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    gap: 7,
    border: "1px solid var(--tmc-border-strong)",
    borderRadius: 8,
    padding: "9px 12px",
    background: "var(--tmc-surface)",
    color: "var(--tmc-subtle-text)",
    cursor: "pointer",
    fontWeight: 600,
  },
  cancel: {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    gap: 7,
    border: "1px solid var(--tmc-border-strong)",
    borderRadius: 8,
    padding: "9px 12px",
    background: "var(--tmc-surface-soft)",
    color: "var(--tmc-subtle-text)",
    cursor: "pointer",
    fontWeight: 600,
  },
  inlineButton: {
    border: 0,
    background: "transparent",
    color: "inherit",
    textDecoration: "underline",
    cursor: "pointer",
    fontWeight: 600,
  },
  wizard: {
    minHeight: 0,
    flex: "1 1 0",
    marginTop: 0,
    display: "flex",
    flexDirection: "column",
    overflowY: "auto",
    paddingRight: 6,
  },
  formSummary: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    gap: 12,
    marginTop: 22,
    marginBottom: 14,
    color: "var(--tmc-heading)",
    fontSize: 14,
  },
  questionList: { display: "grid", gap: 14, paddingBottom: 4 },
  questionCard: {
    background: "var(--tmc-surface)",
    border: "1px solid var(--tmc-border)",
    borderRadius: 12,
    padding: 20,
    boxShadow: "var(--tmc-question-shadow)",
  },
  questionTitle: {
    margin: 0,
    color: "var(--tmc-heading)",
    fontSize: 18,
    lineHeight: 1.4,
  },
  helper: { color: "var(--tmc-muted)", fontSize: 13, lineHeight: 1.5 },
  questionError: {
    margin: "10px 0 0",
    color: "var(--tmc-error-text)",
    fontSize: 13,
    lineHeight: 1.4,
  },
  questionGuidance: {
    margin: "10px 0 0",
    color: "var(--tmc-muted)",
    fontSize: 13,
    lineHeight: 1.4,
  },
  optionGrid: { display: "grid", gap: 8, marginTop: 16 },
  optionRow: {
    display: "flex",
    alignItems: "center",
    gap: 10,
    padding: "13px 14px",
    border: "1px solid var(--tmc-border-strong)",
    borderRadius: 8,
    background: "var(--tmc-input-bg)",
    color: "var(--tmc-text)",
    cursor: "pointer",
    fontSize: 14,
  },
  optionSelected: {
    borderColor: "var(--tmc-primary)",
    background: "var(--tmc-selected-bg)",
  },
  wizardNav: {
    display: "flex",
    alignItems: "center",
    gap: 10,
    flexWrap: "wrap",
    marginTop: 16,
  },
  fineprint: {
    display: "flex",
    alignItems: "center",
    gap: 5,
    color: "var(--tmc-muted)",
    fontSize: 12,
  },
  groupGrid: { display: "grid", gap: 16, marginTop: 16 },
  groupFieldset: { border: 0, padding: 0, margin: 0 },
  groupLegend: { color: "var(--tmc-heading)", fontWeight: 600, fontSize: 14 },
  fieldLabel: {
    display: "grid",
    gap: 6,
    color: "var(--tmc-heading)",
    fontSize: 13,
    fontWeight: 600,
  },
  input: {
    width: "100%",
    boxSizing: "border-box",
    padding: "10px 12px",
    border: "1px solid var(--tmc-border-strong)",
    borderRadius: 8,
    background: "var(--tmc-input-bg)",
    color: "var(--tmc-text)",
    font: "inherit",
  },
  successCard: {
    background: "var(--tmc-success-bg)",
    border: "1px solid var(--tmc-success-text)",
    borderRadius: 14,
    padding: 20,
  },
  resultStack: { display: "grid", gap: 18 },
  recommendationGroups: { display: "grid", gap: 18, marginTop: 18 },
  categoryTitle: {
    margin: 0,
    fontSize: 14,
    textTransform: "uppercase",
    letterSpacing: "0.04em",
    color: "var(--tmc-heading)",
  },
  recommendationList: { display: "grid", gap: 10, marginTop: 8 },
  tripCard: {
    display: "flex",
    alignItems: "flex-start",
    gap: 12,
    padding: 14,
    border: "1px solid var(--tmc-border)",
    borderRadius: 10,
    background: "var(--tmc-input-bg)",
    cursor: "pointer",
  },
  tripSelected: {
    borderColor: "var(--tmc-primary)",
    background: "var(--tmc-selected-bg)",
  },
  tripBody: { minWidth: 0, color: "var(--tmc-text)" },
  tripSummary: {
    margin: "6px 0 0",
    color: "var(--tmc-muted)",
    fontSize: 13,
    lineHeight: 1.5,
  },
  learnings: {
    margin: "8px 0 0",
    paddingLeft: 18,
    color: "var(--tmc-subtle-text)",
    fontSize: 13,
    lineHeight: 1.5,
  },
  brochureLink: {
    display: "inline-flex",
    marginTop: 10,
    color: "var(--tmc-link)",
    fontSize: 13,
    fontWeight: 700,
    textDecoration: "none",
  },
  choiceFooter: {
    display: "flex",
    alignItems: "center",
    gap: 12,
    flexWrap: "wrap",
    marginTop: 18,
  },
  completeMessage: {
    display: "inline-flex",
    alignItems: "center",
    gap: 5,
    color: "var(--tmc-success-text)",
    fontSize: 13,
  },
  interestsError: { color: "var(--tmc-error-text)", fontSize: 13 },
  downloadCard: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    gap: 16,
    flexWrap: "wrap",
    background: "var(--tmc-surface-soft)",
    border: "1px solid var(--tmc-border)",
    borderRadius: 14,
    padding: 20,
  },
  inlineActions: {
    display: "flex",
    alignItems: "center",
    gap: 10,
    flexWrap: "wrap",
  },
  textButton: {
    border: 0,
    padding: 0,
    background: "transparent",
    color: "var(--tmc-link)",
    cursor: "pointer",
    fontWeight: 600,
    fontSize: 13,
  },
  textLink: {
    color: "var(--tmc-link)",
    fontWeight: 600,
    fontSize: 13,
    textDecoration: "none",
  },
  reportList: { display: "grid", gap: 4, marginTop: 14 },
  reportRow: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    gap: 12,
    padding: "12px 0",
    borderTop: "1px solid var(--tmc-border-light)",
  },
  empty: {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    padding: "26px 10px",
    color: "var(--tmc-muted)",
    fontSize: 14,
    textAlign: "center",
  },
  error: {
    padding: "10px 12px",
    borderRadius: 8,
    background: "var(--tmc-error-bg)",
    color: "var(--tmc-error-text)",
    fontSize: 13,
  },
  formError: {
    padding: "10px 12px",
    borderRadius: 8,
    background: "var(--tmc-error-bg)",
    color: "var(--tmc-error-text)",
    fontSize: 13,
    display: "block",
    height: "auto",
    minHeight: 0,
    marginTop: 18,
    marginBottom: 0,
    boxSizing: "border-box",
    alignSelf: "stretch",
  },
  spin: { animation: "spin 1s linear infinite" },
};
