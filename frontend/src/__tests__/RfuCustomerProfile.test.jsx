/**
 * RfuCustomerProfile.jsx — page-level coverage (PRD §4.5 RFU customer profile).
 *
 * Lives at /travel/rfu/customers/:contactId. Reads from
 *   GET  /api/contacts/:id
 *   GET  /api/travel/rfu-profiles/by-contact/:contactId
 * Writes via POST /api/travel/rfu-profiles (create) or
 * PATCH /api/travel/rfu-profiles/:id (update).
 *
 * This spec COMPLEMENTS RfuCustomerProfile.dupModal.test.jsx — that
 * sibling pins the 409 DUPLICATE_PASSPORT modal flow exclusively. We
 * deliberately do NOT re-cover the dup-modal scope; every case here
 * exercises page chrome / fetch / read-view / edit-view / lifecycle.
 *
 * Drift pinned vs the tick #123 prompt:
 *   - "Customer not found" framing — the SUT does NOT render that
 *     copy. Instead the loading state renders "Loading…" via &hellip;,
 *     and an unresolved contact gracefully degrades to "Contact #<id>"
 *     using the cid number (see SUT line 197). The 404-on-profile path
 *     surfaces an "No RFU profile yet" empty-state with a "Create
 *     profile" CTA (SUT lines 209-214). The invalid-cid (NaN from a
 *     non-numeric route param) branch renders "Invalid contact id in
 *     URL." (SUT line 179).
 *   - "RFU teal palette" — SUT does NOT import travelSubBrand.js;
 *     uses CSS vars (--primary-color, --warning-color) instead. We
 *     do NOT assert on inline rgba colors.
 *   - "RBAC USER role hides mutation CTAs" — SUT has NO RBAC gating
 *     at the page level (route is wrapped in <TravelOnly> in App.jsx
 *     but that's vertical gating, not role gating). Skipped.
 *   - "Sub-brand badge" — SUT does NOT render a sub-brand badge;
 *     RFU context is implicit in the route. Skipped.
 *
 * Mock-object stability: useNotify, fetchApi, useNavigate mocks are
 * stable references per CLAUDE.md feedback rule (fresh refs in
 * useCallback deps trigger infinite re-render).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import RfuCustomerProfile from '../pages/travel/RfuCustomerProfile';

const fetchApiMock = vi.fn();
vi.mock('../utils/api', () => ({
  fetchApi: (...args) => fetchApiMock(...args),
  getAuthToken: () => 'test-token',
}));

const notifyObj = {
  error: vi.fn(),
  success: vi.fn(),
  info: vi.fn(),
  confirm: vi.fn(() => Promise.resolve(true)),
  prompt: () => Promise.resolve(''),
};
vi.mock('../utils/notify', () => ({
  useNotify: () => notifyObj,
}));

const navigateMock = vi.fn();
vi.mock('react-router-dom', async () => {
  const real = await vi.importActual('react-router-dom');
  return { ...real, useNavigate: () => navigateMock };
});

const CONTACT = {
  id: 100,
  name: 'Aisha Khan',
  email: 'aisha@example.test',
  phone: '+919876543210',
  subBrand: 'rfu',
};

const PROFILE = {
  id: 42,
  contactId: 100,
  passportNumber: 'P1234567',
  passportExpiry: '2030-06-15T00:00:00.000Z',
  visaHistoryJson: '[{"country":"AE","date":"2024-03","outcome":"granted"}]',
  frequentFlyerJson: '',
  seatPref: 'window',
  mealPref: 'halal',
  travelStyle: 'comfort',
  budgetMin: 150000,
  budgetMax: 350000,
  emergencyContactName: 'Salma Khan',
  emergencyContactPhone: '+919812345678',
  medicalNotes: 'Mild diabetes — needs sugar-free meals',
  specialAssistance: 'Wheelchair at airport',
  pastComplaintsJson: '',
  productTier: 'premium',
};

beforeEach(() => {
  fetchApiMock.mockReset();
  notifyObj.error.mockReset();
  notifyObj.success.mockReset();
  notifyObj.info.mockReset();
  navigateMock.mockReset();
});

function renderPage(contactId = '100') {
  return render(
    <MemoryRouter initialEntries={[`/travel/rfu/customers/${contactId}`]}>
      <Routes>
        <Route path="/travel/rfu/customers/:contactId" element={<RfuCustomerProfile />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('RfuCustomerProfile — page chrome + fetch lifecycle', () => {
  it('renders the loading state on mount (Loading…)', () => {
    fetchApiMock.mockReturnValue(new Promise(() => { /* never resolves */ }));
    renderPage();
    // SUT renders "Loading…" via the &hellip; entity (which DOES decode
    // through JSX since this is an HTML entity reference, not a JS
    // escape sequence). The rendered text is the single unicode
    // ellipsis character.
    expect(screen.getByText(/Loading/i)).toBeTruthy();
  });

  it('fires both fetches against the contactId from the route param', async () => {
    fetchApiMock.mockImplementation((url) => {
      if (url === '/api/contacts/100') return Promise.resolve(CONTACT);
      if (url === '/api/travel/rfu-profiles/by-contact/100') return Promise.resolve(PROFILE);
      return Promise.resolve(null);
    });
    renderPage();
    await waitFor(() => {
      expect(fetchApiMock).toHaveBeenCalledWith('/api/contacts/100');
      expect(fetchApiMock).toHaveBeenCalledWith('/api/travel/rfu-profiles/by-contact/100');
    });
  });

  it('renders the heading + contact name + email after fetches resolve', async () => {
    fetchApiMock.mockImplementation((url) => {
      if (url === '/api/contacts/100') return Promise.resolve(CONTACT);
      if (url === '/api/travel/rfu-profiles/by-contact/100') return Promise.resolve(PROFILE);
      return Promise.resolve(null);
    });
    renderPage();
    await screen.findByRole('heading', { name: /RFU Customer Profile/i });
    await waitFor(() => {
      expect(screen.getByText(/Aisha Khan/)).toBeTruthy();
    });
    // Email + phone render with a middle-dot separator in the SUT.
    expect(screen.getByText(/aisha@example\.test/)).toBeTruthy();
    expect(screen.getByText(/\+919876543210/)).toBeTruthy();
  });

  it('falls back to "Contact #<id>" when /api/contacts/:id resolves to null', async () => {
    fetchApiMock.mockImplementation((url) => {
      if (url === '/api/contacts/100') return Promise.reject({ status: 500, body: {} });
      if (url === '/api/travel/rfu-profiles/by-contact/100') return Promise.resolve(PROFILE);
      return Promise.resolve(null);
    });
    renderPage();
    await waitFor(() => {
      expect(screen.getByText(/Contact #100/)).toBeTruthy();
    });
  });

  it('renders "Invalid contact id" when route param is non-numeric', async () => {
    fetchApiMock.mockResolvedValue(null);
    renderPage('not-a-number');
    await waitFor(() => {
      expect(screen.getByText(/Invalid contact id in URL/i)).toBeTruthy();
    });
  });
});

