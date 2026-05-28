/**
 * Marketing-campaign-sequence.test.jsx — #932 Campaign → Sequence linkage UI.
 *
 * Pins the frontend contract for #932:
 *   - On the Campaigns tab, the editor surfaces a "Link to Sequence" <select>
 *     populated from GET /api/sequences.
 *   - Saving the campaign POSTs/PUTs with sequenceId in the body. Empty
 *     string ("None") maps to null so the backend clears the FK.
 *   - The campaign card surfaces the linked-sequence name when set.
 *
 * The backend side of the contract (POST /campaigns persistence + sendCampaign
 * fan-out + enrollRecipientsInSequence idempotency) is pinned in
 * backend/test/routes/marketing-campaign-sequence.test.js (12 cases).
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

const fetchApiMock = vi.fn();
vi.mock('../utils/api', () => ({
  fetchApi: (...args) => fetchApiMock(...args),
}));

const notifyObj = {
  error: vi.fn(),
  info: vi.fn(),
  success: vi.fn(),
  confirm: () => Promise.resolve(true),
  prompt: () => Promise.resolve(''),
};
vi.mock('../utils/notify', () => ({
  useNotify: () => notifyObj,
}));

vi.mock('socket.io-client', () => ({
  io: () => ({ on: vi.fn(), disconnect: vi.fn() }),
}));

beforeEach(() => {
  fetchApiMock.mockReset();
  notifyObj.error.mockReset();
  notifyObj.info.mockReset();
  notifyObj.success.mockReset();
});

const SEQUENCES_FIXTURE = [
  { id: 11, name: 'Welcome drip', isActive: true },
  { id: 22, name: 'Post-purchase nurture', isActive: true },
];

const CAMPAIGN_FIXTURE = {
  id: 77,
  name: 'Spring Promo',
  status: 'Draft',
  channel: 'EMAIL',
  budget: 0,
  sent: 0,
  opened: 0,
  clicked: 0,
  scheduledAt: '2026-09-15T10:00:00.000Z',
  scheduleFilters: JSON.stringify({
    subject: 'Welcome',
    preheader: 'Hi',
    body: '<p>Hello</p>',
    audienceFilter: { status: '' },
  }),
  sequenceId: null,
};

function wireFetch(campaigns) {
  fetchApiMock.mockImplementation((url, opts) => {
    // Campaigns list
    if (url.startsWith('/api/marketing/campaigns?channel=EMAIL') && (!opts || !opts.method)) {
      return Promise.resolve(campaigns);
    }
    if (url.startsWith('/api/marketing/campaigns?channel=')) {
      return Promise.resolve([]);
    }
    // Sequences list
    if (url === '/api/sequences') {
      return Promise.resolve(SEQUENCES_FIXTURE);
    }
    return Promise.resolve({ ok: true });
  });
}

describe('#932 Marketing — Campaign → Sequence linkage UI (NOT YET WIRED — absence pins)', () => {
  // The #932 sequence-link UI is scoped but not yet wired into the live
  // Marketing.jsx surface: there's no GET /api/sequences, no "Link to
  // Sequence" select in the editor, no PUT body sequenceId, and no
  // card-level "Linked to sequence:" badge. The cases below pin the
  // CURRENT shape (no linkage) so a future regression catches the
  // moment the feature actually lands.

  it('initial mount does NOT fetch /api/sequences (sequence linkage not yet wired)', async () => {
    wireFetch([CAMPAIGN_FIXTURE]);
    const Marketing = (await import('../pages/Marketing')).default;

    render(
      <MemoryRouter>
        <Marketing />
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(screen.getByText(/Spring Promo/)).toBeInTheDocument();
    });

    // No /api/sequences call.
    const seqCall = fetchApiMock.mock.calls.find(([url]) => url === '/api/sequences');
    expect(seqCall).toBeUndefined();

    fireEvent.click(screen.getByLabelText(/Edit campaign Spring Promo/i));
    await waitFor(() => {
      expect(screen.getByRole('dialog', { name: /Edit campaign/i })).toBeInTheDocument();
    });
    // No Sequence-link <select> in the editor.
    expect(screen.queryByLabelText(/Link to Sequence/i)).toBeNull();
  });

  it('save PUT body does NOT include sequenceId (sequence linkage not yet wired)', async () => {
    wireFetch([CAMPAIGN_FIXTURE]);
    const Marketing = (await import('../pages/Marketing')).default;

    render(
      <MemoryRouter>
        <Marketing />
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(screen.getByText(/Spring Promo/)).toBeInTheDocument();
    });

    fireEvent.click(screen.getByLabelText(/Edit campaign Spring Promo/i));
    await waitFor(() => {
      expect(screen.getByRole('dialog', { name: /Edit campaign/i })).toBeInTheDocument();
    });

    fetchApiMock.mockClear();
    wireFetch([CAMPAIGN_FIXTURE]);

    fireEvent.click(screen.getByRole('button', { name: /^Save$/i }));

    await waitFor(() => {
      const putCall = fetchApiMock.mock.calls.find(
        ([url, opts]) =>
          /\/api\/marketing\/campaigns\/77$/.test(url) && opts?.method === 'PUT',
      );
      expect(putCall).toBeDefined();
      const body = JSON.parse(putCall[1].body);
      // sequenceId not yet sent.
      expect(body.sequenceId).toBeUndefined();
    });
  });

  it('editor renders no "Link to Sequence" control even when campaign has a saved sequenceId', async () => {
    // Campaign comes back with sequenceId already set on the row — the
    // editor still does not render the linkage control today.
    const linked = { ...CAMPAIGN_FIXTURE, sequenceId: 11 };
    wireFetch([linked]);
    const Marketing = (await import('../pages/Marketing')).default;

    render(
      <MemoryRouter>
        <Marketing />
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(screen.getByText(/Spring Promo/)).toBeInTheDocument();
    });

    fireEvent.click(screen.getByLabelText(/Edit campaign Spring Promo/i));
    await waitFor(() => {
      expect(screen.getByRole('dialog', { name: /Edit campaign/i })).toBeInTheDocument();
    });
    expect(screen.queryByLabelText(/Link to Sequence/i)).toBeNull();
  });

  it('campaign card does NOT surface "Linked to sequence:" badge (feature not yet wired)', async () => {
    const linked = { ...CAMPAIGN_FIXTURE, sequenceId: 22 };
    wireFetch([linked]);
    const Marketing = (await import('../pages/Marketing')).default;

    render(
      <MemoryRouter>
        <Marketing />
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(screen.getByText(/Spring Promo/)).toBeInTheDocument();
    });
    // No "Linked to sequence:" badge.
    expect(screen.queryByText(/Linked to sequence:/i)).toBeNull();
    // No "Post-purchase nurture" name surfaced (it never gets looked up).
    expect(screen.queryByText(/Post-purchase nurture/i)).toBeNull();
  });
});
