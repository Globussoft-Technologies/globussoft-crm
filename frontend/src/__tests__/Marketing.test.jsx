/**
 * Marketing.test.jsx — broad page-surface vitest coverage for /pages/Marketing.jsx.
 *
 * Complement to the focused Marketing-campaign-sequence.test.jsx (which pins
 * the #932 Campaign → Sequence linkage UI). This file pins the wider
 * Marketing-page chrome:
 *   - Page header ("Marketing") + description copy.
 *   - 4-tab strip (Email Campaigns / SMS Campaigns / Push Campaigns /
 *     Embedded Forms) renders + the Email tab is the default.
 *   - Email tab: empty-state copy when /api/marketing/campaigns?channel=EMAIL
 *     returns []; campaign cards render with name + status + Stat tiles
 *     when populated.
 *   - Create-Campaign button opens the role="dialog" Create modal with the
 *     name input, max-length counter, and the XSS-looking-input warning hint.
 *   - Edit-Campaign dialog opens on card click + has Save/Send Now/Delete CTAs.
 *   - Tab switching: clicking SMS triggers GET ?channel=SMS; clicking FORMS
 *     triggers GET ?channel=FORM; clicking PUSH renders the Push placeholder.
 *   - SMS tab: composer form has recipient + body inputs with the 480-char
 *     body counter + a Send SMS button.
 *   - Push tab: renders the "Open Push Templates & Settings" deep-link CTA
 *     pointing at /channels?tab=push.
 *   - Forms tab: renders the Builder column heading + Embed Snippet column
 *     heading; "Add Form Field" CTA appends a new field row.
 *
 * Stable mock-object reference for useNotify (per the 2026-05-08 RTL standing
 * rule — fresh objects per render trigger infinite re-render loops via
 * useCallback dependencies). fetchApi mocked via a switch on the requested
 * URL so each test can vary fixture data without re-wiring.
 *
 * Backend contracts touched by the page (read-only here — POSTs/PUTs are
 * pinned by Marketing-campaign-sequence.test.jsx + the backend route tests):
 *   GET /api/marketing/campaigns?channel=EMAIL
 *   GET /api/marketing/campaigns?channel=SMS
 *   GET /api/marketing/campaigns?channel=FORM
 *   GET /api/sequences
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

const fetchApiMock = vi.fn();
vi.mock('../utils/api', () => ({
  fetchApi: (...args) => fetchApiMock(...args),
}));

// Stable mock object reference — fresh-per-render breaks useCallback identity
// and triggers infinite re-render loops in components that pass notify into
// effect deps. (Standing rule, 2026-05-08.)
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

import { AuthContext } from '../App';
import Marketing from '../pages/Marketing';

const GENERIC_USER = {
  userId: 1,
  name: 'Admin',
  email: 'admin@globussoft.com',
  role: 'ADMIN',
  tenant: { id: 1, vertical: 'generic' },
};

const SAMPLE_CAMPAIGNS = [
  {
    id: 100,
    name: 'Q4 Holiday Promo',
    status: 'Draft',
    channel: 'EMAIL',
    budget: 0,
    sent: 250,
    opened: 35,
    clicked: 12,
    scheduledAt: null,
    scheduleFilters: null,
    sequenceId: null,
  },
  {
    id: 101,
    name: 'Spring Newsletter',
    status: 'Active',
    channel: 'EMAIL',
    budget: 100,
    sent: 1000,
    opened: 42,
    clicked: 18,
    scheduledAt: null,
    scheduleFilters: null,
    sequenceId: null,
  },
];

function wireFetch({ campaigns = SAMPLE_CAMPAIGNS, sms = [], forms = [], sequences = [] } = {}) {
  fetchApiMock.mockImplementation((url) => {
    if (typeof url !== 'string') return Promise.resolve(null);
    if (url.startsWith('/api/marketing/campaigns?channel=EMAIL')) {
      return Promise.resolve(campaigns);
    }
    if (url.startsWith('/api/marketing/campaigns?channel=SMS')) {
      return Promise.resolve(sms);
    }
    if (url.startsWith('/api/marketing/campaigns?channel=FORM')) {
      return Promise.resolve(forms);
    }
    if (url === '/api/sequences') {
      return Promise.resolve(sequences);
    }
    return Promise.resolve(null);
  });
}

function renderMarketing(user = GENERIC_USER) {
  return render(
    <MemoryRouter>
      <AuthContext.Provider value={{ user, token: 'tk', tenant: user.tenant, loading: false }}>
        <Marketing />
      </AuthContext.Provider>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  fetchApiMock.mockReset();
  notifyObj.error.mockReset();
  notifyObj.info.mockReset();
  notifyObj.success.mockReset();
});

describe('<Marketing /> — broad page surface', () => {
  it('renders the page heading + description copy', async () => {
    wireFetch();
    renderMarketing();
    await waitFor(() => {
      expect(screen.getByRole('heading', { name: /^Marketing$/i })).toBeInTheDocument();
    });
    expect(
      screen.getByText(/Manage outbound campaigns and inbound lead capture forms/i),
    ).toBeInTheDocument();
  });

  it('renders all 4 tab buttons (Email / SMS / Push / Forms)', async () => {
    wireFetch();
    renderMarketing();
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Email Campaigns/i })).toBeInTheDocument();
    });
    expect(screen.getByRole('button', { name: /SMS Campaigns/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Push Campaigns/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Embedded Forms/i })).toBeInTheDocument();
  });

  it('Email Campaigns tab is the default — Create Campaign button is visible', async () => {
    wireFetch({ campaigns: [] });
    renderMarketing();
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Create Campaign/i })).toBeInTheDocument();
    });
  });

  it('shows the empty-state message when /api/marketing/campaigns?channel=EMAIL returns []', async () => {
    wireFetch({ campaigns: [] });
    renderMarketing();
    await waitFor(() => {
      expect(screen.getByText(/No campaigns found/i)).toBeInTheDocument();
    });
    expect(
      screen.getByText(/Launch your first email campaign to start tracking engagement/i),
    ).toBeInTheDocument();
  });

  it('renders one card per campaign with name + status + Stat tiles', async () => {
    wireFetch();
    renderMarketing();
    await waitFor(() => {
      expect(screen.getByText(/Q4 Holiday Promo/i)).toBeInTheDocument();
    });
    expect(screen.getByText(/Spring Newsletter/i)).toBeInTheDocument();
    // Both status badges render (Draft + Active).
    expect(screen.getByText('Draft')).toBeInTheDocument();
    expect(screen.getByText('Active')).toBeInTheDocument();
    // Stat tile labels appear once per card → use getAllByText (duplicate
    // labels across the two cards, per the standing rule).
    expect(screen.getAllByText('Sent').length).toBeGreaterThanOrEqual(2);
    expect(screen.getAllByText(/Open Rate/i).length).toBeGreaterThanOrEqual(2);
    expect(screen.getAllByText(/Click Rate/i).length).toBeGreaterThanOrEqual(2);
  });

  it('Create Campaign button opens a role="dialog" modal with the name input', async () => {
    wireFetch({ campaigns: [] });
    renderMarketing();
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Create Campaign/i })).toBeInTheDocument();
    });
    fireEvent.click(screen.getByRole('button', { name: /Create Campaign/i }));
    await waitFor(() => {
      expect(screen.getByRole('dialog', { name: /Create campaign/i })).toBeInTheDocument();
    });
    expect(screen.getByPlaceholderText(/Q4 Product Launch/i)).toBeInTheDocument();
    // Submit button starts disabled when the input is empty.
    const submitBtn = within(screen.getByRole('dialog', { name: /Create campaign/i }))
      .getByRole('button', { name: /Create Campaign/i });
    expect(submitBtn).toBeDisabled();
  });

  it('Create-campaign name input enforces maxLength=100 + live counter', async () => {
    wireFetch({ campaigns: [] });
    renderMarketing();
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Create Campaign/i })).toBeInTheDocument();
    });
    fireEvent.click(screen.getByRole('button', { name: /Create Campaign/i }));
    const input = await screen.findByPlaceholderText(/Q4 Product Launch/i);
    expect(input).toHaveAttribute('maxLength', '100');
    // Counter renders "0/100" initially.
    expect(screen.getByText(/0\/100/i)).toBeInTheDocument();
    // After typing, the counter updates.
    fireEvent.change(input, { target: { value: 'Spring Promo' } });
    await waitFor(() => {
      expect(screen.getByText(/12\/100/i)).toBeInTheDocument();
    });
  });

  it('XSS-looking input surfaces the angle-bracket warning hint', async () => {
    wireFetch({ campaigns: [] });
    renderMarketing();
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Create Campaign/i })).toBeInTheDocument();
    });
    fireEvent.click(screen.getByRole('button', { name: /Create Campaign/i }));
    const input = await screen.findByPlaceholderText(/Q4 Product Launch/i);
    fireEvent.change(input, { target: { value: '<script>x' } });
    await waitFor(() => {
      expect(
        screen.getByText(/Angle brackets and "javascript:" will be stripped on save/i),
      ).toBeInTheDocument();
    });
  });

  it('clicking a campaign card opens the Edit-Campaign dialog with Save/Send Now/Delete CTAs', async () => {
    wireFetch();
    renderMarketing();
    await waitFor(() => {
      expect(screen.getByLabelText(/Edit campaign Q4 Holiday Promo/i)).toBeInTheDocument();
    });
    fireEvent.click(screen.getByLabelText(/Edit campaign Q4 Holiday Promo/i));
    await waitFor(() => {
      expect(screen.getByRole('dialog', { name: /Edit campaign/i })).toBeInTheDocument();
    });
    // Footer CTAs.
    expect(screen.getByRole('button', { name: /^Save$/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Send Now/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Delete$/i })).toBeInTheDocument();
    // Status select preloads with the campaign's status.
    expect(screen.getByDisplayValue('Draft')).toBeInTheDocument();
  });

  it('clicking the SMS tab fires GET /api/marketing/campaigns?channel=SMS + renders the Send SMS Blast composer', async () => {
    wireFetch();
    renderMarketing();
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /SMS Campaigns/i })).toBeInTheDocument();
    });
    fetchApiMock.mockClear();
    wireFetch({ sms: [] });
    fireEvent.click(screen.getByRole('button', { name: /SMS Campaigns/i }));

    await waitFor(() => {
      const call = fetchApiMock.mock.calls.find(([u]) =>
        typeof u === 'string' && u.startsWith('/api/marketing/campaigns?channel=SMS'),
      );
      expect(call).toBeTruthy();
    });

    // SMS Blast composer is on-screen (Send SMS Blast heading + recipient
    // phone input + body textarea + 0/480 counter).
    expect(screen.getByRole('heading', { name: /Send SMS Blast/i })).toBeInTheDocument();
    expect(screen.getByPlaceholderText(/\+919876543210/)).toBeInTheDocument();
    expect(screen.getByText(/0\/480/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Send SMS/i })).toBeInTheDocument();
  });

  it('clicking the Push tab renders the "Open Push Templates & Settings" deep-link to /channels?tab=push', async () => {
    wireFetch();
    renderMarketing();
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Push Campaigns/i })).toBeInTheDocument();
    });
    fireEvent.click(screen.getByRole('button', { name: /Push Campaigns/i }));

    await waitFor(() => {
      expect(screen.getByRole('heading', { name: /Push Campaigns/i })).toBeInTheDocument();
    });
    // The primary CTA is an <a href="/channels?tab=push">.
    const cta = screen.getByRole('link', { name: /Open Push Templates & Settings/i });
    expect(cta).toBeInTheDocument();
    expect(cta).toHaveAttribute('href', '/channels?tab=push');
  });

  it('clicking the Embedded Forms tab fires GET ?channel=FORM + renders Builder + Embed Snippet columns', async () => {
    wireFetch();
    renderMarketing();
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Embedded Forms/i })).toBeInTheDocument();
    });
    fetchApiMock.mockClear();
    wireFetch({ forms: [] });
    fireEvent.click(screen.getByRole('button', { name: /Embedded Forms/i }));

    await waitFor(() => {
      const call = fetchApiMock.mock.calls.find(([u]) =>
        typeof u === 'string' && u.startsWith('/api/marketing/campaigns?channel=FORM'),
      );
      expect(call).toBeTruthy();
    });

    // Builder + Embed Snippet columns render.
    expect(screen.getByRole('heading', { name: /^Builder$/i })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: /Embed Snippet/i })).toBeInTheDocument();
    // Default field starts with Full Name + the Add Form Field CTA exists.
    expect(screen.getByRole('button', { name: /Add Form Field/i })).toBeInTheDocument();
  });

  it('Forms tab: clicking "Add Form Field" appends a new field row', async () => {
    wireFetch();
    renderMarketing();
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Embedded Forms/i })).toBeInTheDocument();
    });
    fireEvent.click(screen.getByRole('button', { name: /Embedded Forms/i }));
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Add Form Field/i })).toBeInTheDocument();
    });

    // Pre-state: one Remove-field button (one default field).
    const removeBefore = screen.getAllByRole('button', { name: /^Remove field/i });
    expect(removeBefore.length).toBe(1);

    fireEvent.click(screen.getByRole('button', { name: /Add Form Field/i }));

    await waitFor(() => {
      const removeAfter = screen.getAllByRole('button', { name: /^Remove field/i });
      expect(removeAfter.length).toBe(2);
    });
  });

  it('Forms tab: Embed Snippet pre populates with the formId + the Copy Snippet CTA renders', async () => {
    wireFetch();
    renderMarketing();
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Embedded Forms/i })).toBeInTheDocument();
    });
    fireEvent.click(screen.getByRole('button', { name: /Embedded Forms/i }));
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Copy Snippet/i })).toBeInTheDocument();
    });
    // formId label in the Builder column.
    expect(screen.getByText(/formId:/i)).toBeInTheDocument();
    // The "Saved Forms" empty-state hint renders when no rows exist.
    expect(
      screen.getByText(/No saved forms yet/i),
    ).toBeInTheDocument();
  });
});
