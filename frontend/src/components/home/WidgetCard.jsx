import { Link } from 'react-router-dom';
import { ArrowUpRight, AlertCircle, Loader2, Inbox } from 'lucide-react';

/**
 * Shared shell for every /home widget. Two exports work together:
 *
 *   <WidgetCard …>            — card chrome (left accent strip, single-
 *                               line header with inline icon, body slot
 *                               for metric/content, footer with deep-
 *                               link CTA, loading/error/empty states).
 *   <Metric value label sub /> — the "big number" headline every widget
 *                               uses. Single visual rule so 0 / 10 / 1000
 *                               all look balanced — the metric never
 *                               competes with surrounding cards.
 *
 * Visual contract:
 *   - Left-edge primary-color accent strip → uniform branding.
 *   - Header: icon inline with title (no chip / no bubble) → minimal
 *     chrome, room for the title to breathe.
 *   - No description text inside the card → titles are descriptive
 *     enough and the previous description text wrapped awkwardly when
 *     the column was narrow.
 *   - CTA lives at the footer (separated by a soft divider), right-
 *     aligned, so it never competes with the title row.
 *   - 1px hover lift via .widget-card:hover in index.css.
 *   - Body uses the full vertical space; empty state centres an icon
 *     bubble + message so the card never reads as "broken".
 */
export default function WidgetCard({
  title,
  // `description` is accepted (so widgets that already pass it don't
  // break) but no longer rendered inside the card. It maps to the
  // section's aria-description so screen readers still announce it.
  description,
  icon: Icon,
  loading = false,
  error = null,
  empty = false,
  emptyMessage = 'Nothing to show right now.',
  emptyHint,
  linkTo,
  linkLabel = 'Open',
  children,
}) {
  return (
    <section
      className="widget-card"
      aria-label={title}
      aria-description={description || undefined}
      style={cardStyle}
    >
      <span aria-hidden="true" style={accentStrip} />

      <header style={headerStyle}>
        {Icon && (
          <Icon
            size={16}
            aria-hidden="true"
            style={titleIconStyle}
          />
        )}
        <h3 style={titleStyle}>{title}</h3>
      </header>

      <div style={bodyStyle}>
        {loading ? (
          <BodyState>
            <Loader2 size={14} className="spin" />
            <span>Loading…</span>
          </BodyState>
        ) : error ? (
          <BodyState role="alert" tone="danger">
            <AlertCircle size={16} />
            <span>{error}</span>
          </BodyState>
        ) : empty ? (
          <EmptyBody icon={Icon} message={emptyMessage} hint={emptyHint} />
        ) : (
          children
        )}
      </div>

      {linkTo && (
        <footer style={footerStyle}>
          <Link to={linkTo} className="widget-card-link" style={footerLinkStyle}>
            {linkLabel}
            <ArrowUpRight size={13} />
          </Link>
        </footer>
      )}
    </section>
  );
}

// ── Public helper components (widgets import these) ──────────────────

/**
 * Big-number metric headline. Fixed visual weight regardless of digits:
 * 0 / 10 / 1000 all read the same so no widget ends up dominating its
 * neighbours because its number happens to be large.
 */
export function Metric({ value, label, sub, tone }) {
  const valueColor =
    tone === 'success'
      ? 'var(--success-color, #10b981)'
      : tone === 'danger'
        ? 'var(--danger-color, #ef4444)'
        : 'var(--text-primary)';
  return (
    <div style={metricWrap}>
      <div style={metricRow}>
        <span style={{ ...metricValue, color: valueColor }}>{value}</span>
        {label && <span style={metricLabel}>{label}</span>}
      </div>
      {sub && <div style={metricSub}>{sub}</div>}
    </div>
  );
}

// `Rows` export kept for backward-compat with widgets that haven't been
// refactored yet. It now renders nothing — list content has moved to
// the deep-linked detail page (cards stay clean; lists live where the
// user is actually working with them). Removing the export entirely
// would crash any widget that still imports it on an older deploy.
export function Rows() {
  return null;
}

// ── Internal sub-components ──────────────────────────────────────────

