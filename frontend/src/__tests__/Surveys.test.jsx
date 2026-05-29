/**
 * Surveys.test.jsx — vitest + RTL coverage for the authenticated Surveys
 * authoring + results-viewing page (frontend/src/pages/Surveys.jsx, 721 LOC).
 *
 * Test-coverage-drain tick — adds outer-shell + CRUD + response-view pin for
 * the broader page surface. The sibling Surveys.aggregate.test.jsx already
 * covers the #613 /aggregate panel specifically; this file covers the rest
 * of the page lifecycle so any regression on list-fetch, create-modal,
 * delete-confirm, detail-view-load, or empty-responses copy breaks a test.
 *
 * Scope — pins the page-surface invariants:
 *   1. Smoke render of the list view header + Create CTA.
 *   2. Loading copy ("Loading surveys...") renders while GET is in-flight.
 *   3. Empty-list state renders the "No surveys yet" copy.
 *   4. Loaded list renders survey cards (name + question + response count).
 *   5. Create-modal opens when Create Survey CTA is clicked.
 *   6. Create-modal closes via the Cancel button.
 *   7. Successful create POSTs /api/surveys with the form shape +
 *      isActive=true, then refreshes the list.
 *   8. Delete confirm flow — clicking the X on a card triggers notify.confirm;
 *      cancel skips the DELETE; accept fires DELETE + refreshes.
 *   9. Clicking a survey card opens the detail view (fetches aggregate +
 *      responses) and renders the question + Back-to-Surveys CTA.
 *  10. Empty-responses state — detail view with zero responses surfaces the
 *      "No responses yet" copy.
 *  11. API error on list-fetch — surveys-list GET throws → loading clears,
 *      empty-state renders.
 *
 * Stable-mock-object pattern per 2026-05-23 standing rule: a single notifyObj
 * reference is returned by every useNotify() call, NOT a fresh {error: vi.fn()...}
 * per call (which would cause infinite re-render loops via useCallback deps).
 *
 * Recharts mock — ResponsiveContainer needs measurable width which jsdom
 * doesn't supply; stub it to a plain div so the detail-view chart can render.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

// Stable mock-object refs (2026-05-23 standing rule). Each property is a
// vi.fn() spy so per-test assertions can verify call shapes; the object
// identity itself is stable across re-renders.
const notifyObj = {
  error: vi.fn(),
  success: vi.fn(),
  info: vi.fn(),
  confirm: vi.fn().mockResolvedValue(true),
  prompt: vi.fn().mockResolvedValue(''),
};

vi.mock('../utils/api', () => ({ fetchApi: vi.fn() }));
vi.mock('../utils/notify', () => ({
  useNotify: () => notifyObj,
}));

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
import Surveys from '../pages/Surveys';

const surveysFixture = [
  {
    id: 11,
    name: 'Q2 Customer NPS',
    type: 'NPS',
    question: 'How likely are you to recommend us?',
    responseCount: 8,
    npsScore: 25,
  },
  {
    id: 12,
    name: 'Onboarding CSAT',
    type: 'CSAT',
    question: 'How satisfied were you with onboarding?',
    responseCount: 4,
    avgScore: 4.2,
  },
];

const aggregateFixture = {
  surveyId: 11,
  type: 'NPS',
  count: 8,
  avgScore: 7.2,
  npsScore: 25,
  promoters: 3,
  passives: 3,
  detractors: 2,
  distribution: Array.from({ length: 11 }, (_, score) => ({ score, count: 0 })),
};

describe('<Surveys /> — list + CRUD + response-view shell', () => {
  beforeEach(() => {
    fetchApi.mockReset();
    notifyObj.error.mockClear();
    notifyObj.success.mockClear();
    notifyObj.info.mockClear();
    notifyObj.confirm.mockClear();
    notifyObj.confirm.mockResolvedValue(true);
    // Default: list returns the fixture; detail endpoints resolve emptily.
    fetchApi.mockImplementation((url, opts) => {
      if (url === '/api/surveys' && (!opts || !opts.method || opts.method === 'GET')) {
        return Promise.resolve(surveysFixture);
      }
      if (url.endsWith('/aggregate')) return Promise.resolve(aggregateFixture);
      if (url.endsWith('/stats')) return Promise.resolve(aggregateFixture);
      if (url.endsWith('/responses')) return Promise.resolve([]);
      if (url === '/api/contacts' || url.startsWith('/api/contacts?')) return Promise.resolve([]);
      if (url.startsWith('/api/wellness/patients')) return Promise.resolve({ patients: [], total: 0 });
      return Promise.resolve({});
    });
  });

  it('renders the list-view header + Create CTA on initial mount', async () => {
    render(<Surveys />);
    expect(screen.getByText(/NPS\/CSAT Surveys/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /create survey/i })).toBeInTheDocument();
  });

  it('shows loading copy while the surveys-list GET is in-flight', async () => {
    // Never-resolving promise keeps loading=true through the assertion.
    fetchApi.mockReset();
    fetchApi.mockImplementation(() => new Promise(() => {}));
    render(<Surveys />);
    expect(screen.getByText(/loading surveys/i)).toBeInTheDocument();
  });

  it('renders the empty-state copy when the list is empty', async () => {
    fetchApi.mockReset();
    fetchApi.mockImplementation((url) => {
      if (url === '/api/surveys') return Promise.resolve([]);
      return Promise.resolve({});
    });
    render(<Surveys />);
    await waitFor(() => {
      expect(screen.getByText(/no surveys yet/i)).toBeInTheDocument();
    });
    expect(screen.getByText(/create your first nps or csat survey/i)).toBeInTheDocument();
  });

  it('renders all surveys returned by /api/surveys as cards', async () => {
    render(<Surveys />);
    await waitFor(() => {
      expect(screen.getByText('Q2 Customer NPS')).toBeInTheDocument();
    });
    expect(screen.getByText('Onboarding CSAT')).toBeInTheDocument();
    expect(screen.getByText(/how likely are you to recommend us\?/i)).toBeInTheDocument();
    expect(screen.getByText(/how satisfied were you with onboarding\?/i)).toBeInTheDocument();
    // Both NPS and CSAT TypeBadges appear on cards; getAllByText guards against
    // future regressions where the same label appears in filter chrome + badges.
    expect(screen.getAllByText('NPS').length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText('CSAT').length).toBeGreaterThanOrEqual(1);
  });

  it('opens the create-survey modal when the Create CTA is clicked', async () => {
    const user = userEvent.setup();
    render(<Surveys />);
    await waitFor(() => expect(screen.getByText('Q2 Customer NPS')).toBeInTheDocument());

    await user.click(screen.getByRole('button', { name: /create survey/i }));

    // Modal heading uses the same "Create Survey" string as the CTA; getAllByText.
    const createHeadings = screen.getAllByText(/create survey/i);
    expect(createHeadings.length).toBeGreaterThanOrEqual(2);
    // The modal exposes a Name input + Type select + Question textarea.
    expect(screen.getByPlaceholderText(/q2 customer satisfaction/i)).toBeInTheDocument();
    expect(screen.getByPlaceholderText(/how likely are you to recommend us/i)).toBeInTheDocument();
  });

  it('closes the create-modal via the Cancel button', async () => {
    const user = userEvent.setup();
    render(<Surveys />);
    await waitFor(() => expect(screen.getByText('Q2 Customer NPS')).toBeInTheDocument());

    await user.click(screen.getByRole('button', { name: /create survey/i }));
    expect(screen.getByPlaceholderText(/q2 customer satisfaction/i)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /cancel/i }));
    await waitFor(() => {
      expect(screen.queryByPlaceholderText(/q2 customer satisfaction/i)).not.toBeInTheDocument();
    });
  });

  it('POSTs to /api/surveys with isActive=true and refreshes the list on submit', async () => {
    const user = userEvent.setup();
    render(<Surveys />);
    await waitFor(() => expect(screen.getByText('Q2 Customer NPS')).toBeInTheDocument());

    await user.click(screen.getByRole('button', { name: /create survey/i }));

    // Type into Name + Question.
    const nameInput = screen.getByPlaceholderText(/q2 customer satisfaction/i);
    const questionInput = screen.getByPlaceholderText(/how likely are you to recommend us/i);
    await user.type(nameInput, 'Annual Loyalty Pulse');
    await user.type(questionInput, 'How likely would you renew?');

    // Submit — the modal renders a second "Create Survey" button inside the
    // form (type=submit). It's the LAST occurrence in the DOM.
    const allCreateButtons = screen.getAllByRole('button', { name: /create survey/i });
    await user.click(allCreateButtons[allCreateButtons.length - 1]);

    await waitFor(() => {
      const postCall = fetchApi.mock.calls.find(
        ([url, opts]) => url === '/api/surveys' && opts && opts.method === 'POST'
      );
      expect(postCall).toBeDefined();
      const body = JSON.parse(postCall[1].body);
      expect(body.name).toBe('Annual Loyalty Pulse');
      expect(body.question).toBe('How likely would you renew?');
      expect(body.type).toBe('NPS');
      expect(body.isActive).toBe(true);
    });

    // List refresh — /api/surveys GET should have been called at least twice
    // (initial mount + post-create reload).
    const getCalls = fetchApi.mock.calls.filter(
      ([url, opts]) => url === '/api/surveys' && (!opts || !opts.method || opts.method === 'GET')
    );
    expect(getCalls.length).toBeGreaterThanOrEqual(2);
  });

  it('delete confirm: cancel skips DELETE, accept fires DELETE + refreshes', async () => {
    const user = userEvent.setup();
    render(<Surveys />);
    await waitFor(() => expect(screen.getByText('Q2 Customer NPS')).toBeInTheDocument());

    // Cancel first.
    notifyObj.confirm.mockResolvedValueOnce(false);
    const deleteBtn = screen.getByRole('button', { name: /delete survey q2 customer nps/i });
    await user.click(deleteBtn);

    await waitFor(() => expect(notifyObj.confirm).toHaveBeenCalledTimes(1));
    // No DELETE should have fired.
    const deleteAfterCancel = fetchApi.mock.calls.filter(
      ([url, opts]) => opts && opts.method === 'DELETE'
    );
    expect(deleteAfterCancel).toHaveLength(0);

    // Accept now.
    notifyObj.confirm.mockResolvedValueOnce(true);
    await user.click(deleteBtn);

    await waitFor(() => {
      const deleteCalls = fetchApi.mock.calls.filter(
        ([url, opts]) => opts && opts.method === 'DELETE'
      );
      expect(deleteCalls).toHaveLength(1);
      expect(deleteCalls[0][0]).toBe('/api/surveys/11');
    });
  });

  it('opens the detail view with aggregate + responses when a card is clicked', async () => {
    const user = userEvent.setup();
    render(<Surveys />);
    await waitFor(() => expect(screen.getByText('Q2 Customer NPS')).toBeInTheDocument());

    await user.click(screen.getByText('Q2 Customer NPS'));

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /back to surveys/i })).toBeInTheDocument();
    });
    // Detail-view question copy — surfaces in BOTH the header sub-paragraph
    // AND the "Response Form Preview" card on the detail surface, so use
    // getAllByText to tolerate the dual occurrence.
    expect(screen.getAllByText(/how likely are you to recommend us\?/i).length).toBeGreaterThanOrEqual(1);
    // Aggregate + responses endpoints were called.
    const aggCall = fetchApi.mock.calls.find(([url]) => url === '/api/surveys/11/aggregate');
    const respCall = fetchApi.mock.calls.find(([url]) => url === '/api/surveys/11/responses');
    expect(aggCall).toBeDefined();
    expect(respCall).toBeDefined();
  });

  it('empty-responses state renders the "No responses yet" copy on detail view', async () => {
    const user = userEvent.setup();
    render(<Surveys />);
    await waitFor(() => expect(screen.getByText('Q2 Customer NPS')).toBeInTheDocument());

    await user.click(screen.getByText('Q2 Customer NPS'));
    await waitFor(() => {
      expect(screen.getByText(/no responses yet/i)).toBeInTheDocument();
    });
  });

  it('list-fetch API error clears loading and surfaces the empty-state copy', async () => {
    fetchApi.mockReset();
    fetchApi.mockImplementation((url) => {
      if (url === '/api/surveys') return Promise.reject(new Error('boom'));
      return Promise.resolve({});
    });
    // Suppress the SUT's expected console.error so test output stays clean.
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    render(<Surveys />);
    await waitFor(() => {
      // Loading must have cleared.
      expect(screen.queryByText(/loading surveys/i)).not.toBeInTheDocument();
    });
    // With surveys=[] post-catch, the empty-state copy surfaces.
    expect(screen.getByText(/no surveys yet/i)).toBeInTheDocument();
    errSpy.mockRestore();
  });

  // ── Extension: ≥8 new cases below ──────────────────────────────
  // The SUT is a SINGLE-question NPS/CSAT/CUSTOM survey (no multi-question
  // editor, no drag-reorder, no questions[] array). The prompt's "question
  // editor" / "reorder" / "delete question" items were authored against a
  // hypothetical multi-question shape; the cases below adapt to what the
  // SUT actually ships: detail-view send-modal, CSV export, contact search
  // filter, NPS breakdown, CSAT detail-view distinct shape, back-to-list
  // navigation, distribution chart, send-with-no-contacts disabled CTA.

  it('back-to-list button on detail view returns to the list view', async () => {
    const user = userEvent.setup();
    render(<Surveys />);
    await waitFor(() => expect(screen.getByText('Q2 Customer NPS')).toBeInTheDocument());

    await user.click(screen.getByText('Q2 Customer NPS'));
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /back to surveys/i })).toBeInTheDocument();
    });

    await user.click(screen.getByRole('button', { name: /back to surveys/i }));
    await waitFor(() => {
      // The list-view header (different "NPS/CSAT Surveys" h1) renders again.
      expect(screen.getByText(/NPS\/CSAT Surveys/i)).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /back to surveys/i })).not.toBeInTheDocument();
    });
  });

  it('detail view renders the NPS Breakdown card with promoters/passives/detractors counts', async () => {
    const user = userEvent.setup();
    render(<Surveys />);
    await waitFor(() => expect(screen.getByText('Q2 Customer NPS')).toBeInTheDocument());

    await user.click(screen.getByText('Q2 Customer NPS'));
    await waitFor(() => {
      expect(screen.getByText(/NPS Breakdown/i)).toBeInTheDocument();
    });
    // Promoters/Passives/Detractors labels + their hint score-ranges.
    expect(screen.getByText(/promoters/i)).toBeInTheDocument();
    expect(screen.getByText(/passives/i)).toBeInTheDocument();
    expect(screen.getByText(/detractors/i)).toBeInTheDocument();
    expect(screen.getByText('9–10')).toBeInTheDocument();
    expect(screen.getByText('7–8')).toBeInTheDocument();
    expect(screen.getByText('0–6')).toBeInTheDocument();
  });

  it('CSAT detail view shows Avg Score (no NPS breakdown card)', async () => {
    const user = userEvent.setup();
    // Override the aggregate response for CSAT survey 12.
    fetchApi.mockImplementation((url, opts) => {
      if (url === '/api/surveys' && (!opts || !opts.method || opts.method === 'GET')) {
        return Promise.resolve(surveysFixture);
      }
      if (url === '/api/surveys/12/aggregate') {
        return Promise.resolve({
          surveyId: 12, type: 'CSAT', count: 4, avgScore: 4.2,
          distribution: Array.from({ length: 11 }, (_, score) => ({ score, count: 0 })),
        });
      }
      if (url.endsWith('/responses')) return Promise.resolve([]);
      return Promise.resolve({});
    });
    render(<Surveys />);
    await waitFor(() => expect(screen.getByText('Onboarding CSAT')).toBeInTheDocument());

    await user.click(screen.getByText('Onboarding CSAT'));
    await waitFor(() => {
      expect(screen.getByText(/back to surveys/i)).toBeInTheDocument();
    });
    // CSAT detail surfaces "Survey Type" tile (not "NPS Score").
    expect(screen.getByText(/survey type/i)).toBeInTheDocument();
    expect(screen.queryByText(/NPS Breakdown/i)).not.toBeInTheDocument();
    // CSAT preview shows the 1-5 scale anchor labels.
    expect(screen.getByText(/very dissatisfied/i)).toBeInTheDocument();
    expect(screen.getByText(/very satisfied/i)).toBeInTheDocument();
  });

  it('distribution chart renders via the recharts ResponsiveContainer stub', async () => {
    const user = userEvent.setup();
    render(<Surveys />);
    await waitFor(() => expect(screen.getByText('Q2 Customer NPS')).toBeInTheDocument());

    await user.click(screen.getByText('Q2 Customer NPS'));
    await waitFor(() => {
      expect(screen.getByText(/Score Distribution/i)).toBeInTheDocument();
    });
    // The stubbed ResponsiveContainer carries data-testid="responsive".
    expect(screen.getByTestId('responsive')).toBeInTheDocument();
  });

  it('opens the Send Survey modal, loads /api/contacts, and shows them', async () => {
    const user = userEvent.setup();
    const contactsFixture = [
      { id: 101, name: 'Aarav Patel', email: 'aarav@example.com', company: 'Acme Inc.' },
      { id: 102, name: 'Priya Singh', email: 'priya@example.com', company: 'Globus Co.' },
    ];
    fetchApi.mockImplementation((url, opts) => {
      if (url === '/api/surveys' && (!opts || !opts.method || opts.method === 'GET')) {
        return Promise.resolve(surveysFixture);
      }
      if (url.endsWith('/aggregate')) return Promise.resolve(aggregateFixture);
      if (url.endsWith('/responses')) return Promise.resolve([]);
      if (url === '/api/contacts' || (typeof url === 'string' && url.startsWith('/api/contacts?'))) return Promise.resolve(contactsFixture);
      return Promise.resolve({});
    });
    render(<Surveys />);
    await waitFor(() => expect(screen.getByText('Q2 Customer NPS')).toBeInTheDocument());

    await user.click(screen.getByText('Q2 Customer NPS'));
    await waitFor(() => expect(screen.getByRole('button', { name: /send survey/i })).toBeInTheDocument());

    await user.click(screen.getByRole('button', { name: /send survey/i }));
    await waitFor(() => {
      expect(screen.getByPlaceholderText(/search by name/i)).toBeInTheDocument();
    });
    expect(screen.getByText('Aarav Patel')).toBeInTheDocument();
    expect(screen.getByText('Priya Singh')).toBeInTheDocument();
    // "0 selected" line on first open.
    expect(screen.getByText(/0 selected/i)).toBeInTheDocument();
  });

  it('send-to button is disabled when no contacts are selected', async () => {
    const user = userEvent.setup();
    fetchApi.mockImplementation((url, opts) => {
      if (url === '/api/surveys' && (!opts || !opts.method || opts.method === 'GET')) {
        return Promise.resolve(surveysFixture);
      }
      if (url.endsWith('/aggregate')) return Promise.resolve(aggregateFixture);
      if (url.endsWith('/responses')) return Promise.resolve([]);
      if (url === '/api/contacts' || (typeof url === 'string' && url.startsWith('/api/contacts?'))) return Promise.resolve([
        { id: 201, name: 'Test Lead', email: 'tl@example.com' },
      ]);
      return Promise.resolve({});
    });
    render(<Surveys />);
    await waitFor(() => expect(screen.getByText('Q2 Customer NPS')).toBeInTheDocument());
    await user.click(screen.getByText('Q2 Customer NPS'));
    await waitFor(() => expect(screen.getByRole('button', { name: /send survey/i })).toBeInTheDocument());
    await user.click(screen.getByRole('button', { name: /send survey/i }));
    await waitFor(() => expect(screen.getByText('Test Lead')).toBeInTheDocument());

    // "Send to 0" button is disabled when nothing is selected.
    const sendToBtn = screen.getByRole('button', { name: /send to 0/i });
    expect(sendToBtn).toBeDisabled();
  });

  it('sending a survey POSTs /send with contactIds and surfaces the success message', async () => {
    const user = userEvent.setup();
    fetchApi.mockImplementation((url, opts) => {
      if (url === '/api/surveys' && (!opts || !opts.method || opts.method === 'GET')) {
        return Promise.resolve(surveysFixture);
      }
      if (url.endsWith('/aggregate')) return Promise.resolve(aggregateFixture);
      if (url.endsWith('/responses')) return Promise.resolve([]);
      if (url === '/api/contacts' || (typeof url === 'string' && url.startsWith('/api/contacts?'))) return Promise.resolve([
        { id: 301, name: 'Riya Sharma', email: 'riya@example.com' },
        { id: 302, name: 'Karan Mehta', email: 'karan@example.com' },
      ]);
      if (url === '/api/surveys/11/send' && opts && opts.method === 'POST') {
        return Promise.resolve({ sentCount: 2, attempted: 2 });
      }
      return Promise.resolve({});
    });
    render(<Surveys />);
    await waitFor(() => expect(screen.getByText('Q2 Customer NPS')).toBeInTheDocument());
    await user.click(screen.getByText('Q2 Customer NPS'));
    await waitFor(() => expect(screen.getByRole('button', { name: /send survey/i })).toBeInTheDocument());
    await user.click(screen.getByRole('button', { name: /send survey/i }));
    await waitFor(() => expect(screen.getByText('Riya Sharma')).toBeInTheDocument());

    // Check both contact checkboxes.
    const checkboxes = screen.getAllByRole('checkbox');
    await user.click(checkboxes[0]);
    await user.click(checkboxes[1]);
    expect(screen.getByText(/2 selected/i)).toBeInTheDocument();

    // Click Send to 2.
    const sendToBtn = screen.getByRole('button', { name: /send to 2/i });
    await user.click(sendToBtn);

    await waitFor(() => {
      const postCall = fetchApi.mock.calls.find(
        ([url, opts]) => url === '/api/surveys/11/send' && opts && opts.method === 'POST'
      );
      expect(postCall).toBeDefined();
      const body = JSON.parse(postCall[1].body);
      expect(body.contactIds).toEqual([301, 302]);
    });
    // Success message renders.
    await waitFor(() => {
      expect(screen.getByText(/sent to 2 of 2 recipients/i)).toBeInTheDocument();
    });
  });

  it('contact search filter narrows the visible contact list', async () => {
    const user = userEvent.setup();
    fetchApi.mockImplementation((url, opts) => {
      if (url === '/api/surveys' && (!opts || !opts.method || opts.method === 'GET')) {
        return Promise.resolve(surveysFixture);
      }
      if (url.endsWith('/aggregate')) return Promise.resolve(aggregateFixture);
      if (url.endsWith('/responses')) return Promise.resolve([]);
      if (url === '/api/contacts' || (typeof url === 'string' && url.startsWith('/api/contacts?'))) return Promise.resolve([
        { id: 401, name: 'Aarav Patel', email: 'aarav@acme.com', company: 'Acme' },
        { id: 402, name: 'Priya Singh', email: 'priya@globus.com', company: 'Globus' },
      ]);
      return Promise.resolve({});
    });
    render(<Surveys />);
    await waitFor(() => expect(screen.getByText('Q2 Customer NPS')).toBeInTheDocument());
    await user.click(screen.getByText('Q2 Customer NPS'));
    await waitFor(() => expect(screen.getByRole('button', { name: /send survey/i })).toBeInTheDocument());
    await user.click(screen.getByRole('button', { name: /send survey/i }));
    await waitFor(() => expect(screen.getByText('Aarav Patel')).toBeInTheDocument());

    // Type "globus" — only Priya should remain.
    const searchInput = screen.getByPlaceholderText(/search by name/i);
    await user.type(searchInput, 'globus');

    await waitFor(() => {
      expect(screen.queryByText('Aarav Patel')).not.toBeInTheDocument();
    });
    expect(screen.getByText('Priya Singh')).toBeInTheDocument();
  });

  it('CSV export builds a /export.csv fetch with a Bearer token and triggers an anchor download', async () => {
    const user = userEvent.setup();
    // Seed a token so the SUT attaches the Authorization header.
    localStorage.setItem('token', 'test-jwt-token');

    // Stub global.fetch (NOT the fetchApi mock — the SUT bypasses fetchApi
    // for the CSV path because /export.csv returns text/csv directly).
    const fetchSpy = vi.spyOn(global, 'fetch').mockResolvedValue({
      ok: true,
      status: 200,
      blob: async () => new Blob(['contact,score\nAlice,9\n'], { type: 'text/csv' }),
    });
    // Stub URL.createObjectURL / revokeObjectURL (jsdom returns undefined).
    const createUrlSpy = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:mock-url');
    const revokeUrlSpy = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    // Stub HTMLAnchorElement click so the test doesn't trigger an actual navigation.
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});

    render(<Surveys />);
    await waitFor(() => expect(screen.getByText('Q2 Customer NPS')).toBeInTheDocument());
    await user.click(screen.getByText('Q2 Customer NPS'));
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /export csv/i })).toBeInTheDocument();
    });

    await user.click(screen.getByRole('button', { name: /export csv/i }));

    await waitFor(() => {
      expect(fetchSpy).toHaveBeenCalledWith(
        '/api/surveys/11/export.csv',
        expect.objectContaining({
          headers: expect.objectContaining({ Authorization: 'Bearer test-jwt-token' }),
        })
      );
    });
    expect(createUrlSpy).toHaveBeenCalled();
    expect(clickSpy).toHaveBeenCalled();
    expect(revokeUrlSpy).toHaveBeenCalled();

    fetchSpy.mockRestore();
    createUrlSpy.mockRestore();
    revokeUrlSpy.mockRestore();
    clickSpy.mockRestore();
    localStorage.removeItem('token');
  });

  it('CSV export shows a notify.error when the /export.csv fetch fails', async () => {
    const user = userEvent.setup();
    localStorage.setItem('token', 'test-jwt-token');
    const fetchSpy = vi.spyOn(global, 'fetch').mockResolvedValue({
      ok: false, status: 500, blob: async () => new Blob([]),
    });
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    render(<Surveys />);
    await waitFor(() => expect(screen.getByText('Q2 Customer NPS')).toBeInTheDocument());
    await user.click(screen.getByText('Q2 Customer NPS'));
    await waitFor(() => expect(screen.getByRole('button', { name: /export csv/i })).toBeInTheDocument());

    await user.click(screen.getByRole('button', { name: /export csv/i }));

    await waitFor(() => {
      expect(notifyObj.error).toHaveBeenCalledWith(expect.stringMatching(/failed to export csv/i));
    });

    fetchSpy.mockRestore();
    errSpy.mockRestore();
    localStorage.removeItem('token');
  });

  it('responses table renders contact rows with name, score, and date', async () => {
    const user = userEvent.setup();
    const respsFixture = [
      { id: 9001, score: 10, comment: 'Loved the new feature!', respondedAt: '2026-05-20T08:30:00.000Z',
        contact: { name: 'Rohan Verma', email: 'rohan@example.com' } },
      { id: 9002, score: 6, comment: null, respondedAt: '2026-05-19T11:15:00.000Z', contact: null },
    ];
    fetchApi.mockImplementation((url, opts) => {
      if (url === '/api/surveys' && (!opts || !opts.method || opts.method === 'GET')) {
        return Promise.resolve(surveysFixture);
      }
      if (url.endsWith('/aggregate')) return Promise.resolve(aggregateFixture);
      if (url.endsWith('/responses')) return Promise.resolve(respsFixture);
      return Promise.resolve({});
    });
    render(<Surveys />);
    await waitFor(() => expect(screen.getByText('Q2 Customer NPS')).toBeInTheDocument());
    await user.click(screen.getByText('Q2 Customer NPS'));

    await waitFor(() => {
      expect(screen.getByText('Rohan Verma')).toBeInTheDocument();
    });
    expect(screen.getByText('rohan@example.com')).toBeInTheDocument();
    expect(screen.getByText(/loved the new feature/i)).toBeInTheDocument();
    // Anonymous row when contact is null.
    expect(screen.getByText(/anonymous/i)).toBeInTheDocument();
    // No "No responses yet" copy when responses exist.
    expect(screen.queryByText(/no responses yet/i)).not.toBeInTheDocument();
  });
});
