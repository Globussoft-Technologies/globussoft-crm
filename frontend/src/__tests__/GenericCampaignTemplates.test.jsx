import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

const fetchApiMock = vi.fn();
vi.mock('../utils/api', () => ({
  fetchApi: (...args) => fetchApiMock(...args),
}));

const notifyObj = {
  error: vi.fn(),
  info: vi.fn(),
  success: vi.fn(),
  confirm: () => Promise.resolve(true),
};
vi.mock('../utils/notify', () => ({
  useNotify: () => notifyObj,
}));

import GenericCampaignTemplates from '../components/GenericCampaignTemplates';

beforeEach(() => {
  fetchApiMock.mockReset();
  fetchApiMock.mockImplementation((url) => {
    if (String(url).startsWith('/api/email-templates?paginate=1')) {
      return Promise.resolve({ items: [], pagination: { page: 1, pageSize: 10, total: 0, totalPages: 1 } });
    }
    if (url === '/api/email-templates/personalization-fields') {
      return Promise.resolve({ fields: [] });
    }
    if (String(url).startsWith('/api/contacts')) return Promise.resolve({ data: [] });
    return Promise.resolve([]);
  });
});

describe('Generic CRM template personalization', () => {
  it('loads templates by channel and preserves all personalization categories including Sender Details', async () => {
    render(<GenericCampaignTemplates />);

    await waitFor(() => expect(fetchApiMock).toHaveBeenCalledWith(
      '/api/email-templates?paginate=1&page=1&limit=10&channel=EMAIL',
    ));

    fireEvent.click(await screen.findByRole('button', { name: /create new template/i }));
    const groupSelect = await screen.findByRole('combobox', { name: /personalization field group/i });
    const optionLabels = [...groupSelect.options].map(option => option.textContent);
    expect(optionLabels).toEqual(expect.arrayContaining([
      'Contact', 'Campaign', 'Deal', 'Invoice', 'Payment', 'Pickup', 'Visit',
      'Task', 'Activity', 'Expense', 'Contract', 'Estimate', 'Project', 'Sender Details',
    ]));
  });

  it('shows sender name, email, and company fields with neutral defaults when metadata is unavailable', async () => {
    render(<GenericCampaignTemplates />);
    fireEvent.click(await screen.findByRole('button', { name: /create new template/i }));
    const groupSelect = await screen.findByRole('combobox', { name: /personalization field group/i });
    fireEvent.change(groupSelect, { target: { value: 'Sender Details' } });
    expect(await screen.findByRole('button', { name: 'Sender Name' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Sender Email' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Sender Company' })).toBeInTheDocument();
  });
});
