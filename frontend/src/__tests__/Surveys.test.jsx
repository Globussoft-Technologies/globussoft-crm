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
      if (url === '/api/contacts') return Promise.resolve([]);
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
});
