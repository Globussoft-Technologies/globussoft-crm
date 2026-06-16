/**
 * Visa Sure Reports — Phase 3 analytics surface (cluster B3, rows V16-V18)
 *
 * Analytics surface for the Visa Sure sub-brand per
 * docs/PRD_VISA_SURE_PHASE_3.md §3 FR-7 (rows V16-V18 in the portal feature
 * matrix). Wires the SHELL shipped at 4d70d35 to the 3 real backend endpoints
 * shipped at 45dde56 (backend/routes/travel_visa_analytics.js).
 *
 * Endpoint shapes (from 45dde56):
 *   V16  GET /api/travel/visa/analytics/rejection-recovery
 *        → { totalRejected, recoveryAttempts, recoverySuccesses,
 *            successRate (0..1 decimal), rows: [{status, count}], note? }
 *
 *   V17  GET /api/travel/visa/analytics/conversion-by-readiness
 *        → { byReadinessLevel: [{ level: "level_1".."level_4"|"unknown",
 *            count, converted, conversionRate (0..1 decimal) }],
 *            rows: [...], note? }
 *
 *   V18  GET /api/travel/visa/analytics/lead-source-rate
 *        → { bySource: [{ source, leads, applications,
 *            rate (0..1 decimal) }], rows: [...], note? }
 *
 * Empty-state contract: each endpoint returns a `note` field (with empty
 * arrays) when the tenant has no Visa Sure contacts / leads yet. We render
 * an empty-state card with the note text in that case. Same for any chart
 * whose series array comes back length-0 even without `note` (defensive).
 *
 * Shape adapters: backend rate fields are 0..1 decimals; the recharts Y
 * axes are configured for 0..100 percent. Each adapter multiplies through
 * and renames into the dataKey the existing Bar `dataKey` props expect
 * (successRate / conversionRate / applicationRate) so the chart shells
 * shipped at 4d70d35 stay intact.
 *
 * V16 shape note: backend returns aggregate counts (not a time-series),
 * so we render a single "Overall" cohort bar from the aggregate rate
 * plus 3 KPI tiles (totalRejected, recoveryAttempts, recoverySuccesses)
 * for the numerator/denominator context the bar can't carry alone.
 *
 * Mirrors LlmSpend.jsx (76996c8) fetch-and-render pattern: fetchApi in
 * useEffect with cancel guard + per-section loading/error/empty states.
 *
 * Route mounted in App.jsx: /travel/visa/reports
 */
import { useEffect, useState } from 'react';
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
import { fetchApi } from '../../../utils/api';
import { useNotify } from '../../../utils/notify';

// Brand-aligned palette — mirrors LlmSpend.jsx so cross-page colour reading
// stays consistent. Teal for primary metric, gold for secondary overlays.
const COLOR_PRIMARY = '#265855';
const COLOR_ACCENT = '#C89A4E';

const SHELL_EMPTY_FALLBACK =
  'Waiting for backend data wiring (cluster B3 PRD §3 FR-7)';

function formatNumber(n) {
  return Number(n || 0).toLocaleString();
}

function Tile({ label, value, sub }) {
  return (
    <div
      style={{
        background: 'var(--surface-color, rgba(255,255,255,0.04))',
        border: '1px solid var(--border-color, rgba(255,255,255,0.08))',
        borderRadius: 10,
        padding: '0.85rem 1rem',
        display: 'flex',
        flexDirection: 'column',
        gap: '0.25rem',
        minWidth: 0,
      }}
    >
      <div
        style={{
          fontSize: '0.7rem',
          color: 'var(--text-secondary)',
          textTransform: 'uppercase',
          letterSpacing: '0.05em',
        }}
      >
        {label}
      </div>
      <div
        style={{
          fontSize: '1.3rem',
          fontWeight: 600,
          fontFamily: 'var(--font-family, inherit)',
          lineHeight: 1.2,
        }}
      >
        {value}
      </div>
      {sub && (
        <div style={{ fontSize: '0.72rem', color: 'var(--text-secondary)' }}>
          {sub}
        </div>
      )}
    </div>
  );
}

function ChartCard({ title, description, children, empty, emptyMessage }) {
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
          {emptyMessage || SHELL_EMPTY_FALLBACK}
        </div>
      ) : (
        children
      )}
    </div>
  );
}

