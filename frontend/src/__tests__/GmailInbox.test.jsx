// Vitest + RTL coverage for pages/GmailInbox.jsx — the Gmail integration UI
// (connect status, message list, compose). fetchApi is mocked per-URL; the
// notify hook returns ONE stable object reference (RTL standing rule — a fresh
// object per render would loop the status useCallback).

import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, test, expect, beforeEach, vi } from 'vitest';

import GmailInbox from '../pages/GmailInbox';
import { fetchApi } from '../utils/api';

vi.mock('../utils/api', () => ({ fetchApi: vi.fn() }));

const notifyObj = { error: vi.fn(), info: vi.fn(), success: vi.fn(), confirm: vi.fn() };
vi.mock('../utils/notify', () => ({ useNotify: () => notifyObj }));

beforeEach(() => {
  vi.clearAllMocks();
});

describe('GmailInbox — not connected', () => {
  test('shows the Connect Gmail button when no mailbox is linked', async () => {
    fetchApi.mockImplementation((url) => {
      if (url.includes('/gmail/status')) return Promise.resolve({ connected: false });
      return Promise.resolve({});
    });
    render(<GmailInbox />);
    expect(await screen.findByRole('button', { name: /connect gmail/i })).toBeInTheDocument();
    expect(screen.getByText(/not connected/i)).toBeInTheDocument();
    // No message list / compose when disconnected.
    expect(screen.queryByRole('button', { name: /compose/i })).toBeNull();
  });
});

describe('GmailInbox — connected', () => {
  function mockConnected(messages = []) {
    fetchApi.mockImplementation((url) => {
      if (url.includes('/gmail/status')) {
        return Promise.resolve({ connected: true, emailAddress: 'agent@demo.test' });
      }
      if (url.includes('/gmail/messages')) return Promise.resolve({ messages });
      return Promise.resolve({});
    });
  }

  test('renders the connected address, Compose, and the message list', async () => {
    mockConnected([
      { id: 'm1', from: 'Client <c@example.com>', subject: 'Goa trip', snippet: 'See attached', date: '2026-06-16T10:00:00Z', unread: true },
    ]);
    render(<GmailInbox />);
    expect(await screen.findByText(/connected as agent@demo\.test/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /compose/i })).toBeInTheDocument();
    expect(await screen.findByText('Goa trip')).toBeInTheDocument();
    // Both status + messages endpoints were hit.
    const urls = fetchApi.mock.calls.map(([u]) => u);
    expect(urls.some((u) => u.includes('/gmail/status'))).toBe(true);
    expect(urls.some((u) => u.includes('/gmail/messages'))).toBe(true);
  });

  test('opening the composer and submitting empty shows a validation toast (no send call)', async () => {
    mockConnected([]);
    render(<GmailInbox />);
    fireEvent.click(await screen.findByRole('button', { name: /compose/i }));
    // Submit with empty To/body → client-side validation blocks the send.
    fireEvent.click(screen.getByRole('button', { name: /^send$/i }));
    expect(await screen.findByText(/recipient and a message body are required/i)).toBeInTheDocument();
    const urls = fetchApi.mock.calls.map(([u]) => u);
    expect(urls.some((u) => u.includes('/gmail/send'))).toBe(false);
  });

  test('composing a valid email POSTs to /gmail/send', async () => {
    mockConnected([]);
    render(<GmailInbox />);
    fireEvent.click(await screen.findByRole('button', { name: /compose/i }));
    fireEvent.change(screen.getByLabelText('To'), { target: { value: 'client@example.com' } });
    fireEvent.change(screen.getByLabelText('Subject'), { target: { value: 'Hello' } });
    // contentEditable body — set textContent directly and fire an input event.
    const bodyEl = screen.getByRole('textbox', { name: /message body/i });
    Object.defineProperty(bodyEl, 'textContent', { value: 'See you soon', writable: true, configurable: true });
    fireEvent.input(bodyEl, { target: { textContent: 'See you soon' } });
    fireEvent.click(screen.getByRole('button', { name: /^send$/i }));
    await waitFor(() => {
      const sendCall = fetchApi.mock.calls.find(([u]) => u.includes('/gmail/send'));
      expect(sendCall).toBeTruthy();
      expect(sendCall[1].method).toBe('POST');
      const body = JSON.parse(sendCall[1].body);
      expect(body.to).toBe('client@example.com');
    });
  });
});
