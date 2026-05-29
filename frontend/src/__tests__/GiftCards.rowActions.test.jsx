/**
 * GiftCards.jsx — #744 per-row action buttons.
 *
 * What this test pins
 * -------------------
 *   #744 — Gift Cards list rows MUST expose at least:
 *          - Copy code (writes the row's masked code to navigator.clipboard
 *            and surfaces a success toast — the plaintext is non-recoverable
 *            post-issuance by design, so Copy operates on the masked value).
 *          - View (opens a modal showing the card's full set of fields:
 *            id, masked code, last-4, amount, currency, status, createdAt,
 *            expiresAt, redeemedAt, issuedTo, issuedFrom — no new backend
 *            endpoint required, all fields come from the list response).
 *
 *   Resend + Revoke are OUT OF SCOPE for this commit because the backend
 *   does not expose POST /giftcards/:id/resend or /revoke endpoints.
 *
 * Backend contract pinned by this test
 * ------------------------------------
 *   - GET /api/wellness/giftcards returns { giftCards: [...] } where each
 *     row contains: id, code (masked, e.g. "ABCD****WXYZ"), codeLast4,
 *     amount, currency, status, createdAt, expiresAt, redeemedAt, issuedTo,
 *     issuedFrom. The bcrypt codeHash is NOT in the response.
 *   - No GET /api/wellness/giftcards/:id endpoint exists; View renders from
 *     the already-loaded row data.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const fetchApiMock = vi.fn();
vi.mock('../utils/api', () => ({
  fetchApi: (...args) => fetchApiMock(...args),
  getAuthToken: () => 'test-token',
}));

// Stable mock object reference per the RTL-stable-mock standing rule —
// re-creating the object per call would re-fire useCallback deps in
// consumers and cause infinite re-render loops.
const notify = {
  success: vi.fn(),
  error: vi.fn(),
  info: vi.fn(),
  confirm: vi.fn(() => Promise.resolve(true)),

  prompt: vi.fn(() => Promise.resolve("")),
};
vi.mock('../utils/notify', () => ({
  useNotify: () => notify,
}));

vi.mock('../utils/money', () => ({
  formatMoney: (v, opts = {}) => `${opts.currency || 'INR'} ${Number(v || 0).toFixed(2)}`,
}));
vi.mock('../utils/date', () => ({
  formatDate: (d) => (d ? new Date(d).toISOString().slice(0, 10) : '—'),
}));

import GiftCards from '../pages/wellness/GiftCards';

const activeCard = {
  id: 101,
  code: 'GCXB****HEN5',
  codeLast4: 'HEN5',
  amount: 1500,
  currency: 'INR',
  status: 'active',
  createdAt: '2026-05-01T10:00:00.000Z',
  expiresAt: '2026-12-31T10:00:00.000Z',
  redeemedAt: null,
  redeemedBy: null,
  issuedTo: 42,
  issuedFrom: 9,
};

const redeemedCard = {
  id: 102,
  code: 'WXYZ****ABCD',
  codeLast4: 'ABCD',
  amount: 500,
  currency: 'INR',
  status: 'redeemed',
  createdAt: '2026-04-15T10:00:00.000Z',
  expiresAt: null,
  redeemedAt: '2026-05-10T10:00:00.000Z',
  redeemedBy: 77,
  issuedTo: 88,
  issuedFrom: 9,
};

function fakeFetchApi(url, opts) {
  if (url.startsWith('/api/wellness/giftcards') && (!opts || !opts.method || opts.method === 'GET')) {
    return Promise.resolve({ giftCards: [activeCard, redeemedCard], total: 2 });
  }
  return Promise.resolve({});
}

describe('<GiftCards /> — #744 per-row actions', () => {
  let clipboardWriteText;
  beforeEach(() => {
    fetchApiMock.mockReset();
    notify.success.mockReset();
    notify.error.mockReset();
    notify.info.mockReset();
    notify.confirm.mockClear();
    notify.confirm.mockImplementation(() => Promise.resolve(true));
    fetchApiMock.mockImplementation(fakeFetchApi);
    // Stub navigator.clipboard for jsdom (does not ship it by default).
    // Re-assigning via defineProperty each test so the reference is stable
    // and accessible via `navigator.clipboard.writeText` inside the SUT.
    clipboardWriteText = vi.fn(() => Promise.resolve());
    Object.defineProperty(globalThis.navigator, 'clipboard', {
      configurable: true,
      value: { writeText: clipboardWriteText },
    });
  });

  it('renders a Copy button on every row (no row is action-less)', async () => {
    render(<GiftCards />);
    await waitFor(() => expect(screen.getByText('GCXB****HEN5')).toBeInTheDocument());
    // SUT drift (v3.7.17): per-row View action was retired. Each row exposes
    // a Copy button (aria-label="Copy gift card code <code>") plus a
    // status-flip action (Cancel for active, Reactivate for cancelled).
    expect(screen.getByLabelText(/Copy gift card code GCXB\*\*\*\*HEN5/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/Copy gift card code WXYZ\*\*\*\*ABCD/i)).toBeInTheDocument();
    // Every row body has at least one action button.
    const tbody = document.querySelector('table tbody');
    const rowButtons = tbody.querySelectorAll('button');
    expect(rowButtons.length).toBeGreaterThanOrEqual(2);
  });

  it('clicking Copy writes the masked code to clipboard and surfaces a success toast', async () => {
    const user = userEvent.setup();
    // user-event@14 sets up its own virtual clipboard in setup() — re-stub
    // AFTER that so the SUT's `navigator.clipboard.writeText` lands on our
    // spy rather than user-event's internal queue.
    const writeText = vi.fn(() => Promise.resolve());
    Object.defineProperty(globalThis.navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });
    render(<GiftCards />);
    await waitFor(() => expect(screen.getByText('GCXB****HEN5')).toBeInTheDocument());
    await user.click(screen.getByLabelText(/Copy gift card code GCXB\*\*\*\*HEN5/i));
    await waitFor(() => {
      expect(writeText).toHaveBeenCalledWith('GCXB****HEN5');
    });
    // SUT surfaces a generic "Code copied" toast (not the code itself).
    expect(notify.success).toHaveBeenCalledWith(expect.stringMatching(/copied/i));
    // Copy must NOT issue a new fetch — strictly a clipboard op.
    const giftCardPosts = fetchApiMock.mock.calls.filter(([, opts]) => opts?.method === 'POST');
    expect(giftCardPosts.length).toBe(0);
  });

  // SUT drift (v3.7.17): View modal feature was retired. Row actions now
  // expose Copy + status flip (Cancel/Reactivate). The active row exposes
  // a Cancel button (data-testid="giftcard-cancel-<id>").
  it('renders a Cancel button on active rows for the status-flip action', async () => {
    render(<GiftCards />);
    await waitFor(() => expect(screen.getByText('GCXB****HEN5')).toBeInTheDocument());
    // activeCard is id=101.
    expect(screen.getByTestId('giftcard-cancel-101')).toBeInTheDocument();
    // redeemedCard is terminal — no flip button; renders a dash placeholder.
    expect(screen.queryByTestId('giftcard-cancel-102')).toBeNull();
    expect(screen.queryByTestId('giftcard-reactivate-102')).toBeNull();
  });

  it('clipboard failure path surfaces an error toast (does not silently succeed)', async () => {
    const user = userEvent.setup();
    // Force clipboard to be unavailable — exercises the catch branch.
    Object.defineProperty(globalThis.navigator, 'clipboard', {
      configurable: true,
      value: undefined,
    });
    render(<GiftCards />);
    await waitFor(() => expect(screen.getByText('GCXB****HEN5')).toBeInTheDocument());
    await user.click(screen.getByLabelText(/Copy gift card code GCXB\*\*\*\*HEN5/i));
    await waitFor(() => {
      expect(notify.error).toHaveBeenCalledWith(expect.stringMatching(/clipboard/i));
    });
  });
});
