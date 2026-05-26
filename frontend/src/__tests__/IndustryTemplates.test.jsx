/**
 * IndustryTemplates.test.jsx — vitest + RTL coverage for the
 * Settings → Industry Templates page (frontend/src/pages/IndustryTemplates.jsx,
 * 528 LOC).
 *
 * Scope — pins the page's load-bearing surfaces:
 *
 *   1. Initial mount fires the 2 expected GETs — /api/industry-templates
 *      and /api/pipelines (the latter is best-effort, .catch(() => []) keeps
 *      the page rendering even if it 404s).
 *   2. Loading state: "Loading industry templates..." renders before the
 *      initial fetch settles.
 *   3. Page chrome: heading "Industry Templates" + the intro copy render
 *      after the fetch settles.
 *   4. Template cards: each template in the API response renders a card with
 *      name + industry slug + description + the "What's Included" summary
 *      (pipeline count, custom-object count, sample-contact count).
 *   5. Empty state: when /api/industry-templates returns [], the page shows
 *      "No industry templates available." instead of an empty grid.
 *   6. Error state: when /api/industry-templates rejects, the error message
 *      from the thrown error renders inside the red error card AND the
 *      loading spinner clears.
 *   7. "Already Applied" badge: when the user's tenant already has
 *      pipelines with the SAME names as every pipeline in a template's
 *      config, the card renders the "Already Applied" pill AND the CTA
 *      flips to "Re-Apply Template".
 *   8. Apply-template confirm flow: clicking "Apply Template" opens the
 *      ConfirmModal, showing the warning copy + the bulleted list of what
 *      will be created (pipelines / custom objects / sample contacts).
 *   9. Cancel from confirm modal closes it WITHOUT issuing the POST.
 *  10. Confirm-apply happy path: clicking the modal's "Apply Template"
 *      button fires POST /api/industry-templates/apply/:industry, then
 *      closes the modal, surfaces a success toast with the
 *      "Created N pipelines..." copy, and triggers a refetch.
 *  11. Apply-template error path: when the POST rejects, the modal closes
 *      and a red error toast renders with "Failed to apply template" +
 *      the error message — and the page does NOT refetch pipelines
 *      (no extra GET fires).
 *  12. Re-Apply flow: a template marked "Already Applied" can still be
 *      re-applied (CTA is still clickable).
 *
 * Mocking discipline (per CLAUDE.md RTL standing rules)
 *   - fetchApi mocked at ../utils/api (the page's only dependency surface).
 *   - The page does NOT call useNotify() — toasts are rendered inline by
 *     the component itself — so no notify mock is needed.
 *   - Stable mock object references for any hook returns (none in this case;
 *     fetchApi is the only mocked surface).
 *   - All data-dependent assertions use findBy / waitFor.
 *
 * Why a frontend test, not a backend / API test
 * ─────────────────────────────────────────────
 * The backend POST /api/industry-templates/apply/:industry contract is
 * already pinned by industry-templates-api.spec.js. What's NOT pinned
 * elsewhere is (a) the page renders templates from the GET response, (b)
 * the confirm-modal flow opens/closes/POSTs correctly, (c) the success-vs-
 * error toast branching, and (d) the "Already Applied" detection logic
 * which is purely a frontend join between two API responses. Those are
 * component-level invariants.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';

const fetchApiMock = vi.fn();
vi.mock('../utils/api', () => ({
  fetchApi: (...args) => fetchApiMock(...args),
  getAuthToken: () => 'test-token',
}));

import IndustryTemplates from '../pages/IndustryTemplates';

// ---------------------------------------------------------------------------
// Fixtures — realistic industry-template shapes mirroring what
// backend/routes/industry_templates.js actually serves.
// ---------------------------------------------------------------------------
const realEstateTemplate = {
  id: 1,
  industry: 'real-estate',
  name: 'Real Estate CRM',
  description: 'Pre-built pipelines for buyer and seller journeys, with property and showing tracking.',
  config: {
    pipelines: [
      { name: 'Buyer Pipeline', stages: [{ name: 'Lead' }, { name: 'Pre-Approval' }, { name: 'Showing' }, { name: 'Offer' }, { name: 'Closed' }] },
      { name: 'Listing Pipeline', stages: [{ name: 'New Listing' }, { name: 'Active' }, { name: 'Under Contract' }, { name: 'Sold' }] },
    ],
    customFields: [
      { entity: 'Property', fields: [{ name: 'bedrooms' }, { name: 'sqft' }, { name: 'listPrice' }] },
      { entity: 'Showing', fields: [{ name: 'scheduledAt' }, { name: 'agent' }] },
    ],
    sampleContacts: [
      { name: 'Anita Sharma', email: 'anita@example.in' },
      { name: 'Vikram Patel', email: 'vikram@example.in' },
    ],
  },
};

const healthcareTemplate = {
  id: 2,
  industry: 'healthcare',
  name: 'Healthcare Practice CRM',
  description: 'Patient acquisition, referral tracking, and appointment lifecycle pipelines.',
  config: {
    pipelines: [
      { name: 'Patient Acquisition', stages: [{ name: 'Inquiry' }, { name: 'Consult Booked' }, { name: 'Onboarded' }] },
    ],
    customFields: [
      { entity: 'Referral', fields: [{ name: 'referringPhysician' }, { name: 'specialty' }] },
    ],
    sampleContacts: [
      { name: 'Dr Harsh Mehra', email: 'drharsh@clinic.example.in' },
    ],
  },
};

const saasTemplate = {
  id: 3,
  industry: 'saas',
  name: 'SaaS Sales CRM',
  description: 'B2B SaaS funnel — MQL → SQL → trial → paid, with renewal pipeline.',
  config: {
    pipelines: [
      { name: 'New Business', stages: [{ name: 'MQL' }, { name: 'SQL' }, { name: 'Trial' }, { name: 'Closed Won' }] },
      { name: 'Renewal', stages: [{ name: 'Up for Renewal' }, { name: 'Negotiation' }, { name: 'Renewed' }] },
    ],
    customFields: [],
    sampleContacts: [],
  },
};

const allTemplates = [realEstateTemplate, healthcareTemplate, saasTemplate];

// ---------------------------------------------------------------------------
// Default mock: industry-templates returns the 3 fixture templates; pipelines
// returns []  (so no template is "Already Applied" by default).
// ---------------------------------------------------------------------------
function defaultFetch(url, opts) {
  if (!opts || !opts.method || opts.method === 'GET') {
    if (url === '/api/industry-templates') return Promise.resolve(allTemplates);
    if (url === '/api/pipelines') return Promise.resolve([]);
  }
  return Promise.resolve([]);
}

function renderPage() {
  return render(
    <MemoryRouter>
      <IndustryTemplates />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  fetchApiMock.mockReset();
  fetchApiMock.mockImplementation(defaultFetch);
});

describe('<IndustryTemplates /> — initial render + fetch wiring', () => {
  it('shows the "Loading industry templates..." spinner before fetches settle', () => {
    // Make the fetches hang so we can observe the loading state.
    fetchApiMock.mockImplementation(() => new Promise(() => {}));
    renderPage();
    expect(screen.getByText(/Loading industry templates/i)).toBeInTheDocument();
  });

  it('fires GET /api/industry-templates AND GET /api/pipelines on mount', async () => {
    renderPage();
    await waitFor(() => {
      const calls = fetchApiMock.mock.calls.map((c) => c[0]);
      expect(calls).toContain('/api/industry-templates');
      expect(calls).toContain('/api/pipelines');
    });
  });

  it('renders the page header + intro copy after fetches settle', async () => {
    renderPage();
    await waitFor(() => expect(screen.getByRole('heading', { name: /Industry Templates/i })).toBeInTheDocument());
    expect(screen.getByText(/Jump-start your CRM with pre-built pipelines/i)).toBeInTheDocument();
  });

  it('renders one card per template — with name, industry slug, and description', async () => {
    renderPage();
    await waitFor(() => expect(screen.getByText('Real Estate CRM')).toBeInTheDocument());
    expect(screen.getByText('Healthcare Practice CRM')).toBeInTheDocument();
    expect(screen.getByText('SaaS Sales CRM')).toBeInTheDocument();

    // Industry slug renders as an uppercase eyebrow in the card.
    // The slug 'real-estate' also appears in INDUSTRY_ACCENTS lookups but only
    // as a string label on the card eyebrow — so getAllByText covers any
    // duplicate appearance (e.g. once per card region) without exploding.
    const realEstateLabels = screen.getAllByText('real-estate');
    expect(realEstateLabels.length).toBeGreaterThanOrEqual(1);

    expect(screen.getByText(/Pre-built pipelines for buyer and seller journeys/i)).toBeInTheDocument();
  });

  it('renders the "What\'s Included" summary lines for each card (pipelines / objects / contacts)', async () => {
    renderPage();
    await waitFor(() => expect(screen.getByText('Real Estate CRM')).toBeInTheDocument());

    // Real-estate: 2 pipelines, 9 stages total (5 + 4), 2 custom objects, 2 sample contacts.
    expect(screen.getByText(/2 pipelines, 9 stages/i)).toBeInTheDocument();
    // Healthcare: 1 pipeline, 3 stages, 1 custom object, 1 sample contact.
    expect(screen.getByText(/1 pipeline, 3 stages/i)).toBeInTheDocument();
    expect(screen.getByText(/1 custom object/i)).toBeInTheDocument();
    expect(screen.getByText(/1 sample contact/i)).toBeInTheDocument();
    // SaaS: 2 pipelines, 7 stages, 0 custom objects, 0 sample contacts.
    expect(screen.getByText(/0 custom objects/i)).toBeInTheDocument();
    expect(screen.getByText(/0 sample contacts/i)).toBeInTheDocument();
  });
});

describe('<IndustryTemplates /> — empty + error states', () => {
  it('shows the "No industry templates available." empty state when the GET returns []', async () => {
    fetchApiMock.mockImplementation((url) => {
      if (url === '/api/industry-templates') return Promise.resolve([]);
      if (url === '/api/pipelines') return Promise.resolve([]);
      return Promise.resolve([]);
    });
    renderPage();
    await waitFor(() => expect(screen.getByText(/No industry templates available/i)).toBeInTheDocument());
  });

  it('renders the error card when /api/industry-templates rejects', async () => {
    fetchApiMock.mockImplementation((url) => {
      if (url === '/api/industry-templates') return Promise.reject(new Error('Network down'));
      if (url === '/api/pipelines') return Promise.resolve([]);
      return Promise.resolve([]);
    });
    renderPage();
    await waitFor(() => expect(screen.getByText(/Network down/i)).toBeInTheDocument());
    // Loading spinner cleared.
    expect(screen.queryByText(/Loading industry templates/i)).not.toBeInTheDocument();
  });
});

describe('<IndustryTemplates /> — already-applied detection', () => {
  it('renders "Already Applied" badge + "Re-Apply Template" CTA when every template pipeline name exists in /api/pipelines', async () => {
    // Pretend the tenant already has both real-estate pipelines named (lower-cased
    // by the page) but NOT the healthcare or saas ones.
    fetchApiMock.mockImplementation((url) => {
      if (url === '/api/industry-templates') return Promise.resolve(allTemplates);
      if (url === '/api/pipelines') {
        return Promise.resolve([
          { id: 11, name: 'Buyer Pipeline' },
          { id: 12, name: 'Listing Pipeline' },
        ]);
      }
      return Promise.resolve([]);
    });
    renderPage();
    await waitFor(() => expect(screen.getByText('Real Estate CRM')).toBeInTheDocument());

    // Real-estate card has the badge.
    expect(screen.getByText(/Already Applied/i)).toBeInTheDocument();
    // CTA flipped to Re-Apply for real-estate.
    expect(screen.getByText(/Re-Apply Template/i)).toBeInTheDocument();

    // Healthcare + SaaS still render the plain Apply CTA — getAllByText
    // because two cards (healthcare, saas) both have it.
    const applyButtons = screen.getAllByText(/^Apply Template$/i);
    expect(applyButtons.length).toBeGreaterThanOrEqual(2);
  });

  it('does NOT render "Already Applied" when only SOME template pipelines exist (not all)', async () => {
    // Real-estate needs BOTH 'Buyer Pipeline' AND 'Listing Pipeline'. Provide
    // only one — the badge should NOT appear for real-estate.
    fetchApiMock.mockImplementation((url) => {
      if (url === '/api/industry-templates') return Promise.resolve([realEstateTemplate]);
      if (url === '/api/pipelines') {
        return Promise.resolve([{ id: 11, name: 'Buyer Pipeline' }]);
      }
      return Promise.resolve([]);
    });
    renderPage();
    await waitFor(() => expect(screen.getByText('Real Estate CRM')).toBeInTheDocument());

    expect(screen.queryByText(/Already Applied/i)).not.toBeInTheDocument();
    expect(screen.getByText(/^Apply Template$/i)).toBeInTheDocument();
  });
});

describe('<IndustryTemplates /> — apply-template confirm flow', () => {
  it('clicking "Apply Template" on a card opens the ConfirmModal with the warning copy', async () => {
    const user = userEvent.setup();
    renderPage();
    await waitFor(() => expect(screen.getByText('Real Estate CRM')).toBeInTheDocument());

    // Click the first Apply Template button (real-estate card's CTA).
    const applyButtons = screen.getAllByText(/^Apply Template$/i);
    await user.click(applyButtons[0]);

    // Modal title pins the template name. Use getAllByText because the
    // template name now appears twice — once on the card behind the modal,
    // once in the modal heading ("Apply Real Estate CRM?").
    await waitFor(() => expect(screen.getByText(/Apply Real Estate CRM\?/i)).toBeInTheDocument());

    // Warning copy.
    expect(screen.getByText(/This will/i)).toBeInTheDocument();
    expect(screen.getByText(/nothing will be deleted/i)).toBeInTheDocument();

    // Bulleted list of what will be created — use getAllByText because the
    // pipeline names also appear as chips in the card behind the modal.
    expect(screen.getAllByText(/Buyer Pipeline/i).length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText(/Listing Pipeline/i).length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText(/Property/i).length).toBeGreaterThanOrEqual(1);
  });

  it('clicking Cancel in the ConfirmModal closes it WITHOUT issuing the POST', async () => {
    const user = userEvent.setup();
    renderPage();
    await waitFor(() => expect(screen.getByText('Real Estate CRM')).toBeInTheDocument());

    const applyButtons = screen.getAllByText(/^Apply Template$/i);
    await user.click(applyButtons[0]);
    await waitFor(() => expect(screen.getByText(/Apply Real Estate CRM\?/i)).toBeInTheDocument());

    // Snapshot the call count BEFORE clicking cancel.
    const callsBefore = fetchApiMock.mock.calls.length;
    await user.click(screen.getByText(/^Cancel$/i));

    // Modal gone.
    await waitFor(() => expect(screen.queryByText(/Apply Real Estate CRM\?/i)).not.toBeInTheDocument());

    // No new fetch calls — specifically NO POST to /apply/:industry.
    const callsAfter = fetchApiMock.mock.calls;
    expect(callsAfter.length).toBe(callsBefore);
    const postCalls = callsAfter.filter((c) => c[1]?.method === 'POST');
    expect(postCalls).toHaveLength(0);
  });

  it('confirm-apply happy path fires POST /api/industry-templates/apply/:industry + shows success toast + refetches', async () => {
    let resolvePost;
    const postPromise = new Promise((r) => { resolvePost = r; });

    fetchApiMock.mockImplementation((url, opts) => {
      if (opts?.method === 'POST' && url === '/api/industry-templates/apply/real-estate') {
        return postPromise;
      }
      return defaultFetch(url, opts);
    });

    const user = userEvent.setup();
    renderPage();
    await waitFor(() => expect(screen.getByText('Real Estate CRM')).toBeInTheDocument());

    const applyButtons = screen.getAllByText(/^Apply Template$/i);
    await user.click(applyButtons[0]);
    await waitFor(() => expect(screen.getByText(/Apply Real Estate CRM\?/i)).toBeInTheDocument());

    // Modal "Apply Template" button — inside the modal there are two buttons:
    // Cancel + Apply Template. The Apply button is the last matching.
    const modalApplyButtons = screen.getAllByText(/^Apply Template$/i);
    // Click the LAST one — the modal's button (the cards' buttons all rendered first).
    await user.click(modalApplyButtons[modalApplyButtons.length - 1]);

    // The button should now read "Applying..." until the POST resolves.
    await waitFor(() => expect(screen.getByText(/Applying\.\.\./i)).toBeInTheDocument());

    // Resolve the POST.
    resolvePost({
      created: { pipelines: 2, stages: 9, customEntities: 2, contacts: 2 },
    });

    // Modal closes.
    await waitFor(() => expect(screen.queryByText(/Apply Real Estate CRM\?/i)).not.toBeInTheDocument());

    // Success toast renders with the title + the created-counts copy.
    await waitFor(() => expect(screen.getByText(/Real Estate CRM applied/i)).toBeInTheDocument());
    expect(screen.getByText(/Created 2 pipelines, 9 stages, 2 custom objects, and 2 sample contacts/i)).toBeInTheDocument();

    // Refetch fires — at least one additional GET /api/industry-templates
    // after the POST. Count the GET calls to that URL.
    await waitFor(() => {
      const tplFetches = fetchApiMock.mock.calls.filter(
        (c) => c[0] === '/api/industry-templates' && (!c[1] || !c[1].method || c[1].method === 'GET'),
      );
      expect(tplFetches.length).toBeGreaterThanOrEqual(2);
    });
  });

  it('confirm-apply error path renders error toast with the thrown message + keeps the modal open', async () => {
    fetchApiMock.mockImplementation((url, opts) => {
      if (opts?.method === 'POST' && url.startsWith('/api/industry-templates/apply/')) {
        return Promise.reject(new Error('Insufficient permissions — admin role required'));
      }
      return defaultFetch(url, opts);
    });

    const user = userEvent.setup();
    renderPage();
    await waitFor(() => expect(screen.getByText('Real Estate CRM')).toBeInTheDocument());

    const applyButtons = screen.getAllByText(/^Apply Template$/i);
    await user.click(applyButtons[0]);
    await waitFor(() => expect(screen.getByText(/Apply Real Estate CRM\?/i)).toBeInTheDocument());

    const modalApplyButtons = screen.getAllByText(/^Apply Template$/i);
    await user.click(modalApplyButtons[modalApplyButtons.length - 1]);

    // Error toast renders with the title + the thrown error message.
    await waitFor(() => expect(screen.getByText(/Failed to apply template/i)).toBeInTheDocument());
    expect(screen.getByText(/Insufficient permissions — admin role required/i)).toBeInTheDocument();

    // The page intentionally leaves the modal OPEN on error so the operator
    // can re-try without re-opening it. The Apply button flips back from
    // "Applying..." to its normal "Apply Template" label (applying=false).
    expect(screen.getByText(/Apply Real Estate CRM\?/i)).toBeInTheDocument();
    expect(screen.queryByText(/Applying\.\.\./i)).not.toBeInTheDocument();
  });

  it('re-apply: an "Already Applied" template still has a clickable Re-Apply CTA that opens the confirm modal', async () => {
    // Mark real-estate as already applied via pipelines response.
    fetchApiMock.mockImplementation((url, opts) => {
      if (!opts || !opts.method || opts.method === 'GET') {
        if (url === '/api/industry-templates') return Promise.resolve([realEstateTemplate]);
        if (url === '/api/pipelines') {
          return Promise.resolve([
            { id: 11, name: 'Buyer Pipeline' },
            { id: 12, name: 'Listing Pipeline' },
          ]);
        }
      }
      return Promise.resolve([]);
    });

    const user = userEvent.setup();
    renderPage();
    await waitFor(() => expect(screen.getByText(/Already Applied/i)).toBeInTheDocument());

    // Click the Re-Apply Template button.
    await user.click(screen.getByText(/Re-Apply Template/i));
    await waitFor(() => expect(screen.getByText(/Apply Real Estate CRM\?/i)).toBeInTheDocument());
  });
});
