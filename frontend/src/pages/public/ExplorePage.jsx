import { useEffect, useMemo, useState } from "react";
import {
  AlertCircle,
  ArrowRight,
  BookOpen,
  CheckCircle2,
  Compass,
  Download,
  Flag,
  GraduationCap,
  Landmark,
  Leaf,
  Loader2,
  Mountain,
  Star,
  Waves,
  X,
  Users,
} from "lucide-react";
import "./ExplorePage.css";
import "./ExplorePageOverrides.css";

const heroImage = "https://images.unsplash.com/photo-1533105079780-92b9be482077?w=1500&q=90";
const diagnosticSubBrand = "tmc";
const defaultExploreConfig = {
  brandName: "The Modern School",
  heroEyebrow: "EXPLORE. DREAM. DISCOVER.",
  heroTitle: "Journeys that",
  heroAccent: "inspire growth.",
  heroDescription: "Discover transformative travel experiences, take the diagnostic, and browse curated catalogues crafted for schools and explorers.",
  cataloguesEyebrow: "TRAVEL INSPIRATION",
  cataloguesTitle: "Explore our TMC catalogues",
  cataloguesDescription: "Select the journeys you would like to discuss with our travel team.",
  journeysEyebrow: "PUBLISHED TRIPS",
  journeysTitle: "Explore current journeys",
  heroImage: "",
  navigation: ["Explore", "Current Journeys", "Catalogues"],
};

