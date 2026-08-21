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

  const submit = async () => {
    setSubmitError("");
    setSubmitting(true);
    try {
      const payload = {
        answers,
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
