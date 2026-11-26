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
  { id: 9, name: 'Kanchan Gupta', email: 'kanchan@example.com', company: 'Innotech', status: 'Prospect' },
  { id: 10, name: 'Meera Nair', email: 'meera@example.com', company: 'Acme Retail', status: 'Customer' },
];
const STAGES = [
  { id: 1, name: 'Lead', position: 0 },
  { id: 2, name: 'Contacted', position: 1 },
  { id: 3, name: 'Sales Qualified', position: 2 },
];
const PIPELINE = { id: 3, name: 'Enterprise', isDefault: true };

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
    if (url.startsWith('/api/pipeline_stages') && method === 'POST') {
      const created = { id: 44, ...JSON.parse(opts.body || '{}') };
      if (Array.isArray(overrides.pipelineStages)) overrides.pipelineStages.push(created);
      return Promise.resolve(created);
    }
    if (url.startsWith('/api/pipeline_stages')) return Promise.resolve([...(overrides.pipelineStages ?? overrides.stages ?? STAGES)]);
    if (url.startsWith('/api/pipelines')) return Promise.resolve(overrides.pipelines ?? [PIPELINE]);
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

async function selectPipeline(user) {
  const pipeline = await screen.findByLabelText('Pipeline');
  await user.selectOptions(pipeline, '3');
  await waitFor(() => expect(screen.getByLabelText('Deal stage')).not.toBeDisabled());
}

beforeEach(() => {
  fetchApiMock.mockReset();
  notifyObj.error.mockReset();
  notifyObj.success.mockReset();
  localStorage.clear();
});

