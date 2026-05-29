/**
 * Signatures.test.jsx — vitest + RTL page-level coverage for the
 * E-Signature Requests page (frontend/src/pages/Signatures.jsx, 417 LOC).
 *
 * Authored by the autonomous test-writing cron — first test for this surface.
 *
 * The page manages e-signature requests for Contracts / Estimates / Quotes.
 * Surface = a status-grouped pills bar (PENDING / SIGNED / DECLINED / EXPIRED),
 * a single requests table (Document / Signer / Email / Status / Sent / Signed
 * / Actions), an action row per request with View + (conditional) Resend +
 * (conditional) Cancel buttons, a Create modal (document-type select →
 * documents select → signer name/email + expires-in-days form), and a View
 * modal that may show a Captured Signature image when status === 'SIGNED'.
 *
 * Scope-pinned invariants — 10 cases:
 *
 *   1. Page renders the heading + descriptor + "Request Signature" CTA.
 *   2. Initial mount fetches /api/signatures AND /api/contracts (default
 *      documentType is 'Contract' so loadDocOptions hits /api/contracts).
 *   3. Renders one row per signature request with documentType+id, signer,
 *      and email; plus the StatusBadge text.
 *   4. The status counter pills render with the correct N counts per
 *      status — pin shape "N STATUS" inside one pill per status group.
 *   5. Empty state: "No signature requests yet…" renders when /api/signatures
 *      returns [].
 *   6. PENDING rows show Resend + Cancel; SIGNED rows show neither.
 *   7. Clicking the View button opens the View modal and GETs the detail
 *      endpoint /api/signatures/<id>; modal renders signer/email/status row.
 *   8. Cancel button: notify.confirm() resolving false short-circuits;
 *      confirm() resolving true fires DELETE /api/signatures/<id>.
 *   9. Create modal: clicking "Request Signature" opens the modal with the
 *      Document Type / Signer Name / Signer Email / Expires inputs.
 *  10. Submitting Create without picking a document fires notify.error and
 *      does NOT POST; submitting with a valid documentId POSTs /api/signatures
 *      with the body shape { documentType, documentId(int), signerName,
 *      signerEmail, expiresInDays(int) }.
 *
 * Drift note: the page also renders a Captured Signature image in the View
 * modal when status === 'SIGNED' AND viewing.signature/details.signature is
 * truthy. This is covered indirectly via the View-modal open assertion in
 * case 7 (PENDING request — no signature image expected; absence is implicit
 * via the conditional render branch). The SIGNED-with-image branch is
 * intentionally not pinned here to keep the spec scoped to the daily-use
 * surface (PENDING-heavy in practice).
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

const fetchApiMock = vi.fn();
vi.mock('../utils/api', () => ({
  fetchApi: (...args) => fetchApiMock(...args),
  getAuthToken: () => 'test-token',
}));

// Stable mock-object identity for useNotify per CLAUDE.md standing rule
// "RTL: stable mock object references for hooks used in useCallback deps".
const notifyError = vi.fn();
const notifySuccess = vi.fn();
const notifyInfo = vi.fn();
const notifyConfirm = vi.fn(() => Promise.resolve(true));
const notifyObj = {
  error: notifyError,
  info: notifyInfo,
  success: notifySuccess,
  confirm: (...args) => notifyConfirm(...args),
};
vi.mock('../utils/notify', () => ({
  useNotify: () => notifyObj,
}));

vi.mock('../utils/date', () => ({
  formatDate: (d) => (d ? new Date(d).toISOString().slice(0, 10) : '—'),
}));

import Signatures from '../pages/Signatures';

const sampleRequests = [
  {
    id: 1,
    documentType: 'Contract',
    documentId: 42,
    signerName: 'Anita Sharma',
    signerEmail: 'anita@example.com',
    status: 'PENDING',
    createdAt: '2026-04-01T10:00:00.000Z',
    signedAt: null,
    expiresAt: '2026-04-08T10:00:00.000Z',
  },
  {
    id: 2,
    documentType: 'Estimate',
    documentId: 17,
    signerName: 'Rohit Verma',
    signerEmail: 'rohit@example.com',
    status: 'SIGNED',
    createdAt: '2026-03-15T10:00:00.000Z',
    signedAt: '2026-03-18T12:30:00.000Z',
    expiresAt: '2026-03-22T10:00:00.000Z',
  },
  {
    id: 3,
    documentType: 'Quote',
    documentId: 9,
    signerName: 'Priya Patel',
    signerEmail: 'priya@example.com',
    status: 'DECLINED',
    createdAt: '2026-03-20T10:00:00.000Z',
    signedAt: null,
    expiresAt: '2026-03-27T10:00:00.000Z',
  },
];

const sampleContracts = [
  { id: 42, title: 'MSA — Acme Corp' },
  { id: 43, title: 'SOW — Beta Industries' },
];

// SUT's docLabel reads `d.title || d.estimateNum || `Estimate #${d.id}``
// — give the estimate fixture a recognizable title so the option-name
// assertions below survive the Contract→Estimate default switch.
const sampleEstimates = [
  { id: 42, title: 'MSA — Acme Corp', estimateNum: 'EST-042' },
  { id: 43, title: 'SOW — Beta Industries', estimateNum: 'EST-043' },
];

function defaultFetchMock(url, opts) {
  if (url === '/api/signatures' && (!opts || !opts.method || opts.method === 'GET')) {
    return Promise.resolve(sampleRequests);
  }
  if (url === '/api/contracts') return Promise.resolve(sampleContracts);
  if (url === '/api/estimates') return Promise.resolve(sampleEstimates);
  if (url === '/api/quotes') return Promise.resolve([]);
  // GET /api/signatures/<id> — detail endpoint hit by view().
  if (/^\/api\/signatures\/\d+$/.test(url) && (!opts || !opts.method || opts.method === 'GET')) {
    const id = parseInt(url.split('/').pop(), 10);
    const found = sampleRequests.find((r) => r.id === id);
    return Promise.resolve(found || null);
  }
  return Promise.resolve(null);
}

function renderSignatures() {
  return render(
    <MemoryRouter>
      <Signatures />
    </MemoryRouter>,
  );
}

describe('<Signatures /> — page surface', () => {
  beforeEach(() => {
    fetchApiMock.mockReset();
    fetchApiMock.mockImplementation(defaultFetchMock);
    notifyError.mockReset();
    notifySuccess.mockReset();
    notifyInfo.mockReset();
    notifyConfirm.mockReset();
    notifyConfirm.mockImplementation(() => Promise.resolve(true));
  });

  it('renders the heading + descriptor + Request Signature CTA', async () => {
    renderSignatures();
    expect(
      await screen.findByRole('heading', { name: /E-Signature Requests/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/Send documents for secure electronic signature/i),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /Request Signature/i }),
    ).toBeInTheDocument();
  });

  it('initial mount fetches /api/signatures AND /api/estimates (default documentType=Estimate)', async () => {
    // Drift: the SUT's default documentType moved from Contract → Estimate
    // and ENDPOINT_FOR_TYPE only carries Estimate now (Signatures.jsx:28+36).
    renderSignatures();
    await waitFor(() => {
      const sigCall = fetchApiMock.mock.calls.find(([u]) => u === '/api/signatures');
      expect(sigCall).toBeTruthy();
    });
    await waitFor(() => {
      const docCall = fetchApiMock.mock.calls.find(([u]) => u === '/api/estimates');
      expect(docCall).toBeTruthy();
    });
  });

  it('renders one row per signature request with documentType+id, signer, email, and status', async () => {
    renderSignatures();
    expect(await screen.findByText('Anita Sharma')).toBeInTheDocument();
    expect(screen.getByText('Rohit Verma')).toBeInTheDocument();
    expect(screen.getByText('Priya Patel')).toBeInTheDocument();
    // Emails render inline.
    expect(screen.getByText('anita@example.com')).toBeInTheDocument();
    expect(screen.getByText('rohit@example.com')).toBeInTheDocument();
    expect(screen.getByText('priya@example.com')).toBeInTheDocument();
    // Document cell renders "<Type> #<id>".
    expect(screen.getByText('Contract #42')).toBeInTheDocument();
    expect(screen.getByText('Estimate #17')).toBeInTheDocument();
    expect(screen.getByText('Quote #9')).toBeInTheDocument();
    // StatusBadge renders the literal status text — each appears in both
    // the pills bar AND the row badge, so use getAllByText for the duplicate.
    expect(screen.getAllByText('PENDING').length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText('SIGNED').length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText('DECLINED').length).toBeGreaterThanOrEqual(1);
  });

  it('renders status counter pills with N counts per status', async () => {
    renderSignatures();
    // Wait until data settles so the pill counts reflect the seeded shape:
    // 1 PENDING, 1 SIGNED, 1 DECLINED, 0 EXPIRED.
    await screen.findByText('Anita Sharma');
    expect(screen.getByText(/^1 PENDING$/)).toBeInTheDocument();
    expect(screen.getByText(/^1 SIGNED$/)).toBeInTheDocument();
    expect(screen.getByText(/^1 DECLINED$/)).toBeInTheDocument();
    expect(screen.getByText(/^0 EXPIRED$/)).toBeInTheDocument();
  });

  it('renders the empty-state message when /api/signatures returns []', async () => {
    fetchApiMock.mockImplementation((url) => {
      if (url === '/api/signatures') return Promise.resolve([]);
      if (url === '/api/contracts') return Promise.resolve([]);
      return Promise.resolve(null);
    });
    renderSignatures();
    expect(
      await screen.findByText(/No signature requests yet\./i),
    ).toBeInTheDocument();
  });

  it('PENDING rows render Resend + Cancel; SIGNED rows render neither', async () => {
    renderSignatures();
    await screen.findByText('Anita Sharma');
    // The PENDING row (Anita) renders both Resend and Cancel.
    // There's exactly 1 PENDING request in the seed, so one Resend button total.
    const resendBtns = screen.getAllByRole('button', { name: /^Resend$/ });
    expect(resendBtns.length).toBe(1);
    // 2 Cancel buttons (PENDING + DECLINED — only SIGNED hides cancel).
    const cancelBtns = screen.getAllByRole('button', { name: /^Cancel$/ });
    expect(cancelBtns.length).toBe(2);
    // SIGNED row (Rohit) has no Resend on its row — implied by total count = 1.
    // 3 View buttons (one per row).
    expect(screen.getAllByRole('button', { name: /^View$/ }).length).toBe(3);
  });

  it('clicking View opens the View modal and GETs /api/signatures/<id>', async () => {
    renderSignatures();
    await screen.findByText('Anita Sharma');

    fetchApiMock.mockClear();
    const viewBtns = screen.getAllByRole('button', { name: /^View$/ });
    fireEvent.click(viewBtns[0]); // Anita's row — id=1.

    // Detail fetch fires for /api/signatures/1.
    await waitFor(() => {
      const detailCall = fetchApiMock.mock.calls.find(
        ([u]) => u === '/api/signatures/1',
      );
      expect(detailCall).toBeTruthy();
    });
    // Modal title is "<type> #<id>" — load-bearing pin that the View
    // modal actually opened.
    expect(
      await screen.findByRole('heading', { name: /Contract #42/ }),
    ).toBeInTheDocument();
    // Modal renders the row labels — "Signer" + "Email" appear in BOTH
    // the table column headers AND the modal's Row k/v list. Use
    // getAllByText for the duplicate; assert length >= 2 (one column
    // header + one modal row).
    expect(screen.getAllByText('Signer').length).toBeGreaterThanOrEqual(2);
    expect(screen.getAllByText('Email').length).toBeGreaterThanOrEqual(2);
  });

  it('Cancel: confirm() false short-circuits; confirm() true fires DELETE /api/signatures/<id>', async () => {
    renderSignatures();
    await screen.findByText('Anita Sharma');

    // First click: confirm resolves false — no DELETE fires.
    notifyConfirm.mockImplementationOnce(() => Promise.resolve(false));
    fetchApiMock.mockClear();
    const cancelBtns = screen.getAllByRole('button', { name: /^Cancel$/ });
    fireEvent.click(cancelBtns[0]); // first Cancel = Anita (id=1, PENDING).
    await waitFor(() => expect(notifyConfirm).toHaveBeenCalled());
    const noDelete = fetchApiMock.mock.calls.find(
      ([, opts]) => opts?.method === 'DELETE',
    );
    expect(noDelete).toBeUndefined();

    // Second click: confirm resolves true (default) — DELETE fires.
    fetchApiMock.mockClear();
    notifyConfirm.mockClear();
    notifyConfirm.mockImplementation(() => Promise.resolve(true));
    fireEvent.click(cancelBtns[0]);
    await waitFor(() => {
      const deleteCall = fetchApiMock.mock.calls.find(
        ([u, opts]) => u === '/api/signatures/1' && opts?.method === 'DELETE',
      );
      expect(deleteCall).toBeTruthy();
    });
  });

  it('clicking "Request Signature" opens the Create modal with the expected form fields', async () => {
    // Drift: the documentType select was removed when ENDPOINT_FOR_TYPE
    // narrowed to Estimate-only (Signatures.jsx:35). Modal now exposes
    // a single document <select> + signer inputs + submit.
    renderSignatures();
    await screen.findByText('Anita Sharma');

    fireEvent.click(screen.getByRole('button', { name: /Request Signature/i }));

    const selects = await screen.findAllByRole('combobox');
    expect(selects.length).toBeGreaterThanOrEqual(1);
    // Signer Name + Signer Email inputs render with the placeholder hints.
    expect(screen.getByPlaceholderText(/Jane Doe/i)).toBeInTheDocument();
    expect(screen.getByPlaceholderText(/jane@example\.com/i)).toBeInTheDocument();
    // Submit button renders.
    expect(
      screen.getByRole('button', { name: /Send Signature Request/i }),
    ).toBeInTheDocument();
  });

  it('Create: submitting without picking a document fires notify.error and does NOT POST', async () => {
    renderSignatures();
    await screen.findByText('Anita Sharma');

    fireEvent.click(screen.getByRole('button', { name: /Request Signature/i }));

    // Fill name/email but leave documentId empty. The HTML5 `required` on
    // the document <select> would normally block a click-driven submit in
    // jsdom (constraint validation runs on the submitter button); use
    // fireEvent.submit(form) to dispatch the submit event directly so the
    // page's own `if (!form.documentId)` runtime guard is exercised.
    fireEvent.change(screen.getByPlaceholderText(/Jane Doe/i), {
      target: { value: 'Test Signer' },
    });
    fireEvent.change(screen.getByPlaceholderText(/jane@example\.com/i), {
      target: { value: 'test@example.com' },
    });

    fetchApiMock.mockClear();
    const submitBtn = screen.getByRole('button', {
      name: /Send Signature Request/i,
    });
    const form = submitBtn.closest('form');
    expect(form).toBeTruthy();
    fireEvent.submit(form);

    await waitFor(() => {
      expect(notifyError).toHaveBeenCalledWith(
        expect.stringMatching(/Pick a document to send for signature/i),
      );
    });
    const postCall = fetchApiMock.mock.calls.find(
      ([u, opts]) => u === '/api/signatures' && opts?.method === 'POST',
    );
    expect(postCall).toBeUndefined();
  });

  it('Create: submitting with a valid documentId POSTs /api/signatures with the parsed body shape', async () => {
    renderSignatures();
    await screen.findByText('Anita Sharma');

    fireEvent.click(screen.getByRole('button', { name: /Request Signature/i }));

    // Wait for the estimate options to populate the document <select>
    // (page-mount loadDocOptions targets /api/estimates by default).
    await waitFor(() => {
      expect(screen.getByText('MSA — Acme Corp')).toBeInTheDocument();
    });

    // Document type select was removed (Estimate-only world); only the
    // documentId select remains in the form now.
    const selects = screen.getAllByRole('combobox');
    expect(selects.length).toBeGreaterThanOrEqual(1);
    const docSelect = selects[0];
    fireEvent.change(docSelect, { target: { value: '42' } });

    fireEvent.change(screen.getByPlaceholderText(/Jane Doe/i), {
      target: { value: 'Test Signer' },
    });
    fireEvent.change(screen.getByPlaceholderText(/jane@example\.com/i), {
      target: { value: 'test@example.com' },
    });

    fetchApiMock.mockClear();
    const submitBtn = screen.getByRole('button', {
      name: /Send Signature Request/i,
    });
    const form = submitBtn.closest('form');
    fireEvent.submit(form);

    await waitFor(() => {
      const postCall = fetchApiMock.mock.calls.find(
        ([u, opts]) => u === '/api/signatures' && opts?.method === 'POST',
      );
      expect(postCall).toBeTruthy();
      const body = JSON.parse(postCall[1].body);
      // Pinned shape: documentId/expiresInDays parsed to int; default
      // documentType=Estimate (Signatures.jsx:28).
      expect(body.documentType).toBe('Estimate');
      expect(body.documentId).toBe(42);
      expect(typeof body.documentId).toBe('number');
      expect(body.signerName).toBe('Test Signer');
      expect(body.signerEmail).toBe('test@example.com');
      expect(body.expiresInDays).toBe(7);
      expect(typeof body.expiresInDays).toBe('number');
    });
  });
});