describe('RfuCustomerProfile — read view (existing profile)', () => {
  beforeEach(() => {
    fetchApiMock.mockImplementation((url) => {
      if (url === '/api/contacts/100') return Promise.resolve(CONTACT);
      if (url === '/api/travel/rfu-profiles/by-contact/100') return Promise.resolve(PROFILE);
      return Promise.resolve(null);
    });
  });

  it('renders the RFU-specific cards + values from the profile', async () => {
    renderPage();
    await screen.findByText(/Identity & travel docs/i);
    expect(screen.getByText('P1234567')).toBeTruthy();
    expect(screen.getByText(/premium/i)).toBeTruthy();
    expect(screen.getByText('window')).toBeTruthy();
    expect(screen.getByText('halal')).toBeTruthy();
    expect(screen.getByText('Salma Khan')).toBeTruthy();
    expect(screen.getByText(/Mild diabetes/)).toBeTruthy();
    expect(screen.getByText(/Wheelchair at airport/)).toBeTruthy();
  });

  it('formats budgetMin / budgetMax with ₹ + en-IN locale grouping', async () => {
    renderPage();
    await screen.findByText(/Budget/i);
    // 150000 → "₹1,50,000" under en-IN grouping.
    expect(screen.getByText(/1,50,000/)).toBeTruthy();
    expect(screen.getByText(/3,50,000/)).toBeTruthy();
  });

  it('pretty-prints the JSON textarea fields in the read view <pre>', async () => {
    renderPage();
    await screen.findByText(/Visa history \(JSON\)/i);
    // JSON is parsed + re-stringified with 2-space indent — the country
    // key should be on its own line.
    const pre = screen.getByText((_, node) => node?.tagName === 'PRE' && /AE/.test(node.textContent || ''));
    expect(pre).toBeTruthy();
    expect(pre.textContent).toMatch(/"country":\s*"AE"/);
  });

  it('shows the "Edit profile" CTA (NOT "Create profile") when a profile exists', async () => {
    renderPage();
    const btn = await screen.findByRole('button', { name: /Edit profile/i });
    expect(btn).toBeTruthy();
    // The empty-state "No RFU profile yet" copy must NOT render when a
    // profile is already loaded.
    expect(screen.queryByText(/No RFU profile yet/i)).toBeNull();
  });
});

