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
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import PointOfSale from '../pages/wellness/PointOfSale';

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