function EmptyBody({ icon: Icon, message, hint }) {
  return (
    <div style={emptyBodyStyle}>
      <span style={emptyIconBubble}>
        {Icon ? <Icon size={20} /> : <Inbox size={20} />}
      </span>
      <p style={emptyMessageStyle}>{message}</p>
      {hint && <p style={emptyHintStyle}>{hint}</p>}
    </div>
  );
}

function BodyState({ children, tone, role }) {
  const color = tone === 'danger' ? '#ef4444' : 'var(--text-secondary)';
  return (
    <div role={role} style={{ ...bodyStateStyle, color }}>
      {children}
    </div>
  );
}

// ── Styles ───────────────────────────────────────────────────────────

const cardStyle = {
  position: 'relative',
  overflow: 'hidden',
  border: '1px solid var(--border-color)',
  borderRadius: 14,
  padding: '1rem 1.1rem 0.85rem 1.25rem',
  background: 'var(--subtle-bg-2)',
  display: 'flex',
  flexDirection: 'column',
  gap: '0.85rem',
  minHeight: 200,
  transition:
    'transform 0.15s ease, box-shadow 0.15s ease, border-color 0.15s ease',
};

const accentStrip = {
  position: 'absolute',
  top: 0,
  left: 0,
  bottom: 0,
  width: 4,
  background:
    'linear-gradient(180deg, var(--primary-color, var(--accent-color)), color-mix(in srgb, var(--primary-color, var(--accent-color)) 40%, transparent))',
};

const headerStyle = {
  display: 'flex',
  alignItems: 'center',
  gap: '0.45rem',
  minWidth: 0,
};

const titleIconStyle = {
  color: 'var(--primary-color, var(--accent-color))',
  flexShrink: 0,
};

const titleStyle = {
  margin: 0,
  fontSize: '0.92rem',
  fontWeight: 600,
  lineHeight: 1.3,
  letterSpacing: '-0.005em',
  // Single-line title with ellipsis. Most widget titles are short
  // ("Pending prescriptions", "Today's appointments") and fit; the
  // long outliers ("Consent forms awaiting signature") wrap to two
  // lines here, which is fine — better than a CTA fighting them.
  minWidth: 0,
  flex: 1,
};

const bodyStyle = {
  flex: 1,
  display: 'flex',
  flexDirection: 'column',
  justifyContent: 'center',
  gap: '0.5rem',
};

const footerStyle = {
  borderTop: '1px solid var(--border-color)',
  paddingTop: '0.7rem',
  display: 'flex',
  justifyContent: 'flex-end',
};

const footerLinkStyle = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: '0.3rem',
  fontSize: '0.78rem',
  fontWeight: 500,
  color: 'var(--primary-color, var(--accent-color))',
  textDecoration: 'none',
  padding: '0.2rem 0.45rem',
  borderRadius: 6,
  transition: 'background 0.12s ease',
};

// Metric headline
const metricWrap = { display: 'flex', flexDirection: 'column', gap: '0.2rem' };

const metricRow = {
  display: 'flex',
  alignItems: 'baseline',
  gap: '0.5rem',
};

const metricValue = {
  fontSize: '2.2rem',
  fontWeight: 700,
  lineHeight: 1,
  letterSpacing: '-0.02em',
};

const metricLabel = {
  fontSize: '0.78rem',
  fontWeight: 600,
  color: 'var(--text-secondary)',
};

const metricSub = {
  fontSize: '0.78rem',
  color: 'var(--text-secondary)',
};

// Empty body
const emptyBodyStyle = {
  flex: 1,
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  justifyContent: 'center',
  gap: '0.35rem',
  textAlign: 'center',
  padding: '0.5rem 0',
};

const emptyIconBubble = {
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  width: 38,
  height: 38,
  borderRadius: 999,
  background: 'var(--subtle-bg-3)',
  color: 'var(--text-secondary)',
  marginBottom: '0.15rem',
};

const emptyMessageStyle = {
  margin: 0,
  fontSize: '0.85rem',
  color: 'var(--text-primary)',
  fontWeight: 500,
};

const emptyHintStyle = {
  margin: 0,
  fontSize: '0.74rem',
  color: 'var(--text-secondary)',
  maxWidth: 220,
  lineHeight: 1.4,
};

// Generic body-state (loading / error)
const bodyStateStyle = {
  flex: 1,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  gap: '0.5rem',
  fontSize: '0.85rem',
  textAlign: 'center',
};
