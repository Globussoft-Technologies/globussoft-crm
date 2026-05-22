/**
 * #613 — Surveys aggregation panel renders count, average score, NPS,
 * promoter / passive / detractor breakdown, and the score-distribution
 * chart from a mocked /api/surveys/:id/aggregate response. Pins the
 * server-side-aggregation contract so any future regression to client-side
 * reduce-over-paginated-list breaks the test.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

vi.mock('../utils/api', () => ({ fetchApi: vi.fn() }));
vi.mock('../utils/notify', () => ({
  useNotify: () => ({
    error: vi.fn(),
    success: vi.fn(),
    info: vi.fn(),
    confirm: () => Promise.resolve(true),
    prompt: () => Promise.resolve(''),
  }),
}));

// Recharts uses ResponsiveContainer that needs a real DOM with measurable
// width; jsdom returns 0. Mock it so the chart renders in tests.
vi.mock('recharts', async () => {
  const actual = await vi.importActual('recharts');
  return {
    ...actual,
    ResponsiveContainer: ({ children }) => (
      <div data-testid="responsive">{children}</div>
    ),
  };
});

import { fetchApi } from '../utils/api';
import Surveys, { __clearRelatedEntityCacheForTests } from '../pages/Surveys';

const surveys = [
  { id: 42, name: 'Q2 NPS', type: 'NPS', question: 'How likely?', responseCount: 10, npsScore: 30 },
];

const aggregate = {
  surveyId: 42,
  type: 'NPS',
  count: 10,
  avgScore: 7.4,
  npsScore: 30,
  promoters: 5,
  passives: 3,
  detractors: 2,
  distribution: Array.from({ length: 11 }, (_, score) => ({
    score,
    count: { 0: 1, 3: 1, 7: 1, 8: 2, 9: 3, 10: 2 }[score] || 0,
  })),
};

describe('<Surveys /> — #613 aggregation panel', () => {
  beforeEach(() => {
    fetchApi.mockReset();
    fetchApi.mockImplementation((url) => {
      if (url === '/api/surveys') return Promise.resolve(surveys);
      if (url.endsWith('/aggregate')) return Promise.resolve(aggregate);
      if (url.endsWith('/responses')) return Promise.resolve([]);
      return Promise.resolve([]);
    });
  });

  it('renders count + avg + NPS + promoter/passive/detractor split from /aggregate', async () => {
    const user = userEvent.setup();
    render(<Surveys />);
    await waitFor(() => expect(screen.getByText('Q2 NPS')).toBeInTheDocument());

    // Open detail view
    await user.click(screen.getByText('Q2 NPS'));

    // Stats summary cards: count, avg, NPS
    await waitFor(() => {
      // Avg score (formatted to 2dp by the page) — uniquely identifies the
      // avg-score card; "10" / "30" appear in the score-axis tick labels
      // too so we anchor on the decimal-formatted value instead.
      expect(screen.getByText('7.40')).toBeInTheDocument();
    });

    // NPS bucket breakdown — the #613 deliverable. All three categories surface.
    expect(screen.getByText('Promoters')).toBeInTheDocument();
    expect(screen.getByText('Passives')).toBeInTheDocument();
    expect(screen.getByText('Detractors')).toBeInTheDocument();

    // Promoter/passive/detractor counts surface as "% of responses" lines too,
    // which uniquely tag the bucket-card values vs the chart-axis duplicates.
    // 5 promoters / 10 = 50%, 3 passives = 30%, 2 detractors = 20%.
    expect(screen.getByText(/50% of responses/i)).toBeInTheDocument();
    expect(screen.getByText(/30% of responses/i)).toBeInTheDocument();
    expect(screen.getByText(/20% of responses/i)).toBeInTheDocument();
  });

  it('calls /aggregate (not legacy /stats) when entering detail view', async () => {
    const user = userEvent.setup();
    render(<Surveys />);
    await waitFor(() => expect(screen.getByText('Q2 NPS')).toBeInTheDocument());
    await user.click(screen.getByText('Q2 NPS'));
    await waitFor(() =>
      expect(fetchApi).toHaveBeenCalledWith('/api/surveys/42/aggregate')
    );
  });

  it('falls back to /stats if /aggregate 404s (back-compat)', async () => {
    fetchApi.mockReset();
    fetchApi.mockImplementation((url) => {
      if (url === '/api/surveys') return Promise.resolve(surveys);
      if (url.endsWith('/aggregate')) return Promise.reject(new Error('not found'));
      if (url.endsWith('/stats')) return Promise.resolve({ count: 1, avgScore: 9, npsScore: 100, distribution: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1], type: 'NPS' });
      if (url.endsWith('/responses')) return Promise.resolve([]);
      return Promise.resolve([]);
    });
    const user = userEvent.setup();
    render(<Surveys />);
    await waitFor(() => expect(screen.getByText('Q2 NPS')).toBeInTheDocument());
    await user.click(screen.getByText('Q2 NPS'));
    await waitFor(() =>
      expect(fetchApi).toHaveBeenCalledWith('/api/surveys/42/stats')
    );
  });
});

// ── v3.7.17 — Parent-child review system ──────────────────────────────
//
// Covers the type-aware Create modal + Question Builder UI plumbed in
// alongside the legacy NPS / CSAT flow. Each describe targets one piece
// of the new surface so failures are easy to localize.

describe('<Surveys /> — type-aware Create modal (v3.7.17)', () => {
  beforeEach(() => {
    fetchApi.mockReset();
    // Reset the entity-name cache between tests so the picker re-fetches.
    __clearRelatedEntityCacheForTests();
    fetchApi.mockImplementation((url) => {
      if (url === '/api/surveys') return Promise.resolve([]);
      if (url.endsWith('/questions')) return Promise.resolve([]);
      return Promise.resolve([]);
    });
  });

  it('shows the legacy Question field for NPS and CSAT types', async () => {
    const user = userEvent.setup();
    render(<Surveys />);
    // The "Create Survey" trigger opens the modal.
    // Trigger button only — modal isn't open yet so there's just one.
    await user.click(await screen.findByRole('button', { name: /Create Survey/i }));
    expect(await screen.findByTestId('survey-question-textarea')).toBeInTheDocument();
    expect(screen.queryByTestId('survey-title-input')).not.toBeInTheDocument();

    // Switch to CSAT — Question stays.
    await user.selectOptions(screen.getByTestId('survey-type-select'), 'CSAT');
    expect(screen.getByTestId('survey-question-textarea')).toBeInTheDocument();
    expect(screen.queryByTestId('survey-title-input')).not.toBeInTheDocument();
  });

  it('switches to Title + entity picker for PRODUCT / SERVICE / DOCTOR', async () => {
    // v3.7.17: the relatedEntityId raw-number input was replaced with a
    // name-driven dropdown so the admin doesn't have to know DB IDs.
    fetchApi.mockImplementation((url) => {
      if (url === '/api/surveys') return Promise.resolve([]);
      if (url === '/api/wellness/products') return Promise.resolve([]);
      if (url === '/api/wellness/services') return Promise.resolve([]);
      if (url === '/api/staff') return Promise.resolve([]);
      return Promise.resolve([]);
    });
    const user = userEvent.setup();
    render(<Surveys />);
    // Trigger button only — modal isn't open yet so there's just one.
    await user.click(await screen.findByRole('button', { name: /Create Survey/i }));
    await user.selectOptions(screen.getByTestId('survey-type-select'), 'PRODUCT');
    expect(screen.getByTestId('survey-title-input')).toBeInTheDocument();
    expect(await screen.findByTestId('survey-related-entity-select')).toBeInTheDocument();
    expect(screen.queryByTestId('survey-question-textarea')).not.toBeInTheDocument();
  });

  it('CUSTOM type does NOT show the entity picker (no relatedEntity needed)', async () => {
    fetchApi.mockImplementation((url) => {
      if (url === '/api/surveys') return Promise.resolve([]);
      return Promise.resolve([]);
    });
    const user = userEvent.setup();
    render(<Surveys />);
    await user.click(await screen.findByRole('button', { name: /Create Survey/i }));
    await user.selectOptions(screen.getByTestId('survey-type-select'), 'CUSTOM');
    expect(screen.getByTestId('survey-title-input')).toBeInTheDocument();
    expect(screen.queryByTestId('survey-related-entity-select')).not.toBeInTheDocument();
  });

  it('submitting PRODUCT survey POSTs the id picked from the products dropdown (not a typed number)', async () => {
    // The admin picks "Pilgrim Face Wash" from a name-driven dropdown;
    // the picker resolves to the numeric id and the POST carries that id.
    let postBody = null;
    fetchApi.mockImplementation((url, opts) => {
      if (url === '/api/surveys' && opts?.method === 'POST') {
        postBody = JSON.parse(opts.body);
        return Promise.resolve({ id: 99, type: 'PRODUCT', name: postBody.name, title: postBody.title });
      }
      if (url === '/api/surveys') return Promise.resolve([]);
      if (url === '/api/wellness/products') return Promise.resolve([
        { id: 7, name: 'Pilgrim Face Wash', sku: 'PFW-1' },
        { id: 12, name: 'Acne Cream', sku: 'AC-1' },
      ]);
      if (url.endsWith('/questions')) return Promise.resolve([]);
      return Promise.resolve([]);
    });
    const user = userEvent.setup();
    render(<Surveys />);
    await user.click(await screen.findByRole('button', { name: /Create Survey/i }));
    await user.selectOptions(screen.getByTestId('survey-type-select'), 'PRODUCT');

    const select = await screen.findByTestId('survey-related-entity-select');
    // The dropdown should populate with the two products from the mock.
    await waitFor(() => {
      expect(select.querySelectorAll('option').length).toBeGreaterThanOrEqual(3); // placeholder + 2 products
    });
    await user.selectOptions(select, '7');

    const nameInput = screen.getByPlaceholderText(/Q2 Customer Satisfaction/i);
    await user.type(nameInput, 'product-99');
    await user.type(screen.getByTestId('survey-title-input'), 'Pilgrim review');

    // Two buttons say "Create Survey" — disambiguate by type=submit.
    const buttons = screen.getAllByRole('button', { name: /Create Survey/i });
    const submitBtn = buttons.find((b) => b.getAttribute('type') === 'submit');
    await user.click(submitBtn);

    await waitFor(() => expect(postBody).not.toBeNull());
    expect(postBody.type).toBe('PRODUCT');
    expect(postBody.title).toBe('Pilgrim review');
    // The id came from the dropdown — NOT a hand-typed number.
    expect(postBody.relatedEntityId).toBe(7);
    expect(postBody.question).toBeUndefined();
  });

  it('Send modal surfaces per-recipient failure reasons in the toast (SendGrid-not-configured visibility fix)', async () => {
    // The "Sent to 0 of 1 recipients." toast used to give the admin no
    // hint about WHY — the common reason in local/dev is SENDGRID_API_KEY
    // being unset on the backend, which makes every send a logged-only
    // no-op. The new toast aggregates per-recipient `reason` values from
    // the response and surfaces a friendly explanation.
    fetchApi.mockImplementation((url, opts) => {
      if (url === '/api/surveys' && (!opts || !opts.method)) {
        return Promise.resolve([{ id: 9, name: 'svc-9', title: 'X', type: 'SERVICE', responseCount: 0 }]);
      }
      if (url.startsWith('/api/contacts')) return Promise.resolve([]);
      if (url.startsWith('/api/wellness/patients')) {
        return Promise.resolve({
          patients: [{ id: 99, name: 'Mohit Gupta', email: 'mohitgupta@x.test', phone: '+91' }],
          total: 1,
        });
      }
      if (url.endsWith('/aggregate')) return Promise.resolve({ surveyId: 9, type: 'SERVICE', count: 0 });
      if (url.endsWith('/responses')) return Promise.resolve([]);
      if (url.endsWith('/send') && opts?.method === 'POST') {
        // Backend reports zero sent because Mailgun isn't configured.
        return Promise.resolve({
          sentCount: 0,
          attempted: 1,
          results: [{ patientId: 99, kind: 'patient', sent: false, reason: 'no_api_key' }],
        });
      }
      return Promise.resolve([]);
    });
    const user = userEvent.setup();
    render(<Surveys />);
    await user.click(await screen.findByText('X'));
    await user.click(await screen.findByRole('button', { name: /Send Survey/i }));
    const patientRow = await screen.findByTestId('recipient-row-patient-99');
    await user.click(patientRow.querySelector('input[type=checkbox]'));
    await user.click(screen.getByRole('button', { name: /Send to 1/i }));

    // Toast must surface the no_api_key reason with the Mailgun hint so
    // the admin knows the failure is a config gap, not a recipient bug.
    await waitFor(() => {
      expect(screen.getByText(/Sent to 0 of 1 recipients/)).toBeInTheDocument();
    });
    expect(screen.getByText(/SendGrid not configured/i)).toBeInTheDocument();
  });

  it('Send modal reads patients from the { patients, total } envelope (regression — bare-array assumption silently dropped all 607 rows)', async () => {
    // Live shape of /api/wellness/patients is `{ patients, total }` —
    // the contacts endpoint returns a bare array. If the modal ever
    // assumes both are arrays, the merge drops every patient row and
    // an admin trying to send to a Patient sees only Contacts. This
    // test pins the parser against the canonical wrapping shape.
    fetchApi.mockImplementation((url) => {
      if (url === '/api/surveys') {
        return Promise.resolve([{ id: 9, name: 'svc-9', title: 'X', type: 'SERVICE', responseCount: 0 }]);
      }
      if (url.startsWith('/api/contacts')) return Promise.resolve([]);
      if (url.startsWith('/api/wellness/patients')) {
        // Real shape from backend/routes/wellness.js:385.
        return Promise.resolve({
          patients: [
            { id: 99, name: 'Mohit Gupta', email: 'mohitgupta@fivermail.com', phone: '+916200039874' },
          ],
          total: 607,
        });
      }
      if (url.endsWith('/aggregate')) return Promise.resolve({ surveyId: 9, type: 'SERVICE', count: 0 });
      if (url.endsWith('/responses')) return Promise.resolve([]);
      return Promise.resolve([]);
    });
    const user = userEvent.setup();
    render(<Surveys />);
    await user.click(await screen.findByText('X'));
    await user.click(await screen.findByRole('button', { name: /Send Survey/i }));
    expect(await screen.findByTestId('recipient-row-patient-99')).toBeInTheDocument();
    expect(screen.getByTestId('recipient-row-patient-99').textContent).toMatch(/Mohit Gupta/);
  });

  it('Send modal merges Contacts + Patients with kind badges (v3.7.17)', async () => {
    // The recipient list pulls /api/contacts AND /api/wellness/patients
    // in parallel and shows each with a CONTACT or PATIENT badge so the
    // admin can see at a glance which entity they're inviting.
    const contacts = [{ id: 5, name: 'Anita Patel', email: 'anita@x.test', company: 'Acme' }];
    const patients = [{ id: 11, name: 'Priya Sharma', email: 'priya@x.test', phone: '+91999' }];
    let postBody = null;
    fetchApi.mockImplementation((url, opts) => {
      if (url === '/api/surveys' && (!opts || !opts.method)) {
        return Promise.resolve([{ id: 9, name: 'svc-9', title: 'GFC Hair feedback', type: 'SERVICE', responseCount: 0 }]);
      }
      if (url.startsWith('/api/contacts')) return Promise.resolve(contacts);
      // openSendModal now requests /api/wellness/patients?limit=200 to
      // dodge the default 50-row cap; the mock matches via startsWith
      // so the URL's query string doesn't break the test.
      if (url.startsWith('/api/wellness/patients')) return Promise.resolve(patients);
      if (url.endsWith('/aggregate')) return Promise.resolve({ surveyId: 9, type: 'SERVICE', count: 0 });
      if (url.endsWith('/responses')) return Promise.resolve([]);
      if (url.endsWith('/send') && opts?.method === 'POST') {
        postBody = JSON.parse(opts.body);
        return Promise.resolve({ sentCount: 2, attempted: 2, results: [] });
      }
      return Promise.resolve([]);
    });
    const user = userEvent.setup();
    render(<Surveys />);
    // Open the survey detail view (the Send button lives there).
    await user.click(await screen.findByText('GFC Hair feedback'));
    await user.click(await screen.findByRole('button', { name: /Send Survey/i }));
    // Both rows appear with their badges.
    expect(await screen.findByTestId('recipient-row-contact-5')).toBeInTheDocument();
    expect(screen.getByTestId('recipient-row-patient-11')).toBeInTheDocument();
    const contactRow = screen.getByTestId('recipient-row-contact-5');
    const patientRow = screen.getByTestId('recipient-row-patient-11');
    expect(contactRow.textContent).toMatch(/CONTACT/);
    expect(patientRow.textContent).toMatch(/PATIENT/);

    // Select one of each and click Send.
    await user.click(contactRow.querySelector('input[type=checkbox]'));
    await user.click(patientRow.querySelector('input[type=checkbox]'));
    // Selection counter now reads "2 selected".
    expect(screen.getByText(/2 selected/i)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /Send to 2/i }));

    await waitFor(() => expect(postBody).not.toBeNull());
    // Body splits the selection by kind into the matching arrays.
    expect(postBody.contactIds).toEqual([5]);
    expect(postBody.patientIds).toEqual([11]);
  });

  it('Multi-question detail view: clicking a submission opens the detail modal with recipient + per-question answers', async () => {
    // The submission cards are clickable now — opening the modal
    // surfaces WHO submitted (Contact / Patient name + email + phone)
    // alongside the full question/answer rundown.
    const survey = { id: 9, name: 'product-9', title: 'Acne Cream Review', type: 'PRODUCT', responseCount: 0 };
    fetchApi.mockImplementation((url) => {
      if (url === '/api/surveys') return Promise.resolve([survey]);
      if (url === '/api/surveys/9/answers') {
        return Promise.resolve({
          submissionCount: 1,
          answerCount: 2,
          submissions: [
            {
              submissionId: 'sub-abc',
              submittedAt: '2026-05-21T13:40:00.000Z',
              recipient: {
                kind: 'patient',
                id: 99,
                name: 'Mohit Gupta',
                email: 'mohitgupta@fivermail.com',
                phone: '+916200039874',
              },
              answers: [
                { questionId: 11, question: 'How satisfied?', fieldType: 'RATE', order: 0, answer: '5' },
                { questionId: 12, question: 'Comments?',      fieldType: 'TEXTAREA', order: 1, answer: 'Loved it' },
              ],
            },
          ],
        });
      }
      return Promise.resolve([]);
    });
    const user = userEvent.setup();
    render(<Surveys />);
    await user.click(await screen.findByText('Acne Cream Review'));

    // Modal isn't open yet.
    expect(screen.queryByTestId('mq-submission-detail-modal')).not.toBeInTheDocument();

    // Click the first submission card → modal opens.
    const card = await screen.findByTestId('mq-submission-0');
    await user.click(card);
    const modal = await screen.findByTestId('mq-submission-detail-modal');

    // Recipient card surfaces name + email + phone, tagged PATIENT.
    expect(within(modal).getByTestId('mq-submission-recipient-card')).toBeInTheDocument();
    expect(within(modal).getByText(/Mohit Gupta/)).toBeInTheDocument();
    expect(within(modal).getByText(/PATIENT/)).toBeInTheDocument();
    expect(within(modal).getByTestId('recipient-email')).toHaveTextContent('mohitgupta@fivermail.com');
    expect(within(modal).getByTestId('recipient-phone')).toHaveTextContent('+916200039874');

    // Answers grid surfaces every question/answer pair.
    const answers = within(modal).getByTestId('mq-submission-answers');
    expect(answers.textContent).toMatch(/How satisfied\?/);
    expect(answers.textContent).toMatch(/5/);
    expect(answers.textContent).toMatch(/Comments\?/);
    expect(answers.textContent).toMatch(/Loved it/);
  });

  it('Multi-question detail view: legacy submission with no recipient shows the anonymous placeholder', async () => {
    const survey = { id: 9, name: 'product-9', title: 'Acne Cream Review', type: 'PRODUCT', responseCount: 0 };
    fetchApi.mockImplementation((url) => {
      if (url === '/api/surveys') return Promise.resolve([survey]);
      if (url === '/api/surveys/9/answers') {
        return Promise.resolve({
          submissionCount: 1,
          answerCount: 1,
          submissions: [
            {
              submissionId: null,
              submittedAt: '2026-05-19T13:40:00.000Z',
              recipient: null,
              answers: [
                { questionId: 11, question: 'Comments?', fieldType: 'TEXT', order: 0, answer: 'Older feedback' },
              ],
            },
          ],
        });
      }
      return Promise.resolve([]);
    });
    const user = userEvent.setup();
    render(<Surveys />);
    await user.click(await screen.findByText('Acne Cream Review'));
    await user.click(await screen.findByTestId('mq-submission-0'));
    const modal = await screen.findByTestId('mq-submission-detail-modal');
    // Recipient card is absent; anonymous placeholder is shown instead.
    expect(within(modal).queryByTestId('mq-submission-recipient-card')).not.toBeInTheDocument();
    expect(within(modal).getByTestId('mq-submission-anonymous')).toBeInTheDocument();
    // Answers still render.
    expect(within(modal).getByTestId('mq-submission-answers').textContent).toMatch(/Older feedback/);
  });

  it('Multi-question detail view: renders Submissions tile + per-submission answer cards instead of NPS chart (v3.7.17)', async () => {
    // For PRODUCT/SERVICE/DOCTOR/CUSTOM surveys the detail view loads
    // GET /:id/answers and renders one card per submission with each
    // question/answer pair. NPS-style "Avg Score" + "Score Distribution"
    // tiles are intentionally absent — they make no sense for chip /
    // textarea / yes-no answers.
    const survey = { id: 9, name: 'product-9', title: 'Acne Cream Review', type: 'PRODUCT', responseCount: 0 };
    fetchApi.mockImplementation((url) => {
      if (url === '/api/surveys') return Promise.resolve([survey]);
      if (url === '/api/surveys/9/answers') {
        return Promise.resolve({
          submissionCount: 1,
          answerCount: 2,
          submissions: [
            {
              submissionId: 'sub-a3f2',
              submittedAt: '2026-05-21T13:40:00.000Z',
              answers: [
                { questionId: 11, question: 'How satisfied?', fieldType: 'RATE', order: 0, answer: '5' },
                { questionId: 12, question: 'Comments?',      fieldType: 'TEXTAREA', order: 1, answer: 'Loved it' },
              ],
            },
          ],
        });
      }
      return Promise.resolve([]);
    });
    const user = userEvent.setup();
    render(<Surveys />);
    await user.click(await screen.findByText('Acne Cream Review'));

    // Submissions tile reflects the count from /answers (NOT the
    // legacy SurveyResponse-driven `responseCount` field which would
    // have read 0 here and confused the admin).
    const tile = await screen.findByTestId('mq-submissions-tile');
    expect(tile.textContent).toMatch(/1/);

    // One clickable submission card appears in the list. Full Q+A
    // detail surfacing is covered by the "click opens modal" test
    // above; here we just confirm the card rendered with an
    // answer-count summary and a "click to view details" affordance.
    const list = await screen.findByTestId('mq-submissions-list');
    expect(within(list).getByTestId('mq-submission-0')).toBeInTheDocument();
    expect(list.textContent).toMatch(/2 answers/);
    expect(list.textContent).toMatch(/click to view details/i);

    // No NPS Score Distribution chart should appear here — it's an
    // NPS-only widget. Quick way to confirm: the legacy "Recent
    // Responses" / "Score Distribution" headings are absent.
    expect(screen.queryByText(/Score Distribution/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/Recent Responses/i)).not.toBeInTheDocument();
  });

  it('DOCTOR picker filters /api/staff to wellnessRole=doctor only', async () => {
    fetchApi.mockImplementation((url) => {
      if (url === '/api/surveys') return Promise.resolve([]);
      if (url === '/api/staff') return Promise.resolve([
        { id: 1, name: 'Admin User',  email: 'a@x.test', wellnessRole: null },
        { id: 2, name: 'Dr. Harsh',   email: 'h@x.test', wellnessRole: 'doctor' },
        { id: 3, name: 'Receptionist', email: 'r@x.test', wellnessRole: 'helper' },
      ]);
      return Promise.resolve([]);
    });
    const user = userEvent.setup();
    render(<Surveys />);
    await user.click(await screen.findByRole('button', { name: /Create Survey/i }));
    await user.selectOptions(screen.getByTestId('survey-type-select'), 'DOCTOR');

    const select = await screen.findByTestId('survey-related-entity-select');
    await waitFor(() => {
      const labels = Array.from(select.querySelectorAll('option')).map((o) => o.textContent);
      // Only the doctor row should appear (alongside the placeholder).
      expect(labels.some((l) => l.includes('Dr. Harsh'))).toBe(true);
      expect(labels.some((l) => l.includes('Admin User'))).toBe(false);
      expect(labels.some((l) => l.includes('Receptionist'))).toBe(false);
    });
  });
});

describe('<Surveys /> — Question Builder (v3.7.17)', () => {
  // Render the page with one PRODUCT survey already in the list so we can
  // click "Manage questions" directly.
  function setupWithProductSurvey(questions = []) {
    const survey = { id: 9, name: 'product-9', title: 'Acne Cream Review', type: 'PRODUCT', responseCount: 0, questionCount: questions.length };
    const requests = { posted: [], puts: [], deletes: [] };
    fetchApi.mockImplementation((url, opts) => {
      if (url === '/api/surveys') return Promise.resolve([survey]);
      if (url === '/api/surveys/9/questions' && (!opts || !opts.method || opts.method === 'GET')) {
        return Promise.resolve(questions);
      }
      if (url === '/api/surveys/9/questions' && opts.method === 'POST') {
        const body = JSON.parse(opts.body);
        requests.posted.push(body);
        const created = { id: 100 + requests.posted.length, surveyId: 9, ...body };
        questions.push(created);
        return Promise.resolve(created);
      }
      if (url.startsWith('/api/surveys/questions/') && opts?.method === 'PUT') {
        requests.puts.push({ url, body: JSON.parse(opts.body) });
        return Promise.resolve({});
      }
      if (url.startsWith('/api/surveys/questions/') && opts?.method === 'DELETE') {
        requests.deletes.push(url);
        return Promise.resolve({});
      }
      if (url.endsWith('/aggregate')) return Promise.resolve({ surveyId: 9, type: 'PRODUCT', count: 0 });
      return Promise.resolve([]);
    });
    return { survey, requests };
  }

  beforeEach(() => {
    fetchApi.mockReset();
  });

  async function openBuilder(user) {
    render(<Surveys />);
    await waitFor(() => expect(screen.getByText('Acne Cream Review')).toBeInTheDocument());
    await user.click(screen.getByTestId('manage-questions-9'));
    expect(await screen.findByTestId('question-builder-modal')).toBeInTheDocument();
  }

  it('TEXT field type shows no options or rating section', async () => {
    setupWithProductSurvey();
    const user = userEvent.setup();
    await openBuilder(user);
    await user.click(screen.getByTestId('add-question-btn'));
    // Default fieldType is TEXT — neither options nor rating section.
    expect(screen.queryByTestId('options-section')).not.toBeInTheDocument();
    expect(screen.queryByTestId('rating-section')).not.toBeInTheDocument();
    expect(screen.queryByTestId('yesno-section')).not.toBeInTheDocument();
  });

  it('SELECT field type shows the options builder; RADIO does too', async () => {
    setupWithProductSurvey();
    const user = userEvent.setup();
    await openBuilder(user);
    await user.click(screen.getByTestId('add-question-btn'));
    await user.selectOptions(screen.getByTestId('question-fieldtype-select'), 'SELECT');
    expect(screen.getByTestId('options-section')).toBeInTheDocument();
    await user.selectOptions(screen.getByTestId('question-fieldtype-select'), 'RADIO');
    expect(screen.getByTestId('options-section')).toBeInTheDocument();
  });

  it('RATE field type shows min/max number inputs; switching to TEXT hides them', async () => {
    setupWithProductSurvey();
    const user = userEvent.setup();
    await openBuilder(user);
    await user.click(screen.getByTestId('add-question-btn'));
    await user.selectOptions(screen.getByTestId('question-fieldtype-select'), 'RATE');
    expect(screen.getByTestId('rating-section')).toBeInTheDocument();
    expect(screen.getByTestId('min-rating-input')).toBeInTheDocument();
    expect(screen.getByTestId('max-rating-input')).toBeInTheDocument();
    await user.selectOptions(screen.getByTestId('question-fieldtype-select'), 'TEXT');
    expect(screen.queryByTestId('rating-section')).not.toBeInTheDocument();
  });

  it('YES_NO field type shows the read-only True/False chips', async () => {
    setupWithProductSurvey();
    const user = userEvent.setup();
    await openBuilder(user);
    await user.click(screen.getByTestId('add-question-btn'));
    await user.selectOptions(screen.getByTestId('question-fieldtype-select'), 'YES_NO');
    expect(screen.getByTestId('yesno-section')).toBeInTheDocument();
    const section = screen.getByTestId('yesno-section');
    expect(section.textContent).toMatch(/True/);
    expect(section.textContent).toMatch(/False/);
  });

  it('SELECT validation: empty options shows the OPTIONS_REQUIRED error', async () => {
    setupWithProductSurvey();
    const user = userEvent.setup();
    await openBuilder(user);
    await user.click(screen.getByTestId('add-question-btn'));
    await user.type(screen.getByTestId('question-text-input'), 'Pick one');
    await user.selectOptions(screen.getByTestId('question-fieldtype-select'), 'SELECT');
    // No options added — click Save.
    await user.click(screen.getByTestId('save-question-btn'));
    expect(await screen.findByTestId('question-form-error')).toHaveTextContent(/at least one option/i);
  });

  it('SELECT validation: duplicate options (case-insensitive) shows error', async () => {
    setupWithProductSurvey();
    const user = userEvent.setup();
    await openBuilder(user);
    await user.click(screen.getByTestId('add-question-btn'));
    await user.type(screen.getByTestId('question-text-input'), 'Pick one');
    await user.selectOptions(screen.getByTestId('question-fieldtype-select'), 'SELECT');
    await user.click(screen.getByTestId('add-option-btn'));
    await user.click(screen.getByTestId('add-option-btn'));
    await user.type(screen.getByTestId('option-input-0'), 'Yes');
    await user.type(screen.getByTestId('option-input-1'), 'yes');
    await user.click(screen.getByTestId('save-question-btn'));
    expect(await screen.findByTestId('question-form-error')).toHaveTextContent(/unique/i);
  });

  it('RATE validation: inverted range shows the appropriate error', async () => {
    setupWithProductSurvey();
    const user = userEvent.setup();
    await openBuilder(user);
    await user.click(screen.getByTestId('add-question-btn'));
    await user.type(screen.getByTestId('question-text-input'), 'Rate it');
    await user.selectOptions(screen.getByTestId('question-fieldtype-select'), 'RATE');
    const minInput = screen.getByTestId('min-rating-input');
    const maxInput = screen.getByTestId('max-rating-input');
    await user.clear(minInput);
    await user.type(minInput, '5');
    await user.clear(maxInput);
    await user.type(maxInput, '1');
    await user.click(screen.getByTestId('save-question-btn'));
    expect(await screen.findByTestId('question-form-error')).toHaveTextContent(/greater than min/i);
  });

  it('happy path: SELECT question POSTs trimmed unique options to the server', async () => {
    const { requests } = setupWithProductSurvey();
    const user = userEvent.setup();
    await openBuilder(user);
    await user.click(screen.getByTestId('add-question-btn'));
    await user.type(screen.getByTestId('question-text-input'), 'Pick one');
    await user.selectOptions(screen.getByTestId('question-fieldtype-select'), 'SELECT');
    await user.click(screen.getByTestId('add-option-btn'));
    await user.click(screen.getByTestId('add-option-btn'));
    await user.type(screen.getByTestId('option-input-0'), '  Excellent  ');
    await user.type(screen.getByTestId('option-input-1'), 'Average');
    await user.click(screen.getByTestId('save-question-btn'));
    await waitFor(() => expect(requests.posted.length).toBe(1));
    expect(requests.posted[0].fieldType).toBe('SELECT');
    expect(requests.posted[0].options).toEqual(['Excellent', 'Average']);
    expect(requests.posted[0].question).toBe('Pick one');
  });
});
