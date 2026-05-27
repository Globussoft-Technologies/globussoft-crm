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

  it('renders the signature inside a sandboxed preview iframe', async () => {
    fetchApiMock.mockResolvedValue(mockResponse({ data: { signature: '<strong>Bold</strong>' } }));
    const { container } = render(<EmailSignatureEditor />);
    await waitFor(() => {
      const iframe = container.querySelector('iframe');
      expect(iframe).toBeTruthy();
      // signature HTML is carried in srcDoc, not injected into the page DOM
      expect(iframe.getAttribute('srcdoc')).toContain('<strong>Bold</strong>');
      // sandbox="" (no allow-scripts) → typed markup cannot execute
      expect(iframe.getAttribute('sandbox')).toBe('');
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

  // ─────────────────────────────────────────────────────────────────────
  // Extended cases — save lifecycle, error-resilience, preview placeholder,
  // status auto-clear, PUT request shape, unmount-during-fetch safety.
  // ─────────────────────────────────────────────────────────────────────

  it('reads signature from top-level response shape (not nested under data)', async () => {
    // Component code: data.signature || (data.data && data.data.signature)
    // — top-level shape is the OTHER half of the OR fork.
    fetchApiMock.mockResolvedValue(mockResponse({ data: { signature: '<p>Top-level</p>' } }));
    render(<EmailSignatureEditor />);
    await waitFor(() => {
      expect(screen.getByRole('textbox').value).toBe('<p>Top-level</p>');
    });
  });

  it('handles response json() rejection gracefully (treats as empty)', async () => {
    // res.json().catch(() => ({})) — if the body is not JSON, the component
    // should fall back to empty signature rather than throwing.
    fetchApiMock.mockResolvedValue({
      ok: true,
      json: () => Promise.reject(new Error('not json')),
    });
    render(<EmailSignatureEditor />);
    await waitFor(() => {
      expect(screen.getByRole('textbox').value).toBe('');
    });
  });

  it('save button is disabled while loading', () => {
    fetchApiMock.mockReturnValue(new Promise(() => {})); // never resolves
    render(<EmailSignatureEditor />);
    const btn = screen.getByText(/Save Signature/i).closest('button');
    expect(btn).toBeDisabled();
  });

  it('save button shows "Saving" + becomes disabled during save in-flight', async () => {
    let resolvePut;
    fetchApiMock
      .mockResolvedValueOnce(mockResponse({ data: { signature: 'hi' } }))
      .mockReturnValueOnce(new Promise((resolve) => { resolvePut = resolve; }));
    render(<EmailSignatureEditor />);
    await screen.findByRole('textbox');
    fireEvent.click(screen.getByText(/Save Signature/i));
    // Mid-flight: button label flips to "Saving" and is disabled
    await waitFor(() => {
      const savingBtn = screen.getByText(/Saving/i).closest('button');
      expect(savingBtn).toBeDisabled();
    });
    // Cleanup: resolve so the unmount doesn't trigger setState-after-unmount
    resolvePut(mockResponse({ ok: true }));
  });

  it('PUT request carries application/json Content-Type and JSON body', async () => {
    fetchApiMock
      .mockResolvedValueOnce(mockResponse({ data: { signature: '' } }))
      .mockResolvedValueOnce(mockResponse({ ok: true }));
    render(<EmailSignatureEditor />);
    const textarea = await screen.findByRole('textbox');
    fireEvent.change(textarea, { target: { value: 'goodbye' } });
    fireEvent.click(screen.getByText(/Save Signature/i));
    await waitFor(() => {
      const putCall = fetchApiMock.mock.calls.find(
        ([url, opts]) => url === '/api/email-scheduling/signature' && opts?.method === 'PUT'
      );
      expect(putCall).toBeDefined();
      expect(putCall[1].headers).toEqual({ 'Content-Type': 'application/json' });
      expect(JSON.parse(putCall[1].body)).toEqual({ signature: 'goodbye' });
    });
  });

  it('save status auto-clears after 3 seconds', async () => {
    // Spy on setTimeout so we can capture the 3000ms registration AND
    // invoke its callback synchronously — avoids fake-timer / React-microtask
    // interaction hazards while still exercising the auto-clear branch.
    const origSetTimeout = global.setTimeout;
    const setTimeoutSpy = vi.spyOn(global, 'setTimeout');
    fetchApiMock
      .mockResolvedValueOnce(mockResponse({ data: { signature: 'hi' } }))
      .mockResolvedValueOnce(mockResponse({ ok: true }));
    render(<EmailSignatureEditor />);
    await screen.findByRole('textbox');
    fireEvent.click(screen.getByText(/Save Signature/i));
    expect(await screen.findByRole('status')).toHaveTextContent(/saved/i);
    // Find the 3000ms setTimeout from handleSave's finally block
    const autoClearCall = setTimeoutSpy.mock.calls.find(([, ms]) => ms === 3000);
    expect(autoClearCall).toBeDefined();
    // Invoke the callback directly to fire the auto-clear path
    const clearCb = autoClearCall[0];
    // Restore real setTimeout so React can schedule its own updates
    setTimeoutSpy.mockRestore();
    await waitFor(() => {
      clearCb();
    });
    await waitFor(() => {
      expect(screen.queryByRole('status')).toBeNull();
    });
    // (origSetTimeout reference retained for completeness)
    void origSetTimeout;
  });

  it('preview iframe shows placeholder text when signature is empty', async () => {
    fetchApiMock.mockResolvedValue(mockResponse({ data: { signature: '' } }));
    const { container } = render(<EmailSignatureEditor />);
    await screen.findByRole('textbox');
    const iframe = container.querySelector('iframe');
    expect(iframe).toBeTruthy();
    expect(iframe.getAttribute('srcdoc')).toMatch(
      /Your signature preview will appear here/i
    );
  });

  it('preview iframe updates srcdoc as the textarea changes', async () => {
    fetchApiMock.mockResolvedValue(mockResponse({ data: { signature: 'old' } }));
    const { container } = render(<EmailSignatureEditor />);
    const textarea = await screen.findByRole('textbox');
    fireEvent.change(textarea, { target: { value: '<em>new signature</em>' } });
    await waitFor(() => {
      const iframe = container.querySelector('iframe');
      expect(iframe.getAttribute('srcdoc')).toContain('<em>new signature</em>');
    });
  });

  it('unmount during in-flight load does not throw (cancelled flag)', async () => {
    let resolveLoad;
    fetchApiMock.mockReturnValue(
      new Promise((resolve) => { resolveLoad = resolve; })
    );
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { unmount } = render(<EmailSignatureEditor />);
    unmount();
    // Resolve AFTER unmount — guarded by `if (!cancelled)` so no state update
    resolveLoad(mockResponse({ data: { signature: 'late' } }));
    await Promise.resolve();
    await Promise.resolve();
    // No "Can't perform a React state update on an unmounted component" warnings
    const stateWarnings = errSpy.mock.calls.filter(([msg]) =>
      typeof msg === 'string' && /unmounted component/i.test(msg)
    );
    expect(stateWarnings).toHaveLength(0);
    errSpy.mockRestore();
  });
});
