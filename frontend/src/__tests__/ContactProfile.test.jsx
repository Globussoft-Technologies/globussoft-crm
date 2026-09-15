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
    for (const tab of ['Overview', 'Contact details', 'Conversation', 'Activities']) {
      expect(panel.getByRole('button', { name: new RegExp(tab) })).toBeTruthy();
    }
    expect(panel.getByText('Status')).toBeTruthy();
    expect(panel.getByText('Summary')).toBeTruthy();
    expect(panel.getByText('Starter plan')).toBeTruthy();
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
    expect(JSON.parse(fetchApiMock.mock.calls.find(([_u, o]) => o?.method === 'PATCH')[1].body)).toEqual({ status: 'Prospect' });
    await waitFor(() => expect(panel.getByRole('button', { name: 'Interested / Unqualified' }).className).toMatch(/current/));
  });

  it('qualified dropdown shows Qualified and red Lost options', async () => {
    renderProfile();
    const panel = within(await screen.findByLabelText('Contact profile'));
    fireEvent.click(panel.getByRole('button', { name: 'Qualified / Lost' }));
    expect(panel.getByRole('button', { name: 'Qualified' })).toBeTruthy();
    expect(panel.getByRole('button', { name: 'Lost' })).toBeTruthy();
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
