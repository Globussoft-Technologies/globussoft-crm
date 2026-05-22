/**
 * Visa Sure Reports — Phase 3 analytics SHELL (cluster B3, rows V16-V18)
 *
 * Analytics surface for the Visa Sure sub-brand per
 * docs/PRD_VISA_SURE_PHASE_3.md §3 FR-7 (rows V16-V18 in the portal feature
 * matrix). This is a SHELL only — three empty recharts placeholders for the
 * three PRD-named metrics. Backend wiring (a new `/reports/visa` endpoint
 * extending backend/routes/travel_reports.js, joining VisaApplication +
 * TravelDiagnostic + Contact) is multi-day work gated on the PRD §5 product
 * calls + Q1 / Q11 LLM credential unlocks.
 *
 * PRD §3 FR-7 metrics (the three sections rendered below):
 *   V16 — Rejection-recovery success rate
 *         = (recovery applications with outcome=approved) / (recovery total)
 *         Sources: VisaApplication.recoveryProgramId IS NOT NULL + outcome
 *   V17 — Conversion by readiness level
 *         = for each level 1-4: (applications in {filed, approved}) /
 *           (diagnostics in that level)
 *         Sources: join TravelDiagnostic.classification ↔ VisaApplication.status
 *   V18 — Lead source to application rate
 *         = for each Contact.firstTouchSource: (applications) / (leads)
 *         Sources: join Contact.firstTouchSource ↔ VisaApplication.status
 *
 * Mirrors LlmSpend.jsx (76996c8) recharts shell pattern: ChartCard wrapper
 * with empty-state messaging, brand-aligned palette (teal primary / warm gold
 * accent matching travel theme), ResponsiveContainer for layout-safety.
 *
 * Route mounted in App.jsx: /travel/visa/reports
 */
import {
  ResponsiveContainer,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  CartesianGrid,
  Legend,
} from 'recharts';
import { BarChart3 } from 'lucide-react';

// Brand-aligned palette — mirrors LlmSpend.jsx so cross-page colour reading
// stays consistent. Teal for primary metric, gold for secondary overlays.
const COLOR_PRIMARY = '#265855';
const COLOR_ACCENT = '#C89A4E';

const SHELL_EMPTY_MESSAGE =
  'Waiting for backend data wiring (cluster B3 PRD §3 FR-7)';

function ChartCard({ title, description, children, empty }) {
  return (
    <div
      style={{
        background: 'var(--surface-color, rgba(255,255,255,0.04))',
        border: '1px solid var(--border-color, rgba(255,255,255,0.08))',
        borderRadius: 10,
        padding: '1rem 1.25rem',
        marginBottom: '1.5rem',
        minWidth: 0,
      }}
    >
      <h3
        style={{
          margin: 0,
          marginBottom: '0.35rem',
          fontSize: '1rem',
          fontWeight: 600,
        }}
      >
        {title}
      </h3>
      {description && (
        <p
          style={{
            margin: 0,
            marginBottom: '0.75rem',
            color: 'var(--text-secondary)',
            fontSize: '0.85rem',
          }}
        >
          {description}
        </p>
      )}
      {empty ? (
        <div
          style={{
            padding: '3rem 1rem',
            textAlign: 'center',
            color: 'var(--text-secondary)',
            fontSize: '0.9rem',
            background: 'rgba(255,255,255,0.02)',
            border: '1px dashed rgba(255,255,255,0.08)',
            borderRadius: 8,
          }}
        >
          {SHELL_EMPTY_MESSAGE}
        </div>
      ) : (
        children
      )}
    </div>
  );
}

