/**
 * PointOfSale (wellness) — frontend regression coverage for Wave 2A POS
 * backbone (commit e37369a).
 *
 * Surface pinned: the closed-shift / open-shift state machine, basket
 * line-item add + remove, totals math (subtotal − discount + tax → grand
 * total), and the POST shapes for /api/pos/shifts/open, /api/pos/sales,
 * and /api/pos/shifts/:id/close. e2e covers the API contract; this gives
 * regression catching for the UI state transitions, conditional
 * rendering, and form-shape correctness.
 *
 * Contracts pinned:
 *   1. Closed-shift state — "No shift open" card + Register select +
 *      opening float input + "Open shift" submit. Basket / line-item UI
 *      is NOT mounted.
 *   2. Open-shift state — "Shift open" banner + line-item builder + close
 *      shift card. The opening-shift card is NOT mounted.
 *   3. Open-shift POST — clicking "Open shift" submits to
 *      /api/pos/shifts/open with { registerId: number, openingFloat: number }.
 *   4. Add line item — picking lineType + refId + quantity + unitPrice +
 *      Add appends a row to the basket; the row renders type, name, qty,
 *      and a numeric total.
 *   5. Remove line item — clicking the per-row trash button removes the
 *      row from the basket.
 *   6. Totals math — subtotal = Σ qty × unitPrice; grandTotal includes tax.
 *      Pin the formula via two distinct line items.
 *   7. Complete sale — POSTs /api/pos/sales with { shiftId, lineItems,
 *      paymentMethod, discountTotal, taxTotal, paidAmount }. After success
 *      the basket clears and an invoice receipt banner appears.
 *   8. Empty-basket sale — Complete-sale button is disabled when the
 *      basket is empty (the page renders the disabled style + cursor;
 *      clicking does NOT issue a POST).
 *   9. Close shift — clicking "Close shift" with a closingTotal POSTs
 *      /api/pos/shifts/:id/close with { closingTotal: number, notes }.
 *  10. Add-line guard — clicking Add with no refId/unitPrice surfaces
 *      a notify.error and does NOT append to the basket.
 *
 * Mocking — fetchApi is a vi.fn at module scope; useNotify returns
 * spy fns so the rejection-path tests can assert which message fired.
 * formatMoney() is left un-mocked: the page invokes it as
 * `formatMoney(value, 'INR', 'en-IN')` (3-arg legacy form) so opts
 * resolves to the string 'INR' and the function falls back to the
 * tenant default currency. Tests assert on the digit content of the
 * rendered amounts (e.g. /500/), not on the currency symbol — keeps
 * the spec portable across CI ICU builds + tenant context.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within, act } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import PointOfSale from '../pages/wellness/PointOfSale';
import { AuthContext } from '../App';

const fetchApiMock = vi.fn();
vi.mock('../utils/api', () => ({
  fetchApi: (...args) => fetchApiMock(...args),
}));

const notifyError = vi.fn();
const notifySuccess = vi.fn();
const notifyInfo = vi.fn();
vi.mock('../utils/notify', () => ({
  useNotify: () => ({
    error: notifyError,
    success: notifySuccess,
    info: notifyInfo,
    confirm: () => Promise.resolve(true),
    prompt: () => Promise.resolve(''),
  }),
}));

const REGISTERS = [
  { id: 11, name: 'Front Desk', location: { id: 1, name: 'HSR Layout' } },
  { id: 12, name: 'Pharmacy Counter', location: { id: 1, name: 'HSR Layout' } },
];

const OPEN_SHIFT = {
  id: 999,
  registerId: 11,
  register: { id: 11, name: 'Front Desk' },
  openingFloat: 500,
  status: 'OPEN',
};

// ── Mock builders ──────────────────────────────────────────────────────
// Defaults used by the closed-shift state: registers list returns 2 entries,
// /shifts/current rejects (no open shift). Tests can override per-call via
// fetchApiMock.mockImplementation(...).
function defaultClosedShiftMock(url, opts) {
  if (url === '/api/pos/registers?isActive=true') return Promise.resolve(REGISTERS);
  if (url === '/api/pos/shifts/current') return Promise.reject(new Error('no shift'));
  if (opts?.method === 'POST' && url === '/api/pos/shifts/open') {
    return Promise.resolve(OPEN_SHIFT);
  }
  return Promise.resolve([]);
}

function defaultOpenShiftMock(url, opts) {
  if (url === '/api/pos/registers?isActive=true') return Promise.resolve(REGISTERS);
  if (url === '/api/pos/shifts/current') return Promise.resolve(OPEN_SHIFT);
  if (opts?.method === 'POST' && url === '/api/pos/sales') {
    return Promise.resolve({
      id: 7001,
      invoiceNumber: 'INV-0001',
      total: 1180,
      paymentMethod: 'CASH',
      lineItems: [{ id: 1 }, { id: 2 }],
    });
  }
  if (opts?.method === 'POST' && /^\/api\/pos\/shifts\/\d+\/close$/.test(url)) {
    return Promise.resolve({ id: OPEN_SHIFT.id, status: 'CLOSED', variance: 0 });
  }
  return Promise.resolve([]);
}

function renderPos() {
  return render(
    <MemoryRouter>
      <PointOfSale />
    </MemoryRouter>,
  );
}

// PointOfSale.jsx uses bare <label> + sibling <input>/<select> with no
// htmlFor/id linkage, so RTL's getByLabelText fails. Walk the DOM the
// same way a sighted user would: find the <label> text node, then take
// the next form control inside the same wrapper <div>. Returns null
// if not found so tests can fall through to a clearer assertion.
function controlForLabel(text) {
  const labels = Array.from(document.querySelectorAll('label'));
  const matcher = text instanceof RegExp ? text : new RegExp(`^${text}$`, 'i');
  const label = labels.find((l) => matcher.test((l.textContent || '').trim()));
  if (!label) return null;
  const wrapper = label.parentElement;
  return wrapper ? wrapper.querySelector('input, select, textarea') : null;
}

// Helper: walks the rendered basket card and adds a line via the form.
async function addLine({ lineType = 'SERVICE', refId, name = '', quantity = 1, unitPrice }) {
  const typeSelect = controlForLabel('Type');
  const refIdInput = controlForLabel(/^Ref ID$/i);
  const nameInput = controlForLabel('Name');
  const qtyInput = controlForLabel('Qty');
  const priceInput = controlForLabel('Unit price');

  fireEvent.change(typeSelect, { target: { value: lineType } });
  fireEvent.change(refIdInput, { target: { value: String(refId) } });
  if (name) fireEvent.change(nameInput, { target: { value: name } });
  fireEvent.change(qtyInput, { target: { value: String(quantity) } });
  fireEvent.change(priceInput, { target: { value: String(unitPrice) } });

  fireEvent.click(screen.getByRole('button', { name: /^Add$/i }));
}

describe('<PointOfSale /> — closed-shift state', () => {
  beforeEach(() => {
    fetchApiMock.mockReset();
    notifyError.mockReset();
    notifySuccess.mockReset();
    notifyInfo.mockReset();
    fetchApiMock.mockImplementation(defaultClosedShiftMock);
  });

  it('renders the "No shift open" card with register select + opening float input', async () => {
    renderPos();
    await waitFor(() =>
      expect(screen.getByText(/No shift open/i)).toBeInTheDocument(),
    );
    // Register dropdown populated from /api/pos/registers
    const registerSelect = controlForLabel('Register');
    expect(registerSelect).toBeTruthy();
    await waitFor(() => {
      const opts = within(registerSelect).getAllByRole('option');
      // Placeholder + 2 registers
      expect(opts.length).toBe(3);
    });
    expect(screen.getByText(/Front Desk/i)).toBeInTheDocument();
    expect(screen.getByText(/Pharmacy Counter/i)).toBeInTheDocument();

    // Opening float input + Open shift button rendered
    expect(controlForLabel(/Opening float/i)).toBeTruthy();
    expect(screen.getByRole('button', { name: /Open shift/i })).toBeInTheDocument();

    // Basket / line-item UI is NOT mounted in closed-shift state
    expect(controlForLabel('Type')).toBeNull();
    expect(controlForLabel(/^Ref ID$/i)).toBeNull();
    expect(screen.queryByRole('button', { name: /Complete sale/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Close shift$/i })).not.toBeInTheDocument();
  });

  it('rejects "Open shift" without a register selected — notify.error + no POST', async () => {
    renderPos();
    await waitFor(() =>
      expect(screen.getByText(/No shift open/i)).toBeInTheDocument(),
    );
    fetchApiMock.mockClear();

    fireEvent.click(screen.getByRole('button', { name: /Open shift/i }));

    await waitFor(() => {
      expect(notifyError).toHaveBeenCalledWith(expect.stringMatching(/Pick a register/i));
    });
    const postCall = fetchApiMock.mock.calls.find(
      ([url, opts]) => url === '/api/pos/shifts/open' && opts?.method === 'POST',
    );
    expect(postCall).toBeUndefined();
  });

  it('Open-shift POST sends { registerId: number, openingFloat: number }', async () => {
    renderPos();
    await waitFor(() =>
      expect(screen.getByText(/No shift open/i)).toBeInTheDocument(),
    );

    fireEvent.change(controlForLabel('Register'), { target: { value: '11' } });
    fireEvent.change(controlForLabel(/Opening float/i), { target: { value: '500' } });
    fireEvent.click(screen.getByRole('button', { name: /Open shift/i }));

    await waitFor(() => {
      const call = fetchApiMock.mock.calls.find(
        ([url, opts]) => url === '/api/pos/shifts/open' && opts?.method === 'POST',
      );
      expect(call).toBeDefined();
      const body = JSON.parse(call[1].body);
      expect(body.registerId).toBe(11);
      expect(typeof body.registerId).toBe('number');
      expect(body.openingFloat).toBe(500);
      expect(typeof body.openingFloat).toBe('number');
    });
    // After successful open, the page swaps to the open-shift surface.
    await waitFor(() =>
      expect(screen.getByText(/Shift open/i)).toBeInTheDocument(),
    );
    expect(notifySuccess).toHaveBeenCalledWith(expect.stringMatching(/Shift opened/i));
  });
});

describe('<PointOfSale /> — open-shift state', () => {
  beforeEach(() => {
    fetchApiMock.mockReset();
    notifyError.mockReset();
    notifySuccess.mockReset();
    notifyInfo.mockReset();
    fetchApiMock.mockImplementation(defaultOpenShiftMock);
  });

  it('renders the open-shift banner + line-item builder + close-shift card', async () => {
    renderPos();
    await waitFor(() => expect(screen.getByText(/Shift open/i)).toBeInTheDocument());

    // Banner mentions register name + opening float
    expect(screen.getByText(/Front Desk/i)).toBeInTheDocument();

    // Line-item builder fields all present
    expect(controlForLabel('Type')).toBeTruthy();
    expect(controlForLabel(/^Ref ID$/i)).toBeTruthy();
    expect(controlForLabel('Qty')).toBeTruthy();
    expect(controlForLabel('Unit price')).toBeTruthy();
    expect(screen.getByRole('button', { name: /^Add$/i })).toBeInTheDocument();

    // Complete sale + close shift buttons present (close-shift section)
    expect(screen.getByRole('button', { name: /Complete sale/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Close shift$/i })).toBeInTheDocument();

    // The "No shift open" opening-shift card is NOT mounted.
    expect(screen.queryByText(/No shift open/i)).not.toBeInTheDocument();
  });

  it('Add-line guard fires when refId or unitPrice is missing', async () => {
    renderPos();
    await waitFor(() => expect(screen.getByText(/Shift open/i)).toBeInTheDocument());

    // Click Add with empty draft → notify.error + no row added.
    fireEvent.click(screen.getByRole('button', { name: /^Add$/i }));

    await waitFor(() => {
      expect(notifyError).toHaveBeenCalledWith(
        expect.stringMatching(/refId.*unitPrice.*required/i),
      );
    });
    // Empty-state copy still shown.
    expect(screen.getByText(/No lines yet/i)).toBeInTheDocument();
  });

  it('Add line appends a row with the typed name + qty + total', async () => {
    renderPos();
    await waitFor(() => expect(screen.getByText(/Shift open/i)).toBeInTheDocument());

    await addLine({ lineType: 'SERVICE', refId: 100, name: 'Hair Transplant', quantity: 1, unitPrice: 1000 });

    // Row body — type label, name, qty all rendered
    await waitFor(() => expect(screen.getByText('Hair Transplant')).toBeInTheDocument());
    expect(screen.getByText('SERVICE')).toBeInTheDocument();
    // Line total numeric content (1 × 1000 = 1000) — assert digit presence,
    // not currency symbol, since formatMoney's currency depends on the
    // tenant in localStorage which the test doesn't seed.
    const row = screen.getByText('Hair Transplant').closest('tr');
    expect(row).toBeTruthy();
    expect(row.textContent).toMatch(/1,?000/);
    // Header switches from "0 lines" / "No lines yet" → "1 line" copy.
    expect(screen.queryByText(/No lines yet/i)).not.toBeInTheDocument();
    expect(screen.getByText(/Current sale \(1 line\)/i)).toBeInTheDocument();
  });

  it('Remove line button drops the row from the basket', async () => {
    renderPos();
    await waitFor(() => expect(screen.getByText(/Shift open/i)).toBeInTheDocument());

    await addLine({ refId: 100, name: 'Botox', quantity: 1, unitPrice: 500 });
    await waitFor(() => expect(screen.getByText('Botox')).toBeInTheDocument());

    // Per source (PointOfSale.jsx:1439) the trash button's aria-label is
    // `Remove ${l.name}` — e.g. "Remove Botox" — not the generic "Remove
    // line" the original test assumed. Match the dynamic shape.
    fireEvent.click(screen.getByRole('button', { name: /^Remove Botox/i }));

    await waitFor(() => expect(screen.queryByText('Botox')).not.toBeInTheDocument());
    expect(screen.getByText(/No lines yet/i)).toBeInTheDocument();
  });

  it('subtotal + tax compose the grand total', async () => {
    renderPos();
    await waitFor(() => expect(screen.getByText(/Shift open/i)).toBeInTheDocument());

    // Two lines: 2 × 500 + 1 × 200 = 1200 subtotal.
    await addLine({ refId: 1, name: 'Service A', quantity: 2, unitPrice: 500 });
    await waitFor(() => expect(screen.getByText('Service A')).toBeInTheDocument());
    await addLine({ refId: 2, name: 'Service B', quantity: 1, unitPrice: 200 });
    await waitFor(() => expect(screen.getByText('Service B')).toBeInTheDocument());

    // Apply 18% tax = 216 → grand total 1416.
    fireEvent.change(controlForLabel(/^Tax$/i), { target: { value: '216' } });

    // Subtotal block contains the 1,200 figure.
    const subtotalLine = screen.getByText(/Subtotal/i);
    expect(subtotalLine.textContent).toMatch(/1,?200/);
    // Total block carries 1,416.
    const totalLine = screen.getByText(/^Total:/i);
    expect(totalLine.textContent).toMatch(/1,?416/);
  });

  it('Complete sale POST sends { shiftId, lineItems, paymentMethod, paidAmount, … }', async () => {
    renderPos();
    await waitFor(() => expect(screen.getByText(/Shift open/i)).toBeInTheDocument());

    await addLine({ lineType: 'SERVICE', refId: 100, name: 'Hair Transplant', quantity: 1, unitPrice: 1000 });
    await waitFor(() => expect(screen.getByText('Hair Transplant')).toBeInTheDocument());

    fireEvent.change(controlForLabel(/Payment method/i), { target: { value: 'UPI' } });

    fireEvent.click(screen.getByRole('button', { name: /Complete sale/i }));

    await waitFor(() => {
      const call = fetchApiMock.mock.calls.find(
        ([url, opts]) => url === '/api/pos/sales' && opts?.method === 'POST',
      );
      expect(call).toBeDefined();
      const body = JSON.parse(call[1].body);
      expect(body.shiftId).toBe(OPEN_SHIFT.id);
      expect(Array.isArray(body.lineItems)).toBe(true);
      expect(body.lineItems.length).toBe(1);
      expect(body.lineItems[0].lineType).toBe('SERVICE');
      expect(body.lineItems[0].refId).toBe(100);
      expect(body.lineItems[0].quantity).toBe(1);
      expect(body.lineItems[0].unitPrice).toBe(1000);
      expect(body.paymentMethod).toBe('UPI');
      expect(typeof body.paidAmount).toBe('number');
      expect(typeof body.discountTotal).toBe('number');
      expect(typeof body.taxTotal).toBe('number');
    });

    // Receipt banner appears + basket clears.
    await waitFor(() =>
      expect(screen.getByText(/Sale INV-0001 complete/i)).toBeInTheDocument(),
    );
    expect(screen.getByText(/No lines yet/i)).toBeInTheDocument();
    expect(notifySuccess).toHaveBeenCalledWith(expect.stringMatching(/INV-0001/));
  });

  it('Complete sale button is disabled when basket is empty', async () => {
    renderPos();
    await waitFor(() => expect(screen.getByText(/Shift open/i)).toBeInTheDocument());

    const button = screen.getByRole('button', { name: /Complete sale/i });
    expect(button).toBeDisabled();

    // Click does NOT trigger a sales POST (the disabled attribute prevents it).
    fireEvent.click(button);
    const call = fetchApiMock.mock.calls.find(
      ([url, opts]) => url === '/api/pos/sales' && opts?.method === 'POST',
    );
    expect(call).toBeUndefined();
  });

  it('Close shift POST hits /api/pos/shifts/:id/close with closingTotal as a number', async () => {
    renderPos();
    await waitFor(() => expect(screen.getByText(/Shift open/i)).toBeInTheDocument());

    fireEvent.change(controlForLabel(/Closing total/i), { target: { value: '1500' } });
    fireEvent.change(controlForLabel(/Notes/i), { target: { value: 'no variance' } });
    fireEvent.click(screen.getByRole('button', { name: /^Close shift$/i }));

    await waitFor(() => {
      const call = fetchApiMock.mock.calls.find(
        ([url, opts]) => /^\/api\/pos\/shifts\/\d+\/close$/.test(url) && opts?.method === 'POST',
      );
      expect(call).toBeDefined();
      expect(call[0]).toBe(`/api/pos/shifts/${OPEN_SHIFT.id}/close`);
      const body = JSON.parse(call[1].body);
      expect(body.closingTotal).toBe(1500);
      expect(typeof body.closingTotal).toBe('number');
      expect(body.notes).toBe('no variance');
    });

    // Successful close → page returns to the closed-shift card.
    await waitFor(() => expect(screen.getByText(/No shift open/i)).toBeInTheDocument());
  });

  it('Close shift rejects an empty closingTotal — notify.error + no POST', async () => {
    renderPos();
    await waitFor(() => expect(screen.getByText(/Shift open/i)).toBeInTheDocument());
    fetchApiMock.mockClear();

    // Closing-total left blank.
    fireEvent.click(screen.getByRole('button', { name: /^Close shift$/i }));

    await waitFor(() => {
      expect(notifyError).toHaveBeenCalledWith(expect.stringMatching(/cash drawer total/i));
    });
    const call = fetchApiMock.mock.calls.find(
      ([url, opts]) => /\/close$/.test(url) && opts?.method === 'POST',
    );
    expect(call).toBeUndefined();
  });
});

// ── #789 / WAL-002 — Wallet + Gift Card payment-method surface ────────────
//
// Acceptance criteria: Wallet and Gift Card visible as selectable payment
// methods at POS; selecting Wallet surfaces the patient's wallet balance;
// selecting Gift Card surfaces a redeem code-input that calls
// /api/wellness/giftcards/redeem.
describe('<PointOfSale /> — wallet + gift card payment methods (#789)', () => {
  beforeEach(() => {
    fetchApiMock.mockReset();
    notifyError.mockReset();
    notifySuccess.mockReset();
    notifyInfo.mockReset();
    fetchApiMock.mockImplementation((url, opts) => {
      if (url === '/api/pos/registers?isActive=true') return Promise.resolve(REGISTERS);
      if (url === '/api/pos/shifts/current') return Promise.resolve(OPEN_SHIFT);
      if (url === '/api/wellness/patients/42/wallet') {
        return Promise.resolve({
          patient: { id: 42, name: 'Asha Iyer' },
          wallet: { id: 9, balance: 750 },
          transactions: [],
        });
      }
      if (opts?.method === 'POST' && url === '/api/wellness/giftcards/redeem') {
        return Promise.resolve({
          giftCard: { id: 5, amount: 500, status: 'redeemed' },
          transaction: { id: 99 },
        });
      }
      return Promise.resolve([]);
    });
  });

  it('payment-method dropdown lists Wallet + Gift Card as human-readable options', async () => {
    renderPos();
    await waitFor(() => expect(screen.getByText(/Shift open/i)).toBeInTheDocument());

    const pmSelect = screen.getByLabelText(/Payment method/i);
    const options = within(pmSelect).getAllByRole('option').map((o) => o.textContent);
    // Friendly labels (not raw enum codes).
    expect(options).toEqual(
      expect.arrayContaining(['Cash', 'Card', 'UPI', 'Wallet', 'Gift Card', 'Split / combined']),
    );
    // Value attribute still pins backend enum.
    const walletOpt = within(pmSelect).getByRole('option', { name: /^Wallet$/ });
    expect(walletOpt.getAttribute('value')).toBe('WALLET');
    const giftOpt = within(pmSelect).getByRole('option', { name: /^Gift Card$/ });
    expect(giftOpt.getAttribute('value')).toBe('GIFTCARD');
  });

  it('selecting Wallet with a Patient ID fetches + displays the wallet balance', async () => {
    renderPos();
    await waitFor(() => expect(screen.getByText(/Shift open/i)).toBeInTheDocument());

    // Set patient id 42 in the Customer card.
    fireEvent.change(controlForLabel(/Patient ID/i), { target: { value: '42' } });
    // Switch the payment method to WALLET.
    fireEvent.change(screen.getByLabelText(/Payment method/i), { target: { value: 'WALLET' } });

    // Hint region + balance digits appear.
    await waitFor(() => {
      expect(screen.getByRole('region', { name: /Wallet balance/i })).toBeInTheDocument();
    });
    // GET /api/wellness/patients/42/wallet was called.
    await waitFor(() => {
      const call = fetchApiMock.mock.calls.find(
        ([url]) => url === '/api/wellness/patients/42/wallet',
      );
      expect(call).toBeDefined();
    });
    // Balance digit ("750") shown — currency symbol depends on ICU build so
    // we only pin the digits.
    await waitFor(() => {
      const balanceEl = screen.getByTestId('wallet-balance');
      expect(balanceEl.textContent).toMatch(/750/);
    });
  });

  it('selecting Wallet without a Patient ID surfaces a hint instead of fetching', async () => {
    renderPos();
    await waitFor(() => expect(screen.getByText(/Shift open/i)).toBeInTheDocument());
    fetchApiMock.mockClear();

    // Switch to WALLET with no patientId in the Customer card.
    fireEvent.change(screen.getByLabelText(/Payment method/i), { target: { value: 'WALLET' } });

    await waitFor(() => {
      expect(screen.getByRole('region', { name: /Wallet balance/i })).toBeInTheDocument();
    });
    expect(screen.getByText(/Enter a Patient ID/i)).toBeInTheDocument();
    // No fetch attempted.
    const walletCall = fetchApiMock.mock.calls.find(
      ([url]) => typeof url === 'string' && url.includes('/wallet'),
    );
    expect(walletCall).toBeUndefined();
  });

  it('selecting Gift Card shows a redeem form; Redeem fires POST /api/wellness/giftcards/redeem and auto-switches to Wallet', async () => {
    renderPos();
    await waitFor(() => expect(screen.getByText(/Shift open/i)).toBeInTheDocument());

    // Set patient id 42 + switch to GIFTCARD.
    fireEvent.change(controlForLabel(/Patient ID/i), { target: { value: '42' } });
    fireEvent.change(screen.getByLabelText(/Payment method/i), { target: { value: 'GIFTCARD' } });

    // Redeem mini-form rendered.
    await waitFor(() => {
      expect(screen.getByRole('region', { name: /Gift card redemption/i })).toBeInTheDocument();
    });
    const codeInput = screen.getByLabelText(/^Gift card code$/i);
    expect(codeInput).toBeInTheDocument();

    // Enter a code + click Redeem.
    fireEvent.change(codeInput, { target: { value: 'GIFT-AAAA-1111' } });
    fireEvent.click(screen.getByRole('button', { name: /^Redeem$/i }));

    // POST sent with { code, patientId } shape.
    await waitFor(() => {
      const call = fetchApiMock.mock.calls.find(
        ([url, opts]) =>
          url === '/api/wellness/giftcards/redeem' && opts?.method === 'POST',
      );
      expect(call).toBeDefined();
      const body = JSON.parse(call[1].body);
      expect(body.code).toBe('GIFT-AAAA-1111');
      expect(body.patientId).toBe(42);
    });
    // Success toast fired.
    await waitFor(() => {
      expect(notifySuccess).toHaveBeenCalledWith(expect.stringMatching(/redeemed/i));
    });
    // Payment method auto-switched to WALLET so the cashier can charge against
    // the now-credited wallet.
    await waitFor(() => {
      const pmSelect = screen.getByLabelText(/Payment method/i);
      expect(pmSelect.value).toBe('WALLET');
    });
  });

  it('Gift Card redeem in guest-checkout mode is rejected with a clear notify.error (no POST)', async () => {
    renderPos();
    await waitFor(() => expect(screen.getByText(/Shift open/i)).toBeInTheDocument());

    // Enable Guest checkout — wallet/giftcard need a registered patient.
    fireEvent.click(screen.getByLabelText(/Guest checkout/i));
    fireEvent.change(screen.getByLabelText(/Payment method/i), { target: { value: 'GIFTCARD' } });

    await waitFor(() => {
      expect(screen.getByRole('region', { name: /Gift card redemption/i })).toBeInTheDocument();
    });
    const codeInput = screen.getByLabelText(/^Gift card code$/i);
    fireEvent.change(codeInput, { target: { value: 'GIFT-AAAA-1111' } });
    fireEvent.click(screen.getByRole('button', { name: /^Redeem$/i }));

    await waitFor(() => {
      expect(notifyError).toHaveBeenCalledWith(expect.stringMatching(/patient/i));
    });
    const call = fetchApiMock.mock.calls.find(
      ([url, opts]) =>
        url === '/api/wellness/giftcards/redeem' && opts?.method === 'POST',
    );
    expect(call).toBeUndefined();
  });
});

// ── EXTENSION 2026-05-26 — additional regression coverage ─────────────
//
// Surface added below the existing 17 cases:
//   - Booking | Walk-in tab strip (D17 Arc 1 slice 1) — URL routing,
//     today's-bookings fetch, Pre-fill from booking, basket pre-population.
//   - Items picker autocomplete (D17 slice 3) — debounced fetch, grouped
//     dropdown, click adds catalogue line at base price.
//   - Row-level qty +/- buttons (updateLineQty) — increment, decrement
//     floor at 1, lineTotal recomputes.
//   - Cart-level discounts — flat, percent, and coupon-preview modes;
//     resolvedOrderDiscount feeds the grandTotal math.
//   - Manager-override (admin/manager-only) — gating, payload shape,
//     reason-required guard.
//   - Payment splitter (D17 slice 4) — method-button adds payment line,
//     /finalize POST shape (cents-native, sale-context wallet gate).
//   - Wallet-balance insufficient-funds warning surface (#789 / WAL-002).
//
// Mocking pattern preserved — stable mock-object refs for notify, fresh
// fetchApiMock per beforeEach. AuthContext wrapper used for admin paths.

const ADMIN_USER = { userId: 9, name: 'Sandhya Admin', email: 'admin@x.com', role: 'ADMIN' };
const TELLER_USER = { userId: 33, name: 'Ravi Teller', email: 'teller@x.com', role: 'USER' };

function renderPosWithUser(user) {
  return render(
    <MemoryRouter>
      <AuthContext.Provider value={{ user, token: 'tk', tenant: { id: 1 }, loading: false }}>
        <PointOfSale />
      </AuthContext.Provider>
    </MemoryRouter>,
  );
}

// ── Tab switching + booking pre-fill (D17 Arc 1 slice 1) ──────────────
describe('<PointOfSale /> — Booking | Walk-in tab strip', () => {
  beforeEach(() => {
    fetchApiMock.mockReset();
    notifyError.mockReset();
    notifySuccess.mockReset();
    notifyInfo.mockReset();
  });

  it('renders both tab buttons with Walk-in selected by default', async () => {
    fetchApiMock.mockImplementation(defaultOpenShiftMock);
    renderPos();
    await waitFor(() => expect(screen.getByText(/Shift open/i)).toBeInTheDocument());

    const bookingTab = screen.getByTestId('pos-tab-booking');
    const walkinTab = screen.getByTestId('pos-tab-walkin');
    expect(bookingTab).toBeInTheDocument();
    expect(walkinTab).toBeInTheDocument();
    // Default tab — walkin selected, booking unselected.
    expect(walkinTab.getAttribute('aria-selected')).toBe('true');
    expect(bookingTab.getAttribute('aria-selected')).toBe('false');
  });

  it('clicking the Booking tab fetches today\'s bookings and renders the row table', async () => {
    const todayBookings = [
      {
        id: 401,
        visitDate: new Date().toISOString(),
        patient: { id: 51, name: 'Neha Sharma' },
        service: { id: 71, name: 'Botox Touch-up' },
        doctor: { id: 6, name: 'Dr. Harsh' },
        status: 'BOOKED',
      },
    ];
    fetchApiMock.mockImplementation((url, opts) => {
      if (url === '/api/pos/registers?isActive=true') return Promise.resolve(REGISTERS);
      if (url === '/api/pos/shifts/current') return Promise.resolve(OPEN_SHIFT);
      if (typeof url === 'string' && url.startsWith('/api/wellness/visits?')) {
        return Promise.resolve(todayBookings);
      }
      return Promise.resolve([]);
    });

    renderPos();
    await waitFor(() => expect(screen.getByText(/Shift open/i)).toBeInTheDocument());

    fireEvent.click(screen.getByTestId('pos-tab-booking'));

    await waitFor(() =>
      expect(screen.getByTestId('pos-booking-panel')).toBeInTheDocument(),
    );
    // Bookings fetch fired with ?from=&to= query.
    await waitFor(() => {
      const call = fetchApiMock.mock.calls.find(
        ([u]) => typeof u === 'string' && u.startsWith('/api/wellness/visits?from='),
      );
      expect(call).toBeDefined();
      expect(call[0]).toMatch(/&to=/);
    });
    // Row content rendered.
    await waitFor(() => expect(screen.getByText('Neha Sharma')).toBeInTheDocument());
    expect(screen.getByText('Botox Touch-up')).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /Pre-fill sale from booking for Neha Sharma/i }),
    ).toBeInTheDocument();
  });

  it('Pre-fill from booking appends a SERVICE line, sets patient ID, and returns to Walk-in tab', async () => {
    const todayBookings = [
      {
        id: 402,
        visitDate: new Date().toISOString(),
        patient: { id: 88, name: 'Ravi Kumar' },
        service: { id: 17, name: 'Skin Polishing' },
        status: 'BOOKED',
      },
    ];
    fetchApiMock.mockImplementation((url) => {
      if (url === '/api/pos/registers?isActive=true') return Promise.resolve(REGISTERS);
      if (url === '/api/pos/shifts/current') return Promise.resolve(OPEN_SHIFT);
      if (typeof url === 'string' && url.startsWith('/api/wellness/visits?')) {
        return Promise.resolve(todayBookings);
      }
      return Promise.resolve([]);
    });

    renderPos();
    await waitFor(() => expect(screen.getByText(/Shift open/i)).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('pos-tab-booking'));
    await waitFor(() => expect(screen.getByText('Skin Polishing')).toBeInTheDocument());

    fireEvent.click(
      screen.getByRole('button', { name: /Pre-fill sale from booking for Ravi Kumar/i }),
    );

    // We get switched back to walkin tab + the basket has the service line.
    await waitFor(() => {
      const walkinTab = screen.getByTestId('pos-tab-walkin');
      expect(walkinTab.getAttribute('aria-selected')).toBe('true');
    });
    // Pre-fill success toast.
    await waitFor(() =>
      expect(notifySuccess).toHaveBeenCalledWith(expect.stringMatching(/Pre-filled Skin Polishing/i)),
    );
    // The service line is now visible in the basket (Walk-in tab).
    await waitFor(() => {
      expect(screen.getByText(/Current sale \(1 line\)/i)).toBeInTheDocument();
    });
    // Patient picker pre-populated from booking.patient.id.
    const pidInput = controlForLabel(/Patient ID/i);
    expect(pidInput).toBeTruthy();
    expect(pidInput.value).toBe('88');
  });
});

// ── Items picker autocomplete (D17 Arc 1 slice 3) ─────────────────────
describe('<PointOfSale /> — items picker autocomplete', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    fetchApiMock.mockReset();
    notifyError.mockReset();
    notifySuccess.mockReset();
    notifyInfo.mockReset();
    fetchApiMock.mockImplementation((url) => {
      if (url === '/api/pos/registers?isActive=true') return Promise.resolve(REGISTERS);
      if (url === '/api/pos/shifts/current') return Promise.resolve(OPEN_SHIFT);
      if (typeof url === 'string' && url.startsWith('/api/wellness/services')) {
        return Promise.resolve([
          { id: 101, name: 'Hydra Facial', basePrice: 2500, category: 'Skin' },
          { id: 102, name: 'Hydra Massage', basePrice: 1200, category: 'Spa' },
        ]);
      }
      if (typeof url === 'string' && url.startsWith('/api/wellness/products')) {
        return Promise.resolve([
          { id: 201, name: 'Hydration Serum', price: 800, currentStock: 14 },
        ]);
      }
      return Promise.resolve([]);
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('typing into the catalogue search debounces the fetch then renders grouped results', async () => {
    renderPos();
    await waitFor(() => expect(screen.getByText(/Shift open/i)).toBeInTheDocument());

    const input = screen.getByTestId('pos-items-search-input');
    fireEvent.change(input, { target: { value: 'hydra' } });

    // Pre-debounce: no fetch fired yet.
    expect(
      fetchApiMock.mock.calls.find(
        ([u]) => typeof u === 'string' && u.includes('/api/wellness/services?q='),
      ),
    ).toBeUndefined();

    // Advance the 300ms debounce timer.
    await act(async () => {
      vi.advanceTimersByTime(320);
    });

    // Fetch fired with ?q=hydra.
    await waitFor(() => {
      const call = fetchApiMock.mock.calls.find(
        ([u]) => typeof u === 'string' && u.includes('/api/wellness/services?q=hydra'),
      );
      expect(call).toBeDefined();
    });
    // Dropdown opens with Services + Products groups.
    await waitFor(() => expect(screen.getByTestId('pos-items-dropdown')).toBeInTheDocument());
    expect(screen.getByTestId('pos-items-result-service-101')).toBeInTheDocument();
    expect(screen.getByTestId('pos-items-result-service-102')).toBeInTheDocument();
    expect(screen.getByTestId('pos-items-result-product-201')).toBeInTheDocument();
  });

  it('clicking a catalogue result appends a basket line at the catalogue price and clears the dropdown', async () => {
    renderPos();
    await waitFor(() => expect(screen.getByText(/Shift open/i)).toBeInTheDocument());

    fireEvent.change(screen.getByTestId('pos-items-search-input'), {
      target: { value: 'hydra' },
    });
    await act(async () => {
      vi.advanceTimersByTime(320);
    });
    await waitFor(() => expect(screen.getByTestId('pos-items-result-service-101')).toBeInTheDocument());

    // Click the Hydra Facial result (₹2,500 base price).
    fireEvent.click(screen.getByTestId('pos-items-result-service-101'));

    // Basket now has one line for Hydra Facial.
    await waitFor(() => expect(screen.getByText('Hydra Facial')).toBeInTheDocument());
    expect(screen.getByText(/Current sale \(1 line\)/i)).toBeInTheDocument();
    // Line total cell carries the catalogue price digits.
    const totalCell = screen.getByTestId('pos-line-total-0');
    expect(totalCell.textContent).toMatch(/2,?500/);
    // notify.success fired with the added-name string.
    expect(notifySuccess).toHaveBeenCalledWith(expect.stringMatching(/Added Hydra Facial/i));
    // Dropdown closed + search cleared.
    expect(screen.queryByTestId('pos-items-dropdown')).not.toBeInTheDocument();
    expect(screen.getByTestId('pos-items-search-input').value).toBe('');
  });
});

// ── Row-level qty +/- + cart-level discount modes ────────────────────
describe('<PointOfSale /> — qty controls + discount modes', () => {
  beforeEach(() => {
    fetchApiMock.mockReset();
    notifyError.mockReset();
    notifySuccess.mockReset();
    notifyInfo.mockReset();
    fetchApiMock.mockImplementation(defaultOpenShiftMock);
  });

  it('row qty + button increments the line; − floors at 1', async () => {
    renderPos();
    await waitFor(() => expect(screen.getByText(/Shift open/i)).toBeInTheDocument());

    await addLine({ refId: 200, name: 'Vitamin C Serum', quantity: 1, unitPrice: 400 });
    await waitFor(() => expect(screen.getByText('Vitamin C Serum')).toBeInTheDocument());

    // Decrement button is disabled at qty=1.
    const decBtn = screen.getByRole('button', { name: /Decrease quantity for Vitamin C Serum/i });
    expect(decBtn).toBeDisabled();

    // Click + twice — qty should be 3.
    const incBtn = screen.getByRole('button', { name: /Increase quantity for Vitamin C Serum/i });
    fireEvent.click(incBtn);
    fireEvent.click(incBtn);

    await waitFor(() => {
      const qtyContainer = screen.getByTestId('pos-line-qty-0');
      expect(qtyContainer.textContent.replace(/\s/g, '')).toMatch(/3/);
    });
    // Line total recomputed (3 × 400 = 1,200).
    const totalCell = screen.getByTestId('pos-line-total-0');
    expect(totalCell.textContent).toMatch(/1,?200/);
  });

  it('flat order-level discount subtracts from grand total', async () => {
    renderPos();
    await waitFor(() => expect(screen.getByText(/Shift open/i)).toBeInTheDocument());

    await addLine({ refId: 1, name: 'Service A', quantity: 1, unitPrice: 1000 });
    await waitFor(() => expect(screen.getByText('Service A')).toBeInTheDocument());

    // Discount mode defaults to 'flat'. Find the flat-discount input.
    const flatInput = controlForLabel(/^Flat discount$/i);
    expect(flatInput).toBeTruthy();
    fireEvent.change(flatInput, { target: { value: '200' } });

    // Subtotal 1,000 − 200 flat = 800 grand total.
    await waitFor(() => {
      const totalLine = screen.getByText(/^Total:/i);
      expect(totalLine.textContent).toMatch(/800/);
    });
  });

  it('percent discount mode computes (subtotal × pct/100) and updates the total', async () => {
    renderPos();
    await waitFor(() => expect(screen.getByText(/Shift open/i)).toBeInTheDocument());

    await addLine({ refId: 1, name: 'Service A', quantity: 2, unitPrice: 500 });
    await waitFor(() => expect(screen.getByText('Service A')).toBeInTheDocument());

    // Switch to percent mode via radio.
    const percentRadio = screen.getByRole('radio', { name: /Percent/i });
    fireEvent.click(percentRadio);

    // 10% on 1,000 subtotal = 100 discount → total 900.
    const pctInput = controlForLabel(/Discount percentage/i);
    expect(pctInput).toBeTruthy();
    fireEvent.change(pctInput, { target: { value: '10' } });

    await waitFor(() => {
      const totalLine = screen.getByText(/^Total:/i);
      expect(totalLine.textContent).toMatch(/900/);
    });
  });

  it('coupon-preview success populates the coupon hint and applies to the grand total', async () => {
    fetchApiMock.mockImplementation((url, opts) => {
      if (url === '/api/pos/registers?isActive=true') return Promise.resolve(REGISTERS);
      if (url === '/api/pos/shifts/current') return Promise.resolve(OPEN_SHIFT);
      if (opts?.method === 'POST' && url === '/api/wellness/coupons/preview') {
        return Promise.resolve({
          applied: true,
          code: 'WELCOME10',
          discount: 100,
          finalAmount: 900,
          discountType: 'FLAT',
        });
      }
      return Promise.resolve([]);
    });

    renderPos();
    await waitFor(() => expect(screen.getByText(/Shift open/i)).toBeInTheDocument());

    await addLine({ refId: 1, name: 'Service A', quantity: 1, unitPrice: 1000 });
    await waitFor(() => expect(screen.getByText('Service A')).toBeInTheDocument());

    // Switch discount mode to coupon.
    const couponRadio = screen.getByRole('radio', { name: /Coupon code/i });
    fireEvent.click(couponRadio);

    // Two "Coupon code" labels exist (radio span + text-input label). Target the
    // text input by its placeholder which is unique.
    const couponInput = screen.getByPlaceholderText('WELCOME10');
    fireEvent.change(couponInput, { target: { value: 'WELCOME10' } });
    fireEvent.click(screen.getByRole('button', { name: /Apply coupon/i }));

    // POST fires with { code, baseAmount: 1000 }.
    await waitFor(() => {
      const call = fetchApiMock.mock.calls.find(
        ([url, opts]) => url === '/api/wellness/coupons/preview' && opts?.method === 'POST',
      );
      expect(call).toBeDefined();
      const body = JSON.parse(call[1].body);
      expect(body.code).toBe('WELCOME10');
      expect(body.baseAmount).toBe(1000);
    });
    // Coupon hint copy + total reflects the discount.
    await waitFor(() => {
      expect(notifySuccess).toHaveBeenCalledWith(expect.stringMatching(/WELCOME10/));
    });
    await waitFor(() => {
      // Grand total is now 900 (subtotal 1000 - coupon discount 100).
      const totalLine = screen.getByText(/^Total:/i);
      expect(totalLine.textContent).toMatch(/900/);
    });
  });

  it('coupon-preview with applied:false fires notify.error and leaves discount unset', async () => {
    fetchApiMock.mockImplementation((url, opts) => {
      if (url === '/api/pos/registers?isActive=true') return Promise.resolve(REGISTERS);
      if (url === '/api/pos/shifts/current') return Promise.resolve(OPEN_SHIFT);
      if (opts?.method === 'POST' && url === '/api/wellness/coupons/preview') {
        return Promise.resolve({ applied: false, code: 'EXPIRED', discount: 0 });
      }
      return Promise.resolve([]);
    });

    renderPos();
    await waitFor(() => expect(screen.getByText(/Shift open/i)).toBeInTheDocument());

    await addLine({ refId: 1, name: 'Service A', quantity: 1, unitPrice: 1000 });
    await waitFor(() => expect(screen.getByText('Service A')).toBeInTheDocument());

    fireEvent.click(screen.getByRole('radio', { name: /Coupon code/i }));
    const couponInput = screen.getByPlaceholderText('WELCOME10');
    fireEvent.change(couponInput, { target: { value: 'EXPIRED' } });
    fireEvent.click(screen.getByRole('button', { name: /Apply coupon/i }));

    await waitFor(() => {
      expect(notifyError).toHaveBeenCalledWith(expect.stringMatching(/does not apply/i));
    });
    // Grand total stays at subtotal (1,000) — coupon not applied.
    const totalLine = screen.getByText(/^Total:/i);
    expect(totalLine.textContent).toMatch(/1,?000/);
  });
});

// ── Manager-override (admin/manager-only RBAC) ────────────────────────
describe('<PointOfSale /> — manager override (admin RBAC)', () => {
  beforeEach(() => {
    fetchApiMock.mockReset();
    notifyError.mockReset();
    notifySuccess.mockReset();
    notifyInfo.mockReset();
    fetchApiMock.mockImplementation(defaultOpenShiftMock);
  });

  it('non-admin users (role=USER) do not see the Manager override card', async () => {
    renderPosWithUser(TELLER_USER);
    await waitFor(() => expect(screen.getByText(/Shift open/i)).toBeInTheDocument());

    // The override section's heading + checkbox should be absent for plain tellers.
    expect(screen.queryByText(/Manager override/i)).not.toBeInTheDocument();
    expect(
      screen.queryByLabelText(/Enable manager override for grand total/i),
    ).not.toBeInTheDocument();
  });

  it('admin user can toggle override on; entered overrideAmount becomes the grand total', async () => {
    renderPosWithUser(ADMIN_USER);
    await waitFor(() => expect(screen.getByText(/Shift open/i)).toBeInTheDocument());

    await addLine({ refId: 1, name: 'Service A', quantity: 1, unitPrice: 1000 });
    await waitFor(() => expect(screen.getByText('Service A')).toBeInTheDocument());

    // Toggle the override checkbox.
    const overrideCb = screen.getByLabelText(/Enable manager override for grand total/i);
    fireEvent.click(overrideCb);

    const amountInput = controlForLabel(/^Override amount$/i);
    expect(amountInput).toBeTruthy();
    fireEvent.change(amountInput, { target: { value: '500' } });

    // Grand total swaps from computed (1000) → manual override (500).
    await waitFor(() => {
      const totalLine = screen.getByText(/^Total:/i);
      expect(totalLine.textContent).toMatch(/500/);
    });
    // The "computed total" hint copy appears.
    expect(
      screen.getByText(/Manager override active.*computed total/i),
    ).toBeInTheDocument();
  });

  it('Complete sale rejects an override with empty reason — no POST fires', async () => {
    renderPosWithUser(ADMIN_USER);
    await waitFor(() => expect(screen.getByText(/Shift open/i)).toBeInTheDocument());

    await addLine({ refId: 1, name: 'Service A', quantity: 1, unitPrice: 1000 });
    await waitFor(() => expect(screen.getByText('Service A')).toBeInTheDocument());

    fireEvent.click(screen.getByLabelText(/Enable manager override for grand total/i));
    fireEvent.change(controlForLabel(/^Override amount$/i), { target: { value: '500' } });
    // Reason left blank.

    fireEvent.click(screen.getByRole('button', { name: /Complete sale/i }));

    await waitFor(() => {
      expect(notifyError).toHaveBeenCalledWith(expect.stringMatching(/reason/i));
    });
    const salesCall = fetchApiMock.mock.calls.find(
      ([url, opts]) => url === '/api/pos/sales' && opts?.method === 'POST',
    );
    expect(salesCall).toBeUndefined();
  });

  it('valid override submits sale POST with managerOverride.{amount,reason} + notes', async () => {
    renderPosWithUser(ADMIN_USER);
    await waitFor(() => expect(screen.getByText(/Shift open/i)).toBeInTheDocument());

    await addLine({ refId: 1, name: 'Service A', quantity: 1, unitPrice: 1000 });
    await waitFor(() => expect(screen.getByText('Service A')).toBeInTheDocument());

    fireEvent.click(screen.getByLabelText(/Enable manager override for grand total/i));
    fireEvent.change(controlForLabel(/^Override amount$/i), { target: { value: '750' } });
    fireEvent.change(controlForLabel(/^Reason \(required\)$/i), {
      target: { value: 'Loyalty discount for Dr Harsh referral' },
    });

    fireEvent.click(screen.getByRole('button', { name: /Complete sale/i }));

    await waitFor(() => {
      const call = fetchApiMock.mock.calls.find(
        ([url, opts]) => url === '/api/pos/sales' && opts?.method === 'POST',
      );
      expect(call).toBeDefined();
      const body = JSON.parse(call[1].body);
      expect(body.managerOverride).toBeDefined();
      expect(body.managerOverride.amount).toBe(750);
      expect(body.managerOverride.reason).toBe('Loyalty discount for Dr Harsh referral');
      expect(body.notes).toMatch(/Manager override/i);
      expect(body.notes).toMatch(/750/);
    });
  });
});

// ── Payment splitter (D17 Arc 1 slice 4) ─────────────────────────────
describe('<PointOfSale /> — split-tender finalize flow', () => {
  beforeEach(() => {
    fetchApiMock.mockReset();
    notifyError.mockReset();
    notifySuccess.mockReset();
    notifyInfo.mockReset();
    fetchApiMock.mockImplementation((url, opts) => {
      if (url === '/api/pos/registers?isActive=true') return Promise.resolve(REGISTERS);
      if (url === '/api/pos/shifts/current') return Promise.resolve(OPEN_SHIFT);
      if (typeof url === 'string' && url.startsWith('/api/pos/sale-context/')) {
        return Promise.resolve({ walletBalanceCents: 50_000, currency: 'INR' });
      }
      if (opts?.method === 'POST' && url === '/api/pos/sales/finalize') {
        return Promise.resolve({ saleId: 9001, invoiceNumber: 'INV-SPLIT-9001' });
      }
      return Promise.resolve([]);
    });
  });

  it('payment splitter renders one button per SPLIT_PAYMENT_METHODS option', async () => {
    renderPos();
    await waitFor(() => expect(screen.getByText(/Shift open/i)).toBeInTheDocument());

    // All 5 split-method buttons (cash, card, upi, wallet, giftcard).
    expect(screen.getByTestId('pos-split-method-cash')).toBeInTheDocument();
    expect(screen.getByTestId('pos-split-method-card')).toBeInTheDocument();
    expect(screen.getByTestId('pos-split-method-upi')).toBeInTheDocument();
    expect(screen.getByTestId('pos-split-method-wallet')).toBeInTheDocument();
    expect(screen.getByTestId('pos-split-method-giftcard')).toBeInTheDocument();
    // Empty state copy when no split-payment lines yet.
    expect(screen.getByText(/No payment lines yet/i)).toBeInTheDocument();
    // Finalize button rendered but disabled (no patient, no payments).
    const finalizeBtn = screen.getByTestId('pos-split-finalize');
    expect(finalizeBtn).toBeDisabled();
  });

  it('tapping cash + UPI buttons appends two payment lines and live-updates the balance', async () => {
    renderPos();
    await waitFor(() => expect(screen.getByText(/Shift open/i)).toBeInTheDocument());

    await addLine({ refId: 1, name: 'Service A', quantity: 1, unitPrice: 1000 });
    await waitFor(() => expect(screen.getByText('Service A')).toBeInTheDocument());

    fireEvent.click(screen.getByTestId('pos-split-method-cash'));
    fireEvent.click(screen.getByTestId('pos-split-method-upi'));

    await waitFor(() => {
      expect(screen.getByTestId('pos-split-line-0')).toBeInTheDocument();
      expect(screen.getByTestId('pos-split-line-1')).toBeInTheDocument();
    });
    // Enter 600 cash + 400 UPI = 1,000 total → balance 0.
    fireEvent.change(screen.getByTestId('pos-split-amount-0'), { target: { value: '600' } });
    fireEvent.change(screen.getByTestId('pos-split-amount-1'), { target: { value: '400' } });

    await waitFor(() => {
      const balance = screen.getByTestId('pos-split-balance');
      // Balance shows as "0" or "0.00" depending on currency formatter.
      expect(balance.textContent).toMatch(/0(\.00)?/);
    });
    // The Paid / of totals block carries 1,000 + 1,000.
    const totals = screen.getByTestId('pos-split-totals');
    expect(totals.textContent).toMatch(/1,?000/);
  });

  it('finalize POST sends cents-native body with items[], payments[], discountCents, taxCents', async () => {
    renderPos();
    await waitFor(() => expect(screen.getByText(/Shift open/i)).toBeInTheDocument());

    await addLine({ refId: 17, name: 'Hydra Facial', quantity: 1, unitPrice: 1000 });
    await waitFor(() => expect(screen.getByText('Hydra Facial')).toBeInTheDocument());

    // Patient ID required for finalize (non-guest, positive int).
    fireEvent.change(controlForLabel(/Patient ID/i), { target: { value: '42' } });
    // Wait for sale-context fetch to settle so canFinalize gate sees the patient.
    await waitFor(() => {
      const ctxCall = fetchApiMock.mock.calls.find(
        ([u]) => u === '/api/pos/sale-context/42',
      );
      expect(ctxCall).toBeDefined();
    });

    fireEvent.click(screen.getByTestId('pos-split-method-cash'));
    fireEvent.change(screen.getByTestId('pos-split-amount-0'), { target: { value: '1000' } });

    // Finalize gate should now be open.
    await waitFor(() => expect(screen.getByTestId('pos-split-finalize')).not.toBeDisabled());

    fireEvent.click(screen.getByTestId('pos-split-finalize'));

    await waitFor(() => {
      const call = fetchApiMock.mock.calls.find(
        ([url, opts]) => url === '/api/pos/sales/finalize' && opts?.method === 'POST',
      );
      expect(call).toBeDefined();
      const body = JSON.parse(call[1].body);
      expect(body.patientId).toBe(42);
      expect(Array.isArray(body.items)).toBe(true);
      expect(body.items[0].type).toBe('service');
      expect(body.items[0].refId).toBe(17);
      expect(body.items[0].qty).toBe(1);
      expect(body.items[0].unitPriceCents).toBe(100_000);
      expect(Array.isArray(body.payments)).toBe(true);
      expect(body.payments[0].method).toBe('cash');
      expect(body.payments[0].amountCents).toBe(100_000);
      expect(typeof body.discountCents).toBe('number');
      expect(typeof body.taxCents).toBe('number');
    });
    // Success toast carries the saleId.
    await waitFor(() =>
      expect(notifySuccess).toHaveBeenCalledWith(expect.stringMatching(/9001/)),
    );
  });

  it('wallet button is disabled when sale-context reports zero wallet balance', async () => {
    // Override the per-suite mock to flip walletBalanceCents to 0.
    fetchApiMock.mockImplementation((url) => {
      if (url === '/api/pos/registers?isActive=true') return Promise.resolve(REGISTERS);
      if (url === '/api/pos/shifts/current') return Promise.resolve(OPEN_SHIFT);
      if (typeof url === 'string' && url.startsWith('/api/pos/sale-context/')) {
        return Promise.resolve({ walletBalanceCents: 0, currency: 'INR' });
      }
      return Promise.resolve([]);
    });

    renderPos();
    await waitFor(() => expect(screen.getByText(/Shift open/i)).toBeInTheDocument());

    fireEvent.change(controlForLabel(/Patient ID/i), { target: { value: '42' } });
    await waitFor(() => {
      const ctxCall = fetchApiMock.mock.calls.find(
        ([u]) => u === '/api/pos/sale-context/42',
      );
      expect(ctxCall).toBeDefined();
    });

    // Wallet split-method button should be disabled because walletBalanceCents=0.
    await waitFor(() => {
      const walletBtn = screen.getByTestId('pos-split-method-wallet');
      expect(walletBtn).toBeDisabled();
    });
    // Hint label still rendered.
    expect(screen.getByTestId('pos-split-wallet-balance-hint')).toBeInTheDocument();
  });
});

// ── Wallet insufficient-balance warning surface (#789 follow-up) ──────
describe('<PointOfSale /> — wallet insufficient-balance warning', () => {
  beforeEach(() => {
    fetchApiMock.mockReset();
    notifyError.mockReset();
    notifySuccess.mockReset();
    notifyInfo.mockReset();
  });

  it('shows the "Insufficient wallet balance" copy when wallet < grand total', async () => {
    fetchApiMock.mockImplementation((url) => {
      if (url === '/api/pos/registers?isActive=true') return Promise.resolve(REGISTERS);
      if (url === '/api/pos/shifts/current') return Promise.resolve(OPEN_SHIFT);
      if (url === '/api/wellness/patients/42/wallet') {
        return Promise.resolve({
          patient: { id: 42, name: 'Asha' },
          wallet: { id: 9, balance: 100 },
          transactions: [],
        });
      }
      return Promise.resolve([]);
    });

    renderPos();
    await waitFor(() => expect(screen.getByText(/Shift open/i)).toBeInTheDocument());

    // Big-ticket basket line so grand total > wallet balance.
    await addLine({ refId: 1, name: 'Procedure', quantity: 1, unitPrice: 5000 });
    await waitFor(() => expect(screen.getByText('Procedure')).toBeInTheDocument());

    fireEvent.change(controlForLabel(/Patient ID/i), { target: { value: '42' } });
    fireEvent.change(screen.getByLabelText(/Payment method/i), { target: { value: 'WALLET' } });

    // Wallet balance loaded (100) but grand total is 5,000 — warning rendered.
    await waitFor(() => {
      const balance = screen.getByTestId('wallet-balance');
      expect(balance.textContent).toMatch(/100/);
    });
    await waitFor(() => {
      expect(
        screen.getByText(/Insufficient wallet balance for this sale/i),
      ).toBeInTheDocument();
    });
  });
});
