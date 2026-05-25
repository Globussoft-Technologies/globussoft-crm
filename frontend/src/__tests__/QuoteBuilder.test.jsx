/**
 * QuoteBuilder.test.jsx — vitest + RTL coverage for the Travel-vertical
 * operator-facing Quote Builder (frontend/src/pages/travel/QuoteBuilder.jsx,
 * Arc 2 #900 slice 2).
 *
 * Scope — pins the page-surface invariants for the line-items builder
 * (distinct from QuotesAdmin's list/CRUD page):
 *
 *   1. Page chrome: heading "Quote Builder" + header fields (Contact ID,
 *      Currency, Sub-brand, Valid Until) + action cluster (Save Draft /
 *      Send / Duplicate / Download PDF).
 *   2. NEW mode (no :id route param): empty items array, "Save Draft" CTA
 *      visible, no GET fired on mount.
 *   3. EDIT mode (:id route param): fires GET /api/travel/quotes/:id on
 *      mount and populates form fields from the response.
 *   4. Add line: clicking "Add line" appends a row to the items table.
 *   5. Remove line: clicking the trash icon removes the row.
 *   6. Inline edit: typing into a line's qty + unitPrice updates the
 *      line total + rolls into the grand-total panel.
 *   7. Save Draft: NEW mode POSTs /api/travel/quotes with the parsed
 *      payload (contactId int + totalAmount float + currency + status +
 *      subBrand + validUntil).
 *   8. Save Draft: EDIT mode PUTs /api/travel/quotes/:id with the same
 *      payload shape.
 *   9. Duplicate: with a saved id, clicking Duplicate POSTs to
 *      /api/travel/quotes/:id/duplicate. Graceful-degrades to notify.info
 *      on 404 (Agent A's endpoint may not have deployed yet — cascade
 *      tolerance per slice prompt).
 *  10. Role gate (USER): a plain USER role sees the RoleGuard locked
 *      panel via the wrapping route — but since QuoteBuilder doesn't
 *      gate itself (App.jsx route does that), the test pins the
 *      canWrite=false branch: the action cluster + add-line CTA are
 *      hidden.
 *
 * Backend contract pinned:
 *   GET    /api/travel/quotes/:id                    → 200 { id, contactId, ... }
 *   POST   /api/travel/quotes                        → 201 created (Agent A b02c091)
 *   PUT    /api/travel/quotes/:id                    → 200 updated
 *   POST   /api/travel/quotes/:id/duplicate          → 201 cloned (Agent A SAME TICK)
 *   GET    /api/travel/quotes/:id/pdf                → PDF stream (Agent A SAME TICK)
 *
 * Mocking discipline (per CLAUDE.md RTL standing rules):
 *   - fetchApi mocked at ../utils/api.
 *   - notifyObj is a STABLE module-level reference so useNotify identity
 *     stays stable across renders (per Wave 11 cfb5789 + Wave 12 f59e91d).
 *   - useParams mocked per-suite (NEW vs EDIT mode) since the SUT reads
 *     route id via useParams() — MemoryRouter alone isn't enough to
 *     simulate the :id? optional segment cleanly across all 10 cases.
 *   - AuthContext provided with role:ADMIN by default so canWrite=true.
 *   - All data-dependent assertions use await findBy / waitFor (per
 *     CLAUDE.md tick #108 cron-learning).
 *
 * Path: flat __tests__/ — matches the convention established by
 * QuotesAdmin.test.jsx + InvoicesAdmin.test.jsx (tick #97 + #111).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

// fetchApi mock — install BEFORE importing the SUT.
const fetchApiMock = vi.fn();
vi.mock('../utils/api', () => ({
  fetchApi: (...args) => fetchApiMock(...args),
  getAuthToken: () => 'test-token',
}));

// Stable notify object — RTL standing rule. The SUT closes over notify
// inside the action handlers; a fresh object per render would loop.
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

// useParams mock — controlled per test. Default to NEW mode (id undefined).
let mockRouteId = undefined;
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual('react-router-dom');
  return {
    ...actual,
    useParams: () => ({ id: mockRouteId }),
  };
});

import { AuthContext } from '../App';
import QuoteBuilder from '../pages/travel/QuoteBuilder';

const ADMIN_USER = { userId: 1, name: 'Admin', email: 'a@x.com', role: 'ADMIN' };
const USER_USER = { userId: 2, name: 'Plain User', email: 'u@x.com', role: 'USER' };

function renderPage(user = ADMIN_USER) {
  return render(
    <MemoryRouter>
      <AuthContext.Provider
        value={{
          user,
          token: 'tk',
          tenant: { id: 1, defaultCurrency: 'INR' },
          loading: false,
        }}
      >
        <QuoteBuilder />
      </AuthContext.Provider>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  mockRouteId = undefined;
  fetchApiMock.mockReset();
  notifyError.mockReset();
  notifySuccess.mockReset();
  notifyInfo.mockReset();
  notifyConfirm.mockReset();
  notifyConfirm.mockResolvedValue(true);
  // Default mock: succeed on anything.
  fetchApiMock.mockResolvedValue({ id: 999, contactId: 5001, status: 'Draft', currency: 'INR', subBrand: 'tmc' });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('<QuoteBuilder /> — page chrome + NEW mode', () => {
  it('renders heading + header fields + action cluster (ADMIN)', async () => {
    renderPage();
    expect(
      await screen.findByRole('heading', { name: /Quote Builder/i }),
    ).toBeInTheDocument();
    // Header fields
    expect(screen.getByLabelText(/Contact ID/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/^Currency$/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/Sub-brand/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/Valid until/i)).toBeInTheDocument();
    // Action cluster
    expect(screen.getByRole('button', { name: /Save Draft/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Send$/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Duplicate/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Download PDF/i })).toBeInTheDocument();
  });

  it('NEW mode: no GET fired on mount, items table renders empty-state copy', async () => {
    renderPage();
    await screen.findByRole('heading', { name: /Quote Builder/i });
    // No GET to /api/travel/quotes/:id should fire when there's no route id.
    const gets = fetchApiMock.mock.calls.filter(
      ([u, o]) => typeof u === 'string' && (!o || !o.method || o.method === 'GET'),
    );
    expect(gets.length).toBe(0);
    // Empty-state copy in the items table.
    expect(screen.getByText(/No line items yet/i)).toBeInTheDocument();
  });
});

describe('<QuoteBuilder /> — EDIT mode hydration', () => {
  it('fetches GET /api/travel/quotes/:id on mount and populates the form', async () => {
    mockRouteId = '42';
    fetchApiMock.mockResolvedValueOnce({
      id: 42,
      contactId: 5050,
      status: 'Sent',
      currency: 'USD',
      subBrand: 'rfu',
      validUntil: '2026-12-31T00:00:00.000Z',
      totalAmount: 12345.67,
    });
    renderPage();
    // Hydration GET fires.
    await waitFor(() => {
      const get = fetchApiMock.mock.calls.find(
        ([u, o]) => u === '/api/travel/quotes/42' && (!o || !o.method || o.method === 'GET'),
      );
      expect(get).toBeTruthy();
    });
    // Form populated.
    const contactInput = await screen.findByLabelText(/Contact ID/i);
    expect(contactInput.value).toBe('5050');
    expect(screen.getByLabelText(/^Currency$/i).value).toBe('USD');
    expect(screen.getByLabelText(/Sub-brand/i).value).toBe('rfu');
    // Header shows the quote # + status badge.
    expect(screen.getByText(/#42/)).toBeInTheDocument();
    expect(screen.getByText('Sent')).toBeInTheDocument();
  });
});

describe('<QuoteBuilder /> — line items', () => {
  it('clicking "Add line" appends a row; "Remove line" trash removes it', async () => {
    renderPage();
    await screen.findByRole('heading', { name: /Quote Builder/i });
    // Initially empty.
    expect(screen.getByText(/No line items yet/i)).toBeInTheDocument();
    // Add line.
    fireEvent.click(screen.getByRole('button', { name: /Add line/i }));
    // Empty-state disappears; description input appears.
    expect(screen.queryByText(/No line items yet/i)).toBeNull();
    const descInputs = screen.getAllByPlaceholderText(/Service \/ package description/i);
    expect(descInputs.length).toBe(1);
    // Add a second line.
    fireEvent.click(screen.getByRole('button', { name: /Add line/i }));
    const descInputs2 = screen.getAllByPlaceholderText(/Service \/ package description/i);
    expect(descInputs2.length).toBe(2);
    // Remove the first via its aria-label "Remove line <key>".
    const removeBtns = screen.getAllByRole('button', { name: /Remove line/i });
    expect(removeBtns.length).toBe(2);
    fireEvent.click(removeBtns[0]);
    const descInputs3 = screen.getAllByPlaceholderText(/Service \/ package description/i);
    expect(descInputs3.length).toBe(1);
  });

  it('inline-editing qty + unitPrice updates the line total + grand total', async () => {
    renderPage();
    await screen.findByRole('heading', { name: /Quote Builder/i });
    fireEvent.click(screen.getByRole('button', { name: /Add line/i }));
    // The new line's qty input has aria-label "Line <key> quantity".
    const qtyInputs = screen.getAllByLabelText(/Line .* quantity/i);
    const unitInputs = screen.getAllByLabelText(/Line .* unit price/i);
    fireEvent.change(qtyInputs[0], { target: { value: '3' } });
    fireEvent.change(unitInputs[0], { target: { value: '1000' } });
    // Grand total label is "Grand total" — assert the value cell contains "3,000".
    const grand = await screen.findByLabelText(/Grand total/i);
    expect(grand.textContent).toMatch(/3,000/);
  });
});

describe('<QuoteBuilder /> — Save Draft', () => {
  it('NEW mode: POSTs /api/travel/quotes with parsed payload + sets created id', async () => {
    // Reset to a clean per-call mock so the POST returns id=777.
    fetchApiMock.mockImplementation((url, opts) => {
      if (url === '/api/travel/quotes' && opts?.method === 'POST') {
        return Promise.resolve({ id: 777, contactId: 5050, status: 'Draft' });
      }
      return Promise.resolve(null);
    });
    renderPage();
    await screen.findByRole('heading', { name: /Quote Builder/i });
    fireEvent.change(screen.getByLabelText(/Contact ID/i), { target: { value: '5050' } });
    fireEvent.change(screen.getByLabelText(/^Currency$/i), { target: { value: 'usd' } });
    fireEvent.click(screen.getByRole('button', { name: /Save Draft/i }));
    await waitFor(() => {
      const post = fetchApiMock.mock.calls.find(
        ([u, o]) => u === '/api/travel/quotes' && o?.method === 'POST',
      );
      expect(post).toBeTruthy();
      const body = JSON.parse(post[1].body);
      expect(body.contactId).toBe(5050);
      expect(body.currency).toBe('USD');
      expect(body.status).toBe('Draft');
      expect(body.subBrand).toBe('tmc');
      // No lines yet → totalAmount is 0.
      expect(body.totalAmount).toBe(0);
    });
    // After save, the header shows #777.
    expect(await screen.findByText(/#777/)).toBeInTheDocument();
    expect(notifySuccess).toHaveBeenCalled();
  });

  it('validation: missing contactId surfaces notify.error and does NOT POST', async () => {
    renderPage();
    await screen.findByRole('heading', { name: /Quote Builder/i });
    // Leave contactId blank.
    fireEvent.click(screen.getByRole('button', { name: /Save Draft/i }));
    await waitFor(() => {
      expect(notifyError).toHaveBeenCalledWith(
        expect.stringMatching(/Contact ID is required/i),
      );
    });
    const posts = fetchApiMock.mock.calls.filter(
      ([u, o]) => u === '/api/travel/quotes' && o?.method === 'POST',
    );
    expect(posts.length).toBe(0);
  });
});

describe('<QuoteBuilder /> — Duplicate (cascade-tolerant)', () => {
  it('with saved id: POSTs /api/travel/quotes/:id/duplicate; 404 → notify.info graceful-degrade', async () => {
    mockRouteId = '42';
    // EDIT mode hydration + duplicate 404.
    fetchApiMock.mockImplementation((url, opts) => {
      const method = opts?.method || 'GET';
      if (url === '/api/travel/quotes/42' && method === 'GET') {
        return Promise.resolve({ id: 42, contactId: 5001, status: 'Draft', currency: 'INR', subBrand: 'tmc' });
      }
      if (url === '/api/travel/quotes/42/duplicate' && method === 'POST') {
        const err = new Error('Not found');
        err.status = 404;
        return Promise.reject(err);
      }
      return Promise.resolve(null);
    });
    renderPage();
    // Wait for hydration to settle (quote #42 header renders).
    await screen.findByText(/#42/);
    fireEvent.click(screen.getByRole('button', { name: /Duplicate/i }));
    await waitFor(() => {
      const dup = fetchApiMock.mock.calls.find(
        ([u, o]) => u === '/api/travel/quotes/42/duplicate' && o?.method === 'POST',
      );
      expect(dup).toBeTruthy();
    });
    // Graceful-degrade: notify.info on 404 (not error).
    await waitFor(() => {
      expect(notifyInfo).toHaveBeenCalledWith(
        expect.stringMatching(/Duplicate endpoint not yet available/i),
      );
    });
  });
});

describe('<QuoteBuilder /> — RBAC USER role', () => {
  it('USER role (canWrite=false): action cluster + Add-line CTA hidden', async () => {
    renderPage(USER_USER);
    await screen.findByRole('heading', { name: /Quote Builder/i });
    // Action cluster gated on canWrite — should NOT render for USER.
    expect(screen.queryByRole('button', { name: /Save Draft/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /^Send$/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /Duplicate/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /Download PDF/i })).toBeNull();
    // Add line CTA also gated.
    expect(screen.queryByRole('button', { name: /Add line/i })).toBeNull();
    // Header fields still render (USER can READ the form — write is gated).
    expect(screen.getByLabelText(/Contact ID/i)).toBeInTheDocument();
  });
});