export default function ExplorePage() {
  const [diagnosticExpanded, setDiagnosticExpanded] = useState(false);
  const [diagnosticConfig, setDiagnosticConfig] = useState(null);
  const [diagnosticLoading, setDiagnosticLoading] = useState(false);
  const [diagnosticError, setDiagnosticError] = useState("");
  const [answers, setAnswers] = useState({});
  const [identity, setIdentity] = useState({});
  const [diagnosticSubmitting, setDiagnosticSubmitting] = useState(false);
  const [diagnosticResult, setDiagnosticResult] = useState(null);
  const [report, setReport] = useState(null);
  const [selectedNames, setSelectedNames] = useState(() => new Set());
  const [interestsSubmitting, setInterestsSubmitting] = useState(false);
  const [interestsSubmittedAt, setInterestsSubmittedAt] = useState(null);
  const [interestsError, setInterestsError] = useState("");
  const [selectedFiles, setSelectedFiles] = useState([]);
  const [selectedFileRecords, setSelectedFileRecords] = useState([]);
  const [cataloguePage, setCataloguePage] = useState(1);
  const [interestFormOpen, setInterestFormOpen] = useState(false);
  const [interestSubmitted, setInterestSubmitted] = useState(false);
  const [interestDetails, setInterestDetails] = useState({
    name: "",
    email: "",
    phone: "",
    dates: "",
    grades: "",
    students: "",
  });
  const [data, setData] = useState({ trips: [], catalogue: [], files: [], exploreConfig: null });
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch(`/api/explore?ts=${Date.now()}`, { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error("load failed"))))
      .then(setData)
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  const exploreConfig = useMemo(() => {
    let previewConfig = null;
    const rawPreview = new URLSearchParams(window.location.search).get("preview");
    if (rawPreview) {
      try { previewConfig = JSON.parse(rawPreview); } catch (_error) { previewConfig = null; }
    }
    return { ...defaultExploreConfig, ...(data.exploreConfig || {}), ...(previewConfig || {}) };
  }, [data.exploreConfig]);
  const sectionOrder = exploreConfig.sections || ["hero", "catalogues", "journeys"];
  const sectionPosition = (section) => sectionOrder.indexOf(section) + 1 || 99;

  useEffect(() => {
    setCataloguePage(1);
  }, [data.files.length]);

  useEffect(() => {
    if (!diagnosticExpanded || diagnosticConfig) return;
    const tenantSlug = data.tenantSlug;
    if (!tenantSlug) {
      if (!loading) {
        setDiagnosticError("The travel diagnostic is not available right now.");
      }
      return;
    }

    setDiagnosticLoading(true);
    setDiagnosticError("");
    fetch(
      `/api/travel/diagnostics/public/form/${encodeURIComponent(tenantSlug)}/${encodeURIComponent(
        diagnosticSubBrand,
      )}`,
    )
      .then(async (res) => {
        const body = await res.json().catch(() => ({}));
        if (!res.ok) {
          throw new Error(body.error || "Failed to load the diagnostic questions.");
        }
        return body;
      })
      .then((body) => {
        setDiagnosticConfig(body);
      })
      .catch((e) => {
        setDiagnosticError(e.message || "Failed to load the diagnostic questions.");
      })
      .finally(() => {
        setDiagnosticLoading(false);
      });
  }, [data.tenantSlug, diagnosticConfig, diagnosticExpanded, loading]);

  const displayed = useMemo(
    () =>
      data.trips.map((trip) => [
        trip.publicPageId || trip.id,
        trip.name,
        trip.destination,
        `${new Date(trip.departDate).toLocaleDateString()} - ${new Date(
          trip.returnDate,
        ).toLocaleDateString()}`,
        trip.imageUrl || heroImage,
      ]),
    [data.trips],
  );

  const cataloguePageSize = 8;
  const cataloguePageCount = Math.max(1, Math.ceil(data.files.length / cataloguePageSize));
  const cataloguePageItems = data.files.slice(
    (cataloguePage - 1) * cataloguePageSize,
    cataloguePage * cataloguePageSize,
  );

  const fallback = (event) => {
    event.currentTarget.src = heroImage;
  };

  const catalogueImage = (file) =>
    `https://source.unsplash.com/800x600/?travel,${encodeURIComponent(
      catalogueDisplayName(file).replace(/[^a-z0-9]+/gi, ","),
    )}`;

  function openDiagnostic() {
    setDiagnosticExpanded(true);
    window.setTimeout(() => {
      document
        .getElementById("diagnostic")
        ?.scrollIntoView?.({ behavior: "smooth", block: "start" });
    }, 0);
  }

  function setSingleAnswer(questionId, value) {
    setAnswers((current) => ({ ...current, [questionId]: value }));
    setDiagnosticError("");
  }

  function toggleMultiAnswer(questionId, value, max) {
    setAnswers((current) => {
      const existing = Array.isArray(current[questionId]) ? current[questionId] : [];
      const next = existing.includes(value)
        ? existing.filter((item) => item !== value)
        : [...existing, value].slice(0, Number(max) || undefined);
      return { ...current, [questionId]: next };
    });
    setDiagnosticError("");
  }

  async function submitDiagnostic(event) {
    event.preventDefault();
    if (!data.tenantSlug) return;

    setDiagnosticSubmitting(true);
    setDiagnosticError("");
    setInterestsError("");
    try {
      const response = await fetch(
        `/api/travel/diagnostics/public/form/${encodeURIComponent(
          data.tenantSlug,
        )}/${encodeURIComponent(diagnosticSubBrand)}/submit`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            answers,
            ...identity,
            ...(JSON.parse(sessionStorage.getItem("exploreCatalogueInterest") || "null")
              ? { catalogueInterest: JSON.parse(sessionStorage.getItem("exploreCatalogueInterest")) }
              : {}),
          }),
        },
      );
      const body = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(body.error || "We could not submit the diagnostic right now.");
      }
      setDiagnosticResult(body);
      await loadDiagnosticReport(body.reportSlug, body);
    } catch (e) {
      setDiagnosticError(e.message || "We could not submit the diagnostic right now.");
    } finally {
      setDiagnosticSubmitting(false);
    }
  }

  async function loadDiagnosticReport(reportSlug, fallbackResult) {
    if (!reportSlug) {
      setReport({ ...fallbackResult });
      return;
    }
    const response = await fetch(
      `/api/travel/diagnostics/public/report/${encodeURIComponent(reportSlug)}`,
    );
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      setReport({ ...fallbackResult });
      return;
    }
    setReport(body);
    const prior = Array.isArray(body?.chosenInterests?.interests)
      ? body.chosenInterests.interests
      : [];
    setSelectedNames(new Set(prior.map((item) => item.name)));
    setInterestsSubmittedAt(body?.chosenInterests?.submittedAt || null);
  }

  function toggleInterest(name) {
    setSelectedNames((current) => {
      const next = new Set(current);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
    setInterestsError("");
  }

  async function submitInterests() {
    const slug = diagnosticResult?.reportSlug;
    const trips = getRecommendedTrips(report);
    const chosen = trips
      .filter((trip) => selectedNames.has(trip.name))
      .map((trip) => ({ name: trip.name, driveLink: trip.driveLink || "" }));
    if (!slug || !chosen.length) return;

    setInterestsSubmitting(true);
    setInterestsError("");
    try {
      const response = await fetch(
        `/api/travel/diagnostics/public/report/${encodeURIComponent(slug)}/interests`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ interests: chosen }),
        },
      );
      const body = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(body.error || "Failed to submit your chosen interests.");
      }
      setInterestsSubmittedAt(body.submittedAt || new Date().toISOString());
    } catch (e) {
      setInterestsError(e.message || "Failed to submit your chosen interests.");
    } finally {
      setInterestsSubmitting(false);
    }
  }

  return (
    <div
      className="explore-site"
      style={{
        "--explore-background": exploreConfig.palette?.background || "#f7f9fc",
        "--explore-accent": exploreConfig.palette?.accent || "#6d4aff",
        "--explore-text": exploreConfig.palette?.text || "#0f172a",
        "--blue": exploreConfig.palette?.accent || "#6d4aff",
        "--ink": exploreConfig.palette?.text || "#0f172a",
        "--muted": exploreConfig.palette?.muted || "#64748b",
        "--explore-panel": exploreConfig.palette?.panel || "#ffffff",
        "--explore-border": exploreConfig.palette?.border || "#dbe3f0",
        "--explore-button-text": exploreConfig.palette?.buttonText || "#ffffff",
        "--explore-button": exploreConfig.palette?.button || "#6d4aff",
        backgroundColor: exploreConfig.palette?.background || "#f7f9fc",
        display: "flex",
        flexDirection: "column",
      }}
    >
      <header className="explore-header">
        <a href="/explore" className="explore-logo">
          <span>
            <Star size={17} />
          </span>
          <strong>
            {exploreConfig.brandName}
          </strong>
        </a>
        <nav aria-label="Explore navigation">
          <a className="is-active" href="#top">Explore</a>
          <a href="#trips">Current Journeys</a>
          <a href="#catalogues">Catalogues</a>
        </nav>
      </header>

      <section
        className="explore-hero"
        id="top"
        style={{ order: sectionPosition("hero"), ...(exploreConfig.heroImage ? { backgroundImage: `url(${exploreConfig.heroImage})` } : {}) }}
      >
        <div className="explore-hero-copy">
          <p className="explore-eyebrow">{exploreConfig.heroEyebrow}</p>
          <h1>
            {exploreConfig.heroTitle}
            <br />
            <em>{exploreConfig.heroAccent}</em>
          </h1>
          <p>
            {exploreConfig.heroDescription}
          </p>
        </div>
        <div className="explore-hero-cards" aria-label="Explore options">
          <button type="button" className="explore-hero-card" onClick={openDiagnostic}>
            <span className="explore-card-icon explore-card-icon-green">
              <Compass size={28} />
            </span>
            <span>
              <strong>Take the Diagnostic</strong>
              <small>
                Answer a few quick questions and get trip recommendations tailored to your goals.
              </small>
            </span>
            <span className="explore-card-arrow">
              <ArrowRight size={17} />
            </span>
          </button>
          <a className="explore-hero-card" href="#catalogues">
            <span className="explore-card-icon explore-card-icon-purple">
              <BookOpen size={28} />
            </span>
            <span>
              <strong>Browse Catalogues</strong>
              <small>
                Explore destination guides, school expeditions, and travel PDFs for your next
                journey.
              </small>
            </span>
            <span className="explore-card-arrow">
              <ArrowRight size={17} />
            </span>
          </a>
          <a className="explore-hero-card" href="#trips">
            <span className="explore-card-icon explore-card-icon-gold">
              <Star size={28} />
            </span>
            <span>
              <strong>Current Journeys</strong>
              <small>
                Handpicked journeys designed for learning, discovery, and unforgettable experiences.
              </small>
            </span>
            <span className="explore-card-arrow">
              <ArrowRight size={17} />
            </span>
          </a>
        </div>
      </section>

      {diagnosticExpanded && (
        <DiagnosticPanel
          answers={answers}
          config={diagnosticConfig}
          error={diagnosticError}
          identity={identity}
          interestsError={interestsError}
          interestsSubmittedAt={interestsSubmittedAt}
          interestsSubmitting={interestsSubmitting}
          loading={diagnosticLoading}
          onClose={() => setDiagnosticExpanded(false)}
          onIdentityChange={setIdentity}
          onMultiAnswer={toggleMultiAnswer}
          onSingleAnswer={setSingleAnswer}
          onSubmit={submitDiagnostic}
          onSubmitInterests={submitInterests}
          onToggleInterest={toggleInterest}
          report={report}
          result={diagnosticResult}
          selectedNames={selectedNames}
          submitting={diagnosticSubmitting}
        />
      )}

      <section className="explore-catalogues" id="catalogues" style={{ order: sectionPosition("catalogues") }}>
        <small>{exploreConfig.cataloguesEyebrow}</small>
        <h2>{exploreConfig.cataloguesTitle}</h2>
        <p>{exploreConfig.cataloguesDescription}</p>
        <div className="catalogue-row">
          {loading ? (
            <p>Loading catalogues...</p>
          ) : (
            cataloguePageItems.map((file, index) => {
              const selected = selectedFiles.includes(file.id);
              const displayName = catalogueDisplayName(file);
              const category = catalogueCategory(displayName, index);
              const tags = catalogueTags(displayName, category);
              return (
                <article
                  className={selected ? "is-selected" : ""}
                  key={file.id}
                  style={{ "--catalogue-delay": `${index * 45}ms` }}
                >
                  <div className="catalogue-image-wrap">
                    <a href={file.driveViewLink} target="_blank" rel="noreferrer" aria-label={`View ${displayName}`}>
                      <img
                        src={file.thumbnailUrl || file.imageUrl || catalogueImage(file)}
                        alt={displayName}
                        onError={(event) => {
                          event.currentTarget.style.visibility = "hidden";
                        }}
                      />
                    </a>
                  </div>
                  <div className="catalogue-card-body">
                    <strong>{displayName}</strong>
                    <p>{catalogueDescription(displayName)}</p>
                    <div className="catalogue-tags" aria-label={`${displayName} highlights`}>
                      {tags.map((tag) => (
                        <span key={tag}>
                          <CatalogueIcon name={tag} size={12} />
                          {tag}
                        </span>
                      ))}
                    </div>
                    <div className="catalogue-card-actions">
                      <label className="catalogue-select">
                        <input
                          type="checkbox"
                          checked={selected}
                          onChange={() => {
                            setSelectedFiles((current) =>
                              current.includes(file.id)
                                ? current.filter((id) => id !== file.id)
                                : [...current, file.id],
                            );
                            setSelectedFileRecords((current) =>
                              current.some((item) => item.id === file.id)
                                ? current.filter((item) => item.id !== file.id)
                                : [...current, { id: file.id, name: displayName, driveViewLink: file.driveViewLink }],
                            );
                          }}
                          aria-label={`Choose ${displayName}`}
                        />
                        <span>{selected ? "Selected for enquiry" : "Select for enquiry"}</span>
                      </label>
                      <a className="catalogue-view-link" href={file.driveViewLink} target="_blank" rel="noreferrer">
                        View PDF Dossier <ArrowRight size={14} />
                      </a>
                    </div>
                  </div>
                </article>
              );
            })
          )}
        </div>
        {!loading && !data.files.length && <p>No published catalogues are available right now.</p>}
        {!loading && data.files.length > cataloguePageSize && (
          <div className="catalogue-pagination" aria-label="Catalogue pagination">
            <button
              type="button"
              disabled={cataloguePage === 1}
              onClick={() => setCataloguePage((page) => Math.max(1, page - 1))}
            >
              Previous
            </button>
            <span>
              Page {cataloguePage} of {cataloguePageCount}
            </span>
            <button
              type="button"
              disabled={cataloguePage === cataloguePageCount}
              onClick={() => setCataloguePage((page) => Math.min(cataloguePageCount, page + 1))}
            >
              Next
            </button>
          </div>
        )}
        {selectedFiles.length > 0 && (
          <button type="button" className="explore-interest-button" onClick={() => {
            setInterestSubmitted(false);
            setInterestFormOpen(true);
          }}>
            Submit interest ({selectedFiles.length})
          </button>
        )}
      </section>

      <section className="explore-trips" id="trips" style={{ order: sectionPosition("journeys") }}>
        <span id="experiences" className="explore-anchor" aria-hidden="true" />
        <div className="explore-section-heading">
          <div>
            <small>{exploreConfig.journeysEyebrow}</small>
            <h2>{exploreConfig.journeysTitle}</h2>
          </div>
        </div>
        <div className="explore-trip-list">
          {loading ? (
            <p>Loading published trips...</p>
          ) : (
            displayed.map(([id, name, country, date, image]) => (
              <a className="explore-trip-card" href={`/trips/${id}`} key={`${id || name}-trip`}>
                <img src={image} alt="" onError={fallback} />
                <div>
                  <small>{country}</small>
                  <h3>{name}</h3>
                  <p>{date}</p>
                </div>
              </a>
            ))
          )}
        </div>
        {!loading && !displayed.length && <p>No published journeys are available right now.</p>}
      </section>

      {interestFormOpen && (
        <div className="explore-modal" role="dialog" aria-modal="true">
          <form
            onSubmit={async (event) => {
              event.preventDefault();
              const response = await fetch(
                `/api/travel/diagnostics/public/form/${encodeURIComponent(data.tenantSlug)}/${encodeURIComponent(diagnosticSubBrand)}/submit`,
                {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({
                    interestOnly: true,
                    name: interestDetails.name,
                    email: interestDetails.email,
                    phone: interestDetails.phone,
                    catalogueInterest: { ...interestDetails, files: selectedFileRecords },
                  }),
                },
              );
              if (!response.ok) return;
              sessionStorage.setItem(
                "exploreCatalogueInterest",
                JSON.stringify({ ...interestDetails, files: selectedFileRecords }),
              );
              setInterestSubmitted(true);
            }}
          >
            <button
              type="button"
              className="modal-close"
              aria-label="Close form"
              onClick={() => setInterestFormOpen(false)}
            >
              <X size={20} />
            </button>
            {interestSubmitted && (
              <div className="explore-interest-success-mark" aria-hidden="true">
                <CheckCircle2 size={24} strokeWidth={2.25} />
              </div>
            )}
            <small>{interestSubmitted ? "REQUEST RECEIVED" : "CATALOGUE INTEREST"}</small>
            <h2>{interestSubmitted ? "Thank you for your interest" : "Tell us about your journey"}</h2>
            <p>
              {interestSubmitted
                ? "Your travel requirements are safely with our team. We will review your preferences and be in touch shortly."
                : "Share a few details and our travel team will help plan your selected trips."}
            </p>
            {interestSubmitted ? (
              <div className="explore-interest-confirmation" role="status">
                <strong>What happens next</strong>
                <span>A member of our travel team will review your request and contact you with the next steps.</span>
              </div>
            ) : (
              <>
            <label>
              Name
              <input required value={interestDetails.name} onChange={(event) => setInterestDetails({ ...interestDetails, name: event.target.value })} autoComplete="name" />
            </label>
            <label>
              Email
              <input required type="email" value={interestDetails.email} onChange={(event) => setInterestDetails({ ...interestDetails, email: event.target.value })} autoComplete="email" />
            </label>
            <label>
              Phone
              <input required type="tel" pattern="[+()0-9 .-]{7,}" value={interestDetails.phone} onChange={(event) => setInterestDetails({ ...interestDetails, phone: event.target.value })} autoComplete="tel" />
            </label>
            <label>
              Dates
              <input
                required
                type="date"
                min={new Date().toISOString().slice(0, 10)}
                value={interestDetails.dates}
                onChange={(event) => setInterestDetails({ ...interestDetails, dates: event.target.value })}
              />
            </label>
            <label>
              Grades
              <input
                required
                value={interestDetails.grades}
                onChange={(event) => setInterestDetails({ ...interestDetails, grades: event.target.value })}
                placeholder="e.g. Grade 8"
              />
            </label>
            <label>
              Tentative no. of students
              <input
                required
                type="number"
                min="1"
                value={interestDetails.students}
                onChange={(event) =>
                  setInterestDetails({ ...interestDetails, students: event.target.value })
                }
              />
            </label>
            <button className="explore-primary" type="submit">
              Submit your interest
            </button>
              </>
            )}
          </form>
        </div>
      )}
    </div>
  );
}

