import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';

const fetchApiMock = vi.fn();
vi.mock('../utils/api', () => ({
  fetchApi: (...args) => fetchApiMock(...args),
  getAuthToken: () => 'test-token',
}));

const notifyObj = {
  error: vi.fn(),
  success: vi.fn(),
  info: vi.fn(),
  confirm: vi.fn(() => Promise.resolve(true)),
};
vi.mock('../utils/notify', () => ({ useNotify: () => notifyObj }));

import ContactDetail from '../pages/ContactDetail';
import ContactDetailsDrawer from '../components/contact/ContactDetailsDrawer';
import { AuthContext } from '../appContexts';

const BASE_CONTACT = {
  id: 42,
  name: 'Priya Sharma',
  email: 'priya.sharma@example.com',
  phone: '+91-9000000001',
  title: 'VP Marketing',
  company: 'Acme Retail',
  status: 'Customer',
  aiScore: 85,
  source: 'Website',
  deals: [
    { id: 11, title: 'Q3 Renewal', amount: 145000, currency: 'INR', stage: 'won' },
    { id: 12, title: 'Add-on package', amount: 60000, currency: 'INR', stage: 'negotiation' },
  ],
  activities: [
    { id: 1, type: 'Email', description: 'Sent renewal quote', createdAt: '2026-05-20T10:00:00.000Z' },
    { id: 2, type: 'Call', description: 'Followed up on quote', createdAt: '2026-05-22T11:30:00.000Z' },
  ],
};

function makeFetchImpl(overrides = {}) {
  const options = {
    contact: { kind: 'ok', data: BASE_CONTACT },
    activities: { kind: 'ok', data: { data: BASE_CONTACT.activities, total: 2, page: 1, limit: 10, totalPages: 1 } },
    sms: { kind: 'ok', data: [{ id: 601, contactId: 42, body: 'Hello from SMS', direction: 'INBOUND', fromNumber: '+919000000002', contactName: 'Priya Sharma', createdAt: '2026-05-23T10:00:00.000Z' }] },
    emailThreads: { kind: 'ok', data: [{ subject: 'Renewal', messages: [{ id: 701, contactId: 42, body: 'Sent renewal quote', direction: 'OUTBOUND', to: BASE_CONTACT.email, contactName: 'Priya Sharma', createdAt: '2026-05-22T10:00:00.000Z' }] }] },
    staff: { kind: 'ok', data: [] },
    ...overrides,
  };
  const resolve = (slot) => {
    if (slot.kind === 'throw') return Promise.reject(slot.error || new Error('boom'));
    return Promise.resolve(slot.data);
  };
  return (url, opts) => {
    const method = opts?.method || 'GET';
    if (url === '/api/staff?fields=summary') return resolve(options.staff);
    if (/^\/api\/contacts\/\d+\/activities\?/.test(url)) return resolve(options.activities);
    if (/^\/api\/sms\/messages\?/.test(url)) return resolve(options.sms);
    if (url === '/api/email/threads') return resolve(options.emailThreads);
    if (/^\/api\/contacts\/\d+$/.test(url) && method === 'GET') return resolve(options.contact);
    return Promise.resolve([]);
  };
}

beforeEach(() => {
  fetchApiMock.mockReset();
  notifyObj.error.mockReset();
  notifyObj.success.mockReset();
  notifyObj.info.mockReset();
  notifyObj.confirm.mockReset();
  notifyObj.confirm.mockImplementation(() => Promise.resolve(true));
});

function renderPage({ contactId = 42, state, vertical } = {}) {
  const page = (
    <MemoryRouter initialEntries={[state ? { pathname: `/contacts/${contactId}`, state } : `/contacts/${contactId}`]}>
      <Routes>
        <Route path="/contacts/:id" element={<ContactDetail />} />
        <Route path="/contacts" element={<div data-testid="contacts-list-stub">Contacts list stub</div>} />
        <Route path="/travel/diagnostics" element={<div data-testid="diagnostics-list-stub">Diagnostics list stub</div>} />
      </Routes>
    </MemoryRouter>
  );
  return render(vertical
    ? <AuthContext.Provider value={{ tenant: { vertical } }}>{page}</AuthContext.Provider>
    : page);
}

