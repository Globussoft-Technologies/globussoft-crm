/**
 * FlyerShareAdmin.test.jsx — vitest + RTL coverage for the Travel-vertical
 * operator UI for flyer share-link admin (mint + history + revoke), slice
 * S79 of TRAVEL_BIG_SCOPE_BACKLOG. SUT: frontend/src/pages/travel/FlyerShareAdmin.jsx.
 *
 * Scope — pins the lifecycle UX:
 *
 *   1. Page chrome + ADMIN role gate:
 *      a) ADMIN sees the heading + Refresh + template list.
 *      b) USER (non-ADMIN) sees the access-denied surface — NO fetch fires.
 *
 *   2. Initial template list fetch (GET /api/travel/flyer-templates).
 *
 *   3. Empty templates state — copy + data-testid surface.
 *
 *   4. Selecting a template loads its mint history via
 *      GET /api/audit-viewer/entity/TravelFlyerTemplate/:id, filtered to
 *      action='TRAVEL_FLYER_PUBLIC_SHARE_MINTED' rows.
 *
 *   5. Mint button — POST /api/v1/flyers/:id/share with the selected TTL
 *      surfaces shareUrl + embedCode + expiresAt in the modal.
 *
 *   6. Copy-shareUrl button calls navigator.clipboard.writeText.
 *
 *   7. Copy-embedCode button calls navigator.clipboard.writeText.
 *
 *   8. Mint error (500) → notify.error path, NO modal.
 *
 *   9. Revoke button (graceful 404): POST /:id/revoke-share returns 404 →
 *      notify.info("Revoke endpoint not yet shipped …"). No throw, no
 *      red banner — the link expires naturally at expiresAt.
 *
 *  10. Revoke button (success): same POST returns 200 → notify.success
 *      and the row flips to the optimistic "Revoked" badge.
 *
 * RTL discipline (per CLAUDE.md standing rules):
 *   - useNotify mocked with a STABLE module-level notifyObj ref so
 *     hook-identity stays stable across renders.
 *   - fetchApi mocked at ../utils/api.
 *   - navigator.clipboard.writeText monkey-patched per test.
 *   - AuthContext provided via the real App module's Provider with USER ≠ ADMIN
 *     to exercise the role gate.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

const fetchApiMock = vi.fn();
vi.mock('../utils/api', () => ({
  fetchApi: (...args) => fetchApiMock(...args),
  getAuthToken: () => 'test-token',
  getActiveTenantId: () => 1,
}));

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
}));

import { AuthContext } from '../App';
import FlyerShareAdmin from '../pages/travel/FlyerShareAdmin';

const ADMIN_USER = { userId: 1, name: 'Admin', email: 'a@x.com', role: 'ADMIN' };
const USER_USER = { userId: 2, name: 'Plain User', email: 'u@x.com', role: 'USER' };

function makeTemplate(overrides = {}) {
  return {
    id: 501,
    tenantId: 1,
    subBrand: 'tmc',
    name: 'TMC Summer Europe Flyer',
    palette: {
      primaryHex: '#122647',
      secondaryHex: '#265855',
      accentHex: '#C89A4E',
      textHex: '#222222',
      bgHex: '#FFFDF7',
    },
    layout: [],
    assets: {},
    createdAt: '2026-05-25T10:00:00.000Z',
    updatedAt: '2026-05-25T10:00:00.000Z',
    ...overrides,
  };
}

const TEMPLATES_DEFAULT = [
  makeTemplate({ id: 501, name: 'TMC Summer Europe Flyer' }),
  makeTemplate({ id: 502, name: 'RFU Ramadan Umrah Flyer', subBrand: 'rfu' }),
];

const MINT_RESULT = {
  shareUrl: 'https://crm.globusdemos.com/p/flyer/tmc-summer-europe-flyer?t=abc.def.ghi',
  embedCode: '<iframe src="https://crm.globusdemos.com/p/flyer/tmc-summer-europe-flyer?t=abc.def.ghi&embed=1" width="1200" height="1200" frameborder="0" allowfullscreen></iframe>',
  expiresAt: '2026-06-18T10:00:00.000Z',
  slug: 'tmc-summer-europe-flyer',
  flyerId: 501,
};

// The component rebases the minted URL onto window.location.origin (so a link
// minted behind a dev tunnel / Vite proxy still points at the host the
// operator is on, not the backend-seen localhost). The displayed + copied
// values are these rebased forms.
const REBASED_SHARE_URL = `${window.location.origin}/p/flyer/tmc-summer-europe-flyer?t=abc.def.ghi`;
const REBASED_EMBED_CODE = `<iframe src="${window.location.origin}/p/flyer/tmc-summer-europe-flyer?t=abc.def.ghi&embed=1" width="1200" height="1200" frameborder="0" allowfullscreen></iframe>`;

const HISTORY_LOGS_DEFAULT = {
  entity: 'TravelFlyerTemplate',
  entityId: 501,
  total: 2,
  logs: [
    {
      id: 9001,
      entity: 'TravelFlyerTemplate',
      entityId: 501,
      action: 'TRAVEL_FLYER_PUBLIC_SHARE_MINTED',
      userId: 1,
      createdAt: '2026-05-30T12:00:00.000Z',
      metadata: JSON.stringify({
        flyerId: 501,
        slug: 'tmc-summer-europe-flyer',
        expiresAt: '2026-06-06T12:00:00.000Z',
        expiresInSec: 604800,
      }),
    },
    // A non-mint row (a public render) should NOT appear in history.
    {
      id: 9002,
      entity: 'TravelFlyerTemplate',
      entityId: 501,
      action: 'TRAVEL_FLYER_PUBLIC_RENDER',
      userId: null,
      createdAt: '2026-05-30T13:00:00.000Z',
      metadata: JSON.stringify({ flyerId: 501, slug: 'tmc-summer-europe-flyer' }),
    },
  ],
};

function installFetchMock({
  list = { templates: TEMPLATES_DEFAULT, total: TEMPLATES_DEFAULT.length },
  mint = MINT_RESULT,
  history = HISTORY_LOGS_DEFAULT,
  revoke = null, // null → success (resolves to {}); pass Error/404 to test fallback.
} = {}) {
  fetchApiMock.mockImplementation((url, opts) => {
    const method = (opts && opts.method) || 'GET';
    if (url === '/api/travel/flyer-templates' && method === 'GET') {
      if (list instanceof Error) return Promise.reject(list);
      return Promise.resolve(list);
    }
    if (/^\/api\/audit-viewer\/entity\/TravelFlyerTemplate\/\d+$/.test(url) && method === 'GET') {
      if (history instanceof Error) return Promise.reject(history);
      return Promise.resolve(history);
    }
    if (/^\/api\/v1\/flyers\/\d+\/share$/.test(url) && method === 'POST') {
      if (mint instanceof Error) return Promise.reject(mint);
      return Promise.resolve(mint);
    }
    if (/^\/api\/v1\/flyers\/\d+\/revoke-share$/.test(url) && method === 'POST') {
      if (revoke instanceof Error) return Promise.reject(revoke);
      return Promise.resolve(revoke || {});
    }
    return Promise.resolve(null);
  });
}

function renderPage(user = ADMIN_USER) {
  const value = { user, token: 'tk', tenant: { id: 1, defaultCurrency: 'INR' }, loading: false };
  return render(
    <MemoryRouter>
      <AuthContext.Provider value={value}>
        <FlyerShareAdmin />
      </AuthContext.Provider>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  fetchApiMock.mockReset();
  notifyError.mockReset();
  notifySuccess.mockReset();
  notifyInfo.mockReset();
  notifyConfirm.mockReset();
  notifyConfirm.mockResolvedValue(true);
  installFetchMock();
});

describe('<FlyerShareAdmin /> — page chrome + role gate', () => {
  it('renders heading + Refresh + template list for ADMIN', async () => {
    renderPage();
    expect(
      screen.getByRole('heading', { name: /Flyer Share Admin/i }),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Refresh templates/i })).toBeInTheDocument();
    await screen.findAllByText('TMC Summer Europe Flyer');
    await waitFor(() => {
      expect(fetchApiMock).toHaveBeenCalledWith(
        '/api/travel/flyer-templates',
        expect.any(Object),
      );
    });
  });

  it('renders access-denied surface for non-ADMIN role and DOES NOT fetch', async () => {
    renderPage(USER_USER);
    expect(
      screen.getByRole('heading', { name: /Flyer Share Admin/i }),
    ).toBeInTheDocument();
    // The role-gate alert mentions ADMIN.
    expect(screen.getByRole('alert')).toHaveTextContent(/restricted to ADMIN/i);
    // The role gate short-circuits before useEffect's fetch fires.
    await new Promise((r) => setTimeout(r, 50));
    expect(fetchApiMock).not.toHaveBeenCalled();
  });
});

describe('<FlyerShareAdmin /> — template list', () => {
  it('renders empty state when API returns no templates', async () => {
    installFetchMock({ list: { templates: [], total: 0 } });
    renderPage();
    await screen.findByTestId('flyer-share-empty');
    expect(screen.getByTestId('flyer-share-empty')).toHaveTextContent(/No flyer templates yet/i);
  });

  it('auto-selects the first template on initial load and fetches its history', async () => {
    renderPage();
    await screen.findAllByText('TMC Summer Europe Flyer');
    // The first template's history call fires.
    await waitFor(() => {
      const calls = fetchApiMock.mock.calls.map((c) => c[0]);
      expect(calls).toContain('/api/audit-viewer/entity/TravelFlyerTemplate/501');
    });
  });

  it('clicking a different template row switches selection and refetches history', async () => {
    renderPage();
    await screen.findByText('RFU Ramadan Umrah Flyer');
    const row = screen.getByTestId('flyer-share-template-row-502');
    fireEvent.click(row);
    await waitFor(() => {
      const calls = fetchApiMock.mock.calls.map((c) => c[0]);
      expect(calls).toContain('/api/audit-viewer/entity/TravelFlyerTemplate/502');
    });
  });
});

describe('<FlyerShareAdmin /> — mint workflow', () => {
  it('Mint button POSTs /api/v1/flyers/:id/share and opens the result modal', async () => {
    renderPage();
    await screen.findAllByText('TMC Summer Europe Flyer');
    const mintBtn = await screen.findByTestId('flyer-share-mint-btn');
    fireEvent.click(mintBtn);
    await waitFor(() => {
      const postCall = fetchApiMock.mock.calls.find(
        (c) => /^\/api\/v1\/flyers\/501\/share$/.test(c[0]) && c[1]?.method === 'POST',
      );
      expect(postCall).toBeTruthy();
    });
    // Modal shows the URL + embed + expires.
    await screen.findByTestId('flyer-share-mint-modal');
    expect(screen.getByTestId('flyer-share-result-url')).toHaveTextContent(REBASED_SHARE_URL);
    expect(screen.getByTestId('flyer-share-result-embed')).toHaveTextContent(/iframe/);
    expect(screen.getByTestId('flyer-share-result-expires')).toBeInTheDocument();
    expect(notifySuccess).toHaveBeenCalled();
  });

  it('selecting a TTL preset updates the body sent on Mint', async () => {
    renderPage();
    await screen.findAllByText('TMC Summer Europe Flyer');
    // Pick "1 hour" preset.
    fireEvent.click(screen.getByTestId('ttl-preset-3600'));
    fireEvent.click(await screen.findByTestId('flyer-share-mint-btn'));
    await waitFor(() => {
      const postCall = fetchApiMock.mock.calls.find(
        (c) => /^\/api\/v1\/flyers\/\d+\/share$/.test(c[0]) && c[1]?.method === 'POST',
      );
      expect(postCall).toBeTruthy();
      const body = JSON.parse(postCall[1].body);
      expect(body.expiresInSec).toBe(3600);
    });
  });

  it('Copy URL button calls navigator.clipboard.writeText with the shareUrl', async () => {
    const writeText = vi.fn(() => Promise.resolve());
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });
    renderPage();
    await screen.findAllByText('TMC Summer Europe Flyer');
    fireEvent.click(await screen.findByTestId('flyer-share-mint-btn'));
    await screen.findByTestId('flyer-share-mint-modal');
    fireEvent.click(screen.getByTestId('flyer-share-copy-url-btn'));
    await waitFor(() => {
      expect(writeText).toHaveBeenCalledWith(REBASED_SHARE_URL);
    });
    expect(notifySuccess).toHaveBeenCalledWith(expect.stringMatching(/Share URL copied/i));
  });

  it('Copy embed-code button calls navigator.clipboard.writeText with the embedCode', async () => {
    const writeText = vi.fn(() => Promise.resolve());
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });
    renderPage();
    await screen.findAllByText('TMC Summer Europe Flyer');
    fireEvent.click(await screen.findByTestId('flyer-share-mint-btn'));
    await screen.findByTestId('flyer-share-mint-modal');
    fireEvent.click(screen.getByTestId('flyer-share-copy-embed-btn'));
    await waitFor(() => {
      expect(writeText).toHaveBeenCalledWith(REBASED_EMBED_CODE);
    });
    expect(notifySuccess).toHaveBeenCalledWith(expect.stringMatching(/Embed code copied/i));
  });

  it('Mint error path (500) surfaces notify.error and NO modal opens', async () => {
    const err = new Error('Server exploded');
    err.status = 500;
    installFetchMock({ mint: err });
    renderPage();
    await screen.findAllByText('TMC Summer Europe Flyer');
    fireEvent.click(await screen.findByTestId('flyer-share-mint-btn'));
    await waitFor(() => {
      expect(notifyError).toHaveBeenCalledWith(expect.stringMatching(/Server exploded|Failed to mint/i));
    });
    expect(screen.queryByTestId('flyer-share-mint-modal')).toBeNull();
  });
});

describe('<FlyerShareAdmin /> — history + revoke', () => {
  it('renders past mint audit rows for the selected template, filtering out non-mint actions', async () => {
    renderPage();
    await screen.findAllByText('TMC Summer Europe Flyer');
    // Mint audit row 9001 shows up.
    const row = await screen.findByTestId('flyer-share-history-row-9001');
    expect(row).toBeInTheDocument();
    expect(within(row).getByText(/tmc-summer-europe-flyer/i)).toBeInTheDocument();
    // The render row (9002) is NOT surfaced as a history entry.
    expect(screen.queryByTestId('flyer-share-history-row-9002')).toBeNull();
  });

  it('shows empty-history copy when no mint rows exist', async () => {
    installFetchMock({
      history: {
        entity: 'TravelFlyerTemplate',
        entityId: 501,
        total: 0,
        logs: [],
      },
    });
    renderPage();
    await screen.findAllByText('TMC Summer Europe Flyer');
    await screen.findByTestId('flyer-share-history-empty');
  });

  it('Revoke button: graceful 404 surfaces notify.info ("tracked in S80"), no error banner', async () => {
    const err = new Error('Not found');
    err.status = 404;
    installFetchMock({ revoke: err });
    renderPage();
    await screen.findAllByText('TMC Summer Europe Flyer');
    const revokeBtn = await screen.findByTestId('flyer-share-revoke-9001');
    fireEvent.click(revokeBtn);
    await waitFor(() => {
      expect(notifyConfirm).toHaveBeenCalled();
    });
    await waitFor(() => {
      expect(notifyInfo).toHaveBeenCalledWith(expect.stringMatching(/S80/));
    });
    // notify.error did NOT fire — the 404 was caught as a graceful fallback.
    expect(notifyError).not.toHaveBeenCalled();
  });

  it('Revoke button: success path fires notify.success and POSTs to revoke-share with slug + mintedAt', async () => {
    renderPage();
    await screen.findAllByText('TMC Summer Europe Flyer');
    const revokeBtn = await screen.findByTestId('flyer-share-revoke-9001');
    fireEvent.click(revokeBtn);
    await waitFor(() => {
      const postCall = fetchApiMock.mock.calls.find(
        (c) => /^\/api\/v1\/flyers\/501\/revoke-share$/.test(c[0]) && c[1]?.method === 'POST',
      );
      expect(postCall).toBeTruthy();
      const body = JSON.parse(postCall[1].body);
      expect(body.slug).toBe('tmc-summer-europe-flyer');
      expect(body.mintedAt).toBe('2026-05-30T12:00:00.000Z');
    });
    await waitFor(() => {
      expect(notifySuccess).toHaveBeenCalledWith(expect.stringMatching(/revoked/i));
    });
  });

  it('Revoke confirm-NO does not fire the revoke POST', async () => {
    notifyConfirm.mockResolvedValueOnce(false);
    renderPage();
    await screen.findAllByText('TMC Summer Europe Flyer');
    const revokeBtn = await screen.findByTestId('flyer-share-revoke-9001');
    fireEvent.click(revokeBtn);
    await waitFor(() => {
      expect(notifyConfirm).toHaveBeenCalled();
    });
    // Wait briefly to be sure no POST fires.
    await new Promise((r) => setTimeout(r, 50));
    const postCall = fetchApiMock.mock.calls.find(
      (c) => /^\/api\/v1\/flyers\/\d+\/revoke-share$/.test(c[0]),
    );
    expect(postCall).toBeFalsy();
  });
});