export default function VisaReports() {
  const notify = useNotify();

  const [recovery, setRecovery] = useState(null);
  const [readiness, setReadiness] = useState(null);
  const [leadSource, setLeadSource] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);

    Promise.allSettled([
      fetchApi('/api/travel/visa/analytics/rejection-recovery'),
      fetchApi('/api/travel/visa/analytics/conversion-by-readiness'),
      fetchApi('/api/travel/visa/analytics/lead-source-rate'),
    ])
      .then((results) => {
        if (cancelled) return;
        const [r1, r2, r3] = results;
        if (r1.status === 'fulfilled') {
          setRecovery(r1.value);
        } else {
          setRecovery(null);
        }
        if (r2.status === 'fulfilled') {
          setReadiness(r2.value);
        } else {
          setReadiness(null);
        }
        if (r3.status === 'fulfilled') {
          setLeadSource(r3.value);
        } else {
          setLeadSource(null);
        }
        // Surface a single toast if any endpoint failed — granular per-card
        // errors would be noisy and the user can see which card is "—".
        const failures = results.filter((r) => r.status === 'rejected');
        if (failures.length > 0) {
          const first = failures[0];
          const msg =
            first.reason?.body?.error ||
            first.reason?.message ||
            'Failed to load some Visa Sure analytics';
          notify.error(msg);
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
    // notify is stable from useNotify(); intentionally omit to avoid loops.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // V16 adapter — backend returns aggregate counts + a single rate, so we
  // render a one-bar "Overall" cohort. KPI tiles carry numerator/denom.
  const recoverySuccessRatePct =
    recovery && recovery.recoveryAttempts > 0
      ? Number((recovery.successRate * 100).toFixed(2))
      : 0;
  const recoveryData =
    recovery && recovery.recoveryAttempts > 0
      ? [{ cohort: 'Overall', successRate: recoverySuccessRatePct }]
      : [];
  const recoveryEmptyMessage =
    recovery?.note ||
    (recovery && recovery.recoveryAttempts === 0
      ? 'No recovery-program applications recorded yet — chart populates once VisaApplication.recoveryProgramId entries exist for this tenant.'
      : SHELL_EMPTY_FALLBACK);

  // V17 adapter — backend rate is 0..1 decimal, multiply to percent and
  // keep the level label (level_1..level_4 / "unknown") as the X axis.
  const readinessData = (readiness?.byReadinessLevel || []).map((r) => ({
    level: r.level,
    count: r.count,
    converted: r.converted,
    conversionRate: Number((r.conversionRate * 100).toFixed(2)),
  }));
  const readinessHasData = readinessData.some((r) => r.count > 0);
  const readinessEmptyMessage =
    readiness?.note ||
    (readiness && !readinessHasData
      ? 'No applications scored against readiness levels yet — chart populates once VisaApplication.readinessLevel entries exist.'
      : SHELL_EMPTY_FALLBACK);

  // V18 adapter — rename `rate` → `applicationRate` (the existing Bar
  // dataKey from the SHELL) and convert to percent.
  const leadSourceData = (leadSource?.bySource || []).map((r) => ({
    source: r.source,
    leads: r.leads,
    applications: r.applications,
    applicationRate: Number((r.rate * 100).toFixed(2)),
  }));
  const leadSourceEmptyMessage =
    leadSource?.note ||
    (leadSource && leadSourceData.length === 0
      ? 'No Visa Sure leads attributed to a source yet — chart populates once Contact.source values arrive on visasure leads.'
      : SHELL_EMPTY_FALLBACK);

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
              Live data from the visa-analytics endpoints; empty cards mean
              no data has accumulated for that metric yet on this tenant.
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
          Phase 3 — V16-V18 wired
        </div>
      </header>

      {loading && !recovery && !readiness && !leadSource && (
        <div style={{ padding: '2rem', color: 'var(--text-secondary)' }}>
          Loading Visa Sure analytics…
        </div>
      )}

      {/* V16 — Rejection-recovery success rate */}
      <ChartCard
        title="Rejection-recovery success rate (V16)"
        description="(Recovery-program applications with outcome=approved) ÷ (total recovery-program applications). Source: VisaApplication.recoveryProgramId + outcome."
        empty={recoveryData.length === 0}
        emptyMessage={recoveryEmptyMessage}
      >
        {recovery && recovery.recoveryAttempts > 0 && (
          <div
            style={{
              display: 'grid',
              gridTemplateColumns:
                'repeat(auto-fit, minmax(min(100%, 180px), 1fr))',
              gap: '0.75rem',
              marginBottom: '1rem',
            }}
          >
            <Tile
              label="Total rejected"
              value={formatNumber(recovery.totalRejected)}
              sub="status=rejected OR outcome=rejected"
            />
            <Tile
              label="Recovery attempts"
              value={formatNumber(recovery.recoveryAttempts)}
              sub="recoveryProgramId set"
            />
            <Tile
              label="Recovery successes"
              value={formatNumber(recovery.recoverySuccesses)}
              sub="recovered + approved"
            />
            <Tile
              label="Success rate"
              value={`${recoverySuccessRatePct}%`}
              sub="successes ÷ attempts"
            />
          </div>
        )}
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
                formatter={(value) => [`${value}%`, 'Success rate']}
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
        empty={!readinessHasData}
        emptyMessage={readinessEmptyMessage}
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
                formatter={(value, name, item) => {
                  const row = item?.payload || {};
                  return [
                    `${value}% (${formatNumber(row.converted)} ÷ ${formatNumber(
                      row.count,
                    )})`,
                    'Conversion',
                  ];
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
        description="Per Contact.source: (contacts with ≥1 application) ÷ (total leads in that source). Source: Contact.source × VisaApplication presence."
        empty={leadSourceData.length === 0}
        emptyMessage={leadSourceEmptyMessage}
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
                formatter={(value, name, item) => {
                  const row = item?.payload || {};
                  return [
                    `${value}% (${formatNumber(
                      row.applications,
                    )} ÷ ${formatNumber(row.leads)})`,
                    'Rate',
                  ];
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
