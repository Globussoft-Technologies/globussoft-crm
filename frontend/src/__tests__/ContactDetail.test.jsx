import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
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
  website: 'https://company.example.com',
  webFormSubmissions: [{
    id: 91,
    submittedAt: '2026-10-14T04:30:00.000Z',
    payloadJson: JSON.stringify({
      _meta: {
        tracking: {
          pageUrl: 'https://example.com/pricing',
          location: 'Koramangala, Bengaluru, Karnataka, 560034, India',
        },
      },
    }),
  }],
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
    workflow: { kind: 'ok', data: {
      customers: [{
        contactId: 42,
        pickupAddress: 'Kursakanta, Bihar, India',
        assignedPlots: [{ id: 301, name: 'Green Meadows', plotNumber: 'A-17' }],
        currentStage: 'transport',
        currentStatus: 'awaiting_transport',
      }],
    } },
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
    if (url === '/api/pickup-plot-inventory/lead-status?contactIds=42') return resolve(options.workflow);
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

function renderPage({ contactId = 42, state, vertical, user, listType = 'contacts' } = {}) {
  const detailPath = `/${listType}/${contactId}`;
  const page = (
    <MemoryRouter initialEntries={[state ? { pathname: detailPath, state } : detailPath]}>
      <Routes>
        <Route path="/contacts/:id" element={<ContactDetail />} />
        <Route path="/leads/:id" element={<ContactDetail />} />
        <Route path="/contacts" element={<div data-testid="contacts-list-stub">Contacts list stub</div>} />
        <Route path="/leads" element={<div data-testid="leads-list-stub">Leads list stub</div>} />
        <Route path="/travel/diagnostics" element={<div data-testid="diagnostics-list-stub">Diagnostics list stub</div>} />
      </Routes>
    </MemoryRouter>
  );
  return render(vertical || user
    ? <AuthContext.Provider value={{ tenant: { vertical }, user }}>{page}</AuthContext.Provider>
    : page);
}

async function getProfile() {
  return within(await screen.findByLabelText('Contact profile'));
}

