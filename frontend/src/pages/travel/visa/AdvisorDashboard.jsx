/**
 * Visa Sure Advisor Dashboard — Phase 3 per-application advisor view
 * (cluster B3, rows V8-V10).
 *
 * Read-only per-application advisor view per docs/PRD_VISA_SURE_PHASE_3.md
 * §3 FR-4. Mounted at /travel/visa/applications/:applicationId — drilldown
 * from the existing Visa Applications list (875c082 sibling scaffold).
 *
 * WIRED to the GET /api/travel/visa/applications/:id backend endpoint
 * shipped at ce5f5db. Three sections render from real data:
 *
 *   1. Diagnostic answers (V8) — surfaces TravelDiagnostic.classificationLabel
 *      + score from the joined diagnostic projection. Renders a
 *      "View full diagnostic" link when a diagnostic row exists.
 *
 *   2. AI summary notes (V9) — LLM-router `visa-summary` task consumer
 *      per PRD §3 FR-4 + §6 (LLM consumer list). Placeholder text pending
 *      Q11 LLM-keys product call — there is no `aiSummary` field on
 *      VisaApplication yet (FR-4 LLM consumer is post-Q11).
 *
 *   3. Risk indicators (V10) — three coloured pills mapped to FR-3.1
 *      (complex case), FR-3.2 (prior rejection history), FR-3.3
 *      (high readinessLevel / advisorRiskFlag). Pills go RED on FR-3.1
 *      + FR-3.2 trip conditions, YELLOW on FR-3.3 advisor flag, otherwise
 *      remain neutral.
 *
 *   4. Document checklist progress (bonus) — "X of Y required documents
 *      verified" derived from the documentChecklist relation included
 *      by the backend.
 *
 * Mirrors frontend/src/pages/travel/LeadDetail.jsx parallel-fetch shape
 * for the data flow; visual shell matches the 875c082 SHELL it replaces.
 */
import { useEffect, useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import {
  Stamp,
  ArrowLeft,
  AlertTriangle,
  History,
  ShieldAlert,
  ClipboardList,
  Sparkles,
  CheckCircle2,
  ArrowRight,
} from 'lucide-react';
import { fetchApi } from '../../../utils/api';

const SECTION = {
  background: 'rgba(255, 255, 255, 0.03)',
  border: '1px solid rgba(255, 255, 255, 0.05)',
  borderRadius: 12,
  padding: '1.25rem 1.5rem',
  marginBottom: '1.25rem',
};

const SECTION_HEADER = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  fontSize: '0.95rem',
  fontWeight: 600,
  color: 'var(--text-primary, #fff)',
  margin: 0,
  marginBottom: '0.75rem',
  letterSpacing: 0.3,
};

const EMPTY_LINE = {
  color: 'var(--text-secondary)',
  fontSize: '0.9rem',
  fontStyle: 'italic',
  lineHeight: 1.5,
};

const RISK_PILL_BASE = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 6,
  padding: '6px 12px',
  borderRadius: 999,
  fontSize: '0.8rem',
  fontWeight: 600,
  letterSpacing: 0.3,
  border: '1px solid',
};

// Risk pill palettes — neutral until the FR-3 risk-flag engine populates
// the corresponding fields, then active (red for hard risk, yellow for
// soft / advisor-tagged risk).
const PILL_NEUTRAL = {
  background: 'rgba(255, 255, 255, 0.04)',
  borderColor: 'rgba(255, 255, 255, 0.08)',
  color: 'var(--text-secondary)',
};

const PILL_RED = {
  background: 'rgba(255, 90, 90, 0.12)',
  borderColor: 'rgba(255, 90, 90, 0.4)',
  color: 'rgb(255, 160, 160)',
};

const PILL_YELLOW = {
  background: 'rgba(255, 200, 80, 0.12)',
  borderColor: 'rgba(255, 200, 80, 0.4)',
  color: 'rgb(255, 220, 140)',
};

// Helpers — keep the JSX readable by hoisting the boolean checks here.

// FR-3.2: rejectionHistoryJson is a String? @db.Text — treat null /
// empty string / "[]" / "{}" as "no rejection history". Anything else
// is treated as a hit (the engine writes JSON arrays of prior decisions).
const hasRejectionHistory = (raw) => {
  if (!raw) return false;
  const s = String(raw).trim();
  if (s === '' || s === '[]' || s === '{}' || s === 'null') return false;
  return true;
};

// FR-3.3: advisorRiskFlag is a freeform String? — the visaRiskFlagEngine
// sets it to 'high' or 'priority' for elevated cases. Any non-empty
// value goes yellow; the canonical values are reflected in the title.
const isAdvisorRiskActive = (flag) => {
  if (!flag) return false;
  const f = String(flag).toLowerCase();
  return f === 'high' || f === 'priority';
};

