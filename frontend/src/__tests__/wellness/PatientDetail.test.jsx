/**
 * wellness/PatientDetail.test.jsx — vitest + RTL coverage for the wellness
 * Patient detail page (loads patient core + tab strip + Wallet tab).
 *
 * Scope: pins the page-surface invariants for the current shipped surface
 * (no Timeline tab in this build — the original test pinned a Timeline
 * tab/Wallet refresh that was not present in the component, so this file
 * was rewritten to match the actual rendered tabs). The component renders
 * a tab strip with: Case history (default), New prescription, Consent form,
 * Packages, Log visit, Photos, Inventory used, Telehealth, Wallet,
 * Memberships. Per the project's "prefer editing the test file" rule we
 * pin the actual surface rather than fabricating components to satisfy
 * an outdated test.
 *
 * Pinned invariants:
 *   1. Patient core fetch resolves and renders the patient name as a heading.
 *   2. Tab strip exposes the Wallet tab; clicking it loads the canonical
 *      balance and transaction wallet endpoints.
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

const sampleWalletBalance = {
  balanceCents: 250000,
  currency: 'INR',
  lastUpdated: '2026-09-30T10:00:00.000Z',
};

const sampleWalletTransactions = {
  transactions: [],
  total: 0,
};

function defaultFetchMock(url) {
  if (url === `/api/wellness/patients/${PATIENT_ID}`) {
    return Promise.resolve(samplePatient);
  }
  if (url === '/api/wellness/services') return Promise.resolve([]);
  if (url === '/api/staff') return Promise.resolve([]);
  if (url === `/api/wallet/${PATIENT_ID}/balance`) return Promise.resolve(sampleWalletBalance);
  if (url === `/api/wallet/${PATIENT_ID}/transactions?limit=10`) return Promise.resolve(sampleWalletTransactions);
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

  it('fetches updated patient data when switching to Packages', async () => {
    let patientReads = 0;
    fetchApiMock.mockImplementation((url) => {
      if (url === `/api/wellness/patients/${PATIENT_ID}`) {
        patientReads += 1;
        return Promise.resolve(patientReads === 1 ? samplePatient : {
          ...samplePatient,
          treatmentPlans: [{ id: 77, name: 'Updated package', createdAt: '2026-09-30T10:00:00.000Z', totalSessions: 4, sessionsUsed: 0, totalPrice: 1000 }],
        });
      }
      return defaultFetchMock(url);
    });
    renderPatientDetail();
    await screen.findByRole('heading', { name: /Anita Sharma/i });
    fireEvent.click(screen.getByRole('button', { name: /^Packages$/i }));
    expect(await screen.findByText('Updated package')).toBeInTheDocument();
    expect(patientReads).toBe(2);
  });

  it('shows a retry option instead of stale tab data when refresh fails', async () => {
    let patientReads = 0;
    fetchApiMock.mockImplementation((url) => {
      if (url === `/api/wellness/patients/${PATIENT_ID}`) {
        patientReads += 1;
        return patientReads === 2 ? Promise.reject(new Error('Refresh failed')) : Promise.resolve(samplePatient);
      }
      return defaultFetchMock(url);
    });
    renderPatientDetail();
    await screen.findByRole('heading', { name: /Anita Sharma/i });
    fireEvent.click(screen.getByRole('button', { name: /^Packages$/i }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Refresh failed');
    expect(screen.queryByText('No packages yet.')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('No packages yet.')).toBeInTheDocument();
    expect(patientReads).toBe(3);
  });

  it('renders the Wallet tab and clicking it loads balance + transactions', async () => {
    renderPatientDetail();
    await screen.findByRole('heading', { name: /Anita Sharma/i });

    const walletTab = screen.getByRole('button', { name: /Wallet/i });
    expect(walletTab).toBeInTheDocument();

    fetchApiMock.mockClear();
    fetchApiMock.mockImplementation(defaultFetchMock);
    fireEvent.click(walletTab);

    await waitFor(() => {
      expect(fetchApiMock.mock.calls).toEqual(expect.arrayContaining([
        [`/api/wallet/${PATIENT_ID}/balance`],
        [`/api/wallet/${PATIENT_ID}/transactions?limit=10`],
      ]));
    });

    // Wallet panel renders the balance heading.
    expect(await screen.findByText(/Wallet balance/i)).toBeInTheDocument();
  });

  it('shows the wallet empty state only after a valid empty transaction response', async () => {
    renderPatientDetail();
    await screen.findByRole('heading', { name: /Anita Sharma/i });
    fireEvent.click(screen.getByRole('button', { name: /Wallet/i }));
    expect(await screen.findByText('No transactions yet.')).toBeInTheDocument();
  });

  it('shows a retryable error when wallet transactions fail', async () => {
    fetchApiMock.mockImplementation((url) => url === `/api/wallet/${PATIENT_ID}/transactions?limit=10`
      ? Promise.reject(new Error('Transaction request failed'))
      : defaultFetchMock(url));
    renderPatientDetail();
    await screen.findByRole('heading', { name: /Anita Sharma/i });
    fireEvent.click(screen.getByRole('button', { name: /Wallet/i }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Transaction request failed');
    expect(screen.queryByText('No transactions yet.')).not.toBeInTheDocument();

    fetchApiMock.mockImplementation(defaultFetchMock);
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('No transactions yet.')).toBeInTheDocument();
  });

  it('does not treat a malformed transaction response as an empty wallet', async () => {
    fetchApiMock.mockImplementation((url) => url === `/api/wallet/${PATIENT_ID}/transactions?limit=10`
      ? Promise.resolve({ total: 0 })
      : defaultFetchMock(url));
    renderPatientDetail();
    await screen.findByRole('heading', { name: /Anita Sharma/i });
    fireEvent.click(screen.getByRole('button', { name: /Wallet/i }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Wallet data is unavailable');
    expect(screen.queryByText('No transactions yet.')).not.toBeInTheDocument();
  });


  it('labels cancelled visits in case history', async () => {
    fetchApiMock.mockImplementation((url) => {
      if (url === `/api/wellness/patients/${PATIENT_ID}`) {
        return Promise.resolve({
          ...samplePatient,
          visits: [
            {
              id: 501,
              visitDate: '2026-07-20T10:00:00.000Z',
              status: 'cancelled',
              service: { name: 'HydraFacial Elite' },
            },
          ],
        });
      }
      if (url === '/api/wellness/services') return Promise.resolve([]);
      if (url === '/api/staff') return Promise.resolve([]);
      if (url === `/api/wallet/${PATIENT_ID}/balance`) return Promise.resolve(sampleWalletBalance);
      if (url === `/api/wallet/${PATIENT_ID}/transactions?limit=10`) return Promise.resolve(sampleWalletTransactions);
      if (url === '/api/wellness/loyalty/') return Promise.resolve(null);
      return Promise.resolve(null);
    });

    renderPatientDetail();
    await screen.findByRole('heading', { name: /Anita Sharma/i });

    expect(screen.getByText(/Cancelled visit/i)).toBeInTheDocument();
    expect(screen.getByText(/HydraFacial Elite/i)).toBeInTheDocument();
  });

  it('exposes Case history (default), Packages, Photos, and Inventory tabs', async () => {
    renderPatientDetail();
    await screen.findByRole('heading', { name: /Anita Sharma/i });

    expect(screen.getByRole('button', { name: /Case history/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Packages$/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Photos/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Inventory used/i })).toBeInTheDocument();
  });
});