export default function VisaReports() {
  // SHELL stage — no data fetched. When backend wiring lands (cluster B3),
  // this becomes a useEffect + fetchApi('/api/travel/reports/visa') that
  // populates each of the three series below.
  const recoveryData = [];
  const readinessData = [];
  const leadSourceData = [];

  return (
    <div style={{ padding: '2rem', animation: 'fadeIn 0.5s ease-out' }}>
      {/* Header bar */}
      <header
        style={{
          marginBottom: '1.5rem',
          display: 'flex',
          alignItems: 'flex-start',
          justifyContent: 'space-between',
          flexWrap: 'wrap',
          gap: '1rem',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
          <BarChart3 size={28} color={COLOR_PRIMARY} aria-hidden="true" />
          <div>
            <h1
              style={{
                margin: 0,
                fontFamily: 'var(--font-family, inherit)',
                fontSize: '1.75rem',
                fontWeight: 600,
              }}
            >
              Visa Sure — Reports
            </h1>
            <p
              style={{
                margin: 0,
                marginTop: '0.25rem',
                color: 'var(--text-secondary)',
                fontSize: '0.85rem',
                maxWidth: 720,
              }}
            >
              Analytics surface per docs/PRD_VISA_SURE_PHASE_3.md §3 FR-7.
              SHELL only — backend{' '}
              <code>/api/travel/reports/visa</code> endpoint pending
              (cluster B3 multi-day work).
            </p>
          </div>
        </div>
        <div
          style={{
            display: 'inline-block',
            padding: '0.35rem 0.75rem',
            borderRadius: 999,
            background: 'rgba(255, 200, 100, 0.12)',
            border: '1px solid rgba(255, 200, 100, 0.25)',
            color: 'var(--text-secondary)',
            fontSize: '0.78rem',
            letterSpacing: 0.3,
            alignSelf: 'center',
          }}
        >
          Phase 3 — V16-V18 scaffolding
        </div>
      </header>

      {/* V16 — Rejection-recovery success rate */}
      <ChartCard
        title="Rejection-recovery success rate (V16)"
        description="(Recovery-program applications with outcome=approved) ÷ (total recovery-program applications). Source: VisaApplication.recoveryProgramId + outcome."
        empty={recoveryData.length === 0}
      >
        <div style={{ width: '100%', height: 280 }}>
          <ResponsiveContainer width="100%" height="100%">
            <BarChart
              data={recoveryData}
              margin={{ top: 8, right: 16, left: 0, bottom: 24 }}
            >
              <CartesianGrid
                strokeDasharray="3 3"
                stroke="rgba(127,127,127,0.18)"
              />
              <XAxis
                dataKey="cohort"
                stroke="var(--text-secondary)"
                tick={{ fontSize: 11 }}
              />
              <YAxis
                stroke="var(--text-secondary)"
                tick={{ fontSize: 11 }}
                tickFormatter={(v) => `${v}%`}
                domain={[0, 100]}
              />
              <Tooltip
                contentStyle={{
                  background: 'rgba(20,20,25,0.95)',
                  border: '1px solid rgba(255,255,255,0.1)',
                  borderRadius: 8,
                  color: '#fff',
                }}
              />
              <Legend wrapperStyle={{ fontSize: 12 }} />
              <Bar
                dataKey="successRate"
                name="Success rate (%)"
                fill={COLOR_PRIMARY}
              />
            </BarChart>
          </ResponsiveContainer>
        </div>
      </ChartCard>

      {/* V17 — Conversion by readiness level */}
      <ChartCard
        title="Conversion by readiness level (V17)"
        description="Per readiness level 1-4: (applications in {filed, approved}) ÷ (diagnostics scored in that level). Source: TravelDiagnostic.classification × VisaApplication.status."
        empty={readinessData.length === 0}
      >
        <div style={{ width: '100%', height: 280 }}>
          <ResponsiveContainer width="100%" height="100%">
            <BarChart
              data={readinessData}
              margin={{ top: 8, right: 16, left: 0, bottom: 24 }}
            >
              <CartesianGrid
                strokeDasharray="3 3"
                stroke="rgba(127,127,127,0.18)"
              />
              <XAxis
                dataKey="level"
                stroke="var(--text-secondary)"
                tick={{ fontSize: 11 }}
              />
              <YAxis
                stroke="var(--text-secondary)"
                tick={{ fontSize: 11 }}
                tickFormatter={(v) => `${v}%`}
                domain={[0, 100]}
              />
              <Tooltip
                contentStyle={{
                  background: 'rgba(20,20,25,0.95)',
                  border: '1px solid rgba(255,255,255,0.1)',
                  borderRadius: 8,
                  color: '#fff',
                }}
              />
              <Legend wrapperStyle={{ fontSize: 12 }} />
              <Bar
                dataKey="conversionRate"
                name="Conversion rate (%)"
                fill={COLOR_ACCENT}
              />
            </BarChart>
          </ResponsiveContainer>
        </div>
      </ChartCard>

      {/* V18 — Lead source to application rate */}
      <ChartCard
        title="Lead source → application rate (V18)"
        description="Per firstTouchSource: (applications filed) ÷ (leads acquired). Source: Contact.firstTouchSource × VisaApplication.status ≠ intake."
        empty={leadSourceData.length === 0}
      >
        <div style={{ width: '100%', height: 280 }}>
          <ResponsiveContainer width="100%" height="100%">
            <BarChart
              data={leadSourceData}
              margin={{ top: 8, right: 16, left: 0, bottom: 24 }}
            >
              <CartesianGrid
                strokeDasharray="3 3"
                stroke="rgba(127,127,127,0.18)"
              />
              <XAxis
                dataKey="source"
                stroke="var(--text-secondary)"
                tick={{ fontSize: 11 }}
                interval={0}
                angle={-15}
                textAnchor="end"
                height={48}
              />
              <YAxis
                stroke="var(--text-secondary)"
                tick={{ fontSize: 11 }}
                tickFormatter={(v) => `${v}%`}
                domain={[0, 100]}
              />
              <Tooltip
                contentStyle={{
                  background: 'rgba(20,20,25,0.95)',
                  border: '1px solid rgba(255,255,255,0.1)',
                  borderRadius: 8,
                  color: '#fff',
                }}
              />
              <Legend wrapperStyle={{ fontSize: 12 }} />
              <Bar
                dataKey="applicationRate"
                name="Application rate (%)"
                fill={COLOR_PRIMARY}
              />
            </BarChart>
          </ResponsiveContainer>
        </div>
      </ChartCard>
    </div>
  );
}
