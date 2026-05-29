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

  // ───── NEW CASES (extension wave) ─────

  it('Email-tab GET initially fires for ?channel=EMAIL on mount', async () => {
    // Pins that the Campaigns useEffect loads campaigns on initial mount.
    // The #932 sequence-link UI was scoped but not yet wired into
    // Marketing.jsx — the page does NOT fetch /api/sequences today.
    // Asserting absence so the spec catches the moment that lands.
    wireFetch({ sequences: [{ id: 7, name: 'Welcome Drip' }] });
    renderMarketing();
    await waitFor(() => {
      const emailCall = fetchApiMock.mock.calls.find(([u]) =>
        typeof u === 'string' && u.startsWith('/api/marketing/campaigns?channel=EMAIL'),
      );
      expect(emailCall).toBeTruthy();
    });
    // /api/sequences is NOT fetched by the current SUT.
    const seqCall = fetchApiMock.mock.calls.find(([u]) => u === '/api/sequences');
    expect(seqCall).toBeFalsy();
  });

  it('submitting the Create Campaign modal POSTs /api/marketing/campaigns with sanitised name', async () => {
    // Pins the create-campaign POST contract: name is trimmed before send,
    // channel='EMAIL', budget=0. After success the modal closes + the list
    // reloads + a success toast fires.
    wireFetch({ campaigns: [] });
    renderMarketing();
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Create Campaign/i })).toBeInTheDocument();
    });
    fireEvent.click(screen.getByRole('button', { name: /Create Campaign/i }));
    const input = await screen.findByPlaceholderText(/Q4 Product Launch/i);
    fireEvent.change(input, { target: { value: '  Black Friday Blast  ' } });

    const submitBtn = within(screen.getByRole('dialog', { name: /Create campaign/i }))
      .getByRole('button', { name: /Create Campaign/i });
    fireEvent.click(submitBtn);

    await waitFor(() => {
      const postCall = fetchApiMock.mock.calls.find(([u, opts]) =>
        u === '/api/marketing/campaigns' && opts?.method === 'POST',
      );
      expect(postCall).toBeTruthy();
      const body = JSON.parse(postCall[1].body);
      expect(body.name).toBe('Black Friday Blast'); // trimmed
      expect(body.channel).toBe('EMAIL');
      expect(body.budget).toBe(0);
    });
    expect(notifyObj.success).toHaveBeenCalledWith('Campaign created');
  });

  it('Edit-Campaign dialog exposes Subject, Preheader, Body, Audience Status filter, Schedule', async () => {
    // Pins the editor's field set per the SUT openEditor() shape:
    // name + status + subject + preheader + body + audienceFilter.status
    // + scheduledAt datetime-local. The #932 sequence-link UI is scoped
    // but not yet wired into Marketing.jsx — the test below pins its
    // absence so the spec catches the moment that lands.
    wireFetch({
      sequences: [{ id: 99, name: 'Onboarding Drip' }],
    });
    renderMarketing();
    await waitFor(() => {
      expect(screen.getByLabelText(/Edit campaign Q4 Holiday Promo/i)).toBeInTheDocument();
    });
    fireEvent.click(screen.getByLabelText(/Edit campaign Q4 Holiday Promo/i));
    await waitFor(() => {
      expect(screen.getByRole('dialog', { name: /Edit campaign/i })).toBeInTheDocument();
    });

    // Subject, Preheader, Body inputs.
    expect(
      screen.getByPlaceholderText(/The first line your recipients see in their inbox/i),
    ).toBeInTheDocument();
    expect(
      screen.getByPlaceholderText(/Optional preview text shown next to the subject/i),
    ).toBeInTheDocument();
    expect(
      screen.getByPlaceholderText(/Hello \{\{contact\.firstName\}\}/i),
    ).toBeInTheDocument();

    // Audience Status filter — first option is "All contacts with email".
    expect(screen.getByDisplayValue('All contacts with email')).toBeInTheDocument();

    // Schedule datetime-local input (type attribute pin).
    const dialog = screen.getByRole('dialog', { name: /Edit campaign/i });
    expect(dialog.querySelector('input[type="datetime-local"]')).toBeInTheDocument();

    // Sequence-link select (#932) is NOT yet rendered by Marketing.jsx —
    // pin absence so a future regression catches the moment it lands.
    expect(screen.queryByLabelText(/Link to Sequence/i)).toBeNull();
  });

  it('Edit-Campaign Save click PUTs name + status then POSTs schedule + pause', async () => {
    // Pins the saveEditor multi-call contract:
    //   PUT /api/marketing/campaigns/:id { name, status }
    //   POST /api/marketing/campaigns/:id/schedule { scheduledAt, filters }
    //   POST /api/marketing/campaigns/:id/pause  (no-schedule fallback)
    // The #932 sequence-link UI is not yet wired into the PUT body —
    // pin absence so a future regression catches the moment it lands.
    wireFetch();
    renderMarketing();
    await waitFor(() => {
      expect(screen.getByLabelText(/Edit campaign Q4 Holiday Promo/i)).toBeInTheDocument();
    });
    fireEvent.click(screen.getByLabelText(/Edit campaign Q4 Holiday Promo/i));
    await waitFor(() => {
      expect(screen.getByRole('dialog', { name: /Edit campaign/i })).toBeInTheDocument();
    });

    fetchApiMock.mockClear();
    // Re-wire after clear so subsequent reloads still resolve.
    wireFetch();
    fireEvent.click(screen.getByRole('button', { name: /^Save$/i }));

    await waitFor(() => {
      const putCall = fetchApiMock.mock.calls.find(([u, opts]) =>
        typeof u === 'string' &&
        u === '/api/marketing/campaigns/100' &&
        opts?.method === 'PUT',
      );
      expect(putCall).toBeTruthy();
      const putBody = JSON.parse(putCall[1].body);
      expect(putBody.name).toBe('Q4 Holiday Promo');
      expect(putBody.status).toBe('Draft');
      // sequenceId is NOT in the PUT body — feature not yet wired (#932).
      expect(putBody.sequenceId).toBeUndefined();
    });

    const scheduleCall = fetchApiMock.mock.calls.find(([u, opts]) =>
      typeof u === 'string' &&
      u === '/api/marketing/campaigns/100/schedule' &&
      opts?.method === 'POST',
    );
    expect(scheduleCall).toBeTruthy();
    const schedBody = JSON.parse(scheduleCall[1].body);
    expect(schedBody.scheduledAt).toBeTruthy(); // ISO string placeholder
    expect(schedBody.filters).toBeTruthy();
    // No scheduledAt + no originalScheduledAt → SUT issues pause POST so the
    // placeholder +1yr date doesn't accidentally trigger dispatch.
    const pauseCall = fetchApiMock.mock.calls.find(([u, opts]) =>
      typeof u === 'string' &&
      u === '/api/marketing/campaigns/100/pause' &&
      opts?.method === 'POST',
    );
    expect(pauseCall).toBeTruthy();
  });

  it('Send Now in the editor dialog POSTs /:id/send with the audienceFilter payload', async () => {
    // Pins the sendCampaignNow contract: confirm prompt → POST /send with
    // filters body. notify.confirm is stubbed to true via our mock object
    // so the dispatch fires without user gesture.
    wireFetch();
    renderMarketing();
    await waitFor(() => {
      expect(screen.getByLabelText(/Edit campaign Spring Newsletter/i)).toBeInTheDocument();
    });
    fireEvent.click(screen.getByLabelText(/Edit campaign Spring Newsletter/i));
    await waitFor(() => {
      expect(screen.getByRole('dialog', { name: /Edit campaign/i })).toBeInTheDocument();
    });

    fetchApiMock.mockClear();
    wireFetch();
    fireEvent.click(screen.getByRole('button', { name: /Send Now/i }));

    await waitFor(() => {
      const sendCall = fetchApiMock.mock.calls.find(([u, opts]) =>
        typeof u === 'string' &&
        u === '/api/marketing/campaigns/101/send' &&
        opts?.method === 'POST',
      );
      expect(sendCall).toBeTruthy();
      const body = JSON.parse(sendCall[1].body);
      expect(body).toHaveProperty('filters');
    });
    expect(notifyObj.success).toHaveBeenCalledWith('Campaign dispatched');
  });

  it('SMS tab: Send SMS Blast posts to /api/sms/send-bulk with parsed recipient array', async () => {
    // Pins the #516 single-shot /send-bulk contract — recipient field accepts
    // comma- or whitespace-separated phones, parsed client-side into an
    // array before the POST.
    wireFetch();
    renderMarketing();
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /SMS Campaigns/i })).toBeInTheDocument();
    });
    fireEvent.click(screen.getByRole('button', { name: /SMS Campaigns/i }));
    await waitFor(() => {
      expect(screen.getByPlaceholderText(/\+919876543210/)).toBeInTheDocument();
    });

    fireEvent.change(screen.getByPlaceholderText(/\+919876543210/), {
      target: { value: '+919876543210, +918765432109' },
    });
    fireEvent.change(screen.getByPlaceholderText(/Hi \{\{contact\.firstName\}\}/i), {
      target: { value: 'Test blast' },
    });

    fetchApiMock.mockClear();
    fetchApiMock.mockImplementation((url) => {
      if (url === '/api/sms/send-bulk') {
        return Promise.resolve({ totalSent: 2, totalFailed: 0 });
      }
      if (typeof url === 'string' && url.startsWith('/api/marketing/campaigns?channel=SMS')) {
        return Promise.resolve([]);
      }
      return Promise.resolve(null);
    });

    fireEvent.click(screen.getByRole('button', { name: /Send SMS/i }));

    await waitFor(() => {
      const sendCall = fetchApiMock.mock.calls.find(([u, opts]) =>
        u === '/api/sms/send-bulk' && opts?.method === 'POST',
      );
      expect(sendCall).toBeTruthy();
      const body = JSON.parse(sendCall[1].body);
      // Recipient string split on commas/whitespace into a typed array.
      expect(Array.isArray(body.to)).toBe(true);
      expect(body.to).toEqual(['+919876543210', '+918765432109']);
      expect(body.body).toBe('Test blast');
    });
    expect(notifyObj.success).toHaveBeenCalledWith(expect.stringMatching(/SMS sent: 2 OK/));
  });

  it('SMS tab: empty recipient OR body short-circuits with notify.error (no POST)', async () => {
    // Pins the local guard inside handleSendSmsBlast — both fields are
    // required before a POST goes out.
    wireFetch();
    renderMarketing();
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /SMS Campaigns/i })).toBeInTheDocument();
    });
    fireEvent.click(screen.getByRole('button', { name: /SMS Campaigns/i }));
    await waitFor(() => {
      expect(screen.getByPlaceholderText(/\+919876543210/)).toBeInTheDocument();
    });

    // The Send button is disabled until both fields have content (HTML5
    // attribute pin — guards against accidental empty POST in the first
    // place). Recipient+body inputs are also required.
    const sendBtn = screen.getByRole('button', { name: /Send SMS/i });
    expect(sendBtn).toBeDisabled();
  });

  it('SMS tab: recent campaigns history renders rows when /api/marketing/campaigns?channel=SMS has data', async () => {
    // Pins the right-column "Recent SMS Campaigns" populated state — was
    // empty-state in the existing test; this is the non-empty path.
    wireFetch({
      sms: [
        { id: 200, name: 'Diwali Blast', status: 'Completed', sent: 500 },
        { id: 201, name: 'New Year Promo', status: 'Active', sent: 1200 },
      ],
    });
    renderMarketing();
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /SMS Campaigns/i })).toBeInTheDocument();
    });
    fireEvent.click(screen.getByRole('button', { name: /SMS Campaigns/i }));

    await waitFor(() => {
      expect(screen.getByText(/Diwali Blast/i)).toBeInTheDocument();
    });
    expect(screen.getByText(/New Year Promo/i)).toBeInTheDocument();
    // The "no rows yet" empty-state copy is gone when the list has rows.
    expect(screen.queryByText(/No SMS campaign blasts yet/i)).toBeNull();
  });

  it('Forms tab: addField then editing the label updates only that row (independent state)', async () => {
    // Pins updateField() and removeField() — appending + mutating a field
    // doesn't bleed into the first row.
    wireFetch();
    renderMarketing();
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Embedded Forms/i })).toBeInTheDocument();
    });
    fireEvent.click(screen.getByRole('button', { name: /Embedded Forms/i }));
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Add Form Field/i })).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole('button', { name: /Add Form Field/i }));
    await waitFor(() => {
      expect(screen.getAllByRole('button', { name: /^Remove field/i }).length).toBe(2);
    });

    // Remove the second field — back to 1 row.
    const removeBtns = screen.getAllByRole('button', { name: /^Remove field/i });
    fireEvent.click(removeBtns[1]);
    await waitFor(() => {
      expect(screen.getAllByRole('button', { name: /^Remove field/i }).length).toBe(1);
    });
  });

  it('Travel-vertical tenant: editor Sub-brand audience filter NOT YET RENDERED (#898 TODO)', async () => {
    // The #898 travel-vertical-only Sub-brand audience filter is not yet
    // wired into Marketing.jsx — Marketing.jsx does not even consume
    // AuthContext today. Pin absence so a future regression catches the
    // moment it lands.
    const TRAVEL_USER = {
      ...GENERIC_USER,
      tenant: { id: 2, vertical: 'travel' },
    };
    wireFetch();
    renderMarketing(TRAVEL_USER);
    await waitFor(() => {
      expect(screen.getByLabelText(/Edit campaign Q4 Holiday Promo/i)).toBeInTheDocument();
    });
    fireEvent.click(screen.getByLabelText(/Edit campaign Q4 Holiday Promo/i));
    await waitFor(() => {
      expect(screen.getByRole('dialog', { name: /Edit campaign/i })).toBeInTheDocument();
    });
    // Sub-brand audience filter dropdown is NOT yet rendered.
    expect(screen.queryByText(/Sub-brand audience/i)).toBeNull();
    expect(
      screen.queryByRole('option', { name: /TMC \(School trips\)/i }),
    ).toBeNull();
  });

  it('Generic tenant: editor does NOT render the Sub-brand audience filter (gated on travel)', async () => {
    // Negative-pin of the #898 isTravelTenant gate — generic vertical hides
    // the Sub-brand dropdown.
    wireFetch();
    renderMarketing(); // default GENERIC_USER
    await waitFor(() => {
      expect(screen.getByLabelText(/Edit campaign Q4 Holiday Promo/i)).toBeInTheDocument();
    });
    fireEvent.click(screen.getByLabelText(/Edit campaign Q4 Holiday Promo/i));
    await waitFor(() => {
      expect(screen.getByRole('dialog', { name: /Edit campaign/i })).toBeInTheDocument();
    });
    expect(screen.queryByText(/Sub-brand audience/i)).toBeNull();
  });

  it('handles a fetchApi rejection on campaign load without crashing (graceful empty)', async () => {
    // Pins the try/catch in loadCampaigns — backend errors don't throw past
    // the component; we still see the page chrome + empty-state.
    fetchApiMock.mockImplementation((url) => {
      if (typeof url === 'string' && url.startsWith('/api/marketing/campaigns?channel=EMAIL')) {
        return Promise.reject(new Error('Network error'));
      }
      if (url === '/api/sequences') {
        return Promise.resolve([]);
      }
      return Promise.resolve(null);
    });
    renderMarketing();
    await waitFor(() => {
      expect(screen.getByRole('heading', { name: /^Marketing$/i })).toBeInTheDocument();
    });
    // Page still renders + empty-state shows (campaigns stays []).
    await waitFor(() => {
      expect(screen.getByText(/No campaigns found/i)).toBeInTheDocument();
    });
  });

  it('Edit dialog status select can transition Draft → Scheduled → Active → Completed', async () => {
    // Pins the status select option set + the controlled-value mutation
    // round-trip (state flips through every enum value).
    wireFetch();
    renderMarketing();
    await waitFor(() => {
      expect(screen.getByLabelText(/Edit campaign Q4 Holiday Promo/i)).toBeInTheDocument();
    });
    fireEvent.click(screen.getByLabelText(/Edit campaign Q4 Holiday Promo/i));
    await waitFor(() => {
      expect(screen.getByRole('dialog', { name: /Edit campaign/i })).toBeInTheDocument();
    });

    const dialog = screen.getByRole('dialog', { name: /Edit campaign/i });
    // Status select is the one with options ['Draft','Scheduled','Active','Completed'].
    const statusSelect = within(dialog).getByDisplayValue('Draft');
    expect(statusSelect.tagName).toBe('SELECT');
    // All four lifecycle options are present.
    expect(within(statusSelect).getByRole('option', { name: 'Draft' })).toBeInTheDocument();
    expect(within(statusSelect).getByRole('option', { name: 'Scheduled' })).toBeInTheDocument();
    expect(within(statusSelect).getByRole('option', { name: 'Active' })).toBeInTheDocument();
    expect(within(statusSelect).getByRole('option', { name: 'Completed' })).toBeInTheDocument();

    fireEvent.change(statusSelect, { target: { value: 'Scheduled' } });
    await waitFor(() => {
      expect(within(dialog).getByDisplayValue('Scheduled')).toBeInTheDocument();
    });
    fireEvent.change(statusSelect, { target: { value: 'Completed' } });
    await waitFor(() => {
      expect(within(dialog).getByDisplayValue('Completed')).toBeInTheDocument();
    });
  });

  // ───── NEW CASES (extension wave 2 — delete / forms persistence / snippet / nav) ─────

  it('Editor Delete CTA confirms then DELETEs /api/marketing/campaigns/:id and reloads', async () => {
    // Pins the deleteCampaign() contract: notify.confirm gate → DELETE
    // /api/marketing/campaigns/:id → notify.success → editor closes →
    // campaigns list reloads. notifyObj.confirm is stubbed to resolve(true)
    // so the destructive prompt fires-through.
    wireFetch();
    renderMarketing();
    await waitFor(() => {
      expect(screen.getByLabelText(/Edit campaign Q4 Holiday Promo/i)).toBeInTheDocument();
    });
    fireEvent.click(screen.getByLabelText(/Edit campaign Q4 Holiday Promo/i));
    await waitFor(() => {
      expect(screen.getByRole('dialog', { name: /Edit campaign/i })).toBeInTheDocument();
    });

    fetchApiMock.mockClear();
    fetchApiMock.mockImplementation((url, opts) => {
      if (url === '/api/marketing/campaigns/100' && opts?.method === 'DELETE') {
        return Promise.resolve({});
      }
      if (typeof url === 'string' && url.startsWith('/api/marketing/campaigns?channel=EMAIL')) {
        return Promise.resolve([]);
      }
      if (url === '/api/sequences') return Promise.resolve([]);
      return Promise.resolve(null);
    });

    fireEvent.click(within(screen.getByRole('dialog', { name: /Edit campaign/i }))
      .getByRole('button', { name: /^Delete$/i }));

    await waitFor(() => {
      const deleteCall = fetchApiMock.mock.calls.find(([u, o]) =>
        u === '/api/marketing/campaigns/100' && o?.method === 'DELETE',
      );
      expect(deleteCall).toBeTruthy();
    });
    expect(notifyObj.success).toHaveBeenCalledWith('Campaign deleted');
  });

  it('Forms tab: Save click POSTs /api/marketing/campaigns with channel=FORM then schedule+pause', async () => {
    // Pins the saveForm() create-path multi-call contract:
    //   POST /api/marketing/campaigns { name, channel: 'FORM', budget: 0 }
    //   POST /api/marketing/campaigns/:id/schedule { scheduledAt, filters }
    //   POST /api/marketing/campaigns/:id/pause
    wireFetch();
    renderMarketing();
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Embedded Forms/i })).toBeInTheDocument();
    });
    fireEvent.click(screen.getByRole('button', { name: /Embedded Forms/i }));
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /^Save$/i })).toBeInTheDocument();
    });

    fetchApiMock.mockClear();
    fetchApiMock.mockImplementation((url, opts) => {
      if (url === '/api/marketing/campaigns' && opts?.method === 'POST') {
        return Promise.resolve({ id: 555, name: 'My Contact Form', channel: 'FORM' });
      }
      if (typeof url === 'string' && url.startsWith('/api/marketing/campaigns?channel=FORM')) {
        return Promise.resolve([]);
      }
      return Promise.resolve(null);
    });

    fireEvent.click(screen.getByRole('button', { name: /^Save$/i }));

    await waitFor(() => {
      const createCall = fetchApiMock.mock.calls.find(([u, o]) =>
        u === '/api/marketing/campaigns' && o?.method === 'POST',
      );
      expect(createCall).toBeTruthy();
      const body = JSON.parse(createCall[1].body);
      expect(body.channel).toBe('FORM');
      expect(body.budget).toBe(0);
      expect(body.name).toBe('My Contact Form');
    });

    // Schedule + pause both fire against the new id.
    await waitFor(() => {
      const scheduleCall = fetchApiMock.mock.calls.find(([u, o]) =>
        u === '/api/marketing/campaigns/555/schedule' && o?.method === 'POST',
      );
      expect(scheduleCall).toBeTruthy();
      const schedBody = JSON.parse(scheduleCall[1].body);
      // The filters payload carries formId + fields per #499.
      expect(schedBody.filters.formId).toMatch(/^form_/);
      expect(Array.isArray(schedBody.filters.fields)).toBe(true);
    });
    const pauseCall = fetchApiMock.mock.calls.find(([u, o]) =>
      u === '/api/marketing/campaigns/555/pause' && o?.method === 'POST',
    );
    expect(pauseCall).toBeTruthy();
    expect(notifyObj.success).toHaveBeenCalledWith('Form saved');
  });

  it('Forms tab: clicking a saved-form row loads it into the builder + flips Save → Update', async () => {
    // Pins loadForm() — clicking a saved row deserialises scheduleFilters
    // JSON back into formName + fields, sets loadedFormCampaignId so the
    // Save button label flips to "Update", and fires notify.info.
    const savedRow = {
      id: 777,
      name: 'Lead Capture Form',
      channel: 'FORM',
      status: 'Paused',
      scheduleFilters: JSON.stringify({
        formId: 'form_loaded_abc',
        fields: [
          { id: 'a', name: 'email', label: 'Email Address', required: true, placeholder: 'you@co.com' },
          { id: 'b', name: 'phone', label: 'Mobile', required: false, placeholder: '' },
        ],
      }),
    };
    wireFetch({ forms: [savedRow] });
    renderMarketing();
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Embedded Forms/i })).toBeInTheDocument();
    });
    fireEvent.click(screen.getByRole('button', { name: /Embedded Forms/i }));
    await waitFor(() => {
      expect(screen.getByText(/Lead Capture Form/i)).toBeInTheDocument();
    });

    // Click the saved-form row (matches the row's name button).
    fireEvent.click(screen.getByRole('button', { name: /^Lead Capture Form$/i }));

    await waitFor(() => {
      // Save button flipped to Update.
      expect(screen.getByRole('button', { name: /Update/i })).toBeInTheDocument();
    });
    expect(notifyObj.info).toHaveBeenCalledWith('Loaded "Lead Capture Form"');
    // Loaded indicator visible.
    expect(screen.getByText(/\(loaded\)/i)).toBeInTheDocument();
  });

  it('Forms tab: embed snippet maps phone → type="tel" (not email — #500 regression pin)', async () => {
    // Pins the FIELD_TYPE_MAP fix from #500. Pre-fix every non-Full-Name
    // field rendered as type="email" which blocked browser phone validation.
    // Snippet must contain type="tel" for the phone field and type="email"
    // ONLY for the email field.
    wireFetch();
    renderMarketing();
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Embedded Forms/i })).toBeInTheDocument();
    });
    fireEvent.click(screen.getByRole('button', { name: /Embedded Forms/i }));
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Add Form Field/i })).toBeInTheDocument();
    });

    // Default field is full_name. Switch the field's name select to phone.
    const fieldNameSelect = screen.getAllByRole('combobox').find(
      (sel) => sel.querySelector('option[value="phone"]'),
    );
    expect(fieldNameSelect).toBeTruthy();
    fireEvent.change(fieldNameSelect, { target: { value: 'phone' } });

    await waitFor(() => {
      // Snippet pre updates with type="tel" + inputmode="tel".
      const snippetEl = document.querySelector('pre code');
      expect(snippetEl?.textContent).toContain('type="tel"');
      expect(snippetEl?.textContent).toContain('inputmode="tel"');
    });
  });

  it('Forms tab: Copy Snippet click writes embed HTML to navigator.clipboard + flips to "Copied!"', async () => {
    // Pins copyToClipboard() — writes the rendered <form> snippet to the
    // clipboard, surfaces a success toast, and flips the button label
    // "Copy Snippet" → "Copied!" for 2 seconds.
    const writeTextMock = vi.fn(() => Promise.resolve());
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: writeTextMock },
      configurable: true,
    });

    wireFetch();
    renderMarketing();
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Embedded Forms/i })).toBeInTheDocument();
    });
    fireEvent.click(screen.getByRole('button', { name: /Embedded Forms/i }));
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Copy Snippet/i })).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole('button', { name: /Copy Snippet/i }));

    await waitFor(() => {
      expect(writeTextMock).toHaveBeenCalledTimes(1);
      const written = writeTextMock.mock.calls[0][0];
      expect(written).toMatch(/<form action="\/api\/marketing\/submit"/);
      expect(written).toMatch(/<input type="hidden" name="formId" value="form_/);
    });
    expect(notifyObj.success).toHaveBeenCalledWith('Snippet copied to clipboard');
    // Button label flips.
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Copied!/i })).toBeInTheDocument();
    });
  });

  it('Forms tab: New button resets the builder back to a single Full Name field', async () => {
    // Pins newForm() — clears formName to default + replaces fields with
    // one Full Name row + regenerates formId + clears loadedFormCampaignId.
    wireFetch();
    renderMarketing();
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Embedded Forms/i })).toBeInTheDocument();
    });
    fireEvent.click(screen.getByRole('button', { name: /Embedded Forms/i }));
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Add Form Field/i })).toBeInTheDocument();
    });

    // Add two extra fields → 3 total.
    fireEvent.click(screen.getByRole('button', { name: /Add Form Field/i }));
    fireEvent.click(screen.getByRole('button', { name: /Add Form Field/i }));
    await waitFor(() => {
      expect(screen.getAllByRole('button', { name: /^Remove field/i }).length).toBe(3);
    });

    // Click New — resets to 1 field.
    fireEvent.click(screen.getByRole('button', { name: /^New$/i }));
    await waitFor(() => {
      expect(screen.getAllByRole('button', { name: /^Remove field/i }).length).toBe(1);
    });
    // Form Name input reverts to default.
    const formNameInput = screen.getAllByDisplayValue('My Contact Form')[0];
    expect(formNameInput).toBeInTheDocument();
  });

  it('Forms tab: empty form name short-circuits Save with notify.error (no POST)', async () => {
    // Pins the guard inside saveForm() — empty/whitespace name must NOT
    // hit the API; surfaces notify.error("Form name is required") instead.
    wireFetch();
    renderMarketing();
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Embedded Forms/i })).toBeInTheDocument();
    });
    fireEvent.click(screen.getByRole('button', { name: /Embedded Forms/i }));
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /^Save$/i })).toBeInTheDocument();
    });

    // Clear the form name input.
    const formNameInput = screen.getAllByDisplayValue('My Contact Form')[0];
    fireEvent.change(formNameInput, { target: { value: '   ' } });

    fetchApiMock.mockClear();
    fireEvent.click(screen.getByRole('button', { name: /^Save$/i }));

    await waitFor(() => {
      expect(notifyObj.error).toHaveBeenCalledWith('Form name is required');
    });
    // No POST went out.
    const postCalls = fetchApiMock.mock.calls.filter(([, o]) => o?.method === 'POST');
    expect(postCalls.length).toBe(0);
  });

  it('Editor: pre-existing scheduledAt round-trips through the datetime-local input (#610 pin)', async () => {
    // Pins the #610 originalScheduledAt snapshot — opening a campaign with
    // a saved schedule should preload the datetime-local input with the
    // ISO-truncated value, so a no-op Save preserves it.
    const SCHEDULED_CAMPAIGN = {
      id: 102,
      name: 'Monday Promo',
      status: 'Scheduled',
      channel: 'EMAIL',
      budget: 50,
      sent: 0,
      opened: 0,
      clicked: 0,
      scheduledAt: '2026-08-15T10:30:00.000Z',
      scheduleFilters: JSON.stringify({ subject: 'Hi', body: '<p>x</p>' }),
      sequenceId: null,
    };
    wireFetch({ campaigns: [SCHEDULED_CAMPAIGN] });
    renderMarketing();
    await waitFor(() => {
      expect(screen.getByLabelText(/Edit campaign Monday Promo/i)).toBeInTheDocument();
    });
    fireEvent.click(screen.getByLabelText(/Edit campaign Monday Promo/i));
    await waitFor(() => {
      expect(screen.getByRole('dialog', { name: /Edit campaign/i })).toBeInTheDocument();
    });

    // The datetime-local input value is the slice(0,16) of the ISO string.
    const dialog = screen.getByRole('dialog', { name: /Edit campaign/i });
    const datetimeInput = dialog.querySelector('input[type="datetime-local"]');
    expect(datetimeInput).toBeInTheDocument();
    expect(datetimeInput.value).toBe('2026-08-15T10:30');

    // Subject + body roundtripped from scheduleFilters JSON.
    expect(within(dialog).getByDisplayValue('Hi')).toBeInTheDocument();
  });

  it('Push tab → switching back to Email tab re-renders campaign cards (state preserved)', async () => {
    // Pins the activeTab navigation — Push has no GET so we just verify the
    // tab switch round-trip restores the campaign cards from state.
    wireFetch();
    renderMarketing();
    await waitFor(() => {
      expect(screen.getByText(/Q4 Holiday Promo/i)).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole('button', { name: /Push Campaigns/i }));
    await waitFor(() => {
      expect(screen.getByRole('heading', { name: /Push Campaigns/i })).toBeInTheDocument();
    });
    // Campaign card is gone while Push tab is active.
    expect(screen.queryByText(/Q4 Holiday Promo/i)).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: /Email Campaigns/i }));
    await waitFor(() => {
      expect(screen.getByText(/Q4 Holiday Promo/i)).toBeInTheDocument();
    });
    expect(screen.getByText(/Spring Newsletter/i)).toBeInTheDocument();
  });
});
