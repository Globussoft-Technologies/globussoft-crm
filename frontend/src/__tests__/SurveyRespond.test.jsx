// v3.7.17 — SurveyRespond page (token-based public respondent landing).
//
// Pins:
//   1. Loads survey via GET /api/surveys/respond/:token on mount.
//   2. Multi-question survey: renders one input per question, branches
//      on fieldType (TEXT, TEXTAREA, SELECT, RATE, RADIO, YES_NO).
//   3. Required-question validation blocks submit with a friendly error.
//   4. Successful submission POSTs to /api/surveys/respond/:token/submit
//      with a normalized { answers: [{ questionId, answer }] } body, and
//      the page shows the "Thank you" view.
//   5. Legacy NPS path renders the 0-10 score buttons and POSTs to the
//      old /api/surveys/respond/:token endpoint with { score, comment }.
//   6. The 410-already-answered / 404-invalid-token error from the GET
//      lands in the user-facing "We couldn't open this survey" surface.

import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import SurveyRespond from '../pages/SurveyRespond';

function renderAt(token) {
  return render(
    <MemoryRouter initialEntries={[`/surveys/respond/${token}`]}>
      <Routes>
        <Route path="/surveys/respond/:token" element={<SurveyRespond />} />
      </Routes>
    </MemoryRouter>,
  );
}

function mockFetch(impl) {
  global.fetch = vi.fn(impl);
}

describe('<SurveyRespond /> — multi-question flow (v3.7.17)', () => {
  beforeEach(() => {
    delete global.fetch;
  });

  it('renders one input per question, branching on fieldType', async () => {
    mockFetch((url) => {
      if (url.endsWith('/api/surveys/respond/tok-1')) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({
            type: 'PRODUCT',
            title: 'Pilgrim Face Wash Review',
            questions: [
              { id: 11, question: 'How satisfied?',      fieldType: 'RATE',     options: null, minRating: 1, maxRating: 5, order: 0, isRequired: true,  isActive: true },
              { id: 12, question: 'Which part?',         fieldType: 'SELECT',   options: ['Doctor', 'Staff'], order: 1, isRequired: false, isActive: true },
              { id: 13, question: 'Would you recommend', fieldType: 'YES_NO',   options: ['True', 'False'], order: 2, isRequired: true,  isActive: true },
              { id: 14, question: 'Comments',            fieldType: 'TEXTAREA', options: null, order: 3, isRequired: false, isActive: true },
            ],
          }),
        });
      }
      return Promise.reject(new Error('unexpected fetch ' + url));
    });
    renderAt('tok-1');
    expect(await screen.findByTestId('survey-title')).toHaveTextContent(/Pilgrim Face Wash Review/);
    // RATE → buttons 1..5
    expect(screen.getByTestId('rate-11-1')).toBeInTheDocument();
    expect(screen.getByTestId('rate-11-5')).toBeInTheDocument();
    // SELECT → dropdown
    const sel = screen.getByTestId('input-12');
    expect(sel.tagName.toLowerCase()).toBe('select');
    // YES_NO → radio with True/False (no caller-provided options)
    const yn = screen.getByTestId('input-13');
    expect(yn.textContent).toMatch(/True/);
    expect(yn.textContent).toMatch(/False/);
    // TEXTAREA → textarea
    expect(screen.getByTestId('input-14').tagName.toLowerCase()).toBe('textarea');
  });

  it('required-question validation blocks submit before POSTing', async () => {
    let submitFired = false;
    mockFetch((url, opts) => {
      if (url.endsWith('/api/surveys/respond/tok-2') && (!opts || !opts.method)) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({
            type: 'PRODUCT', title: 'X',
            questions: [{ id: 21, question: 'Rate', fieldType: 'RATE', minRating: 1, maxRating: 5, order: 0, isRequired: true, isActive: true }],
          }),
        });
      }
      if (url.endsWith('/submit')) {
        submitFired = true;
        return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
      }
      return Promise.reject(new Error('unexpected fetch ' + url));
    });
    renderAt('tok-2');
    await screen.findByTestId('survey-title');
    const user = userEvent.setup();
    await user.click(screen.getByTestId('survey-respond-submit'));
    expect(await screen.findByTestId('survey-respond-validation-error')).toHaveTextContent(/required/i);
    expect(submitFired).toBe(false);
  });

  it('happy path: picks values then POSTs to /respond/:token/submit with a normalized answers body', async () => {
    let postedBody = null;
    mockFetch((url, opts) => {
      if (url.endsWith('/api/surveys/respond/tok-3') && (!opts || !opts.method)) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({
            type: 'PRODUCT', title: 'Form',
            questions: [
              { id: 31, question: 'Rate', fieldType: 'RATE', minRating: 1, maxRating: 5, order: 0, isRequired: true, isActive: true },
              { id: 32, question: 'Pick', fieldType: 'SELECT', options: ['A', 'B'], order: 1, isRequired: true, isActive: true },
            ],
          }),
        });
      }
      if (url.endsWith('/submit') && opts?.method === 'POST') {
        postedBody = JSON.parse(opts.body);
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ success: true, submitted: 2 }) });
      }
      return Promise.reject(new Error('unexpected fetch ' + url));
    });
    renderAt('tok-3');
    await screen.findByTestId('survey-title');
    const user = userEvent.setup();
    await user.click(screen.getByTestId('rate-31-4'));
    await user.selectOptions(screen.getByTestId('input-32'), 'B');
    await user.click(screen.getByTestId('survey-respond-submit'));
    await waitFor(() => expect(postedBody).not.toBeNull());
    expect(postedBody.answers).toEqual([
      { questionId: 31, answer: '4' },
      { questionId: 32, answer: 'B' },
    ]);
    // The thank-you surface replaces the form after submit succeeds.
    await screen.findByTestId('survey-respond-thanks');
  });
});