async function getProfile() {
  return within(await screen.findByLabelText('Contact profile'));
}

describe('ContactDetail — current profile contract', () => {
  it('renders the loading placeholder before the contact GET resolves', () => {
    fetchApiMock.mockImplementation((url) => (
      /^\/api\/contacts\/\d+$/.test(url) ? new Promise(() => {}) : Promise.resolve([])
    ));
    renderPage();
    expect(screen.getByText('Loading contact…')).toBeInTheDocument();
  });

  it('renders the contact header, contact links, score, and current profile tabs', async () => {
    fetchApiMock.mockImplementation(makeFetchImpl());
    renderPage();
    const profile = await getProfile();
    expect(profile.getByText('Priya Sharma', { exact: true })).toBeInTheDocument();
    expect(profile.getAllByRole('link', { name: BASE_CONTACT.email }).length).toBeGreaterThan(0);
    expect(profile.getAllByRole('link', { name: BASE_CONTACT.phone }).length).toBeGreaterThan(0);
    expect(profile.getByText('85', { exact: true })).toBeInTheDocument();
    expect(profile.getByText(/VP Marketing.*Acme Retail/)).toBeInTheDocument();
    for (const tab of ['Overview', 'Contact details', 'Conversation', 'Activities']) {
      expect(profile.getByRole('button', { name: tab })).toBeInTheDocument();
    }
  });

  it('uses the originating diagnostics URL when closing the profile', async () => {
    fetchApiMock.mockImplementation(makeFetchImpl());
    renderPage({ state: { backTo: '/travel/diagnostics?page=2' } });
    expect(await screen.findByLabelText('Contact profile')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Close profile' }));
    expect(await screen.findByTestId('diagnostics-list-stub')).toBeInTheDocument();
  });

  it('returns to Contacts when the profile has no originating route', async () => {
    fetchApiMock.mockImplementation(makeFetchImpl());
    renderPage();
    expect(await screen.findByLabelText('Contact profile')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Close profile' }));
    expect(await screen.findByTestId('contacts-list-stub')).toBeInTheDocument();
  });

  it('shows the current lifecycle stage and score for the contact', async () => {
    fetchApiMock.mockImplementation(makeFetchImpl());
    renderPage();
    const profile = await getProfile();
    expect(profile.getByText('Qualified', { exact: true })).toBeInTheDocument();
    expect(profile.getByText('85', { exact: true })).toBeInTheDocument();
  });

  it('does not render an orphan title/company separator when both values are empty', async () => {
    fetchApiMock.mockImplementation(makeFetchImpl({
      contact: { kind: 'ok', data: { ...BASE_CONTACT, title: '', company: '' } },
    }));
    renderPage();
    const profile = await getProfile();
    expect(profile.getByText('Priya Sharma', { exact: true })).toBeInTheDocument();
    expect(profile.queryByText(/VP Marketing/)).toBeNull();
    expect(profile.queryByText(/Acme Retail/)).toBeNull();
  });

  it('shows the empty phone value in the overview when no phone is available', async () => {
    fetchApiMock.mockImplementation(makeFetchImpl({
      contact: { kind: 'ok', data: { ...BASE_CONTACT, phone: '' } },
    }));
    renderPage();
    const profile = await getProfile();
    expect(profile.queryByRole('link', { name: BASE_CONTACT.phone })).toBeNull();
    expect(profile.getAllByText('Not available').length).toBeGreaterThan(0);
  });

  it('renders the contact deals in the overview', async () => {
    fetchApiMock.mockImplementation(makeFetchImpl());
    renderPage();
    const profile = await getProfile();
    expect(profile.getByText('Q3 Renewal')).toBeInTheDocument();
    expect(profile.getByText('Add-on package')).toBeInTheDocument();
    expect(profile.getAllByRole('button', { name: 'Add deal' }).length).toBeGreaterThan(0);
  });

  it('renders actual SMS and email messages in the Conversation tab with the person name', async () => {
    fetchApiMock.mockImplementation(makeFetchImpl());
    renderPage();
    const profile = await getProfile();
    fireEvent.click(profile.getByRole('button', { name: 'Conversation' }));
    expect(await profile.findByText('Conversation (2)')).toBeInTheDocument();
    expect(profile.getByText('Hello from SMS')).toBeInTheDocument();
    expect(profile.getByText('Sent renewal quote')).toBeInTheDocument();
    expect(profile.getAllByText('Priya Sharma', { exact: true }).length).toBeGreaterThan(0);
    expect(profile.queryByRole('button', { name: /WhatsApp/i })).toBeNull();
  });

  it('keeps activities separate and paginated from conversations', async () => {
    fetchApiMock.mockImplementation(makeFetchImpl());
    renderPage();
    const profile = await getProfile();
    fireEvent.click(profile.getByRole('button', { name: 'Activities' }));
    expect(await profile.findByText('Activities (2)')).toBeInTheDocument();
    expect(profile.getByText('Sent renewal quote')).toBeInTheDocument();
    expect(profile.getByText('Followed up on quote')).toBeInTheDocument();
    expect(fetchApiMock).toHaveBeenCalledWith(
      '/api/contacts/42/activities?page=1&limit=10',
      expect.objectContaining({ silent: true }),
    );
  });

  it('shows the empty activity state when the activity API returns no records', async () => {
    fetchApiMock.mockImplementation(makeFetchImpl({
      activities: { kind: 'ok', data: { data: [], total: 0, page: 1, limit: 10, totalPages: 1 } },
    }));
    renderPage();
    const profile = await getProfile();
    fireEvent.click(profile.getByRole('button', { name: 'Activities' }));
    expect(await profile.findByText('No activities recorded yet.')).toBeInTheDocument();
  });
});

describe('Generic CRM contact tags', () => {
  it('selects an existing tag and creates a new tag without duplicates', async () => {
    const saveTags = vi.fn().mockResolvedValue(undefined);
    fetchApiMock.mockImplementation((url, options = {}) => {
      if (url === '/api/lead-custom-fields') return Promise.resolve([]);
      if (url === '/api/contacts/tags' && options.method === 'POST') return Promise.resolve({ name: 'Renewal', color: '#db2777' });
      if (url === '/api/contacts/tags') return Promise.resolve({ tags: [{ name: 'VIP', color: '#2563eb' }, { name: 'Prospect', color: '#059669' }] });
      return Promise.resolve({});
    });
    render(
      <AuthContext.Provider value={{ tenant: { vertical: 'generic' } }}>
        <ContactDetailsDrawer inline genericTagsEnabled contact={{ ...BASE_CONTACT, tags: ['VIP'] }} onFieldSave={saveTags} />
      </AuthContext.Provider>,
    );

    fireEvent.click(await screen.findByRole('button', { name: '+ Add tag' }));
    const picker = await screen.findByRole('dialog', { name: 'Tag selector' });
    const vipLabel = within(picker).getByText('VIP', { exact: true });
    expect(vipLabel.closest('button')).toHaveAttribute('aria-selected', 'true');
    fireEvent.click(within(picker).getByText('Prospect', { exact: true }));
    fireEvent.change(within(picker).getByRole('textbox', { name: 'New tag name' }), { target: { value: 'Renewal' } });
    fireEvent.click(within(picker).getByRole('button', { name: 'Create' }));
    await waitFor(() => expect(fetchApiMock).toHaveBeenCalledWith('/api/contacts/tags', expect.objectContaining({ method: 'POST' })));
    fireEvent.click(within(picker).getByRole('button', { name: 'Apply tags' }));

    await waitFor(() => expect(saveTags).toHaveBeenCalledWith({ key: 'tags' }, ['VIP', 'Prospect', 'Renewal']));
  });

  it.each(['wellness', 'travel'])('does not request the Generic tag catalog for %s CRM', async (vertical) => {
    fetchApiMock.mockImplementation(makeFetchImpl());
    renderPage({ vertical });

    expect(await screen.findByLabelText('Contact profile')).toBeInTheDocument();
    expect(fetchApiMock.mock.calls.some(([url]) => url === '/api/contacts/tags')).toBe(false);
  });
});
