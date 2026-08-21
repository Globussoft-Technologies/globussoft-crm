import { Link, useSearchParams } from 'react-router-dom';
import { ArrowLeft } from 'lucide-react';

/**
 * frontend/src/components/ReturnToBanner.jsx
 *
 * Renders a "← Back to <where you came from>" bar when the current page was
 * opened as a drill-down from another surface.
 *
 * A report that hands you a filtered list has to hand you a way back too —
 * otherwise the browser Back button is the only route, and that loses the
 * report's own tab / date-range state on a re-mount.
 *
 * The caller links in with:
 *   /leads?callStatus=qualified&returnTo=%2Flead-reports&returnLabel=Lead%20Funnel
 *
 * Renders nothing when `returnTo` is absent, so pages can mount it
 * unconditionally.
 *
 * Security note: `returnTo` is attacker-controllable via a crafted URL, so it
 * is accepted ONLY as a same-origin absolute path ("/leads"). Anything else —
 * "//evil.com", "https://evil.com", "javascript:…" — is dropped rather than
 * turned into an open redirect.
 */
export function isSafeInternalPath(value) {
  if (typeof value !== 'string' || value.length === 0) return false;
  if (!value.startsWith('/')) return false;
  // "//host" and "/\host" are protocol-relative URLs, not local paths.
  if (value.startsWith('//') || value.startsWith('/\\')) return false;
  return true;
}

// Human wording for the filters a drill-down can carry. Without this the
// destination is a grid that silently hides most of its rows — and when the
// filter matches nothing, an unexplained empty table reads as a broken page.
const CALL_STATUS_WORDS = {
  yet_to_call: 'not called yet',
  connected: 'Connecting',
  qualified: 'Qualified',
  junk: 'Junk',
  dnp: 'DNP / unreachable',
};

function describeFilters(params) {
  const parts = [];
  const callStatus = params.get('callStatus');
  const status = params.get('status');
  const source = params.get('source');
  const assignee = params.get('assignee');

  if (callStatus) parts.push(`call status is ${CALL_STATUS_WORDS[callStatus] || callStatus}`);
  if (status) parts.push(`status is ${status}`);
  if (source) parts.push(`source is ${source}`);
  if (assignee) parts.push(assignee === 'unassigned' ? 'nobody is assigned' : 'assigned to the selected owner');
  return parts;
}

export default function ReturnToBanner() {
  const [params] = useSearchParams();
  const to = params.get('returnTo');
  const label = params.get('returnLabel');

  if (!isSafeInternalPath(to)) return null;

  const filters = describeFilters(params);

  return (
    <div className="return-banner">
      <Link to={to} className="return-banner__link">
        <ArrowLeft size={15} />
        Back to {label ? label.slice(0, 60) : 'the previous page'}
      </Link>
      <span className="return-banner__hint">
        {filters.length
          ? `Showing only records where ${filters.join(' and ')}. Clear the filters below to see everything.`
          : 'Filters below were applied from there.'}
      </span>
    </div>
  );
}
