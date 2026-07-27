/**
 * EventsHistory.test.jsx — vitest + RTL coverage for the wellness
 * Events History page.
 *
 * Scope:
 *   1. Renders an empty state when no events exist.
 *   2. Renders saved events and their QRs from the API.
 *   3. Expands and collapses an event card.
 *   4. Downloads a QR from history.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

const toDataURLMock = vi.fn();
vi.mock('qrcode', () => ({
  default: {
    toDataURL: (...args) => toDataURLMock(...args),
    toCanvas: vi.fn(),
  },
}));

const notifySuccess = vi.fn();
const notifyError = vi.fn();
const notifyObj = {
  error: notifyError,
  success: notifySuccess,
  info: vi.fn(),
  confirm: () => Promise.resolve(true),
};
vi.mock('../../utils/notify', () => ({
  useNotify: () => notifyObj,
}));

vi.mock('../../utils/api', () => ({
  fetchApi: vi.fn(),
}));

import EventsHistory from '../../pages/wellness/EventsHistory';
import { AuthContext } from '../../App';
import { fetchApi } from '../../utils/api';

const TEST_TENANT_ID = 42;
const QR_EVENTS_API = '/api/wellness/qr-events';

let mockEvents = [];

function renderPage() {
  return render(
    <MemoryRouter>
      <AuthContext.Provider value={{ tenant: { id: TEST_TENANT_ID, slug: 'enhanced-wellness' }, user: { role: 'ADMIN' } }}>
        <EventsHistory />
      </AuthContext.Provider>
    </MemoryRouter>
  );
}

beforeEach(() => {
  vi.restoreAllMocks();
  toDataURLMock.mockResolvedValue('data:image/png;base64,MOCK');
  notifySuccess.mockReset();
  notifyError.mockReset();
  mockEvents = [];

  fetchApi.mockImplementation(async (url) => {
    if (url === QR_EVENTS_API) {
      return { events: mockEvents };
    }
    return {};
  });
});

describe('EventsHistory', () => {
  it('renders the page header and empty state', async () => {
    renderPage();
    expect(screen.getByText('Events History')).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.getByText('No events yet')).toBeInTheDocument();
    });
    expect(
      screen.getByText('Create an event in the QR Generator to start collecting QR codes here.')
    ).toBeInTheDocument();
  });

  it('renders saved events and their QR counts from the API', async () => {
    mockEvents = [
      {
        id: 1,
        name: 'Summer Camp',
        createdAt: new Date().toISOString(),
        qrs: [
          { id: 1, name: 'Check-in QR', text: 'https://example.com/checkin', size: 256, fgColor: '#000000', bgColor: '#ffffff', errorLevel: 'M', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() },
        ],
      },
      {
        id: 2,
        name: 'Membership Drive',
        createdAt: new Date().toISOString(),
        qrs: [],
      },
    ];

    renderPage();
    await waitFor(() => {
      expect(screen.getByText('Summer Camp')).toBeInTheDocument();
    });
    expect(screen.getByText('1 QR')).toBeInTheDocument();
    expect(screen.getByText('Membership Drive')).toBeInTheDocument();
    expect(screen.getByText('0 QRs')).toBeInTheDocument();
  });

  it('expands and collapses an event to show its QRs', async () => {
    mockEvents = [
      {
        id: 1,
        name: 'Summer Camp',
        createdAt: new Date().toISOString(),
        qrs: [
          { id: 1, name: 'Check-in QR', text: 'https://example.com/checkin', size: 256, fgColor: '#000000', bgColor: '#ffffff', errorLevel: 'M', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() },
        ],
      },
    ];

    renderPage();
    await waitFor(() => {
      expect(screen.getByText('Check-in QR')).toBeInTheDocument();
    });

    const toggleButton = screen.getByRole('button', { name: /Summer Camp/i });
    fireEvent.click(toggleButton);

    await waitFor(() => {
      expect(screen.queryByText('Check-in QR')).not.toBeInTheDocument();
    });

    fireEvent.click(toggleButton);
    await waitFor(() => {
      expect(screen.getByText('Check-in QR')).toBeInTheDocument();
    });
  });

  it('downloads a QR from history', async () => {
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click');
    mockEvents = [
      {
        id: 1,
        name: 'Summer Camp',
        createdAt: new Date().toISOString(),
        qrs: [
          { id: 1, name: 'Check-in QR', text: 'https://example.com/checkin', size: 512, fgColor: '#123456', bgColor: '#abcdef', errorLevel: 'H', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() },
        ],
      },
    ];

    renderPage();
    await waitFor(() => {
      expect(screen.getByText('Check-in QR')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByTitle('Download this QR'));

    await waitFor(() => {
      expect(toDataURLMock).toHaveBeenCalledWith(
        'https://example.com/checkin',
        expect.objectContaining({
          width: 512,
          color: { dark: '#123456', light: '#abcdef' },
          errorCorrectionLevel: 'H',
        })
      );
    });
    await waitFor(() => {
      expect(notifySuccess).toHaveBeenCalledWith('QR code downloaded');
    });
    expect(clickSpy).toHaveBeenCalled();
    clickSpy.mockRestore();
  });
});
