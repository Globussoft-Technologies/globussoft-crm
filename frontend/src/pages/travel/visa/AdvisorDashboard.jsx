/**
 * Visa Sure Advisor Dashboard — Phase 3 scaffolding shell (cluster B3, rows V8-V10)
 *
 * Read-only per-application advisor view per docs/PRD_VISA_SURE_PHASE_3.md
 * §3 FR-4. Mounted at /travel/visa/applications/:applicationId — drilldown
 * from the existing Visa Applications list (875c082 sibling scaffold).
 *
 * Three SHELL sections (no real data flow yet — the backend endpoint
 * GET /api/travel/visa/applications/:id is the wider PRD §3 FR-5 surface
 * tracked as cluster B3 in MANUAL_CODING_BACKLOG; this page renders the
 * empty state until that lands):
 *
 *   1. Diagnostic answers (V8) — Q/A list rendered from
 *      VisaApplication.diagnosticAnswersJson; placeholder grid until the
 *      backend ships.
 *
 *   2. AI summary notes (V9) — LLM-router `visa-summary` task consumer
 *      per PRD §3 FR-4 + §6 (LLM consumer list). Stub-mode pending
 *      Q11 LLM-keys product call.
 *
 *   3. Risk indicators (V10) — three coloured pills mapped to FR-3.1
 *      (complex case), FR-3.2 (prior rejection history), and FR-3.3
 *      (high readinessLevel / advisorRiskFlag). The visaRiskFlagEngine
 *      shell shipped at 9e8c28f computes these flags; this page surfaces
 *      them once the backend GET endpoint lands.
 *
 * Mirrors frontend/src/pages/travel/visa/Dashboard.jsx (875c082) shell
 * shape for visual consistency across under-construction Visa surfaces.
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

// Risk pill palettes — neutral until backend lands, then active when the
// FR-3 risk-flag engine populates the corresponding fields.
const PILL_NEUTRAL = {
  background: 'rgba(255, 255, 255, 0.04)',
  borderColor: 'rgba(255, 255, 255, 0.08)',
  color: 'var(--text-secondary)',
};

const VisaAdvisorDashboard = () => {
  const { applicationId } = useParams();
  const [application, setApplication] = useState(null);
  const [loading, setLoading] = useState(true);
  const [endpointMissing, setEndpointMissing] = useState(false);

  useEffect(() => {
    let cancelled = false;
    // STUB: GET /api/travel/visa/applications/:id (PRD §3 FR-5).
    // Endpoint not yet implemented; degrade gracefully to the empty
    // SHELL state when the route 404s.
    fetchApi(`/api/travel/visa/applications/${applicationId}`)
      .then((res) => {
        if (cancelled) return;
        setApplication(res || null);
      })
      .catch(() => {
        if (cancelled) return;
        setEndpointMissing(true);
        setApplication(null);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [applicationId]);

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
        <div
          style={{
            display: 'inline-block',
            marginTop: 8,
            padding: '0.2rem 0.7rem',
            borderRadius: 999,
            background: 'rgba(255, 200, 100, 0.12)',
            border: '1px solid rgba(255, 200, 100, 0.25)',
            color: 'var(--text-secondary)',
            fontSize: '0.75rem',
            letterSpacing: 0.3,
          }}
        >
          Phase 3 — Advisor dashboard SHELL (FR-4)
        </div>
      </header>

      {loading && (
        <div style={EMPTY_LINE}>Loading application&hellip;</div>
      )}

      {!loading && endpointMissing && (
        <div
          style={{
            ...SECTION,
            borderColor: 'rgba(255, 200, 100, 0.2)',
            background: 'rgba(255, 200, 100, 0.05)',
          }}
        >
          <p style={EMPTY_LINE}>
            Backend endpoint{' '}
            <code>GET /api/travel/visa/applications/:id</code> not yet
            implemented (PRD §3 FR-5, cluster B3 in
            <code> MANUAL_CODING_BACKLOG</code>). This page renders the
            empty SHELL until the route lands.
          </p>
        </div>
      )}

      {/* Section 1 — Diagnostic answers (V8 / PRD §3 FR-4)
          TODO(FR-4): render diagnosticAnswersJson as Q/A list grouped by
          diagnostic section; pull section labels from TravelDiagnosticBank. */}
      <section style={SECTION}>
        <h2 style={SECTION_HEADER}>
          <ClipboardList size={16} aria-hidden /> Diagnostic answers
        </h2>
        <div
          style={{
            display: 'grid',
            gap: 8,
            gridTemplateColumns:
              'repeat(auto-fit, minmax(min(100%, 240px), 1fr))',
          }}
        >
          <div style={EMPTY_LINE}>
            {application?.diagnosticAnswersJson
              ? 'Diagnostic answers will render here.'
              : 'No diagnostic submitted yet.'}
          </div>
        </div>
      </section>

      {/* Section 2 — AI summary notes (V9 / PRD §3 FR-4 LLM consumer)
          TODO(FR-4): consume LLM router `visa-summary` task; render
          (a) what jumped out from the diagnostic, (b) which risks elevate
          the case, (c) suggested talking points. Stub-mode pending Q11
          LLM-keys product call. */}
      <section style={SECTION}>
        <h2 style={SECTION_HEADER}>
          <Sparkles size={16} aria-hidden /> AI summary notes
        </h2>
        <div style={EMPTY_LINE}>
          {application?.aiSummary
            ? application.aiSummary
            : 'AI summary not generated yet — pending Q11 LLM-keys product call.'}
        </div>
      </section>

      {/* Section 3 — Risk indicators (V10 / PRD §3 FR-3.1 + FR-3.2 + FR-3.3)
          Three pills mapped to the visaRiskFlagEngine outputs (engine shell
          shipped at 9e8c28f). Neutral until backend GET endpoint lands. */}
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
          {/* FR-3.1 — Complex case (applicationType / family / high-rejection embassy) */}
          <span
            style={{ ...RISK_PILL_BASE, ...PILL_NEUTRAL }}
            title="Complex case flag (FR-3.1)"
          >
            <AlertTriangle size={12} aria-hidden /> Complex case&nbsp;
            <span style={{ opacity: 0.7 }}>
              {application?.complexCase ? 'yes' : '—'}
            </span>
          </span>

          {/* FR-3.2 — Prior rejection history */}
          <span
            style={{ ...RISK_PILL_BASE, ...PILL_NEUTRAL }}
            title="Prior rejection history (FR-3.2)"
          >
            <History size={12} aria-hidden /> Rejection history&nbsp;
            <span style={{ opacity: 0.7 }}>
              {application?.priorRejectionCount ?? '—'}
            </span>
          </span>

          {/* FR-3.3 — High readinessLevel / advisorRiskFlag */}
          <span
            style={{ ...RISK_PILL_BASE, ...PILL_NEUTRAL }}
            title="High-risk flag (FR-3.3)"
          >
            <ShieldAlert size={12} aria-hidden /> Advisor risk flag&nbsp;
            <span style={{ opacity: 0.7 }}>
              {application?.advisorRiskFlag || '—'}
            </span>
          </span>
        </div>
        <p style={{ ...EMPTY_LINE, marginTop: 12 }}>
          Risk flags populated by{' '}
          <code>backend/cron/visaRiskFlagEngine.js</code> (shell at
          commit <code>9e8c28f</code>); pills go active once the engine
          + GET endpoint both land.
        </p>
      </section>
    </div>
  );
};

export default VisaAdvisorDashboard;
