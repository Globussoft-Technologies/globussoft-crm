import { useContext, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  RefreshCw,
  Calendar,
  CalendarPlus,
  UserPlus,
  Calculator,
  PenTool,
  Sparkles,
  ArrowRight,
  CheckCircle2,
  Sun,
  Moon,
  Sunrise,
} from 'lucide-react';
import { AuthContext } from '../App';
import { fetchApi } from '../utils/api';
import { usePermissions } from '../hooks/usePermissions';
import { getWidgetComponent } from '../components/home/widgets/index.js';
import WidgetCard from '../components/home/WidgetCard.jsx';

/**
 * Role-aware home dashboard. Fetches /api/widgets/me which returns the
 * intersection of (this user's role's configured widget layout) ∩ (the
 * user's effective permissions). The page then iterates the result and
 * renders each via the frontend widget registry (components/home/
 * widgets/index.js). Unknown widget keys (e.g. after a widget is removed
 * from the registry but still in the DB) silently no-op.
 *
 * Layout:
 *   1. Hero — welcome, role badge, clinic, current date
 *   2. Quick actions — permission-gated CTA buttons (Book Appointment,
 *      Open Calendar, Add Patient, Open POS) so the landing page is
 *      always useful even before any widgets have rendered.
 *   3. Widget grid — role-specific cards (today's appointments, pending
 *      Rx, low-stock alerts, etc.) configured per role via the Roles &
 *      Permissions UI.
 *   4. Empty state — friendly explanation + quick links when the role
 *      has no widgets configured.
 *
 * No per-role hardcoded layout lives here — everything is driven by the
 * RoleWidget table + the user's actual permissions.
 */
