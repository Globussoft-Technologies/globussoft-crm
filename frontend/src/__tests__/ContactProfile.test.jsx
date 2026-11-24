import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { AuthContext } from '../appContexts';

const fetchApiMock = vi.fn();
vi.mock('../utils/api', () => ({
  fetchApi: (...args) => fetchApiMock(...args),
}));

vi.mock('../utils/money', () => ({
  formatMoney: (n, opts) => `${opts?.currency || 'USD'} ${n ?? 0}`,
  tenantCurrency: () => 'USD',
}));

vi.mock('../utils/date', async (importOriginal) => ({
  ...await importOriginal(),
  formatDate: (d) => (d ? 'DATE' : '—'),
  formatDateTime: (d) => (d ? 'DATETIME' : '—'),
}));

import ContactDetail from '../pages/ContactDetail';

const baseContact = {
  id: 7,
  name: 'Ahmad Malik',
  email: 'ahmad@example.com',
  phone: '+911234567890',
  company: 'ABC Pvt Ltd',
  title: 'Manager',
  status: 'Lead',
  source: 'Organic',
  aiScore: 61,
  industry: 'SaaS',
  companySize: '11-50',
  website: 'abc.example',
  assignedToId: null,
  assignedTo: null,
  activities: [
    { id: 1, type: 'Note', description: 'First note', userId: null, createdAt: '2026-01-01T10:00:00.000Z' },
  ],
  deals: [
    { id: 11, title: 'Starter plan', amount: 5000, currency: 'USD', stage: 'proposal' },
  ],
};

function renderProfile(authValue) {
  const profile = (
    <MemoryRouter initialEntries={['/contacts/7']}>
      <Routes>
        <Route path="/contacts/:id" element={<ContactDetail />} />
      </Routes>
    </MemoryRouter>
  );
  return render(authValue
    ? <AuthContext.Provider value={authValue}>{profile}</AuthContext.Provider>
    : profile);
}

beforeEach(() => {
  localStorage.clear();
  Element.prototype.scrollIntoView = vi.fn();
  fetchApiMock.mockReset();
  fetchApiMock.mockImplementation((url) => {
    if (url === '/api/contacts/7') return Promise.resolve({ ...baseContact });
    if (url.startsWith('/api/staff')) return Promise.resolve([]);
    if (url.startsWith('/api/contacts/7/attachments')) return Promise.resolve([]);
    return Promise.resolve([]);
  });
});

