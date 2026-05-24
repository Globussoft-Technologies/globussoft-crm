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

describe('#932 Marketing — Campaign → Sequence linkage UI', () => {
  it('sequence dropdown renders with options sourced from GET /api/sequences', async () => {
    wireFetch([CAMPAIGN_FIXTURE]);
    const Marketing = (await import('../pages/Marketing')).default;

    render(
      <MemoryRouter>
        <Marketing />
      </MemoryRouter>,
    );

    // Wait until the campaign card lands.
    await waitFor(() => {
      expect(screen.getByText(/Spring Promo/)).toBeInTheDocument();
    });

    // Sequences list call happened.
    await waitFor(() => {
      const seqCall = fetchApiMock.mock.calls.find(([url]) => url === '/api/sequences');
      expect(seqCall).toBeDefined();
    });

    // Open the editor.
    fireEvent.click(screen.getByLabelText(/Edit campaign Spring Promo/i));
    await waitFor(() => {
      expect(screen.getByRole('dialog', { name: /Edit campaign/i })).toBeInTheDocument();
    });

    // Sequence <select> exists with all options.
    const seqSelect = screen.getByLabelText(/Link to Sequence/i);
    expect(seqSelect).toBeInTheDocument();
    // The "None" option + the two sequences from /api/sequences.
    expect(seqSelect.querySelectorAll('option')).toHaveLength(3);
    expect(seqSelect.querySelector('option[value="11"]').textContent).toMatch(/Welcome drip/);
    expect(seqSelect.querySelector('option[value="22"]').textContent).toMatch(/Post-purchase nurture/);
  });

  it('selecting a sequence + saving posts sequenceId in the PUT body', async () => {
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

    const seqSelect = screen.getByLabelText(/Link to Sequence/i);
    fireEvent.change(seqSelect, { target: { value: '22' } });

    fetchApiMock.mockClear();
    // Re-wire after mockClear (the implementation reference was reset).
    wireFetch([CAMPAIGN_FIXTURE]);

    fireEvent.click(screen.getByRole('button', { name: /^Save$/i }));

    await waitFor(() => {
      const putCall = fetchApiMock.mock.calls.find(
        ([url, opts]) =>
          /\/api\/marketing\/campaigns\/77$/.test(url) && opts?.method === 'PUT',
      );
      expect(putCall).toBeDefined();
      const body = JSON.parse(putCall[1].body);
      // Frontend sends the sequenceId verbatim (backend parseInt's it).
      expect(body.sequenceId).toBe('22');
    });
  });

  it('clearing the linkage (None) sends sequenceId: null in the PUT body', async () => {
    // Campaign starts already linked to sequence 11.
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

    const seqSelect = screen.getByLabelText(/Link to Sequence/i);
    // The pre-populated value reflects the saved linkage.
    expect(seqSelect.value).toBe('11');

    // Change to "None".
    fireEvent.change(seqSelect, { target: { value: '' } });

    fetchApiMock.mockClear();
    wireFetch([linked]);

    fireEvent.click(screen.getByRole('button', { name: /^Save$/i }));

    await waitFor(() => {
      const putCall = fetchApiMock.mock.calls.find(
        ([url, opts]) =>
          /\/api\/marketing\/campaigns\/77$/.test(url) && opts?.method === 'PUT',
      );
      expect(putCall).toBeDefined();
      const body = JSON.parse(putCall[1].body);
      expect(body.sequenceId).toBeNull();
    });
  });

  it('campaign card surfaces the linked sequence name', async () => {
    const linked = { ...CAMPAIGN_FIXTURE, sequenceId: 22 };
    wireFetch([linked]);
    const Marketing = (await import('../pages/Marketing')).default;

    render(
      <MemoryRouter>
        <Marketing />
      </MemoryRouter>,
    );

    // Wait for both campaign + sequence lists to land so the lookup resolves.
    await waitFor(() => {
      expect(screen.getByText(/Linked to sequence:/i)).toBeInTheDocument();
    });
    // The name from the sequence-fixture lookup, not the raw id.
    expect(screen.getByText(/Post-purchase nurture/i)).toBeInTheDocument();
  });
});