export default function Home() {
  const { user, tenant } = useContext(AuthContext);
  const { hasPermission, isReady: permsReady } = usePermissions();
  const [widgets, setWidgets] = useState([]);
  const [role, setRole] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [reloadTick, setReloadTick] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetchApi('/api/widgets/me', { silent: true })
      .then((res) => {
        if (cancelled) return;
        setWidgets(Array.isArray(res?.widgets) ? res.widgets : []);
        setRole(res?.role || null);
        setLoading(false);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err?.message || 'Failed to load home dashboard');
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [reloadTick]);

  const reload = () => setReloadTick((n) => n + 1);

  // Greeting + matching icon. Three buckets matching the three lucide
  // metaphors available so the visual reinforces the text without
  // needing a separate illustration.
  const { greeting, GreetingIcon } = useMemo(() => {
    const h = new Date().getHours();
    if (h < 12) return { greeting: 'Good morning', GreetingIcon: Sunrise };
    if (h < 18) return { greeting: 'Good afternoon', GreetingIcon: Sun };
    return { greeting: 'Good evening', GreetingIcon: Moon };
  }, []);

  const today = useMemo(() => {
    const d = new Date();
    const opts = { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' };
    return d.toLocaleDateString(tenant?.locale || 'en-US', opts);
  }, [tenant?.locale]);

  // Permission-gated quick actions. Only the buttons the user can
  // actually USE render — a doctor sees Calendar + New Rx, a
  // receptionist sees Book Appointment + POS, an admin sees most.
  const quickActions = useMemo(() => {
    if (!permsReady) return [];
    return [
      {
        key: 'calendar',
        label: 'View Calendar',
        sub: "Today's schedule",
        icon: Calendar,
        to: '/wellness/calendar',
        check: () => hasPermission('appointments', 'read'),
      },
      {
        key: 'book',
        label: 'Book Appointment',
        sub: 'On behalf of a patient',
        icon: CalendarPlus,
        to: '/wellness/book-appointment',
        check: () => hasPermission('appointments', 'write'),
      },
      {
        key: 'patient',
        label: 'Patient Directory',
        sub: 'Add or view patients',
        icon: UserPlus,
        to: '/wellness/patients',
        check: () => hasPermission('patients', 'read'),
      },
      {
        key: 'prescriptions',
        label: 'Prescriptions',
        sub: 'Review + finalise Rx',
        icon: PenTool,
        to: '/wellness/prescriptions',
        check: () => hasPermission('prescriptions', 'read'),
      },
      {
        key: 'pos',
        label: 'Point of Sale',
        sub: 'Ring a sale',
        icon: Calculator,
        to: '/wellness/pos',
        check: () => hasPermission('pos', 'read'),
      },
    ].filter((a) => a.check());
  }, [hasPermission, permsReady]);

  const firstName = user?.name?.split(' ')[0] || '';
  const roleLabel = role?.name || user?.role || '';
  const clinicLabel = tenant?.name || '';

  return (
    <div style={pageStyle}>
      {/* ── Hero band ─────────────────────────────────────────────── */}
      <section style={heroSection}>
        <div style={heroLeft}>
          <div style={heroGreetingRow}>
            <span style={heroIconBubble}>
              <GreetingIcon size={20} />
            </span>
            <div>
              <h1 style={heroTitle}>
                {greeting}{firstName ? `, ${firstName}` : ''}
              </h1>
              <div style={heroMeta}>
                {roleLabel && <span style={heroBadge}>{roleLabel}</span>}
                {clinicLabel && (
                  <span style={heroMetaText}>{clinicLabel}</span>
                )}
                <span style={heroMetaDot}>•</span>
                <span style={heroMetaText}>{today}</span>
              </div>
            </div>
          </div>
          <p style={heroSubtitle}>
            Welcome back. Here&apos;s what&apos;s on your plate today — jump
            straight into work using the shortcuts below, or scan your
            role&apos;s personalised cards.
          </p>
        </div>
        <button
          type="button"
          onClick={reload}
          style={heroRefreshBtn}
          aria-label="Refresh home"
        >
          <RefreshCw size={14} /> Refresh
        </button>
      </section>

      {/* ── Quick actions strip ──────────────────────────────────── */}
      {quickActions.length > 0 && (
        <section style={{ marginBottom: '1.5rem' }}>
          <SectionLabel
            icon={Sparkles}
            label="Quick actions"
            hint="What you reach for most"
          />
          <div style={quickGrid}>
            {quickActions.map((a) => (
              <QuickActionCard key={a.key} action={a} />
            ))}
          </div>
        </section>
      )}

      {/* ── Widget grid ──────────────────────────────────────────── */}
      <section>
        <SectionLabel
          icon={CheckCircle2}
          label="Today at a glance"
          hint={
            role?.name
              ? `Personalised for the ${role.name} role`
              : 'Your personalised cards'
          }
        />

        {loading && (
          <div style={widgetGrid}>
            {Array.from({ length: 4 }).map((_, i) => (
              <WidgetCard key={i} title="Loading…" loading />
            ))}
          </div>
        )}

        {!loading && error && (
          <div role="alert" style={errorBanner}>
            {error}
          </div>
        )}

        {!loading && !error && widgets.length === 0 && (
          <EmptyState quickActions={quickActions} />
        )}

        {!loading && !error && widgets.length > 0 && (
          <div style={widgetGrid}>
            {widgets.map((w) => {
              const Component = getWidgetComponent(w.widgetKey);
              if (!Component) return null;
              let parsedSettings = null;
              if (w.settings) {
                try { parsedSettings = JSON.parse(w.settings); } catch { parsedSettings = null; }
              }
              return (
                <Component
                  key={w.widgetKey}
                  meta={w.meta || {}}
                  settings={parsedSettings}
                  role={role}
                />
              );
            })}
          </div>
        )}
      </section>
    </div>
  );
}

// ── Sub-components ───────────────────────────────────────────────

function SectionLabel({ icon: Icon, label, hint }) {
  return (
    <div style={sectionLabelRow}>
      <div style={sectionLabelLeft}>
        {Icon && <Icon size={14} style={{ color: 'var(--text-secondary)' }} />}
        <span style={sectionLabelText}>{label}</span>
      </div>
      {hint && <span style={sectionLabelHint}>{hint}</span>}
    </div>
  );
}

function QuickActionCard({ action }) {
  const { label, sub, icon: Icon, to } = action;
  return (
    <Link to={to} style={quickCardStyle} className="home-quick-card">
      <span style={quickCardIcon}>
        <Icon size={18} />
      </span>
      <span style={{ flex: 1, minWidth: 0 }}>
        <span style={quickCardLabel}>{label}</span>
        <span style={quickCardSub}>{sub}</span>
      </span>
      <ArrowRight
        size={14}
        style={{ color: 'var(--text-secondary)', flexShrink: 0 }}
      />
    </Link>
  );
}

function EmptyState({ quickActions }) {
  return (
    <div style={emptyStateStyle}>
      <span style={emptyStateBubble}>
        <Sparkles size={20} />
      </span>
      <h3 style={{ margin: 0, fontSize: '1rem', fontWeight: 600 }}>
        No personalised cards yet
      </h3>
      <p style={emptyStateText}>
        Your administrator hasn&apos;t configured any home widgets for your
        role. You can still get to everything you need from the sidebar —
        or use one of the quick actions above.
      </p>
      {quickActions.length === 0 && (
        <p style={emptyStateHelp}>
          If your sidebar also looks bare, ask an admin to grant you the
          relevant permissions via <code>Settings → Roles &amp; Permissions</code>.
        </p>
      )}
    </div>
  );
}

// ── Styles ───────────────────────────────────────────────────────

const pageStyle = { padding: '1.5rem', maxWidth: 1400, margin: '0 auto' };

const heroSection = {
  display: 'flex',
  alignItems: 'flex-start',
  justifyContent: 'space-between',
  gap: '1rem',
  flexWrap: 'wrap',
  padding: '1.5rem',
  borderRadius: 16,
  marginBottom: '1.5rem',
  background:
    'linear-gradient(135deg, color-mix(in srgb, var(--primary-color, var(--accent-color)) 18%, transparent), color-mix(in srgb, var(--primary-color, var(--accent-color)) 4%, transparent))',
  border: '1px solid color-mix(in srgb, var(--primary-color, var(--accent-color)) 22%, transparent)',
};

const heroLeft = { flex: '1 1 320px', minWidth: 0 };
const heroGreetingRow = {
  display: 'flex',
  gap: '0.75rem',
  alignItems: 'flex-start',
};

const heroIconBubble = {
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  width: 38,
  height: 38,
  borderRadius: 10,
  background: 'var(--primary-color, var(--accent-color))',
  color: '#fff',
  flexShrink: 0,
};

const heroTitle = {
  margin: 0,
  fontSize: '1.7rem',
  fontWeight: 700,
  lineHeight: 1.15,
  letterSpacing: '-0.01em',
};

const heroMeta = {
  display: 'flex',
  alignItems: 'center',
  gap: '0.5rem',
  flexWrap: 'wrap',
  marginTop: '0.4rem',
  color: 'var(--text-secondary)',
  fontSize: '0.85rem',
};

const heroBadge = {
  display: 'inline-flex',
  alignItems: 'center',
  padding: '0.18rem 0.55rem',
  borderRadius: 999,
  background: 'color-mix(in srgb, var(--primary-color, var(--accent-color)) 28%, transparent)',
  color: 'var(--text-primary)',
  fontSize: '0.72rem',
  fontWeight: 600,
  letterSpacing: '0.02em',
  textTransform: 'uppercase',
};

const heroMetaText = { color: 'var(--text-secondary)' };
const heroMetaDot = { opacity: 0.5 };

const heroSubtitle = {
  margin: '0.85rem 0 0',
  color: 'var(--text-secondary)',
  fontSize: '0.9rem',
  lineHeight: 1.5,
  maxWidth: 620,
};

const heroRefreshBtn = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: '0.4rem',
  padding: '0.45rem 0.85rem',
  borderRadius: 8,
  border: '1px solid var(--border-color)',
  background: 'var(--subtle-bg-2)',
  color: 'inherit',
  cursor: 'pointer',
  fontSize: '0.82rem',
  whiteSpace: 'nowrap',
};

