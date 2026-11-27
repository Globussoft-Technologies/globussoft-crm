import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

const fetchApiMock = vi.fn();
vi.mock('../utils/api', () => ({
  fetchApi: (...args) => fetchApiMock(...args),
}));

const notifyConfirm = vi.fn(async () => true);
const notifyObj = { error: vi.fn(), success: vi.fn(), confirm: notifyConfirm };
vi.mock('../utils/notify', () => ({ useNotify: () => notifyObj }));

import TravelEmailAutomation from '../pages/travel/EmailAutomation';

const renderAutomation = () => render(<MemoryRouter><TravelEmailAutomation /></MemoryRouter>);

const template = {
  id: 1,
  name: 'Registration approved',
  eventKey: 'registration.approved',
  eventLabel: 'Registration approved',
  subBrand: 'all',
  subject: 'Your travel registration is approved',
  body: 'Your registration has been approved.',
  isDefault: true,
};

const tmcTemplate = {
  ...template,
  id: 2,
  name: 'TMC registration approved',
  subBrand: 'tmc',
  isDefault: false,
};

const rfuTemplate = {
  ...template,
  id: 3,
  name: 'RFU registration approved',
  subBrand: 'rfu',
  isDefault: true,
};

const activeTemplate = {
  ...template,
  id: 4,
  name: 'Active first template',
  isActive: true,
};

const deliveryLog = {
  id: 11,
  eventKey: 'payment.received',
  recipientEmail: 'parent@example.com',
  subject: 'Payment received for Bangalore trip',
  status: 'SENT',
  createdAt: '2026-11-20T08:09:55.762Z',
  sentAt: '2026-11-20T08:09:55.761Z',
};

beforeEach(() => {
  fetchApiMock.mockImplementation((url) => {
    if (url.endsWith('/catalog')) {
      return Promise.resolve({
        essential: [{ value: 'registration.approved', label: 'Registration approved' }],
        optional: [
          { value: 'registration.started', label: 'Registration started but not completed', subject: 'Complete your registration', body: 'Hello {{recipient.name}}, please complete your registration.' },
          { value: 'trip.completed', label: 'Trip completed — review request', subject: 'How was your trip?', body: 'Hello {{recipient.name}}, please share your review.' },
          { value: 'payment.failed', label: 'Payment failed or overdue', subject: 'Payment overdue', body: 'Hello {{recipient.name}}, your payment is overdue.' },
        ],
        subBrands: ['tmc', 'rfu', 'travelstall', 'visasure'],
      });
    }
    if (url.endsWith('/templates')) return Promise.resolve([template, tmcTemplate, rfuTemplate, activeTemplate]);
    if (url.endsWith('/delivery-logs/11')) return Promise.resolve({ ...deliveryLog, bodyHtml: '<p>Hello Asha, payment received.</p>' });
    if (url.endsWith('/delivery-logs/bulk-delete')) return Promise.resolve({ deleted: 1 });
    if (url.includes('/delivery-logs')) return Promise.resolve({ logs: [deliveryLog], pagination: { page: 1, limit: 15, total: 16, totalPages: 2 } });
    if (url === '/api/ai/draft') return Promise.resolve({ draft: 'Hello {{recipient.name}},\nYour trip is ready.' });
    return Promise.resolve({});
  });
});

