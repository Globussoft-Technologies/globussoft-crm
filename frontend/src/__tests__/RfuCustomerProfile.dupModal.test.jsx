/**
 * RfuCustomerProfile.jsx — duplicate-passport modal flow (PRD §4.5 Phase 2).
 *
 * When the backend rejects POST /api/travel/rfu-profiles with
 * 409 DUPLICATE_PASSPORT, the page must:
 *   - NOT fire the generic error toast
 *   - Render a modal that shows the colliding contact's identity
 *   - Offer "Open that contact" (navigates to /travel/rfu/customers/:id)
 *   - Offer "Edit passport" (closes the modal so the operator can fix it)
 *
 * The 409 is the failure mode the new POST + PATCH guards added in
 * commit ea817fb (backend/routes/travel_rfu_profiles.js). This spec
 * pins the frontend contract end-to-end.
 *
 * Mock-object stability: useNotify, useNavigate, and fetchApi mocks
 * are stable references per CLAUDE.md feedback rule (fresh refs in
 * useCallback deps trigger infinite re-render).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import RfuCustomerProfile from '../pages/travel/RfuCustomerProfile';

const fetchApiMock = vi.fn();
vi.mock('../utils/api', () => ({
  fetchApi: (...args) => fetchApiMock(...args),
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

const SEEDED_CONTACT = {
  id: 100,
  name: 'Aisha Khan',
  email: 'aisha@example.test',
  phone: '+919876543210',
  subBrand: 'rfu',
};

const COLLIDING_CONTACT = {
  id: 200,
  name: 'Yusuf Rahman',
  email: 'yusuf@example.test',
};

function makeFetchImpl({ collision = true } = {}) {
  return (url, opts) => {
    if (url === '/api/contacts/100') return Promise.resolve(SEEDED_CONTACT);
    if (url === '/api/contacts/200') return Promise.resolve(COLLIDING_CONTACT);
    if (url === '/api/travel/rfu-profiles/by-contact/100') {
      // Simulate "no profile yet" via 404.
      return Promise.reject({ status: 404, body: { error: 'Not found' } });
    }
    if (url === '/api/travel/rfu-profiles' && opts?.method === 'POST') {
      if (collision) {
        return Promise.reject({
          status: 409,
          body: {
            error: 'Another contact already has this passport number',
            code: 'DUPLICATE_PASSPORT',
            existingProfileId: 42,
            existingContactId: 200,
          },
        });
      }
      return Promise.resolve({ id: 7, contactId: 100, passportNumber: 'K9876543' });
    }
    return Promise.resolve(null);
  };
}

beforeEach(() => {
  fetchApiMock.mockReset();
  notifyObj.error.mockReset();
  notifyObj.success.mockReset();
  notifyObj.info.mockReset();
  navigateMock.mockReset();
});

function renderPage() {
  return render(
    <MemoryRouter initialEntries={['/travel/rfu/customers/100']}>
      <Routes>
        <Route path="/travel/rfu/customers/:contactId" element={<RfuCustomerProfile />} />
      </Routes>
    </MemoryRouter>,
  );
}

async function clickCreateAndType(passport) {
  // Page renders "Create profile" CTA because /by-contact/100 returns 404.
  const createBtn = await screen.findByRole('button', { name: /Create profile/i });
  fireEvent.click(createBtn);
  // Form's <Field> wrapper renders <label> + <input> as siblings without
  // htmlFor/id wiring, so getByLabelText can't associate them. The
  // passport number is the FIRST text input rendered in the form (date
  // input + product-tier select don't have role=textbox), so positional
  // query is the cleanest reliable selector.
  const textInputs = await screen.findAllByRole('textbox');
  fireEvent.change(textInputs[0], { target: { value: passport } });
  const saveBtn = screen.getByRole('button', { name: /Save profile|Save/i });
  fireEvent.click(saveBtn);
}

describe('RfuCustomerProfile — duplicate-passport modal (PRD §4.5)', () => {
  it('opens the modal on 409 DUPLICATE_PASSPORT instead of a toast', async () => {
    fetchApiMock.mockImplementation(makeFetchImpl({ collision: true }));
    renderPage();
    await clickCreateAndType('K9876543');
    await screen.findByRole('dialog');
    expect(screen.getByText(/Passport already on file/i)).toBeTruthy();
    // The error toast is suppressed in favour of the modal.
    expect(notifyObj.error).not.toHaveBeenCalled();
  });

  it('shows the colliding contact’s name once /api/contacts/:id resolves', async () => {
    fetchApiMock.mockImplementation(makeFetchImpl({ collision: true }));
    renderPage();
    await clickCreateAndType('K9876543');
    await screen.findByRole('dialog');
    // Name resolved from GET /api/contacts/200.
    await waitFor(() => {
      expect(screen.getByText(/Yusuf Rahman/)).toBeTruthy();
    });
    expect(screen.getByText('K9876543')).toBeTruthy();
  });

  it('"Open that contact" navigates to the colliding contact’s profile', async () => {
    fetchApiMock.mockImplementation(makeFetchImpl({ collision: true }));
    renderPage();
    await clickCreateAndType('K9876543');
    await screen.findByRole('dialog');
    const openBtn = screen.getByRole('button', { name: /Open that contact/i });
    fireEvent.click(openBtn);
    expect(navigateMock).toHaveBeenCalledWith('/travel/rfu/customers/200');
  });

  it('"Edit passport" closes the modal without navigating', async () => {
    fetchApiMock.mockImplementation(makeFetchImpl({ collision: true }));
    renderPage();
    await clickCreateAndType('K9876543');
    const dialog = await screen.findByRole('dialog');
    const editBtn = screen.getByRole('button', { name: /Edit passport/i });
    fireEvent.click(editBtn);
    await waitFor(() => {
      expect(dialog).not.toBeInTheDocument();
    });
    expect(navigateMock).not.toHaveBeenCalled();
  });

  it('clean save (no collision) does NOT open the modal', async () => {
    fetchApiMock.mockImplementation(makeFetchImpl({ collision: false }));
    renderPage();
    await clickCreateAndType('NOVEL12345');
    // Give the success path room to resolve; no dialog should ever appear.
    await waitFor(() => {
      expect(notifyObj.success).toHaveBeenCalled();
    });
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});
