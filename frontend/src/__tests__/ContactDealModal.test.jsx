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
    if (url.includes('/api/tenant-settings/generic.dealTypes')) {
      return Promise.resolve(overrides.dealTypesSetting ?? {
        value: JSON.stringify([{ id: 'new-business', name: 'New Business', isDefault: true, stages: [{ id: 'new', name: 'New' }, { id: 'qualified', name: 'Sales Qualified' }, { id: 'won', name: 'Won' }, { id: 'lost', name: 'Lost' }] }]),
      });
    }
    if (url.includes('/api/tenant-settings/generic.contactLifecycleStages')) {
      return Promise.resolve(overrides.lifecycleSetting ?? {
        value: JSON.stringify([
          { id: 'new', title: 'New', options: [{ id: 'new', label: 'New' }] },
          { id: 'qualified', title: 'Qualified', options: [{ id: 'qualified', label: 'Sales Qualified' }] },
        ]),
      });
    }
    if (url.startsWith('/api/pipeline_stages')) return Promise.resolve(overrides.pipelineStages ?? overrides.stages ?? STAGES);
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
  it('keeps the edited type selected by ID after it is renamed', async () => {
    mockLists();
    const user = userEvent.setup();
    renderModal();
    const stage = await screen.findByLabelText('Deal stage');
    await user.selectOptions(stage, '__new_stage__');
    const dialog = await screen.findByRole('dialog', { name: 'Deal type configuration' });
    const name = within(dialog).getByLabelText(/deal type name/i);
    await user.clear(name);
    await user.type(name, 'Sales');
    await user.click(within(dialog).getByRole('button', { name: 'Save deal type' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Deal type configuration' })).toBeNull());
    await waitFor(() => expect(within(screen.getByLabelText('Deal stage')).getByRole('option', { name: 'Sales Qualified' })).toBeTruthy());
  });
  it('shows Generic CRM contact and deal details and loads dynamic stages', async () => {
    mockLists();
    renderModal();
    expect(await screen.findByText('Add deal')).toBeTruthy();
    expect(screen.getByLabelText('Deal name')).toBeTruthy();
    expect(screen.getByLabelText('Contact type')).toBeTruthy();
    expect(screen.getByLabelText('Deal type')).toBeTruthy();
    expect(screen.getByLabelText('Payment')).toBeTruthy();
    expect(screen.getByLabelText('Notes')).toBeTruthy();
    expect(screen.queryByText('Related account')).toBeNull();
    expect(screen.queryByRole('button', { name: /Add products/ })).toBeNull();
    expect(screen.getByLabelText('Pipeline')).toBeTruthy();
    expect(screen.getByText('Rakesh Rana')).toBeTruthy();
    const stage = await screen.findByLabelText('Deal stage');
    await waitFor(() => {
      expect(within(stage).getByRole('option', { name: 'Sales Qualified' })).toBeTruthy();
    });
    expect(stage.value).toBe('new');
  });

  it('selects the default pipeline and uses that pipeline\'s stages for a new deal', async () => {
    mockLists({
      pipelines: [{ id: 3, name: 'Enterprise', isDefault: true }],
      pipelineStages: [{ id: 31, name: 'Qualification' }, { id: 32, name: 'Won' }],
    });
    const user = userEvent.setup();
    renderModal();
    const pipeline = await screen.findByLabelText('Pipeline');
    await waitFor(() => expect(pipeline).toHaveValue('3'));
    const stage = await screen.findByLabelText('Deal stage');
    expect(within(stage).getByRole('option', { name: 'Qualification' })).toBeTruthy();
    await user.selectOptions(stage, 'qualification');
    await user.clear(screen.getByLabelText('Deal value'));
    await user.type(screen.getByLabelText('Deal value'), '50000');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => {
      const call = fetchApiMock.mock.calls.find((entry) => entry[0] === '/api/deals' && entry[1]?.method === 'POST');
      expect(JSON.parse(call[1].body)).toEqual(expect.objectContaining({ pipelineId: 3, stage: 'qualification' }));
    });
  });

  it('shows billing period only for recurring Generic deals and persists payment and notes', async () => {
    mockLists();
    const user = userEvent.setup();
    renderModal();
    await screen.findByText('Add deal');
    await user.selectOptions(screen.getByLabelText('Deal type'), 'recurring');
    expect(screen.getByLabelText('Billing period')).toBeTruthy();
    await user.selectOptions(screen.getByLabelText('Billing period'), 'monthly');
    await user.type(screen.getByLabelText('Payment'), '20% advance');
    await user.type(screen.getByLabelText('Notes'), 'Requested a site visit next week.');
    await user.clear(screen.getByLabelText('Deal value'));
    await user.type(screen.getByLabelText('Deal value'), '50000');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => {
      const call = fetchApiMock.mock.calls.find((c) => c[0] === '/api/deals' && c[1]?.method === 'POST');
      expect(JSON.parse(call[1].body)).toEqual(expect.objectContaining({ dealKind: 'recurring', billingPeriod: 'monthly', paymentInfo: '20% advance', notes: 'Requested a site visit next week.' }));
    });
    await user.selectOptions(screen.getByLabelText('Deal type'), 'one-time');
    expect(screen.queryByLabelText('Billing period')).toBeNull();
  });

  it('creates the deal with title, value, stage and contact on Save', async () => {
    mockLists();
    const user = userEvent.setup();
    const { onClose, onDone } = renderModal();
    await screen.findByText('Add deal');
    await user.clear(screen.getByLabelText('Deal value'));
    await user.type(screen.getByLabelText('Deal value'), '50000');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => {
      const call = fetchApiMock.mock.calls.find((c) => c[0] === '/api/deals' && c[1]?.method === 'POST');
      expect(call).toBeTruthy();
      const body = JSON.parse(call[1].body);
      expect(body.title).toBe('Rakesh Rana Deal');
      expect(body.amount).toBe(50000);
      expect(body.stage).toBe('new');
      expect(body.contactId).toBe(7);
      expect(body.currency).toBe('USD');
    });
    expect(notifyObj.success).toHaveBeenCalledWith('Deal created.');
    expect(onDone).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('blocks save with an error when the deal value is empty', async () => {
    mockLists();
    const user = userEvent.setup();
    renderModal();
    await screen.findByText('Add deal');
    await user.clear(screen.getByLabelText('Deal value'));
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(notifyObj.error).toHaveBeenCalledWith('Enter a deal value greater than zero.');
    expect(fetchApiMock.mock.calls.some((c) => c[0] === '/api/deals' && c[1]?.method === 'POST')).toBe(false);
  });

  it('does not render product controls for generic CRM', async () => {
    mockLists();
    renderModal();
    await screen.findByText('Add deal');
    expect(screen.queryByRole('button', { name: /Add products/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /Add product/ })).toBeNull();
  });

  it('does not render extra probability or expected-close fields for generic CRM', async () => {
    mockLists({ pipelines: [{ id: 3, name: 'Enterprise' }] });
    renderModal();
    await screen.findByText('Add deal');
    expect(screen.queryByLabelText('Probability %')).toBeNull();
    expect(screen.queryByLabelText('Expected close')).toBeNull();
    expect(screen.queryByRole('button', { name: /Show all fields|Hide extra fields/ })).toBeNull();
    expect(screen.getByLabelText('Pipeline')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Customize fields/ })).toBeNull();
  });

  it('falls back to default deal-type stages when the deal-type setting fails', async () => {
    fetchApiMock.mockImplementation((url) => {
      if (url.startsWith('/api/contacts')) return Promise.resolve(CONTACTS);
      if (url.includes('/api/tenant-settings/generic.dealTypes')) return Promise.reject(new Error('down'));
      if (url.startsWith('/api/pipelines')) return Promise.resolve([]);
      if (url.startsWith('/api/staff')) return Promise.resolve([]);
      return Promise.resolve([]);
    });
    renderModal();
    const stage = await screen.findByLabelText('Deal stage');
    await waitFor(() => {
      expect(within(stage).getByRole('option', { name: 'Contracted' })).toBeTruthy();
    });
  });
});
