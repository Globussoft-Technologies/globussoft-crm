import { useContext, useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Activity, AlertTriangle, Calendar, IndianRupee, Sparkles, TrendingUp, Users, Bell, ArrowRight, Stethoscope, Megaphone, PhoneCall, ExternalLink, RefreshCw } from 'lucide-react';
import { ResponsiveContainer, AreaChart, Area, XAxis, YAxis, Tooltip, CartesianGrid } from 'recharts';
import { fetchApi } from '../../utils/api';
import { AuthContext } from '../../App';
import { launchAdsGptAs, ADSGPT_DEMO_LOGIN } from '../../utils/adsgpt';
import { launchCallifiedSSO } from '../../utils/callified';
import { getGreeting } from '../../utils/greeting';

// #207/#214: clinical staff (doctor/professional/telecaller/helper) must not
// land on the Owner Dashboard. Mirror the Login redirect logic so a direct
// URL nav also bounces them to the right page for their wellnessRole.
function landingForClinicalStaff(user) {
  switch (user?.wellnessRole) {
    case 'telecaller':   return '/wellness/telecaller';
    case 'doctor':       return '/wellness/calendar';
    case 'professional': return '/wellness/calendar';
    case 'helper':       return '/wellness/patients';
    default:             return '/wellness/calendar';
  }
}

const formatRupees = (n) => `₹${Math.round(n || 0).toLocaleString('en-IN')}`;

const StatCard = ({ icon: Icon, label, value, sub, color, onClick }) => (
  <div className="glass" onClick={onClick} style={{ padding: '1.25rem', display: 'flex', flexDirection: 'column', gap: '0.4rem', cursor: onClick ? 'pointer' : 'default', transition: onClick ? 'all 0.2s ease' : 'none' }} onMouseEnter={(e) => onClick && (e.currentTarget.style.transform = 'translateY(-4px)')} onMouseLeave={(e) => onClick && (e.currentTarget.style.transform = 'translateY(0)')}>
    <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', color: 'var(--text-secondary)', fontSize: '0.85rem' }}>
      <Icon size={16} color={color} /> {label}
    </div>
    <div style={{ fontSize: '1.6rem', fontWeight: 600, fontFamily: 'var(--font-family)' }}>{value}</div>
    {sub && <div style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>{sub}</div>}
  </div>
);

