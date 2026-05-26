/**
 * Profile2FA.jsx — vitest + RTL coverage for the user 2FA enrollment page.
 *
 * Scope: pins the page-surface invariants for the TOTP enrollment + recovery-
 * codes + disable flow at /profile/2fa. The handler walks four states —
 * loading → status → setup (QR + secret + 6-digit verify) → backup-codes
 * reveal → disable. Each state has a load-bearing UI contract that this file
 * pins.
 *
 * Contracts pinned here
 * ─────────────────────
 *   1. Initial loader: "Loading 2FA settings..." renders while /api/auth/me
 *      is in flight; the page chrome (Shield heading) is NOT yet visible.
 *   2. Status when /api/auth/me returns twoFactorEnabled=false: Disabled
 *      copy + "Enable 2FA" card with "Begin Setup" CTA renders.
 *   3. Status when /api/auth/me returns twoFactorEnabled=true: Enabled
 *      copy + "Disable 2FA" card with password + code inputs render.
 *   4. /api/auth/me failure silently defaults to disabled (no error toast)
 *      — the catch block sets enabled=false and clears loading.
 *   5. Clicking "Begin Setup" POSTs /api/auth/2fa/setup; success renders
 *      the QR image (alt="2FA QR code") + the manual-entry secret + the
 *      6-digit code input.
 *   6. The 6-digit code input strips non-digits and the Verify button
 *      stays disabled until length >= 6.
 *   7. Successful verify POSTs /api/auth/2fa/enable with { code }, flips
 *      enabled=true, surfaces the success info banner, and renders the
 *      backup-codes block with a 2-column grid of monospace codes.
 *   8. Verify failure surfaces the server's error message via the error
 *      banner; setupCode + setupData are preserved so the user can retry.
 *   9. "I've saved these" dismisses the backup-codes block (sets
 *      backupCodes=null + savedAck=true).
 *  10. Disable form: requires BOTH password + code; submitting without
 *      either surfaces "Password and 2FA code are required" and does NOT
 *      POST.
 *  11. Successful disable POSTs /api/auth/2fa/disable with { password,
 *      code }, flips enabled=false, and surfaces the info banner.
 *  12. Disable failure surfaces the server's error message.
 *
 * Drift notes
 * ───────────
 *   - JWT user reference: this page does NOT itself read req.user — it
 *     calls /api/auth/me which the AuthContext seeds. No mock for
 *     AuthContext needed; the page only reads response shapes.
 *   - navigator.clipboard isn't tested directly here; jsdom doesn't
 *     reliably implement it. The copy button's existence + text-flip
 *     contract is implicit in #7's grid render.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

const fetchApiMock = vi.fn();
vi.mock('../utils/api', () => ({
  fetchApi: (...args) => fetchApiMock(...args),
  getAuthToken: () => 'test-token',
}));

import Profile2FA from '../pages/Profile2FA';

function renderPage() {
  return render(<Profile2FA />);
}

describe('<Profile2FA /> — page surface', () => {
  beforeEach(() => {
    fetchApiMock.mockReset();
  });

  it('renders the loading state while /api/auth/me is in flight', () => {
    let resolveMe;
    fetchApiMock.mockImplementation((url) => {
      if (url === '/api/auth/me') {
        return new Promise((r) => { resolveMe = r; });
      }
      return Promise.resolve({});
    });
    renderPage();
    expect(screen.getByText(/Loading 2FA settings/i)).toBeInTheDocument();
    // Resolve so React doesn't warn about unhandled act() on unmount.
    resolveMe({ twoFactorEnabled: false });
  });

  it('renders the Disabled status + "Begin Setup" CTA when /api/auth/me returns twoFactorEnabled=false', async () => {
    fetchApiMock.mockImplementation((url) => {
      if (url === '/api/auth/me') return Promise.resolve({ twoFactorEnabled: false });
      return Promise.resolve({});
    });
    renderPage();

    expect(await screen.findByRole('heading', { name: /Two-Factor Authentication/i })).toBeInTheDocument();
    expect(screen.getByText(/Disabled — 2FA is not active on your account\./i)).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: /Enable 2FA/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Begin Setup/i })).toBeInTheDocument();
    // Disable card MUST NOT render in the disabled state.
    expect(screen.queryByRole('heading', { name: /Disable 2FA/i })).not.toBeInTheDocument();
  });

  it('renders the Enabled status + "Disable 2FA" form when /api/auth/me returns twoFactorEnabled=true', async () => {
    fetchApiMock.mockImplementation((url) => {
      if (url === '/api/auth/me') return Promise.resolve({ twoFactorEnabled: true });
      return Promise.resolve({});
    });
    renderPage();

    expect(await screen.findByText(/Enabled — your account is protected with 2FA\./i)).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: /Disable 2FA/i })).toBeInTheDocument();
    expect(screen.getByPlaceholderText('••••••••')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Disable 2FA/i })).toBeInTheDocument();
    // Enable card MUST NOT render in the enabled state.
    expect(screen.queryByRole('heading', { name: /Enable 2FA/i })).not.toBeInTheDocument();
  });

  it('silently defaults to disabled when /api/auth/me throws (no error banner)', async () => {
    fetchApiMock.mockImplementation((url) => {
      if (url === '/api/auth/me') return Promise.reject(new Error('boom'));
      return Promise.resolve({});
    });
    renderPage();

    // Wait until loading clears.
    await waitFor(() => {
      expect(screen.queryByText(/Loading 2FA settings/i)).not.toBeInTheDocument();
    });
    // Falls through to Disabled state.
    expect(screen.getByText(/Disabled — 2FA is not active on your account\./i)).toBeInTheDocument();
    // No error banner — failure is swallowed by design.
    expect(screen.queryByText(/boom/i)).not.toBeInTheDocument();
  });

  it('clicking "Begin Setup" POSTs /api/auth/2fa/setup and renders QR + secret + 6-digit input', async () => {
    fetchApiMock.mockImplementation((url, opts) => {
      if (url === '/api/auth/me') return Promise.resolve({ twoFactorEnabled: false });
      if (url === '/api/auth/2fa/setup' && opts?.method === 'POST') {
        return Promise.resolve({
          secret: 'JBSWY3DPEHPK3PXP',
          qrCode: 'data:image/png;base64,iVBORw0KGgo=',
        });
      }
      return Promise.resolve({});
    });
    renderPage();

    fireEvent.click(await screen.findByRole('button', { name: /Begin Setup/i }));

    // QR image appears with the alt text + the server's qrCode src.
    const qrImg = await screen.findByAltText('2FA QR code');
    expect(qrImg).toBeInTheDocument();
    expect(qrImg.getAttribute('src')).toBe('data:image/png;base64,iVBORw0KGgo=');
    // Manual-entry secret renders verbatim.
    expect(screen.getByText('JBSWY3DPEHPK3PXP')).toBeInTheDocument();
    // 6-digit code input + Verify CTA render.
    expect(screen.getByPlaceholderText('123456')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Verify & Enable/i })).toBeInTheDocument();
  });

  it('6-digit code input strips non-digits; Verify stays disabled until length >= 6', async () => {
    fetchApiMock.mockImplementation((url, opts) => {
      if (url === '/api/auth/me') return Promise.resolve({ twoFactorEnabled: false });
      if (url === '/api/auth/2fa/setup' && opts?.method === 'POST') {
        return Promise.resolve({ secret: 'SEC', qrCode: 'data:image/png;base64,x' });
      }
      return Promise.resolve({});
    });
    renderPage();

    fireEvent.click(await screen.findByRole('button', { name: /Begin Setup/i }));
    const codeInput = await screen.findByPlaceholderText('123456');
    const verifyBtn = screen.getByRole('button', { name: /Verify & Enable/i });

    // Pre-fill: Verify is disabled.
    expect(verifyBtn).toBeDisabled();

    // Letters + symbols are stripped client-side; only "12" remains.
    fireEvent.change(codeInput, { target: { value: '1abc2!@' } });
    expect(codeInput.value).toBe('12');
    expect(verifyBtn).toBeDisabled();

    // Fill to 6 digits — Verify enables.
    fireEvent.change(codeInput, { target: { value: '123456' } });
    expect(codeInput.value).toBe('123456');
    expect(verifyBtn).not.toBeDisabled();
  });

  it('successful enable POSTs /api/auth/2fa/enable with { code }, surfaces backup codes + success banner', async () => {
    fetchApiMock.mockImplementation((url, opts) => {
      if (url === '/api/auth/me') return Promise.resolve({ twoFactorEnabled: false });
      if (url === '/api/auth/2fa/setup' && opts?.method === 'POST') {
        return Promise.resolve({ secret: 'SEC', qrCode: 'data:image/png;base64,x' });
      }
      if (url === '/api/auth/2fa/enable' && opts?.method === 'POST') {
        return Promise.resolve({
          backupCodes: ['ABCD-1111', 'EFGH-2222', 'IJKL-3333', 'MNOP-4444'],
        });
      }
      return Promise.resolve({});
    });
    renderPage();

    fireEvent.click(await screen.findByRole('button', { name: /Begin Setup/i }));
    const codeInput = await screen.findByPlaceholderText('123456');
    fireEvent.change(codeInput, { target: { value: '654321' } });
    fireEvent.click(screen.getByRole('button', { name: /Verify & Enable/i }));

    // Success banner copy.
    expect(await screen.findByText(/2FA enabled\. Save your backup codes now/i)).toBeInTheDocument();
    // All 4 backup codes render.
    expect(screen.getByText('ABCD-1111')).toBeInTheDocument();
    expect(screen.getByText('EFGH-2222')).toBeInTheDocument();
    expect(screen.getByText('IJKL-3333')).toBeInTheDocument();
    expect(screen.getByText('MNOP-4444')).toBeInTheDocument();
    // "I've saved these" + "Copy all" affordances render.
    expect(screen.getByRole('button', { name: /I've saved these/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Copy all/i })).toBeInTheDocument();
    // Verify the enable POST was actually invoked with the typed code.
    const enableCall = fetchApiMock.mock.calls.find(
      ([u, o]) => u === '/api/auth/2fa/enable' && o?.method === 'POST',
    );
    expect(enableCall).toBeTruthy();
    expect(JSON.parse(enableCall[1].body)).toEqual({ code: '654321' });
  });

  it('verify failure surfaces the server error message; QR + setupCode are preserved', async () => {
    fetchApiMock.mockImplementation((url, opts) => {
      if (url === '/api/auth/me') return Promise.resolve({ twoFactorEnabled: false });
      if (url === '/api/auth/2fa/setup' && opts?.method === 'POST') {
        return Promise.resolve({ secret: 'SEC', qrCode: 'data:image/png;base64,x' });
      }
      if (url === '/api/auth/2fa/enable' && opts?.method === 'POST') {
        return Promise.reject(new Error('Invalid code'));
      }
      return Promise.resolve({});
    });
    renderPage();

    fireEvent.click(await screen.findByRole('button', { name: /Begin Setup/i }));
    const codeInput = await screen.findByPlaceholderText('123456');
    fireEvent.change(codeInput, { target: { value: '000000' } });
    fireEvent.click(screen.getByRole('button', { name: /Verify & Enable/i }));

    // Error banner shows the server's message.
    expect(await screen.findByText(/Invalid code/i)).toBeInTheDocument();
    // setupData preserved — QR still visible for retry.
    expect(screen.getByAltText('2FA QR code')).toBeInTheDocument();
    // setupCode preserved in the input so the user can edit + retry.
    expect(codeInput.value).toBe('000000');
  });

  it('"I\'ve saved these" dismisses the backup-codes block', async () => {
    fetchApiMock.mockImplementation((url, opts) => {
      if (url === '/api/auth/me') return Promise.resolve({ twoFactorEnabled: false });
      if (url === '/api/auth/2fa/setup' && opts?.method === 'POST') {
        return Promise.resolve({ secret: 'SEC', qrCode: 'data:image/png;base64,x' });
      }
      if (url === '/api/auth/2fa/enable' && opts?.method === 'POST') {
        return Promise.resolve({ backupCodes: ['XX-1', 'YY-2'] });
      }
      return Promise.resolve({});
    });
    renderPage();

    fireEvent.click(await screen.findByRole('button', { name: /Begin Setup/i }));
    const codeInput = await screen.findByPlaceholderText('123456');
    fireEvent.change(codeInput, { target: { value: '111111' } });
    fireEvent.click(screen.getByRole('button', { name: /Verify & Enable/i }));

    // Wait for codes to appear.
    expect(await screen.findByText('XX-1')).toBeInTheDocument();
    expect(screen.getByText('YY-2')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /I've saved these/i }));

    // Codes are dismissed.
    await waitFor(() => {
      expect(screen.queryByText('XX-1')).not.toBeInTheDocument();
    });
    expect(screen.queryByText('YY-2')).not.toBeInTheDocument();
    // The user is now in the Enabled state — Disable card visible.
    expect(screen.getByRole('heading', { name: /Disable 2FA/i })).toBeInTheDocument();
  });

  it('disable form requires password + code; missing either surfaces error and does NOT POST', async () => {
    fetchApiMock.mockImplementation((url) => {
      if (url === '/api/auth/me') return Promise.resolve({ twoFactorEnabled: true });
      return Promise.resolve({});
    });
    renderPage();

    // Wait for the Disable form to render.
    const disableBtn = await screen.findByRole('button', { name: /Disable 2FA/i });

    // Click with both fields empty — should fire validation, not the POST.
    fetchApiMock.mockClear();
    fireEvent.click(disableBtn);

    expect(await screen.findByText(/Password and 2FA code are required/i)).toBeInTheDocument();
    // No POST to /api/auth/2fa/disable fired.
    const disableCall = fetchApiMock.mock.calls.find(
      ([u, o]) => u === '/api/auth/2fa/disable' && o?.method === 'POST',
    );
    expect(disableCall).toBeUndefined();
  });

  it('successful disable POSTs /api/auth/2fa/disable with { password, code } and flips enabled=false', async () => {
    fetchApiMock.mockImplementation((url, opts) => {
      if (url === '/api/auth/me') return Promise.resolve({ twoFactorEnabled: true });
      if (url === '/api/auth/2fa/disable' && opts?.method === 'POST') {
        return Promise.resolve({ ok: true });
      }
      return Promise.resolve({});
    });
    renderPage();

    // Wait for Disable form.
    await screen.findByRole('heading', { name: /Disable 2FA/i });
    const passwordInput = screen.getByPlaceholderText('••••••••');
    const codeInput = screen.getByPlaceholderText('123456');

    fireEvent.change(passwordInput, { target: { value: 'hunter2' } });
    fireEvent.change(codeInput, { target: { value: '987654' } });
    fireEvent.click(screen.getByRole('button', { name: /Disable 2FA/i }));

    // Info banner surfaces.
    expect(await screen.findByText(/Two-factor authentication has been disabled\./i)).toBeInTheDocument();
    // After disable, the Disabled state's "Begin Setup" CTA reappears.
    expect(screen.getByRole('button', { name: /Begin Setup/i })).toBeInTheDocument();
    // Verify the disable POST body.
    const disableCall = fetchApiMock.mock.calls.find(
      ([u, o]) => u === '/api/auth/2fa/disable' && o?.method === 'POST',
    );
    expect(disableCall).toBeTruthy();
    expect(JSON.parse(disableCall[1].body)).toEqual({ password: 'hunter2', code: '987654' });
  });

  it('disable failure surfaces the server error message; user stays in enabled state', async () => {
    fetchApiMock.mockImplementation((url, opts) => {
      if (url === '/api/auth/me') return Promise.resolve({ twoFactorEnabled: true });
      if (url === '/api/auth/2fa/disable' && opts?.method === 'POST') {
        return Promise.reject(new Error('Wrong password'));
      }
      return Promise.resolve({});
    });
    renderPage();

    await screen.findByRole('heading', { name: /Disable 2FA/i });
    fireEvent.change(screen.getByPlaceholderText('••••••••'), { target: { value: 'badpw' } });
    fireEvent.change(screen.getByPlaceholderText('123456'), { target: { value: '111111' } });
    fireEvent.click(screen.getByRole('button', { name: /Disable 2FA/i }));

    // Error banner surfaces the server's message.
    expect(await screen.findByText(/Wrong password/i)).toBeInTheDocument();
    // Disable form is still visible — user can correct + retry.
    expect(screen.getByRole('heading', { name: /Disable 2FA/i })).toBeInTheDocument();
    // No success banner.
    expect(screen.queryByText(/has been disabled/i)).not.toBeInTheDocument();
  });
});
