/**
 * Drugs.test.jsx — vitest + RTL coverage for the wellness-vertical drug
 * catalogue admin page (frontend/src/pages/wellness/Drugs.jsx).
 *
 * Scope: pins the page-surface invariants for the prescription-writer's
 * typeahead-master CRUD — heading + count sub-copy + CTA, loading state,
 * GET on mount, empty-state, drug-row render (name + generic + form +
 * strength + default-dosage + active status), search-then-Enter triggers
 * a re-fetch with `?q=` param, New-drug form open/close + CTA-label flip,
 * create POST shape (including dosageForm select default + isActive bool),
 * native-confirm delete flow (true + false branches), and edit-prefill
 * → PUT.
 *
 * Test cases (10):
 *   1. Heading "Drug catalogue" + Pill icon + "New drug" CTA + count sub-copy
 *      ("N drug(s) — used by the prescription writer's typeahead.") render.
 *   2. Loading state: "Loading catalogue…" renders while initial GET is
 *      in-flight (per CLAUDE.md tick #108 cron-learning — pin actual literal).
 *   3. GET /api/wellness/drugs fires on mount; rendered rows match payload.
 *   4. Empty-state copy "No drugs match." renders when GET resolves to [].
 *   5. Drug row renders name + generic + dosageForm + strength (value + unit
 *      joined) + defaultDosage + Active/Inactive status.
 *   6. Search input + Enter-keydown triggers GET with `?q=<term>` URL.
 *   7. Clicking "New drug" opens the form (name placeholder visible); CTA
 *      label flips to "Cancel"; clicking again resets + re-shows "New drug".
 *   8. Submitting Create POSTs /api/wellness/drugs with body shape
 *      {name, dosageForm, isActive, …} + notify.success + re-fetches list.
 *   9. Clicking row's Edit (Pencil, title="Edit") opens the form pre-filled
 *      with name + genericName + dosageForm + strengthValue; Save → PUT
 *      /api/wellness/drugs/:id + notify.success.
 *  10. Delete flow: confirm()=true fires DELETE + notify.success;
 *      confirm()=false aborts (no DELETE).
 *
 * Mocking discipline (per CLAUDE.md RTL standing rules):
 *   - fetchApi mocked at `../utils/api` (relative to flat __tests__/) with a
 *     stable mock fn.
 *   - notifyObj is STABLE module-level (Wave 11 cfb5789 / Wave 12 f59e91d
 *     standing rule — fresh-per-call objects flap dep identity and infinite-
 *     re-render-hang the test).
 *   - SUT does NOT consume AuthContext (no useAuth import) → no Provider
 *     wrapper. MemoryRouter is defensive in case any lazy descendant pulls
 *     in a Link/useNavigate.
 *   - window.confirm spied per-test via vi.spyOn (matches Vendors /
 *     ServiceCategories / Coupons pattern).
 *
 * Drift pinned (prompt vs. actual SUT):
 *   - Prompt anticipated "GST-rate / HSN-code fields + Schedule H/X badges +
 *     manufacturer column + prescription-eligibility flag". REALITY: SUT has
 *     NONE of those. EMPTY_FORM (SUT line 16) is only name, genericName,
 *     dosageForm, strengthValue, strengthUnit, defaultDosage, defaultFrequency,
 *     defaultDuration, notes, isActive. No GST, no HSN, no Schedule H/X, no
 *     manufacturer, no rxOnly bool. The table columns (SUT lines 147-153) are
 *     Name / Generic / Form / Strength / Default-dosage / Status — NOT
 *     manufacturer or class. Omitted those cases. Drug regulation metadata
 *     (Schedule H/X / Rx-only) is *intentionally not modelled* per the SUT
 *     header comment "sensible defaults the doctor's UI can pre-fill from" —
 *     it's a typeahead-master, not a regulatory ledger.
 *   - Prompt anticipated "RBAC: USER hides mutation CTAs if SUT enforces".
 *     CONFIRMED backend-only: SUT does NOT consume AuthContext at all (no
 *     useAuth / useContext); every authenticated client sees the New-drug
 *     CTA + row Edit/Delete buttons. Header comment notes "Manager+ gated
 *     via App.jsx's RoleGuard wrapper" — outer route guard, not in-page.
 *     Omitted in-page RBAC tests (covered by App.jsx RoleGuard tests + route
 *     api spec).
 *   - Prompt anticipated "validation: empty name rejected". REALITY: SUT
 *     relies on the browser-native `required` attribute on the name input
 *     (SUT line 118). The actual blocking happens in the browser's form-
 *     submit handler before React's onSubmit fires — no JS validation
 *     function to call. Not pinned via a discrete case (form-open coverage
 *     in case 7 implicitly shows the required field renders) — too thin to
 *     spend a case on.
 *   - Prompt anticipated "Loading…" verbatim. REALITY: SUT renders "Loading
 *     catalogue…" (SUT line 140). Pin via the actual literal.
 *   - Prompt anticipated "confirmation + DELETE". CONFIRMED — uses bare
 *     `confirm()` (window.confirm) at SUT line 80. Dialog message is
 *     `Delete "${drug.name}" from the catalogue?` — pinned in case 10.
 *   - Prompt anticipated "500 → silent degrade or notify.error". CONFIRMED
 *     silent-degrade: SUT line 38's `.catch(() => setDrugs([]))` swallows
 *     errors silently, falls through to empty-state. The notify.error path
 *     is fetchApi-internal (it toasts the server message inside the helper).
 *     Omitted error-branch case — silent-degrade behaviour is identical to
 *     empty-state (case 4).
 *   - Search behaviour: SUT line 110 fires `load(search)` ONLY on Enter
 *     keydown OR clicking the Search button; onChange just updates local
 *     state. Pinned via Enter keydown (case 6); the URL gets `?q=<encoded>`
 *     appended (SUT line 35).
 *   - Backend endpoint confirmed at /api/wellness/drugs per SUT lines 35, 67,
 *     70, 82.
 *
 * Path: flat __tests__/Drugs.test.jsx — matches sibling Vendors /
 * ServiceCategories / ProductCategories flat-path convention.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

const fetchApiMock = vi.fn();
vi.mock('../utils/api', () => ({
  fetchApi: (...args) => fetchApiMock(...args),
  getAuthToken: () => 'test-token',
}));

// Stable notify object — RTL standing rule (Wave 11 cfb5789, Wave 12 f59e91d).
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

import Drugs from '../pages/wellness/Drugs';

const CROCIN = {
  id: 901,
  name: 'Crocin 500',
  genericName: 'Acetaminophen',
  dosageForm: 'tablet',
  strengthValue: '500',
  strengthUnit: 'mg',
  defaultDosage: '1 tablet',
  defaultFrequency: 'twice daily',
  defaultDuration: '5 days',
  notes: '',
  isActive: true,
};
const COMBIFLAM = {
  id: 902,
  name: 'Combiflam',
  genericName: 'Ibuprofen + Paracetamol',
  dosageForm: 'tablet',
  strengthValue: '400',
  strengthUnit: 'mg',
  defaultDosage: '1 tablet',
  defaultFrequency: 'as needed',
  defaultDuration: '3 days',
  notes: '',
  isActive: true,
};
const LEGACY_SYRUP = {
  id: 903,
  name: 'Legacy Cough Syrup',
  genericName: '',
  dosageForm: 'syrup',
  strengthValue: '',
  strengthUnit: '',
  defaultDosage: '',
  defaultFrequency: '',
  defaultDuration: '',
  notes: '',
  isActive: false,
};

function installFetchMock({
  drugs = [CROCIN, COMBIFLAM, LEGACY_SYRUP],
  drugsPromise = null,
} = {}) {
  fetchApiMock.mockImplementation((url, opts) => {
    const method = opts?.method || 'GET';
    if (/^\/api\/wellness\/drugs(\?q=.*)?$/.test(url) && method === 'GET') {
      if (drugsPromise) return drugsPromise;
      return Promise.resolve(drugs);
    }
    if (/^\/api\/wellness\/drugs(\/\d+)?$/.test(url)) {
      // POST / PUT / DELETE — resolve so submit / delete paths complete.
      return Promise.resolve({ ok: true });
    }
    return Promise.resolve({});
  });
}

function renderPage() {
  return render(
    <MemoryRouter>
      <Drugs />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  fetchApiMock.mockReset();
  notifyError.mockReset();
  notifySuccess.mockReset();
  notifyInfo.mockReset();
  notifyConfirm.mockReset();
  notifyConfirm.mockImplementation(() => Promise.resolve(true));
});

describe('<Drugs /> — page chrome', () => {
  it('renders heading "Drug catalogue" + "New drug" CTA + count sub-copy', async () => {
    installFetchMock();
    renderPage();
    expect(
      screen.getByRole('heading', { name: /Drug catalogue/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /New drug/i }),
    ).toBeInTheDocument();
    // Sub-copy mentions "drug(s) — used by the prescription writer's typeahead".
    await waitFor(() => {
      expect(
        screen.getAllByText((_t, el) =>
          /\d+ drugs?.*prescription writer.*typeahead/i.test(
            el?.textContent || '',
          ),
        ).length,
      ).toBeGreaterThanOrEqual(1);
    });
  });

  it('renders "Loading catalogue…" while the initial GET is in flight', async () => {
    // Block the fetch indefinitely to pin the loading branch.
    installFetchMock({ drugsPromise: new Promise(() => {}) });
    renderPage();
    expect(
      await screen.findByText(/^Loading catalogue…$/),
    ).toBeInTheDocument();
  });
});

describe('<Drugs /> — mount fetch + list render', () => {
  it('fires GET /api/wellness/drugs on mount and renders rows', async () => {
    installFetchMock();
    renderPage();
    await waitFor(() => {
      expect(fetchApiMock).toHaveBeenCalledWith('/api/wellness/drugs');
    });
    expect(await screen.findByText('Crocin 500')).toBeInTheDocument();
    expect(screen.getByText('Combiflam')).toBeInTheDocument();
    expect(screen.getByText('Legacy Cough Syrup')).toBeInTheDocument();
  });

  it('renders the empty-state copy when GET resolves to []', async () => {
    installFetchMock({ drugs: [] });
    renderPage();
    expect(
      await screen.findByText(/^No drugs match\.$/),
    ).toBeInTheDocument();
  });

  it('renders row columns: name + generic + form + strength + default-dosage + status', async () => {
    installFetchMock();
    renderPage();
    await waitFor(() => {
      expect(screen.getByText('Crocin 500')).toBeInTheDocument();
    });
    // Generic name renders.
    expect(screen.getByText('Acetaminophen')).toBeInTheDocument();
    expect(screen.getByText('Ibuprofen + Paracetamol')).toBeInTheDocument();
    // Generic em-dash for the LEGACY_SYRUP (no generic name).
    expect(screen.getAllByText('—').length).toBeGreaterThanOrEqual(1);
    // Strength joined "500 mg" / "400 mg".
    expect(screen.getByText('500 mg')).toBeInTheDocument();
    expect(screen.getByText('400 mg')).toBeInTheDocument();
    // Dosage form renders for syrup (Legacy is the only syrup).
    expect(screen.getByText('syrup')).toBeInTheDocument();
    // Status — there are 2 Active rows and 1 Inactive.
    expect(screen.getAllByText(/^Active$/).length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText(/^Inactive$/)).toBeInTheDocument();
  });
});

describe('<Drugs /> — search re-fetch', () => {
  it('Enter-keydown in search input fires GET with ?q=<encoded> URL', async () => {
    installFetchMock();
    renderPage();
    await waitFor(() => {
      expect(screen.getByText('Crocin 500')).toBeInTheDocument();
    });
    const searchInput = screen.getByPlaceholderText(
      /Search by name or generic name/i,
    );
    fireEvent.change(searchInput, { target: { value: 'paracetamol' } });
    fireEvent.keyDown(searchInput, { key: 'Enter' });
    await waitFor(() => {
      const searchCall = fetchApiMock.mock.calls.find(
        ([u]) => u === '/api/wellness/drugs?q=paracetamol',
      );
      expect(searchCall).toBeTruthy();
    });
  });
});

describe('<Drugs /> — New-drug form toggle', () => {
  it('"New drug" opens the form (label flips to "Cancel"); click again closes it', async () => {
    installFetchMock();
    renderPage();
    await waitFor(() => {
      expect(screen.getByText('Crocin 500')).toBeInTheDocument();
    });
    fireEvent.click(screen.getByRole('button', { name: /New drug/i }));
    expect(
      screen.getByPlaceholderText(/Brand \/ trade name/i),
    ).toBeInTheDocument();
    // "Generic name (e.g. Acetaminophen)" — disambiguate from search input
    // placeholder "Search by name or generic name…".
    expect(
      screen.getByPlaceholderText(/^Generic name \(e\.g\. Acetaminophen\)$/),
    ).toBeInTheDocument();
    // CTA label flipped.
    expect(
      screen.getByRole('button', { name: /^Cancel$/ }),
    ).toBeInTheDocument();
    // Click Cancel → form closes.
    fireEvent.click(screen.getByRole('button', { name: /^Cancel$/ }));
    expect(
      screen.queryByPlaceholderText(/Brand \/ trade name/i),
    ).toBeNull();
    expect(
      screen.getByRole('button', { name: /New drug/i }),
    ).toBeInTheDocument();
  });
});

describe('<Drugs /> — create POST', () => {
  it('Create → POST /api/wellness/drugs with body shape + notify.success + refetch', async () => {
    installFetchMock();
    renderPage();
    await waitFor(() => {
      expect(screen.getByText('Crocin 500')).toBeInTheDocument();
    });
    fireEvent.click(screen.getByRole('button', { name: /New drug/i }));
    fireEvent.change(
      screen.getByPlaceholderText(/Brand \/ trade name/i),
      { target: { value: 'Dolo 650' } },
    );
    fireEvent.change(
      screen.getByPlaceholderText(/^Generic name \(e\.g\. Acetaminophen\)$/),
      { target: { value: 'Paracetamol' } },
    );
    fireEvent.change(
      screen.getByPlaceholderText(/Strength value/i),
      { target: { value: '650' } },
    );
    fireEvent.change(
      screen.getByPlaceholderText(/Strength unit/i),
      { target: { value: 'mg' } },
    );

    fireEvent.click(screen.getByRole('button', { name: /Add drug/i }));

    await waitFor(() => {
      const postCall = fetchApiMock.mock.calls.find(
        ([u, opts]) =>
          u === '/api/wellness/drugs' && opts?.method === 'POST',
      );
      expect(postCall).toBeTruthy();
      const body = JSON.parse(postCall[1].body);
      expect(body).toMatchObject({
        name: 'Dolo 650',
        genericName: 'Paracetamol',
        dosageForm: 'tablet', // default
        strengthValue: '650',
        strengthUnit: 'mg',
        isActive: true,
      });
    });
    expect(notifySuccess).toHaveBeenCalledWith(
      expect.stringMatching(/Created.*Dolo 650/i),
    );
    // After create, list refetches → at least 2 GETs total.
    const getCalls = fetchApiMock.mock.calls.filter(
      ([u, opts]) =>
        /^\/api\/wellness\/drugs(\?q=.*)?$/.test(u) &&
        (opts?.method || 'GET') === 'GET',
    );
    expect(getCalls.length).toBeGreaterThanOrEqual(2);
  });
});

describe('<Drugs /> — edit prefill + PUT', () => {
  it('Edit (Pencil) opens the form pre-filled and Save → PUT /api/wellness/drugs/:id', async () => {
    installFetchMock();
    renderPage();
    await waitFor(() => {
      expect(screen.getByText('Crocin 500')).toBeInTheDocument();
    });
    // Edit buttons have title="Edit"; multiple rows → pick the first (Crocin).
    const editButtons = screen.getAllByTitle('Edit');
    expect(editButtons.length).toBeGreaterThanOrEqual(3);
    fireEvent.click(editButtons[0]);

    // Pre-fill: name + generic + strength values.
    const nameInput = screen.getByPlaceholderText(/Brand \/ trade name/i);
    expect(nameInput.value).toBe('Crocin 500');
    expect(
      screen.getByPlaceholderText(/^Generic name \(e\.g\. Acetaminophen\)$/).value,
    ).toBe('Acetaminophen');
    expect(
      screen.getByPlaceholderText(/Strength value/i).value,
    ).toBe('500');

    // Tweak name + submit.
    fireEvent.change(nameInput, {
      target: { value: 'Crocin 500 (renamed)' },
    });
    fireEvent.click(screen.getByRole('button', { name: /Save changes/i }));
    await waitFor(() => {
      const putCall = fetchApiMock.mock.calls.find(
        ([u, opts]) =>
          u === '/api/wellness/drugs/901' && opts?.method === 'PUT',
      );
      expect(putCall).toBeTruthy();
      const body = JSON.parse(putCall[1].body);
      expect(body.name).toBe('Crocin 500 (renamed)');
      expect(body.isActive).toBe(true);
    });
    expect(notifySuccess).toHaveBeenCalledWith(
      expect.stringMatching(/Updated.*Crocin 500 \(renamed\)/i),
    );
  });
});

describe('<Drugs /> — delete (notify.confirm)', () => {
  // SUT drift: delete uses notify.confirm({...}) (async), not window.confirm.
  it('notify.confirm()=true → DELETE /api/wellness/drugs/:id + notify.success', async () => {
    installFetchMock();
    notifyConfirm.mockImplementation(() => Promise.resolve(true));
    renderPage();
    await waitFor(() => {
      expect(screen.getByText('Crocin 500')).toBeInTheDocument();
    });
    const deleteButtons = screen.getAllByTitle('Delete');
    expect(deleteButtons.length).toBeGreaterThanOrEqual(3);
    fireEvent.click(deleteButtons[0]);

    expect(notifyConfirm).toHaveBeenCalledWith(
      expect.objectContaining({
        message: expect.stringMatching(/Delete "Crocin 500" from the catalogue\?/),
      }),
    );
    await waitFor(() => {
      const delCall = fetchApiMock.mock.calls.find(
        ([u, opts]) =>
          u === '/api/wellness/drugs/901' && opts?.method === 'DELETE',
      );
      expect(delCall).toBeTruthy();
    });
    expect(notifySuccess).toHaveBeenCalledWith(
      expect.stringMatching(/Deleted.*Crocin 500/i),
    );
  });

  it('notify.confirm()=false → no DELETE fired + no notify.success', async () => {
    installFetchMock();
    notifyConfirm.mockImplementation(() => Promise.resolve(false));
    renderPage();
    await waitFor(() => {
      expect(screen.getByText('Crocin 500')).toBeInTheDocument();
    });
    const deleteButtons = screen.getAllByTitle('Delete');
    fireEvent.click(deleteButtons[0]);
    expect(notifyConfirm).toHaveBeenCalled();
    // Microtask wait — make sure no async DELETE sneaks through.
    await Promise.resolve();
    await Promise.resolve();
    const delCall = fetchApiMock.mock.calls.find(
      ([, opts]) => opts?.method === 'DELETE',
    );
    expect(delCall).toBeUndefined();
    expect(notifySuccess).not.toHaveBeenCalled();
  });
});