describe('ContactDetail — current profile contract', () => {
  it('shows the owner without a reassignment control for a read-only travel role', async () => {
    fetchApiMock.mockImplementation(makeFetchImpl({
      contact: { kind: 'ok', data: { ...BASE_CONTACT, assignedToId: 7, assignedTo: { id: 7, name: 'TMC Operator' } } },
    }));
    renderPage({ vertical: 'travel', user: { role: 'USER', permissions: ['contacts.read', 'leads.read'] } });

    await getProfile();
    expect(screen.getAllByText('TMC Operator').length).toBeGreaterThan(0);
    expect(screen.queryByRole('combobox', { name: 'Sales owner' })).not.toBeInTheDocument();
    expect(fetchApiMock).not.toHaveBeenCalledWith('/api/contacts/assignees', expect.anything());
  });

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

  it('keeps the Generic Leads page behind a profile opened from /leads', async () => {
    fetchApiMock.mockImplementation(makeFetchImpl());
    renderPage({ listType: 'leads', vertical: 'generic' });

    expect(await screen.findByLabelText('Contact profile')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Leads' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Contacts' })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Close profile' }));
    expect(await screen.findByTestId('leads-list-stub')).toBeInTheDocument();
  });

  it('sends the lead sequence action to Marketing Campaign sequences', async () => {
    fetchApiMock.mockImplementation(makeFetchImpl());
    renderPage({ listType: 'leads', vertical: 'generic' });

    expect(await screen.findByRole('link', { name: 'Add to a sequence' }))
      .toHaveAttribute('href', '/marketing?tab=campaigns');
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

  it('shows Generic Customize-table fields and web-form tracking in Contact details', async () => {
    fetchApiMock.mockImplementation(makeFetchImpl());
    renderPage();
    const profile = await getProfile();

    fireEvent.click(profile.getByRole('button', { name: 'Contact details' }));

    expect(profile.getByText('Page URL')).toBeInTheDocument();
    expect(profile.getByText('https://example.com/pricing')).toBeInTheDocument();
    expect(profile.getByText('Location')).toBeInTheDocument();
    expect(profile.getByText('Koramangala, Bengaluru, Karnataka, 560034, India')).toBeInTheDocument();
    expect(profile.getByText('Website URL')).toBeInTheDocument();
    expect(profile.getByText('Source')).toBeInTheDocument();
    expect(profile.getByText('Medium')).toBeInTheDocument();
    expect(profile.getByText('Pickup Location')).toBeInTheDocument();
    expect(await profile.findByText('Kursakanta, Bihar, India')).toBeInTheDocument();
    expect(profile.getByText('Plot Assign')).toBeInTheDocument();
    expect(profile.getByText('A-17')).toBeInTheDocument();
    expect(profile.getByText('Overall Status')).toBeInTheDocument();
    expect(profile.getByText('Transport: Awaiting Transport')).toBeInTheDocument();
    expect(profile.getByText('Callified Campaign')).toBeInTheDocument();
    expect(profile.getByText('Call Status')).toBeInTheDocument();
    expect(profile.getByText('Callified Score')).toBeInTheDocument();
    expect(profile.getByText('First Touch Source')).toBeInTheDocument();
    expect(profile.getByText('Last Touch Source')).toBeInTheDocument();
  });

  it.each(['wellness', 'travel'])('preserves Website URL outside Generic CRM (%s)', async (vertical) => {
    fetchApiMock.mockImplementation(makeFetchImpl());
    renderPage({ vertical });
    const profile = await getProfile();

    fireEvent.click(profile.getByRole('button', {
      name: vertical === 'wellness' ? 'Patient details' : 'Contact details',
    }));

    expect(profile.getByText('Website URL')).toBeInTheDocument();
    expect(profile.queryByText('Page URL')).toBeNull();
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

  it('shows inbox-style email previews and opens the complete message', async () => {
    const body = 'Hello Laura,\n\nThis is a long email that belongs in the reader.\nSecond paragraph.';
    fetchApiMock.mockImplementation(makeFetchImpl({
      emailThreads: { kind: 'ok', data: [{ subject: 'Follow-up', messages: [{ id: 702, contactId: 42, body, direction: 'INBOUND', from: 'laura@example.com', to: BASE_CONTACT.email, createdAt: '2026-05-22T10:00:00.000Z' }] }] },
    }));
    renderPage();
    const profile = await getProfile();
    fireEvent.click(profile.getByRole('button', { name: 'Conversation' }));
    const preview = await profile.findByRole('button', { name: 'Open email: Follow-up' });
    expect(preview).toHaveClass('cp-email-row');
    expect(preview).toHaveTextContent('laura@example.com');
    expect(preview).toHaveTextContent('Follow-up');
    expect(preview).toHaveTextContent('Hello Laura, This is a long email');
    expect(profile.queryByRole('dialog')).toBeNull();
    fireEvent.click(preview);
    const reader = profile.getByRole('dialog');
    expect(reader.querySelector('.cp-email-detail-body').textContent).toBe(body);
    expect(reader).toHaveTextContent(`to ${BASE_CONTACT.email}`);
    fireEvent.click(within(reader).getByRole('button', { name: 'Close' }));
    expect(profile.queryByRole('dialog')).toBeNull();
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

  it('opens the note editor from the pencil and persists the updated note', async () => {
    const note = {
      id: 81,
      type: 'Note',
      description: 'Original note',
      createdAt: '2026-10-21T06:00:00.000Z',
      contactId: 42,
      userId: 7,
    };
    const baseFetch = makeFetchImpl({
      activities: { kind: 'ok', data: { data: [note], total: 1, page: 1, limit: 5, totalPages: 1 } },
    });
    fetchApiMock.mockImplementation((url, opts) => {
      if (url === '/api/contacts/42/activities/81' && opts?.method === 'PATCH') {
        return Promise.resolve({ ...note, description: 'Updated note' });
      }
      return baseFetch(url, opts);
    });
    renderPage();
    const profile = await getProfile();

    fireEvent.click(await profile.findByRole('button', { name: 'Edit note Original note' }));
    const dialog = screen.getByRole('dialog', { name: 'Edit note' });
    const editor = within(dialog).getByRole('textbox', { name: 'Note content' });
    await waitFor(() => expect(editor).toHaveTextContent('Original note'));
    editor.textContent = 'Updated note';
    fireEvent.input(editor);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Done' }));

    await waitFor(() => expect(fetchApiMock).toHaveBeenCalledWith(
      '/api/contacts/42/activities/81',
      expect.objectContaining({ method: 'PATCH', body: JSON.stringify({ description: 'Updated note' }) }),
    ));
    expect(await profile.findByText('Updated note')).toBeInTheDocument();
    expect(notifyObj.success).toHaveBeenCalledWith('Note updated.');
  });

  it('keeps immediately typed text in the generic note composer', async () => {
    fetchApiMock.mockImplementation(makeFetchImpl());
    renderPage({ vertical: 'generic' });
    const profile = await getProfile();
    const user = userEvent.setup();

    await user.click(profile.getByRole('button', { name: /^Note$/ }));
    const dialog = await screen.findByRole('dialog', { name: 'Add note' });
    const editor = within(dialog).getByRole('textbox', { name: 'Note content' });
    await user.type(editor, 'Follow up tomorrow');

    expect(editor).toHaveTextContent('Follow up tomorrow');
    expect(editor).toHaveFocus();
  });
});

describe('Generic CRM contact details', () => {
  it('filters contact data into Basic, UTM, Custom Tracking, and Ad Information tabs', async () => {
    fetchApiMock.mockImplementation((url) => {
      if (url === '/api/lead-custom-fields') return Promise.resolve({ fields: [{ id: 1, label: 'Service Type', fieldKey: 'service_type', fieldType: 'text' }] });
      if (url === '/api/contacts/tags') return Promise.resolve({ tags: [] });
      return Promise.resolve({});
    });
    const contact = {
      ...BASE_CONTACT,
      customFields: { service_type: 'SEO' },
      webFormSubmissions: [{
        id: 92,
        submittedAt: '2026-10-14T04:30:00.000Z',
        webForm: { id: 8, name: 'October Lead Form' },
        payloadJson: JSON.stringify({
          _meta: { tracking: { pageUrl: 'https://example.com/offer', referrerUrl: 'https://search.example/referrer', utm_source: 'meta', utm_campaign: 'October leads' } },
        }),
      }],
    };

    render(
      <AuthContext.Provider value={{ tenant: { vertical: 'generic' } }}>
        <ContactDetailsDrawer inline genericTagsEnabled contact={contact} />
      </AuthContext.Provider>,
    );

    const tabs = await screen.findByRole('tablist', { name: 'Contact detail groups' });
    for (const label of ['All details', 'Basic information', 'UTM Tracker', 'Custom Tracking', 'Ad Information']) {
      expect(within(tabs).getByRole('tab', { name: label })).toBeInTheDocument();
    }

    fireEvent.click(within(tabs).getByRole('tab', { name: 'UTM Tracker' }));
    expect(screen.getByText('meta')).toBeInTheDocument();
    expect(screen.getByText('October leads')).toBeInTheDocument();
    expect(screen.queryByText('UTM Referrer')).toBeNull();
    expect(screen.queryByText('https://search.example/referrer')).toBeNull();
    expect(screen.queryByText('Priya Sharma', { selector: '.cd-filled-value' })).toBeNull();
    expect(screen.queryByText('https://example.com/offer')).toBeNull();

    const utmSection = screen.getByRole('button', { name: 'Collapse UTM Tracker' }).closest('.cd-detail-section');
    expect(utmSection).toHaveClass('is-open');
    fireEvent.click(screen.getByRole('button', { name: 'Collapse UTM Tracker' }));
    expect(utmSection).not.toHaveClass('is-open');
    expect(screen.queryByText('October leads')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Expand UTM Tracker' }));
    expect(screen.getByText('October leads')).toBeInTheDocument();

    fireEvent.click(within(tabs).getByRole('tab', { name: 'Custom Tracking' }));
    expect(await screen.findByText('Service Type')).toBeInTheDocument();
    expect(screen.getByText('SEO')).toBeInTheDocument();
    expect(screen.queryByText('October leads')).toBeNull();

    fireEvent.click(within(tabs).getByRole('tab', { name: 'Ad Information' }));
    expect(screen.getByText('https://example.com/offer')).toBeInTheDocument();
    expect(screen.getByText('https://search.example/referrer')).toBeInTheDocument();
    expect(screen.queryByText('SEO')).toBeNull();

    fireEvent.click(within(tabs).getByRole('tab', { name: 'All details' }));
    expect(screen.getByText('October leads')).toBeInTheDocument();
    expect(screen.getByText('October Lead Form')).toBeInTheDocument();
    expect(screen.getByText('SEO')).toBeInTheDocument();
    expect(screen.getByText('https://example.com/offer')).toBeInTheDocument();
  });

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
    expect(fetchApiMock.mock.calls.some(([url]) => String(url).startsWith('/api/pickup-plot-inventory/lead-status'))).toBe(false);
  });
});
