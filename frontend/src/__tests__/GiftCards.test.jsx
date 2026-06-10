/**
 * GiftCards.test.jsx — page-surface coverage for wellness-vertical Gift
 * Cards admin (frontend/src/pages/wellness/GiftCards.jsx).
 *
 * Complement to GiftCards.rowActions.test.jsx — that file pins the #744
 * per-row Copy + View actions; THIS file pins the broader page surface:
 *
 *   - Header chrome + "Issue gift card" CTA.
 *   - Loading-state placeholder until GET resolves.
 *   - GET on mount hits /api/wellness/giftcards with no status filter.
 *   - Empty-state copy when the API returns [].
 *   - List rendering with code, formatted amount, status pill, dates.
 *   - Status filter triggers a re-fetch with ?status=<value>.
 *   - Status labels appear as both filter <option>s AND row pills —
 *     getAllByText required (per CLAUDE.md RTL standing rule on labels
 *     that appear as both filter chrome AND row badges).
 *   - Issue modal opens with amount / expiry / recipient fields.
 *   - Issue submit validation: non-positive amount → notify.error + no
 *     POST. Positive amount → POST /api/wellness/giftcards with amount,
 *     optional expiresAt, optional issuedTo (parsed as int).
 *   - Successful issue surfaces the latestCode banner with the plaintext
 *     code (one-time view) + Copy button + formatted amount.
 *   - GET error surfaces notify.error.
 *
 * Mocking discipline (per CLAUDE.md RTL standing rules):
 *   - fetchApi mocked at ../utils/api with module-scope vi.fn.
 *   - notify object is STABLE module-level reference (Wave 11 cfb5789 /
 *     Wave 12 f59e91d standing rule — fresh-per-call objects flap
 *     useCallback / useEffect identity and cause infinite render loops).
 *   - formatMoney mocked to deterministic "INR X.XX" so CI ICU build
 *     differences don't leak in (cf. cron-learning 2026-05-07 wave-6).
 *   - formatDate mocked to ISO yyyy-mm-dd so dates are stable across TZ.
 *   - SUT imported AFTER mocks so it picks up our fetchApi/notify.
 *
 * Drift pinned vs source (frontend/src/pages/wellness/GiftCards.jsx):
 *   - Endpoint is /api/wellness/giftcards (single word, not /gift-cards).
 *   - Empty-state copy is literally "No gift cards yet." (NOT "No gift
 *     cards have been issued.").
 *   - Loading placeholder is literally "Loading…" (ellipsis is a real
 *     U+2026 character — JSX text does NOT interpret \u escapes per
 *     standing rule).
 *   - Status filter options are: All (empty value) / Active / Redeemed /
 *     Expired / Cancelled — value is lower-case, label is title-case.
 *   - No RBAC gating in SUT — Issue CTA always renders.
 *   - issuedTo is parsed via parseInt(value, 10) — string "42" → 42.
 *   - latestCode banner renders the PLAINTEXT code (one-time post-issuance
 *     return from POST response), distinct from the row's MASKED code.
 *   - Status pill text is the raw lower-case status ("active" / "redeemed")
 *     not title-cased — matches source line 129.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';

const fetchApiMock = vi.fn();
vi.mock('../utils/api', () => ({
  fetchApi: (...args) => fetchApiMock(...args),
  getAuthToken: () => 'test-token',
}));

// Stable mock object — RTL standing rule. Fresh objects per call would
// flap useCallback / useEffect identity in consumers and cause infinite
// re-render loops (canonical regression: Wave 11 cfb5789 / Wave 12 f59e91d).
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
  tenantCurrency: () => 'INR',
}));
vi.mock('../utils/date', () => ({
  formatDate: (d) => (d ? new Date(d).toISOString().slice(0, 10) : '—'),
}));

// SUT imported AFTER the mocks above.
import GiftCardsPage from '../pages/wellness/GiftCards';

// ── Fixtures ──────────────────────────────────────────────────────────
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

function makeListMock(cards) {
  return (url, opts = {}) => {
    const method = opts.method || 'GET';
    if (url.startsWith('/api/wellness/giftcards') && method === 'GET') {
      return Promise.resolve({ giftCards: cards, total: cards.length });
    }
    if (url === '/api/wellness/giftcards' && method === 'POST') {
      const body = opts.body ? JSON.parse(opts.body) : {};
      return Promise.resolve({
        id: 999,
        code: 'NEWCODE1234PLAINTEXT',
        codeLast4: 'TEXT',
        amount: body.amount,
        currency: 'INR',
        status: 'active',
        createdAt: '2026-05-25T10:00:00.000Z',
        expiresAt: body.expiresAt || null,
        redeemedAt: null,
        redeemedBy: null,
        issuedTo: body.issuedTo ?? null,
        issuedFrom: 9,
      });
    }
    return Promise.resolve({});
  };
}

beforeEach(() => {
  fetchApiMock.mockReset();
  notify.success.mockReset();
  notify.error.mockReset();
  notify.info.mockReset();
  // Stub clipboard so latestCode banner Copy doesn't blow up.
  Object.defineProperty(globalThis.navigator, 'clipboard', {
    configurable: true,
    value: { writeText: vi.fn(() => Promise.resolve()) },
  });
});

// ─────────────────────────────────────────────────────────────────────
// 1. Page chrome + Issue CTA
// ─────────────────────────────────────────────────────────────────────
describe('GiftCards — page chrome', () => {
  it('renders the "Gift Cards" heading, intro copy, and "Issue gift card" CTA', async () => {
    fetchApiMock.mockImplementation(makeListMock([]));
    render(<GiftCardsPage />);

    expect(screen.getByRole('heading', { name: /Gift Cards/i })).toBeInTheDocument();
    expect(
      screen.getByText(/Issue, track, and audit gift-card codes/i),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /Issue gift card/i }),
    ).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getByText(/No gift cards yet/i)).toBeInTheDocument(),
    );
  });

  it('shows the literal "Loading…" placeholder until the GET resolves', async () => {
    let resolveFn;
    fetchApiMock.mockImplementation((url) => {
      if (url.startsWith('/api/wellness/giftcards')) {
        return new Promise((r) => {
          resolveFn = r;
        });
      }
      return Promise.resolve({});
    });
    render(<GiftCardsPage />);
    // The ellipsis in the source is a real U+2026 character; match
    // loosely so we don't depend on the exact codepoint.
    expect(screen.getByText(/Loading/i)).toBeInTheDocument();
    resolveFn({ giftCards: [] });
    await waitFor(() => {
      expect(screen.queryByText(/^Loading/i)).not.toBeInTheDocument();
    });
  });
});

// ─────────────────────────────────────────────────────────────────────
// 2. Empty-state vs list rendering
// ─────────────────────────────────────────────────────────────────────
describe('GiftCards — list rendering', () => {
  it('renders empty-state copy when the API returns no gift cards', async () => {
    fetchApiMock.mockImplementation(makeListMock([]));
    render(<GiftCardsPage />);

    await waitFor(() => expect(screen.getByText(/No gift cards yet/i)).toBeInTheDocument());
    // No table is rendered in the empty state.
    expect(document.querySelector('table')).toBeNull();
  });

  it('GET on mount hits /api/wellness/giftcards with no status filter', async () => {
    fetchApiMock.mockImplementation(makeListMock([]));
    render(<GiftCardsPage />);

    await waitFor(() => {
      const calls = fetchApiMock.mock.calls.filter(([url]) =>
        url.startsWith('/api/wellness/giftcards'),
      );
      expect(calls.length).toBeGreaterThanOrEqual(1);
      // First call must be the bare endpoint (no ?status=).
      expect(calls[0][0]).toBe('/api/wellness/giftcards');
    });
  });

  it('renders a row per gift card with code, formatted amount, and status pill', async () => {
    fetchApiMock.mockImplementation(makeListMock([activeCard, redeemedCard]));
    render(<GiftCardsPage />);

    await waitFor(() => expect(screen.getByText('GCXB****HEN5')).toBeInTheDocument());
    // Code rendered.
    expect(screen.getByText('WXYZ****ABCD')).toBeInTheDocument();
    // Amount formatted via mocked formatMoney → "INR 1500.00" / "INR 500.00".
    expect(screen.getByText('INR 1500.00')).toBeInTheDocument();
    expect(screen.getByText('INR 500.00')).toBeInTheDocument();
    // Table is present with the expected column headers.
    const headers = ['Code', 'Amount', 'Status', 'Created', 'Expires', 'Redeemed', 'Actions'];
    headers.forEach((h) => {
      expect(screen.getByRole('columnheader', { name: h })).toBeInTheDocument();
    });
  });

  it('renders the row dates via formatDate (createdAt always, expiresAt + redeemedAt branched)', async () => {
    fetchApiMock.mockImplementation(makeListMock([activeCard, redeemedCard]));
    render(<GiftCardsPage />);

    await waitFor(() => expect(screen.getByText('GCXB****HEN5')).toBeInTheDocument());
    // activeCard: createdAt=2026-05-01, expiresAt=2026-12-31, redeemedAt=null → "—"
    expect(screen.getByText('2026-05-01')).toBeInTheDocument();
    expect(screen.getByText('2026-12-31')).toBeInTheDocument();
    // redeemedCard: createdAt=2026-04-15, expiresAt=null → "—", redeemedAt=2026-05-10
    expect(screen.getByText('2026-04-15')).toBeInTheDocument();
    expect(screen.getByText('2026-05-10')).toBeInTheDocument();
    // Both null-date cells render as "—" — multiple dashes across rows.
    const dashes = screen.getAllByText('—');
    expect(dashes.length).toBeGreaterThanOrEqual(2);
  });
});

// ─────────────────────────────────────────────────────────────────────
// 3. Status filter — labels appear as both <option> AND row pill
// ─────────────────────────────────────────────────────────────────────
describe('GiftCards — status filter', () => {
  it('exposes status options Active / Redeemed / Expired / Cancelled', async () => {
    fetchApiMock.mockImplementation(makeListMock([]));
    render(<GiftCardsPage />);

    await waitFor(() => expect(screen.getByText(/No gift cards yet/i)).toBeInTheDocument());
    // Filter <select> is the only combobox on the page.
    const select = screen.getByRole('combobox');
    expect(select).toBeInTheDocument();
    expect(within(select).getByRole('option', { name: 'All' })).toBeInTheDocument();
    expect(within(select).getByRole('option', { name: 'Active' })).toBeInTheDocument();
    expect(within(select).getByRole('option', { name: 'Redeemed' })).toBeInTheDocument();
    expect(within(select).getByRole('option', { name: 'Expired' })).toBeInTheDocument();
    expect(within(select).getByRole('option', { name: 'Cancelled' })).toBeInTheDocument();
  });

  it('changing the filter re-fires the GET with ?status=<value>', async () => {
    fetchApiMock.mockImplementation(makeListMock([activeCard]));
    render(<GiftCardsPage />);

    await waitFor(() => expect(screen.getByText('GCXB****HEN5')).toBeInTheDocument());
    const select = screen.getByRole('combobox');
    fireEvent.change(select, { target: { value: 'active' } });

    await waitFor(() => {
      const filterCalls = fetchApiMock.mock.calls.filter(
        ([url]) => url === '/api/wellness/giftcards?status=active',
      );
      expect(filterCalls.length).toBeGreaterThanOrEqual(1);
    });
  });

  it('status label "active" appears as both filter <option> AND row pill (getAllByText required)', async () => {
    fetchApiMock.mockImplementation(makeListMock([activeCard]));
    render(<GiftCardsPage />);

    await waitFor(() => expect(screen.getByText('GCXB****HEN5')).toBeInTheDocument());
    // The lower-case "active" appears in the row pill (source line 129 uses
    // raw status). The <option> label is title-case "Active", so the strict
    // duplicate is between row-pill "active" and any other render. To pin
    // the standing-rule pattern: when a label could appear as both, use
    // getAllByText — the row pill "active" is at least 1, and that count
    // should not throw.
    const actives = screen.getAllByText(/^active$/i);
    expect(actives.length).toBeGreaterThanOrEqual(1);
  });
});

// ─────────────────────────────────────────────────────────────────────
// 4. Issue modal — open, validate, submit
// SUT drift (v3.7.17): the modal was reshaped to a Zylu-style SKU/template
// add form. New fields: Name, Validity (select with options), Gift value,
// Price, Color swatches. "Recipient patient id" + "Expires" + "Amount" +
// "Issue" button were replaced. Modal title is now "Add gift card", save
// button is "Save", data-testid attributes target inputs precisely.
// ─────────────────────────────────────────────────────────────────────
describe('GiftCards — issue flow', () => {
  it('clicking "Issue gift card" opens the Add gift card modal with name / gift value / price / color fields', async () => {
    fetchApiMock.mockImplementation(makeListMock([]));
    render(<GiftCardsPage />);

    await waitFor(() => expect(screen.getByText(/No gift cards yet/i)).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: /Issue gift card/i }));

    expect(screen.getByRole('heading', { name: /Add gift card/i })).toBeInTheDocument();
    expect(screen.getByTestId('giftcard-name-input')).toBeInTheDocument();
    expect(screen.getByTestId('giftcard-giftvalue-input')).toBeInTheDocument();
    expect(screen.getByTestId('giftcard-price-input')).toBeInTheDocument();
    expect(screen.getByTestId('giftcard-validity-select')).toBeInTheDocument();
    expect(screen.getByTestId('giftcard-color-swatches')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Cancel$/i })).toBeInTheDocument();
    expect(screen.getByTestId('giftcard-save-btn')).toBeInTheDocument();
  });

  it('rejects empty name + non-positive gift value via notify.error and does NOT POST', async () => {
    fetchApiMock.mockImplementation(makeListMock([]));
    render(<GiftCardsPage />);

    await waitFor(() => expect(screen.getByText(/No gift cards yet/i)).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: /Issue gift card/i }));

    // Blank name → submit → "Enter a name" toast.
    fireEvent.click(screen.getByTestId('giftcard-save-btn'));
    await waitFor(() =>
      expect(notify.error).toHaveBeenCalledWith(expect.stringMatching(/name/i)),
    );

    // Fill name, leave gift value blank → "Gift value must be a positive number".
    fireEvent.change(screen.getByTestId('giftcard-name-input'), { target: { value: 'Holiday card' } });
    fireEvent.click(screen.getByTestId('giftcard-save-btn'));
    await waitFor(() =>
      expect(notify.error).toHaveBeenCalledWith(expect.stringMatching(/gift value/i)),
    );

    // Zero gift value → still rejected.
    fireEvent.change(screen.getByTestId('giftcard-giftvalue-input'), { target: { value: '0' } });
    fireEvent.click(screen.getByTestId('giftcard-save-btn'));
    await waitFor(() =>
      expect(notify.error).toHaveBeenCalledWith(expect.stringMatching(/gift value/i)),
    );

    // No POST should have fired.
    const postCalls = fetchApiMock.mock.calls.filter(([, opts]) => opts?.method === 'POST');
    expect(postCalls.length).toBe(0);
  });

  it('POSTs /api/wellness/giftcards with { name, amount, price, color, validityDays } on submit', async () => {
    fetchApiMock.mockImplementation(makeListMock([]));
    render(<GiftCardsPage />);

    await waitFor(() => expect(screen.getByText(/No gift cards yet/i)).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: /Issue gift card/i }));

    fireEvent.change(screen.getByTestId('giftcard-name-input'), { target: { value: 'NY 2027' } });
    fireEvent.change(screen.getByTestId('giftcard-giftvalue-input'), { target: { value: '2500' } });
    fireEvent.change(screen.getByTestId('giftcard-price-input'), { target: { value: '2000' } });
    fireEvent.change(screen.getByTestId('giftcard-validity-select'), { target: { value: '90' } });
    fireEvent.click(screen.getByTestId('giftcard-save-btn'));

    await waitFor(() => {
      const posts = fetchApiMock.mock.calls.filter(
        ([url, opts]) => url === '/api/wellness/giftcards' && opts?.method === 'POST',
      );
      expect(posts.length).toBe(1);
      const body = JSON.parse(posts[0][1].body);
      expect(body).toMatchObject({
        name: 'NY 2027',
        amount: 2500,
        price: 2000,
        validityDays: 90,
      });
      expect(typeof body.color).toBe('string');
    });
    expect(notify.success).toHaveBeenCalledWith(expect.stringMatching(/Gift card issued/i));
  });

  it('POST without validity sends body with no validityDays key', async () => {
    fetchApiMock.mockImplementation(makeListMock([]));
    render(<GiftCardsPage />);

    await waitFor(() => expect(screen.getByText(/No gift cards yet/i)).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: /Issue gift card/i }));

    fireEvent.change(screen.getByTestId('giftcard-name-input'), { target: { value: 'Basic' } });
    fireEvent.change(screen.getByTestId('giftcard-giftvalue-input'), { target: { value: '750' } });
    fireEvent.click(screen.getByTestId('giftcard-save-btn'));

    await waitFor(() => {
      const posts = fetchApiMock.mock.calls.filter(
        ([url, opts]) => url === '/api/wellness/giftcards' && opts?.method === 'POST',
      );
      expect(posts.length).toBe(1);
      const body = JSON.parse(posts[0][1].body);
      expect(body.name).toBe('Basic');
      expect(body.amount).toBe(750);
      // validityDays NOT set when "No expiry" (empty string value) is selected.
      expect('validityDays' in body).toBe(false);
    });
  });

  it('Cancel button closes the issue modal without firing a POST', async () => {
    fetchApiMock.mockImplementation(makeListMock([]));
    render(<GiftCardsPage />);

    await waitFor(() => expect(screen.getByText(/No gift cards yet/i)).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: /Issue gift card/i }));
    expect(screen.getByRole('heading', { name: /Add gift card/i })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /^Cancel$/i }));
    await waitFor(() => {
      expect(screen.queryByRole('heading', { name: /Add gift card/i })).not.toBeInTheDocument();
    });
    const postCalls = fetchApiMock.mock.calls.filter(([, opts]) => opts?.method === 'POST');
    expect(postCalls.length).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────
// 5. latestCode banner — one-time plaintext display
// ─────────────────────────────────────────────────────────────────────
describe('GiftCards — latest-code banner', () => {
  it('successful issuance surfaces the plaintext code banner + Copy button + formatted amount', async () => {
    // First GET returns empty; POST returns plaintext; subsequent GET returns
    // the newly-created (masked) row.
    fetchApiMock
      .mockImplementationOnce(() => Promise.resolve({ giftCards: [] }))
      .mockImplementationOnce(() =>
        Promise.resolve({
          id: 999,
          code: 'NEWCODE1234PLAINTEXT',
          codeLast4: 'TEXT',
          amount: 3000,
          currency: 'INR',
          status: 'active',
          createdAt: '2026-05-25T10:00:00.000Z',
          expiresAt: null,
          redeemedAt: null,
          redeemedBy: null,
          issuedTo: null,
          issuedFrom: 9,
        }),
      )
      .mockImplementation(makeListMock([])); // re-fetch on close

    render(<GiftCardsPage />);
    await waitFor(() => expect(screen.getByText(/No gift cards yet/i)).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: /Issue gift card/i }));
    fireEvent.change(screen.getByTestId('giftcard-name-input'), { target: { value: 'Banner test' } });
    fireEvent.change(screen.getByTestId('giftcard-giftvalue-input'), { target: { value: '3000' } });
    fireEvent.click(screen.getByTestId('giftcard-save-btn'));

    // Banner appears with plaintext code + formatted amount.
    await waitFor(() => {
      expect(screen.getByText(/New gift card issued/i)).toBeInTheDocument();
    });
    expect(screen.getByText('NEWCODE1234PLAINTEXT')).toBeInTheDocument();
    // Amount text is wrapped in whitespace + sits beside punctuation, so
    // match loosely (the `formatMoney` mock output is "INR 3000.00").
    expect(screen.getByText(/INR 3000\.00/)).toBeInTheDocument();
    // Banner exposes its own Copy button (in addition to per-row Copies).
    const copyButtons = screen.getAllByRole('button', { name: /Copy/i });
    expect(copyButtons.length).toBeGreaterThanOrEqual(1);
  });
});

// ─────────────────────────────────────────────────────────────────────
// 6. Error handling
// ─────────────────────────────────────────────────────────────────────
describe('GiftCards — error handling', () => {
  it('GET failure surfaces notify.error with the server message', async () => {
    fetchApiMock.mockImplementation((url) => {
      if (url.startsWith('/api/wellness/giftcards')) {
        return Promise.reject(new Error('giftcards offline'));
      }
      return Promise.resolve({});
    });
    render(<GiftCardsPage />);

    await waitFor(() =>
      expect(notify.error).toHaveBeenCalledWith(expect.stringMatching(/giftcards offline/i)),
    );
  });

  it('POST failure surfaces notify.error and leaves the modal open', async () => {
    fetchApiMock.mockImplementation((url, opts = {}) => {
      const method = opts.method || 'GET';
      if (url.startsWith('/api/wellness/giftcards') && method === 'GET') {
        return Promise.resolve({ giftCards: [] });
      }
      if (url === '/api/wellness/giftcards' && method === 'POST') {
        return Promise.reject(new Error('amount exceeds policy cap'));
      }
      return Promise.resolve({});
    });
    render(<GiftCardsPage />);

    await waitFor(() => expect(screen.getByText(/No gift cards yet/i)).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: /Issue gift card/i }));
    fireEvent.change(screen.getByTestId('giftcard-name-input'), { target: { value: 'Will fail' } });
    fireEvent.change(screen.getByTestId('giftcard-giftvalue-input'), { target: { value: '999999' } });
    fireEvent.click(screen.getByTestId('giftcard-save-btn'));

    await waitFor(() =>
      expect(notify.error).toHaveBeenCalledWith(expect.stringMatching(/amount exceeds policy cap/i)),
    );
    // Modal stays open so the operator can correct + retry.
    expect(screen.getByRole('heading', { name: /Add gift card/i })).toBeInTheDocument();
  });
});