describe('RfuCustomerProfile — empty + error states', () => {
  it('shows "No RFU profile yet" + Create CTA when by-contact returns 404', async () => {
    fetchApiMock.mockImplementation((url) => {
      if (url === '/api/contacts/100') return Promise.resolve(CONTACT);
      if (url === '/api/travel/rfu-profiles/by-contact/100') {
        return Promise.reject({ status: 404, body: { error: 'Not found' } });
      }
      return Promise.resolve(null);
    });
    renderPage();
    await screen.findByText(/No RFU profile yet/i);
    expect(screen.getByRole('button', { name: /Create profile/i })).toBeTruthy();
  });

  it('surfaces notify.error on a non-404 fetch failure (500)', async () => {
    fetchApiMock.mockImplementation((url) => {
      if (url === '/api/contacts/100') return Promise.resolve(CONTACT);
      if (url === '/api/travel/rfu-profiles/by-contact/100') {
        return Promise.reject({ status: 500, body: { error: 'DB read failed' } });
      }
      return Promise.resolve(null);
    });
    renderPage();
    await waitFor(() => {
      expect(notifyObj.error).toHaveBeenCalledWith('DB read failed');
    });
  });

  it('renders gracefully when profile fields (passport / preferences) are null', async () => {
    fetchApiMock.mockImplementation((url) => {
      if (url === '/api/contacts/100') return Promise.resolve(CONTACT);
      if (url === '/api/travel/rfu-profiles/by-contact/100') {
        return Promise.resolve({
          id: 7,
          contactId: 100,
          passportNumber: null,
          passportExpiry: null,
          visaHistoryJson: null,
          frequentFlyerJson: null,
          seatPref: null,
          mealPref: null,
          travelStyle: null,
          budgetMin: null,
          budgetMax: null,
          emergencyContactName: null,
          emergencyContactPhone: null,
          medicalNotes: null,
          specialAssistance: null,
          pastComplaintsJson: null,
          productTier: null,
        });
      }
      return Promise.resolve(null);
    });
    renderPage();
    // Page should NOT crash. Heading renders, and the dash placeholder
    // appears for missing values (KV component falls back to "—").
    await screen.findByRole('heading', { name: /RFU Customer Profile/i });
    expect(screen.getAllByText('—').length).toBeGreaterThan(0);
    // Visa history pre falls back to the placeholder copy.
    expect(screen.getByText(/No visa history captured yet/i)).toBeTruthy();
  });
});

