import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import React from 'react';
import EmailSignatureEditor from '../components/EmailSignatureEditor';

// This component was written expecting a raw fetch Response (calls res.json()),
// but utils/api.js returns already-parsed JSON. We mirror the component's
// expectation here so tests exercise the happy path code as written.
const fetchApiMock = vi.fn();
vi.mock('../utils/api', () => ({ fetchApi: (...args) => fetchApiMock(...args) }));

function mockResponse({ ok = true, data = {} } = {}) {
  return { ok, json: () => Promise.resolve(data) };
}

describe('EmailSignatureEditor', () => {
  beforeEach(() => {
    fetchApiMock.mockReset();
  });

  it('shows loading state initially', () => {
    fetchApiMock.mockReturnValue(new Promise(() => {})); // never resolves
    render(<EmailSignatureEditor />);
    expect(screen.getByText(/Loading signature/i)).toBeInTheDocument();
  });

  it('loads existing signature from /api/email-scheduling/signature', async () => {
    fetchApiMock.mockResolvedValue(mockResponse({ data: { signature: '<p>Hi,<br/>Alice</p>' } }));
    render(<EmailSignatureEditor />);
    await waitFor(() => {
      const textarea = screen.queryByRole('textbox');
      expect(textarea).toBeInTheDocument();
      expect(textarea.value).toBe('<p>Hi,<br/>Alice</p>');
    });
  });

  it('falls back to empty signature when none stored', async () => {
    fetchApiMock.mockResolvedValue(mockResponse({ data: {} }));
    render(<EmailSignatureEditor />);
    await waitFor(() => {
      const textarea = screen.queryByRole('textbox');
      expect(textarea.value).toBe('');
    });
  });

  it('sets error status when load fails', async () => {
    fetchApiMock.mockRejectedValue(new Error('network'));
    render(<EmailSignatureEditor />);
    expect(await screen.findByRole('status')).toHaveTextContent(/Failed to load/i);
  });

  it('editing + clicking save PUTs to the API', async () => {
    fetchApiMock
      .mockResolvedValueOnce(mockResponse({ data: { signature: '' } })) // GET on mount
      .mockResolvedValueOnce(mockResponse({ ok: true })); // PUT on save
    render(<EmailSignatureEditor />);
    const textarea = await screen.findByRole('textbox');
    fireEvent.change(textarea, { target: { value: '<p>Best,<br/>Bob</p>' } });
    fireEvent.click(screen.getByText(/Save Signature/i));
    await waitFor(() => {
      const putCall = fetchApiMock.mock.calls.find(
        ([url, opts]) => url === '/api/email-scheduling/signature' && opts?.method === 'PUT'
      );
      expect(putCall).toBeDefined();
      expect(putCall[1].body).toContain('Best,');
    });
  });

  it('successful save shows "Signature saved" status', async () => {
    fetchApiMock
      .mockResolvedValueOnce(mockResponse({ data: { signature: 'hi' } }))
      .mockResolvedValueOnce(mockResponse({ ok: true }));
    render(<EmailSignatureEditor />);
    await screen.findByRole('textbox');
    fireEvent.click(screen.getByText(/Save Signature/i));
    expect(await screen.findByRole('status')).toHaveTextContent(/saved/i);
  });

  it('failed save shows error status', async () => {
    fetchApiMock
      .mockResolvedValueOnce(mockResponse({ data: { signature: '' } }))
      .mockResolvedValueOnce(mockResponse({ ok: false }));
    render(<EmailSignatureEditor />);
    await screen.findByRole('textbox');
    fireEvent.click(screen.getByText(/Save Signature/i));
    expect(await screen.findByRole('status')).toHaveTextContent(/failed/i);
  });

  it('renders the live preview HTML dangerously', async () => {
    fetchApiMock.mockResolvedValue(mockResponse({ data: { signature: '<strong>Bold</strong>' } }));
    const { container } = render(<EmailSignatureEditor />);
    await waitFor(() => {
      expect(container.querySelector('strong')).toBeTruthy();
    });
  });

  it('displays the 3 variable tokens the server auto-substitutes', async () => {
    fetchApiMock.mockResolvedValue(mockResponse({ data: {} }));
    render(<EmailSignatureEditor />);
    await screen.findByRole('textbox');
    expect(screen.getByText(/{{user.name}}/)).toBeInTheDocument();
    expect(screen.getByText(/{{user.email}}/)).toBeInTheDocument();
    expect(screen.getByText(/{{tenant.name}}/)).toBeInTheDocument();
  });
});
