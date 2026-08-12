/**
 * QRGenerator.test.jsx — vitest + RTL coverage for the wellness
 * Events Management QR Generator page.
 *
 * Scope:
 *   1. Renders the page header and event selector.
 *   2. Creates an event and auto-selects it.
 *   3. Enters a URL + QR name and generates a QR under the selected event.
 *   4. Editing a QR loads it back into the form and updates it.
 *   5. Download buttons work once a QR preview exists.
 *   6. Events and QRs persist across reloads (re-fetched from the API).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

const toDataURLMock = vi.fn();
const toCanvasMock = vi.fn();
vi.mock('qrcode', () => ({
  default: {
    toDataURL: (...args) => toDataURLMock(...args),
    toCanvas: (...args) => toCanvasMock(...args),
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

import QRGenerator from '../../pages/wellness/QRGenerator';
import { AuthContext } from '../../App';
import { fetchApi } from '../../utils/api';

const TEST_TENANT_ID = 42;
const QR_EVENTS_API = '/api/wellness/qr-events';

let mockEvents = [];
let nextId = 1;

function parseBody(options = {}) {
  if (!options.body) return {};
  try {
    return JSON.parse(options.body);
  } catch {
    return {};
  }
}

function renderPage() {
  return render(
    <MemoryRouter>
      <AuthContext.Provider value={{ tenant: { id: TEST_TENANT_ID, slug: 'enhanced-wellness' }, user: { role: 'ADMIN' } }}>
        <QRGenerator />
      </AuthContext.Provider>
    </MemoryRouter>
  );
}

function openEventDropdown() {
  fireEvent.click(screen.getByTestId('event-dropdown-trigger'));
}

function createEvent(name) {
  fireEvent.click(screen.getByTestId('new-event-button'));
  fireEvent.change(screen.getByPlaceholderText('e.g. Summer Camp 2026'), { target: { value: name } });
  fireEvent.click(screen.getByRole('button', { name: /^Create$/i }));
}

beforeEach(() => {
  vi.restoreAllMocks();
  toDataURLMock.mockResolvedValue('data:image/png;base64,MOCK');
  toCanvasMock.mockResolvedValue(undefined);
  notifySuccess.mockReset();
  notifyError.mockReset();
  mockEvents = [];
  nextId = 1;

  fetchApi.mockImplementation(async (url, options = {}) => {
    const method = options.method || 'GET';

    if (url === QR_EVENTS_API && method === 'GET') {
      return { events: mockEvents };
    }

    if (url === QR_EVENTS_API && method === 'POST') {
      const body = parseBody(options);
      const created = {
        id: nextId++,
        name: body.name,
        createdAt: new Date().toISOString(),
        qrs: [],
      };
      mockEvents = [created, ...mockEvents];
      return created;
    }

    const qrCreateMatch = url.match(new RegExp(`^${QR_EVENTS_API}/(\\d+)/qrs$`));
    if (qrCreateMatch && method === 'POST') {
      const eventId = parseInt(qrCreateMatch[1], 10);
      const body = parseBody(options);
      const qr = {
        id: nextId++,
        eventId,
        ...body,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      const event = mockEvents.find((e) => e.id === eventId);
      if (event) event.qrs = [qr, ...event.qrs];
      return qr;
    }

    const qrUpdateMatch = url.match(new RegExp(`^${QR_EVENTS_API}/(\\d+)/qrs/(\\d+)$`));
    if (qrUpdateMatch && method === 'PUT') {
      const eventId = parseInt(qrUpdateMatch[1], 10);
      const qrId = parseInt(qrUpdateMatch[2], 10);
      const body = parseBody(options);
      const event = mockEvents.find((e) => e.id === eventId);
      if (event) {
        const idx = event.qrs.findIndex((q) => q.id === qrId);
        if (idx !== -1) {
          event.qrs[idx] = { ...event.qrs[idx], ...body, updatedAt: new Date().toISOString() };
          return event.qrs[idx];
        }
      }
      return { id: qrId, ...body };
    }

    const qrDeleteMatch = url.match(new RegExp(`^${QR_EVENTS_API}/(\\d+)/qrs/(\\d+)$`));
    if (qrDeleteMatch && method === 'DELETE') {
      const eventId = parseInt(qrDeleteMatch[1], 10);
      const qrId = parseInt(qrDeleteMatch[2], 10);
      const event = mockEvents.find((e) => e.id === eventId);
      if (event) event.qrs = event.qrs.filter((q) => q.id !== qrId);
      return true;
    }

    return {};
  });
});

describe('QRGenerator', () => {
  it('renders the page header and event selector', async () => {
    renderPage();
    expect(screen.getByText('QR Generator')).toBeInTheDocument();
    expect(screen.getByTestId('event-dropdown-trigger')).toBeInTheDocument();
    expect(screen.getByTestId('new-event-button')).toBeInTheDocument();
    expect(screen.getByPlaceholderText('Enter URL here')).toBeInTheDocument();
  });

  it('creates an event and auto-selects it', async () => {
    renderPage();
    createEvent('Health Camp 2026');

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Health Camp 2026/i })).toBeInTheDocument();
    });

    expect(notifySuccess).toHaveBeenCalledWith('Event "Health Camp 2026" created');
  });

  it('selects an existing event from the dropdown', async () => {
    mockEvents = [
      { id: 1, name: 'Existing Event', createdAt: new Date().toISOString(), qrs: [] },
    ];
    renderPage();

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Existing Event/i })).toBeInTheDocument();
    });

    openEventDropdown();
    fireEvent.click(screen.getByRole('option', { name: /Existing Event/i }));

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Existing Event/i })).toBeInTheDocument();
    });
  });

  it('loads more generated QRs when the selected event list is scrolled', async () => {
    mockEvents = [
      {
        id: 1,
        name: 'Large Event',
        createdAt: new Date().toISOString(),
        qrs: Array.from({ length: 12 }, (_, index) => ({
          id: index + 1,
          name: `QR ${index + 1}`,
          text: `https://example.com/${index + 1}`,
          size: 256,
          fgColor: '#000000',
          bgColor: '#ffffff',
          errorLevel: 'M',
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        })),
      },
    ];

    renderPage();
    expect(await screen.findByText('QR 10')).toBeInTheDocument();
    expect(screen.queryByText('QR 11')).not.toBeInTheDocument();

    const list = screen.getByTestId('generated-qr-list');
    // Robustly mock the scroll geometry so the infinite-scroll handler fires
    // in both jsdom and CI where native layout metrics are unreliable.
    Object.defineProperty(list, 'scrollTop', { value: 1000, writable: true, configurable: true });
    Object.defineProperty(list, 'clientHeight', { value: 300, writable: true, configurable: true });
    Object.defineProperty(list, 'scrollHeight', { value: 1000, writable: true, configurable: true });
    fireEvent.scroll(list, { target: list });

    await waitFor(() => {
      expect(screen.getByText('QR 11')).toBeInTheDocument();
    });
  });

  it('adds a generated QR to the selected event', async () => {
    renderPage();
    createEvent('Membership Drive');

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Membership Drive/i })).toBeInTheDocument();
    });

    fireEvent.change(screen.getByPlaceholderText('e.g. Registration desk'), { target: { value: 'Sign-up QR' } });
    fireEvent.change(screen.getByPlaceholderText('Enter URL here'), { target: { value: 'https://example.com/signup' } });

    await waitFor(() => expect(screen.getByRole('button', { name: /Generate QR/i })).not.toBeDisabled());
    fireEvent.click(screen.getByRole('button', { name: /Generate QR/i }));

    await waitFor(() => {
      expect(notifySuccess).toHaveBeenCalledWith('QR added to event');
    });

    expect(screen.getByText('Membership Drive — Generated QRs')).toBeInTheDocument();
    expect(screen.getByText('Sign-up QR')).toBeInTheDocument();
    expect(screen.getByText('https://example.com/signup')).toBeInTheDocument();
  });

  it('edits an existing QR and updates it', async () => {
    renderPage();
    createEvent('Yoga Workshop');

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Yoga Workshop/i })).toBeInTheDocument();
    });

    fireEvent.change(screen.getByPlaceholderText('e.g. Registration desk'), { target: { value: 'Initial QR' } });
    fireEvent.change(screen.getByPlaceholderText('Enter URL here'), { target: { value: 'https://example.com/initial' } });
    await waitFor(() => expect(screen.getByRole('button', { name: /Generate QR/i })).not.toBeDisabled());
    fireEvent.click(screen.getByRole('button', { name: /Generate QR/i }));

    await waitFor(() => expect(screen.getByText('Initial QR')).toBeInTheDocument());

    fireEvent.click(screen.getByTitle('Edit this QR code'));

    await waitFor(() => {
      expect(screen.getByDisplayValue('Initial QR')).toBeInTheDocument();
      expect(screen.getByDisplayValue('https://example.com/initial')).toBeInTheDocument();
    });

    fireEvent.change(screen.getByPlaceholderText('e.g. Registration desk'), { target: { value: 'Updated QR' } });
    fireEvent.change(screen.getByPlaceholderText('Enter URL here'), { target: { value: 'https://example.com/updated' } });
    fireEvent.click(screen.getByRole('button', { name: /Update QR/i }));

    await waitFor(() => {
      expect(notifySuccess).toHaveBeenCalledWith('QR updated');
    });

    expect(screen.getByText('Updated QR')).toBeInTheDocument();
    expect(screen.getByText('https://example.com/updated')).toBeInTheDocument();
    expect(screen.queryByText('Initial QR')).not.toBeInTheDocument();
  });

  it('downloads the preview QR code and shows a success toast', async () => {
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click');
    renderPage();
    createEvent('Download Event');

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Download Event/i })).toBeInTheDocument();
    });

    fireEvent.change(screen.getByPlaceholderText('Enter URL here'), { target: { value: 'https://example.com/offer' } });
    await waitFor(() => expect(screen.getByRole('button', { name: /Download PNG/i })).not.toBeDisabled());

    fireEvent.click(screen.getByRole('button', { name: /Download PNG/i }));

    await waitFor(() => {
      expect(notifySuccess).toHaveBeenCalledWith('QR code downloaded');
    });
    expect(clickSpy).toHaveBeenCalled();
    clickSpy.mockRestore();
  });

  it('downloads a QR from the event list', async () => {
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click');
    renderPage();
    createEvent('List Download Event');

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /List Download Event/i })).toBeInTheDocument();
    });

    fireEvent.change(screen.getByPlaceholderText('e.g. Registration desk'), { target: { value: 'List QR' } });
    fireEvent.change(screen.getByPlaceholderText('Enter URL here'), { target: { value: 'https://example.com/list' } });
    await waitFor(() => expect(screen.getByRole('button', { name: /Generate QR/i })).not.toBeDisabled());
    fireEvent.click(screen.getByRole('button', { name: /Generate QR/i }));

    await waitFor(() => expect(screen.getByText('List QR')).toBeInTheDocument());

    toDataURLMock.mockClear();
    fireEvent.click(screen.getByTitle('Download this QR'));

    await waitFor(() => {
      expect(toDataURLMock).toHaveBeenCalledWith('https://example.com/list', expect.any(Object));
    });
    await waitFor(() => {
      expect(notifySuccess).toHaveBeenCalledWith('QR code downloaded');
    });
    expect(clickSpy).toHaveBeenCalled();
    clickSpy.mockRestore();
  });

  it('shows an error toast when Generate QR is clicked without a URL', async () => {
    renderPage();
    createEvent('Empty Event');

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Empty Event/i })).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole('button', { name: /Generate QR/i }));
    await waitFor(() => {
      expect(notifyError).toHaveBeenCalledWith('Enter a URL before generating.');
    });
  });

  it('persists events and QRs across renders via the API', async () => {
    const { unmount } = renderPage();
    createEvent('Persistent Event');

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Persistent Event/i })).toBeInTheDocument();
    });

    fireEvent.change(screen.getByPlaceholderText('e.g. Registration desk'), { target: { value: 'Persistent QR' } });
    fireEvent.change(screen.getByPlaceholderText('Enter URL here'), { target: { value: 'https://persist.com' } });
    await waitFor(() => expect(screen.getByRole('button', { name: /Generate QR/i })).not.toBeDisabled());
    fireEvent.click(screen.getByRole('button', { name: /Generate QR/i }));

    await waitFor(() => expect(screen.getByText('Persistent QR')).toBeInTheDocument());

    // Re-render simulating a page reload; the component re-fetches from the API.
    unmount();
    renderPage();

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Persistent Event/i })).toBeInTheDocument();
    });
    expect(screen.getByText('Persistent QR')).toBeInTheDocument();
  });
});