export default function OwnerDashboard() {
  const { user, tenant } = useContext(AuthContext);
  const navigate = useNavigate();
  const [data, setData] = useState(null);
  // #565 (HI-16): canonical revenue figure for the displayed window comes
  // from /api/wellness/reports/pnl-by-service so the Owner Dashboard's
  // headline KPI agrees with the /wellness/reports P&L tab. Pre-fix the
  // dashboard surfaced data.today.expectedRevenue (a different scope —
  // scheduled-not-yet-completed) which never reconciled with the P&L
  // page's realised-revenue total.
  const [pnl, setPnl] = useState(null);
  const [loading, setLoading] = useState(true);
  const [locations, setLocations] = useState([]);
  const [locationId, setLocationId] = useState('');
  const [adsGptStatus, setAdsGptStatus] = useState({ state: 'idle', msg: '' });
  const [callifiedStatus, setCallifiedStatus] = useState({ state: 'idle', msg: '' });
  // #831: AdsGPT card was hard-wired to ADSGPT_DEMO_LOGIN at build time
  // and never consulted real linked-account state. Pen-test framing on
  // staging: card reads "Linked account: Not configured" regardless of
  // what's actually wired — the env var isn't baked into the staging
  // build, and nothing falls back to a server-side truth source.
  // Now: query /api/integrations, find the adsgpt row (if any), and
  // render one of three states (linked / not-linked / fetch-error).
  // 'idle' = first paint before /api/integrations resolves;
  // 'linked' = Integration row exists + isActive;
  // 'not_linked' = no Integration row, OR row exists but isActive=false;
  // 'error' = /api/integrations call failed.
  const [adsGptIntegration, setAdsGptIntegration] = useState({ state: 'idle', login: null });
  // #836: surface a freshness signal on the "Top recommendation" panel +
  // give Owner a manual-refresh CTA when the top card is stale. The
  // orchestrator runs daily 07:00 IST, but its output can age out if the
  // cron misses a day (or if it's running against a tenant whose payload
  // hasn't changed). Pre-fix the panel read the top row's title/body with
  // no date context — same copy every visit, regardless of when it was
  // generated. The pen-test framing was "looks scripted" because it
  // literally was reading week-old seed-table copy.
  const [orchestratorStatus, setOrchestratorStatus] = useState({ state: 'idle', msg: '' });

  const refreshDashboard = () => {
    const url = locationId ? `/api/wellness/dashboard?locationId=${locationId}` : '/api/wellness/dashboard';
    return fetchApi(url).then(setData).catch(() => {});
  };

  const handleRunOrchestrator = async () => {
    setOrchestratorStatus({ state: 'loading', msg: 'Refreshing recommendations…' });
    try {
      const result = await fetchApi('/api/wellness/orchestrator/run', { method: 'POST', silent: true });
      const count = (result && typeof result.created === 'number') ? result.created : 0;
      await refreshDashboard();
      setOrchestratorStatus({
        state: 'ok',
        msg: count > 0 ? `Generated ${count} new recommendation${count === 1 ? '' : 's'}.` : 'No new recommendations — today\'s queue is up-to-date.',
      });
      setTimeout(() => setOrchestratorStatus({ state: 'idle', msg: '' }), 4000);
    } catch (err) {
      const msg = err?.status === 403
        ? 'Admin or manager only.'
        : (err?.message || 'Refresh failed.');
      setOrchestratorStatus({ state: 'error', msg });
    }
  };

  // #207/#214: redirect non-management away from the Owner Dashboard.
  // Direct URL nav by a doctor/telecaller/helper/professional now bounces
  // to the page that fits their daily work (matches the post-login landing
  // logic in Login.jsx).
  useEffect(() => {
    if (!user) return;
    if (tenant?.vertical !== 'wellness') return;
    if (user.role === 'ADMIN' || user.role === 'MANAGER') return;
    navigate(landingForClinicalStaff(user), { replace: true });
  }, [user, tenant, navigate]);

  const handleLaunchAdsGpt = async () => {
    setAdsGptStatus({ state: 'loading', msg: 'Signing you into AdsGPT…' });
    try {
      await launchAdsGptAs(ADSGPT_DEMO_LOGIN);
      setAdsGptStatus({ state: 'ok', msg: `Opened AdsGPT as ${ADSGPT_DEMO_LOGIN}` });
      setTimeout(() => setAdsGptStatus({ state: 'idle', msg: '' }), 3000);
    } catch (err) {
      setAdsGptStatus({ state: 'error', msg: err.message || 'AdsGPT launch failed' });
    }
  };

  const handleLaunchCallified = async () => {
    setCallifiedStatus({ state: 'loading', msg: 'Signing you into Callified…' });
    try {
      await launchCallifiedSSO();
      setCallifiedStatus({ state: 'ok', msg: 'Opened Callified dashboard' });
      setTimeout(() => setCallifiedStatus({ state: 'idle', msg: '' }), 3000);
    } catch (err) {
      setCallifiedStatus({ state: 'error', msg: err.message || 'Callified launch failed' });
    }
  };

  useEffect(() => {
    fetchApi('/api/wellness/locations').then(setLocations).catch(() => setLocations([]));
  }, []);

  // #831: load real AdsGPT linked-account state from /api/integrations.
  // Pre-fix the card read a build-time env var (ADSGPT_DEMO_LOGIN) that
  // wasn't set on the staging build — so every demo showed "Not
  // configured" with no path forward. Wrapped in a callable so the
  // "Retry" CTA on the error state can re-fire it without remounting
  // the dashboard.
  const loadAdsGptIntegration = () => {
    setAdsGptIntegration((prev) => ({ ...prev, state: 'idle' }));
    fetchApi('/api/integrations', { silent: true })
      .then((rows) => {
        const list = Array.isArray(rows) ? rows : [];
        const adsgpt = list.find((r) => r && r.provider === 'adsgpt');
        if (adsgpt && adsgpt.isActive) {
          // settings is a JSON-stringified blob per the Integration model
          // (@db.Text). Try to pull a human-readable account label off
          // it; fall back to the build-time demo login so the demo box
          // still has something to show when the row is wired but
          // unannotated.
          let login = null;
          if (adsgpt.settings) {
            try {
              const parsed = typeof adsgpt.settings === 'string'
                ? JSON.parse(adsgpt.settings)
                : adsgpt.settings;
              login = parsed?.login || parsed?.accountName || parsed?.account || null;
            } catch (_e) { /* ignore parse failure — fallback handles it */ }
          }
          setAdsGptIntegration({ state: 'linked', login: login || ADSGPT_DEMO_LOGIN });
        } else {
          setAdsGptIntegration({ state: 'not_linked', login: null });
        }
      })
      .catch(() => setAdsGptIntegration({ state: 'error', login: null }));
  };

  useEffect(() => {
    loadAdsGptIntegration();
  }, []);

  // #831: "Connect AdsGPT" CTA path on the not_linked state — reuses
  // the existing SSO impersonation helper so Owner gets the same
  // one-click surface whether they're linking for the first time or
  // re-entering an already-linked account. Server-side persistence of
  // the Integration row is handled out-of-band today (demo fixture);
  // this CTA is the user-visible "go connect now" surface the
  // pen-test asked for. After launch, we don't optimistically flip to
  // 'linked' — the source of truth is /api/integrations, so the user
  // clicks Retry (or refreshes) to pick up the real state once the
  // out-of-band link completes.
  const handleConnectAdsGpt = async () => {
    setAdsGptStatus({ state: 'loading', msg: 'Opening AdsGPT connect flow…' });
    try {
      await launchAdsGptAs(ADSGPT_DEMO_LOGIN);
      setAdsGptStatus({ state: 'ok', msg: 'Connect flow opened in a new tab. Complete the link, then click Retry below.' });
      setTimeout(() => setAdsGptStatus({ state: 'idle', msg: '' }), 6000);
    } catch (err) {
      setAdsGptStatus({ state: 'error', msg: err.message || 'AdsGPT connect failed' });
    }
  };

  useEffect(() => {
    setLoading(true);
    const url = locationId ? `/api/wellness/dashboard?locationId=${locationId}` : '/api/wellness/dashboard';
    fetchApi(url)
      .then(setData)
      .catch(() => setData(null))
      .finally(() => setLoading(false));
  }, [locationId]);

  // #565: fetch the canonical P&L total for "this month so far" so the
  // headline revenue KPI matches /wellness/reports. Window: from the 1st
  // of the current month to today (inclusive). YYYY-MM-DD on both ends
  // — the route's reportRange helper widens DATE_ONLY values to the full
  // day so we get realised revenue through end-of-today.
  useEffect(() => {
    const now = new Date();
    const yyyy = now.getFullYear();
    const mm = String(now.getMonth() + 1).padStart(2, '0');
    const today = String(now.getDate()).padStart(2, '0');
    const from = `${yyyy}-${mm}-01`;
    const to = `${yyyy}-${mm}-${today}`;
    const qs = new URLSearchParams({ from, to });
    if (locationId) qs.set('locationId', String(locationId));
    fetchApi(`/api/wellness/reports/pnl-by-service?${qs.toString()}`, { silent: true })
      .then(setPnl)
      .catch(() => setPnl(null));
  }, [locationId]);

  if (loading) return <div style={{ padding: '2rem' }}>Loading owner dashboard…</div>;
  if (!data) return <div style={{ padding: '2rem' }}>Could not load dashboard. Make sure your tenant has the Wellness vertical enabled.</div>;

  return (
    <div style={{ padding: '2rem', animation: 'fadeIn 0.5s ease-out' }}>
      <header style={{ marginBottom: '1.5rem', display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: '1rem' }}>
        <div>
          {/* #636: greeting now derives from the user's local clock via the
              shared getGreeting helper (4 branches inc. "Good night" for
              22:00–04:59). Was inline IST-only with 3 branches and no
              late-night case.
              #833: previously used `user.name.split(' ')[0]` which truncated
              two-word display labels — for the demo seed user `name="Demo Admin"`
              the greeting rendered as "Good evening, Demo" and looked broken /
              role-truncated. Use the full name; for genuine first-and-last
              names ("Rishu Sharma" → "Good evening, Rishu Sharma") this still
              reads cleanly. */}
          <h1 style={{ fontFamily: 'var(--font-family)', fontSize: '1.75rem', fontWeight: 600 }}>
            {getGreeting()}{user?.name ? `, ${user.name}` : ''}
          </h1>
          <p style={{ color: 'var(--text-secondary)', marginTop: '0.25rem' }}>
            Here's the snapshot for today — {new Date().toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'long' })}
          </p>
        </div>
        {locations.length > 1 && (
          <select value={locationId} onChange={(e) => setLocationId(e.target.value)}
            aria-label="Filter dashboard by clinic location"
            style={{ padding: '0.5rem 0.75rem', background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.08)', borderRadius: 8, color: 'var(--text-primary)', fontSize: '0.9rem' }}>
            <option value="">All locations</option>
            {locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
          </select>
        )}
      </header>

      {/* KPI grid */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '1rem', marginBottom: '1.5rem' }}>
        <StatCard icon={Calendar} label="Today's appointments" value={data.today.visits} sub={`${data.today.completed} completed so far`} color="var(--accent-color)" onClick={() => navigate('/wellness/calendar')} />
        {/* #565: month-to-date realised revenue from the canonical P&L
            endpoint, matching the figure on /wellness/reports. */}
        <StatCard
          icon={IndianRupee}
          label="Revenue this month"
          value={formatRupees(pnl?.totalRevenue)}
          sub="from completed visits (P&L canonical)"
          color="var(--success-color)"
          onClick={() => navigate('/wellness/reports')}
        />
        <StatCard icon={IndianRupee} label="Today's expected revenue" value={formatRupees(data.today.expectedRevenue)} sub="based on scheduled services" color="var(--success-color)" />
        <StatCard icon={Activity} label="Occupancy" value={`${data.today.occupancyPct}%`} sub="vs target 100%" color={data.today.occupancyPct >= 60 ? 'var(--success-color)' : 'var(--warning-color)'} />
        <StatCard icon={Users} label="New leads today" value={data.today.newLeads} sub="across all channels" color="#3b82f6" />
        <StatCard icon={Bell} label="Pending approvals" value={data.pendingApprovals} sub="from the AI agent" color="#a855f7" onClick={() => navigate('/wellness/recommendations')} />
        <StatCard icon={Stethoscope} label="Active treatment plans" value={data.activeTreatmentPlans} sub="multi-session bundles in progress" color="#ec4899" onClick={() => navigate('/wellness/services?tab=activetreatments')} />
        {/* PRD §6.8 — no-show risk: amber if any flagged, green when clean. */}
        <StatCard
          icon={AlertTriangle}
          label="No-show risk"
          value={data.today.noShowRisk?.count ?? 0}
          sub={`of ${data.today.noShowRisk?.totalUpcoming ?? 0} upcoming`}
          color={(data.today.noShowRisk?.count ?? 0) > 0 ? 'var(--warning-color)' : 'var(--success-color)'}
        />
      </div>

      {/* Yesterday vs Today + Recommendations side by side.
          #523: className-based responsive hooks (was [style*="1fr 1fr"]
          attribute selector — silently broke on inline-style refactor). */}
      <div className="wellness-split-row" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1rem', marginBottom: '1.5rem' }}>
        <div className="glass" style={{ padding: '1.25rem' }}>
          <h3 style={{ marginBottom: '0.75rem', fontSize: '1rem', fontWeight: 600 }}>Yesterday's actuals</h3>
          <div className="wellness-stat-row-3up" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '0.75rem' }}>
            <div>
              <div style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>Visits</div>
              <div style={{ fontSize: '1.4rem', fontWeight: 600 }}>{data.yesterday.visits}</div>
            </div>
            <div>
              <div style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>Completed</div>
              <div style={{ fontSize: '1.4rem', fontWeight: 600 }}>{data.yesterday.completed}</div>
            </div>
            <div>
              <div style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>Revenue</div>
              <div style={{ fontSize: '1.4rem', fontWeight: 600 }}>{formatRupees(data.yesterday.revenue)}</div>
            </div>
          </div>
        </div>

        <div className="glass" style={{ padding: '1.25rem' }}>
          <h3 style={{ marginBottom: '0.75rem', fontSize: '1rem', fontWeight: 600, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '0.5rem' }}>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: '0.5rem' }}>
              <Sparkles size={16} color="#a855f7" /> Top recommendation
            </span>
            {/* #836: manual orchestrator-run CTA — same endpoint the daily
                07:00 IST cron uses. Backend dedup-suppresses re-emits for
                cards already created today, so a double-click cannot
                duplicate the queue. */}
            <button
              type="button"
              onClick={handleRunOrchestrator}
              disabled={orchestratorStatus.state === 'loading'}
              aria-label="Refresh recommendations from the orchestrator"
              title="Re-run the orchestrator to generate today's recommendations"
              style={{
                display: 'inline-flex', alignItems: 'center', gap: '0.3rem',
                padding: '0.3rem 0.6rem', borderRadius: 6,
                background: 'rgba(168, 85, 247, 0.1)', color: '#a855f7',
                border: '1px solid rgba(168, 85, 247, 0.25)',
                fontSize: '0.75rem', fontWeight: 500,
                cursor: orchestratorStatus.state === 'loading' ? 'wait' : 'pointer',
                opacity: orchestratorStatus.state === 'loading' ? 0.7 : 1,
              }}
            >
              <RefreshCw size={12} style={{ animation: orchestratorStatus.state === 'loading' ? 'spin 1s linear infinite' : 'none' }} />
              {orchestratorStatus.state === 'loading' ? 'Refreshing…' : 'Refresh'}
            </button>
          </h3>
          {orchestratorStatus.state !== 'idle' && orchestratorStatus.state !== 'loading' && (
            <div role="status" style={{
              fontSize: '0.75rem', marginBottom: '0.5rem',
              color: orchestratorStatus.state === 'error' ? '#f87171' : '#34d399',
            }}>
              {orchestratorStatus.msg}
            </div>
          )}
          {data.pendingRecommendations.length > 0 ? (
            <>
              <div style={{ fontSize: '0.95rem', fontWeight: 500 }}>{data.pendingRecommendations[0].title}</div>
              <div style={{ fontSize: '0.85rem', color: 'var(--text-secondary)', marginTop: '0.4rem', lineHeight: 1.4 }}>
                {data.pendingRecommendations[0].body}
              </div>
              {/* #836: surface the recommendation's age so Owner can tell
                  at a glance whether the card reflects today's data or a
                  week-old snapshot. Anything older than 1 day gets a
                  warning-coloured chip and a hint to refresh. */}
              {(() => {
                const createdAt = data.pendingRecommendations[0].createdAt;
                if (!createdAt) return null;
                const ageMs = Date.now() - new Date(createdAt).getTime();
                const ageHours = ageMs / 3600000;
                const ageDays = ageMs / 86400000;
                let label;
                if (ageHours < 1) label = 'Generated less than an hour ago';
                else if (ageHours < 24) label = `Generated ${Math.round(ageHours)} hour${Math.round(ageHours) === 1 ? '' : 's'} ago`;
                else if (ageDays < 7) label = `Generated ${Math.round(ageDays)} day${Math.round(ageDays) === 1 ? '' : 's'} ago`;
                else label = `Generated ${Math.round(ageDays)} days ago — likely stale`;
                const stale = ageHours >= 24;
                return (
                  <div
                    aria-label="recommendation age"
                    style={{
                      display: 'inline-flex', alignItems: 'center', gap: '0.3rem',
                      marginTop: '0.5rem', padding: '0.2rem 0.5rem', borderRadius: 4,
                      fontSize: '0.7rem',
                      background: stale ? 'rgba(245, 158, 11, 0.1)' : 'rgba(52, 211, 153, 0.1)',
                      color: stale ? 'var(--warning-color, #f59e0b)' : '#34d399',
                      border: `1px solid ${stale ? 'rgba(245, 158, 11, 0.25)' : 'rgba(52, 211, 153, 0.2)'}`,
                    }}
                  >
                    {label}
                  </div>
                );
              })()}
              <Link to="/wellness/recommendations" style={{ display: 'inline-flex', alignItems: 'center', gap: '0.3rem', marginTop: '0.75rem', fontSize: '0.85rem', color: 'var(--accent-color)' }}>
                Review all {data.pendingApprovals} <ArrowRight size={14} />
              </Link>
            </>
          ) : (
            // #836: honest empty-state instead of the old "No pending
            // recommendations." which read as a UI-error placeholder when
            // the user landed here with zero rows. Pen-test pushback was
            // about believability — explicitly naming the orchestrator
            // makes it clear this is a real engine, not stub copy.
            <div style={{ fontSize: '0.85rem', color: 'var(--text-secondary)' }}>
              No recommendations awaiting your review. The AI orchestrator runs daily at 07:00 IST — click <strong>Refresh</strong> to re-run now.
            </div>
          )}
        </div>
      </div>

      {/* AdsGPT and Callified SSO cards — one-click access to external tools */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))', gap: '1.5rem', marginBottom: '1.5rem' }}>
        {/* AdsGPT launch — one-click SSO impersonation into the linked AdsGPT
            account (login: sumitgh2050 by default; override with
            VITE_ADSGPT_DEMO_LOGIN). Uses the real socket.adsgpt.io +
            dashboard.adsgpt.io flow. */}
        <div className="glass" style={{ padding: '1.25rem', display: 'flex', flexDirection: 'column', gap: '1rem' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '1rem' }}>
            <div style={{
              width: 44, height: 44, borderRadius: 10,
              background: 'linear-gradient(135deg, #f472b6, #8b5cf6)',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              color: '#fff', flexShrink: 0,
            }}>
              <Megaphone size={22} />
            </div>
            <div>
              <div style={{ fontSize: '1rem', fontWeight: 600 }}>AdsGPT</div>
              {/* #831: card now reflects real /api/integrations state
                  rather than a build-time env var. Three render branches:
                  linked (account name + View campaigns), not_linked
                  (Connect AdsGPT CTA), error (Retry CTA). 'idle' is the
                  pre-fetch flash — kept brief to avoid layout jitter. */}
              {adsGptIntegration.state === 'linked' && (
                <div style={{ fontSize: '0.85rem', color: 'var(--text-secondary)', marginTop: 2 }} data-testid="adsgpt-linked-label">
                  Linked account: <strong>{adsGptIntegration.login}</strong>
                </div>
              )}
              {adsGptIntegration.state === 'not_linked' && (
                <div style={{ fontSize: '0.85rem', color: 'var(--text-secondary)', marginTop: 2 }} data-testid="adsgpt-not-linked-label">
                  No AdsGPT account linked yet
                </div>
              )}
              {adsGptIntegration.state === 'error' && (
                <div style={{ fontSize: '0.85rem', color: 'var(--warning-color, #f59e0b)', marginTop: 2 }} data-testid="adsgpt-error-label">
                  Unable to check link status
                </div>
              )}
              {adsGptIntegration.state === 'idle' && (
                <div style={{ fontSize: '0.85rem', color: 'var(--text-secondary)', marginTop: 2 }}>
                  Checking link status…
                </div>
              )}
              {adsGptStatus.state !== 'idle' && (
                <div
                  role="status"
                  style={{
                    fontSize: '0.8rem',
                    marginTop: 6,
                    color: adsGptStatus.state === 'error' ? '#f87171'
                      : adsGptStatus.state === 'ok' ? '#34d399'
                      : 'var(--text-secondary)',
                  }}
                >
                  {adsGptStatus.msg}
                </div>
              )}
            </div>
          </div>
          {/* #831: state-driven CTA. 'linked' → existing View-campaigns SSO
              into AdsGPT dashboard. 'not_linked' → Connect AdsGPT (same
              SSO helper — out-of-band link completion writes the
              Integration row). 'error' → Retry to re-fire the /api/
              integrations fetch. 'idle' → disabled placeholder. */}
          {adsGptIntegration.state === 'linked' && (
            <button
              type="button"
              onClick={handleLaunchAdsGpt}
              disabled={adsGptStatus.state === 'loading'}
              aria-label={`Open AdsGPT campaigns for ${adsGptIntegration.login}`}
              style={{
                display: 'inline-flex', alignItems: 'center', gap: '0.5rem',
                padding: '0.65rem 1rem', borderRadius: 10,
                background: 'linear-gradient(135deg, #a855f7, #6366f1)',
                color: '#fff', border: 'none',
                fontSize: '0.9rem', fontWeight: 500,
                boxShadow: '0 8px 20px rgba(139, 92, 246, 0.3)',
                cursor: adsGptStatus.state === 'loading' ? 'wait' : 'pointer',
                opacity: adsGptStatus.state === 'loading' ? 0.7 : 1,
                alignSelf: 'flex-start',
              }}
            >
              {adsGptStatus.state === 'loading' ? 'Signing in…' : 'View campaigns'}
              <ExternalLink size={14} />
            </button>
          )}
          {adsGptIntegration.state === 'not_linked' && (
            <button
              type="button"
              onClick={handleConnectAdsGpt}
              disabled={adsGptStatus.state === 'loading'}
              aria-label="Connect AdsGPT account"
              style={{
                display: 'inline-flex', alignItems: 'center', gap: '0.5rem',
                padding: '0.65rem 1rem', borderRadius: 10,
                background: 'linear-gradient(135deg, #f472b6, #8b5cf6)',
                color: '#fff', border: 'none',
                fontSize: '0.9rem', fontWeight: 500,
                boxShadow: '0 8px 20px rgba(139, 92, 246, 0.3)',
                cursor: adsGptStatus.state === 'loading' ? 'wait' : 'pointer',
                opacity: adsGptStatus.state === 'loading' ? 0.7 : 1,
                alignSelf: 'flex-start',
              }}
            >
              {adsGptStatus.state === 'loading' ? 'Opening…' : 'Connect AdsGPT'}
              <ExternalLink size={14} />
            </button>
          )}
          {adsGptIntegration.state === 'error' && (
            <button
              type="button"
              onClick={loadAdsGptIntegration}
              aria-label="Retry checking AdsGPT link status"
              style={{
                display: 'inline-flex', alignItems: 'center', gap: '0.5rem',
                padding: '0.65rem 1rem', borderRadius: 10,
                background: 'rgba(245, 158, 11, 0.15)',
                color: 'var(--warning-color, #f59e0b)',
                border: '1px solid rgba(245, 158, 11, 0.35)',
                fontSize: '0.9rem', fontWeight: 500,
                cursor: 'pointer',
                alignSelf: 'flex-start',
              }}
            >
              <RefreshCw size={14} /> Retry
            </button>
          )}
        </div>

        {/* Callified launch — one-click SSO into Callified for voice/WhatsApp
            management. Backend generates JWT token signed with shared secret. */}
        <div className="glass" style={{ padding: '1.25rem', display: 'flex', flexDirection: 'column', gap: '1rem' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '1rem' }}>
            <div style={{
              width: 44, height: 44, borderRadius: 10,
              background: 'linear-gradient(135deg, #06b6d4, #0891b2)',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              color: '#fff', flexShrink: 0,
            }}>
              <PhoneCall size={22} />
            </div>
            <div>
              <div style={{ fontSize: '1rem', fontWeight: 600 }}>Callified</div>
              <div style={{ fontSize: '0.85rem', color: 'var(--text-secondary)', marginTop: 2 }}>
                Voice & WhatsApp integration
              </div>
              {callifiedStatus.state !== 'idle' && (
                <div
                  role="status"
                  style={{
                    fontSize: '0.8rem',
                    marginTop: 6,
                    color: callifiedStatus.state === 'error' ? '#f87171'
                      : callifiedStatus.state === 'ok' ? '#34d399'
                      : 'var(--text-secondary)',
                  }}
                >
                  {callifiedStatus.msg}
                </div>
              )}
            </div>
          </div>
          <button
            type="button"
            onClick={handleLaunchCallified}
            disabled={callifiedStatus.state === 'loading'}
            aria-label="Open Callified dashboard"
            style={{
              display: 'inline-flex', alignItems: 'center', gap: '0.5rem',
              padding: '0.65rem 1rem', borderRadius: 10,
              background: 'linear-gradient(135deg, #06b6d4, #0891b2)',
              color: '#fff', border: 'none',
              fontSize: '0.9rem', fontWeight: 500,
              boxShadow: '0 8px 20px rgba(6, 182, 212, 0.3)',
              cursor: callifiedStatus.state === 'loading' ? 'wait' : 'pointer',
              opacity: callifiedStatus.state === 'loading' ? 0.7 : 1,
              alignSelf: 'flex-start',
            }}
          >
            {callifiedStatus.state === 'loading' ? 'Signing in…' : 'Open Callified'}
            <ExternalLink size={14} />
          </button>
        </div>
      </div>

      {/* Revenue trend */}
      <div className="glass" style={{ padding: '1.25rem', marginBottom: '1.5rem' }}>
        <h3 style={{ marginBottom: '0.75rem', fontSize: '1rem', fontWeight: 600, display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
          <TrendingUp size={16} /> Revenue — last 30 days
        </h3>
        <div style={{ height: 220 }}>
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={data.revenueTrend}>
              <defs>
                <linearGradient id="revGrad" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor="var(--accent-color)" stopOpacity={0.6} />
                  <stop offset="95%" stopColor="var(--accent-color)" stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.06)" />
              <XAxis dataKey="date" stroke="var(--text-secondary)" tick={{ fontSize: 10 }} interval={6} />
              {/* #439: pin y-floor at 0. Recharts auto-domain on all-zero data
                  picks a tiny negative lower bound, which trips the
                  "[chart] negative-domain on positive scale" console warning.
                  Revenue is non-negative by definition; explicit floor=0
                  silences the warning + matches the semantic. */}
              <YAxis stroke="var(--text-secondary)" tick={{ fontSize: 10 }} domain={[0, 'auto']} tickFormatter={(v) => `₹${Math.round(v / 1000)}k`} />
              <Tooltip
                contentStyle={{ background: 'rgba(20, 20, 25, 0.95)', border: '1px solid rgba(255,255,255,0.1)', borderRadius: 8 }}
                labelStyle={{ color: 'var(--text-secondary)' }}
                formatter={(v) => [formatRupees(v), 'Revenue']}
              />
              <Area type="monotone" dataKey="revenue" stroke="var(--accent-color)" fill="url(#revGrad)" />
            </AreaChart>
          </ResponsiveContainer>
        </div>
      </div>

      {/* Quick links */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '1rem' }}>
        <Link to="/wellness/patients" className="glass" style={{ padding: '1rem', textDecoration: 'none', color: 'inherit', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span><Users size={18} style={{ verticalAlign: 'middle', marginRight: '0.5rem' }} /> Patients ({data.totals.patients})</span>
          <ArrowRight size={16} />
        </Link>
        <Link to="/wellness/services" className="glass" style={{ padding: '1rem', textDecoration: 'none', color: 'inherit', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span><Sparkles size={18} style={{ verticalAlign: 'middle', marginRight: '0.5rem' }} /> Service catalog ({data.totals.services})</span>
          <ArrowRight size={16} />
        </Link>
        <Link to="/wellness/recommendations" className="glass" style={{ padding: '1rem', textDecoration: 'none', color: 'inherit', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span><Bell size={18} style={{ verticalAlign: 'middle', marginRight: '0.5rem' }} /> Agent inbox ({data.pendingApprovals})</span>
          <ArrowRight size={16} />
        </Link>
      </div>
    </div>
  );
}