describe('ContactDetail profile', () => {
  it('renders header, sidebar tabs and overview by default', async () => {
    renderProfile();
    const panel = within(await screen.findByLabelText('Contact profile'));
    expect(panel.getByText('Ahmad Malik', { exact: true })).toBeTruthy();
    for (const tab of ['Overview', 'Contact details', 'Conversation', 'Activities', 'Accounts', 'Deals', 'AI insights', 'Files']) {
      expect(panel.getByRole('button', { name: new RegExp(tab) })).toBeTruthy();
    }
    expect(panel.getAllByText('Status').length).toBeGreaterThan(0);
    expect(panel.getByText('Summary')).toBeTruthy();
    expect(panel.getByText('Starter plan')).toBeTruthy();
  });

  it('highlights the current status stage in the profile status bar', async () => {
    renderProfile();
    const panel = within(await screen.findByLabelText('Contact profile'));
    expect(panel.getByRole('button', { name: 'New' }).className).toMatch(/current/);
    expect(panel.getByRole('button', { name: 'Contacted' }).className).not.toMatch(/current/);
  });

  it('hides the retired Generic CRM profile actions while keeping Delete and Export', async () => {
    renderProfile();
    const panel = within(await screen.findByLabelText('Contact profile'));

    expect(panel.queryByRole('button', { name: 'Sales activities' })).not.toBeInTheDocument();
    fireEvent.click(panel.getByRole('button', { name: 'More actions' }));
    const menu = within(panel.getByRole('menu'));
    for (const action of ['Edit', 'Clone', 'Add to sequence', 'Unsubscribe', 'Forget']) {
      expect(menu.queryByRole('menuitem', { name: action })).not.toBeInTheDocument();
    }
    expect(menu.getByRole('menuitem', { name: 'Delete' })).toBeInTheDocument();
    expect(menu.getByRole('menuitem', { name: 'Export' })).toBeInTheDocument();
    fireEvent.click(menu.getByRole('menuitem', { name: 'Delete' }));
    expect(await screen.findByRole('dialog', { name: 'Delete Ahmad Malik?' })).toHaveTextContent(
      'Do you want to delete this contact permanently? This action cannot be undone.',
    );
  });

  it('keeps the existing profile actions outside Generic CRM', async () => {
    renderProfile({ tenant: { id: 2, vertical: 'wellness' }, user: { id: 3, role: 'ADMIN' } });
    const panel = within(await screen.findByLabelText('Contact profile'));

    expect(panel.getByRole('button', { name: 'Care activities' })).toBeInTheDocument();
    expect(panel.queryByRole('button', { name: 'WhatsApp' })).not.toBeInTheDocument();
    fireEvent.click(panel.getByRole('button', { name: 'More actions' }));
    const menu = within(panel.getByRole('menu'));
    for (const action of ['Edit', 'Clone', 'Delete', 'Add to sequence', 'Export', 'Unsubscribe', 'Forget']) {
      expect(menu.getByRole('menuitem', { name: action })).toBeInTheDocument();
    }
    fireEvent.click(menu.getByRole('menuitem', { name: 'Delete' }));
    expect(await screen.findByRole('dialog', { name: 'Delete Ahmad Malik?' })).toHaveTextContent(
      'The contact will be moved to trash. You can restore it later from the contacts list.',
    );
  });

  it('uses the requested Generic CRM action order and sends a WhatsApp message', async () => {
    renderProfile();
    const panelElement = await screen.findByLabelText('Contact profile');
    const panel = within(panelElement);
    const actionLabels = within(panelElement.querySelector('.cp-actions-bar'))
      .getAllByRole('button')
      .map((button) => button.getAttribute('aria-label') || button.textContent.trim());
    expect(actionLabels).toEqual([
      'Email',
      'SMS',
      'WhatsApp',
      'Call',
      'Meeting',
      'Note',
      'Task',
      'Add deal',
      'More actions',
    ]);

    fireEvent.click(panel.getByRole('button', { name: 'WhatsApp' }));
    const dialog = within(await screen.findByRole('dialog', { name: 'WhatsApp Ahmad Malik' }));
    fireEvent.change(dialog.getByPlaceholderText('Type your message…'), {
      target: { value: 'Hello from Globussoft CRM' },
    });
    fireEvent.click(dialog.getByRole('button', { name: 'Send' }));

    await waitFor(() => expect(fetchApiMock).toHaveBeenCalledWith(
      '/api/whatsapp/send',
      expect.objectContaining({ method: 'POST' }),
    ));
    const sendCall = fetchApiMock.mock.calls.find(([url, options]) => url === '/api/whatsapp/send' && options?.method === 'POST');
    expect(JSON.parse(sendCall[1].body)).toEqual({
      to: baseContact.phone,
      body: 'Hello from Globussoft CRM',
      contactId: baseContact.id,
    });
  });

  it('sends an approved WhatsApp template from Generic CRM without sending its name as message text', async () => {
    fetchApiMock.mockImplementation((url, options) => {
      if (url === '/api/contacts/7') return Promise.resolve({ ...baseContact });
      if (url.startsWith('/api/staff')) return Promise.resolve([]);
      if (url === '/api/whatsapp/templates') return Promise.resolve([{
        id: 91,
        name: 'appointment_reminder',
        body: 'Hi {{1}}, your appointment is tomorrow at {{2}}.',
        status: 'APPROVED',
      }]);
      if (url === '/api/whatsapp/send' && options?.method === 'POST') {
        return Promise.resolve({ success: true, status: 'QUEUED' });
      }
      return Promise.resolve([]);
    });

    renderProfile();
    const panel = within(await screen.findByLabelText('Contact profile'));
    fireEvent.click(panel.getByRole('button', { name: 'WhatsApp' }));
    const dialog = within(await screen.findByRole('dialog', { name: 'WhatsApp Ahmad Malik' }));

    fireEvent.click(await dialog.findByRole('checkbox', { name: 'Use approved template' }));
    fireEvent.change(dialog.getByRole('combobox', { name: 'Approved template' }), {
      target: { value: 'appointment_reminder' },
    });
    expect(dialog.getByText('Hi {{1}}, your appointment is tomorrow at {{2}}.')).toBeInTheDocument();
    fireEvent.click(dialog.getByRole('button', { name: 'Send' }));

    await waitFor(() => {
      const sendCall = fetchApiMock.mock.calls.find(([url, options]) => url === '/api/whatsapp/send' && options?.method === 'POST');
      expect(JSON.parse(sendCall[1].body)).toEqual({
        to: baseContact.phone,
        templateName: 'appointment_reminder',
        contactId: baseContact.id,
      });
    });
  });

  it('shows the Generic CRM contact WhatsApp chat in Conversation', async () => {
    fetchApiMock.mockImplementation((url) => {
      if (url === '/api/contacts/7') return Promise.resolve({ ...baseContact });
      if (url.startsWith('/api/staff')) return Promise.resolve([]);
      if (url === '/api/whatsapp/messages?contactId=7') {
        return Promise.resolve({ messages: [{
          id: 81,
          direction: 'INBOUND',
          from: baseContact.phone,
          to: 'whatsapp-business-number',
          body: 'Please share the latest quotation',
          status: 'DELIVERED',
          createdAt: '2026-10-26T10:00:00.000Z',
          contact: { id: 7, name: baseContact.name },
        }] });
      }
      return Promise.resolve([]);
    });

    renderProfile();
    const panel = within(await screen.findByLabelText('Contact profile'));
    fireEvent.click(panel.getByRole('button', { name: 'Conversation' }));

    expect(await panel.findByText('Please share the latest quotation')).toBeInTheDocument();
    expect(panel.getAllByRole('button', { name: 'WhatsApp' })).toHaveLength(2);
    expect(panel.getByRole('button', { name: 'New WhatsApp' })).toBeInTheDocument();
    expect(panel.getByText(/whatsapp.*DELIVERED/i)).toBeInTheDocument();
    expect(fetchApiMock).toHaveBeenCalledWith('/api/whatsapp/messages?contactId=7', { silent: true });
  });

  it('refreshes WhatsApp delivery status in the Generic CRM Conversation tab', async () => {
    let whatsappRequestCount = 0;
    let statusRefresh;
    const intervalSpy = vi.spyOn(window, 'setInterval').mockImplementation((callback, delay) => {
      if (delay === 10_000) statusRefresh = callback;
      return 91;
    });
    const clearIntervalSpy = vi.spyOn(window, 'clearInterval').mockImplementation(() => {});
    fetchApiMock.mockImplementation((url) => {
      if (url === '/api/contacts/7') return Promise.resolve({ ...baseContact });
      if (url.startsWith('/api/staff')) return Promise.resolve([]);
      if (url === '/api/whatsapp/messages?contactId=7') {
        whatsappRequestCount += 1;
        return Promise.resolve({ messages: [{
          id: 81,
          direction: 'OUTBOUND',
          to: baseContact.phone,
          body: 'Your quotation is ready',
          status: whatsappRequestCount === 1 ? 'SENT' : 'DELIVERED',
          createdAt: '2026-10-26T10:00:00.000Z',
          contact: { id: 7, name: baseContact.name },
        }] });
      }
      return Promise.resolve([]);
    });

    try {
      renderProfile();
      const panel = within(await screen.findByLabelText('Contact profile'));
      fireEvent.click(panel.getByRole('button', { name: 'Conversation' }));
      expect(await panel.findByText(/whatsapp.*SENT/i)).toBeInTheDocument();
      expect(statusRefresh).toBeTypeOf('function');

      await act(async () => { await statusRefresh(); });

      expect(panel.getByText(/whatsapp.*DELIVERED/i)).toBeInTheDocument();
      expect(panel.queryByText(/whatsapp.*SENT/i)).not.toBeInTheDocument();
    } finally {
      intervalSpy.mockRestore();
      clearIntervalSpy.mockRestore();
    }
  });

  it('keeps the files workflow reachable from the profile navigation', async () => {
    fetchApiMock.mockImplementation((url) => {
      if (url === '/api/contacts/7') return Promise.resolve({ ...baseContact });
      if (url.startsWith('/api/staff')) return Promise.resolve([]);
      if (url === '/api/contacts/7/attachments') {
        return Promise.resolve([{ id: 91, filename: 'proposal.pdf', fileUrl: '/uploads/proposal.pdf', fileSize: 1024, createdAt: '2026-01-01T10:00:00.000Z' }]);
      }
      return Promise.resolve([]);
    });

    renderProfile();
    const panel = within(await screen.findByLabelText('Contact profile'));
    fireEvent.click(panel.getByRole('button', { name: 'Files' }));

    expect(await panel.findByText('proposal.pdf')).toBeInTheDocument();
    expect(fetchApiMock).toHaveBeenCalledWith('/api/contacts/7/attachments', { silent: true });
  });

  it('status dropdown option PATCHes the exact Generic CRM status', async () => {
    let currentContact = { ...baseContact };
    fetchApiMock.mockImplementation((url, opts) => {
      if (url === '/api/contacts/7' && opts?.method === 'PATCH') {
        currentContact = { ...currentContact, ...JSON.parse(opts.body) };
        return Promise.resolve(currentContact);
      }
      if (url === '/api/contacts/7') return Promise.resolve(currentContact);
      return Promise.resolve([]);
    });
    renderProfile();
    const panel = within(await screen.findByLabelText('Contact profile'));
    fireEvent.click(panel.getByRole('button', { name: 'Qualified / Lost' }));
    expect(panel.getByRole('button', { name: 'Qualified' })).toBeTruthy();
    fireEvent.click(panel.getByRole('button', { name: 'Qualified' }));
    await waitFor(() => {
      expect(fetchApiMock.mock.calls.filter(([_url, options]) => options?.method === 'PATCH')).toHaveLength(3);
    });
    const patchBodies = fetchApiMock.mock.calls
      .filter(([_url, options]) => options?.method === 'PATCH')
      .map(([_url, options]) => JSON.parse(options.body));
    expect(patchBodies).toEqual([
      { status: 'Contacted', lifecycleStageKey: 'contacted' },
      { status: 'Interested', lifecycleStageKey: 'interested' },
      { status: 'Qualified', lifecycleStageKey: 'qualified' },
    ]);
    expect(currentContact.status).toBe('Qualified');
    await waitFor(() => expect(panel.getByRole('button', { name: 'Qualified' }).className).toMatch(/current/));
  });

  it('qualified dropdown shows Qualified and red Lost options', async () => {
    renderProfile();
    const panel = within(await screen.findByLabelText('Contact profile'));
    fireEvent.click(panel.getByRole('button', { name: 'Qualified / Lost' }));
    expect(panel.getByRole('button', { name: 'Qualified' })).toBeTruthy();
    expect(panel.getByRole('button', { name: 'Lost' })).toBeTruthy();
  });

  it('requires and submits a reason when a negative stage is selected', async () => {
    let currentContact = { ...baseContact };
    fetchApiMock.mockImplementation((url, opts) => {
      if (url === '/api/contacts/7' && opts?.method === 'PATCH') {
        currentContact = { ...currentContact, ...JSON.parse(opts.body) };
        return Promise.resolve(currentContact);
      }
      if (url === '/api/contacts/7') return Promise.resolve(currentContact);
      return Promise.resolve([]);
    });
    renderProfile();
    const panel = within(await screen.findByLabelText('Contact profile'));
    fireEvent.click(panel.getByRole('button', { name: 'Interested / Unqualified' }));
    fireEvent.click(panel.getByRole('button', { name: 'Unqualified' }));

    const dialog = within(await screen.findByRole('dialog', { name: 'Reason required' }));
    fireEvent.click(dialog.getByRole('button', { name: 'Confirm stage' }));
    expect(fetchApiMock.mock.calls.some(([_url, options]) => options?.method === 'PATCH')).toBe(false);
    fireEvent.change(dialog.getByRole('textbox', { name: 'Negative stage reason' }), { target: { value: 'Duplicate and invalid enquiry' } });
    fireEvent.click(dialog.getByRole('button', { name: 'Confirm stage' }));

    await waitFor(() => expect(fetchApiMock).toHaveBeenCalledWith('/api/contacts/7', expect.objectContaining({ method: 'PATCH' })));
    const patchCalls = fetchApiMock.mock.calls.filter(([_url, options]) => options?.method === 'PATCH');
    expect(JSON.parse(patchCalls.at(-1)[1].body)).toEqual({
      status: 'Unqualified',
      lifecycleStageKey: 'unqualified',
      lifecycleTransitionReason: 'Duplicate and invalid enquiry',
    });
    await waitFor(() => expect(panel.getByRole('button', { name: 'Unqualified' }).className).toMatch(/lost/));

    fireEvent.click(panel.getByRole('button', { name: 'Won / Churned' }));
    fireEvent.click(panel.getByRole('button', { name: 'Won' }));

    await waitFor(() => expect(panel.getByRole('button', { name: 'Won' }).className).toMatch(/current/));
    fireEvent.click(panel.getByRole('button', { name: 'Unqualified' }));
    expect(panel.getAllByRole('button', { name: 'Unqualified' })).toHaveLength(2);
  });

  it('updates Generic CRM status directly when returning to an earlier stage', async () => {
    const qualifiedContact = { ...baseContact, status: 'Customer', lifecycleStageKey: 'qualified' };
    fetchApiMock.mockImplementation((url, opts) => {
      if (url === '/api/contacts/7' && opts?.method === 'PATCH') return Promise.resolve({ ...qualifiedContact, ...JSON.parse(opts.body) });
      if (url === '/api/contacts/7') return Promise.resolve(qualifiedContact);
      return Promise.resolve([]);
    });
    renderProfile();
    const panel = within(await screen.findByLabelText('Contact profile'));
    fireEvent.click(panel.getByRole('button', { name: 'Contacted' }));

    const dialog = within(await screen.findByRole('dialog', { name: 'Go back to a previous stage?' }));
    fireEvent.click(dialog.getByRole('button', { name: 'Yes, go back' }));

    await waitFor(() => expect(fetchApiMock).toHaveBeenCalledWith('/api/contacts/7', expect.objectContaining({ method: 'PATCH' })));
    const patchCall = fetchApiMock.mock.calls.find(([_url, options]) => options?.method === 'PATCH');
    expect(JSON.parse(patchCall[1].body)).toEqual({ status: 'Contacted', lifecycleStageKey: 'contacted' });
  });

  it('restores this lead\'s selected conditional outcomes from lifecycle history', async () => {
    fetchApiMock.mockImplementation((url) => {
      if (url === '/api/contacts/7') return Promise.resolve({ ...baseContact, status: 'Customer', lifecycleStageKey: 'won' });
      if (url === '/api/contacts/7/lifecycle-history') {
        return Promise.resolve({
          data: [
            { id: 2, to: { stageKey: 'won', stage: 'Won', status: 'Customer' } },
            { id: 1, to: { stageKey: 'unqualified', stage: 'Unqualified', status: 'Unqualified' } },
          ],
        });
      }
      return Promise.resolve([]);
    });

    renderProfile();
    const panel = within(await screen.findByLabelText('Contact profile'));
    expect(panel.getByRole('button', { name: 'Won' }).className).toMatch(/current/);
    expect(panel.getByRole('button', { name: 'Qualified / Lost' })).toBeInTheDocument();
    fireEvent.click(panel.getByRole('button', { name: 'Unqualified' }));
    expect(panel.getByRole('button', { name: 'Interested' })).toBeInTheDocument();
    expect(panel.getAllByRole('button', { name: 'Unqualified' })).toHaveLength(2);
  });

  it('keeps the standardized Generic CRM status bar read-only', async () => {
    renderProfile();
    const panel = within(await screen.findByLabelText('Contact profile'));
    expect(panel.queryByRole('button', { name: 'Edit lifecycle stage and status' })).not.toBeInTheDocument();
    expect(panel.getByRole('button', { name: 'Interested / Unqualified' })).toBeInTheDocument();
    expect(panel.getByRole('button', { name: 'Qualified / Lost' })).toBeInTheDocument();
    expect(panel.getByRole('button', { name: 'Won / Churned' })).toBeInTheDocument();
  });

  it('shows who changed the lifecycle, when, and the complete from/to values', async () => {
    fetchApiMock.mockImplementation((url) => {
      if (url === '/api/contacts/7') return Promise.resolve({ ...baseContact });
      if (url.startsWith('/api/staff')) return Promise.resolve([]);
      if (url === '/api/contacts/7/lifecycle-history') {
        return Promise.resolve({
          data: [{
            id: 88,
            changedAt: '2026-10-22T07:30:00.000Z',
            changedBy: { id: 7, name: 'Rajesh Sharma', email: 'rajesh@example.com' },
            from: { stageKey: 'new', stage: 'New', status: 'Lead' },
            to: { stageKey: 'contacted', stage: 'Contacted', status: 'Prospect' },
            reason: 'Requested a later follow-up',
          }],
          total: 1,
        });
      }
      return Promise.resolve([]);
    });

    renderProfile();
    const panel = within(await screen.findByLabelText('Contact profile'));
    fireEvent.click(panel.getByRole('button', { name: 'More actions' }));
    fireEvent.click(await panel.findByRole('menuitem', { name: 'View status history' }));
    const dialog = within(await screen.findByRole('dialog', { name: 'Lifecycle history' }));

    expect(await dialog.findByText('Rajesh Sharma')).toBeInTheDocument();
    expect(dialog.getByText('rajesh@example.com')).toBeInTheDocument();
    expect(dialog.getByText('New')).toBeInTheDocument();
    expect(dialog.getByText('Contacted')).toBeInTheDocument();
    expect(dialog.getByText('CRM status: Lead')).toBeInTheDocument();
    expect(dialog.getByText('CRM status: Prospect')).toBeInTheDocument();
    expect(dialog.getByText(/Requested a later follow-up/)).toBeInTheDocument();
    expect(fetchApiMock).toHaveBeenCalledWith('/api/contacts/7/lifecycle-history', { silent: true });
  });

  it('adds a note via POST and clears the input', async () => {
    renderProfile();
    const panel = within(await screen.findByLabelText('Contact profile'));
    const user = userEvent.setup();
    await user.click(panel.getByRole('button', { name: /^Note$/ }));
    const dialog = await screen.findByRole('dialog', { name: 'Add note' });
    const editor = within(dialog).getByRole('textbox', { name: 'Note content' });
    editor.textContent = 'Followed up today';
    fireEvent.input(editor);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Done' }));
    await waitFor(() => {
      expect(fetchApiMock).toHaveBeenCalledWith(
        '/api/contacts/7/activities',
        expect.objectContaining({ method: 'POST' }),
      );
    });
    const [, opts] = fetchApiMock.mock.calls.find(([_u, o]) => _u.endsWith('/activities') && o?.method === 'POST');
    expect(JSON.parse(opts.body)).toEqual({ type: 'Note', description: 'Followed up today' });
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Add note' })).toBeNull());
  });

  it('shows contact deals in the overview and keeps the current profile tabs available', async () => {
    renderProfile();
    const panel = within(await screen.findByLabelText('Contact profile'));
    expect(panel.getByText('Starter plan')).toBeTruthy();
    expect(panel.getAllByRole('button', { name: 'Add deal' }).length).toBeGreaterThan(0);
    expect(panel.getByRole('button', { name: 'Conversation' })).toBeTruthy();
    expect(panel.getByRole('button', { name: 'Activities' })).toBeTruthy();
  });

  it('renders the email composer outside the scrolling profile panel', async () => {
    renderProfile();
    await screen.findByText('Ahmad Malik');

    fireEvent.click(screen.getByRole('button', { name: /^email$/i }));

    const dialog = await screen.findByRole('dialog', { name: 'New mail' });
    expect(dialog.closest('.cp-slide-panel')).toBeNull();
    expect(within(dialog).getByRole('toolbar', { name: 'Formatting' })).toBeInTheDocument();
  });

  it('allows Location and Mobile to be edited from the overview', async () => {
    const contact = { ...baseContact, stateCode: 'Bhubaneswar, Odisha, IN' };
    fetchApiMock.mockImplementation((url, options) => {
      if (url === '/api/contacts/7' && options?.method === 'PATCH') {
        return Promise.resolve({ ...contact, ...JSON.parse(options.body) });
      }
      if (url === '/api/contacts/7') return Promise.resolve(contact);
      if (url.startsWith('/api/staff')) return Promise.resolve([]);
      return Promise.resolve([]);
    });
    renderProfile();
    await screen.findByText('Bhubaneswar, Odisha, IN');

    const locationField = screen.getByText('Bhubaneswar, Odisha, IN').closest('.cp-field');
    fireEvent.click(within(locationField).getByRole('button', { name: 'Edit field' }));
    const locationInput = within(locationField).getByRole('textbox');
    fireEvent.change(locationInput, { target: { value: 'Cuttack, Odisha, IN' } });
    fireEvent.blur(locationInput);
    await waitFor(() => expect(fetchApiMock).toHaveBeenCalledWith(
      '/api/contacts/7',
      expect.objectContaining({ method: 'PATCH', body: JSON.stringify({ stateCode: 'Cuttack, Odisha, IN' }) }),
    ));

    const mobileField = screen.getAllByText(baseContact.phone)
      .map((element) => element.closest('.cp-field'))
      .find(Boolean);
    fireEvent.click(within(mobileField).getByRole('button', { name: 'Edit field' }));
    const mobileInput = within(mobileField).getByRole('textbox');
    fireEvent.change(mobileInput, { target: { value: '+919876543210' } });
    fireEvent.blur(mobileInput);
    await waitFor(() => expect(fetchApiMock).toHaveBeenCalledWith(
      '/api/contacts/7',
      expect.objectContaining({ method: 'PATCH', body: JSON.stringify({ phone: '+919876543210' }) }),
    ));
  });

  it('persists Contact Details edits through the contact update API', async () => {
    fetchApiMock.mockImplementation((url, options) => {
      if (url === '/api/contacts/7' && options?.method === 'PATCH') {
        return Promise.resolve({ ...baseContact, ...JSON.parse(options.body) });
      }
      if (url === '/api/contacts/7') return Promise.resolve({ ...baseContact });
      if (url.startsWith('/api/staff')) return Promise.resolve([]);
      if (url === '/api/lead-custom-fields') return Promise.resolve([]);
      return Promise.resolve([]);
    });
    renderProfile();
    await screen.findByText('Ahmad Malik');
    fireEvent.click(within(screen.getByLabelText('Contact profile')).getByRole('button', { name: /^Contact details$/ }));
    const emailField = screen.getByText('Email', { selector: '.cd-basic-field span' }).closest('.cd-basic-field');
    fireEvent.click(within(emailField).getByRole('button', { name: 'Edit field' }));
    const input = within(emailField).getByRole('textbox');
    fireEvent.change(input, { target: { value: 'updated@example.com' } });
    fireEvent.blur(input);
    await waitFor(() => expect(fetchApiMock).toHaveBeenCalledWith(
      '/api/contacts/7',
      expect.objectContaining({ method: 'PATCH', body: JSON.stringify({ email: 'updated@example.com' }) }),
    ));
  });
});
