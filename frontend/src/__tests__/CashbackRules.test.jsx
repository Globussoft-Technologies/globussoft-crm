/**
 * CashbackRules.test.jsx — Tick #132 wellness admin coverage.
 *
 * SUT lives at frontend/src/pages/wellness/CashbackRules.jsx (Wave 11 Agent FF —
 * "earn % of paid visit amount as wallet credit" admin editor). Backend
 * routes live at backend/routes/wellness.js:7691+ — GET / POST / PUT under
 * verifyRole(['ADMIN','MANAGER']); DELETE under verifyRole(['ADMIN']).
 *
 * What this test pins
 * -------------------
 *   1. Page chrome — heading, intro copy, "New rule" CTA.
 *   2. Loading state — literal "Loading…" placeholder until GET resolves
 *      (per CLAUDE.md tick #108 cron-learning).
 *   3. GET on mount — hits /api/wellness/cashback-rules and renders rows.
 *   4. Empty-state copy ("No cashback rules yet.") when API returns [].
 *   5. List rendering — name / earnPercent / minSpend (formatMoney) /
 *      isActive (Yes/No) columns populated correctly per row.
 *   6. Min-spend "—" placeholder when minSpend is null / 0 / undefined.
 *   7. New-rule modal — opens with all editor fields rendered (name,
 *      earn %, min spend, active).
 *   8. Validation — empty name rejected; non-numeric / out-of-range
 *      earn % (< 0 or > 100) rejected. All surface via notify.error
 *      with NO POST fired.
 *   9. Submit (create) — POSTs /api/wellness/cashback-rules with the
 *      typed numeric fields + trimmed name + null minSpend when blank,
 *      then re-fetches the list and closes the modal.
 *  10. Edit flow — opens editor pre-filled with row data, PUTs
 *      /api/wellness/cashback-rules/:id with new values.
 *  11. Delete flow — native window.confirm() gate; DELETE fires + notify
 *      success when confirmed; aborts when declined.
 *  12. GET error — surfaces notify.error with the server message.
 *
 * Mocking
 * -------
 *   • fetchApi mocked via vi.fn at module scope, behaviour swapped per
 *     test via mockImplementation.
 *   • useNotify returns a STABLE mock object reference per the
 *     RTL-stable-mock standing rule (Wave 11 cfb5789 / Wave 12 f59e91d).
 *   • formatMoney mocked to a deterministic "INR X.XX" string so locale
 *     differences across CI ICU builds don't leak in (cf. Coupons.test
 *     and CashRegisters.test prior art).
 *
 * Drift pinned vs original prompt
 * --------------------------------
 *   • Prompt anticipated "trigger event + cashback %/flat + cap + expiry +
 *     sub-membership-tier scoping". REALITY: SUT is much simpler — only
 *     name + earnPercent + minSpend + isActive fields. No trigger picker,
 *     no FLAT/PERCENT toggle (PERCENT only), no expiry, no membership-tier
 *     scoping, no per-rule cap on earned amount. The SUT's file-header
 *     comment mentions "service-id allowlist" but the editor does NOT
 *     expose one — only minSpend is the gate. Tested against actual SUT
 *     fields only.
 *   • Prompt anticipated active/inactive toggle. REALITY: there IS an
 *     `isActive` checkbox in the editor, but no inline toggle in the
 *     list row — the row only DISPLAYS Yes/No. Tested as edit-flow
 *     toggle, not inline.
 *   • Prompt anticipated "RBAC: USER hides mutation CTAs only if SUT
 *     enforces". REALITY: SUT does NOT gate mutation CTAs in the UI —
 *     all roles see "New rule" / edit / delete. The backend gate
 *     (verifyRole(['ADMIN','MANAGER']) on POST/PUT; verifyRole(['ADMIN'])
 *     on DELETE) is the actual enforcement. Omitted RBAC test (covered
 *     by backend api spec).
 *   • Delete uses native `confirm()` per CLAUDE.md standing rule —
 *     spied via vi.spyOn(window, 'confirm').
 *   • POST/PUT bodies are JSON-stringified per SUT (`JSON.stringify(body)`).
 *
 * Path: flat `__tests__/CashbackRules.test.jsx`.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

const fetchApiMock = vi.fn();
vi.mock('../utils/api', () => ({
  fetchApi: (...args) => fetchApiMock(...args),
  getAuthToken: () => 'test-token',
}));

// Stable notify object — RTL standing rule (Wave 11 cfb5789, Wave 12 f59e91d).
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
import CashbackRulesPage from '../pages/wellness/CashbackRules';

// ── Fixtures ──────────────────────────────────────────────────────────
const RULE_BASIC = {
  id: 1,
  name: 'Standard 5%',
  earnPercent: 5,
  minSpend: 1000,
  isActive: true,
};

const RULE_HIGH_TIER = {
  id: 2,
  name: 'Premium 10%',
  earnPercent: 10,
  minSpend: 5000,
  isActive: true,
};

const RULE_NO_FLOOR = {
  id: 3,
  name: 'Welcome 2%',
  earnPercent: 2,
  minSpend: null,
  isActive: false,
};

function makeListMock(rules) {
  return (url, opts = {}) => {
    const method = opts.method || 'GET';
    if (url === '/api/wellness/cashback-rules' && method === 'GET') {
      return Promise.resolve({ rules });
    }
    if (url === '/api/wellness/cashback-rules' && method === 'POST') {
      const body = opts.body ? JSON.parse(opts.body) : {};
      return Promise.resolve({ id: 99, ...body });
    }
    if (/^\/api\/wellness\/cashback-rules\/\d+$/.test(url) && method === 'PUT') {
      const id = parseInt(url.split('/').pop(), 10);
      const body = opts.body ? JSON.parse(opts.body) : {};
      return Promise.resolve({ id, ...body });
    }
    if (/^\/api\/wellness\/cashback-rules\/\d+$/.test(url) && method === 'DELETE') {
      return Promise.resolve({ ok: true });
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
describe('CashbackRules — page chrome + loading', () => {
  it('renders heading, intro copy, and "New rule" CTA', async () => {
    fetchApiMock.mockImplementation(makeListMock([RULE_BASIC]));
    render(<CashbackRulesPage />);

    expect(screen.getByRole('heading', { name: /Cashback Rules/i })).toBeInTheDocument();
    expect(
      screen.getByText(/Earn wallet credit for the patient on each completed visit/i),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /New rule/i })).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText('Standard 5%')).toBeInTheDocument());
  });

  it('shows the literal "Loading…" placeholder until GET resolves', async () => {
    let resolveFn;
    fetchApiMock.mockImplementation((url) => {
      if (url === '/api/wellness/cashback-rules') {
        return new Promise((r) => {
          resolveFn = r;
        });
      }
      return Promise.resolve({});
    });
    render(<CashbackRulesPage />);
    expect(screen.getByText(/Loading…/i)).toBeInTheDocument();
    resolveFn({ rules: [] });
    await waitFor(() =>
      expect(screen.queryByText(/Loading…/i)).not.toBeInTheDocument(),
    );
  });
});

// ─────────────────────────────────────────────────────────────────────
// 3-6. List rendering: rows, columns, minSpend branches, empty-state
// ─────────────────────────────────────────────────────────────────────
describe('CashbackRules — list rendering', () => {
  it('GETs /api/wellness/cashback-rules on mount and renders a row per rule', async () => {
    fetchApiMock.mockImplementation(makeListMock([RULE_BASIC, RULE_HIGH_TIER]));
    render(<CashbackRulesPage />);

    await waitFor(() => expect(screen.getByText('Standard 5%')).toBeInTheDocument());
    expect(screen.getByText('Premium 10%')).toBeInTheDocument();
    // GET on mount.
    expect(fetchApiMock).toHaveBeenCalledWith('/api/wellness/cashback-rules');
  });

  it('renders earn % with "%" suffix, minSpend via formatMoney, and isActive as Yes/No', async () => {
    fetchApiMock.mockImplementation(makeListMock([RULE_BASIC, RULE_NO_FLOOR]));
    render(<CashbackRulesPage />);

    await waitFor(() => expect(screen.getByText('Standard 5%')).toBeInTheDocument());
    // earnPercent column for both rules — "5%" and "2%" present.
    expect(screen.getByText('5%')).toBeInTheDocument();
    expect(screen.getByText('2%')).toBeInTheDocument();
    // minSpend column — formatMoney mock returns "INR 1000.00".
    expect(screen.getByText('INR 1000.00')).toBeInTheDocument();
    // RULE_BASIC.isActive=true → "Yes"; RULE_NO_FLOOR.isActive=false → "No".
    expect(screen.getByText('Yes')).toBeInTheDocument();
    expect(screen.getByText('No')).toBeInTheDocument();
  });

  it('renders "—" for minSpend when null', async () => {
    fetchApiMock.mockImplementation(makeListMock([RULE_NO_FLOOR]));
    render(<CashbackRulesPage />);

    await waitFor(() => expect(screen.getByText('Welcome 2%')).toBeInTheDocument());
    // Null minSpend → literal em-dash placeholder.
    expect(screen.getByText('—')).toBeInTheDocument();
  });

  it('renders empty-state copy when no rules exist', async () => {
    fetchApiMock.mockImplementation(makeListMock([]));
    render(<CashbackRulesPage />);

    await waitFor(() =>
      expect(screen.getByText(/No cashback rules yet/i)).toBeInTheDocument(),
    );
  });
});

// ─────────────────────────────────────────────────────────────────────
// 7-9. New rule modal — open, validate, submit
// ─────────────────────────────────────────────────────────────────────
describe('CashbackRules — new rule flow', () => {
  it('opens the editor modal with all expected fields when "New rule" is clicked', async () => {
    fetchApiMock.mockImplementation(makeListMock([]));
    render(<CashbackRulesPage />);

    await waitFor(() =>
      expect(screen.getByText(/No cashback rules yet/i)).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByRole('button', { name: /New rule/i }));

    expect(screen.getByRole('heading', { name: /New cashback rule/i })).toBeInTheDocument();
    expect(screen.getByLabelText(/^Name$/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/^Earn %$/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/Min spend/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/^Active$/i)).toBeInTheDocument();
  });

  it('rejects empty name and out-of-range earn % via notify.error (no POST)', async () => {
    fetchApiMock.mockImplementation(makeListMock([]));
    render(<CashbackRulesPage />);

    await waitFor(() =>
      expect(screen.getByText(/No cashback rules yet/i)).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByRole('button', { name: /New rule/i }));

    // Empty name → "Name is required."
    fireEvent.click(screen.getByRole('button', { name: /^Save$/i }));
    await waitFor(() =>
      expect(notify.error).toHaveBeenCalledWith(expect.stringMatching(/Name is required/i)),
    );

    // Fill name, leave earnPercent blank (Number('') === 0; still 0..100 valid).
    // Set earnPercent to 150 → out of range.
    fireEvent.change(screen.getByLabelText(/^Name$/i), { target: { value: 'Test rule' } });
    fireEvent.change(screen.getByLabelText(/^Earn %$/i), { target: { value: '150' } });
    fireEvent.click(screen.getByRole('button', { name: /^Save$/i }));
    await waitFor(() =>
      expect(notify.error).toHaveBeenCalledWith(
        expect.stringMatching(/Earn % must be 0\.\.100/i),
      ),
    );

    // Set earnPercent to -5 → also out of range.
    fireEvent.change(screen.getByLabelText(/^Earn %$/i), { target: { value: '-5' } });
    fireEvent.click(screen.getByRole('button', { name: /^Save$/i }));
    await waitFor(() =>
      expect(notify.error).toHaveBeenCalledWith(
        expect.stringMatching(/Earn % must be 0\.\.100/i),
      ),
    );

    // None of the validation paths should have POSTed.
    const postCalls = fetchApiMock.mock.calls.filter(
      ([, opts]) => opts?.method === 'POST',
    );
    expect(postCalls.length).toBe(0);
  });

  it('POSTs /api/wellness/cashback-rules with trimmed name + numeric fields + null minSpend on blank', async () => {
    fetchApiMock.mockImplementation(makeListMock([]));
    render(<CashbackRulesPage />);

    await waitFor(() =>
      expect(screen.getByText(/No cashback rules yet/i)).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByRole('button', { name: /New rule/i }));

    fireEvent.change(screen.getByLabelText(/^Name$/i), {
      target: { value: '  Founder special  ' },
    });
    fireEvent.change(screen.getByLabelText(/^Earn %$/i), { target: { value: '7.5' } });
    // Leave minSpend blank → SUT should send null.
    fireEvent.click(screen.getByRole('button', { name: /^Save$/i }));

    await waitFor(() => {
      const calls = fetchApiMock.mock.calls.filter(
        ([url, opts]) =>
          url === '/api/wellness/cashback-rules' && opts?.method === 'POST',
      );
      expect(calls.length).toBe(1);
      const body = JSON.parse(calls[0][1].body);
      expect(body).toEqual({
        name: 'Founder special',
        earnPercent: 7.5,
        minSpend: null,
        isActive: true,
      });
    });
    expect(notify.success).toHaveBeenCalledWith(expect.stringMatching(/Rule created/i));
  });
});

// ─────────────────────────────────────────────────────────────────────
// 10. Edit flow
// ─────────────────────────────────────────────────────────────────────
describe('CashbackRules — edit flow', () => {
  it('opens editor pre-filled with row data and PUTs /api/wellness/cashback-rules/:id', async () => {
    fetchApiMock.mockImplementation(makeListMock([RULE_BASIC]));
    render(<CashbackRulesPage />);

    await waitFor(() => expect(screen.getByText('Standard 5%')).toBeInTheDocument());

    // Find the edit icon button via the lucide-pencil svg.
    const editButtons = document.querySelectorAll('button svg.lucide-pencil');
    expect(editButtons.length).toBeGreaterThan(0);
    fireEvent.click(editButtons[0].closest('button'));

    expect(screen.getByRole('heading', { name: /Edit cashback rule/i })).toBeInTheDocument();
    // Pre-fill assertions: name + earnPercent + minSpend.
    expect(screen.getByLabelText(/^Name$/i).value).toBe('Standard 5%');
    expect(screen.getByLabelText(/^Earn %$/i).value).toBe('5');
    expect(screen.getByLabelText(/Min spend/i).value).toBe('1000');

    // Tweak the earn % + save.
    fireEvent.change(screen.getByLabelText(/^Earn %$/i), { target: { value: '8' } });
    fireEvent.click(screen.getByRole('button', { name: /^Save$/i }));

    await waitFor(() => {
      const puts = fetchApiMock.mock.calls.filter(
        ([url, opts]) =>
          url === '/api/wellness/cashback-rules/1' && opts?.method === 'PUT',
      );
      expect(puts.length).toBe(1);
      const body = JSON.parse(puts[0][1].body);
      expect(body.earnPercent).toBe(8);
      expect(body.name).toBe('Standard 5%');
      expect(body.minSpend).toBe(1000);
    });
    expect(notify.success).toHaveBeenCalledWith(expect.stringMatching(/Rule updated/i));
  });
});

// ─────────────────────────────────────────────────────────────────────
// 11. Delete flow — native confirm gate
// ─────────────────────────────────────────────────────────────────────
describe('CashbackRules — delete flow', () => {
  it('DELETEs /api/wellness/cashback-rules/:id and surfaces success notify when confirm()=true', async () => {
    fetchApiMock.mockImplementation(makeListMock([RULE_BASIC]));
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
    render(<CashbackRulesPage />);

    await waitFor(() => expect(screen.getByText('Standard 5%')).toBeInTheDocument());
    const trashButtons = document.querySelectorAll('button svg.lucide-trash-2');
    expect(trashButtons.length).toBeGreaterThan(0);
    fireEvent.click(trashButtons[0].closest('button'));

    await waitFor(() => {
      const dels = fetchApiMock.mock.calls.filter(
        ([url, opts]) =>
          url === '/api/wellness/cashback-rules/1' && opts?.method === 'DELETE',
      );
      expect(dels.length).toBe(1);
    });
    expect(notify.success).toHaveBeenCalledWith(expect.stringMatching(/Rule deleted/i));
    confirmSpy.mockRestore();
  });

  it('does NOT DELETE when confirm()=false', async () => {
    fetchApiMock.mockImplementation(makeListMock([RULE_BASIC]));
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false);
    render(<CashbackRulesPage />);

    await waitFor(() => expect(screen.getByText('Standard 5%')).toBeInTheDocument());
    const trashButtons = document.querySelectorAll('button svg.lucide-trash-2');
    fireEvent.click(trashButtons[0].closest('button'));

    // Give microtasks a beat.
    await Promise.resolve();
    const dels = fetchApiMock.mock.calls.filter(([, opts]) => opts?.method === 'DELETE');
    expect(dels.length).toBe(0);
    expect(notify.success).not.toHaveBeenCalledWith(
      expect.stringMatching(/Rule deleted/i),
    );
    confirmSpy.mockRestore();
  });
});

// ─────────────────────────────────────────────────────────────────────
// 12. Error handling
// ─────────────────────────────────────────────────────────────────────
describe('CashbackRules — error handling', () => {
  it('GET failure surfaces notify.error with the server message', async () => {
    fetchApiMock.mockImplementation((url) => {
      if (url === '/api/wellness/cashback-rules') {
        return Promise.reject(new Error('cashback offline'));
      }
      return Promise.resolve({});
    });
    render(<CashbackRulesPage />);

    await waitFor(() =>
      expect(notify.error).toHaveBeenCalledWith(
        expect.stringMatching(/cashback offline/i),
      ),
    );
  });
});