const sectionLabelRow = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: '0.75rem',
  marginBottom: '0.65rem',
};

const sectionLabelLeft = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: '0.4rem',
};

const sectionLabelText = {
  fontSize: '0.72rem',
  fontWeight: 700,
  textTransform: 'uppercase',
  letterSpacing: '0.08em',
  color: 'var(--text-secondary)',
};

const sectionLabelHint = {
  fontSize: '0.78rem',
  color: 'var(--text-secondary)',
  fontStyle: 'italic',
};

const quickGrid = {
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fill, minmax(min(100%, 220px), 1fr))',
  gap: '0.7rem',
};

const quickCardStyle = {
  display: 'flex',
  alignItems: 'center',
  gap: '0.7rem',
  padding: '0.85rem 0.95rem',
  borderRadius: 12,
  border: '1px solid var(--border-color)',
  background: 'var(--subtle-bg-2)',
  textDecoration: 'none',
  color: 'inherit',
  transition: 'transform 0.12s ease, border-color 0.12s ease, background 0.12s ease',
};

const quickCardIcon = {
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  width: 36,
  height: 36,
  borderRadius: 10,
  background: 'color-mix(in srgb, var(--primary-color, var(--accent-color)) 18%, transparent)',
  color: 'var(--primary-color, var(--accent-color))',
  flexShrink: 0,
};

const quickCardLabel = {
  display: 'block',
  fontSize: '0.9rem',
  fontWeight: 600,
  lineHeight: 1.2,
  whiteSpace: 'nowrap',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
};

const quickCardSub = {
  display: 'block',
  fontSize: '0.72rem',
  color: 'var(--text-secondary)',
  marginTop: '0.15rem',
  whiteSpace: 'nowrap',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
};

const widgetGrid = {
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 320px), 1fr))',
  gap: '1rem',
};

const errorBanner = {
  background: 'rgba(239,68,68,0.1)',
  color: '#ef4444',
  padding: '0.85rem',
  borderRadius: 8,
  marginBottom: '1rem',
};

const emptyStateStyle = {
  border: '1px dashed var(--border-color)',
  borderRadius: 14,
  padding: '2.5rem 1.5rem',
  textAlign: 'center',
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  gap: '0.55rem',
  background: 'var(--subtle-bg-2)',
};

const emptyStateBubble = {
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  width: 44,
  height: 44,
  borderRadius: 12,
  background: 'color-mix(in srgb, var(--primary-color, var(--accent-color)) 16%, transparent)',
  color: 'var(--primary-color, var(--accent-color))',
  marginBottom: '0.25rem',
};

const emptyStateText = {
  margin: 0,
  color: 'var(--text-secondary)',
  fontSize: '0.88rem',
  maxWidth: 520,
  lineHeight: 1.55,
};

const emptyStateHelp = {
  margin: '0.4rem 0 0',
  fontSize: '0.8rem',
  color: 'var(--text-secondary)',
};
