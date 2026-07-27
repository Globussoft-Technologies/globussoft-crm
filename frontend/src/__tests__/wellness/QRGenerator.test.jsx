/**
 * QRGenerator.test.jsx — vitest + RTL coverage for the simplified wellness
 * marketing QR Generator page.
 *
 * Scope:
 *   1. Renders the page header and source options.
 *   2. Generates a live QR preview via qrcode.toDataURL when the user types.
 *   3. Presets build correct URLs:
 *        - Public Booking Page -> /wellness/book-appointment
 *        - Buy Gift Cards     -> /wellness/buy-giftcards
 *   4. Generate QR button saves the current configuration to history.
 *   5. History items can be restored and deleted.
 *   6. Download button works once a QR preview exists.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
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

import QRGenerator from '../../pages/wellness/QRGenerator';
import { AuthContext } from '../../App';

const TEST_ORIGIN = 'https://crm.example.com';
const TEST_TENANT_ID = 42;

function renderPage() {
  return render(
    <MemoryRouter>
      <AuthContext.Provider value={{ tenant: { id: TEST_TENANT_ID, slug: 'enhanced-wellness' }, user: { role: 'ADMIN' } }}>
        <QRGenerator />
      </AuthContext.Provider>
    </MemoryRouter>
  );
}

beforeEach(() => {
  vi.restoreAllMocks();
  toDataURLMock.mockResolvedValue('data:image/png;base64,MOCK');
  toCanvasMock.mockResolvedValue(undefined);
  notifySuccess.mockReset();
  notifyError.mockReset();
  localStorage.clear();
  if (typeof window !== 'undefined') {
    Object.defineProperty(window, 'location', {
      writable: true,
      value: { origin: TEST_ORIGIN },
    });
  }
});

afterEach(() => {
  localStorage.clear();
});

describe('QRGenerator', () => {
  it('renders the page header and source options', () => {
    renderPage();
    expect(screen.getByText('QR Generator')).toBeInTheDocument();
    expect(screen.getByText('Custom URL / Text')).toBeInTheDocument();
    expect(screen.getByText('Public Booking Page')).toBeInTheDocument();
    expect(screen.getByText('Buy Gift Cards')).toBeInTheDocument();
  });

  it('generates a QR preview when the user enters custom text', async () => {
    renderPage();
    const input = screen.getByTitle('The URL or text encoded in the QR code.');
    fireEvent.change(input, { target: { value: 'https://example.com/offer' } });

    await waitFor(() => {
      expect(toDataURLMock).toHaveBeenCalledWith(
        'https://example.com/offer',
        expect.objectContaining({
          width: 256,
          margin: 2,
          color: { dark: '#000000', light: '#ffffff' },
          errorCorrectionLevel: 'M',
        })
      );
    });

    expect(screen.getByAltText('QR code preview')).toBeInTheDocument();
  });

  it('uses the authenticated booking page URL for the Public Booking Page preset', async () => {
    renderPage();
    fireEvent.click(screen.getByText('Public Booking Page'));

    await waitFor(() => {
      expect(toDataURLMock).toHaveBeenCalledWith(
        `${TEST_ORIGIN}/wellness/book-appointment`,
        expect.any(Object)
      );
    });

    const input = screen.getByTitle('The URL or text encoded in the QR code.');
    expect(input.value).toBe(`${TEST_ORIGIN}/wellness/book-appointment`);
  });

  it('uses the gift-card storefront URL for the Buy Gift Cards preset', async () => {
    renderPage();
    fireEvent.click(screen.getByText('Buy Gift Cards'));

    await waitFor(() => {
      expect(toDataURLMock).toHaveBeenCalledWith(
        `${TEST_ORIGIN}/wellness/buy-giftcards`,
        expect.any(Object)
      );
    });

    const input = screen.getByTitle('The URL or text encoded in the QR code.');
    expect(input.value).toBe(`${TEST_ORIGIN}/wellness/buy-giftcards`);
  });

  it('saves the current configuration to history when Generate QR is clicked', async () => {
    renderPage();
    const input = screen.getByTitle('The URL or text encoded in the QR code.');
    fireEvent.change(input, { target: { value: 'https://example.com/offer' } });

    await waitFor(() => expect(screen.getByRole('button', { name: /Generate QR/i })).not.toBeDisabled());
    fireEvent.click(screen.getByRole('button', { name: /Generate QR/i }));

    await waitFor(() => {
      expect(notifySuccess).toHaveBeenCalledWith('QR saved to history');
    });

    expect(screen.getByText('History')).toBeInTheDocument();
    const historySection = screen.getByText('History').closest('div').parentElement;
    expect(historySection).toBeTruthy();
    const historyUrl = historySection.querySelector('[style*="font-family: monospace"]');
    expect(historyUrl.textContent).toBe('https://example.com/offer');
  });

  it('restores a history item when Restore is clicked', async () => {
    renderPage();
    const input = screen.getByTitle('The URL or text encoded in the QR code.');
    fireEvent.change(input, { target: { value: 'https://first.com' } });
    await waitFor(() => expect(screen.getByRole('button', { name: /Generate QR/i })).not.toBeDisabled());
    fireEvent.click(screen.getByRole('button', { name: /Generate QR/i }));
    await waitFor(() => expect(notifySuccess).toHaveBeenCalledWith('QR saved to history'));

    // Switch to a different source/text.
    fireEvent.click(screen.getByText('Public Booking Page'));
    await waitFor(() => {
      expect(input.value).toBe(`${TEST_ORIGIN}/wellness/book-appointment`);
    });

    fireEvent.click(screen.getByRole('button', { name: /Restore/i }));
    expect(input.value).toBe('https://first.com');
  });

  it('deletes a history item when the trash button is clicked', async () => {
    renderPage();
    const input = screen.getByTitle('The URL or text encoded in the QR code.');
    fireEvent.change(input, { target: { value: 'https://delete.me' } });
    await waitFor(() => expect(screen.getByRole('button', { name: /Generate QR/i })).not.toBeDisabled());
    fireEvent.click(screen.getByRole('button', { name: /Generate QR/i }));
    await waitFor(() => expect(screen.getByText('History')).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: /Delete from history/i }));
    expect(screen.queryByText('History')).not.toBeInTheDocument();
  });

  it('downloads a QR from history with the saved design settings', async () => {
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click');
    renderPage();
    const input = screen.getByTitle('The URL or text encoded in the QR code.');
    fireEvent.change(input, { target: { value: 'https://history.com' } });
    await waitFor(() => expect(screen.getByRole('button', { name: /Generate QR/i })).not.toBeDisabled());

    fireEvent.change(screen.getByLabelText('Size (256px)'), { target: { value: '512' } });
    fireEvent.change(screen.getByLabelText('QR foreground color'), { target: { value: '#123456' } });
    fireEvent.change(screen.getByLabelText('QR background color'), { target: { value: '#abcdef' } });

    fireEvent.click(screen.getByRole('button', { name: /Generate QR/i }));
    await waitFor(() => expect(screen.getByText('History')).toBeInTheDocument());

    toDataURLMock.mockClear();
    fireEvent.click(screen.getByTitle('Download this QR again'));

    await waitFor(() => {
      expect(toDataURLMock).toHaveBeenCalledWith(
        'https://history.com',
        expect.objectContaining({
          width: 512,
          color: { dark: '#123456', light: '#abcdef' },
        })
      );
    });
    await waitFor(() => {
      expect(notifySuccess).toHaveBeenCalledWith('QR code downloaded');
    });
    expect(clickSpy).toHaveBeenCalled();
    clickSpy.mockRestore();
  });

  it('downloads the QR code and shows a success toast', async () => {
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click');
    renderPage();
    const input = screen.getByTitle('The URL or text encoded in the QR code.');
    fireEvent.change(input, { target: { value: 'https://example.com/offer' } });

    await waitFor(() => expect(screen.getByRole('button', { name: /Download PNG/i })).not.toBeDisabled());
    fireEvent.click(screen.getByRole('button', { name: /Download PNG/i }));

    await waitFor(() => {
      expect(notifySuccess).toHaveBeenCalledWith('QR code downloaded');
    });
    expect(clickSpy).toHaveBeenCalled();
    clickSpy.mockRestore();
  });

  it('updates the QR when design options change', async () => {
    renderPage();
    const input = screen.getByTitle('The URL or text encoded in the QR code.');
    fireEvent.change(input, { target: { value: 'https://example.com/offer' } });

    await waitFor(() => expect(toDataURLMock).toHaveBeenCalled());
    toDataURLMock.mockClear();

    fireEvent.change(screen.getByLabelText('Size (256px)'), { target: { value: '512' } });

    await waitFor(() => {
      expect(toDataURLMock).toHaveBeenCalledWith(
        'https://example.com/offer',
        expect.objectContaining({ width: 512 })
      );
    });
  });

  it('shows an error toast when Generate QR is clicked with empty text', async () => {
    renderPage();
    fireEvent.click(screen.getByRole('button', { name: /Generate QR/i }));
    await waitFor(() => {
      expect(notifyError).toHaveBeenCalledWith('Enter a URL or text before generating.');
    });
  });

  it('persists history in localStorage across renders', async () => {
    renderPage();
    const input = screen.getByTitle('The URL or text encoded in the QR code.');
    fireEvent.change(input, { target: { value: 'https://persist.com' } });
    await waitFor(() => expect(screen.getByRole('button', { name: /Generate QR/i })).not.toBeDisabled());
    fireEvent.click(screen.getByRole('button', { name: /Generate QR/i }));
    await waitFor(() => expect(screen.getByText('History')).toBeInTheDocument());

    // Re-render simulating a page reload.
    renderPage();
    const historyItem = screen.getAllByText('https://persist.com').find((el) =>
      el.closest('[style*="font-family: monospace"]')
    );
    expect(historyItem).toBeTruthy();
  });
});