function DiagnosticPanel({
  answers,
  config,
  error,
  identity,
  interestsError,
  interestsSubmittedAt,
  interestsSubmitting,
  loading,
  onClose,
  onIdentityChange,
  onMultiAnswer,
  onSingleAnswer,
  onSubmit,
  onSubmitInterests,
  onToggleInterest,
  report,
  result,
  selectedNames,
  submitting,
}) {
  const questions = Array.isArray(config?.questions) ? config.questions : [];
  const identityFields = getIdentityFields(config?.form);
  const trips = getRecommendedTrips(report);
  const curriculumFit = Array.isArray(report?.curriculumFit?.recommendations)
    ? report.curriculumFit.recommendations
    : Array.isArray(result?.curriculumFit?.recommendations)
      ? result.curriculumFit.recommendations
      : [];
  const summary = report?.ragResult?.recommendations?.summary || "";
  const hasResult = Boolean(result || report);

  return (
    <section className="explore-diagnostic-panel" id="diagnostic" aria-labelledby="explore-diagnostic-title">
      <div className="explore-diagnostic-head">
        <div>
          <small>PERSONALISED RECOMMENDATIONS</small>
          <h2 id="explore-diagnostic-title">Take the diagnostic</h2>
          <p>
            Answer the guided travel questions here and continue through the same recommendation,
            curriculum mapping, and interest flow used by Travel CRM.
          </p>
        </div>
        <button type="button" onClick={onClose} aria-label="Close diagnostic">
          <X size={18} />
        </button>
      </div>

      <div className="explore-diagnostic-shell">
        {loading && (
          <div className="explore-diagnostic-status">
            <Loader2 size={22} className="explore-spin" />
            Loading diagnostic questions...
          </div>
        )}

        {error && (
          <div className="explore-diagnostic-error">
            <AlertCircle size={18} />
            <span>{error}</span>
          </div>
        )}

        {!loading && !hasResult && questions.length > 0 && (
          <form className="explore-diagnostic-form" onSubmit={onSubmit}>
            <div className="explore-diagnostic-intro">
              <span>Step 1</span>
              <strong>{config?.form?.title || "Student travel fit finder"}</strong>
              <p>{config?.form?.subtitle || "Tell us what matters most for this journey."}</p>
            </div>

            {questions.map((question, index) => (
              <DiagnosticQuestion
                answer={answers[question.id]}
                index={index}
                key={question.id}
                onMultiAnswer={onMultiAnswer}
                onSingleAnswer={onSingleAnswer}
                question={question}
              />
            ))}

            {identityFields.length > 0 && (
              <div className="explore-identity-grid">
                {identityFields.map((field) => (
                  <label key={field.id}>
                    <span>
                      {field.label}
                      {field.required ? " *" : ""}
                    </span>
                    <input
                      type={field.type}
                      value={identity[field.id] || ""}
                      required={field.required}
                      placeholder={field.placeholder}
                      onChange={(event) =>
                        onIdentityChange({ ...identity, [field.id]: event.target.value })
                      }
                    />
                  </label>
                ))}
              </div>
            )}

            <button className="explore-diagnostic-submit" type="submit" disabled={submitting}>
              {submitting ? (
                <>
                  <Loader2 size={16} className="explore-spin" />
                  Building recommendations
                </>
              ) : (
                <>
                  See my recommendations
                  <ArrowRight size={16} />
                </>
              )}
            </button>
          </form>
        )}

        {!loading && !hasResult && !error && questions.length === 0 && (
          <div className="explore-diagnostic-status">No diagnostic questions are published yet.</div>
        )}

        {hasResult && (
          <div className="explore-diagnostic-result">
            <div className="explore-result-summary">
              <span>
                <CheckCircle2 size={18} />
                Diagnostic submitted
              </span>
              <h3>{report?.classificationLabel || result?.classificationLabel || "Your travel profile is ready"}</h3>
              {report?.recommendedTier || result?.recommendedTier ? (
                <p>
                  Recommended tier: <strong>{report?.recommendedTier || result?.recommendedTier}</strong>
                </p>
              ) : (
                <p>Your answers are now mapped against the travel knowledge and curriculum engine.</p>
              )}
            </div>

            {summary && (
              <section className="explore-result-block">
                <h4>Recommendation summary</h4>
                <p>{summary}</p>
              </section>
            )}

            {curriculumFit.length > 0 && (
              <section className="explore-result-block">
                <h4>Curriculum-fit destinations</h4>
                <div className="explore-result-grid">
                  {curriculumFit.map((item, index) => (
                    <article key={item.mappingIds?.[0] || `${item.destination}-${index}`}>
                      <strong>{item.destination}</strong>
                      {Number.isFinite(item.fitScore) && <span>{item.fitScore}% fit</span>}
                      {Array.isArray(item.reasons) && item.reasons.length > 0 && (
                        <p>
                          {item.reasons
                            .map((reason) => reason.rationale || reason.learningOutcome || reason.subject)
                            .filter(Boolean)
                            .slice(0, 2)
                            .join(" ")}
                        </p>
                      )}
                      {item.brochurePdfUrl && (
                        <a href={item.brochurePdfUrl} target="_blank" rel="noreferrer">
                          View brochure <ArrowRight size={13} />
                        </a>
                      )}
                    </article>
                  ))}
                </div>
              </section>
            )}

            {trips.length > 0 && (
              <section className="explore-result-block">
                <h4>Choose the journeys you are interested in</h4>
                <p>Pick the recommendations you want the travel team to discuss with you.</p>
                <div className="explore-interest-list">
                  {trips.map((trip) => (
                    <label key={trip.name}>
                      <input
                        type="checkbox"
                        checked={selectedNames.has(trip.name)}
                        onChange={() => onToggleInterest(trip.name)}
                        aria-label={`I'm interested in ${trip.name}`}
                      />
                      <span>
                        <strong>{trip.name}</strong>
                        {trip.summary && <small>{trip.summary}</small>}
                      </span>
                    </label>
                  ))}
                </div>
                {selectedNames.size > 0 && (
                  <button
                    className="explore-diagnostic-submit"
                    type="button"
                    onClick={onSubmitInterests}
                    disabled={interestsSubmitting}
                  >
                    {interestsSubmitting
                      ? "Submitting interests..."
                      : `Submit chosen interests (${selectedNames.size})`}
                  </button>
                )}
                {interestsSubmittedAt && (
                  <div className="explore-diagnostic-success">
                    <CheckCircle2 size={16} />
                    Your interests are saved for the advisor team.
                  </div>
                )}
                {interestsError && (
                  <div className="explore-diagnostic-error">
                    <AlertCircle size={18} />
                    <span>{interestsError}</span>
                  </div>
                )}
              </section>
            )}

            {(report?.reportPdfUrl || result?.reportPdfUrl) && (
              <a className="explore-report-link" href={report?.reportPdfUrl || result?.reportPdfUrl} target="_blank" rel="noreferrer">
                <Download size={16} />
                Download detailed report
              </a>
            )}
          </div>
        )}
      </div>
    </section>
  );
}