describe('RfuCustomerProfile — edit flow', () => {
  it('clicking "Edit profile" reveals the form (Save profile button)', async () => {
    fetchApiMock.mockImplementation((url) => {
      if (url === '/api/contacts/100') return Promise.resolve(CONTACT);
      if (url === '/api/travel/rfu-profiles/by-contact/100') return Promise.resolve(PROFILE);
      return Promise.resolve(null);
    });
    renderPage();
    const editBtn = await screen.findByRole('button', { name: /Edit profile/i });
    fireEvent.click(editBtn);
    expect(await screen.findByRole('button', { name: /Save profile/i })).toBeTruthy();
    expect(screen.getByRole('button', { name: /Cancel/i })).toBeTruthy();
  });

  it('Save fires PATCH /api/travel/rfu-profiles/:id when profile exists', async () => {
    fetchApiMock.mockImplementation((url, opts) => {
      if (url === '/api/contacts/100') return Promise.resolve(CONTACT);
      if (url === '/api/travel/rfu-profiles/by-contact/100') return Promise.resolve(PROFILE);
      if (url === '/api/travel/rfu-profiles/42' && opts?.method === 'PATCH') {
        return Promise.resolve({ ...PROFILE });
      }
      return Promise.resolve(null);
    });
    renderPage();
    const editBtn = await screen.findByRole('button', { name: /Edit profile/i });
    fireEvent.click(editBtn);
    const saveBtn = await screen.findByRole('button', { name: /Save profile/i });
    fireEvent.click(saveBtn);
    await waitFor(() => {
      const patchCall = fetchApiMock.mock.calls.find(
        (c) => c[0] === '/api/travel/rfu-profiles/42' && c[1]?.method === 'PATCH',
      );
      expect(patchCall).toBeTruthy();
    });
    await waitFor(() => {
      expect(notifyObj.success).toHaveBeenCalledWith('Profile updated');
    });
  });

  it('Save rejects invalid JSON in JSON-typed textareas with a client-side error', async () => {
    fetchApiMock.mockImplementation((url) => {
      if (url === '/api/contacts/100') return Promise.resolve(CONTACT);
      if (url === '/api/travel/rfu-profiles/by-contact/100') return Promise.resolve(PROFILE);
      return Promise.resolve(null);
    });
    renderPage();
    const editBtn = await screen.findByRole('button', { name: /Edit profile/i });
    fireEvent.click(editBtn);
    // The 3 JSON-typed fields are textareas. Find the visa-history one
    // by its placeholder (which is set in the SUT to a JSON-shaped hint).
    const visaTextarea = await screen.findByPlaceholderText(/"country":"AE"/);
    fireEvent.change(visaTextarea, { target: { value: '{not-valid-json}' } });
    const saveBtn = screen.getByRole('button', { name: /Save profile/i });
    fireEvent.click(saveBtn);
    await waitFor(() => {
      expect(notifyObj.error).toHaveBeenCalledWith(
        expect.stringMatching(/visaHistoryJson is not valid JSON/),
      );
    });
    // No PATCH should have been attempted.
    const patchCall = fetchApiMock.mock.calls.find(
      (c) => c[1]?.method === 'PATCH',
    );
    expect(patchCall).toBeFalsy();
  });

  it('Cancel returns to read view + re-loads the profile', async () => {
    fetchApiMock.mockImplementation((url) => {
      if (url === '/api/contacts/100') return Promise.resolve(CONTACT);
      if (url === '/api/travel/rfu-profiles/by-contact/100') return Promise.resolve(PROFILE);
      return Promise.resolve(null);
    });
    renderPage();
    const editBtn = await screen.findByRole('button', { name: /Edit profile/i });
    fireEvent.click(editBtn);
    const cancelBtn = await screen.findByRole('button', { name: /Cancel/i });
    fetchApiMock.mockClear();
    fireEvent.click(cancelBtn);
    // After cancel, read-view's "Edit profile" CTA should reappear.
    await screen.findByRole('button', { name: /Edit profile/i });
    // load() refires both fetches.
    await waitFor(() => {
      expect(fetchApiMock).toHaveBeenCalledWith('/api/contacts/100');
    });
  });

  it('500 from PATCH surfaces notify.error with the server message', async () => {
    fetchApiMock.mockImplementation((url, opts) => {
      if (url === '/api/contacts/100') return Promise.resolve(CONTACT);
      if (url === '/api/travel/rfu-profiles/by-contact/100') return Promise.resolve(PROFILE);
      if (url === '/api/travel/rfu-profiles/42' && opts?.method === 'PATCH') {
        return Promise.reject({ status: 500, body: { error: 'Server exploded' } });
      }
      return Promise.resolve(null);
    });
    renderPage();
    const editBtn = await screen.findByRole('button', { name: /Edit profile/i });
    fireEvent.click(editBtn);
    const saveBtn = await screen.findByRole('button', { name: /Save profile/i });
    fireEvent.click(saveBtn);
    await waitFor(() => {
      expect(notifyObj.error).toHaveBeenCalledWith('Server exploded');
    });
  });
});
