// Public branded diagnostic form for Travel CRM (v3.9.4).
//
// Lives at /diagnostic-form/:tenantSlug/:subBrand (no auth, renders outside
// AuthContext shell). Fetches the published form config + active question bank,
// then delegates all rendering to DiagnosticFormRenderer so the admin preview
// and the live form are pixel-identical.

import { useEffect, useState } from "react";
import { useParams, useNavigate } from "react-router-dom";
import DiagnosticFormRenderer, {
  DiagnosticFormLoading,
  DiagnosticFormError,
} from "../../components/travel/DiagnosticFormRenderer";

export default function TravelDiagnosticPublicForm() {
  const { tenantSlug, subBrand } = useParams();
  const navigate = useNavigate();

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [formConfig, setFormConfig] = useState(null);
  const [questions, setQuestions] = useState([]);
  const [answers, setAnswers] = useState({});
  const [identity, setIdentity] = useState({});
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState("");

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoading(true);
      setError("");
      try {
        const r = await fetch(
          `/api/travel/diagnostics/public/form/${encodeURIComponent(
            tenantSlug || "",
          )}/${encodeURIComponent(subBrand || "")}`,
        );
        if (!r.ok) {
          const body = await r.json().catch(() => ({}));
          throw new Error(
            body.error || "This diagnostic form is not available right now.",
          );
        }
        const data = await r.json();
        if (cancelled) return;
        setFormConfig(data);
        setQuestions(Array.isArray(data.questions) ? data.questions : []);
      } catch (e) {
        if (!cancelled) setError(e.message || "Failed to load form");
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    load();
    return () => {
      cancelled = true;
    };
  }, [tenantSlug, subBrand]);

  const setAnswer = (qid, value) => {
    setAnswers((prev) => ({ ...prev, [qid]: value }));
  };

  const toggleMulti = (qid, value, max) => {
    setAnswers((prev) => {
      const cur = Array.isArray(prev[qid]) ? prev[qid] : [];
      if (cur.includes(value)) {
        return { ...prev, [qid]: cur.filter((v) => v !== value) };
      }
      if (max && cur.length >= max) return prev;
      return { ...prev, [qid]: [...cur, value] };
    });
  };

  const findUnansweredRequired = () => {
    for (const q of questions) {
      if (!q.required) continue;
      const ans = answers[q.id];
      const empty =
        ans == null ||
        (typeof ans === "string" && ans.trim() === "") ||
        (Array.isArray(ans) && ans.length === 0);
      if (empty) return q;
    }
    return null;
  };

  const submit = async () => {
    setSubmitError("");
    const missing = findUnansweredRequired();
    if (missing) {
      setSubmitError(`Please answer "${missing.text}" before submitting — it's required.`);
      return;
    }
    const activeIdentityFields = Array.isArray(formConfig?.identityFields)
      ? formConfig.identityFields.filter((field) => field?.enabled !== false)
      : [];
    for (const field of activeIdentityFields) {
      const value = String(identity[field.id] || "").trim();
      let invalid = false;
      if (field.required && !value) invalid = true;
      if (value && field.minLength != null && value.length < Number(field.minLength)) invalid = true;
      if (value && field.maxLength != null && value.length > Number(field.maxLength)) invalid = true;
      if (value && field.type === "email" && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) invalid = true;
      if (value && field.type === "tel") {
        const digits = value.replace(/\D/g, "");
        if (!/^\+?[0-9][0-9\s().-]+$/.test(value) || digits.length < 10 || digits.length > 15) invalid = true;
      }
      if (value && field.type === "url") {
        try {
          const url = new URL(value);
          if (!['http:', 'https:'].includes(url.protocol)) invalid = true;
        } catch { invalid = true; }
      }
      if (value && field.type === "number" && !Number.isFinite(Number(value))) invalid = true;
      if (value && field.min != null && (field.type === "number" ? Number(value) < Number(field.min) : value < String(field.min))) invalid = true;
      if (value && field.max != null && (field.type === "number" ? Number(value) > Number(field.max) : value > String(field.max))) invalid = true;
      if (value && field.pattern) {
        try { if (!new RegExp(field.pattern).test(value)) invalid = true; } catch { invalid = true; }
      }
      if (invalid) {
        setSubmitError(field.validationMessage || `Please enter a valid value for "${field.label || field.id}".`);
        return;
      }
    }
    setSubmitting(true);
    try {
      const payload = {
        answers,
        identity,
        // Keep the original top-level fields for older API consumers while
        // custom fields travel in the additive identity object.
        ...identity,
      };
      const r = await fetch(
        `/api/travel/diagnostics/public/form/${encodeURIComponent(
          tenantSlug || "",
        )}/${encodeURIComponent(subBrand || "")}/submit`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        },
      );
      const body = await r.json().catch(() => ({}));
      if (!r.ok) {
        throw new Error(body.error || "Submission failed. Please try again.");
      }
      navigate(
        `/diagnostic-form/${encodeURIComponent(tenantSlug || "")}/${encodeURIComponent(
          subBrand || "",
        )}/report/${encodeURIComponent(body.reportSlug || "")}`,
      );
    } catch (e) {
      setSubmitError(e.message || "Submission failed. Please try again.");
    } finally {
      setSubmitting(false);
    }
  };

  if (loading) {
    return <DiagnosticFormLoading config={{ form: {}, brandKit: null }} />;
  }

  if (error) {
    return (
      <DiagnosticFormError
        config={formConfig || { form: {}, brandKit: null }}
        error={error}
      />
    );
  }

  return (
    <DiagnosticFormRenderer
      config={formConfig}
      questions={questions}
      identityFields={formConfig?.identityFields}
      answers={answers}
      identity={identity}
      onAnswerChange={setAnswer}
      onToggleMulti={toggleMulti}
      onIdentityChange={setIdentity}
      onSubmit={submit}
      submitting={submitting}
      submitError={submitError}
      submitLabel={formConfig?.form?.thankYouMessage || "See my diagnostic result"}
      mode="live"
    />
  );
}
