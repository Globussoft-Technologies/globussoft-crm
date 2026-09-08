/**
 * Callified calling on the lead lists — All Leads and Converted Leads.
 *
 * Both pages render the same controls through this module, so the contract is
 * pinned once here rather than twice per page.
 *
 * The load-bearing property is the GATE. `/leads` and `/converted-leads` are
 * cross-vertical pages: the generic CRM already has its own Callified flow on
 * the very same page, and travel has none. If the wellness action leaked onto
 * a generic tenant a user would see two competing call buttons, and on travel
 * a button whose endpoints 403. So the hook must stay off everywhere except a
 * wellness tenant with Callified actually configured — and must not even ASK
 * about Callified status on the other verticals.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';

const fetchApiMock = vi.fn();
vi.mock('../utils/api', () => ({
  fetchApi: (...args) => fetchApiMock(...args),
  getAuthToken: () => 'test-token',
}));

const notifyObj = { error: vi.fn(), success: vi.fn(), info: vi.fn(), confirm: vi.fn() };
vi.mock('../utils/notify', () => ({ useNotify: () => notifyObj }));

import { AuthContext } from '../App';
import { useLeadCalling } from '../hooks/useLeadCalling';
import { LeadCallButton, LeadCallDialog } from '../components/wellness/LeadCallAction';

const LEAD = { id: 31, name: 'Ravi Kumar', phone: '+919812345670', email: 'r@t.in' };

// A miniature version of what both lead pages do with the hook.
function Harness({ lead = LEAD }) {
  const call = useLeadCalling();
  return (
    <>
      <span data-testid="enabled">{String(call.enabled)}</span>
      {call.enabled && <LeadCallButton lead={lead} onCall={() => call.open(lead)} />}
      <LeadCallDialog lead={call.target} onClose={call.close} />
    </>
  );
}

function renderHarness(opts = {}) {
  // NOT a destructuring default: a tenant row with no vertical at all is a
  // real case, and `vertical = 'wellness'` would silently turn it into the
  // one vertical that IS allowed to call.
  const vertical = 'vertical' in opts ? opts.vertical : 'wellness';
  const lead = opts.lead || LEAD;
  return render(
    <MemoryRouter>
      <AuthContext.Provider
        value={{ user: { userId: 1, role: 'ADMIN' }, token: 'tk', tenant: { id: 1, vertical }, loading: false }}
      >
        <Harness lead={lead} />
      </AuthContext.Provider>
    </MemoryRouter>,
  );
}

function mockApi({ configured = true } = {}) {
  fetchApiMock.mockImplementation((url) => {
    if (typeof url !== 'string') return Promise.resolve({});
    if (url === '/api/wellness/callified/status') {
      return Promise.resolve({ configured, enabled: configured });
    }
    if (url.includes('/callified/leads/') && url.endsWith('/context')) {
      return Promise.resolve({
        leadId: 31,
        patientName: 'Ravi Kumar',
        contactId: 31,
        phone: LEAD.phone,
        normalizedPhone: LEAD.phone,
        phoneValid: true,
        recentCallAt: null,
      });
    }
    if (url === '/api/wellness/callified/campaigns') {
      return Promise.resolve({ campaigns: [{ id: 1, name: 'Recall' }] });
    }
    return Promise.resolve({});
  });
}

beforeEach(() => {
  fetchApiMock.mockReset();
  notifyObj.error.mockReset();
});

describe('useLeadCalling — the vertical gate', () => {
  it('is on for a wellness tenant with Callified configured', async () => {
    mockApi();
    renderHarness();
    await waitFor(() => expect(screen.getByTestId('enabled')).toHaveTextContent('true'));
    expect(screen.getByTestId('lead-call-31')).toBeInTheDocument();
  });

  it('is off for a wellness tenant with no Callified credentials', async () => {
    mockApi({ configured: false });
    renderHarness();
    await waitFor(() => expect(fetchApiMock).toHaveBeenCalled());
    expect(screen.getByTestId('enabled')).toHaveTextContent('false');
    expect(screen.queryByTestId('lead-call-31')).not.toBeInTheDocument();
  });

  it.each(['generic', 'travel', 'retail', undefined])(
    'stays off on a %s tenant and never even asks about Callified',
    async (vertical) => {
      mockApi();
      renderHarness({ vertical });

      expect(screen.getByTestId('enabled')).toHaveTextContent('false');
      // Generic already has its own Callified flow on this same page; asking
      // here would be a wasted request at best and a second call button at
      // worst. Travel has no calling at all.
      await waitFor(() =>
        expect(
          fetchApiMock.mock.calls.some((c) => c[0] === '/api/wellness/callified/status'),
        ).toBe(false),
      );
    },
  );
});

describe('LeadCallButton', () => {
  it('is disabled, not hidden, for a lead with no dialable number', async () => {
    mockApi();
    renderHarness({ lead: { ...LEAD, phone: '' } });

    const btn = await screen.findByTestId('lead-call-31');
    // The operator needs to know WHY they cannot call, so they can go and add
    // the number — hiding it reads as a missing feature.
    expect(btn).toBeDisabled();
    expect(btn).toHaveAttribute('title', 'No valid phone number on file');
  });

  it('rejects a number too short to dial', async () => {
    mockApi();
    renderHarness({ lead: { ...LEAD, phone: '98123' } });
    expect(await screen.findByTestId('lead-call-31')).toBeDisabled();
  });
});

describe('LeadCallDialog', () => {
  it('renders nothing until a lead is picked', () => {
    mockApi();
    renderHarness();
    expect(screen.queryByTestId('call-dialog')).not.toBeInTheDocument();
    expect(screen.queryByText(/Call Customer/i)).not.toBeInTheDocument();
  });

  it('opens against the LEAD endpoints, not the patient or visit ones', async () => {
    mockApi();
    const user = userEvent.setup();
    renderHarness();

    await user.click(await screen.findByTestId('lead-call-31'));

    await waitFor(() =>
      expect(fetchApiMock).toHaveBeenCalledWith(
        '/api/wellness/callified/leads/31/context',
        expect.anything(),
      ),
    );
    // A lead is a Contact, not a Patient and not an appointment. Hitting the
    // other surfaces with this id would dial an unrelated person.
    const urls = fetchApiMock.mock.calls.map((c) => c[0]).filter((u) => typeof u === 'string');
    expect(urls.some((u) => u.includes('/callified/patients/'))).toBe(false);
    expect(urls.some((u) => u.includes('/callified/visits/'))).toBe(false);
  });

  it('offers both call modes, so nothing dials on a single click', async () => {
    mockApi();
    const user = userEvent.setup();
    renderHarness();

    await user.click(await screen.findByTestId('lead-call-31'));

    expect(await screen.findByTestId('callified-call-mode-ai')).toBeInTheDocument();
    expect(screen.getByTestId('callified-call-mode-manual')).toBeInTheDocument();
  });
});