describe('DealModal — add deal drawer', () => {
  it('shows Generic CRM contact and deal details and loads dynamic stages', async () => {
    mockLists();
    const user = userEvent.setup();
    renderModal();
    expect(await screen.findByText('Add deal')).toBeTruthy();
    expect(screen.getByLabelText('Deal name')).toBeTruthy();
    expect(screen.getByLabelText('Contact type')).toBeTruthy();
    expect(screen.getByLabelText('Deal type')).toBeTruthy();
    expect(screen.getByLabelText('Payment')).toBeTruthy();
    expect(screen.getByLabelText('Notes')).toBeTruthy();
    expect(screen.queryByText('Related account')).toBeNull();
    expect(screen.queryByRole('button', { name: /Add products/ })).toBeNull();
    const pipeline = screen.getByLabelText('Pipeline');
    expect(pipeline.closest('label')).toHaveTextContent('Pipeline *');
    expect(screen.getByText('Related lead')).toBeTruthy();
    expect(screen.getByText('Rakesh Rana')).toBeTruthy();
    const stage = await screen.findByLabelText('Deal stage');
    expect(stage).toBeDisabled();
    expect(within(stage).getByRole('option', { name: 'Select pipeline first' })).toBeTruthy();
    await selectPipeline(user);
    await waitFor(() => {
      expect(within(stage).getByRole('option', { name: 'Sales Qualified' })).toBeTruthy();
    });
    expect(stage.value).toBe('lead');
  });

  it('defaults contact-profile deals to the default pipeline and its Won stage', async () => {
    mockLists({
      pipelines: [
        { id: 2, name: 'Sales', isDefault: false },
        { id: 3, name: 'Default Pipeline', isDefault: true },
      ],
      pipelineStages: [
        { id: 31, name: 'Qualification' },
        { id: 32, name: 'Won' },
        { id: 33, name: 'Lost' },
      ],
    });

    const user = userEvent.setup();
    renderModal({ defaultToWon: true });

    expect(await screen.findByLabelText('Pipeline')).toHaveValue('3');
    await waitFor(() => expect(screen.getByLabelText('Deal stage')).toHaveValue('won'));
    await user.type(screen.getByLabelText('Deal value'), '25000');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => {
      const call = fetchApiMock.mock.calls.find((entry) => entry[0] === '/api/deals' && entry[1]?.method === 'POST');
      expect(JSON.parse(call[1].body)).toEqual(expect.objectContaining({ pipelineId: 3, stage: 'won' }));
    });
  });

  it('requires at least one stage when creating a Generic CRM pipeline', async () => {
    mockLists({ pipelineStages: [] });
    const user = userEvent.setup();
    renderModal({ contact: null });
    await user.selectOptions(await screen.findByLabelText('Pipeline'), '__create_pipeline__');

    const dialog = await screen.findByRole('dialog', { name: 'Create Pipeline' });
    expect(within(dialog).getByText('Add at least one stage.')).toBeTruthy();
    expect(within(dialog).queryByText('Required')).toBeNull();
    await user.type(within(dialog).getByPlaceholderText('e.g. Enterprise Sales'), 'Custom Pipeline');
    await user.click(within(dialog).getByRole('button', { name: 'Create Pipeline' }));
    expect(notifyObj.error).toHaveBeenCalledWith('Add at least one stage before creating a pipeline.');
    expect(fetchApiMock.mock.calls.some(([url, options]) => url === '/api/pipelines' && options?.method === 'POST')).toBe(false);
  });

  it('does not show lead lifecycle statuses when Generic CRM has no deal stages', async () => {
    mockLists({
      dealTypesSetting: { value: '[]' },
      pipelineStages: [],
    });
    const user = userEvent.setup();
    renderModal({ contact: null });
    await selectPipeline(user);
    const stage = await screen.findByLabelText('Deal stage');
    expect(within(stage).getByRole('option', { name: 'No deal stages configured' })).toBeTruthy();
    expect(within(stage).queryByRole('option', { name: 'New' })).toBeNull();
    expect(within(stage).queryByRole('option', { name: 'Interested' })).toBeNull();
    expect(within(stage).queryByRole('option', { name: 'lead' })).toBeNull();
    expect(within(stage).queryByRole('option', { name: 'contacted' })).toBeNull();
    expect(within(stage).queryByRole('option', { name: 'proposal' })).toBeNull();
    expect(fetchApiMock.mock.calls.some(([url]) => url.includes('generic.contactLifecycleStages'))).toBe(false);
  });

  it('opens the Generic CRM Pipeline Stages manager as a popup from Add new stage', async () => {
    const pipelineStages = [];
    mockLists({ dealTypesSetting: { value: '[]' }, pipelineStages });
    const user = userEvent.setup();
    renderModal({ contact: null });
    await selectPipeline(user);
    await user.selectOptions(await screen.findByLabelText('Deal stage'), '__new_stage__');
    const stageDialog = await screen.findByRole('dialog', { name: 'Pipeline stages' });
    expect(stageDialog).toHaveStyle({ backdropFilter: 'blur(5px)' });
    expect(stageDialog.firstElementChild).toHaveStyle({ width: '90%', maxWidth: '480px', height: '72vh', maxHeight: '472px' });
    expect(screen.getByRole('heading', { name: 'Pipeline Stages' })).toBeTruthy();
    expect(screen.queryByRole('dialog', { name: 'Deal type configuration' })).toBeNull();
    expect(screen.getByRole('dialog', { name: 'Add deal' })).toBeTruthy();
    await user.type(screen.getByLabelText('New pipeline stage name'), 'Proposal Sent');
    await user.click(screen.getByRole('button', { name: 'Add Stage' }));
    await waitFor(() => {
      const createCall = fetchApiMock.mock.calls.find(([url, options]) => url === '/api/pipeline_stages' && options?.method === 'POST');
      expect(JSON.parse(createCall[1].body)).toEqual(expect.objectContaining({ name: 'Proposal Sent', pipelineId: 3 }));
    });
    await user.click(screen.getByRole('button', { name: 'Close pipeline stages' }));
    await waitFor(() => expect(within(screen.getByLabelText('Deal stage')).getByRole('option', { name: 'Proposal Sent' })).toBeTruthy());
  });

  it('shows generic lead lifecycle records by name and submits the selected lead', async () => {
    mockLists();
    const user = userEvent.setup();
    renderModal({ contact: null });
    await selectPipeline(user);
    const search = await screen.findByLabelText('Search related lead');
    await user.type(search, 'Kanchan');
    await user.click(await screen.findByRole('option', { name: /Kanchan Gupta/ }));
    expect(screen.getByText('Kanchan Gupta')).toBeTruthy();
    await user.clear(screen.getByLabelText('Deal value'));
    await user.type(screen.getByLabelText('Deal value'), '1200');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => {
      const call = fetchApiMock.mock.calls.find((entry) => entry[0] === '/api/deals' && entry[1]?.method === 'POST');
      expect(JSON.parse(call[1].body)).toEqual(expect.objectContaining({ contactId: 9, contactType: 'lead' }));
    });
  });

  it('uses only the explicitly selected pipeline\'s stages for a new deal', async () => {
    mockLists({
      pipelines: [{ id: 3, name: 'Enterprise', isDefault: true }],
      pipelineStages: [{ id: 31, name: 'Qualification' }, { id: 32, name: 'Won' }],
    });
    const user = userEvent.setup();
    renderModal();
    const pipeline = await screen.findByLabelText('Pipeline');
    expect(pipeline).toHaveValue('');
    expect(screen.getByLabelText('Deal stage')).toBeDisabled();
    await user.selectOptions(pipeline, '3');
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
    await selectPipeline(user);
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
    await selectPipeline(user);
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
      expect(body.pipelineId).toBe(3);
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
    await selectPipeline(user);
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

});
