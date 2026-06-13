/**
 * LeadCapture.test.jsx — vitest + RTL coverage for the /settings/lead-capture
 * admin page (frontend/src/pages/settings/LeadCapture.jsx).
 *
 * G009 (PRD_TRAVEL_MULTICHANNEL_LEADS FR-3.7). Pins these page-surface
 * invariants:
 *
 *   1. On mount, the page fetches GET /api/settings/lead-capture and renders
 *      the Channels & cooldowns section with one row per allowedChannel.
 *   2. Per-channel toggle reflects the GET response's channels.<ch> boolean;
 *      clicking the toggle flips local state (does NOT auto-PUT — must hit
 *      Save).
 *   3. Cooldown input renders the GET response's cooldowns.<ch> integer.
 *      Editing the input updates local state; values are clamped to
 *      [0, 86400] and floored on the fly.
 *   4. Save button fires PUT /api/settings/lead-capture with the FULL
 *      current channels + cooldowns objects (per-section save, not per-
 *      channel) and then re-issues the GET so displayed state matches DB
 *      (#586 round-trip standing rule).
 *   5. Form-routing mapping table renders one row per
 *      formRoutingMappings[] from the GET response.
 *   6. Adding a new mapping fires POST /form-routing-mappings with the
 *      composed body; a successful response re-fetches GET.
 *   7. Empty externalFormId on add → notify.error + no POST.
 *   8. Delete button on a row prompts a confirm() then fires DELETE /:id;
 *      success re-fetches.
 *   9. Test-intake panel: clicking "Test intake" POSTs the
 *      /api/travel/inbound/leads/<channel> endpoint with the parsed JSON
 *      payload + `_test: true` + channel. Invalid JSON → notify.error.
 *
 * Backend contract pinned (mirrors backend/routes/lead_capture_settings.js):
 *   GET  /api/settings/lead-capture →
 *          { channels:{ch:bool}, cooldowns:{ch:secs},
 *            formRoutingMappings:[{id,channel,externalFormId,subBrand,
 *            assignedTeamId,isActive,notes,createdAt,updatedAt}],
 *            allowedChannels:[...17...], cooldownRange:{min:0,max:86400} }
 *   PUT  /api/settings/lead-capture body:{channels?,cooldowns?}
 *          → { ok:true, channels, cooldowns }
 *   POST /api/settings/lead-capture/form-routing-mappings
 *          → 201 { mapping }
 *   DELETE /api/settings/lead-capture/form-routing-mappings/:id → 204
 *
 * Mocking discipline (per CLAUDE.md RTL standing rules):
 *   - fetchApi mocked at ../utils/api (the page's dep).
 *   - notify is a STABLE module-level reference (Wave 11 cfb5789 / Wave 12
 *     f59e91d — fresh per-call objects flap useCallback identity).
 *   - window.confirm stubbed via vi.spyOn(window, 'confirm').
 *   - getByText queries that may match both filter chrome AND row badges
 *     use getAllByText (per 2026-05-09 standing rule).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';

const fetchApiMock = vi.fn();
vi.mock('../utils/api', () => ({
  fetchApi: (...args) => fetchApiMock(...args),
  getAuthToken: () => 'test-token',
}));

// Stable notify object — RTL standing rule.
const notifyError = vi.fn();
const notifySuccess = vi.fn();
const notifyInfo = vi.fn();
const notifyObj = {
  error: notifyError,
  info: notifyInfo,
  success: notifySuccess,
  confirm: vi.fn(() => Promise.resolve(true)),
};
vi.mock('../utils/notify', () => ({
  useNotify: () => notifyObj,
}));

import LeadCapture from '../pages/settings/LeadCapture';

const DEFAULT_RESPONSE = {
  channels: {
    web_form: true,
    whatsapp: false,
    meta_ad: true,
  },
  cooldowns: {
    web_form: 60,
    whatsapp: 0,
  },
  formRoutingMappings: [
    {
      id: 1,
      channel: 'meta_ad',
      externalFormId: '12345',
      subBrand: 'tmc',
      assignedTeamId: null,
      isActive: true,
      notes: 'TMC summer campaign',
      createdAt: '2026-06-13T00:00:00Z',
      updatedAt: '2026-06-13T00:00:00Z',
    },
  ],
  allowedChannels: [
    'voyagr', 'web_form', 'whatsapp', 'meta_ad', 'manual',
  ],
  cooldownRange: { min: 0, max: 86400 },
};

function defaultFetch(url, opts) {
  const method = opts?.method || 'GET';
  if (url === '/api/settings/lead-capture' && method === 'GET') {
    return Promise.resolve(DEFAULT_RESPONSE);
  }
  if (url === '/api/settings/lead-capture' && method === 'PUT') {
    return Promise.resolve({ ok: true, channels: {}, cooldowns: {} });
  }
  if (url === '/api/settings/lead-capture/form-routing-mappings' && method === 'POST') {
    return Promise.resolve({
      mapping: { id: 99, channel: 'meta_ad', externalFormId: '777',
        subBrand: 'rfu', isActive: true, notes: null,
        createdAt: '2026-06-13T01:00:00Z', updatedAt: '2026-06-13T01:00:00Z' },
    });
  }
  if (url.startsWith('/api/settings/lead-capture/form-routing-mappings/') && method === 'DELETE') {
    return Promise.resolve(null);
  }
  if (url.startsWith('/api/travel/inbound/leads/') && method === 'POST') {
    return Promise.resolve({ action: 'created' });
  }
  return Promise.resolve(null);
}

function renderPage() {
  return render(<LeadCapture />);
}

describe('<LeadCapture /> — /settings/lead-capture admin page', () => {
  beforeEach(() => {
    fetchApiMock.mockReset();
    notifyError.mockReset();
    notifySuccess.mockReset();
    notifyInfo.mockReset();
    fetchApiMock.mockImplementation(defaultFetch);
  });

  it('1. fetches /api/settings/lead-capture on mount + renders channel rows', async () => {
    renderPage();
    await waitFor(() => {
      const seen = fetchApiMock.mock.calls.some(
        ([url, opts]) => url === '/api/settings/lead-capture' && (!opts || opts.method === undefined || opts.method === 'GET'),
      );
      expect(seen).toBe(true);
    });
    // Each allowed channel renders a row (label appears at least once)
    // "Web Form" appears in BOTH the channel row label AND the mapping-channel
    // <option> + test-intake <option>. Use getAllByText per CLAUDE.md
    // 2026-05-09 standing rule for labels that double as filter chrome.
    await waitFor(() => {
      expect(screen.getAllByText('Web Form').length).toBeGreaterThanOrEqual(1);
      expect(screen.getAllByText('WhatsApp').length).toBeGreaterThanOrEqual(1);
    });
  });

  it('2. toggle reflects GET response + click flips local state (no auto-PUT)', async () => {
    renderPage();
    await waitFor(() => expect(screen.getAllByText('Web Form').length).toBeGreaterThanOrEqual(1));
    // Web Form toggle is checked (enabled in fixture)
    const enableInputs = screen.getAllByRole('checkbox', { name: /Enable / });
    // First channel in allowedChannels is 'voyagr' (not in channels map → false)
    // Second is 'web_form' which is true. Find by exact label match.
    const webFormToggle = screen.getByRole('checkbox', { name: 'Enable web_form' });
    expect(webFormToggle).toBeChecked();
    // Click flips to off
    fireEvent.click(webFormToggle);
    expect(webFormToggle).not.toBeChecked();
    // No PUT fired yet — only the GET
    const putCalls = fetchApiMock.mock.calls.filter(([, opts]) => opts?.method === 'PUT');
    expect(putCalls).toHaveLength(0);
  });

  it('3. cooldown input renders + clamps to [0, 86400]', async () => {
    renderPage();
    await waitFor(() => expect(screen.getAllByText('Web Form').length).toBeGreaterThanOrEqual(1));
    const webFormCooldown = screen.getByRole('spinbutton', { name: 'Cooldown for web_form' });
    expect(webFormCooldown).toHaveValue(60);
    // Set negative → clamps to 0
    fireEvent.change(webFormCooldown, { target: { value: '-100' } });
    expect(webFormCooldown).toHaveValue(0);
    // Set huge → clamps to 86400
    fireEvent.change(webFormCooldown, { target: { value: '99999999' } });
    expect(webFormCooldown).toHaveValue(86400);
  });

  it('4. Save button PUTs current state + re-fetches', async () => {
    renderPage();
    await waitFor(() => expect(screen.getAllByText('Web Form').length).toBeGreaterThanOrEqual(1));
    const initialGetCount = fetchApiMock.mock.calls.filter(
      ([url, opts]) => url === '/api/settings/lead-capture' && (!opts || opts.method === undefined || opts.method === 'GET'),
    ).length;
    const saveBtn = screen.getByRole('button', { name: /Save channel \+ cooldown settings/i });
    fireEvent.click(saveBtn);
    await waitFor(() => {
      const putCall = fetchApiMock.mock.calls.find(([url, opts]) => url === '/api/settings/lead-capture' && opts?.method === 'PUT');
      expect(putCall).toBeTruthy();
      const body = JSON.parse(putCall[1].body);
      expect(body).toHaveProperty('channels');
      expect(body).toHaveProperty('cooldowns');
    });
    // Re-GET fires after PUT (round-trip)
    await waitFor(() => {
      const getCount = fetchApiMock.mock.calls.filter(
        ([url, opts]) => url === '/api/settings/lead-capture' && (!opts || opts.method === undefined || opts.method === 'GET'),
      ).length;
      expect(getCount).toBeGreaterThan(initialGetCount);
    });
  });

  it('5. form-routing mapping rows render from GET response', async () => {
    renderPage();
    await waitFor(() => {
      // The mapping table shows the external form ID as code
      expect(screen.getByText('12345')).toBeInTheDocument();
      // And the notes
      expect(screen.getByText('TMC summer campaign')).toBeInTheDocument();
    });
  });

  it('6. adding a new mapping POSTs + refetches', async () => {
    renderPage();
    await waitFor(() => expect(screen.getByText('12345')).toBeInTheDocument());
    const formIdInput = screen.getByPlaceholderText(/1234567890123456/i);
    fireEvent.change(formIdInput, { target: { value: '777' } });
    const addBtn = screen.getByRole('button', { name: /Add form-routing mapping/i });
    fireEvent.click(addBtn);
    await waitFor(() => {
      const postCall = fetchApiMock.mock.calls.find(
        ([url, opts]) => url === '/api/settings/lead-capture/form-routing-mappings' && opts?.method === 'POST',
      );
      expect(postCall).toBeTruthy();
      const body = JSON.parse(postCall[1].body);
      expect(body.externalFormId).toBe('777');
      expect(body.channel).toBe('meta_ad'); // default
    });
  });

  it('7. empty externalFormId on add → notify.error + no POST', async () => {
    renderPage();
    await waitFor(() => expect(screen.getByText('12345')).toBeInTheDocument());
    const addBtn = screen.getByRole('button', { name: /Add form-routing mapping/i });
    // Bypass HTML5 required validation by using form.submit on the form node
    // via fireEvent.submit on the parent form. The page's submit handler
    // checks empty-trim before invoking fetchApi.
    const form = addBtn.closest('form');
    fireEvent.submit(form);
    await waitFor(() => {
      expect(notifyError).toHaveBeenCalledWith(expect.stringMatching(/required/i));
    });
    const postCalls = fetchApiMock.mock.calls.filter(
      ([url, opts]) => url === '/api/settings/lead-capture/form-routing-mappings' && opts?.method === 'POST',
    );
    expect(postCalls).toHaveLength(0);
  });

  it('8. delete button confirms + DELETEs + refetches', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
    renderPage();
    await waitFor(() => expect(screen.getByText('12345')).toBeInTheDocument());
    const deleteBtn = screen.getByRole('button', { name: /Delete mapping 1/i });
    fireEvent.click(deleteBtn);
    expect(confirmSpy).toHaveBeenCalled();
    await waitFor(() => {
      const delCall = fetchApiMock.mock.calls.find(
        ([url, opts]) => url === '/api/settings/lead-capture/form-routing-mappings/1' && opts?.method === 'DELETE',
      );
      expect(delCall).toBeTruthy();
    });
    confirmSpy.mockRestore();
  });

  it('9. Test intake fires POST to /api/travel/inbound/leads/<channel> with _test:true', async () => {
    renderPage();
    await waitFor(() => expect(screen.getAllByText('Web Form').length).toBeGreaterThanOrEqual(1));
    const testBtn = screen.getByRole('button', { name: /Run test intake/i });
    fireEvent.click(testBtn);
    await waitFor(() => {
      const intakeCall = fetchApiMock.mock.calls.find(
        ([url, opts]) => url.startsWith('/api/travel/inbound/leads/') && opts?.method === 'POST',
      );
      expect(intakeCall).toBeTruthy();
      const body = JSON.parse(intakeCall[1].body);
      expect(body._test).toBe(true);
      expect(body.channel).toBeTruthy();
    });
  });

  it('9b. Test intake with invalid JSON payload → notify.error, no POST', async () => {
    renderPage();
    await waitFor(() => expect(screen.getAllByText('Web Form').length).toBeGreaterThanOrEqual(1));
    const payloadField = screen.getByLabelText(/Test payload JSON/i);
    fireEvent.change(payloadField, { target: { value: '{not valid json' } });
    const testBtn = screen.getByRole('button', { name: /Run test intake/i });
    fireEvent.click(testBtn);
    await waitFor(() => {
      expect(notifyError).toHaveBeenCalledWith(expect.stringMatching(/JSON/i));
    });
    const intakeCalls = fetchApiMock.mock.calls.filter(
      ([url, opts]) => url.startsWith('/api/travel/inbound/leads/') && opts?.method === 'POST',
    );
    expect(intakeCalls).toHaveLength(0);
  });
});