function DiagnosticQuestion({ answer, index, onMultiAnswer, onSingleAnswer, question }) {
  const options = Array.isArray(question.options) ? question.options : [];
  const isMulti = question.type === "multi-select";
  const selected = Array.isArray(answer) ? answer : [];

  return (
    <fieldset className="explore-question-card">
      <legend>
        <span>{String(index + 1).padStart(2, "0")}</span>
        {question.text}
      </legend>
      <div className="explore-question-options">
        {options.map((option) => {
          const checked = isMulti ? selected.includes(option.value) : answer === option.value;
          return (
            <label className={checked ? "is-selected" : ""} key={option.value}>
              <input
                type={isMulti ? "checkbox" : "radio"}
                name={question.id}
                checked={checked}
                onChange={() =>
                  isMulti
                    ? onMultiAnswer(question.id, option.value, question.max)
                    : onSingleAnswer(question.id, option.value)
                }
              />
              <span>{option.label}</span>
            </label>
          );
        })}
      </div>
    </fieldset>
  );
}

function getIdentityFields(form = {}) {
  const fields = [];
  if (form.includeName) {
    fields.push({ id: "name", label: "Name", type: "text", required: form.nameRequired !== false });
  }
  if (form.includeEmail) {
    fields.push({
      id: "email",
      label: "Email",
      type: "email",
      required: form.emailRequired !== false,
      placeholder: "you@example.com",
    });
  }
  if (form.includePhone) {
    fields.push({ id: "phone", label: "Phone", type: "tel", required: form.phoneRequired === true });
  }
  return fields;
}

