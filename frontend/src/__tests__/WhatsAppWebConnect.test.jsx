import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const fetchApiMock = vi.fn();
vi.mock('../utils/api', () => ({
  fetchApi: (...args) => fetchApiMock(...args),
  getAuthToken: () => 'test-token',
}));

const notifyObj = {
  error: vi.fn(),
  info: vi.fn(),
  success: vi.fn(),
  confirm: vi.fn(),
  prompt: vi.fn(),
};
vi.mock('../utils/notify', () => ({ useNotify: () => notifyObj }));

vi.mock('socket.io-client', () => ({ io: () => ({ on: vi.fn(), off: vi.fn(), emit: vi.fn(), disconnect: vi.fn() }) }));

import WhatsAppWebConnect from '../pages/wellness/whatsapp/WhatsAppWebConnect';

describe('<WhatsAppWebConnect />', () => {
  beforeEach(() => {
    fetchApiMock.mockReset();
    notifyObj.error.mockReset();
    notifyObj.info.mockReset();
    notifyObj.confirm.mockReset();
    notifyObj.prompt.mockReset();

    fetchApiMock.mockImplementation((url, opts) => {
      const method = opts?.method || 'GET';
      if (url === '/api/whatsapp-web/status') {
        return Promise.resolve({ connected: false, state: 'DISCONNECTED', phone: null });
      }
      if (url === '/api/whatsapp-web/connect' && method === 'POST') {
        return Promise.resolve({ connected: false, state: 'QR', qr: 'data:image/png;base64,qr-code' });
      }
      if (url === '/api/whatsapp-web/qr') {
        return Promise.resolve({ connected: false, state: 'QR', qr: 'data:image/png;base64,qr-code' });
      }
      if (url === '/api/whatsapp-web/me') {
        return Promise.resolve({ phone: '919800000000', name: 'Demo User', about: 'Hello' });
      }
      if (url === '/api/whatsapp-web/me/avatar' && method === 'POST') {
        return Promise.resolve({ ok: true });
      }
      return Promise.resolve({});
    });
  });

  it('renders the QR connect modal with the caution CTA and a theme-variable surface', async () => {
    const user = userEvent.setup();
    render(<WhatsAppWebConnect apiBase="/api/whatsapp-web" isAdmin tenantId={null} />);

    expect(await screen.findByTestId('wati-status-strip')).toHaveTextContent(/WhatsApp not connected/i);
    await user.click(screen.getByTestId('wa-connect-btn'));

    const modal = await screen.findByTestId('wa-qr-modal');
    expect(modal).toBeInTheDocument();
    expect(screen.getByText('Link WhatsApp')).toBeInTheDocument();
    expect(screen.getByText('Scan to link this device')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Read WhatsApp safety measures/i })).toBeInTheDocument();

    const panel = screen.getByText('Link WhatsApp').parentElement;
    expect(panel?.getAttribute('style') || '').toContain('var(--surface-color, var(--bg-color, #fff))');

    await user.click(screen.getByTestId('wa-safety-open'));
    expect(await screen.findByTestId('wa-safety-guide')).toBeInTheDocument();
    expect(screen.getByText('WhatsApp safety measures')).toBeInTheDocument();
    expect(screen.getByText(/Device connection limits/i)).toBeInTheDocument();
    expect(screen.getByText(/Behave like a human/i)).toBeInTheDocument();
  });

  it('keeps the profile modal on the same theme-aware surface', async () => {
    const user = userEvent.setup();
    fetchApiMock.mockImplementation((url, opts) => {
      const method = opts?.method || 'GET';
      if (url === '/api/whatsapp-web/status') {
        return Promise.resolve({ connected: true, state: 'CONNECTED', phone: '919800000000' });
      }
      if (url === '/api/whatsapp-web/me') {
        return Promise.resolve({ phone: '919800000000', name: 'Demo User', about: 'Hello' });
      }
      if (url === '/api/whatsapp-web/me/avatar' && method === 'POST') {
        return Promise.resolve({});
      }
      return Promise.resolve({});
    });

    render(<WhatsAppWebConnect apiBase="/api/whatsapp-web" isAdmin tenantId={null} />);
    await screen.findByText(/WhatsApp connected/i);

    await user.click(screen.getByTestId('wa-profile-btn'));
    const modal = await screen.findByTestId('wa-profile-modal');
    expect(modal).toBeInTheDocument();
    const panel = screen.getByText('My WhatsApp profile').parentElement;
    expect(panel?.getAttribute('style') || '').toContain('var(--surface-color, var(--bg-color, #fff))');
  });
});
