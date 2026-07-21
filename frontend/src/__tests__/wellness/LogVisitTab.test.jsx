/**
 * wellness/LogVisitTab.test.jsx — vitest + RTL coverage for the Log Visit tab
 * payment-link surface.
 *
 * Pins the following invariants:
 *   1. A completed visit with a payment link renders the link and a Copy button.
 *   2. Clicking Copy writes the URL to the clipboard and shows a transient
 *      "Copied!" label.
 *   3. A completed visit with a charge but no payment link renders a
 *      "Generate payment link" button.
 *   4. Clicking Generate calls the backend endpoint and refreshes the patient.
 *   5. Marking a pending appointment as visited with a charge returns the
 *      payment link in the PUT response and surfaces it in the UI after refresh.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

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

import LogVisitTab from '../../pages/wellness/patientDetail/tabs/LogVisitTab';

const sampleServices = [
  { id: 1, name: 'Botox Treatment', basePrice: 25000, durationMin: 60 },
];

function renderTab(props = {}) {
  const onSaved = vi.fn();
  const defaultProps = {
    patient: { id: 1, visits: [] },
    services: sampleServices,
    doctors: [],
    onSaved,
  };
  return {
    ...render(<LogVisitTab {...defaultProps} {...props} />),
    onSaved,
  };
}

describe('<wellness/LogVisitTab /> — payment link surface', () => {
  beforeEach(() => {
    fetchApiMock.mockReset();
    notifyObj.error.mockReset?.();
    notifyObj.success.mockReset?.();

    // Stub clipboard for the copy-button test.
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders a Copy button for a completed visit that already has a payment link', () => {
    const patient = {
      id: 1,
      visits: [
        {
          id: 10,
          status: 'completed',
          visitDate: '2026-07-20T10:00:00.000Z',
          serviceId: 1,
          service: sampleServices[0],
          doctor: { name: 'Anita Das' },
          amountCharged: 25000,
          paymentLinkUrl: 'https://rzp.io/l/visit-10',
        },
      ],
    };

    renderTab({ patient });

    expect(screen.getByDisplayValue('https://rzp.io/l/visit-10')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Copy/i })).toBeInTheDocument();
  });

  it('copies the payment link to the clipboard when Copy is clicked', async () => {
    const patient = {
      id: 1,
      visits: [
        {
          id: 10,
          status: 'completed',
          visitDate: '2026-07-20T10:00:00.000Z',
          serviceId: 1,
          service: sampleServices[0],
          doctor: { name: 'Anita Das' },
          amountCharged: 25000,
          paymentLinkUrl: 'https://rzp.io/l/visit-10',
        },
      ],
    };

    renderTab({ patient });

    const copyBtn = screen.getByRole('button', { name: /Copy/i });
    fireEvent.click(copyBtn);

    await waitFor(() => {
      expect(navigator.clipboard.writeText).toHaveBeenCalledWith('https://rzp.io/l/visit-10');
      expect(screen.getByRole('button', { name: /Copied!/i })).toBeInTheDocument();
    });
  });

  it('renders a Generate payment link button for a charged completed visit with no link', () => {
    const patient = {
      id: 1,
      visits: [
        {
          id: 11,
          status: 'completed',
          visitDate: '2026-07-19T10:00:00.000Z',
          serviceId: 1,
          service: sampleServices[0],
          doctor: { name: 'Dr. Manose' },
          amountCharged: 18000,
          paymentLinkUrl: null,
        },
      ],
    };

    renderTab({ patient });

    expect(screen.getByRole('button', { name: /Generate payment link/i })).toBeInTheDocument();
  });

  it('calls the payment-link endpoint and refreshes the patient when Generate is clicked', async () => {
    fetchApiMock.mockResolvedValue({ url: 'https://rzp.io/l/visit-11', gateway: 'razorpay' });

    const patient = {
      id: 1,
      visits: [
        {
          id: 11,
          status: 'completed',
          visitDate: '2026-07-19T10:00:00.000Z',
          serviceId: 1,
          service: sampleServices[0],
          doctor: { name: 'Dr. Manose' },
          amountCharged: 18000,
          paymentLinkUrl: null,
        },
      ],
    };

    const { onSaved } = renderTab({ patient });

    const generateBtn = screen.getByRole('button', { name: /Generate payment link/i });
    fireEvent.click(generateBtn);

    await waitFor(() => {
      expect(fetchApiMock).toHaveBeenCalledWith(
        '/api/wellness/visits/11/payment-link',
        expect.objectContaining({ method: 'POST' }),
      );
      expect(onSaved).toHaveBeenCalled();
      expect(notifyObj.success).toHaveBeenCalledWith('Payment link generated');
    });
  });

  it('reflects the payment link returned by mark-as-visited after the patient refreshes', async () => {
    fetchApiMock
      .mockResolvedValueOnce({ id: 10, status: 'completed', paymentLinkUrl: 'https://rzp.io/l/visit-10' })
      .mockResolvedValueOnce([]); // auto-consumption rules

    const patient = {
      id: 1,
      visits: [
        {
          id: 10,
          status: 'booked',
          visitDate: '2026-07-20T10:00:00.000Z',
          serviceId: 1,
          service: sampleServices[0],
          doctor: { name: 'Anita Das' },
        },
      ],
    };

    const { onSaved } = renderTab({ patient });

    fireEvent.click(screen.getByText(/2026-07-20 · Botox Treatment/));
    fireEvent.click(screen.getByRole('button', { name: /Mark as visited/i }));

    await waitFor(() => {
      expect(fetchApiMock).toHaveBeenCalledWith(
        '/api/wellness/visits/10',
        expect.objectContaining({
          method: 'PUT',
          body: JSON.stringify({ status: 'completed', notes: '', amountCharged: 25000 }),
        }),
      );
      expect(onSaved).toHaveBeenCalled();
    });

    // Simulate the parent re-fetching the patient with the newly populated link.
    const refreshedPatient = {
      ...patient,
      visits: [
        {
          ...patient.visits[0],
          status: 'completed',
          amountCharged: 25000,
          paymentLinkUrl: 'https://rzp.io/l/visit-10',
        },
      ],
    };

    // Re-render with the refreshed patient to assert the link surface.
    renderTab({ patient: refreshedPatient });
    expect(await screen.findByDisplayValue('https://rzp.io/l/visit-10')).toBeInTheDocument();
  });

  it('shows a Paid badge and hides Copy/Generate for a paid completed visit', () => {
    const patient = {
      id: 1,
      visits: [
        {
          id: 12,
          status: 'completed',
          visitDate: '2026-07-18T10:00:00.000Z',
          serviceId: 1,
          service: sampleServices[0],
          doctor: { name: 'Anita Das' },
          amountCharged: 25000,
          paymentLinkUrl: 'https://rzp.io/l/visit-12',
          paymentStatus: 'paid',
        },
      ],
    };

    renderTab({ patient });

    expect(screen.getByText(/Paid/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Copy/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Generate payment link/i })).not.toBeInTheDocument();
  });
});
