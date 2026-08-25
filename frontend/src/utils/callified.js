// Shared helpers for logging CRM users into Callified via SSO.
//
// Consumed by:
//   - frontend/src/components/Sidebar.jsx (left-menu link)
//   - frontend/src/pages/wellness/OwnerDashboard.jsx (dashboard card)
//
// Flow:
//   1. Frontend calls CRM backend: GET /api/integrations/callified/auth-url
//   2. Backend generates JWT signed with Callified secret, returns full auth URL
//   3. Frontend opens the URL in a new tab
//   4. Callified validates JWT and logs user into dashboard

import { fetchApi } from './api';

/**
 * Launch Callified dashboard with SSO authentication for the current CRM user.
 * Calls the CRM backend to get a signed JWT auth URL, then opens it in a new tab.
 *
 * @throws {Error} if the backend call fails or Callified is not configured
 * @returns {Promise<string>} the target URL that was opened
 */
export async function launchCallifiedSSO() {
  // Step 1 — fetch auth URL from CRM backend (with Bearer token auth)
  const data = await fetchApi('/api/integrations/callified/auth-url', { silent: false });

  if (!data?.authUrl) {
    throw new Error('Backend did not return an auth URL');
  }

  // Step 2 — open Callified dashboard in new tab with JWT token
  window.open(data.authUrl, '_blank', 'noopener,noreferrer');

  return data.authUrl;
}

/**
 * Rewrite a Callified `recording_url` to the CRM's streaming proxy.
 *
 * Callified returns a path on THEIR host (`/api/recordings/<org>/<…>.wav`),
 * and that endpoint sits behind their Bearer JWT — they explicitly removed the
 * `?token=` query fallback so the credential never lands in a URL. Rendered
 * as-is the browser resolves it against the CRM's own origin, hits our API and
 * gets a 404, which is why a player fed the raw value sits at 0:00 / 0:00.
 *
 * `/api/callified/recordings/*` streams the bytes with the tenant's Callified
 * token attached server-side. Already-absolute URLs are left alone.
 *
 * Note the result still needs an authenticated fetch (blob → object URL) — an
 * `<audio src>` cannot send the CRM's own bearer header either.
 */
