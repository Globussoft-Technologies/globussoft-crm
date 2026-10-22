import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Routes, Route } from 'react-router-dom';

const fetchApiMock = vi.fn();
vi.mock('../utils/api', () => ({
  fetchApi: (...args) => fetchApiMock(...args),
}));

vi.mock('../utils/money', () => ({
  formatMoney: (n, opts) => `${opts?.currency || 'USD'} ${n ?? 0}`,
  tenantCurrency: () => 'USD',
}));

vi.mock('../utils/date', () => ({
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

function renderProfile() {
  return render(
    <MemoryRouter initialEntries={['/contacts/7']}>
      <Routes>
        <Route path="/contacts/:id" element={<ContactDetail />} />
      </Routes>
    </MemoryRouter>,
  );
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
    expect(panel.getByText('Status')).toBeTruthy();
    expect(panel.getByText('Summary')).toBeTruthy();
    expect(panel.getByText('Starter plan')).toBeTruthy();
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

  it('chevron dropdown option PATCHes the mapped status', async () => {
    renderProfile();
    const panel = within(await screen.findByLabelText('Contact profile'));
    let currentContact = { ...baseContact };
    fetchApiMock.mockImplementation((url, opts) => {
      if (url === '/api/contacts/7' && opts?.method === 'PATCH') {
        currentContact = { ...currentContact, status: JSON.parse(opts.body).status };
        return Promise.resolve(currentContact);
      }
      if (url === '/api/contacts/7') return Promise.resolve(currentContact);
      return Promise.resolve([]);
    });
    fireEvent.click(panel.getByRole('button', { name: 'Interested / Unqualified' }));
    expect(panel.getByRole('button', { name: 'Unqualified' })).toBeTruthy();
    fireEvent.click(panel.getByRole('button', { name: 'Interested' }));
    await waitFor(() => {
      expect(fetchApiMock).toHaveBeenCalledWith('/api/contacts/7', expect.objectContaining({ method: 'PATCH' }));
    });
    expect(JSON.parse(fetchApiMock.mock.calls.find(([_u, o]) => o?.method === 'PATCH')[1].body)).toEqual({ status: 'Prospect', lifecycleStageKey: 'interested' });
    await waitFor(() => expect(panel.getByRole('button', { name: 'Interested / Unqualified' }).className).toMatch(/current/));
  });

  it('qualified dropdown shows Qualified and red Lost options', async () => {
    renderProfile();
    const panel = within(await screen.findByLabelText('Contact profile'));
    fireEvent.click(panel.getByRole('button', { name: 'Qualified / Lost' }));
    expect(panel.getByRole('button', { name: 'Qualified' })).toBeTruthy();
    expect(panel.getByRole('button', { name: 'Lost' })).toBeTruthy();
  });

  it('adds a Generic CRM lifecycle stage at the end and scrolls it into view', async () => {
    renderProfile();
    const panel = within(await screen.findByLabelText('Contact profile'));
    fireEvent.click(panel.getByRole('button', { name: 'Edit lifecycle stage and status' }));
    const dialogElement = await screen.findByRole('dialog', { name: 'Manage lifecycle stages' });
    expect(dialogElement).toHaveAttribute('aria-modal', 'true');
    const dialog = within(dialogElement);
    fireEvent.click(dialog.getByRole('button', { name: 'Add stage' }));
    const newStageInput = dialog.getByRole('textbox', { name: 'Stage 6 name' });
    await waitFor(() => expect(Element.prototype.scrollIntoView).toHaveBeenCalledWith({ behavior: 'smooth', block: 'end' }));
    expect(newStageInput).toHaveFocus();
    fireEvent.change(newStageInput, { target: { value: 'Renewal' } });
    expect(dialog.getByRole('button', { name: 'Move Renewal down' })).toBeDisabled();
    fireEvent.click(dialog.getByRole('button', { name: 'Save stages' }));

    await waitFor(() => expect(fetchApiMock).toHaveBeenCalledWith(
      '/api/tenant-settings/generic.contactLifecycleStages',
      expect.objectContaining({ method: 'PUT' }),
    ));
    const putCall = fetchApiMock.mock.calls.find(([url, options]) => url.includes('generic.contactLifecycleStages') && options?.method === 'PUT');
    const saved = JSON.parse(JSON.parse(putCall[1].body).value);
    expect(saved[5].title).toBe('Renewal');
    expect(saved[5].options[0].status).toBe('Lead');
    expect(localStorage.getItem('crm:generic-lifecycle-draft:v1:generic:current')).toBeNull();
  });

  it('allows two conditions with separate CRM statuses in one lifecycle stage', async () => {
    renderProfile();
    const panel = within(await screen.findByLabelText('Contact profile'));
    fireEvent.click(panel.getByRole('button', { name: 'Edit lifecycle stage and status' }));
    const dialog = within(await screen.findByRole('dialog', { name: 'Manage lifecycle stages' }));
    fireEvent.click(dialog.getByRole('button', { name: 'Add stage' }));

    const stageInput = dialog.getByRole('textbox', { name: 'Stage 6 name' });
    const stageRow = within(stageInput.closest('.cp-stage-manager-row'));
    fireEvent.click(stageRow.getByRole('button', { name: 'Add condition' }));

    expect(stageRow.queryByRole('textbox', { name: 'Stage 6 name' })).not.toBeInTheDocument();
    expect(stageRow.getAllByRole('textbox')).toHaveLength(2);
    expect(stageRow.getByRole('textbox', { name: 'New stage condition 1' })).toHaveValue('New stage');
    const secondCondition = stageRow.getByRole('textbox', { name: 'New stage condition 2' });
    fireEvent.change(secondCondition, { target: { value: 'No response' } });
    fireEvent.change(stageRow.getByRole('combobox', { name: 'No response CRM status' }), { target: { value: 'Churned' } });
    fireEvent.click(dialog.getByRole('button', { name: 'Save stages' }));

    await waitFor(() => expect(fetchApiMock).toHaveBeenCalledWith(
      '/api/tenant-settings/generic.contactLifecycleStages',
      expect.objectContaining({ method: 'PUT' }),
    ));
    const putCall = fetchApiMock.mock.calls.find(([url, options]) => url.includes('generic.contactLifecycleStages') && options?.method === 'PUT');
    const saved = JSON.parse(JSON.parse(putCall[1].body).value);
    expect(saved[5].options).toHaveLength(2);
    expect(saved[5].options[1]).toEqual(expect.objectContaining({ label: 'No response', status: 'Churned', negative: true }));

    const groupedStage = panel.getByRole('button', { name: 'New stage / No response' });
    fireEvent.click(groupedStage);
    const groupedStageMenu = within(groupedStage.closest('.cp-chev-wrap'));
    expect(groupedStageMenu.getByRole('button', { name: 'New stage' })).toBeInTheDocument();
    expect(groupedStageMenu.getByRole('button', { name: 'No response' })).toBeInTheDocument();
  });

  it('restores an unsaved lifecycle draft after closing and revisiting the page', async () => {
    const firstRender = renderProfile();
    const firstPanel = within(await screen.findByLabelText('Contact profile'));
    fireEvent.click(firstPanel.getByRole('button', { name: 'Edit lifecycle stage and status' }));
    const firstDialog = within(await screen.findByRole('dialog', { name: 'Manage lifecycle stages' }));
    fireEvent.click(firstDialog.getByRole('button', { name: 'Add stage' }));
    fireEvent.change(firstDialog.getByRole('textbox', { name: 'Stage 6 name' }), { target: { value: 'Draft renewal' } });
    fireEvent.click(firstDialog.getByRole('button', { name: 'Close lifecycle stage editor' }));

    await waitFor(() => expect(localStorage.getItem('crm:generic-lifecycle-draft:v1:generic:current')).toContain('Draft renewal'));
    firstRender.unmount();

    renderProfile();
    const nextPanel = within(await screen.findByLabelText('Contact profile'));
    fireEvent.click(nextPanel.getByRole('button', { name: 'Edit lifecycle stage and status' }));
    const restoredDialog = within(await screen.findByRole('dialog', { name: 'Manage lifecycle stages' }));
    expect(restoredDialog.getByRole('textbox', { name: 'Stage 6 name' })).toHaveValue('Draft renewal');
    expect(restoredDialog.getByRole('combobox', { name: 'Draft renewal CRM status' })).toHaveValue('Lead');
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
          }],
          total: 1,
        });
      }
      return Promise.resolve([]);
    });

    renderProfile();
    const panel = within(await screen.findByLabelText('Contact profile'));
    fireEvent.click(panel.getByRole('button', { name: 'View lifecycle history' }));
    const dialog = within(await screen.findByRole('dialog', { name: 'Lifecycle history' }));

    expect(await dialog.findByText('Rajesh Sharma')).toBeInTheDocument();
    expect(dialog.getByText('rajesh@example.com')).toBeInTheDocument();
    expect(dialog.getByText('New')).toBeInTheDocument();
    expect(dialog.getByText('Contacted')).toBeInTheDocument();
    expect(dialog.getByText('CRM status: Lead')).toBeInTheDocument();
    expect(dialog.getByText('CRM status: Prospect')).toBeInTheDocument();
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