function getRecommendedTrips(report) {
  const trips = report?.ragResult?.recommendations?.recommendedTrips;
  return Array.isArray(trips) ? trips.slice(0, 20) : [];
}

function catalogueDisplayName(file) {
  return String(file?.fileName || "").replace(/\.pdf$/i, "");
}

function catalogueCategory(name, index) {
  const lower = String(name || "").toLowerCase();
  if (lower.includes("school") || lower.includes("educational")) return "Student Expedition";
  if (lower.includes("heritage") || lower.includes("hoysala") || lower.includes("pondicherry")) {
    return "Cultural Discovery";
  }
  if (lower.includes("coorg") || lower.includes("betta") || lower.includes("yercaud")) {
    return "Active & Expedition";
  }
  return ["Curated Journey", "Learning Trail", "Field Discovery", "Student Expedition"][index % 4];
}

function catalogueTags(name, category) {
  const lower = String(name || "").toLowerCase();
  if (lower.includes("pondicherry")) return ["Culture", "Heritage", "Coastal"];
  if (lower.includes("hyderabad")) return ["Heritage", "Landmarks", "Students"];
  if (lower.includes("coorg")) return ["Wildlife", "Nature", "Adventure"];
  if (lower.includes("hampi") || lower.includes("hoysala")) return ["Heritage", "History", "Learning"];
  if (lower.includes("betta") || lower.includes("yercaud")) return ["Adventure", "Nature Study", "Students"];
  if (category === "Learning Trail") return ["Learning", "Outcomes", "Planning"];
  if (category === "Field Discovery") return ["Exploration", "History", "Learning"];
  if (category === "Cultural Discovery") return ["Culture", "Heritage", "Coastal"];
  if (category === "Student Expedition") return ["Heritage", "Landmarks", "Students"];
  return ["Heritage", "Scenic Views", "Learning"];
}