export function crmRecordingUrl(recordingUrl) {
  const raw = String(recordingUrl || '').trim();
  if (!raw) return '';
  if (/^https?:\/\//i.test(raw)) return raw;
  const path = raw.replace(/^\/?api\/recordings\/?/, '');
  if (!path) return '';
  return `/api/callified/recordings/${path}`;
}

/**
 * Does this recording URL need the CRM's own bearer token?
 *
 * Callified used to return a relative path behind ITS auth, which we proxy —
 * those go through /api/callified/recordings and do need our token. It now
 * also returns absolute object-storage URLs
 * (https://objectstorage.…oraclecloud.com/…), which are a different origin
 * entirely. Sending our bearer there is pointless and harmful: the storage
 * host rejects the unknown credential, which surfaced as "Could not load the
 * recording (401)" on calls whose audio was perfectly fine.
 */
export function recordingNeedsCrmAuth(url) {
  return typeof url === 'string' && url.startsWith('/api/');
}


/** Human-readable call length. Zero/absent reads as "—", not "0s". */
export function formatCallDuration(seconds) {
  const s = Math.round(Number(seconds) || 0);
  if (!s) return '—';
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m ${s % 60}s`;
}

/**
 * Pair a CRM call attempt with its Callified transcript.
 *
 * WHY THIS IS HARDER THAN IT LOOKS
 *   Callified stores transcripts against the LEAD, not the call, and the
 *   transcript payload carries no join key back to a specific attempt — the
 *   fields are `id, lead_id, campaign_id, transcript, recording_url,
 *   tts_language, call_duration_s, created_at` and nothing else. No call_sid.
 *   (API_FLOW.md flags the same gap for billing: "the call-log API does not
 *   currently expose call_sid".)
 *
 *   `created_at` is NOT the call time — it is when Callified finished
 *   post-processing. Observed: a call the CRM logged at Aug 24 14:43 UTC has a
 *   transcript stamped Aug 25 11:52, ~21 hours later. Matching on it produces
 *   confident-looking nonsense.
 *
 *   `call_duration_s` is the one field that genuinely corresponds, and it
 *   matches the CRM's own measured duration to the second.
 *
 * So: match on duration, and ONLY when it is unambiguous. A tie means two
 * calls of the same length against one customer, and guessing between them
 * would attribute the wrong conversation to the wrong call — worse than
 * showing nothing. Callers fall back to listing every transcript for the
 * customer instead.
 *
 * @returns {{transcript: object, review: object|null} | null}
 */
export function matchTranscriptByDuration(details, callDurationSeconds, toleranceSeconds = 1) {
  const transcripts = Array.isArray(details?.transcripts) ? details.transcripts : [];
  const reviews = Array.isArray(details?.reviews) ? details.reviews : [];

  const target = Math.round(Number(callDurationSeconds) || 0);
  // A call with no duration never connected — there is nothing to transcribe.
  if (!target || !transcripts.length) return null;

  const hits = transcripts.filter(
    (t) => Math.abs(Math.round(Number(t.call_duration_s) || 0) - target) <= toleranceSeconds,
  );
  if (hits.length !== 1) return null;

  const transcript = hits[0];
  const review = reviews.find((r) => r && !r.error && r.transcript_id === transcript.id) || null;
  return { transcript, review };
}

/** Every transcript for the lead, newest-processed first, with its review. */
export function allTranscripts(details) {
  const transcripts = Array.isArray(details?.transcripts) ? details.transcripts : [];
  const reviews = Array.isArray(details?.reviews) ? details.reviews : [];
  return [...transcripts]
    .sort((a, b) => new Date(b.created_at || 0) - new Date(a.created_at || 0))
    .map((transcript) => ({
      transcript,
      review: reviews.find((r) => r && !r.error && r.transcript_id === transcript.id) || null,
    }));
}

/**
 * Normalise one transcript turn's speaker into a display label.
 *
 * API_FLOW.md documents `{"role": "agent"}` / `{"role": "user"}`. The live API
 * returns **`"AI"` and `"User"`**. A `role === 'agent'` check therefore fell
 * through to the else-branch for EVERY line, labelling the agent's own speech
 * as the customer's — the whole conversation attributed to the wrong party.
 *
 * Both vocabularies are accepted, and anything unrecognised is echoed back
 * rather than silently bucketed, so the next vocabulary change is visible
 * instead of quietly wrong.
 */
export function speakerLabel(role) {
  const value = String(role || '').trim().toLowerCase();
  if (['ai', 'agent', 'assistant', 'bot'].includes(value)) return 'Agent';
  if (['user', 'customer', 'human', 'lead'].includes(value)) return 'Customer';
  return role ? String(role) : 'Unknown';
}

/** True when the speaker is the AI/agent side, for styling. */
export function isAgentTurn(role) {
  return speakerLabel(role) === 'Agent';
}

/**
 * Transcript turns as an array, whatever shape the API used.
 *
 * A transcript can legitimately exist with ZERO turns — recording and AI
 * review present, no dialogue captured (observed on several short calls). The
 * caller must render an explicit "no transcript" state for that rather than
 * omitting the section, which reads as a rendering bug.
 */
export function parseTranscriptTurns(transcript) {
  if (Array.isArray(transcript)) return transcript;
  if (typeof transcript === 'string' && transcript.trim()) {
    try {
      const parsed = JSON.parse(transcript);
      return Array.isArray(parsed) ? parsed : [];
    } catch (_e) {
      return [];
    }
  }
  return [];
}

/**
 * Turn a getUserMedia failure into something the staff member can act on.
 *
 * The browser's own text ("Requested device not found") names the problem in
 * spec language and never says what to do about it.
 */
export function describeMediaError(e) {
  const name = e?.name || '';
  if (name === 'NotFoundError' || name === 'DevicesNotFoundError') {
    return 'No microphone found. Connect a microphone or headset, then try again.';
  }
  if (name === 'NotAllowedError' || name === 'SecurityError') {
    return 'Microphone access was blocked. Allow the microphone for this site in your browser, then try again.';
  }
  if (name === 'NotReadableError' || name === 'TrackStartError') {
    return 'Your microphone is being used by another app. Close it (Zoom, Meet, Teams…) and try again.';
  }
  if (name === 'OverconstrainedError') {
    return 'Your microphone does not support the audio settings this call needs.';
  }
  return `Could not open the microphone: ${e?.message || e}`;
}

/**
 * Open the microphone, reporting failures in plain language.
 *
 * Called BEFORE a manual call is placed, not after. Callified dials the
 * customer the moment the manual-call request succeeds, and the only way to
 * hang that leg up again is a `{"type":"hangup"}` frame over the agent
 * WebSocket — which cannot be sent if the microphone never opened and the
 * socket was therefore never created. Checking first means a machine with no
 * microphone never rings the customer at all, instead of leaving them on a
 * live line listening to silence.
 *
 * @returns {Promise<MediaStream>}
 */
export async function acquireMicrophone() {
  if (!navigator?.mediaDevices?.getUserMedia) {
    throw new Error('This browser cannot access a microphone, so calls cannot be placed from it.');
  }
  try {
    return await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
      video: false,
    });
  } catch (e) {
    throw new Error(describeMediaError(e));
  }
}

/**
 * Verify a working microphone WITHOUT keeping it open.
 *
 * Used as a pre-flight before a manual call is placed. It must not hand the
 * stream on to the bridge: React StrictMode double-mounts the live-call panel,
 * and the discarded first bridge stops the tracks of whatever stream it holds
 * — so a shared stream leaves the bridge that is actually on screen with dead
 * tracks and a silent microphone, i.e. the agent can hear the customer but is
 * never heard back.
 *
 * The bridge therefore opens its own stream. Permission is already granted by
 * then, so that second request raises no prompt.
 */
export async function probeMicrophone() {
  const stream = await acquireMicrophone();
  stream.getTracks().forEach((track) => track.stop());
}

/** Local YYYY-MM-DD — the shape the date inputs and range calendar both use. */
function isoDay(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/**
 * Calendar week (Monday-start) or calendar month, up to today.
 *
 * Deliberately calendar periods rather than rolling 7/30 days: "this week"
 * should mean the same range for everyone in the clinic looking at the same
 * screen, not a window that shifts with the hour they happened to open it.
 */
export function presetRange(period, today = new Date()) {
  const end = isoDay(today);
  if (period === 'month') {
    return { from: isoDay(new Date(today.getFullYear(), today.getMonth(), 1)), to: end };
  }
  if (period === 'week') {
    const start = new Date(today);
    // getDay(): 0 = Sunday. Shift so Monday is the first day of the week.
    const offset = (start.getDay() + 6) % 7;
    start.setDate(start.getDate() - offset);
    return { from: isoDay(start), to: end };
  }
  return { from: '', to: '' };
}
