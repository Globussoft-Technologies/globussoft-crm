import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const fetchApiMock = vi.fn();
vi.mock('../utils/api', () => ({
  fetchApi: (...args) => fetchApiMock(...args),
}));

vi.mock('../utils/money', () => ({
  formatMoney: (n, opts) => `${opts?.currency || 'USD'} ${n ?? 0}`,
  tenantCurrency: () => 'USD',
}));

const notifyObj = {
  error: vi.fn(),
  success: vi.fn(),
  info: vi.fn(),
  confirm: vi.fn(() => Promise.resolve(true)),
};
vi.mock('../utils/notify', () => ({
  useNotify: () => notifyObj,
}));

import { DealModal } from '../components/contact/ActionModals';

const CONTACT = { id: 7, name: 'Rakesh Rana', email: 'rakesh@example.com', company: 'Acme Retail' };
const CONTACTS = [
  CONTACT,
  { id: 8, name: 'Priya Sharma', email: 'priya@example.com', company: 'Globex' },
];
const STAGES = [
  { id: 1, name: 'Lead', position: 0 },
  { id: 2, name: 'Contacted', position: 1 },
  { id: 3, name: 'Sales Qualified', position: 2 },
];

function mockLists(overrides = {}) {
  fetchApiMock.mockImplementation((url, opts) => {
    const method = opts?.method || 'GET';
    if (url.startsWith('/api/contacts') && method === 'GET') {
      return Promise.resolve(overrides.contacts ?? CONTACTS);
    }
    if (url === '/api/pipeline_stages') return Promise.resolve(overrides.stages ?? STAGES);
    if (url.startsWith('/api/pipelines')) return Promise.resolve(overrides.pipelines ?? []);
    if (url.startsWith('/api/staff')) return Promise.resolve(overrides.staff ?? []);
    if (url === '/api/deals' && method === 'POST') {
      if (overrides.create === 'throw') return Promise.reject(new Error('boom'));
      return Promise.resolve({ id: 99, ...(overrides.created || {}) });
    }
    if (/^\/api\/deals\/\d+$/.test(url) && method === 'PUT') return Promise.resolve({ id: 5 });
    return Promise.resolve([]);
  });
}

function renderModal(props = {}) {
  const onClose = vi.fn();
  const onDone = vi.fn();
  render(<DealModal contact={CONTACT} onClose={onClose} onDone={onDone} {...props} />);
  return { onClose, onDone };
}

beforeEach(() => {
  fetchApiMock.mockReset();
  notifyObj.error.mockReset();
  notifyObj.success.mockReset();
  localStorage.clear();
});

describe('DealModal — add deal drawer', () => {
  it('prefills "<name> Deal", shows the contact chip and loads dynamic stages', async () => {
    mockLists();
    renderModal();
    expect(await screen.findByDisplayValue('Rakesh Rana Deal')).toBeTruthy();
    expect(screen.getByText('Rakesh Rana')).toBeTruthy();
    const stage = await screen.findByLabelText('Deal stage');
    await waitFor(() => {
      expect(within(stage).getByRole('option', { name: 'Sales Qualified' })).toBeTruthy();
    });
    expect(stage.value).toBe('lead');
  });

  it('creates the deal with title, value, stage and contact on Save', async () => {
    mockLists();
    const user = userEvent.setup();
    const { onClose, onDone } = renderModal();
    await screen.findByDisplayValue('Rakesh Rana Deal');
    await user.clear(screen.getByLabelText('Deal value'));
    await user.type(screen.getByLabelText('Deal value'), '50000');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => {
      const call = fetchApiMock.mock.calls.find((c) => c[0] === '/api/deals' && c[1]?.method === 'POST');
      expect(call).toBeTruthy();
      const body = JSON.parse(call[1].body);
      expect(body.title).toBe('Rakesh Rana Deal');
      expect(body.amount).toBe(50000);
      expect(body.stage).toBe('lead');
      expect(body.contactId).toBe(7);
      expect(body.currency).toBe('USD');
    });
    expect(notifyObj.success).toHaveBeenCalledWith('Deal created.');
    expect(onDone).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('blocks save with an error when the deal name is empty', async () => {
    mockLists();
    const user = userEvent.setup();
    renderModal();
    await screen.findByDisplayValue('Rakesh Rana Deal');
    await user.clear(screen.getByLabelText('Deal name *'));
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(notifyObj.error).toHaveBeenCalledWith('Enter a deal name.');
    expect(fetchApiMock.mock.calls.some((c) => c[0] === '/api/deals' && c[1]?.method === 'POST')).toBe(false);
  });

  it('blocks save with an error when the deal value is empty', async () => {
    mockLists();
    const user = userEvent.setup();
    renderModal();
    await screen.findByDisplayValue('Rakesh Rana Deal');
    await user.clear(screen.getByLabelText('Deal value'));
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(notifyObj.error).toHaveBeenCalledWith('Enter a deal value of 0 or more.');
    expect(fetchApiMock.mock.calls.some((c) => c[0] === '/api/deals' && c[1]?.method === 'POST')).toBe(false);
  });

  it('product lines total flows into the deal value', async () => {
    mockLists();
    const user = userEvent.setup();
    renderModal();
    await screen.findByDisplayValue('Rakesh Rana Deal');
    await user.click(screen.getByRole('button', { name: /Add products/ }));
    await user.click(screen.getByRole('button', { name: /Add product/ }));
    await user.clear(screen.getByLabelText('Product 1 quantity'));
    await user.type(screen.getByLabelText('Product 1 quantity'), '2');
    await user.type(screen.getByLabelText('Product 1 price'), '2500');
    expect(screen.getByLabelText('Deal value').value).toBe('5000');
  });

  it('Show all fields reveals probability and pipeline', async () => {
    mockLists({ pipelines: [{ id: 3, name: 'Enterprise' }] });
    const user = userEvent.setup();
    renderModal();
    await screen.findByDisplayValue('Rakesh Rana Deal');
    expect(screen.queryByLabelText('Probability %')).toBeNull();
    await user.click(screen.getByRole('button', { name: /Show all fields/ }));
    expect(await screen.findByLabelText('Probability %')).toBeTruthy();
    expect(screen.getByLabelText('Pipeline')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Customize fields/ })).toBeNull();
  });

  it('falls back to legacy stages when the stages endpoint fails', async () => {
    fetchApiMock.mockImplementation((url) => {
      if (url.startsWith('/api/contacts')) return Promise.resolve(CONTACTS);
      if (url === '/api/pipeline_stages') return Promise.reject(new Error('down'));
      if (url.startsWith('/api/pipelines')) return Promise.resolve([]);
      if (url.startsWith('/api/staff')) return Promise.resolve([]);
      return Promise.resolve([]);
    });
    renderModal();
    const stage = await screen.findByLabelText('Deal stage');
    await waitFor(() => {
      expect(within(stage).getByRole('option', { name: 'proposal' })).toBeTruthy();
    });
  });
});
