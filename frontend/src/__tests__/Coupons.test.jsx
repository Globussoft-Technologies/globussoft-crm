/**
 * Coupons.jsx — Tick #125 wellness admin coverage.
 *
 * SUT lives at frontend/src/pages/wellness/Coupons.jsx (Wave 11 Agent FF —
 * promotion / discount coupon admin). The page pins two flows:
 *
 *   • CRUD list — GET /api/wellness/coupons + create/edit/delete via
 *     POST / PUT / DELETE /api/wellness/coupons[/:id].
 *   • Preview modal — POST /api/wellness/coupons/preview with
 *     { code, baseAmount } so the operator can sanity-check a discount
 *     math before sending the code to a customer.
 *
 * What this test pins
 * -------------------
 *   1. Page chrome — heading, copy, "New coupon" + "Preview a code" CTAs.
 *   2. Loading-state shows the literal "Loading…" placeholder until the
 *      GET resolves (per CLAUDE.md tick #108 cron-learning).
 *   3. GET on mount hits /api/wellness/coupons and renders a row per
 *      coupon with PERCENT vs FLAT discount display + redemption count
 *      and a date-range validity label.
 *   4. Empty-state copy ("No coupons yet.") when the API returns an
 *      empty list.
 *   5. Validity formatting branches (both-dates, until-only, from-only,
 *      neither) all render the expected strings.
 *   6. New-coupon modal opens with the editor fields rendered (code,
 *      type, discount value, max redemptions, valid from/until, active).
 *   7. Validation — empty code rejected; non-positive value rejected;
 *      PERCENT > 100 rejected. All three surface via notify.error and
 *      do NOT POST.
 *   8. Submit POSTs /api/wellness/coupons with the upper-cased code +
 *      typed integers + ISO-shaped fields, then re-fetches the list and
 *      closes the modal.
 *   9. Edit flow opens the editor with pre-filled fields, code input is
 *      disabled (immutable), PUT goes to /api/wellness/coupons/:id.
 *  10. Delete flow asks native `confirm()` then DELETEs the coupon and
 *      surfaces a success notify; declining the confirm aborts.
 *  11. Preview modal POSTs to /api/wellness/coupons/preview and renders
 *      the discount + finalAmount; an `applied: false` response surfaces
 *      the "does not apply" copy.
 *  12. GET error surfaces notify.error with the server message.
 *  13. Loading→error→empty transition leaves the page in the empty
 *      state (no row leakage from the in-flight load).
 *
 * Mocking
 * -------
 *   • fetchApi mocked via vi.fn at module scope, behaviour swapped per
 *     test via mockImplementation.
 *   • useNotify returns a STABLE mock object reference per the
 *     RTL-stable-mock standing rule.
 *   • formatMoney mocked to a deterministic "INR X.XX" string so date
 *     / Intl differences across CI ICU builds don't leak in (cf.
 *     CashRegisters.test.jsx prior art).
 *
 * Drift pinned vs original prompt
 * --------------------------------
 *   • Endpoint is /api/wellness/coupons, NOT /api/coupons.
 *   • No RBAC gating in SUT — all admin CTAs always render; "USER hides
 *     mutation CTAs" enumerated in the prompt does NOT match reality.
 *   • Delete uses native window.confirm (not notify.confirm).
 *   • Discount-display uses formatMoney for FLAT and "N%" for PERCENT,
 *     not "$N" hard-coded.
 *   • Preview modal is a separate flow, not validation inside the editor.
 *   • There are no status / expiry filter chrome elements; original
 *     prompt's "filter bar" enumeration does not match SUT.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

const fetchApiMock = vi.fn();
vi.mock('../utils/api', () => ({
  fetchApi: (...args) => fetchApiMock(...args),
  getAuthToken: () => 'test-token',
}));

const notify = {
  success: vi.fn(),
  error: vi.fn(),
  info: vi.fn(),
  confirm: vi.fn(() => Promise.resolve(true)),
  prompt: vi.fn(() => Promise.resolve('')),
};
vi.mock('../utils/notify', () => ({
  useNotify: () => notify,
}));

vi.mock('../utils/money', () => ({
  formatMoney: (v) => `INR ${Number(v || 0).toFixed(2)}`,
  tenantCurrency: () => 'INR',
}));

// Import SUT AFTER the mocks so it picks up our fetchApi.
import CouponsPage from '../pages/wellness/Coupons';

// ── Fixtures ──────────────────────────────────────────────────────────
const COUPON_PERCENT = {
  id: 1,
  code: 'SUMMER25',
  discountType: 'PERCENT',
  discountValue: 25,
  redemptionCount: 12,
  maxRedemptions: 100,
  validFrom: '2026-06-01T00:00:00.000Z',
  validUntil: '2026-08-31T00:00:00.000Z',
  isActive: true,
};

const COUPON_FLAT = {
  id: 2,
  code: 'FLAT500',
  discountType: 'FLAT',
  discountValue: 500,
  redemptionCount: 3,
  maxRedemptions: null,
  validFrom: null,
  validUntil: '2026-12-31T00:00:00.000Z',
  isActive: true,
};

const COUPON_OPEN_RANGE = {
  id: 3,
  code: 'FOREVER',
  discountType: 'PERCENT',
  discountValue: 10,
  redemptionCount: 0,
  maxRedemptions: null,
  validFrom: '2026-01-01T00:00:00.000Z',
  validUntil: null,
  isActive: false,
};

const COUPON_NO_DATES = {
  id: 4,
  code: 'ANYTIME',
  discountType: 'FLAT',
  discountValue: 100,
  redemptionCount: 1,
  maxRedemptions: null,
  validFrom: null,
  validUntil: null,
  isActive: true,
};

function makeListMock(coupons) {
  return (url, opts = {}) => {
    const method = opts.method || 'GET';
    if (url === '/api/wellness/coupons' && method === 'GET') {
      return Promise.resolve({ coupons });
    }
    if (url === '/api/wellness/coupons' && method === 'POST') {
      const body = opts.body ? JSON.parse(opts.body) : {};
      return Promise.resolve({ id: 99, ...body });
    }
    if (/^\/api\/wellness\/coupons\/\d+$/.test(url) && method === 'PUT') {
      const id = parseInt(url.split('/').pop(), 10);
      const body = opts.body ? JSON.parse(opts.body) : {};
      return Promise.resolve({ id, ...body });
    }
    if (/^\/api\/wellness\/coupons\/\d+$/.test(url) && method === 'DELETE') {
      return Promise.resolve({ ok: true });
    }
    if (url === '/api/wellness/coupons/preview' && method === 'POST') {
      return Promise.resolve({
        code: 'SUMMER25',
        discount: 250,
        finalAmount: 750,
        applied: true,
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
});

// ─────────────────────────────────────────────────────────────────────
// 1-2. Page chrome + loading state
// ─────────────────────────────────────────────────────────────────────
describe('Coupons — page chrome + loading', () => {
  it('renders heading, intro copy, and both action CTAs', async () => {
    fetchApiMock.mockImplementation(makeListMock([COUPON_PERCENT]));
    render(<CouponsPage />);

    expect(screen.getByRole('heading', { name: /Coupons/i })).toBeInTheDocument();
    expect(
      screen.getByText(/Promotional discounts.*PERCENT or FLAT/i),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Preview a code/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /New coupon/i })).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText('SUMMER25')).toBeInTheDocument());
  });

  it('shows the literal "Loading…" placeholder until GET resolves', async () => {
    let resolveFn;
    fetchApiMock.mockImplementation((url) => {
      if (url === '/api/wellness/coupons') {
        return new Promise((r) => {
          resolveFn = r;
        });
      }
      return Promise.resolve({});
    });
    render(<CouponsPage />);
    expect(screen.getByText(/Loading…/i)).toBeInTheDocument();
    resolveFn({ coupons: [] });
    await waitFor(() => expect(screen.queryByText(/Loading…/i)).not.toBeInTheDocument());
  });
});

// ─────────────────────────────────────────────────────────────────────
// 3-5. List rendering: PERCENT vs FLAT, redemptions, validity branches
// ─────────────────────────────────────────────────────────────────────
describe('Coupons — list rendering', () => {
  it('renders PERCENT row with "N%" discount and "X / Y" redemption count', async () => {
    fetchApiMock.mockImplementation(makeListMock([COUPON_PERCENT]));
    render(<CouponsPage />);

    await waitFor(() => expect(screen.getByText('SUMMER25')).toBeInTheDocument());
    expect(screen.getByText('25%')).toBeInTheDocument();
    expect(screen.getByText('12 / 100')).toBeInTheDocument();
    // Both-dates validity branch.
    expect(screen.getByText('2026-06-01 → 2026-08-31')).toBeInTheDocument();
    // Active flag rendered as Yes.
    expect(screen.getByText('Yes')).toBeInTheDocument();
  });

  it('renders FLAT row with formatMoney discount + "until X" validity', async () => {
    fetchApiMock.mockImplementation(makeListMock([COUPON_FLAT]));
    render(<CouponsPage />);

    await waitFor(() => expect(screen.getByText('FLAT500')).toBeInTheDocument());
    // formatMoney mock renders "INR 500.00".
    expect(screen.getByText('INR 500.00')).toBeInTheDocument();
    // No maxRedemptions → just the bare count.
    expect(screen.getByText('3')).toBeInTheDocument();
    // until-only validity branch.
    expect(screen.getByText('until 2026-12-31')).toBeInTheDocument();
  });

  it('renders open-range coupons with "from X" validity and inactive flag', async () => {
    fetchApiMock.mockImplementation(makeListMock([COUPON_OPEN_RANGE]));
    render(<CouponsPage />);

    await waitFor(() => expect(screen.getByText('FOREVER')).toBeInTheDocument());
    expect(screen.getByText('from 2026-01-01')).toBeInTheDocument();
    expect(screen.getByText('No')).toBeInTheDocument();
  });

  it('renders "—" validity when neither validFrom nor validUntil set', async () => {
    fetchApiMock.mockImplementation(makeListMock([COUPON_NO_DATES]));
    render(<CouponsPage />);

    await waitFor(() => expect(screen.getByText('ANYTIME')).toBeInTheDocument());
    expect(screen.getByText('—')).toBeInTheDocument();
  });

  it('renders empty-state copy when no coupons exist', async () => {
    fetchApiMock.mockImplementation(makeListMock([]));
    render(<CouponsPage />);

    await waitFor(() => expect(screen.getByText(/No coupons yet/i)).toBeInTheDocument());
  });
});

// ─────────────────────────────────────────────────────────────────────
// 6-8. New coupon modal — open, validate, submit
// ─────────────────────────────────────────────────────────────────────
describe('Coupons — new coupon flow', () => {
  it('opens the editor modal with all expected fields when "New coupon" is clicked', async () => {
    fetchApiMock.mockImplementation(makeListMock([]));
    render(<CouponsPage />);

    await waitFor(() => expect(screen.getByText(/No coupons yet/i)).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: /New coupon/i }));

    expect(screen.getByRole('heading', { name: /New coupon/i })).toBeInTheDocument();
    expect(screen.getByLabelText(/^Code$/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/^Type$/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/^Discount value$/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/Max redemptions/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/Valid from/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/Valid until/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/^Active$/i)).toBeInTheDocument();
  });

  it('rejects empty code, non-positive value, and PERCENT > 100 via notify.error (no POST)', async () => {
    fetchApiMock.mockImplementation(makeListMock([]));
    render(<CouponsPage />);

    await waitFor(() => expect(screen.getByText(/No coupons yet/i)).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: /New coupon/i }));

    // Empty code → error.
    fireEvent.click(screen.getByRole('button', { name: /^Save$/i }));
    await waitFor(() =>
      expect(notify.error).toHaveBeenCalledWith(expect.stringMatching(/Code is required/i)),
    );

    // Fill code, leave value blank → "must be positive".
    fireEvent.change(screen.getByLabelText(/^Code$/i), { target: { value: 'abc' } });
    fireEvent.click(screen.getByRole('button', { name: /^Save$/i }));
    await waitFor(() =>
      expect(notify.error).toHaveBeenCalledWith(expect.stringMatching(/Discount value must be positive/i)),
    );

    // PERCENT default + value 150 → "PERCENT must be ≤ 100".
    fireEvent.change(screen.getByLabelText(/^Discount value$/i), { target: { value: '150' } });
    fireEvent.click(screen.getByRole('button', { name: /^Save$/i }));
    await waitFor(() =>
      expect(notify.error).toHaveBeenCalledWith(expect.stringMatching(/PERCENT must be ≤ 100/i)),
    );

    // None of the validation paths should have POSTed.
    const postCalls = fetchApiMock.mock.calls.filter(
      ([, opts]) => opts?.method === 'POST',
    );
    expect(postCalls.length).toBe(0);
  });

  it('POSTs /api/wellness/coupons with upper-cased code + typed numeric fields on submit', async () => {
    fetchApiMock.mockImplementation(makeListMock([]));
    render(<CouponsPage />);

    await waitFor(() => expect(screen.getByText(/No coupons yet/i)).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: /New coupon/i }));

    fireEvent.change(screen.getByLabelText(/^Code$/i), { target: { value: 'newyear' } });
    fireEvent.change(screen.getByLabelText(/^Type$/i), { target: { value: 'FLAT' } });
    fireEvent.change(screen.getByLabelText(/^Discount value$/i), { target: { value: '250' } });
    fireEvent.change(screen.getByLabelText(/Max redemptions/i), { target: { value: '50' } });
    fireEvent.change(screen.getByLabelText(/Valid from/i), { target: { value: '2027-01-01' } });
    fireEvent.change(screen.getByLabelText(/Valid until/i), { target: { value: '2027-01-31' } });

    fireEvent.click(screen.getByRole('button', { name: /^Save$/i }));

    await waitFor(() => {
      const calls = fetchApiMock.mock.calls.filter(
        ([url, opts]) => url === '/api/wellness/coupons' && opts?.method === 'POST',
      );
      expect(calls.length).toBe(1);
      const body = JSON.parse(calls[0][1].body);
      expect(body).toEqual({
        code: 'NEWYEAR',
        discountType: 'FLAT',
        discountValue: 250,
        maxRedemptions: 50,
        validFrom: '2027-01-01',
        validUntil: '2027-01-31',
        isActive: true,
      });
    });
    expect(notify.success).toHaveBeenCalledWith(expect.stringMatching(/Coupon created/i));
  });
});

// ─────────────────────────────────────────────────────────────────────
// 9. Edit flow
// ─────────────────────────────────────────────────────────────────────
describe('Coupons — edit flow', () => {
  it('opens editor pre-filled with row data, disables code, PUTs /api/wellness/coupons/:id', async () => {
    fetchApiMock.mockImplementation(makeListMock([COUPON_PERCENT]));
    render(<CouponsPage />);

    await waitFor(() => expect(screen.getByText('SUMMER25')).toBeInTheDocument());
    // First icon button on the row is the edit Pencil. There are 2 icon
    // buttons per row (edit, delete); we pick edit by its lucide svg via
    // querying the first within the row's action cell.
    const editButtons = document.querySelectorAll('button svg.lucide-pencil');
    expect(editButtons.length).toBeGreaterThan(0);
    fireEvent.click(editButtons[0].closest('button'));

    expect(screen.getByRole('heading', { name: /Edit coupon/i })).toBeInTheDocument();
    const codeInput = screen.getByLabelText(/^Code$/i);
    expect(codeInput.value).toBe('SUMMER25');
    expect(codeInput).toBeDisabled();
    expect(screen.getByLabelText(/^Discount value$/i).value).toBe('25');

    // Tweak the value + save.
    fireEvent.change(screen.getByLabelText(/^Discount value$/i), { target: { value: '30' } });
    fireEvent.click(screen.getByRole('button', { name: /^Save$/i }));

    await waitFor(() => {
      const puts = fetchApiMock.mock.calls.filter(
        ([url, opts]) => url === '/api/wellness/coupons/1' && opts?.method === 'PUT',
      );
      expect(puts.length).toBe(1);
      const body = JSON.parse(puts[0][1].body);
      expect(body.discountValue).toBe(30);
      expect(body.code).toBe('SUMMER25');
    });
    expect(notify.success).toHaveBeenCalledWith(expect.stringMatching(/Coupon updated/i));
  });
});

// ─────────────────────────────────────────────────────────────────────
// 10. Delete flow — native confirm gate
// ─────────────────────────────────────────────────────────────────────
describe('Coupons — delete flow', () => {
  // SUT drift: delete uses notify.confirm({...}) (async), NOT window.confirm.
  it('DELETEs /api/wellness/coupons/:id and surfaces success notify when notify.confirm()=true', async () => {
    fetchApiMock.mockImplementation(makeListMock([COUPON_PERCENT]));
    notify.confirm.mockImplementation(() => Promise.resolve(true));
    render(<CouponsPage />);

    await waitFor(() => expect(screen.getByText('SUMMER25')).toBeInTheDocument());
    const trashButtons = document.querySelectorAll('button svg.lucide-trash-2');
    expect(trashButtons.length).toBeGreaterThan(0);
    fireEvent.click(trashButtons[0].closest('button'));

    await waitFor(() => {
      const dels = fetchApiMock.mock.calls.filter(
        ([url, opts]) => url === '/api/wellness/coupons/1' && opts?.method === 'DELETE',
      );
      expect(dels.length).toBe(1);
    });
    expect(notify.success).toHaveBeenCalledWith(expect.stringMatching(/Coupon deleted/i));
  });

  it('does NOT DELETE when notify.confirm()=false', async () => {
    fetchApiMock.mockImplementation(makeListMock([COUPON_PERCENT]));
    notify.confirm.mockImplementation(() => Promise.resolve(false));
    render(<CouponsPage />);

    await waitFor(() => expect(screen.getByText('SUMMER25')).toBeInTheDocument());
    const trashButtons = document.querySelectorAll('button svg.lucide-trash-2');
    fireEvent.click(trashButtons[0].closest('button'));

    // Give microtasks a beat.
    await Promise.resolve();
    await Promise.resolve();
    const dels = fetchApiMock.mock.calls.filter(([, opts]) => opts?.method === 'DELETE');
    expect(dels.length).toBe(0);
    expect(notify.success).not.toHaveBeenCalledWith(expect.stringMatching(/Coupon deleted/i));
  });
});

// ─────────────────────────────────────────────────────────────────────
// 11. Preview flow
// ─────────────────────────────────────────────────────────────────────
describe('Coupons — preview flow', () => {
  it('POSTs /api/wellness/coupons/preview and renders discount + finalAmount', async () => {
    fetchApiMock.mockImplementation(makeListMock([]));
    render(<CouponsPage />);

    await waitFor(() => expect(screen.getByText(/No coupons yet/i)).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: /Preview a code/i }));

    expect(screen.getByRole('heading', { name: /Preview a coupon/i })).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText(/^Code$/i), { target: { value: 'summer25' } });
    fireEvent.change(screen.getByLabelText(/Base amount/i), { target: { value: '1000' } });
    fireEvent.click(screen.getByRole('button', { name: /^Preview$/i }));

    await waitFor(() => {
      const calls = fetchApiMock.mock.calls.filter(
        ([url, opts]) =>
          url === '/api/wellness/coupons/preview' && opts?.method === 'POST',
      );
      expect(calls.length).toBe(1);
      const body = JSON.parse(calls[0][1].body);
      expect(body).toEqual({ code: 'SUMMER25', baseAmount: 1000 });
    });

    // Result panel renders formatted discount + final amount.
    await waitFor(() => expect(screen.getByText('INR 250.00')).toBeInTheDocument());
    expect(screen.getByText('INR 750.00')).toBeInTheDocument();
  });

  it('surfaces "does not apply" copy when preview returns applied=false', async () => {
    fetchApiMock.mockImplementation((url, opts = {}) => {
      if (url === '/api/wellness/coupons' && (opts.method || 'GET') === 'GET') {
        return Promise.resolve({ coupons: [] });
      }
      if (url === '/api/wellness/coupons/preview') {
        return Promise.resolve({
          code: 'EXPIRED',
          discount: 0,
          finalAmount: 1000,
          applied: false,
        });
      }
      return Promise.resolve({});
    });
    render(<CouponsPage />);

    await waitFor(() => expect(screen.getByText(/No coupons yet/i)).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: /Preview a code/i }));

    fireEvent.change(screen.getByLabelText(/^Code$/i), { target: { value: 'expired' } });
    fireEvent.change(screen.getByLabelText(/Base amount/i), { target: { value: '1000' } });
    fireEvent.click(screen.getByRole('button', { name: /^Preview$/i }));

    await waitFor(() =>
      expect(
        screen.getByText(/Coupon does not apply to this purchase/i),
      ).toBeInTheDocument(),
    );
  });
});

// ─────────────────────────────────────────────────────────────────────
// 12. Error handling
// ─────────────────────────────────────────────────────────────────────
describe('Coupons — error handling', () => {
  it('GET failure surfaces notify.error with the server message', async () => {
    fetchApiMock.mockImplementation((url) => {
      if (url === '/api/wellness/coupons') {
        return Promise.reject(new Error('coupons offline'));
      }
      return Promise.resolve({});
    });
    render(<CouponsPage />);

    await waitFor(() =>
      expect(notify.error).toHaveBeenCalledWith(expect.stringMatching(/coupons offline/i)),
    );
  });
});
