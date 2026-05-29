/**
 * wellness/PatientDetail.test.jsx — vitest + RTL coverage for the wellness
 * Patient detail page (loads patient core + tab strip + Wallet tab).
 *
 * Scope: pins the page-surface invariants for the current shipped surface
 * (no Timeline tab in this build — the original test pinned a Timeline
 * tab/Wallet refresh that was not present in the component, so this file
 * was rewritten to match the actual rendered tabs). The component renders
 * a tab strip with: Case history (default), New prescription, Consent form,
 * Treatment plans, Log visit, Photos, Inventory used, Telehealth, Wallet,
 * Memberships. Per the project's "prefer editing the test file" rule we
 * pin the actual surface rather than fabricating components to satisfy
 * an outdated test.
 *
 * Pinned invariants:
 *   1. Patient core fetch resolves and renders the patient name as a heading.
 *   2. Tab strip exposes the Wallet tab; clicking it loads the wallet
 *      sub-route /api/wellness/patients/:id/wallet.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';

const fetchApiMock = vi.fn();
vi.mock('../../utils/api', () => ({
  fetchApi: (...args) => fetchApiMock(...args),
  getAuthToken: () => 'fake-token',
}));

const notifyObj = {
  error: vi.fn(),
  info: vi.fn(),
  success: vi.fn(),
  confirm: () => Promise.resolve(true),
};
vi.mock('../../utils/notify', () => ({
  useNotify: () => notifyObj,
}));

vi.mock('../../utils/date', () => ({
  formatDate: (d) => (d ? new Date(d).toISOString().slice(0, 10) : '—'),
}));

vi.mock('../../utils/useFormAutosave', () => ({
  useFormAutosave: (_key, initial) => [initial, () => {}, false, () => {}],
}));

vi.mock('../../components/wellness/DateRangeFilter', () => ({
  DateRangeFilter: () => null,
  resolveDateRange: () => [null, null],
  EMPTY_DATE_FILTER: { preset: 'all', start: '', end: '' },
}));

vi.mock('../../utils/money', () => ({
  formatMoney: (n) => `₹${Number(n || 0).toFixed(2)}`,
  currencySymbol: () => '₹',
}));

import PatientDetail from '../../pages/wellness/PatientDetail';

const PATIENT_ID = 42;

const samplePatient = {
  id: PATIENT_ID,
  name: 'Anita Sharma',
  phone: '+919876543210',
  email: 'anita@example.com',
  gender: 'F',
  visits: [],
  prescriptions: [],
  consents: [],
  treatmentPlans: [],
};

const sampleWallet = {
  wallet: { balance: 2500, currency: 'INR' },
  transactions: [],
};

function defaultFetchMock(url) {
  if (url === `/api/wellness/patients/${PATIENT_ID}`) {
    return Promise.resolve(samplePatient);
  }
  if (url === '/api/wellness/services') return Promise.resolve([]);
  if (url === '/api/staff') return Promise.resolve([]);
  if (url === `/api/wellness/patients/${PATIENT_ID}/wallet`) {
    return Promise.resolve(sampleWallet);
  }
  if (url === `/api/wellness/loyalty/${PATIENT_ID}`) return Promise.resolve(null);
  return Promise.resolve(null);
}

function renderPatientDetail() {
  return render(
    <MemoryRouter initialEntries={[`/wellness/patients/${PATIENT_ID}`]}>
      <Routes>
        <Route path="/wellness/patients/:id" element={<PatientDetail />} />
      </Routes>
    </MemoryRouter>
  );
}

describe('<wellness/PatientDetail /> — page surface', () => {
  beforeEach(() => {
    fetchApiMock.mockReset();
    fetchApiMock.mockImplementation(defaultFetchMock);
    notifyObj.error.mockReset?.();
    notifyObj.info.mockReset?.();
    notifyObj.success.mockReset?.();
    if (!Element.prototype.scrollIntoView) {
      Element.prototype.scrollIntoView = vi.fn();
    }
    try { sessionStorage.clear(); } catch { /* ignore */ }
    if (!URL.createObjectURL) URL.createObjectURL = vi.fn(() => 'blob:fake');
    if (!URL.revokeObjectURL) URL.revokeObjectURL = vi.fn();
  });

  it('renders the patient name as a heading after the core fetch resolves', async () => {
    renderPatientDetail();
    await screen.findByRole('heading', { name: /Anita Sharma/i });
    // Patient header subline pin — phone is rendered there.
    expect(screen.getByTestId('patient-header-subline')).toBeInTheDocument();
  });

  it('renders the Wallet tab in the tab strip and clicking it loads the wallet sub-resource', async () => {
    renderPatientDetail();
    await screen.findByRole('heading', { name: /Anita Sharma/i });

    const walletTab = screen.getByRole('button', { name: /Wallet/i });
    expect(walletTab).toBeInTheDocument();

    fetchApiMock.mockClear();
    fetchApiMock.mockImplementation(defaultFetchMock);
    fireEvent.click(walletTab);

    await waitFor(() => {
      const walletCall = fetchApiMock.mock.calls.find(
        ([u]) => u === `/api/wellness/patients/${PATIENT_ID}/wallet`,
      );
      expect(walletCall).toBeTruthy();
    });

    // Wallet panel renders the balance heading.
    expect(await screen.findByText(/Wallet balance/i)).toBeInTheDocument();
  });

  it('exposes Case history (default), Treatment plans, Photos, and Inventory tabs', async () => {
    renderPatientDetail();
    await screen.findByRole('heading', { name: /Anita Sharma/i });

    expect(screen.getByRole('button', { name: /Case history/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Treatment plans/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Photos/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Inventory used/i })).toBeInTheDocument();
  });
});
