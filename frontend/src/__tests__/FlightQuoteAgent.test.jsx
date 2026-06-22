/**
 * FlightQuoteAgent.test.jsx — vitest + RTL coverage for the Travel-vertical
 * flight quick-quote page (frontend/src/pages/travel/FlightQuoteAgent.jsx).
 *
 * Lands at /travel/flights/quote (PRD §7 page plan). In-CRM fallback for the
 * not-yet-built Chrome flight plugin: advisor manually enters up to 4 flight
 * options, picks a contact, markup rules preview client-side (display only),
 * and submit POSTs the authed plugin-mirror endpoint which applies markup
 * server-side and persists flight ItineraryItems on a draft Itinerary.
 *
 * Scope (9 cases):
 *   1. Page chrome: heading + contact search + contact select + sub-brand
 *      select + currency + Add option + Create quote all render.
 *   2. Mount fetches: GET /api/contacts?limit=200 + GET
 *      /api/travel/markup-rules?subBrand=tmc&scope=flight&active=true
 *      (ADMIN defaults to "tmc" via defaultSubBrandFor preferred brand).
 *   3. Add option: starts at 1 row; clicking "Add option" 3× yields 4 rows
 *      and the button disables at the MAX_OPTIONS=4 cap.
 *   4. Remove option: with 2 rows, "Remove option 2" drops back to 1 row;
 *      the remove button is disabled when only 1 row remains.
 *   5. Contact search: typing into the search box narrows the contact
 *      <select> options by name/phone substring (client-side filter — the
 *      backend /api/contacts has no ?search param today).
 *   6. Validation: submit with no contact → notify.error("Contact is
 *      required"), no POST fired.
 *   7. Validation: contact picked but option 1 has no airline →
 *      notify.error(/airline is required/), no POST fired.
 *   8. Submit happy path: POSTs /api/v1/flight-plugin/agent-quotes with
 *      { contactId(number), subBrand, currency, options:[{ airline UPPER,
 *      pricePerPax(number), route:{from,to} UPPER }] } and renders the
 *      result panel (Quote created + total + PDF link carrying ?_t= token).
 *   9. Send to customer: from the result panel, "Send to customer" POSTs
 *      /api/travel/itineraries/:id/share with { channel:"auto" } (email-first,
 *      WhatsApp fallback) and surfaces the share URL + Copy-link button.
 *
 * Backend contract pinned (per the SUT's wire calls):
 *   GET  /api/contacts?limit=200                      → [ ...contacts ] | { contacts }
 *   GET  /api/travel/markup-rules?subBrand&scope=flight&active=true → { rules }
 *   POST /api/v1/flight-plugin/agent-quotes           → 201 { itineraryId,
 *        items:[{itineraryItemId,totalWithMarkup,currency}], totalWithMarkup,
 *        currency, pdfUrl }
 *   POST /api/travel/itineraries/:id/share            → { shareToken, shareUrl, whatsapp, email, channel }
 *
 * Mocking discipline (per CLAUDE.md RTL standing rules):
 *   - fetchApi mocked at ../utils/api (the page's dep, NOT global fetch);
 *     getAuthToken stubbed in the same vi.mock (feeds the PDF ?_t= link).
 *   - notifyObj is a STABLE module-level reference so useNotify identity
 *     stays stable across renders (Wave 11 cfb5789 / Wave 12 f59e91d rule).
 *   - AuthContext via real Provider; default ADMIN user (userId key, not id).
 *   - MemoryRouter wraps the SUT (chrome renders <Link> elements).
 *   - Data-dependent assertions use await findBy / waitFor (tick #108 rule).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

const fetchApiMock = vi.fn();
vi.mock('../utils/api', () => ({
  fetchApi: (...args) => fetchApiMock(...args),
  getAuthToken: () => 'test-token',
}));

// Stable notify object — RTL standing rule.
const notifyError = vi.fn();
const notifySuccess = vi.fn();
const notifyInfo = vi.fn();
const notifyConfirm = vi.fn(() => Promise.resolve(true));
const notifyObj = {
  error: notifyError,
  info: notifyInfo,
  success: notifySuccess,
  confirm: notifyConfirm,
};
vi.mock('../utils/notify', () => ({
  useNotify: () => notifyObj,
}));

import { AuthContext } from '../App';
import FlightQuoteAgent from '../pages/travel/FlightQuoteAgent';

const ADMIN_USER = { userId: 7, name: 'Admin', email: 'a@x.com', role: 'ADMIN' };

const CONTACTS = [
  { id: 31, name: 'Asha Verma', phone: '+919876543210' },
  { id: 32, name: 'Bilal Khan', phone: '+918765432109' },
];

const RULES = [
  { id: 5, subBrand: 'tmc', scope: 'flight', markupPct: 10, markupFlat: null, priority: 100, isActive: true, ownerUserId: null },
];

const QUOTE_RESULT = {
  itineraryId: 12,
  items: [{ itineraryItemId: 901, totalWithMarkup: 1100, currency: 'INR' }],
  totalWithMarkup: 1100,
  currency: 'INR',
  pdfUrl: '/api/travel/itineraries/12/pdf',
};

const SHARE_RESULT = {
  shareToken: 'tok123',
  shareUrl: 'https://crm.globusdemos.com/p/itinerary/tok123',
  whatsapp: 'SENT',
  email: 'SENT',
  inApp: 'SKIPPED',
  channel: 'email+whatsapp',
};

// Recent flight quotes (history panel). The list returns full item rows;
// the page filters to destinations ending in "flights" — the Andaman row
// must be filtered OUT.
const RECENT_ITINS = {
  itineraries: [
    {
      id: 77, destination: 'DEL→JED flights', contactId: 31, status: 'draft',
      currency: 'INR', totalAmount: null, updatedAt: '2026-06-20T10:00:00.000Z',
      items: [{ id: 1, itemType: 'flight', totalPrice: 1100 }],
    },
    {
      id: 78, destination: 'Andaman Islands', contactId: 32, status: 'sent',
      currency: 'INR', totalAmount: 50000, updatedAt: '2026-06-19T10:00:00.000Z', items: [],
    },
  ],
};

// fetchApi mock routed by URL + method. Tests override only what they need.
function installFetchMock({
  contacts = CONTACTS,
  rules = { rules: RULES },
  quote = QUOTE_RESULT,
  share = SHARE_RESULT,
  itins = RECENT_ITINS,
} = {}) {
  fetchApiMock.mockImplementation((url, opts) => {
    const method = opts?.method || 'GET';
    if (url.startsWith('/api/contacts') && method === 'GET') {
      return Promise.resolve(contacts);
    }
    if (url.startsWith('/api/travel/markup-rules') && method === 'GET') {
      return Promise.resolve(rules);
    }
    if (url === '/api/v1/flight-plugin/agent-quotes' && method === 'POST') {
      if (quote instanceof Error) return Promise.reject(quote);
      return Promise.resolve(quote);
    }
    if (/^\/api\/travel\/itineraries\/\d+\/share$/.test(url) && method === 'POST') {
      return Promise.resolve(share);
    }
    if (url.startsWith('/api/travel/itineraries?') && method === 'GET') {
      return Promise.resolve(itins);
    }
    return Promise.resolve(null);
  });
}

function renderPage(user = ADMIN_USER) {
  return render(
    <MemoryRouter>
      <AuthContext.Provider value={{ user, token: 'tk', tenant: { id: 1, vertical: 'travel' }, loading: false }}>
        <FlightQuoteAgent />
      </AuthContext.Provider>
    </MemoryRouter>,
  );
}

// Fill the minimum viable option-1 fields + pick the first contact.
async function fillHappyPath() {
  fireEvent.change(screen.getByLabelText('Contact'), { target: { value: '31' } });
  fireEvent.change(screen.getByLabelText('Airline code (option 1)'), { target: { value: 'ai' } });
  fireEvent.change(screen.getByLabelText('Origin IATA (option 1)'), { target: { value: 'del' } });
  fireEvent.change(screen.getByLabelText('Destination IATA (option 1)'), { target: { value: 'jed' } });
  fireEvent.change(screen.getByLabelText('Fare per pax (option 1)'), { target: { value: '1000' } });
}

beforeEach(() => {
  fetchApiMock.mockReset();
  notifyError.mockReset();
  notifySuccess.mockReset();
  notifyInfo.mockReset();
  notifyConfirm.mockReset();
  notifyConfirm.mockResolvedValue(true);
  installFetchMock();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('<FlightQuoteAgent /> — page chrome', () => {
  it('renders heading + contact picker + sub-brand + currency + Add option + Create quote', async () => {
    renderPage();
    expect(screen.getByRole('heading', { name: /Flight quick-quote/i })).toBeInTheDocument();
    expect(screen.getByLabelText(/Search contacts by name or phone/i)).toBeInTheDocument();
    expect(screen.getByLabelText('Contact')).toBeInTheDocument();
    expect(screen.getByLabelText('Sub-brand')).toBeInTheDocument();
    expect(screen.getByLabelText('Currency')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Add option/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Create quote/i })).toBeInTheDocument();
    // Let the mount-time GETs settle.
    await waitFor(() => expect(fetchApiMock).toHaveBeenCalled());
  });
});

describe('<FlightQuoteAgent /> — mount fetches', () => {
  it('GETs the contact feed and the flight markup rules for the default sub-brand', async () => {
    renderPage();
    await waitFor(() => {
      const urls = fetchApiMock.mock.calls.map(([u]) => u);
      expect(urls).toContain('/api/contacts?limit=200');
      const rulesCall = urls.find((u) => typeof u === 'string' && u.startsWith('/api/travel/markup-rules?'));
      expect(rulesCall).toBeTruthy();
      // ADMIN default sub-brand resolves to the page's preferred "tmc".
      expect(rulesCall).toMatch(/subBrand=tmc/);
      expect(rulesCall).toMatch(/scope=flight/);
      expect(rulesCall).toMatch(/active=true/);
    });
    // Contact options hydrate the select.
    const select = screen.getByLabelText('Contact');
    await waitFor(() => {
      expect(within(select).getByText(/Asha Verma/)).toBeInTheDocument();
      expect(within(select).getByText(/Bilal Khan/)).toBeInTheDocument();
    });
  });
});

describe('<FlightQuoteAgent /> — option rows add/remove', () => {
  it('starts with 1 row; Add option grows to the 4-option cap then disables', async () => {
    renderPage();
    expect(screen.getByLabelText('Airline code (option 1)')).toBeInTheDocument();
    expect(screen.queryByLabelText('Airline code (option 2)')).toBeNull();
    const addBtn = screen.getByRole('button', { name: /Add option/i });
    fireEvent.click(addBtn);
    fireEvent.click(addBtn);
    fireEvent.click(addBtn);
    expect(screen.getByLabelText('Airline code (option 4)')).toBeInTheDocument();
    expect(addBtn).toBeDisabled();
    // Clicking the disabled button must not create a 5th row.
    fireEvent.click(addBtn);
    expect(screen.queryByLabelText('Airline code (option 5)')).toBeNull();
  });

  it('Remove option drops a row; remove is disabled when only 1 row remains', async () => {
    renderPage();
    // Single row → remove disabled.
    expect(screen.getByRole('button', { name: 'Remove option 1' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: /Add option/i }));
    expect(screen.getByLabelText('Airline code (option 2)')).toBeInTheDocument();
    // Distinguish the rows: fill option 2's airline then remove option 1 —
    // the survivor (re-labelled option 1) keeps option 2's value.
    fireEvent.change(screen.getByLabelText('Airline code (option 2)'), { target: { value: '6E' } });
    fireEvent.click(screen.getByRole('button', { name: 'Remove option 1' }));
    expect(screen.queryByLabelText('Airline code (option 2)')).toBeNull();
    expect(screen.getByLabelText('Airline code (option 1)')).toHaveValue('6E');
  });
});

describe('<FlightQuoteAgent /> — contact search filter', () => {
  it('narrows the contact select by name substring', async () => {
    renderPage();
    const select = screen.getByLabelText('Contact');
    await waitFor(() => expect(within(select).getByText(/Asha Verma/)).toBeInTheDocument());
    fireEvent.change(screen.getByLabelText(/Search contacts by name or phone/i), {
      target: { value: 'bilal' },
    });
    await waitFor(() => {
      expect(within(select).queryByText(/Asha Verma/)).toBeNull();
      expect(within(select).getByText(/Bilal Khan/)).toBeInTheDocument();
    });
  });
});

describe('<FlightQuoteAgent /> — validation', () => {
  it('submit with no contact → notify.error + no POST', async () => {
    renderPage();
    await waitFor(() => expect(fetchApiMock).toHaveBeenCalled());
    fetchApiMock.mockClear();
    fireEvent.click(screen.getByRole('button', { name: /Create quote/i }));
    await waitFor(() => {
      expect(notifyError).toHaveBeenCalledWith('Contact is required');
    });
    const posts = fetchApiMock.mock.calls.filter(([, o]) => o?.method === 'POST');
    expect(posts.length).toBe(0);
  });

  it('submit with contact but no airline → notify.error(/airline is required/) + no POST', async () => {
    renderPage();
    const select = screen.getByLabelText('Contact');
    await waitFor(() => expect(within(select).getByText(/Asha Verma/)).toBeInTheDocument());
    fireEvent.change(select, { target: { value: '31' } });
    fetchApiMock.mockClear();
    fireEvent.click(screen.getByRole('button', { name: /Create quote/i }));
    await waitFor(() => {
      expect(notifyError).toHaveBeenCalledWith(expect.stringMatching(/airline is required/i));
    });
    const posts = fetchApiMock.mock.calls.filter(([, o]) => o?.method === 'POST');
    expect(posts.length).toBe(0);
  });
});

describe('<FlightQuoteAgent /> — submit happy path', () => {
  it('POSTs the agent-quotes endpoint with normalised payload and shows the result panel', async () => {
    renderPage();
    const select = screen.getByLabelText('Contact');
    await waitFor(() => expect(within(select).getByText(/Asha Verma/)).toBeInTheDocument());
    await fillHappyPath();
    fireEvent.click(screen.getByRole('button', { name: /Create quote/i }));

    await waitFor(() => {
      const post = fetchApiMock.mock.calls.find(
        ([u, o]) => u === '/api/v1/flight-plugin/agent-quotes' && o?.method === 'POST',
      );
      expect(post).toBeTruthy();
      const body = JSON.parse(post[1].body);
      expect(body.contactId).toBe(31);
      expect(body.subBrand).toBe('tmc');
      expect(body.currency).toBe('INR');
      expect(Array.isArray(body.options)).toBe(true);
      expect(body.options.length).toBe(1);
      // Airline + IATA codes normalised to upper-case on submit.
      expect(body.options[0].airline).toBe('AI');
      expect(body.options[0].route).toEqual({ from: 'DEL', to: 'JED' });
      // Fare coerced to a number, sent as pricePerPax (plugin payload name).
      expect(body.options[0].pricePerPax).toBe(1000);
    });

    // Result panel: success copy + grand total + PDF link with ?_t= token.
    expect(await screen.findByText(/Quote created/i)).toBeInTheDocument();
    expect(screen.getByText(/Total with markup/i)).toBeInTheDocument();
    const pdfLink = screen.getByRole('link', { name: /Download PDF/i });
    expect(pdfLink).toHaveAttribute(
      'href',
      '/api/travel/itineraries/12/pdf?_t=test-token',
    );
    expect(notifySuccess).toHaveBeenCalledWith('Flight quote created');
  });
});

describe('<FlightQuoteAgent /> — send to customer', () => {
  it('Send to customer POSTs /itineraries/:id/share with channel:"auto" and surfaces the share URL + copy button', async () => {
    renderPage();
    const select = screen.getByLabelText('Contact');
    await waitFor(() => expect(within(select).getByText(/Asha Verma/)).toBeInTheDocument());
    await fillHappyPath();
    fireEvent.click(screen.getByRole('button', { name: /Create quote/i }));
    await screen.findByText(/Quote created/i);

    fetchApiMock.mockClear();
    installFetchMock();
    fireEvent.click(screen.getByRole('button', { name: /Send to customer/i }));
    await waitFor(() => {
      const post = fetchApiMock.mock.calls.find(
        ([u, o]) => u === '/api/travel/itineraries/12/share' && o?.method === 'POST',
      );
      expect(post).toBeTruthy();
      // Email-first: the page asks the backend to auto-pick the channel.
      expect(JSON.parse(post[1].body)).toEqual({ channel: 'auto' });
    });
    expect(
      await screen.findByText('https://crm.globusdemos.com/p/itinerary/tok123'),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Copy share link/i })).toBeInTheDocument();
    // channel:"email+whatsapp" → both-channels confirmation toast.
    expect(notifySuccess).toHaveBeenCalledWith('Quote sent to the customer via email + WhatsApp');
  });
});

describe('<FlightQuoteAgent /> — recent flight quotes history', () => {
  it('lists flight-quote itineraries, filters out non-flight ones, and links to the detail page', async () => {
    renderPage();
    // The flight-quote draft shows; the non-flight itinerary is filtered out.
    expect(await screen.findByText('DEL→JED flights')).toBeInTheDocument();
    expect(screen.queryByText('Andaman Islands')).not.toBeInTheDocument();
    // Row links to the itinerary detail page.
    const link = screen.getByText('DEL→JED flights').closest('a');
    expect(link).toHaveAttribute('href', '/travel/itineraries/77');
    // Total falls back to summed item totalPrice when totalAmount is null.
    expect(screen.getByText(/INR\s*1,100/)).toBeInTheDocument();
  });

  it('re-sends a recent quote from its row via the share endpoint (channel auto)', async () => {
    renderPage();
    await screen.findByText('DEL→JED flights');
    fireEvent.click(screen.getByRole('button', { name: /Send quote DEL→JED flights/i }));
    await waitFor(() => {
      const post = fetchApiMock.mock.calls.find(
        ([u, o]) => u === '/api/travel/itineraries/77/share' && o?.method === 'POST',
      );
      expect(post).toBeTruthy();
      expect(JSON.parse(post[1].body)).toEqual({ channel: 'auto' });
    });
    // SHARE_RESULT channel = email+whatsapp → delivered toast.
    expect(notifySuccess).toHaveBeenCalledWith('Sent to the customer via email + WhatsApp');
  });
});