function CatalogueIcon({ name, size = 14 }) {
  const lower = String(name || "").toLowerCase();
  if (lower.includes("learning") || lower.includes("outcome")) return <BookOpen size={size} />;
  if (lower.includes("field") || lower.includes("exploration")) return <Compass size={size} />;
  if (lower.includes("student")) return <Users size={size} />;
  if (lower.includes("cultural") || lower.includes("heritage") || lower.includes("history") || lower.includes("landmark")) {
    return <Landmark size={size} />;
  }
  if (lower.includes("nature") || lower.includes("wildlife")) return <Leaf size={size} />;
  if (lower.includes("coastal")) return <Waves size={size} />;
  if (lower.includes("adventure")) return <Flag size={size} />;
  if (lower.includes("planning") || lower.includes("curated")) return <GraduationCap size={size} />;
  return <Mountain size={size} />;
}

function catalogueDescription(name) {
  const lower = String(name || "").toLowerCase();
  if (lower.includes("coorg")) return "Forest trails, biodiversity learning, and immersive outdoor discovery.";
  if (lower.includes("hampi") || lower.includes("hoysala")) return "Temple architecture, heritage stories, and guided cultural fieldwork.";
  if (lower.includes("pondicherry")) return "Coastal history, French quarters, and experiential learning by the sea.";
  if (lower.includes("hyderabad")) return "Landmarks, city heritage, and curated student-friendly experiences.";
  if (lower.includes("betta") || lower.includes("yercaud")) return "Hill landscapes, nature study, and active school expedition moments.";
  return "Curated itinerary highlights, learning outcomes, and trip planning details.";
}
