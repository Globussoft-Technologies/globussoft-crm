/**
 * SurveyPublic.test.jsx — vitest + RTL coverage for the public (unauthed)
 * /survey/:id survey-response page that recipients reach via shareable URL.
 *
 * Test-coverage-drain tick — adds first unit coverage for
 * frontend/src/pages/SurveyPublic.jsx (251 LOC). The SUT is the public
 * survey-response surface mounted OUTSIDE the authenticated <Layout> (so no
 * admin sidebar / nav leaks to recipients). It GETs /api/surveys/public/:id
 * to load the survey and POSTs /api/surveys/public/:id/respond on submit.
 * Patient attribution token is read from the ?p= query string.
 *
 * Scope — pins the page-surface invariants:
 *   1. Mount fires GET /api/surveys/public/:id with the URL :id param.
 *   2. Loading copy ("Loading…") renders while the GET is in-flight.
 *   3. 404 response renders the "Survey not found." copy.
 *   4. 410 response renders the "no longer accepting responses." copy.
 *   5. 5xx response renders the generic "Unable to load survey" copy.
 *   6. NPS surveys render the 0-10 scale-hint copy + 11 score buttons (0..10).
 *   7. CSAT surveys render the 1-5 scale-hint copy + 6 score buttons (Star icons).
 *   8. Generic (non-NPS/non-CSAT) surveys default to 0-10 + the generic hint.
 *   9. Brand name renders in the brand chip AND mutates document.title.
 *  10. Score-button click sets aria-pressed=true on the chosen number.
 *  11. Submitting without picking a score blocks POST + shows the
 *      "Please pick a score" error.
 *  12. Happy-path submit POSTs to /respond with score + comment + p token,
 *      then renders the "Thank you!" completion screen.
 *  13. Submit error (non-ok response with {error: ...}) surfaces the
 *      server-supplied error string.
 *  14. Submit network throw renders the "Network error" copy.
 *  15. Submit button disables + shows "Submitting…" while the POST is
 *      in-flight.
 *  16. Comment trims to null when blank/whitespace-only (POST payload
 *      contract).
 *  17. Patient token from ?p= query string flows into the POST body.
 *
 * Drift notes pinned during authoring:
 *   - SUT uses NATIVE fetch (not fetchApi from utils/api), so global.fetch
 *     is per-test stubbed.
 *   - SUT uses useParams() + useSearchParams() — must wrap in MemoryRouter
 *     + Routes + Route with path="/survey/:id" so the param is populated.
 *     The ?p= query string flows through useSearchParams.
 *   - SUT has no AuthContext / useNotify / useApi consumption (public page).
 *   - Comment trimming: SUT sends `comment.trim() || null`, so the spec
 *     pins the null when only whitespace was typed.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Routes, Route } from 'react-router-dom';

import SurveyPublic from '../pages/SurveyPublic';

const SURVEY_ID = 'srv_abc123';
const PATIENT_TOKEN = 'patient_tok_xyz';

function makeSurvey(overrides = {}) {
  return {
    id: SURVEY_ID,
    type: 'NPS',
    question: 'How was your recent visit?',
    brand: { name: 'Enhanced Wellness' },
    ...overrides,
  };
}

function renderPage({ id = SURVEY_ID, patientToken } = {}) {
  const search = patientToken ? `?p=${patientToken}` : '';
  return render(
    <MemoryRouter initialEntries={[`/survey/${id}${search}`]}>
      <Routes>
        <Route path="/survey/:id" element={<SurveyPublic />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('SurveyPublic — public survey-response page surface', () => {
  beforeEach(() => {
    global.fetch = vi.fn();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('fires GET /api/surveys/public/:id on mount with the URL :id param', async () => {
    global.fetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: () => Promise.resolve(makeSurvey()),
    });

    renderPage({ id: SURVEY_ID });

    await waitFor(() => expect(global.fetch).toHaveBeenCalled());
    expect(global.fetch).toHaveBeenCalledWith(`/api/surveys/public/${SURVEY_ID}`);
    // Public endpoint — no Authorization header, no options arg.
    expect(global.fetch.mock.calls[0][1]).toBeUndefined();
  });

  it('renders the "Loading…" copy while the GET is in flight', () => {
    // Never-resolving fetch keeps the loading state visible.
    global.fetch.mockReturnValue(new Promise(() => {}));
    renderPage();
    expect(screen.getByText(/Loading/i)).toBeInTheDocument();
  });

  it('renders the "Survey not found." copy when GET returns 404', async () => {
    global.fetch.mockResolvedValueOnce({
      ok: false,
      status: 404,
      json: () => Promise.resolve({}),
    });
    renderPage();

    expect(await screen.findByText(/Survey not found/i)).toBeInTheDocument();
    // No submit form on the error path.
    expect(screen.queryByRole('button', { name: /Submit feedback/i })).not.toBeInTheDocument();
  });

  it('renders the "no longer accepting responses" copy when GET returns 410', async () => {
    global.fetch.mockResolvedValueOnce({
      ok: false,
      status: 410,
      json: () => Promise.resolve({}),
    });
    renderPage();

    expect(
      await screen.findByText(/no longer accepting responses/i),
    ).toBeInTheDocument();
  });

  it('renders the generic "Unable to load survey" copy on a non-2xx (500) response', async () => {
    global.fetch.mockResolvedValueOnce({
      ok: false,
      status: 500,
      json: () => Promise.resolve({}),
    });
    renderPage();

    expect(await screen.findByText(/Unable to load survey/i)).toBeInTheDocument();
  });

  it('renders the NPS 0-10 scale-hint copy + 11 score buttons (0..10) for an NPS survey', async () => {
    global.fetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: () => Promise.resolve(makeSurvey({ type: 'NPS' })),
    });
    renderPage();

    expect(
      await screen.findByText(/On a scale of 0.10, how likely are you to recommend/i),
    ).toBeInTheDocument();
    // 0 through 10 inclusive = 11 buttons, each with aria-label "Score N".
    for (let n = 0; n <= 10; n += 1) {
      expect(screen.getByRole('button', { name: `Score ${n}` })).toBeInTheDocument();
    }
  });

  it('renders the CSAT 1-5 scale-hint copy + 6 score buttons (0..5) for a CSAT survey', async () => {
    global.fetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: () => Promise.resolve(makeSurvey({ type: 'CSAT' })),
    });
    renderPage();

    expect(
      await screen.findByText(/How satisfied were you/i),
    ).toBeInTheDocument();
    // CSAT has 6 buttons (0..5). NPS would have 11.
    for (let n = 0; n <= 5; n += 1) {
      expect(screen.getByRole('button', { name: `Score ${n}` })).toBeInTheDocument();
    }
    // Score 6 must NOT exist on CSAT.
    expect(screen.queryByRole('button', { name: 'Score 6' })).not.toBeInTheDocument();
  });

  it('defaults to the generic "Please rate from 0 to 10" hint + 0-10 range for a non-NPS/non-CSAT type', async () => {
    global.fetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: () => Promise.resolve(makeSurvey({ type: 'OTHER' })),
    });
    renderPage();

    expect(
      await screen.findByText(/Please rate from 0 to 10/i),
    ).toBeInTheDocument();
    // Same 11-button range as NPS, but the hint copy differs.
    expect(screen.getByRole('button', { name: 'Score 10' })).toBeInTheDocument();
  });

  it('renders the brand name in the brand chip and mutates document.title', async () => {
    const originalTitle = document.title;
    global.fetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: () => Promise.resolve(makeSurvey({ brand: { name: 'Enhanced Wellness' } })),
    });
    renderPage();

    expect(await screen.findByText('Enhanced Wellness')).toBeInTheDocument();
    // document.title was updated to the brand name.
    await waitFor(() => expect(document.title).toBe('Enhanced Wellness'));
    document.title = originalTitle;
  });

  it('marks aria-pressed=true on the clicked score button', async () => {
    const user = userEvent.setup();
    global.fetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: () => Promise.resolve(makeSurvey({ type: 'NPS' })),
    });
    renderPage();

    const sevenBtn = await screen.findByRole('button', { name: 'Score 7' });
    expect(sevenBtn.getAttribute('aria-pressed')).toBe('false');
    await user.click(sevenBtn);
    expect(sevenBtn.getAttribute('aria-pressed')).toBe('true');
    // Other score buttons stay aria-pressed=false.
    expect(
      screen.getByRole('button', { name: 'Score 3' }).getAttribute('aria-pressed'),
    ).toBe('false');
  });

  it('blocks the submit POST + shows "Please pick a score" when no score is chosen', async () => {
    const user = userEvent.setup();
    global.fetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: () => Promise.resolve(makeSurvey({ type: 'NPS' })),
    });
    renderPage();

    const submit = await screen.findByRole('button', { name: /Submit feedback/i });
    await user.click(submit);

    expect(await screen.findByText(/Please pick a score before submitting/i)).toBeInTheDocument();
    // Only the initial GET fired — no POST.
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  it('happy-path submit POSTs /respond with score + comment + p token, then renders "Thank you!"', async () => {
    const user = userEvent.setup();
    global.fetch
      .mockResolvedValueOnce({
        // initial GET
        ok: true,
        status: 200,
        json: () => Promise.resolve(makeSurvey({ type: 'NPS' })),
      })
      .mockResolvedValueOnce({
        // POST /respond
        ok: true,
        status: 200,
        json: () => Promise.resolve({}),
      });

    renderPage({ patientToken: PATIENT_TOKEN });

    // Pick score 9.
    const nineBtn = await screen.findByRole('button', { name: 'Score 9' });
    await user.click(nineBtn);

    // Type a comment.
    const textarea = screen.getByRole('textbox');
    await user.type(textarea, 'Friendly staff!');

    await user.click(screen.getByRole('button', { name: /Submit feedback/i }));

    // POST call shape.
    await waitFor(() => expect(global.fetch).toHaveBeenCalledTimes(2));
    const [postUrl, postOpts] = global.fetch.mock.calls[1];
    expect(postUrl).toBe(`/api/surveys/public/${SURVEY_ID}/respond`);
    expect(postOpts.method).toBe('POST');
    expect(postOpts.headers).toEqual({ 'Content-Type': 'application/json' });
    const parsedBody = JSON.parse(postOpts.body);
    expect(parsedBody).toEqual({
      score: 9,
      comment: 'Friendly staff!',
      p: PATIENT_TOKEN,
    });

    // Completion screen.
    expect(await screen.findByText(/Thank you/i)).toBeInTheDocument();
    expect(
      screen.getByText(/Your feedback has been recorded/i),
    ).toBeInTheDocument();
  });

  it('surfaces the server-supplied {error} string when submit returns a non-ok response', async () => {
    const user = userEvent.setup();
    global.fetch
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: () => Promise.resolve(makeSurvey({ type: 'NPS' })),
      })
      .mockResolvedValueOnce({
        ok: false,
        status: 400,
        json: () => Promise.resolve({ error: 'You have already submitted a response.' }),
      });

    renderPage();

    await user.click(await screen.findByRole('button', { name: 'Score 8' }));
    await user.click(screen.getByRole('button', { name: /Submit feedback/i }));

    expect(
      await screen.findByText(/You have already submitted a response/i),
    ).toBeInTheDocument();
    // Completion screen MUST NOT appear on the error path.
    expect(screen.queryByText(/Thank you/i)).not.toBeInTheDocument();
  });

  it('falls back to "Failed to submit response" when the error response omits {error}', async () => {
    const user = userEvent.setup();
    global.fetch
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: () => Promise.resolve(makeSurvey({ type: 'NPS' })),
      })
      .mockResolvedValueOnce({
        ok: false,
        status: 500,
        json: () => Promise.resolve({}),
      });

    renderPage();

    await user.click(await screen.findByRole('button', { name: 'Score 5' }));
    await user.click(screen.getByRole('button', { name: /Submit feedback/i }));

    expect(
      await screen.findByText(/Failed to submit response/i),
    ).toBeInTheDocument();
  });

  it('renders "Network error" copy when the submit fetch throws', async () => {
    const user = userEvent.setup();
    global.fetch
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: () => Promise.resolve(makeSurvey({ type: 'NPS' })),
      })
      .mockRejectedValueOnce(new Error('socket hang up'));

    renderPage();

    await user.click(await screen.findByRole('button', { name: 'Score 4' }));
    await user.click(screen.getByRole('button', { name: /Submit feedback/i }));

    expect(
      await screen.findByText(/Network error/i),
    ).toBeInTheDocument();
  });

  it('disables the submit button + shows "Submitting…" while the POST is in flight', async () => {
    const user = userEvent.setup();
    let resolvePost;
    global.fetch
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: () => Promise.resolve(makeSurvey({ type: 'NPS' })),
      })
      .mockReturnValueOnce(
        new Promise((resolve) => {
          resolvePost = resolve;
        }),
      );

    renderPage();

    await user.click(await screen.findByRole('button', { name: 'Score 6' }));
    const submit = screen.getByRole('button', { name: /Submit feedback/i });
    await user.click(submit);

    // In-flight: button disabled + "Submitting…" label.
    await waitFor(() => {
      const inFlight = screen.getByRole('button', { name: /Submitting/i });
      expect(inFlight).toBeDisabled();
    });

    // Resolve the POST so the test cleanly completes.
    await act(async () => {
      resolvePost({ ok: true, status: 200, json: () => Promise.resolve({}) });
    });
  });

  it('sends comment=null in the POST body when the textarea is blank/whitespace-only', async () => {
    const user = userEvent.setup();
    global.fetch
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: () => Promise.resolve(makeSurvey({ type: 'NPS' })),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: () => Promise.resolve({}),
      });

    renderPage({ patientToken: PATIENT_TOKEN });

    await user.click(await screen.findByRole('button', { name: 'Score 10' }));
    // Type only spaces — SUT trims to '' then coalesces to null.
    await user.type(screen.getByRole('textbox'), '   ');

    await user.click(screen.getByRole('button', { name: /Submit feedback/i }));

    await waitFor(() => expect(global.fetch).toHaveBeenCalledTimes(2));
    const parsedBody = JSON.parse(global.fetch.mock.calls[1][1].body);
    expect(parsedBody.comment).toBeNull();
    expect(parsedBody.score).toBe(10);
  });

  it('flows the ?p= patient token from the URL query string into the POST body', async () => {
    const user = userEvent.setup();
    global.fetch
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: () => Promise.resolve(makeSurvey({ type: 'NPS' })),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: () => Promise.resolve({}),
      });

    renderPage({ patientToken: 'token_from_url_qs' });

    await user.click(await screen.findByRole('button', { name: 'Score 9' }));
    await user.click(screen.getByRole('button', { name: /Submit feedback/i }));

    await waitFor(() => expect(global.fetch).toHaveBeenCalledTimes(2));
    const parsedBody = JSON.parse(global.fetch.mock.calls[1][1].body);
    expect(parsedBody.p).toBe('token_from_url_qs');
  });

  it('sends p=null in the POST body when no ?p= query param was supplied', async () => {
    const user = userEvent.setup();
    global.fetch
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: () => Promise.resolve(makeSurvey({ type: 'NPS' })),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: () => Promise.resolve({}),
      });

    renderPage();
    // No patientToken passed — searchParams.get('p') yields null.

    await user.click(await screen.findByRole('button', { name: 'Score 2' }));
    await user.click(screen.getByRole('button', { name: /Submit feedback/i }));

    await waitFor(() => expect(global.fetch).toHaveBeenCalledTimes(2));
    const parsedBody = JSON.parse(global.fetch.mock.calls[1][1].body);
    expect(parsedBody.p).toBeNull();
  });

  it('renders the survey question text below the scale hint when the survey loads', async () => {
    global.fetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: () => Promise.resolve(makeSurvey({
        type: 'NPS',
        question: 'How was your recent visit?',
      })),
    });
    renderPage();

    expect(await screen.findByText('How was your recent visit?')).toBeInTheDocument();
  });
});
