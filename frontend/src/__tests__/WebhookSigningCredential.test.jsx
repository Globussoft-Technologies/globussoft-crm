/**
 * WebhookSigningCredential.test.jsx — vitest + RTL coverage for the reusable
 * per-tenant HMAC signing-credential component (frontend/src/components/
 * WebhookSigningCredential.jsx). Rendered inside the Settings page.
 *
 * Backend contract pinned (all under /api/settings/webhook-credential):
 *   GET    → { exists, status, signingId, secretMasked, entitled, signing, ... }  (never `secret`)
 *   POST   → { ...status, secret, signing, warning }                              (show-once raw secret)
 *   POST /rotate → { ...status, secret, lastRotatedAt }                           (new show-once secret)
 *   DELETE → { success, status: 'REVOKED' }
 *
 * Contracts pinned here:
 *   1. entitled + no credential → "Generate signing secret" button enabled.
 *   2. NOT entitled + no credential → button disabled + "Upgrade to enable" link.
 *   3. active credential → signingId + status + receiver-config block render;
 *      the raw 64-hex secret NEVER renders (show-once model).
 *   4. generate → POSTs /api/settings/webhook-credential + reveals the
 *      show-once secret in a centered modal dialog (full key + Copy + Done).
 *   5. modal Done button closes the reveal.
 *   6. rotate → notify.confirm + POST /rotate + reveals the new secret in a modal.
 *   7. rotate cancelled → confirm:false means NO rotate POST.
 *   8. revoke → notify.confirm + DELETE.
 *   9. non-admin (GET 403 → component returns null) renders nothing.
 *
 * Stable mock pattern (2026-05-12 standing rule): notify is ONE object
 * reference for the whole module so hooks reading it in useCallback deps
 * don't trigger re-render loops.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';

const fetchApiMock = vi.fn();
vi.mock('../utils/api', () => ({
  fetchApi: (...args) => fetchApiMock(...args),
}));

const notifyError = vi.fn();
const notifySuccess = vi.fn();
const notifyConfirm = vi.fn();
const notifyObj = {
  error: notifyError,
  info: vi.fn(),
  success: notifySuccess,
  confirm: (...args) => notifyConfirm(...args),
};
vi.mock('../utils/notify', () => ({
  useNotify: () => notifyObj,
}));

import WebhookSigningCredential from '../components/WebhookSigningCredential';

const API = '/api/settings/webhook-credential';
const SIGNING = {
  header: 'X-Globussoft-Signature',
  algorithm: 'HMAC-SHA256',
  signedPayload: '<t>.<rawBody>',
  receiverEnvVar: 'WEBHOOK_HMAC_SECRET_CRM',
};
const credNone = (entitled) => ({
  exists: false, status: null, signingId: null, lastRotatedAt: null,
  createdAt: null, secretMasked: null, entitled,
  entitlementReason: entitled ? 'active_trial' : 'no_active_subscription',
  signing: SIGNING,
});
const credActive = {
  exists: true, status: 'ACTIVE', signingId: 'whid_abcd1234', lastRotatedAt: null,
  createdAt: '2026-01-01T00:00:00.000Z', secretMasked: 'whsec_••••••1234',
  entitled: true, entitlementReason: 'active_subscription', signing: SIGNING,
};
const RAW_SECRET = 'a'.repeat(64);

// Build a fetch mock returning `cred` for the credential GET; POST/rotate/DELETE
// return show-once / status payloads.
const withCred = (cred, overrides = {}) => (url, opts) => {
  if (url === API && (!opts || !opts.method || opts.method === 'GET')) {
    return Promise.resolve(cred);
  }
  if (url === API && opts?.method === 'POST') {
    return Promise.resolve(overrides.post ?? { ...credActive, secret: RAW_SECRET });
  }
  if (url === `${API}/rotate` && opts?.method === 'POST') {
    return Promise.resolve(overrides.rotate ?? { ...credActive, lastRotatedAt: '2026-02-02T00:00:00.000Z', secret: 'b'.repeat(64) });
  }
  if (url === API && opts?.method === 'DELETE') {
    return Promise.resolve({ success: true, ...credActive, status: 'REVOKED' });
  }
  return Promise.resolve(null);
};

describe('<WebhookSigningCredential />', () => {
  beforeEach(() => {
    fetchApiMock.mockReset();
    notifyError.mockReset();
    notifySuccess.mockReset();
    notifyConfirm.mockReset();
    notifyConfirm.mockResolvedValue(true);
  });

  it('entitled + no credential: Generate signing secret button is ENABLED', async () => {
    fetchApiMock.mockImplementation(withCred(credNone(true)));
    render(<WebhookSigningCredential />);
    const btn = await screen.findByRole('button', { name: /Generate signing secret/i });
    expect(btn).not.toBeDisabled();
  });

  it('NOT entitled + no credential: generate disabled + Upgrade link shown', async () => {
    fetchApiMock.mockImplementation(withCred(credNone(false)));
    render(<WebhookSigningCredential />);
    const btn = await screen.findByRole('button', { name: /Generate signing secret/i });
    expect(btn).toBeDisabled();
    expect(screen.getByText(/Upgrade to enable/i)).toBeInTheDocument();
  });

  it('active credential: shows signingId + status + receiver config, never the raw secret', async () => {
    fetchApiMock.mockImplementation(withCred(credActive));
    render(<WebhookSigningCredential />);
    expect(await screen.findByText('whid_abcd1234')).toBeInTheDocument();
    expect(screen.getByText('ACTIVE')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Rotate/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Revoke/i })).toBeInTheDocument();
    expect(screen.getByText(/X-Globussoft-Signature/)).toBeInTheDocument();
    expect(screen.getByText(/HMAC-SHA256/)).toBeInTheDocument();
    expect(screen.getByText(/WEBHOOK_HMAC_SECRET_CRM/)).toBeInTheDocument();
    expect(screen.getByText(/whsec_••••••1234/)).toBeInTheDocument();
    expect(screen.queryByText(new RegExp(RAW_SECRET))).not.toBeInTheDocument();
  });

  it('generate: POSTs the credential + reveals the show-once secret in a centered modal', async () => {
    fetchApiMock.mockImplementation(withCred(credNone(true)));
    render(<WebhookSigningCredential />);
    fireEvent.click(await screen.findByRole('button', { name: /Generate signing secret/i }));

    await waitFor(() => {
      const post = fetchApiMock.mock.calls.find(([u, o]) => u === API && o?.method === 'POST');
      expect(post).toBeTruthy();
    });
    // The full secret is revealed once, in a modal dialog (not a clipped toast).
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(RAW_SECRET)).toBeInTheDocument();
    expect(within(dialog).getByText(/only time/i)).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: /Copy secret/i })).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: /Done/i })).toBeInTheDocument();
  });

  it('reveal modal: Done closes it', async () => {
    fetchApiMock.mockImplementation(withCred(credNone(true)));
    render(<WebhookSigningCredential />);
    fireEvent.click(await screen.findByRole('button', { name: /Generate signing secret/i }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: /Done/i }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

  it('rotate: confirm + POST /rotate + reveals the new secret in a modal', async () => {
    fetchApiMock.mockImplementation(withCred(credActive));
    render(<WebhookSigningCredential />);
    fireEvent.click(await screen.findByRole('button', { name: /Rotate/i }));

    await waitFor(() => expect(notifyConfirm).toHaveBeenCalledWith(expect.stringMatching(/Rotate the webhook signing secret/i)));
    await waitFor(() => {
      const rot = fetchApiMock.mock.calls.find(([u, o]) => u === `${API}/rotate` && o?.method === 'POST');
      expect(rot).toBeTruthy();
    });
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('b'.repeat(64))).toBeInTheDocument();
  });

  it('rotate cancelled: confirm → false means NO rotate POST fires', async () => {
    fetchApiMock.mockImplementation(withCred(credActive));
    notifyConfirm.mockResolvedValue(false);
    render(<WebhookSigningCredential />);
    fireEvent.click(await screen.findByRole('button', { name: /Rotate/i }));
    await waitFor(() => expect(notifyConfirm).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 0));
    const rot = fetchApiMock.mock.calls.find(([u, o]) => u === `${API}/rotate` && o?.method === 'POST');
    expect(rot).toBeUndefined();
  });

  it('revoke: confirm + DELETE', async () => {
    fetchApiMock.mockImplementation(withCred(credActive));
    render(<WebhookSigningCredential />);
    fireEvent.click(await screen.findByRole('button', { name: /Revoke/i }));

    await waitFor(() => expect(notifyConfirm).toHaveBeenCalledWith(expect.stringMatching(/Revoke the webhook signing secret/i)));
    await waitFor(() => {
      const del = fetchApiMock.mock.calls.find(([u, o]) => u === API && o?.method === 'DELETE');
      expect(del).toBeTruthy();
    });
  });

  it('non-admin (GET rejects with 403) renders nothing', async () => {
    fetchApiMock.mockImplementation(() => Promise.reject(Object.assign(new Error('forbidden'), { status: 403 })));
    const { container } = render(<WebhookSigningCredential />);
    // Give the load() effect a tick to settle into the null-cred state.
    await new Promise((r) => setTimeout(r, 0));
    expect(container).toBeEmptyDOMElement();
  });
});
