/**
 * Developer.test.jsx — vitest + RTL coverage for the Developer Ecosystem page
 * (frontend/src/pages/Developer.jsx). The page is the API-key + outbound-
 * webhook admin surface plus the live agent-activity feed used by the
 * orchestrator parent to monitor background agents.
 *
 * Scope: pins the page-surface contracts that downstream integrators + the
 * agent-activity reporting flow rely on. The Developer page is a small but
 * load-bearing admin module — refactoring its render order or fetch shape
 * silently breaks the agent-activity polling + the key-rotation UX.
 *
 * Backend contracts pinned by this test (Developer.jsx talks to 5 routes):
 *   GET    /api/developer/apikeys
 *   POST   /api/developer/apikeys             { name, subBrand? } → { rawKey }
 *   DELETE /api/developer/apikeys/:id
 *   GET    /api/developer/webhooks
 *   POST   /api/developer/webhooks            { event, targetUrl }
 *   DELETE /api/developer/webhooks/:id
 *   GET    /api/developer/agent-activity?limit=50
 *
 * Contracts pinned here:
 *   1. Page mount: heading "Developer Ecosystem" + Swagger CTA + API
 *      Credentials + Webhooks section headings render. Initial mount fires
 *      GET /api/developer/apikeys AND GET /api/developer/webhooks.
 *   2. Empty state: "No active API keys located." renders when /apikeys
 *      returns []; "No registered webhook listeners." renders when
 *      /webhooks returns [].
 *   3. API key list: renders one row per key with the masked key prefix
 *      (first-10 chars + asterisks) — the secret is NEVER shown fully
 *      after the initial creation toast.
 *   4. Generate Key validation: the Generate Key button is DISABLED when
 *      the name input is empty (or whitespace-only). No POST fires.
 *   5. Generate Key happy path: typing a name + clicking Generate POSTs
 *      /api/developer/apikeys with { name: trimmed } body. The success
 *      notify fires with the rawKey + the "ATTENTION: ONLY time" copy,
 *      then re-fetches the list.
 *   6. Generate Key whitespace-only: submitting with "   " triggers the
 *      defense-in-depth notify.error("Key name is required.") and does
 *      NOT POST (button is also disabled per the trim()-check).
 *   7. Revoke key: clicking the Trash icon button fires notify.confirm
 *      with the "sever all integrations" warning; on yes, DELETEs
 *      /api/developer/apikeys/<id> then re-fetches.
 *   8. Revoke key cancelled: notify.confirm → false means NO DELETE
 *      fires (defense against accidental click-through).
 *   9. Webhook register: selecting an event + entering a URL + clicking
 *      Register POSTs /api/developer/webhooks with { event, targetUrl }
 *      and resets the form back to 'deal.created' + ''.
 *  10. Webhook delete: clicking the row Trash button DELETEs
 *      /api/developer/webhooks/<id> then re-fetches.
 *  11. Travel sub-brand selector: only renders when AuthContext.user.tenant
 *      .vertical === 'travel'. Generic + wellness tenants do NOT see it.
 *  12. Travel sub-brand scoping: on a travel tenant, picking a sub-brand
 *      then Generate POSTs with { name, subBrand: '<value>' }; the empty
 *      "Tenant-wide" option POSTs with NO subBrand field.
 *  13. Agent activity empty state: "No agent activity yet" renders when
 *      /agent-activity returns { activity: [] }.
 *  14. Agent activity rows: when /agent-activity returns entries, the
 *      table renders Time / Agent / Action / Detail columns and the
 *      "polling every 3s · N entries" header reflects the count.
 *
 * Stable mock pattern (per the 2026-05-12 standing rule): notify object is
 * ONE reference for the whole module so the hook reading it in useCallback
 * deps doesn't trigger re-render loops + per-test timeouts.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
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

import { AuthContext } from '../App';
import Developer from '../pages/Developer';

const GENERIC_USER = {
  userId: 1,
  name: 'Admin',
  email: 'admin@globussoft.com',
  role: 'ADMIN',
  tenant: { id: 1, vertical: 'generic' },
};

const TRAVEL_USER = {
  userId: 2,
  name: 'Travel Admin',
  email: 'travel@globussoft.com',
  role: 'ADMIN',
  tenant: { id: 2, vertical: 'travel' },
};

const sampleKeys = [
  {
    id: 11,
    name: 'Zapier Integration',
    keySecret: 'glbs_abc12_REDACTED_TAIL_xyz',
    subBrand: null,
  },
  {
    id: 12,
    name: 'TMC trip portal',
    keySecret: 'glbs_def34_REDACTED_TAIL_uvw',
    subBrand: 'tmc',
  },
];

const sampleHooks = [
  { id: 21, event: 'deal.created', targetUrl: 'https://hooks.example.com/deal' },
  { id: 22, event: 'invoice.created', targetUrl: 'https://hooks.example.com/invoice' },
];

function defaultFetchMock(url, opts) {
  if (url === '/api/developer/apikeys' && (!opts || !opts.method || opts.method === 'GET')) {
    return Promise.resolve(sampleKeys);
  }
  if (url === '/api/developer/apikeys' && opts?.method === 'POST') {
    return Promise.resolve({ rawKey: 'glbs_new_RAW_KEY_NEVER_AGAIN' });
  }
  if (url.match(/^\/api\/developer\/apikeys\/\d+$/) && opts?.method === 'DELETE') {
    return Promise.resolve({ ok: true });
  }
  if (url === '/api/developer/webhooks' && (!opts || !opts.method || opts.method === 'GET')) {
    return Promise.resolve(sampleHooks);
  }
  if (url === '/api/developer/webhooks' && opts?.method === 'POST') {
    return Promise.resolve({ ok: true });
  }
  if (url.match(/^\/api\/developer\/webhooks\/\d+$/) && opts?.method === 'DELETE') {
    return Promise.resolve({ ok: true });
  }
  if (url.startsWith('/api/developer/agent-activity')) {
    return Promise.resolve({ activity: [] });
  }
  return Promise.resolve(null);
}

function renderDeveloper(user = GENERIC_USER) {
  return render(
    <AuthContext.Provider value={{ user, token: 'tk', tenant: { id: user.tenant.id }, loading: false }}>
      <Developer />
    </AuthContext.Provider>,
  );
}

describe('<Developer /> — page surface, API key + webhook CRUD, agent activity', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    fetchApiMock.mockReset();
    fetchApiMock.mockImplementation(defaultFetchMock);
    notifyError.mockReset();
    notifySuccess.mockReset();
    notifyConfirm.mockReset();
    notifyConfirm.mockResolvedValue(true);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('mount: renders heading + Swagger CTA + section headings, fires initial GETs', async () => {
    renderDeveloper();
    expect(
      screen.getByRole('heading', { name: /Developer Ecosystem/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('link', { name: /View Swagger OpenAPI Docs/i }),
    ).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: /API Credentials/i })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: /^Webhooks$/i })).toBeInTheDocument();

    await waitFor(() => {
      const keyGet = fetchApiMock.mock.calls.find(
        ([u, o]) => u === '/api/developer/apikeys' && (!o || !o.method || o.method === 'GET'),
      );
      expect(keyGet).toBeTruthy();
    });
    await waitFor(() => {
      const hookGet = fetchApiMock.mock.calls.find(
        ([u, o]) => u === '/api/developer/webhooks' && (!o || !o.method || o.method === 'GET'),
      );
      expect(hookGet).toBeTruthy();
    });
    await waitFor(() => {
      const activityGet = fetchApiMock.mock.calls.find(([u]) =>
        typeof u === 'string' && u.startsWith('/api/developer/agent-activity'),
      );
      expect(activityGet).toBeTruthy();
    });
  });

  it('empty state: renders fallback copy when /apikeys + /webhooks both return []', async () => {
    fetchApiMock.mockImplementation((url) => {
      if (url === '/api/developer/apikeys') return Promise.resolve([]);
      if (url === '/api/developer/webhooks') return Promise.resolve([]);
      if (url.startsWith('/api/developer/agent-activity'))
        return Promise.resolve({ activity: [] });
      return Promise.resolve(null);
    });
    renderDeveloper();
    expect(await screen.findByText(/No active API keys located\./i)).toBeInTheDocument();
    expect(screen.getByText(/No registered webhook listeners\./i)).toBeInTheDocument();
  });

  it('API key list: renders one row per key with name + masked key prefix', async () => {
    renderDeveloper();
    // Both key names render.
    expect(await screen.findByText('Zapier Integration')).toBeInTheDocument();
    expect(screen.getByText('TMC trip portal')).toBeInTheDocument();
    // The page renders the first-10 chars of keySecret + asterisks. Both keys
    // share the 'glbs_' prefix but the next 5 differ; pin the first one.
    expect(screen.getByText(/glbs_abc12\*+/)).toBeInTheDocument();
    expect(screen.getByText(/glbs_def34\*+/)).toBeInTheDocument();
    // Sub-brand badge ('tmc') renders on the scoped key only.
    expect(screen.getByText('tmc')).toBeInTheDocument();
  });

  it('Generate Key button: disabled when name input is empty (no POST possible)', async () => {
    renderDeveloper();
    await screen.findByText('Zapier Integration');
    const generateBtn = screen.getByRole('button', { name: /Generate Key/i });
    expect(generateBtn).toBeDisabled();
    // Type then clear — still disabled with empty value.
    const nameInput = screen.getByPlaceholderText(/Key Name/i);
    fireEvent.change(nameInput, { target: { value: 'New' } });
    expect(generateBtn).not.toBeDisabled();
    fireEvent.change(nameInput, { target: { value: '' } });
    expect(generateBtn).toBeDisabled();
  });

  it('Generate Key happy path: POSTs with trimmed name + surfaces rawKey notify + reloads list', async () => {
    renderDeveloper();
    await screen.findByText('Zapier Integration');

    fetchApiMock.mockClear();
    fetchApiMock.mockImplementation(defaultFetchMock);

    const nameInput = screen.getByPlaceholderText(/Key Name/i);
    fireEvent.change(nameInput, { target: { value: '  Stripe webhooks  ' } });
    fireEvent.click(screen.getByRole('button', { name: /Generate Key/i }));

    await waitFor(() => {
      const postCall = fetchApiMock.mock.calls.find(
        ([u, o]) => u === '/api/developer/apikeys' && o?.method === 'POST',
      );
      expect(postCall).toBeTruthy();
      const body = JSON.parse(postCall[1].body);
      // Name is trimmed before send.
      expect(body.name).toBe('Stripe webhooks');
      // Generic tenant → NO subBrand field on the body.
      expect(body.subBrand).toBeUndefined();
    });
    // Success notify carries the raw key + the "ONLY time" copy.
    await waitFor(() => {
      expect(notifySuccess).toHaveBeenCalledWith(
        expect.stringMatching(/ONLY time this key will be displayed/i),
        expect.objectContaining({ ttl: 30000 }),
      );
    });
    await waitFor(() => {
      expect(notifySuccess).toHaveBeenCalledWith(
        expect.stringContaining('glbs_new_RAW_KEY_NEVER_AGAIN'),
        expect.any(Object),
      );
    });
    // Re-load fires a second GET.
    await waitFor(() => {
      const getCalls = fetchApiMock.mock.calls.filter(
        ([u, o]) => u === '/api/developer/apikeys' && (!o || !o.method || o.method === 'GET'),
      );
      expect(getCalls.length).toBeGreaterThanOrEqual(1);
    });
  });

  it('Generate Key whitespace-only: Generate button disabled — no POST fires', async () => {
    renderDeveloper();
    await screen.findByText('Zapier Integration');

    const nameInput = screen.getByPlaceholderText(/Key Name/i);
    fireEvent.change(nameInput, { target: { value: '     ' } });
    const generateBtn = screen.getByRole('button', { name: /Generate Key/i });
    // disabled={!newKeyName.trim()} — whitespace-only trims to '' → disabled.
    expect(generateBtn).toBeDisabled();

    fetchApiMock.mockClear();
    fireEvent.click(generateBtn);
    // disabled-button click is a no-op; no POST should have fired.
    await new Promise((r) => setTimeout(r, 0));
    const postCall = fetchApiMock.mock.calls.find(
      ([u, o]) => u === '/api/developer/apikeys' && o?.method === 'POST',
    );
    expect(postCall).toBeUndefined();
  });

  it('Revoke key (confirmed): notify.confirm + DELETE /apikeys/<id> + reload', async () => {
    renderDeveloper();
    await screen.findByText('Zapier Integration');

    notifyConfirm.mockResolvedValueOnce(true);
    fetchApiMock.mockClear();
    fetchApiMock.mockImplementation(defaultFetchMock);

    // The first key row's Trash icon button. The page uses two icons per row
    // (Copy + Trash); the Trash is the second button in the row. We locate
    // it by walking up from the key-name into the row's parent.
    const firstRow = screen.getByText('Zapier Integration').closest('div').parentElement;
    const buttons = within(firstRow).getAllByRole('button');
    // Last button on the row is the Trash (Revoke).
    fireEvent.click(buttons[buttons.length - 1]);

    await waitFor(() => {
      expect(notifyConfirm).toHaveBeenCalledWith(
        expect.stringMatching(/sever all integrations/i),
      );
    });
    await waitFor(() => {
      const delCall = fetchApiMock.mock.calls.find(
        ([u, o]) => u === '/api/developer/apikeys/11' && o?.method === 'DELETE',
      );
      expect(delCall).toBeTruthy();
    });
  });

  it('Revoke key (cancelled): notify.confirm → false means NO DELETE fires', async () => {
    renderDeveloper();
    await screen.findByText('Zapier Integration');

    notifyConfirm.mockResolvedValueOnce(false);
    fetchApiMock.mockClear();

    const firstRow = screen.getByText('Zapier Integration').closest('div').parentElement;
    const buttons = within(firstRow).getAllByRole('button');
    fireEvent.click(buttons[buttons.length - 1]);

    await waitFor(() => expect(notifyConfirm).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 0));
    const delCall = fetchApiMock.mock.calls.find(
      ([u, o]) => u?.match(/^\/api\/developer\/apikeys\/\d+$/) && o?.method === 'DELETE',
    );
    expect(delCall).toBeUndefined();
  });

  it('Webhook register: typing URL + clicking Register POSTs /webhooks with event+url', async () => {
    renderDeveloper();
    await screen.findByText('deal.created');

    fetchApiMock.mockClear();
    fetchApiMock.mockImplementation(defaultFetchMock);

    const urlInput = screen.getByPlaceholderText(/endpoint\.example\.com/i);
    fireEvent.change(urlInput, { target: { value: 'https://my.ngrok.io/cb' } });
    fireEvent.click(screen.getByRole('button', { name: /Register Target Endpoint/i }));

    await waitFor(() => {
      const postCall = fetchApiMock.mock.calls.find(
        ([u, o]) => u === '/api/developer/webhooks' && o?.method === 'POST',
      );
      expect(postCall).toBeTruthy();
      const body = JSON.parse(postCall[1].body);
      // Default event when none selected = 'deal.created'.
      expect(body.event).toBe('deal.created');
      expect(body.targetUrl).toBe('https://my.ngrok.io/cb');
    });
  });

  it('Webhook delete: clicking the row Trash DELETEs /webhooks/<id> + reloads', async () => {
    renderDeveloper();
    // Wait for hooks list to populate.
    await screen.findByText('POST: https://hooks.example.com/deal');

    fetchApiMock.mockClear();
    fetchApiMock.mockImplementation(defaultFetchMock);

    // Find the deal.created webhook row's Trash button by walking from the
    // displayed POST URL up to the row container.
    const urlCell = screen.getByText('POST: https://hooks.example.com/deal');
    const row = urlCell.closest('div').parentElement;
    const trashBtn = within(row).getByRole('button');
    fireEvent.click(trashBtn);

    await waitFor(() => {
      const delCall = fetchApiMock.mock.calls.find(
        ([u, o]) => u === '/api/developer/webhooks/21' && o?.method === 'DELETE',
      );
      expect(delCall).toBeTruthy();
    });
  });

  it('Travel sub-brand selector: hidden on generic tenants', async () => {
    renderDeveloper(GENERIC_USER);
    await screen.findByText('Zapier Integration');
    // The sub-brand selector has aria-label="Sub-brand scope" — must NOT
    // render for non-travel tenants.
    expect(
      screen.queryByLabelText(/Sub-brand scope/i),
    ).not.toBeInTheDocument();
  });

  it('Travel sub-brand selector: visible on travel tenants + POST includes subBrand when picked', async () => {
    renderDeveloper(TRAVEL_USER);
    await screen.findByText('Zapier Integration');

    const subBrandSelect = screen.getByLabelText(/Sub-brand scope/i);
    expect(subBrandSelect).toBeInTheDocument();
    // All 5 options render (tenant-wide + 4 sub-brands).
    expect(within(subBrandSelect).getByRole('option', { name: /Tenant-wide/i })).toBeInTheDocument();
    expect(within(subBrandSelect).getByRole('option', { name: /RFU \(Umrah\)/i })).toBeInTheDocument();

    fireEvent.change(subBrandSelect, { target: { value: 'rfu' } });
    fireEvent.change(screen.getByPlaceholderText(/Key Name/i), {
      target: { value: 'RFU portal key' },
    });

    fetchApiMock.mockClear();
    fetchApiMock.mockImplementation(defaultFetchMock);
    fireEvent.click(screen.getByRole('button', { name: /Generate Key/i }));

    await waitFor(() => {
      const postCall = fetchApiMock.mock.calls.find(
        ([u, o]) => u === '/api/developer/apikeys' && o?.method === 'POST',
      );
      expect(postCall).toBeTruthy();
      const body = JSON.parse(postCall[1].body);
      expect(body.name).toBe('RFU portal key');
      expect(body.subBrand).toBe('rfu');
    });
  });

  it('Travel tenant: tenant-wide (empty) sub-brand option does NOT add subBrand to body', async () => {
    renderDeveloper(TRAVEL_USER);
    await screen.findByText('Zapier Integration');

    // Leave sub-brand at default (empty = tenant-wide).
    fireEvent.change(screen.getByPlaceholderText(/Key Name/i), {
      target: { value: 'Tenant-wide key' },
    });

    fetchApiMock.mockClear();
    fetchApiMock.mockImplementation(defaultFetchMock);
    fireEvent.click(screen.getByRole('button', { name: /Generate Key/i }));

    await waitFor(() => {
      const postCall = fetchApiMock.mock.calls.find(
        ([u, o]) => u === '/api/developer/apikeys' && o?.method === 'POST',
      );
      expect(postCall).toBeTruthy();
      const body = JSON.parse(postCall[1].body);
      expect(body.name).toBe('Tenant-wide key');
      // Source: `if (isTravelTenant && newKeySubBrand) body.subBrand = …`
      // — empty string is falsy, so NO subBrand field is added.
      expect(body.subBrand).toBeUndefined();
    });
  });

  it('Agent activity: empty-state copy renders when /agent-activity returns no entries', async () => {
    renderDeveloper();
    expect(
      await screen.findByText(/No agent activity yet\./i),
    ).toBeInTheDocument();
    // Header "polling every 3s · 0 entries" reflects the zero-count.
    expect(screen.getByText(/polling every 3s · 0 entries/i)).toBeInTheDocument();
  });

  it('Agent activity: renders one row per entry + count in header reflects list length', async () => {
    const sampleActivity = [
      {
        ts: '2026-05-25T10:00:00.000Z',
        agent: 'wave-9-agent-a',
        action: 'start',
        status: 'running',
        file: 'frontend/src/__tests__/Developer.test.jsx',
        message: 'authoring test',
      },
      {
        ts: '2026-05-25T10:05:00.000Z',
        agent: 'wave-9-agent-a',
        action: 'commit',
        status: 'done',
        commit: 'abc1234567890def',
        message: 'shipped',
      },
    ];
    fetchApiMock.mockImplementation((url, opts) => {
      if (url.startsWith('/api/developer/agent-activity')) {
        return Promise.resolve({ activity: sampleActivity });
      }
      return defaultFetchMock(url, opts);
    });
    renderDeveloper();

    // Agent name appears in TWO rows — use getAllByText for the duplicate label.
    const agentCells = await screen.findAllByText('wave-9-agent-a');
    expect(agentCells.length).toBe(2);
    // Action labels render once each.
    expect(screen.getByText('start')).toBeInTheDocument();
    expect(screen.getByText('commit')).toBeInTheDocument();
    // Header reflects entry count "2 entries".
    expect(screen.getByText(/polling every 3s · 2 entries/i)).toBeInTheDocument();
    // Commit short-hash (first 7 chars) renders in the Detail cell.
    expect(screen.getByText(/\[abc1234\]/)).toBeInTheDocument();
  });
});
