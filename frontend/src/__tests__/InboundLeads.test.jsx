/**
 * InboundLeads.test.jsx — vitest + RTL coverage for the Travel-vertical
 * InboundLeads admin page (frontend/src/pages/travel/InboundLeads.jsx).
 *
 * Arc 2 #904 slice (frontend STUB) — pins the page-surface invariants for
 * the operator-facing list of inbound-ingested leads. The slice is
 * deliberately STUB-mode: there is NO dedicated GET endpoint for inbound
 * leads yet (slice 1's POST /api/travel/inbound/leads/:channel only
 * accepts inbound writes). The page fetches the generic /api/contacts
 * list and client-side-filters for rows whose source starts with
 * `inbound:`. The STUB marker is grepped by case 11 below so a future
 * GET-endpoint-shipping slice can find this commit's residual debt.
 *
 * Backend contract pinned (per backend/routes/travel_inbound_leads.js):
 *   POST /api/travel/inbound/leads/:channel writes Contact rows with
 *   `source: 'inbound:<channel>'` where <channel> is one of:
 *     voyagr | webform | whatsapp | ads | adsgpt | metaads | manual
 *   The generic /api/contacts list endpoint returns the full Contact
 *   array (NOT wrapped in a `{contacts: []}` envelope) per
 *   backend/routes/contacts.js:175-176 — we handle both shapes
 *   defensively in case the API surface evolves.
 *
 * Cases (11):
 *   1. Heading "Inbound Leads" + tagline render.
 *   2. Initial GET fires `/api/contacts?limit=100` on mount.
 *   3. Only rows with `source` starting with `inbound:` survive the
 *      client-side filter — non-inbound contacts (e.g. source='manual'
 *      from the legacy contact form, source='ads-organic') are excluded.
 *   4. Channel chip "Voyagr" narrows to `source === 'inbound:voyagr'`
 *      exactly (does NOT match `inbound:voyagr-fallback` or similar).
 *   5. Empty state ("No inbound leads yet — external producers haven't
 *      started sending.") renders when zero inbound contacts exist.
 *   6. Row renders name + email + phone + channel badge + createdAt.
 *   7. Click "Convert to Lead" navigates to /leads/:id where :id is the
 *      contact id (NOT a separate lead id — the contact IS the lead at
 *      this stage of the funnel).
 *   8. Date-range filter narrows rows by createdAt window (inclusive on
 *      both ends).
 *   9. 5xx on /api/contacts fires notify.error.
 *  10. Channel filter chip "All" clears the channel narrowing — both
 *      voyagr + webform rows reappear.
 *  11. STUB marker present in SUT source — the future GET-endpoint slice
 *      can grep for `STUB #904 slice` to find this debt entry.
 *
 * Mocking discipline (per CLAUDE.md RTL standing rules):
 *   - fetchApi mocked at ../utils/api with a routing fn.
 *   - useNotify returns a STABLE notifyObj reference for the whole file
 *     (Wave 11 cfb5789 / Wave 12 f59e91d — fresh per-call objects flap
 *     useCallback identity and trigger infinite re-renders).
 *   - useNavigate spied via vi.mock('react-router-dom', ...) so the
 *     Convert-to-Lead click can be asserted against a router target.
 *   - Path: flat __tests__/ — no travel/ subdir.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { readFileSync } from 'fs';
import path from 'path';

const fetchApiMock = vi.fn();
vi.mock('../utils/api', () => ({
  fetchApi: (...args) => fetchApiMock(...args),
  getAuthToken: () => 'test-token',
}));

// Stable notify object — RTL standing rule.
const notifyError = vi.fn();
const notifySuccess = vi.fn();
const notifyInfo = vi.fn();
const notifyConfirm = vi.fn(() => Promise.resolve(true));
const notifyObj = {
  error: notifyError,
  info: notifyInfo,
  success: notifySuccess,
  confirm: notifyConfirm,
};
vi.mock('../utils/notify', () => ({
  useNotify: () => notifyObj,
  NotifyProvider: ({ children }) => children,
}));

// useNavigate spy — Convert-to-Lead click target assertion.
const navigateMock = vi.fn();
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual('react-router-dom');
  return {
    ...actual,
    useNavigate: () => navigateMock,
  };
});

import InboundLeads from '../pages/travel/InboundLeads';

// Canonical contact row factory — overrides allow tests to construct
// arbitrary source / createdAt / contact fields per case.
function makeContact(overrides = {}) {
  return {
    id: 7001,
    name: 'Anita Sharma',
    email: 'anita@example.com',
    phone: '+91 98000 00001',
    source: 'inbound:voyagr',
    createdAt: '2026-05-22T10:00:00.000Z',
    ...overrides,
  };
}

// Install a fetchApi mock that resolves /api/contacts to the caller-
// supplied list. Tests pass `error` to make it reject with a status,
// or `responseByMatcher` for per-URL routing.
function installFetchMock({
  contacts = [],
  error = null,
} = {}) {
  fetchApiMock.mockImplementation((url) => {
    if (typeof url !== 'string') return Promise.resolve(null);
    if (!url.startsWith('/api/contacts')) {
      return Promise.resolve(null);
    }
    if (error) return Promise.reject(error);
    return Promise.resolve(contacts);
  });
}

beforeEach(() => {
  fetchApiMock.mockReset();
  notifyError.mockReset();
  notifySuccess.mockReset();
  notifyInfo.mockReset();
  notifyConfirm.mockReset();
  notifyConfirm.mockResolvedValue(true);
  navigateMock.mockReset();
  installFetchMock();
});

function renderPage() {
  return render(<InboundLeads />);
}

describe('<InboundLeads /> — page chrome', () => {
  it('renders the "Inbound Leads" heading + tagline', async () => {
    renderPage();
    expect(
      screen.getByRole('heading', { name: /Inbound Leads/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/Real-time lead ingestion from external channels/i),
    ).toBeInTheDocument();
  });
});

describe('<InboundLeads /> — initial fetch', () => {
  it('fires GET /api/contacts?limit=100 on mount', async () => {
    installFetchMock({
      contacts: [makeContact({ id: 7001 })],
    });
    renderPage();
    await waitFor(() => {
      const call = fetchApiMock.mock.calls.find(
        ([url]) =>
          typeof url === 'string' && url.startsWith('/api/contacts'),
      );
      expect(call).toBeTruthy();
      expect(call[0]).toMatch(/limit=100/);
    });
  });
});

describe('<InboundLeads /> — suspect / quality badges', () => {
  it('badges a Junk lead as Suspect + shows its aiScore; a good lead shows score with no Suspect pill', async () => {
    installFetchMock({ contacts: [
      makeContact({ id: 8001, name: 'Junk Lead', source: 'inbound:webform', status: 'Junk', aiScore: 12 }),
      makeContact({ id: 8002, name: 'Good Lead', source: 'inbound:voyagr', status: 'Lead', aiScore: 88 }),
    ] });
    render(<InboundLeads />);
    expect(await screen.findByTestId('inbound-lead-suspect-8001')).toBeInTheDocument();
    expect(screen.getByTestId('inbound-lead-score-8001')).toHaveTextContent('12/100');
    expect(screen.getByTestId('inbound-lead-score-8002')).toHaveTextContent('88/100');
    expect(screen.queryByTestId('inbound-lead-suspect-8002')).toBeNull();
  });

  it('flags a low aiScore (<40) as Suspect even when status is not Junk', async () => {
    installFetchMock({ contacts: [
      makeContact({ id: 8003, name: 'Low Score', source: 'inbound:whatsapp', status: 'Lead', aiScore: 30 }),
    ] });
    render(<InboundLeads />);
    expect(await screen.findByTestId('inbound-lead-suspect-8003')).toBeInTheDocument();
  });
});

describe('<InboundLeads /> — only inbound: rows survive', () => {
  it('client-side filters to source.startsWith("inbound:")', async () => {
    installFetchMock({
      contacts: [
        makeContact({ id: 1, name: 'Inbound One', source: 'inbound:voyagr' }),
        makeContact({ id: 2, name: 'Legacy Two', source: 'manual' }),
        makeContact({ id: 3, name: 'Inbound Three', source: 'inbound:webform' }),
        makeContact({ id: 4, name: 'Imported Four', source: 'csv-import' }),
        makeContact({ id: 5, name: 'Inbound Five', source: 'inbound:whatsapp' }),
        makeContact({ id: 6, name: 'Null Source', source: null }),
      ],
    });
    renderPage();
    await screen.findByText('Inbound One');
    expect(screen.getByText('Inbound Three')).toBeInTheDocument();
    expect(screen.getByText('Inbound Five')).toBeInTheDocument();
    expect(screen.queryByText('Legacy Two')).not.toBeInTheDocument();
    expect(screen.queryByText('Imported Four')).not.toBeInTheDocument();
    expect(screen.queryByText('Null Source')).not.toBeInTheDocument();
  });
});

describe('<InboundLeads /> — channel chip narrows by exact source suffix', () => {
  it('clicking "Voyagr" chip narrows to source === "inbound:voyagr"', async () => {
    installFetchMock({
      contacts: [
        makeContact({ id: 1, name: 'V-One', source: 'inbound:voyagr' }),
        makeContact({ id: 2, name: 'WF-Two', source: 'inbound:webform' }),
        makeContact({ id: 3, name: 'WA-Three', source: 'inbound:whatsapp' }),
      ],
    });
    renderPage();
    // All three visible before chip click.
    await screen.findByText('V-One');
    expect(screen.getByText('WF-Two')).toBeInTheDocument();
    expect(screen.getByText('WA-Three')).toBeInTheDocument();

    fireEvent.click(
      screen.getByRole('button', { name: /Filter by channel: Voyagr/i }),
    );
    await waitFor(() => {
      expect(screen.getByText('V-One')).toBeInTheDocument();
      expect(screen.queryByText('WF-Two')).not.toBeInTheDocument();
      expect(screen.queryByText('WA-Three')).not.toBeInTheDocument();
    });
  });
});

describe('<InboundLeads /> — empty state', () => {
  it('renders "No inbound leads yet" when zero inbound contacts exist', async () => {
    installFetchMock({
      contacts: [
        // Only non-inbound rows — none should survive the client filter.
        makeContact({ id: 1, source: 'manual' }),
        makeContact({ id: 2, source: 'csv-import' }),
      ],
    });
    renderPage();
    expect(
      await screen.findByText(/No inbound leads yet/i),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/external producers haven/i),
    ).toBeInTheDocument();
  });
});

describe('<InboundLeads /> — row content', () => {
  it('renders name + email + phone + channel badge + createdAt', async () => {
    installFetchMock({
      contacts: [
        makeContact({
          id: 9001,
          name: 'Rishab Mehra',
          email: 'rishab@example.com',
          phone: '+91 98765 43210',
          source: 'inbound:voyagr',
          createdAt: '2026-05-15T12:34:56.000Z',
        }),
      ],
    });
    renderPage();
    await screen.findByText('Rishab Mehra');
    expect(screen.getByText('rishab@example.com')).toBeInTheDocument();
    expect(screen.getByText('+91 98765 43210')).toBeInTheDocument();
    expect(screen.getByTestId('inbound-lead-channel-9001')).toHaveTextContent(
      /voyagr/i,
    );
    expect(screen.getByText('2026-05-15')).toBeInTheDocument();
  });
});

describe('<InboundLeads /> — Convert to Lead', () => {
  it('creates a pipeline Deal linked to the contact, then opens the pipeline', async () => {
    installFetchMock({
      contacts: [
        makeContact({ id: 4242, name: 'Convert Target', source: 'inbound:voyagr', subBrand: 'tmc' }),
      ],
    });
    renderPage();
    await screen.findByText('Convert Target');
    fireEvent.click(
      screen.getByRole('button', { name: /Convert Convert Target to Lead/i }),
    );
    // PRD: convert creates a Deal (the pipeline "Lead") linked to the Contact.
    await waitFor(() => {
      const dealCall = fetchApiMock.mock.calls.find(
        ([url, opts]) => url === '/api/deals' && opts && opts.method === 'POST',
      );
      expect(dealCall).toBeTruthy();
      const body = JSON.parse(dealCall[1].body);
      expect(body.contactId).toBe(4242);
      expect(body.subBrand).toBe('tmc');
    });
    // Then routes the operator to the Travel Leads page.
    await waitFor(() => expect(navigateMock).toHaveBeenCalledWith('/leads'));
  });
});

describe('<InboundLeads /> — date-range filter', () => {
  it('narrows rows by createdAt window (inclusive both ends)', async () => {
    installFetchMock({
      contacts: [
        makeContact({ id: 1, name: 'Old One', source: 'inbound:voyagr', createdAt: '2026-04-01T00:00:00.000Z' }),
        makeContact({ id: 2, name: 'Mid Two', source: 'inbound:voyagr', createdAt: '2026-05-15T00:00:00.000Z' }),
        makeContact({ id: 3, name: 'New Three', source: 'inbound:voyagr', createdAt: '2026-06-01T00:00:00.000Z' }),
      ],
    });
    renderPage();
    await screen.findByText('Old One');
    expect(screen.getByText('Mid Two')).toBeInTheDocument();
    expect(screen.getByText('New Three')).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText(/Created from/i), {
      target: { value: '2026-05-01' },
    });
    fireEvent.change(screen.getByLabelText(/Created to/i), {
      target: { value: '2026-05-31' },
    });
    await waitFor(() => {
      expect(screen.queryByText('Old One')).not.toBeInTheDocument();
      expect(screen.getByText('Mid Two')).toBeInTheDocument();
      expect(screen.queryByText('New Three')).not.toBeInTheDocument();
    });
  });
});

describe('<InboundLeads /> — 5xx error path', () => {
  it('5xx on /api/contacts fires notify.error', async () => {
    const err = new Error('Internal Server Error');
    err.status = 500;
    installFetchMock({ error: err });
    renderPage();
    await waitFor(() => {
      expect(notifyError).toHaveBeenCalled();
    });
    expect(notifyError.mock.calls[0][0]).toMatch(/Failed to load inbound leads/i);
  });
});

describe('<InboundLeads /> — "All" chip clears the channel narrowing', () => {
  it('clicking "All" after a specific channel reshows the full inbound set', async () => {
    installFetchMock({
      contacts: [
        makeContact({ id: 1, name: 'V-Row', source: 'inbound:voyagr' }),
        makeContact({ id: 2, name: 'WF-Row', source: 'inbound:webform' }),
      ],
    });
    renderPage();
    await screen.findByText('V-Row');

    // Narrow to webform first.
    fireEvent.click(
      screen.getByRole('button', { name: /Filter by channel: Web Form/i }),
    );
    await waitFor(() => {
      expect(screen.queryByText('V-Row')).not.toBeInTheDocument();
      expect(screen.getByText('WF-Row')).toBeInTheDocument();
    });

    // Then click "All" — both rows should re-render.
    fireEvent.click(
      screen.getByRole('button', { name: /Filter by channel: All/i }),
    );
    await waitFor(() => {
      expect(screen.getByText('V-Row')).toBeInTheDocument();
      expect(screen.getByText('WF-Row')).toBeInTheDocument();
    });
  });
});

describe('<InboundLeads /> — STUB marker present in source', () => {
  it('source contains "STUB #904 slice" so the next slice can grep for it', () => {
    const src = readFileSync(
      path.resolve(__dirname, '../pages/travel/InboundLeads.jsx'),
      'utf8',
    );
    expect(src).toMatch(/STUB #904 slice/);
  });
});

describe('<InboundLeads /> — converted state (no double-conversion)', () => {
  const INBOUND = {
    id: 42, name: 'Harsha vardhan', email: 'h@x.com',
    source: 'inbound:whatsapp', createdAt: '2026-06-19T00:00:00Z',
  };

  it('a contact that already has a Deal shows "Converted" and no Convert button', async () => {
    fetchApiMock.mockImplementation((url) => {
      if (typeof url !== 'string') return Promise.resolve(null);
      if (url.startsWith('/api/deals')) return Promise.resolve([{ id: 1, contactId: 42 }]);
      if (url.startsWith('/api/contacts')) return Promise.resolve([INBOUND]);
      return Promise.resolve(null);
    });
    renderPage();
    expect(await screen.findByText('Harsha vardhan')).toBeInTheDocument();
    expect(screen.getByText(/Converted/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Convert .* to Lead/i })).toBeNull();
  });

  it('a not-yet-converted inbound contact still shows the Convert button', async () => {
    fetchApiMock.mockImplementation((url) => {
      if (typeof url !== 'string') return Promise.resolve(null);
      if (url.startsWith('/api/deals')) return Promise.resolve([]);
      if (url.startsWith('/api/contacts')) return Promise.resolve([INBOUND]);
      return Promise.resolve(null);
    });
    renderPage();
    expect(await screen.findByText('Harsha vardhan')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Convert .* to Lead/i })).toBeInTheDocument();
    expect(screen.queryByText(/Converted/i)).toBeNull();
  });
});