describe('<SurveyRespond /> — legacy NPS flow (back-compat)', () => {
  beforeEach(() => { delete global.fetch; });

  it('renders 0-10 score buttons + comment field; POSTs { score, comment } to /respond/:token', async () => {
    let postedBody = null;
    let postedUrl = null;
    mockFetch((url, opts) => {
      if (url.endsWith('/api/surveys/respond/tok-nps') && (!opts || !opts.method)) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({
            type: 'NPS',
            surveyName: 'nps-1',
            question: 'How likely?',
          }),
        });
      }
      if (opts?.method === 'POST') {
        postedUrl = url;
        postedBody = JSON.parse(opts.body);
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ success: true }) });
      }
      return Promise.reject(new Error('unexpected fetch ' + url));
    });
    renderAt('tok-nps');
    await screen.findByText(/How likely/);
    const user = userEvent.setup();
    await user.click(screen.getByTestId('score-9'));
    await user.type(screen.getByTestId('legacy-comment-input'), 'Loved it');
    await user.click(screen.getByTestId('survey-respond-submit'));
    await waitFor(() => expect(postedBody).not.toBeNull());
    // Legacy contract: { score, comment } at /respond/:token (no /submit suffix).
    expect(postedUrl.endsWith('/api/surveys/respond/tok-nps')).toBe(true);
    expect(postedBody.score).toBe(9);
    expect(postedBody.comment).toBe('Loved it');
  });
});

describe('<SurveyRespond /> — link error surfaces', () => {
  beforeEach(() => { delete global.fetch; });

  it('renders the "We couldn\'t open this survey" surface when the GET 410s as already-answered', async () => {
    mockFetch(() => Promise.resolve({
      ok: false,
      status: 410,
      json: () => Promise.resolve({ error: 'This survey has already been answered.' }),
    }));
    renderAt('tok-used');
    expect(await screen.findByTestId('survey-respond-error')).toHaveTextContent(/already been answered/i);
  });

  it('renders the same error surface on a 404 invalid-link', async () => {
    mockFetch(() => Promise.resolve({
      ok: false,
      status: 404,
      json: () => Promise.resolve({ error: 'Invalid or expired link.' }),
    }));
    renderAt('tok-bogus');
    expect(await screen.findByTestId('survey-respond-error')).toHaveTextContent(/Invalid or expired/i);
  });
});
