/**
 * CallifiedEmbed.test.jsx — vitest + RTL coverage for the in-shell Callified
 * iframe embed page (frontend/src/pages/wellness/CallifiedEmbed.jsx, shipped
 * via #832 to replace the new-tab launcher with an in-shell iframe).
 *
 * Scope — pins the page-surface invariants for the 3-state SSO-iframe-embed
 * surface. CallifiedEmbed is the LIGHTEST of the Callified pages (vs. the
 * admin CallifiedCalls page with its DC-7 flag + cap-pill + initiate form):
 * this page just signs into Callified via the same `/auth-url` SSO endpoint
 * the old new-tab launcher used and stuffs the returned JWT URL into an
 * `<iframe src>` so users stay inside the CRM shell.
 *
 * Three render states the SUT branches over:
 *
 *   1. status="loading" (initial + during refetch): renders a Loader2 spinner +
 *      "Signing you into Callified…" copy. NO iframe, NO header strip, NO
 *      error card.
 *   2. status="error" (auth-url fetch rejected OR resolved with no authUrl):
 *      renders a glass card with the AlertTriangle icon + "Couldn't open
 *      Callified" heading + the error message + a "Retry" button that
 *      re-fires the auth-url GET. NO iframe.
 *   3. status="ready" (auth-url GET resolved with a string authUrl):
 *      renders the header strip (PhoneCall icon + "Callified" label +
 *      "Voice & WhatsApp" sub-label + "Open in new tab" fallback anchor) +
 *      the iframe with src=authUrl + title="Callified Voice and WhatsApp" +
 *      the `allow="microphone; camera; clipboard-read; clipboard-write"`
 *      permissions list. NO spinner, NO error card.
 *
 * Edge surfaces the tests pin:
 *   - "not yet available" friendly-error rewrite: when the backend error
 *     message includes the literal substring "not yet available" the SUT
 *     rewrites the surfaced copy to "Callified integration is not yet
 *     configured for this tenant. Contact your administrator." (a
 *     friendlier framing than the raw backend error).
 *   - Retry button re-fires the GET: clicking Retry on the error state
 *     transitions back through loading → ready when the second GET
 *     succeeds.
 *   - Backend resolves with no authUrl field: the SUT treats this as an
 *     error state with the literal copy "Backend did not return an auth
 *     URL" (defensive — protects against a backend bug returning {} or
 *     null).
 *   - "Open in new tab" fallback anchor: even on the ready state, the
 *     header surfaces an `<a href={authUrl} target="_blank">` so users can
 *     bail to a new tab if the iframe blocks (X-Frame-Options /
 *     frame-ancestors CSP — see SUT's "TODO #832 follow-up" note).
 *
 * Backend contract pinned (per backend/routes/integrations.js):
 *   GET /api/integrations/callified/auth-url → 200 { authUrl: string }
 *                                            | 4xx { error: string,
 *                                                   message?: "...not yet available..." }
 *                                            | network reject
 *
 * Drift pinned around (prompt vs. actual code):
 *   - Prompt mentioned "click-to-call CTA" / "POST to initiate" / "call
 *     lifecycle (initiate, in-progress, ended)" / "call-duration timer".
 *     The SUT has NONE of those — that's the admin CallifiedCalls page,
 *     covered separately by CallifiedCalls.test.jsx (tick #112). This page
 *     is purely an iframe-embed shell; Callified itself owns all call
 *     lifecycle UX inside the iframe, opaque to this SUT.
 *   - Prompt mentioned "sender context (patient + clinic + agent)".
 *     The SUT does NOT pass any per-patient / per-clinic context as query
 *     params — it just renders the authUrl the backend returns. The backend
 *     bakes tenant-scope into the signed JWT; the iframe URL carries no
 *     plaintext context.
 *   - Prompt said the SUT might consume AuthContext. The SUT does NOT —
 *     it only consumes fetchApi (which carries the JWT internally via
 *     localStorage in `utils/api.js`). No AuthContext Provider needed in
 *     the test render tree.
 *
 * Mocking discipline (per CLAUDE.md RTL standing rules)
 *   - fetchApi mocked at ../utils/api (the page's dependency, NOT global
 *     fetch). vi.mock path is `../utils/api` relative to THIS test file.
 *   - No useNotify mock — the SUT doesn't use it (errors render inline).
 *   - No router wrapper — the SUT renders no RouterLink (the "Open in new
 *     tab" anchor is a plain `<a>`, not a react-router Link).
 *   - All data-dependent assertions use await findBy / waitFor (per CLAUDE.md
 *     tick #108 cron-learning: sync getBy for data-dependent text is a CI
 *     race trap).
 *
 * Path: flat __tests__/ per tick #111 path-coordination.
 *
 * Note: this is the LAST wellness-vertical page to receive unit-test coverage.
 * After this commit, the wellness page test gap is fully drained.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

const fetchApiMock = vi.fn();
vi.mock('../utils/api', () => ({
  fetchApi: (...args) => fetchApiMock(...args),
  getAuthToken: () => 'test-token',
}));

import CallifiedEmbed from '../pages/wellness/CallifiedEmbed';

const STUB_AUTH_URL = 'https://app.callified.ai/sso?token=stub-jwt-abc';
const SECOND_AUTH_URL = 'https://app.callified.ai/sso?token=stub-jwt-second';

beforeEach(() => {
  fetchApiMock.mockReset();
});

describe('<CallifiedEmbed /> — initial loading state', () => {
  it('renders the spinner + "Signing you into Callified…" copy while the auth-url GET is pending', async () => {
    // Pending promise — never resolves so the SUT stays in the loading branch.
    fetchApiMock.mockImplementation(() => new Promise(() => {}));
    render(<CallifiedEmbed />);
    expect(screen.getByText(/Signing you into Callified/i)).toBeInTheDocument();
    // None of the other branches render.
    expect(screen.queryByText(/Couldn't open Callified/i)).toBeNull();
    expect(screen.queryByRole('button', { name: /Retry/i })).toBeNull();
    expect(screen.queryByTitle(/Callified Voice and WhatsApp/i)).toBeNull();
    // The fetch fired against the right endpoint with silent:true so global
    // toast plumbing in utils/api stays quiet for this UX.
    await waitFor(() => {
      expect(fetchApiMock).toHaveBeenCalledWith(
        '/api/integrations/callified/auth-url',
        expect.objectContaining({ silent: true }),
      );
    });
  });
});

describe('<CallifiedEmbed /> — ready state (authUrl returned, iframe renders)', () => {
  it('renders the header strip + iframe with src=authUrl when the GET resolves', async () => {
    fetchApiMock.mockResolvedValue({ authUrl: STUB_AUTH_URL });
    render(<CallifiedEmbed />);
    // Header strip: "Callified" label + sub-label.
    expect(await screen.findByText('Callified')).toBeInTheDocument();
    expect(screen.getByText(/Voice & WhatsApp/i)).toBeInTheDocument();
    // The iframe surfaces with the SUT's literal title attribute.
    const iframe = screen.getByTitle('Callified Voice and WhatsApp');
    expect(iframe.tagName).toBe('IFRAME');
    expect(iframe).toHaveAttribute('src', STUB_AUTH_URL);
    // The SUT explicitly grants these permissions for in-iframe Callified.
    expect(iframe).toHaveAttribute(
      'allow',
      'microphone; camera; clipboard-read; clipboard-write',
    );
    // Spinner + error card are gone.
    expect(screen.queryByText(/Signing you into Callified/i)).toBeNull();
    expect(screen.queryByText(/Couldn't open Callified/i)).toBeNull();
  });

  it('renders the "Open in new tab" fallback anchor pointing at authUrl with target=_blank + rel=noopener', async () => {
    fetchApiMock.mockResolvedValue({ authUrl: STUB_AUTH_URL });
    render(<CallifiedEmbed />);
    const link = await screen.findByRole('link', {
      name: /Open Callified in a new tab/i,
    });
    expect(link).toHaveAttribute('href', STUB_AUTH_URL);
    expect(link).toHaveAttribute('target', '_blank');
    // rel attribute carries both noopener + noreferrer for the cross-origin link.
    expect(link.getAttribute('rel')).toMatch(/noopener/);
    expect(link.getAttribute('rel')).toMatch(/noreferrer/);
  });
});

describe('<CallifiedEmbed /> — error state branching', () => {
  it('renders the error card with "Backend did not return an auth URL" when the GET resolves without authUrl', async () => {
    // Defensive: the SUT treats {} (or null authUrl) as an error rather than
    // rendering an iframe with src="undefined".
    fetchApiMock.mockResolvedValue({});
    render(<CallifiedEmbed />);
    expect(
      await screen.findByText(/Couldn't open Callified/i),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/Backend did not return an auth URL/i),
    ).toBeInTheDocument();
    // No iframe; the Retry CTA renders.
    expect(screen.queryByTitle(/Callified Voice and WhatsApp/i)).toBeNull();
    expect(screen.getByRole('button', { name: /Retry/i })).toBeInTheDocument();
  });

  it('renders the raw err.message in the error card when the GET rejects with a non-special message', async () => {
    fetchApiMock.mockRejectedValue(new Error('Upstream 503 from Callified'));
    render(<CallifiedEmbed />);
    expect(
      await screen.findByText(/Couldn't open Callified/i),
    ).toBeInTheDocument();
    expect(
      screen.getByText('Upstream 503 from Callified'),
    ).toBeInTheDocument();
  });

  it('rewrites "not yet available" backend errors to the friendly tenant-admin copy', async () => {
    // The SUT's `err.message?.includes('not yet available')` branch swaps the
    // raw backend error for a customer-facing framing.
    fetchApiMock.mockRejectedValue(
      new Error('Callified integration is not yet available for this tenant'),
    );
    render(<CallifiedEmbed />);
    expect(
      await screen.findByText(
        /Callified integration is not yet configured for this tenant\. Contact your administrator\./i,
      ),
    ).toBeInTheDocument();
    // The raw backend error is NOT surfaced verbatim — the rewrite replaces it.
    expect(
      screen.queryByText(/is not yet available for this tenant/i),
    ).toBeNull();
  });

  it('falls back to "Failed to sign in to Callified" when the rejected error has no message field', async () => {
    // Some upstream callers throw bare objects without a .message — the SUT
    // has a string-fallback for that surface.
    fetchApiMock.mockRejectedValue({});
    render(<CallifiedEmbed />);
    expect(
      await screen.findByText(/Failed to sign in to Callified/i),
    ).toBeInTheDocument();
  });
});

describe('<CallifiedEmbed /> — Retry CTA re-fires the GET', () => {
  it('clicking Retry after an error re-fires the auth-url GET and transitions to ready on success', async () => {
    // First GET rejects → error state; second GET (after Retry click) resolves
    // → iframe state. Pins that loadAuthUrl is re-callable via the button.
    fetchApiMock
      .mockRejectedValueOnce(new Error('transient network blip'))
      .mockResolvedValueOnce({ authUrl: SECOND_AUTH_URL });
    render(<CallifiedEmbed />);
    // Wait for the error surface.
    const retryBtn = await screen.findByRole('button', { name: /Retry/i });
    expect(retryBtn).toBeInTheDocument();
    expect(fetchApiMock).toHaveBeenCalledTimes(1);

    fireEvent.click(retryBtn);

    // After the second GET resolves the iframe lands.
    const iframe = await screen.findByTitle('Callified Voice and WhatsApp');
    expect(iframe).toHaveAttribute('src', SECOND_AUTH_URL);
    // The error card is gone.
    expect(screen.queryByText(/Couldn't open Callified/i)).toBeNull();
    // Exactly two GETs fired across the mount + retry.
    expect(fetchApiMock).toHaveBeenCalledTimes(2);
  });
});