describe('TravelEmailAutomation template triggers', () => {
  it('writes a Travel email message with AI', async () => {
    renderAutomation();

    expect(await screen.findByRole('heading', { name: 'Registration approved' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /create new template/i }));
    expect(screen.getByRole('option', { name: 'Registration started but not completed' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'Trip completed — review request' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'Payment failed or overdue' })).toBeInTheDocument();
    expect(screen.queryByRole('option', { name: 'Lead assigned to staff' })).not.toBeInTheDocument();
    expect(screen.getByText('48 fields')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Recipient Name' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Parent Phone' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Student Name' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Registration ID' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Trip Destination' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Payment Amount' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Review Link' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Account Setup Link' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Lead Source' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Industry' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Recipient Name' }));
    expect(screen.getByRole('textbox', { name: 'Email message' })).toHaveTextContent('{{recipient.name}}');
    fireEvent.change(screen.getByPlaceholderText('Template name'), { target: { value: 'Trip welcome' } });
    fireEvent.change(screen.getByPlaceholderText('Subject'), { target: { value: 'Your trip is ready' } });
    fireEvent.click(screen.getByRole('button', { name: 'Write with AI' }));

    await waitFor(() => expect(fetchApiMock).toHaveBeenCalledWith(
      '/api/ai/draft',
      expect.objectContaining({ method: 'POST' }),
    ));
    const aiCall = fetchApiMock.mock.calls.find(([url]) => url === '/api/ai/draft');
    expect(JSON.parse(aiCall[1].body)).toEqual(expect.objectContaining({
      subject: 'Your trip is ready',
      tone: 'professional and warm',
    }));
    await waitFor(() => expect(screen.getByRole('textbox', { name: 'Email message' })).toHaveTextContent(/Hello \{\{recipient\.name\}\},.*Your trip is ready\./));
    expect(notifyObj.success).toHaveBeenCalledWith('AI draft added to the email message.');
  });

  it('offers delete for default templates', async () => {
    renderAutomation();

    expect(await screen.findByRole('heading', { name: 'TMC registration approved' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Delete Registration approved' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Delete RFU registration approved' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Delete Registration approved' }));
    expect(screen.getByRole('alertdialog', { name: /delete template/i })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Delete template' }));

    await waitFor(() => expect(fetchApiMock).toHaveBeenCalledWith(
      '/api/travel/email-automation/templates/1',
      { method: 'DELETE' },
    ));
    expect(notifyConfirm).toHaveBeenCalledWith(expect.objectContaining({
      title: 'Delete email template',
      message: 'Delete template "Registration approved"?',
      destructive: true,
    }));
    expect(notifyObj.success).toHaveBeenCalledWith('Template deleted.');
  });

  it('filters template cards by subbrand', async () => {
    renderAutomation();

    expect(await screen.findByRole('heading', { name: 'Registration approved' })).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Filter templates by subbrand'), { target: { value: 'tmc' } });

    expect(screen.getByRole('heading', { name: 'TMC registration approved' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Registration approved' })).not.toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'RFU registration approved' })).not.toBeInTheDocument();
    expect(screen.getByText('1 of 4 templates')).toBeInTheDocument();
  });

  it('shows running templates before paused templates', async () => {
    renderAutomation();

    expect(await screen.findByRole('heading', { name: 'Active first template' })).toBeInTheDocument();
    const headings = screen.getAllByRole('heading', { level: 3 }).map(item => item.textContent);
    expect(headings[0]).toBe('Active first template');
  });

  it('shows status-aware action styling and badges', async () => {
    renderAutomation();

    expect(await screen.findByRole('heading', { name: 'Registration approved' })).toBeInTheDocument();
    expect(screen.getAllByText('Running')).toHaveLength(1);
    expect(screen.getAllByText('Paused')).toHaveLength(3);
    expect(screen.getByRole('button', { name: 'Pause' })).toHaveClass('pause');
    expect(screen.getAllByRole('button', { name: 'Run' })[0]).toHaveClass('run');
  });

  it('paginates delivery history and opens the exact sent message', async () => {
    renderAutomation();

    await screen.findByRole('heading', { name: 'Registration approved' });
    fireEvent.click(screen.getByRole('button', { name: 'Delivery history' }));
    expect(screen.getByText('Payment received for Bangalore trip')).toBeInTheDocument();

    fireEvent.click(screen.getByText('Payment received for Bangalore trip'));
    expect(await screen.findByRole('dialog', { name: 'Sent email details' })).toBeInTheDocument();
    expect(screen.getByText('Hello Asha, payment received.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Close sent email details' }));

    fireEvent.click(screen.getByRole('button', { name: 'Next page' }));
    await waitFor(() => expect(fetchApiMock).toHaveBeenCalledWith('/api/travel/email-automation/delivery-logs?page=2&limit=15'));
  });

  it('bulk deletes selected delivery records', async () => {
    renderAutomation();

    await screen.findByRole('heading', { name: 'Registration approved' });
    fireEvent.click(screen.getByRole('button', { name: 'Delivery history' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select delivery to parent@example.com' }));
    fireEvent.click(screen.getByRole('button', { name: /Bulk actions \(1\)/i }));
    fireEvent.click(screen.getByRole('button', { name: 'Delete selected (1)' }));

    await waitFor(() => expect(fetchApiMock).toHaveBeenCalledWith(
      '/api/travel/email-automation/delivery-logs/bulk-delete',
      { method: 'POST', body: JSON.stringify({ ids: [11] }) },
    ));
    expect(notifyConfirm).toHaveBeenCalledWith(expect.objectContaining({
      title: 'Delete delivery records',
      message: 'Delete 1 selected delivery record?',
      destructive: true,
    }));
  });

  it('places delivery selection and deletion inside the Bulk actions menu', async () => {
    renderAutomation();

    await screen.findByRole('heading', { name: 'Registration approved' });
    fireEvent.click(screen.getByRole('button', { name: 'Delivery history' }));
    fireEvent.click(screen.getByRole('button', { name: /^Bulk actions$/i }));

    expect(screen.getByRole('menu', { name: 'Bulk actions' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Select current page' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Delete selected/ })).toBeDisabled();
  });

  it('selects all present delivery records for bulk deletion', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    renderAutomation();

    await screen.findByRole('heading', { name: 'Registration approved' });
    fireEvent.click(screen.getByRole('button', { name: 'Delivery history' }));
    fireEvent.click(screen.getByRole('button', { name: /^Bulk actions$/i }));
    fireEvent.click(screen.getByRole('button', { name: 'Select all present' }));
    await waitFor(() => expect(screen.getByRole('button', { name: /Bulk actions \(1\)/i })).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: /Bulk actions \(1\)/i }));
    fireEvent.click(screen.getByRole('button', { name: 'Delete selected (1)' }));

    await waitFor(() => expect(fetchApiMock).toHaveBeenCalledWith(
      '/api/travel/email-automation/delivery-logs/bulk-delete',
      { method: 'POST', body: JSON.stringify({ ids: [11] }) },
    ));
  });

  it('fills the default name, subject, and message when an optional trigger is selected', async () => {
    renderAutomation();

    expect(await screen.findByRole('heading', { name: 'Registration approved' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /create new template/i }));
    fireEvent.change(screen.getByDisplayValue('Registration approved'), { target: { value: 'registration.started' } });

    expect(screen.getByPlaceholderText('Template name')).toHaveValue('Registration started but not completed');
    expect(screen.getByPlaceholderText('Subject')).toHaveValue('Complete your registration');
    expect(screen.getByRole('textbox', { name: 'Email message' })).toHaveTextContent('Hello {{recipient.name}}, please complete your registration.');
  });


});
