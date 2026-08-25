import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  PhoneCall,
  Search,
  RefreshCw,
  Bot,
  User,
  ChevronLeft,
  ChevronRight,
  X,
  Loader,
  AlertCircle,
  Play,
} from 'lucide-react';
import { fetchApi, getAuthToken } from '../../utils/api';
import {
  crmRecordingUrl,
  matchTranscriptByDuration,
  allTranscripts,
  formatCallDuration as formatDuration,
  parseTranscriptTurns,
  speakerLabel,
  isAgentTurn,
  recordingNeedsCrmAuth,
  presetRange,
} from '../../utils/callified';
import CompactRangeCalendar from '../travel/CompactRangeCalendar';

/**
 * Call History — the full record of Callified calls for the clinic.
 *
 * Replaces reading call history through the per-lead transcripts drawer, which
 * listed every attempt for one contact with no paging, no filters and no
 * per-call detail — unreadable by the time a lead had 29 calls.
 *
 * Backend: GET /api/callified/calls (tenant-wide, paginated, filterable).
 *
 * A row's metadata (when, who, duration, outcome, AI vs manual) comes from the
 * CRM's own CallLog and is always authoritative. The transcript, recording and
 * AI review are fetched per-call from Callified only when a row is opened —
 * they arrive minutes after the call ends, and a long recording is tens of
 * megabytes, so pulling them for a whole page would be wasteful and often
 * empty.
 */

const PAGE_SIZE = 25;

const STATUS_OPTIONS = [
  { value: '', label: 'Any outcome' },
  { value: 'INITIATED', label: 'Initiated' },
  { value: 'CONNECTED', label: 'Connected' },
  { value: 'COMPLETED', label: 'Completed' },
  // Bridge was up but the customer never answered.
  { value: 'MISSED', label: 'Not answered' },
  { value: 'FAILED', label: 'Failed' },
];

const MODE_OPTIONS = [
  { value: '', label: 'AI + Manual' },
  { value: 'ai', label: 'AI calls' },
  { value: 'browser', label: 'Manual calls' },
];

const PERIOD_OPTIONS = [
  { value: '', label: 'All time' },
  { value: 'week', label: 'This week' },
  { value: 'month', label: 'This month' },
  { value: 'custom', label: 'Custom range…' },
];