const VisaAdvisorDashboard = () => {
  const { applicationId } = useParams();
  const [application, setApplication] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetchApi(`/api/travel/visa/applications/${applicationId}`)
      .then((res) => {
        if (cancelled) return;
        setApplication(res || null);
      })
      .catch((err) => {
        if (cancelled) return;
        // Surface the route's structured error code when present so
        // 404 NOT_FOUND / 404 NOT_VISA_SURE render the right copy.
        const code =
          (err && (err.code || (err.body && err.body.code))) || null;
        const message =
          (err && (err.message || (err.body && err.body.error))) ||
          'Failed to load visa application';
        setError({ code, message });
        setApplication(null);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [applicationId]);

  // Document checklist progress (bonus). Required items only — optional
  // items don't gate the application moving forward, per FR-5 docs flow.
  const checklist = Array.isArray(application?.documentChecklist)
    ? application.documentChecklist
    : [];
  const requiredItems = checklist.filter((i) => i?.required);
  const verifiedRequired = requiredItems.filter(
    (i) => i?.status === 'verified',
  );

  // Risk-pill state — re-evaluated on every render off the loaded row.
  const complexCaseActive = Boolean(application?.complexCase);
  const rejectionActive = hasRejectionHistory(
    application?.rejectionHistoryJson,
  );
  const advisorRiskActive = isAdvisorRiskActive(application?.advisorRiskFlag);

  return (
    <div style={{ padding: 24, maxWidth: 980, margin: '0 auto' }}>
      <Link
        to="/travel/visa/applications"
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 6,
          color: 'var(--text-secondary)',
          textDecoration: 'none',
          fontSize: '0.85rem',
          marginBottom: '1rem',
        }}
      >
        <ArrowLeft size={14} /> Back to Visa Applications
      </Link>

      <header style={{ marginBottom: '1.5rem' }}>
        <h1
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 10,
            margin: 0,
            fontSize: '1.75rem',
            fontWeight: 'bold',
          }}
        >
          <Stamp
            size={28}
            color="var(--primary-color, var(--accent-color))"
            aria-hidden
          />
          Visa application&nbsp;
          <code style={{ fontSize: '1.1rem', opacity: 0.7 }}>
            #{applicationId}
          </code>
        </h1>
        {application?.contact?.name && (
          <div
            style={{
              marginTop: 6,
              color: 'var(--text-secondary)',
              fontSize: '0.9rem',
            }}
          >
            {application.contact.name}
            {application.applicationType ? (
              <>
                {' '}&middot; <span style={{ opacity: 0.85 }}>
                  {application.applicationType}
                </span>
              </>
            ) : null}
            {application.status ? (
              <>
                {' '}&middot;{' '}
                <span style={{ opacity: 0.85 }}>{application.status}</span>
              </>
            ) : null}
          </div>
        )}
      </header>

      {loading && (
        <div style={EMPTY_LINE}>Loading application&hellip;</div>
      )}

      {!loading && error && (
        <div
          style={{
            ...SECTION,
            borderColor: 'rgba(255, 120, 120, 0.25)',
            background: 'rgba(255, 120, 120, 0.05)',
          }}
        >
          <p style={EMPTY_LINE}>
            {error.code === 'NOT_FOUND' || error.code === 'NOT_VISA_SURE'
              ? 'Visa application not found, or you do not have access to it.'
              : error.message}
          </p>
        </div>
      )}

      {!loading && !error && application && (
        <>
          {/* Section 1 — Diagnostic answers (V8 / PRD §3 FR-4) */}
          <section style={SECTION}>
            <h2 style={SECTION_HEADER}>
              <ClipboardList size={16} aria-hidden /> Diagnostic answers
            </h2>
            {application.diagnostic ? (
              <div
                style={{
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 6,
                  fontSize: '0.9rem',
                }}
              >
                <div>
                  <strong>Classification:</strong>{' '}
                  <span style={{ color: 'var(--text-secondary)' }}>
                    {application.diagnostic.classificationLabel ||
                      application.diagnostic.classification ||
                      '—'}
                  </span>
                </div>
                <div>
                  <strong>Score:</strong>{' '}
                  <span style={{ color: 'var(--text-secondary)' }}>
                    {application.diagnostic.score != null
                      ? application.diagnostic.score
                      : '—'}
                  </span>
                </div>
                {application.diagnostic.recommendedTier && (
                  <div>
                    <strong>Recommended tier:</strong>{' '}
                    <span style={{ color: 'var(--text-secondary)' }}>
                      {application.diagnostic.recommendedTier}
                    </span>
                  </div>
                )}
                {application.diagnostic.id != null && (
                  <Link
                    to={`/travel/diagnostics/${application.diagnostic.id}`}
                    style={{
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: 6,
                      marginTop: 6,
                      color:
                        'var(--primary-color, var(--accent-color))',
                      textDecoration: 'none',
                      fontSize: '0.85rem',
                      fontWeight: 600,
                    }}
                  >
                    View full diagnostic <ArrowRight size={14} />
                  </Link>
                )}
              </div>
            ) : (
              <div style={EMPTY_LINE}>
                No diagnostic submitted yet for this contact.
              </div>
            )}
          </section>

          {/* Section 2 — AI summary notes (V9 / PRD §3 FR-4 LLM consumer).
              Placeholder pending Q11 LLM-keys product call — there is no
              aiSummary field on VisaApplication yet. */}
          <section style={SECTION}>
            <h2 style={SECTION_HEADER}>
              <Sparkles size={16} aria-hidden /> AI summary notes
            </h2>
            <div style={EMPTY_LINE}>
              Pending LLM rollout — the <code>visa-summary</code> task in
              the LLM router lands with Q11 (LLM-keys product call) per
              PRD §6.
            </div>
          </section>

          {/* Section 3 — Risk indicators (V10 / PRD §3 FR-3.1+3.2+3.3).
              Pills are red on FR-3.1 + FR-3.2 trip conditions and yellow
              on FR-3.3 advisor flag. */}
          <section style={SECTION}>
            <h2 style={SECTION_HEADER}>
              <ShieldAlert size={16} aria-hidden /> Risk indicators
            </h2>
            <div
              style={{
                display: 'flex',
                flexWrap: 'wrap',
                gap: 8,
                alignItems: 'center',
              }}
            >
              {/* FR-3.1 — Complex case */}
              <span
                style={{
                  ...RISK_PILL_BASE,
                  ...(complexCaseActive ? PILL_RED : PILL_NEUTRAL),
                }}
                title="Complex case flag (FR-3.1)"
              >
                <AlertTriangle size={12} aria-hidden /> Complex case&nbsp;
                <span style={{ opacity: 0.8 }}>
                  {complexCaseActive ? 'yes' : 'no'}
                </span>
              </span>

              {/* FR-3.2 — Prior rejection history */}
              <span
                style={{
                  ...RISK_PILL_BASE,
                  ...(rejectionActive ? PILL_RED : PILL_NEUTRAL),
                }}
                title="Prior rejection history (FR-3.2)"
              >
                <History size={12} aria-hidden /> Rejection history&nbsp;
                <span style={{ opacity: 0.8 }}>
                  {rejectionActive ? 'on file' : 'none'}
                </span>
              </span>

              {/* FR-3.3 — Advisor risk flag (yellow = high / priority) */}
              <span
                style={{
                  ...RISK_PILL_BASE,
                  ...(advisorRiskActive ? PILL_YELLOW : PILL_NEUTRAL),
                }}
                title="Advisor risk flag (FR-3.3)"
              >
                <ShieldAlert size={12} aria-hidden /> Advisor risk flag&nbsp;
                <span style={{ opacity: 0.8 }}>
                  {application.advisorRiskFlag || '—'}
                </span>
              </span>
            </div>
            <p style={{ ...EMPTY_LINE, marginTop: 12 }}>
              Risk flags populated by{' '}
              <code>backend/cron/visaRiskFlagEngine.js</code> (shell at
              commit <code>9e8c28f</code>).
            </p>
          </section>

          {/* Section 4 (bonus) — Document checklist progress.
              Surfaces the X-of-Y verified ratio across REQUIRED items;
              optional items don't gate forward motion per FR-5. */}
          <section style={SECTION}>
            <h2 style={SECTION_HEADER}>
              <CheckCircle2 size={16} aria-hidden /> Document checklist
            </h2>
            {requiredItems.length === 0 ? (
              <div style={EMPTY_LINE}>
                No document checklist items recorded for this application
                yet.
              </div>
            ) : (
              <>
                <div
                  style={{
                    fontSize: '0.9rem',
                    color: 'var(--text-primary, #fff)',
                    marginBottom: 8,
                  }}
                >
                  <strong>{verifiedRequired.length}</strong> of{' '}
                  <strong>{requiredItems.length}</strong> required
                  documents verified
                </div>
                <div
                  style={{
                    height: 6,
                    width: '100%',
                    borderRadius: 999,
                    background: 'rgba(255, 255, 255, 0.06)',
                    overflow: 'hidden',
                  }}
                  role="progressbar"
                  aria-valuemin={0}
                  aria-valuemax={requiredItems.length}
                  aria-valuenow={verifiedRequired.length}
                  aria-label="Required documents verified"
                >
                  <div
                    style={{
                      height: '100%',
                      width: `${
                        (verifiedRequired.length / requiredItems.length) *
                        100
                      }%`,
                      background:
                        'var(--primary-color, var(--accent-color))',
                      transition: 'width 200ms ease',
                    }}
                  />
                </div>
              </>
            )}
          </section>
        </>
      )}
    </div>
  );
};

export default VisaAdvisorDashboard;
