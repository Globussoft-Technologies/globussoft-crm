import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
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
    expect(await screen.findByText('Ahmad Malik')).toBeTruthy();
    const panel = within(screen.getByLabelText('Contact profile'));
    for (const tab of ['Overview', 'Contact details', 'Conversations', 'Activities', 'Accounts', 'Deals', 'AI insights', 'Files']) {
      expect(panel.getByRole('button', { name: new RegExp(tab) })).toBeTruthy();
    }
    expect(panel.getByText('Status')).toBeTruthy();
    expect(panel.getByText('Summary')).toBeTruthy();
    expect(panel.getByText('Starter plan')).toBeTruthy();
  });

  it('chevron dropdown option PATCHes the mapped status', async () => {
    renderProfile();
    await screen.findByText('Ahmad Malik');
    fetchApiMock.mockImplementation((url, opts) => {
      if (url === '/api/contacts/7' && opts?.method === 'PATCH') {
        return Promise.resolve({ ...baseContact, status: JSON.parse(opts.body).status });
      }
      if (url === '/api/contacts/7') return Promise.resolve({ ...baseContact });
      return Promise.resolve([]);
    });
    fireEvent.click(screen.getByRole('button', { name: 'Interested / Unqualified' }));
    expect(screen.getByRole('button', { name: 'Unqualified' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Interested' }));
    await waitFor(() => {
      expect(fetchApiMock).toHaveBeenCalledWith('/api/contacts/7', expect.objectContaining({ method: 'PATCH' }));
    });
    expect(JSON.parse(fetchApiMock.mock.calls.find(([_u, o]) => o?.method === 'PATCH')[1].body)).toEqual({ status: 'Prospect' });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Interested / Unqualified' }).className).toMatch(/current/));
  });

  it('qualified dropdown shows Qualified and red Lost options', async () => {
    renderProfile();
    await screen.findByText('Ahmad Malik');
    fireEvent.click(screen.getByRole('button', { name: 'Qualified / Lost' }));
    expect(screen.getByRole('button', { name: 'Qualified' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Lost' })).toBeTruthy();
  });

  it('adds a note via POST and clears the input', async () => {
    renderProfile();
    await screen.findByText('Ahmad Malik');
    const box = screen.getByPlaceholderText('Add a note...');
    fireEvent.change(box, { target: { value: 'Followed up today' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add note' }));
    await waitFor(() => {
      expect(fetchApiMock).toHaveBeenCalledWith(
        '/api/contacts/7/activities',
        expect.objectContaining({ method: 'POST' }),
      );
    });
    const [, opts] = fetchApiMock.mock.calls.find(([_u, o]) => _u.endsWith('/activities') && o?.method === 'POST');
    expect(JSON.parse(opts.body)).toEqual({ type: 'Note', description: 'Followed up today' });
    await waitFor(() => expect(screen.getByPlaceholderText('Add a note...').value).toBe(''));
  });

  it('deals tab shows contact deals with add action, files tab lists attachments', async () => {
    fetchApiMock.mockImplementation((url) => {
      if (url === '/api/contacts/7') return Promise.resolve({ ...baseContact });
      if (url.startsWith('/api/staff')) return Promise.resolve([]);
      if (url.startsWith('/api/contacts/7/attachments')) {
        return Promise.resolve([{ id: 3, filename: 'quote.pdf', fileUrl: 'https://x/quote.pdf', createdAt: '2026-01-02T10:00:00.000Z' }]);
      }
      return Promise.resolve([]);
    });
    renderProfile();
    await screen.findByText('Ahmad Malik');
    fireEvent.click(screen.getByRole('button', { name: 'Deals' }));
    expect(await screen.findByText(/Deals \(1\)/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Files' }));
    expect(await screen.findByText('quote.pdf')).toBeTruthy();
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