export default function CallHistory() {
  const [calls, setCalls] = useState([]);
  const [total, setTotal] = useState(0);
  const [totalPages, setTotalPages] = useState(1);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  // Filters + page live in ONE state object so a filter change resets the page
  // in the same update. Held as separate useStates with a "reset page" effect,
  // a filter change fired TWICE — once against the stale page, then again
  // after the reset — and the stale request could win the race and render the
  // wrong page of results.
  const [query, setQuery] = useState({ search: '', status: '', mode: '', from: '', to: '', userId: '' });
  const { search: debouncedSearch, status, mode, from, to, userId } = query;

  // '' = all time. 'week' / 'month' set the dates for you; 'custom' hands over
  // to the range calendar.
  const [period, setPeriod] = useState('');
  const [agents, setAgents] = useState([]);
  // 'own' means the server already restricted the list to this user, so a
  // staff filter would be an empty control that cannot change anything.
  const [scope, setScope] = useState('all');

  // Local, un-debounced mirror so the input stays responsive while typing.
  const [search, setSearch] = useState('');
  const [reloadTick, setReloadTick] = useState(0);
  const [selected, setSelected] = useState(null);

  const setFilter = useCallback((partial) => {
    setPage(1);
    setQuery((q) => ({ ...q, ...partial }));
  }, []);

  // Presets fill the dates in one click. 'custom' keeps whatever is already
  // selected so switching to it does not wipe a range you just picked.
  const applyPeriod = useCallback(
    (next) => {
      setPeriod(next);
      if (next === 'custom') return;
      setFilter(next ? presetRange(next) : { from: '', to: '' });
    },
    [setFilter],
  );

  // Only staff who have actually placed a call — a clinic roster would bury
  // the handful of names that matter.
  useEffect(() => {
    let cancelled = false;
    fetchApi('/api/callified/calls/agents', { silent: true })
      .then((res) => {
        if (cancelled) return;
        setAgents(Array.isArray(res?.agents) ? res.agents : []);
        if (res?.scope) setScope(res.scope);
      })
      .catch(() => {
        if (!cancelled) setAgents([]);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Debounced so typing a patient name doesn't fire a request per keystroke.
  useEffect(() => {
    const id = setTimeout(() => {
      const next = search.trim();
      setQuery((q) => (q.search === next ? q : { ...q, search: next }));
      setPage((p) => (p === 1 ? p : 1));
    }, 350);
    return () => clearTimeout(id);
  }, [search]);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const qs = new URLSearchParams({ page: String(page), limit: String(PAGE_SIZE) });
      if (debouncedSearch) qs.set('search', debouncedSearch);
      if (status) qs.set('status', status);
      if (mode) qs.set('mode', mode);
      if (from) qs.set('from', `${from}T00:00:00`);
      if (to) qs.set('to', `${to}T23:59:59`);
      if (userId) qs.set('userId', userId);

      const res = await fetchApi(`/api/callified/calls?${qs.toString()}`, { silent: true });
      setCalls(Array.isArray(res?.calls) ? res.calls : []);
      setTotal(res?.total || 0);
      setTotalPages(res?.totalPages || 1);
    } catch (err) {
      setError(err?.message || 'Failed to load call history');
      setCalls([]);
    } finally {
      setLoading(false);
    }
  }, [page, debouncedSearch, status, mode, from, to, userId]);

  useEffect(() => {
    load();
  }, [load, reloadTick]);

  const rangeLabel = useMemo(() => {
    if (!total) return 'No calls';
    const first = (page - 1) * PAGE_SIZE + 1;
    const last = Math.min(page * PAGE_SIZE, total);
    return `${first}–${last} of ${total} call${total === 1 ? '' : 's'}`;
  }, [page, total]);

  return (
    <div style={{ padding: '1.5rem', width: '100%' }}>
      <header style={headerStyle}>
        <div>
          <h1 style={{ margin: 0, display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <PhoneCall size={22} style={{ color: 'var(--accent-color)' }} />
            Call History
          </h1>
          <p style={{ margin: '0.2rem 0 0', fontSize: '0.85rem', color: 'var(--text-secondary)' }}>
            Every AI and manual call placed from the CRM. AI calls carry a transcript and review; manual calls are recorded only.
          </p>
        </div>
        <button
          type="button"
          onClick={() => setReloadTick((n) => n + 1)}
          className="btn-secondary"
          style={{ display: 'inline-flex', alignItems: 'center', gap: '0.4rem' }}
        >
          <RefreshCw size={14} /> Refresh
        </button>
      </header>

      <div style={filterBarStyle}>
        <label style={fieldLabel}>
          Search
          <div style={{ position: 'relative' }}>
            <Search size={14} style={searchIconStyle} />
            <input
              type="search"
              className="input-field"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Patient or number…"
              data-testid="call-history-search"
              style={{ width: '100%', paddingLeft: 28 }}
            />
          </div>
        </label>
        {/* One control instead of two raw date boxes. Reviewing calls is
            almost always "this week" or "this month"; typing two dates for
            that is friction. Custom opens the shared range calendar. */}
        <label style={fieldLabel}>
          Period
          <select
            className="input-field"
            value={period}
            onChange={(e) => applyPeriod(e.target.value)}
            data-testid="call-history-period"
            style={{ width: '100%' }}
          >
            {PERIOD_OPTIONS.map((o) => (
              <option key={o.value || 'all'} value={o.value}>{o.label}</option>
            ))}
          </select>
        </label>
        {period === 'custom' && (
          <label style={fieldLabel}>
            Dates
            <div data-testid="call-history-custom-range">
              <CompactRangeCalendar
                from={from}
                to={to}
                popover
                onChange={({ from: nextFrom, to: nextTo }) =>
                  setFilter({ from: nextFrom || '', to: nextTo || '' })
                }
              />
            </div>
          </label>
        )}
        {scope === 'all' && (
        <label style={fieldLabel}>
          Staff
          <select
            className="input-field"
            value={userId}
            onChange={(e) => setFilter({ userId: e.target.value })}
            data-testid="call-history-staff"
            style={{ width: '100%' }}
          >
            <option value="">All staff</option>
            {agents.map((a) => (
              <option key={a.id} value={String(a.id)}>
                {a.name} ({a.callCount})
              </option>
            ))}
          </select>
        </label>
        )}
        <label style={fieldLabel}>
          Type
          <select className="input-field" value={mode} onChange={(e) => setFilter({ mode: e.target.value })} data-testid="call-history-mode" style={{ width: '100%' }}>
            {MODE_OPTIONS.map((o) => (
              <option key={o.value || 'any'} value={o.value}>{o.label}</option>
            ))}
          </select>
        </label>
        <label style={fieldLabel}>
          Outcome
          <select className="input-field" value={status} onChange={(e) => setFilter({ status: e.target.value })} data-testid="call-history-status" style={{ width: '100%' }}>
            {STATUS_OPTIONS.map((o) => (
              <option key={o.value || 'any'} value={o.value}>{o.label}</option>
            ))}
          </select>
        </label>
      </div>

      {error && (
        <div role="alert" style={errorBoxStyle}>{error}</div>
      )}

      <div style={tableShellStyle}>
        <table style={{ width: '100%', borderCollapse: 'separate', borderSpacing: 0, fontSize: '0.9rem', minWidth: 820 }}>
          <thead>
            <tr style={{ textAlign: 'left' }}>
              <Th>When</Th>
              <Th>Customer</Th>
              <Th>Type</Th>
              <Th>Outcome</Th>
              <Th>Duration</Th>
              <Th>Placed by</Th>
              <Th> </Th>
            </tr>
          </thead>
          <tbody>
            {loading && (
              <tr><Td colSpan={7} center>Loading call history…</Td></tr>
            )}
            {!loading && calls.length === 0 && (
              <tr><Td colSpan={7} center>No calls match these filters.</Td></tr>
            )}
            {!loading && calls.map((call) => (
              <tr key={call.id} style={{ borderTop: '1px solid var(--border-color)' }} data-testid={`call-row-${call.id}`}>
                <Td>
                  <div style={{ fontWeight: 600 }}>{formatDate(call.createdAt)}</div>
                  <div style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>{formatTime(call.createdAt)}</div>
                </Td>
                <Td>
                  <div style={{ fontWeight: 600 }}>{call.contactName || 'Unknown'}</div>
                  <div style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>{call.calleeNumber}</div>
                </Td>
                <Td><ModePill mode={call.mode} /></Td>
                <Td><StatusPill status={call.status} /></Td>
                <Td>{formatDuration(call.duration)}</Td>
                <Td style={{ color: 'var(--text-secondary)' }}>{call.placedBy || '—'}</Td>
                <Td>
                  <button
                    type="button"
                    className="btn-secondary"
                    onClick={() => setSelected(call)}
                    data-testid={`call-details-${call.id}`}
                    style={{ padding: '0.3rem 0.6rem', fontSize: '0.75rem' }}
                  >
                    Details
                  </button>
                </Td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div style={pagerStyle}>
        <span style={{ fontSize: '0.8rem', color: 'var(--text-secondary)' }} data-testid="call-history-range">
          {rangeLabel}
        </span>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
          <button
            type="button"
            className="btn-secondary"
            disabled={page <= 1 || loading}
            onClick={() => setPage((p) => Math.max(1, p - 1))}
            data-testid="call-history-prev"
            style={pagerBtnStyle}
          >
            <ChevronLeft size={14} /> Previous
          </button>
          <span style={{ fontSize: '0.8rem', color: 'var(--text-secondary)' }}>
            Page {page} of {totalPages}
          </span>
          <button
            type="button"
            className="btn-secondary"
            disabled={page >= totalPages || loading}
            onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
            data-testid="call-history-next"
            style={pagerBtnStyle}
          >
            Next <ChevronRight size={14} />
          </button>
        </div>
      </div>

      {selected && <CallDetailDrawer call={selected} onClose={() => setSelected(null)} />}
    </div>
  );
}

/**
 * Detail for ONE call.
 *
 * The CallLog half renders immediately because the CRM owns it. The Callified
 * half (transcript / recording / AI review) is fetched on open and matched to
 * this attempt by timestamp — Callified stores transcripts against the LEAD,
 * not the individual call, so a lead with 29 attempts returns 29 transcripts
 * and showing all of them under one row is exactly the confusion this page
 * exists to remove.
 */
function CallDetailDrawer({ call, onClose }) {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [match, setMatch] = useState(null);
  const [others, setOthers] = useState([]);
  const [leadGone, setLeadGone] = useState(false);

  useEffect(() => {
    let cancelled = false;
    if (!call.callifiedLeadId) {
      setLoading(false);
      return undefined;
    }
    setLoading(true);
    setError('');
    setLeadGone(false);
    fetchApi(`/api/callified/calls/${call.callifiedLeadId}/details`, { silent: true })
      .then((res) => {
        if (cancelled) return;
        // Duration is the only field that genuinely corresponds — see
        // matchTranscriptByDuration. When it is ambiguous we show the
        // customer's full list rather than guessing.
        const exact = matchTranscriptByDuration(res, call.duration);
        setMatch(exact);
        setOthers(exact ? [] : allTranscripts(res));
      })
      .catch((err) => {
        if (cancelled) return;
        // Callified hard-deletes leads, and older CRM rows keep pointing at
        // the id that was current when the call was placed. Say that plainly
        // instead of showing a raw 404.
        if (/404|not found/i.test(err?.message || '')) setLeadGone(true);
        else setError(err?.message || 'Could not load the transcript');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, [call.callifiedLeadId, call.duration]);

  const review = match?.review;
  const transcript = match?.transcript;
  const turns = parseTranscriptTurns(transcript?.transcript);
  const isManual = call.mode === 'browser';

  return (
    <div style={drawerBackdrop} onClick={(e) => { if (e.target === e.currentTarget) onClose(); }} role="dialog" aria-modal="true" aria-label="Call details">
      <div className="glass" style={drawerPanel} data-testid="call-detail-drawer">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '1rem' }}>
          <div>
            <h3 style={{ margin: 0, fontSize: '1.05rem' }}>{call.contactName || 'Unknown customer'}</h3>
            <div style={{ fontSize: '0.82rem', color: 'var(--text-secondary)', marginTop: '0.2rem' }}>
              {call.calleeNumber} · {formatDate(call.createdAt)} {formatTime(call.createdAt)}
            </div>
          </div>
          <button type="button" onClick={onClose} aria-label="Close" style={{ background: 'transparent', border: 'none', cursor: 'pointer', color: 'var(--text-secondary)' }}>
            <X size={20} />
          </button>
        </div>

        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.4rem', marginBottom: '1rem' }}>
          <ModePill mode={call.mode} />
          <StatusPill status={call.status} />
          <Chip>{formatDuration(call.duration)}</Chip>
          {call.placedBy && <Chip>by {call.placedBy}</Chip>}
        </div>

        {loading ? (
          <div style={infoRow}><Loader size={16} style={{ animation: 'spin 1s linear infinite' }} /> Loading transcript…</div>
        ) : error ? (
          <div style={{ ...infoRow, color: '#ef4444' }}><AlertCircle size={16} /> {error}</div>
        ) : !call.callifiedLeadId ? (
          <div style={infoRow}>This call has no Callified record to pull a transcript from.</div>
        ) : leadGone ? (
          <div style={infoRow}>
            <AlertCircle size={16} />
            Callified no longer has the lead this call was placed against, so its
            transcript and recording are gone.
          </div>
        ) : !transcript ? (
          <>
            <div style={infoRow}>
              {call.duration
                ? "Callified does not say which recording belongs to which attempt, so this call could not be matched to one."
                : "This call never connected, so there is no recording or transcript."}
            </div>
            {/* Everything Callified holds for this customer. Listing them is
                honest; picking one at random and labelling it "this call"
                would attribute the wrong conversation to the wrong attempt. */}
            {others.length > 0 && (
              <div style={sectionBox} data-testid="call-detail-all-transcripts">
                <SectionTitle>Recordings for this customer ({others.length})</SectionTitle>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
                  {others.map(({ transcript: t }) => (
                    <div key={t.id} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '0.5rem', fontSize: '0.82rem' }}>
                      <span style={{ color: 'var(--text-secondary)' }}>
                        {formatDuration(t.call_duration_s)} · processed {String(t.created_at || '').slice(0, 16)}
                      </span>
                      {t.recording_url && (
                        <a
                          href={crmRecordingUrl(t.recording_url)}
                          onClick={(e) => e.preventDefault()}
                          style={{ color: 'var(--accent-color)', fontSize: '0.78rem', textDecoration: 'none' }}
                          title="Open this call from the customer's own history"
                        >
                          recording available
                        </a>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            )}
          </>
        ) : (
          <>
            {/* Always rendered. A call with no recording must SAY so — an
                absent section reads as a broken page, which is exactly how
                the missing-transcript case looked before. */}
            {transcript.recording_url ? (
              <RecordingPlayer url={crmRecordingUrl(transcript.recording_url)} />
            ) : (
              <div style={sectionBox} data-testid="call-detail-no-recording">
                <SectionTitle>Recording</SectionTitle>
                <div style={{ fontSize: '0.85rem', color: 'var(--text-secondary)' }}>
                  No recording available for this call.
                </div>
              </div>
            )}

            {/* A manual call is two humans talking — Callified's AI is not on
                the line, so it produces no dialogue and no meaningful review.
                Verified against live data: genuine manual calls come back with
                ZERO transcript turns and a default `score 0 / neutral`, while
                the transcripts that DO carry turns contain the AI's own script
                ("I'm Aditya calling from EmpMonitor…") — i.e. they belong to AI
                calls and were being mis-attributed here by duration matching.
                Showing either would be inventing an assessment of a
                conversation the AI never heard. Recording only. */}
            {isManual && (
              <div style={{ ...infoRow, paddingTop: 0 }}>
                Manual calls are not transcribed or scored — Callified records the
                audio only.
              </div>
            )}

            {!isManual && review && (
              <div style={sectionBox}>
                <SectionTitle>AI review</SectionTitle>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.4rem', marginBottom: '0.5rem' }}>
                  {typeof review.quality_score === 'number' && <Chip>Score {review.quality_score}/10</Chip>}
                  {review.sentiment && <Chip>{review.sentiment}</Chip>}
                  <Chip>{review.appointment_booked ? 'Appointment booked' : 'No appointment'}</Chip>
                </div>
                {review.summary && <p style={bodyText}>{review.summary}</p>}
              </div>
            )}

            {/* AI calls only. Always rendered for them, because a transcript
                can exist with a recording but ZERO turns and omitting the
                section entirely reads as a broken page. */}
            {!isManual && (
            <div style={sectionBox} data-testid="call-detail-transcript">
              <SectionTitle>Transcript</SectionTitle>
              {turns.length === 0 ? (
                <div style={{ fontSize: '0.85rem', color: 'var(--text-secondary)' }}>
                  No transcript was captured for this call.
                </div>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem', maxHeight: 320, overflowY: 'auto' }}>
                  {turns.map((line, i) => (
                    <div key={i} style={{ fontSize: '0.85rem' }}>
                      {/* speakerLabel, not `role === 'agent'`: the live API
                          sends "AI" / "User", so an equality check on 'agent'
                          labelled every line — including the agent's own —
                          as the customer. */}
                      <span
                        style={{
                          color: isAgentTurn(line.role) ? 'var(--accent-color)' : '#3b82f6',
                          fontWeight: 600,
                        }}
                      >
                        {speakerLabel(line.role)}:
                      </span>{' '}
                      <span style={{ color: 'var(--text-secondary)' }}>{line.text}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

/** Authenticated blob fetch — an <audio src> cannot send the bearer header. */
function RecordingPlayer({ url }) {
  const [objectUrl, setObjectUrl] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => () => { if (objectUrl) URL.revokeObjectURL(objectUrl); }, [objectUrl]);

  // Callified serves recordings from its own object storage now, on a
  // different origin. Only OUR proxy wants OUR token — sending it to the
  // storage host got a 401 back on audio that was perfectly fine.
  const needsAuth = recordingNeedsCrmAuth(url);

  const load = async () => {
    if (loading || objectUrl) return;
    setLoading(true);
    setError('');
    try {
      const res = await fetch(url, needsAuth ? { headers: { Authorization: `Bearer ${getAuthToken()}` } } : {});
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(
          body.error ||
            (res.status === 404
              ? 'The recording is not ready yet. Callified saves it a minute or two after the call ends.'
              : 'The recording could not be loaded. Please try again shortly.'),
        );
      }
      setObjectUrl(URL.createObjectURL(await res.blob()));
    } catch (e) {
      setError(e?.message || 'The recording could not be loaded.');
    } finally {
      setLoading(false);
    }
  };

  if (error) return <div style={{ ...infoRow, color: '#ef4444' }}><AlertCircle size={16} /> {error}</div>;

  return (
    <div style={sectionBox}>
      <SectionTitle>Recording</SectionTitle>
      {objectUrl ? (
        <audio controls autoPlay src={objectUrl} style={{ width: '100%', height: 34 }} data-testid="call-detail-audio">
          Your browser does not support the audio element.
        </audio>
      ) : (
        <button type="button" className="btn-secondary" onClick={load} disabled={loading} data-testid="call-detail-play" style={{ display: 'inline-flex', alignItems: 'center', gap: '0.4rem', padding: '0.35rem 0.75rem', fontSize: '0.8rem' }}>
          {loading ? <><Loader size={14} style={{ animation: 'spin 1s linear infinite' }} /> Loading…</> : <><Play size={14} /> Play recording</>}
        </button>
      )}
    </div>
  );
}

// ── presentation helpers ───────────────────────────────────────────────────

function ModePill({ mode }) {
  const browser = mode === 'browser';
  return (
    <span style={{ ...pillBase, background: browser ? 'rgba(99,102,241,0.12)' : 'rgba(16,185,129,0.12)', color: browser ? '#6366f1' : '#10b981' }}>
      {browser ? <User size={11} /> : <Bot size={11} />} {browser ? 'Manual' : 'AI'}
    </span>
  );
}

function StatusPill({ status }) {
  const palette = {
    COMPLETED: { fg: '#10b981', bg: 'rgba(16,185,129,0.12)' },
    CONNECTED: { fg: '#3b82f6', bg: 'rgba(59,130,246,0.12)' },
    INITIATED: { fg: '#f59e0b', bg: 'rgba(245,158,11,0.12)' },
    MISSED: { fg: '#f59e0b', bg: 'rgba(245,158,11,0.12)' },
    FAILED: { fg: '#ef4444', bg: 'rgba(239,68,68,0.12)' },
  }[status] || { fg: 'var(--text-secondary)', bg: 'var(--subtle-bg-3)' };
  return <span style={{ ...pillBase, background: palette.bg, color: palette.fg }}>{status || '—'}</span>;
}

function Chip({ children }) {
  return <span style={{ ...pillBase, background: 'var(--subtle-bg-3)', color: 'var(--text-secondary)' }}>{children}</span>;
}

function SectionTitle({ children }) {
  return <div style={{ fontSize: '0.72rem', textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--text-secondary)', marginBottom: '0.5rem', fontWeight: 600 }}>{children}</div>;
}

function formatDate(iso) {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

function formatTime(iso) {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function Th({ children }) {
  return <th style={{ position: 'sticky', top: 0, zIndex: 4, padding: '0.6rem 0.85rem', fontWeight: 600, fontSize: '0.75rem', textTransform: 'uppercase', letterSpacing: '0.04em', color: 'var(--text-secondary)', whiteSpace: 'nowrap', background: 'var(--bg-color)', boxShadow: 'inset 0 -1px 0 var(--border-color)' }}>{children}</th>;
}

function Td({ children, colSpan, center, style }) {
  return <td colSpan={colSpan} style={{ padding: '0.6rem 0.85rem', verticalAlign: 'middle', textAlign: center ? 'center' : 'left', color: center ? 'var(--text-secondary)' : 'inherit', ...style }}>{children}</td>;
}

const headerStyle = { display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: '1rem', marginBottom: '1.25rem', flexWrap: 'wrap' };
const filterBarStyle = { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 170px), 1fr))', gap: '0.6rem', marginBottom: '1rem', padding: '0.75rem', border: '1px solid var(--border-color)', borderRadius: 8, background: 'var(--subtle-bg-2)' };
const fieldLabel = { fontSize: '0.75rem', color: 'var(--text-secondary)', display: 'flex', flexDirection: 'column', gap: '0.25rem' };
const searchIconStyle = { position: 'absolute', top: '50%', left: 8, transform: 'translateY(-50%)', color: 'var(--text-secondary)', pointerEvents: 'none' };
const errorBoxStyle = { background: 'rgba(239,68,68,0.1)', color: '#ef4444', padding: '0.75rem', borderRadius: 8, marginBottom: '1rem' };
const tableShellStyle = { border: '1px solid var(--border-color)', borderRadius: 12, overflow: 'auto', maxHeight: 'calc(100vh - 380px)', background: 'var(--surface-color)' };
const pagerStyle = { marginTop: '0.75rem', display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '1rem', flexWrap: 'wrap' };
const pagerBtnStyle = { display: 'inline-flex', alignItems: 'center', gap: '0.3rem', padding: '0.35rem 0.7rem', fontSize: '0.8rem' };
const pillBase = { display: 'inline-flex', alignItems: 'center', gap: '0.25rem', padding: '0.15rem 0.5rem', borderRadius: 999, fontSize: '0.72rem', fontWeight: 600, whiteSpace: 'nowrap' };
const drawerBackdrop = { position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.65)', display: 'flex', justifyContent: 'flex-end', zIndex: 1002 };
const drawerPanel = { width: '100%', maxWidth: 480, height: '100%', overflowY: 'auto', padding: '1.5rem', borderRadius: 0 };
const infoRow = { display: 'flex', alignItems: 'center', gap: '0.5rem', padding: '0.9rem 0', color: 'var(--text-secondary)', fontSize: '0.87rem' };
const sectionBox = { padding: '0.9rem', borderRadius: 10, border: '1px solid var(--border-color)', marginBottom: '0.9rem' };
const bodyText = { margin: 0, fontSize: '0.85rem', color: 'var(--text-secondary)', lineHeight: 1.5 };
