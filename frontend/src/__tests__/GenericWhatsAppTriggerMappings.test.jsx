import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import GenericWhatsAppTriggerMappings from '../components/GenericWhatsAppTriggerMappings';

const fetchApiMock = vi.fn();
const notify = { success: vi.fn(), error: vi.fn(), info: vi.fn(), confirm: vi.fn() };
const scrollIntoViewMock = vi.fn();
const scrollToMock = vi.fn();

vi.mock('../utils/api', () => ({ fetchApi: (...args) => fetchApiMock(...args) }));
vi.mock('../utils/notify', () => ({ useNotify: () => notify }));

const templates = [
  { id: 9, name: 'welcome_lead', status: 'APPROVED', body: 'Hi {{1}}', variableMapping: { 1: 'contact.first_name' } },
  { id: 10, name: 'follow_up', status: 'APPROVED', body: 'Following up with {{1}}' },
  { id: 11, name: 'thank_you', status: 'APPROVED', body: 'Thank you, {{1}}' },
];

beforeEach(() => {
  fetchApiMock.mockReset().mockImplementation((url, options = {}) => {
    if (url === '/api/whatsapp/templates') return Promise.resolve(templates);
    if (url === '/api/lead-custom-fields') return Promise.resolve([]);
    if (url === '/api/marketing/generic-condition-metadata') return Promise.resolve({ statusOptions: [{ value: 'Lead', label: 'Lead' }, { value: 'Prospect', label: 'Prospect' }, { value: 'Customer', label: 'Customer' }] });
    if (url === '/api/contacts/filter-values/lifecycleStageKey') return Promise.resolve({ values: [{ value: 'new', label: 'New' }, { value: 'contacted', label: 'Contacted' }, { value: 'qualified', label: 'Qualified' }] });
    if (url === '/api/contacts/filter-values/company') return Promise.resolve({ values: [{ value: 'Acme', label: 'Acme' }, { value: 'Globex', label: 'Globex' }] });
    if (url === '/api/email-templates/preview' && options.method === 'POST') return Promise.resolve({ body: 'Hi Sample contact' });
    if (url === '/api/sequences' && options.method === 'POST') return Promise.resolve({ id: 90 });
    if (url === '/api/marketing/campaigns' && options.method === 'POST') return Promise.resolve({ id: 22 });
    return Promise.resolve([]);
  });
  notify.success.mockReset();
  notify.error.mockReset();
  notify.info.mockReset();
  notify.confirm.mockReset().mockResolvedValue('save');
  scrollIntoViewMock.mockReset();
  scrollToMock.mockReset();
  Element.prototype.scrollIntoView = scrollIntoViewMock;
  Element.prototype.scrollTo = scrollToMock;
});

describe('GenericWhatsAppTriggerMappings', () => {
  it('previews the selected WhatsApp template and opens its creator on the same page', async () => {
    render(<GenericWhatsAppTriggerMappings campaigns={[]} onSaved={vi.fn()} />);

    fireEvent.change(await screen.findByRole('combobox', { name: 'WhatsApp template for step 1' }), { target: { value: '9' } });
    fireEvent.click(screen.getByRole('button', { name: 'Preview' }));

    const dialog = within(await screen.findByRole('dialog', { name: 'Preview WhatsApp template' }));
    expect(dialog.getByTitle('Rendered sequence template preview')).toHaveAttribute('srcdoc', expect.stringContaining('Hi Sample contact'));
    const previewCall = fetchApiMock.mock.calls.find(([url, options]) => url === '/api/email-templates/preview' && options?.method === 'POST');
    expect(JSON.parse(previewCall[1].body).body).toBe('Hi {{contact.first_name}}');
    fireEvent.click(dialog.getByRole('button', { name: 'Close' }));

    fireEvent.click(screen.getByRole('button', { name: 'Add template' }));
    const creator = within(await screen.findByRole('dialog', { name: 'Create campaign template' }));
    expect(screen.getByRole('combobox', { name: 'Template Type' })).toHaveValue('WHATSAPP');
    fireEvent.click(creator.getByRole('button', { name: 'Close' }));
    expect(screen.getByRole('combobox', { name: 'WhatsApp template for step 1' })).toHaveValue('9');
  });

  it('shows the WhatsApp trigger and first template step', async () => {
    render(<GenericWhatsAppTriggerMappings campaigns={[]} onSaved={vi.fn()} />);

    expect(await screen.findByRole('heading', { name: 'Build a WhatsApp sequence' })).toBeInTheDocument();
    expect(screen.getByText('WHEN · TRIGGER')).toBeInTheDocument();
    expect(screen.getByText('STEP 1 · SEND WHATSAPP')).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: 'WhatsApp sequence trigger' })).toHaveValue('contact.created');
    expect(screen.queryByText('Lead field filters')).not.toBeInTheDocument();
  });

  it('offers only the eight supported Generic CRM sequence triggers', async () => {
    render(<GenericWhatsAppTriggerMappings campaigns={[]} onSaved={vi.fn()} />);
    const trigger = await screen.findByRole('combobox', { name: 'WhatsApp sequence trigger' });
    const values = within(trigger).getAllByRole('option').map(option => option.value);
    expect(values).toEqual([
      'contact.created', 'contact.status_changed', 'payment.due', 'pickup_plot.selection_requested',
      'pickup_point.assigned', 'pickup_plot.selected', 'payment.collected', 'plot.confirmed',
    ]);
  });

  it('loads the requested WhatsApp trigger-specific presets', async () => {
    render(<GenericWhatsAppTriggerMappings campaigns={[]} onSaved={vi.fn()} />);
    const trigger = await screen.findByRole('combobox', { name: 'WhatsApp sequence trigger' });

    fireEvent.focus(trigger);
    expect(screen.queryByRole('spinbutton', { name: 'Wait duration step 2' })).not.toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: 'WhatsApp template for step 1' })).toBeInTheDocument();
    expect(screen.getByText('Last step · the sequence ends here when saved')).toBeInTheDocument();

    fireEvent.change(trigger, { target: { value: 'contact.status_changed' } });
    expect(screen.getByRole('button', { name: 'CRM column step 1' })).toHaveTextContent('Lead stage');
    expect(screen.getByRole('button', { name: 'CRM column step 1' })).toBeDisabled();
    expect(screen.queryByText('Wait added')).not.toBeInTheDocument();
    expect(screen.queryByRole('spinbutton', { name: 'Wait duration step 2' })).not.toBeInTheDocument();

    fireEvent.change(trigger, { target: { value: 'payment.due' } });
    expect(screen.getByRole('article', { name: 'Payment due timing condition' })).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: 'WhatsApp template for step 1' })).toBeInTheDocument();
    expect(screen.queryByRole('spinbutton', { name: 'Wait duration step 2' })).not.toBeInTheDocument();

    fireEvent.change(trigger, { target: { value: 'pickup_plot.selected' } });
    expect(screen.getByRole('combobox', { name: 'WhatsApp template for step 1' })).toBeInTheDocument();
    expect(screen.queryByRole('combobox', { name: 'If replied — send' })).not.toBeInTheDocument();

    fireEvent.change(trigger, { target: { value: 'plot.confirmed' } });
    expect(screen.getByRole('combobox', { name: 'WhatsApp template for step 1' })).toBeInTheDocument();
    expect(screen.queryByRole('spinbutton', { name: 'Wait duration step 2' })).not.toBeInTheDocument();
  });

  it('shows the exact missing-template error', async () => {
    render(<GenericWhatsAppTriggerMappings campaigns={[]} onSaved={vi.fn()} />);
    await screen.findByRole('combobox', { name: 'WhatsApp template for step 1' });

    fireEvent.click(screen.getByRole('button', { name: /Save & activate/i }));

    expect(notify.error).toHaveBeenCalledWith('Select a WhatsApp template in Step 1.');
  });

  it('reports every incomplete WhatsApp step instead of always reporting only Step 1', async () => {
    render(<GenericWhatsAppTriggerMappings campaigns={[]} onSaved={vi.fn()} />);
    fireEvent.change(await screen.findByRole('combobox', { name: 'WhatsApp sequence trigger' }), { target: { value: 'contact.status_changed' } });
    fireEvent.change(screen.getByRole('combobox', { name: 'Next step type after step 1' }), { target: { value: 'whatsapp' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add next step' }));

    fireEvent.click(screen.getByRole('button', { name: /Save & activate/i }));

    expect(notify.error).toHaveBeenCalledWith(
      'Select a Lead stage in Step 1. Select a WhatsApp template in Step 2.',
    );
  });

  it('numbers the second visible WhatsApp message as Step 2 after its automatic wait', async () => {
    render(<GenericWhatsAppTriggerMappings campaigns={[]} onSaved={vi.fn()} />);
    fireEvent.change(await screen.findByRole('combobox', { name: 'WhatsApp template for step 1' }), { target: { value: '9' } });
    fireEvent.change(screen.getByRole('combobox', { name: 'Next step type after step 1' }), { target: { value: 'whatsapp' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add next step' }));

    expect(screen.getByText('STEP 2 · SEND WHATSAPP')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Save & activate/i }));

    expect(notify.error).toHaveBeenCalledWith('Select a WhatsApp template in Step 2.');
  });

  it('offers to save an unticked WhatsApp step and includes it when confirmed', async () => {
    render(<GenericWhatsAppTriggerMappings campaigns={[]} onSaved={vi.fn()} />);
    fireEvent.change(await screen.findByRole('combobox', { name: 'WhatsApp template for step 1' }), { target: { value: '9' } });
    fireEvent.change(screen.getByRole('combobox', { name: 'Next step type after step 1' }), { target: { value: 'whatsapp' } });
    fireEvent.change(screen.getByRole('combobox', { name: 'WhatsApp template for step 3' }), { target: { value: '10' } });

    fireEvent.click(screen.getByRole('button', { name: /Save & activate/i }));

    await waitFor(() => expect(notify.success).toHaveBeenCalled());
    expect(notify.confirm).toHaveBeenCalledWith(expect.objectContaining({
      title: 'Save unfinished step?',
      confirmText: 'Save step',
      cancelText: 'Discard & save',
    }));
    const stepCalls = fetchApiMock.mock.calls.filter(([url, options]) => url === '/api/sequences/90/steps' && options?.method === 'POST');
    expect(stepCalls.map(([, options]) => JSON.parse(options.body).kind)).toEqual(['whatsapp', 'wait', 'whatsapp']);
  });

  it('discards an unticked WhatsApp step and saves only committed steps when requested', async () => {
    notify.confirm.mockResolvedValue('discard');
    render(<GenericWhatsAppTriggerMappings campaigns={[]} onSaved={vi.fn()} />);
    fireEvent.change(await screen.findByRole('combobox', { name: 'WhatsApp template for step 1' }), { target: { value: '9' } });
    fireEvent.change(screen.getByRole('combobox', { name: 'Next step type after step 1' }), { target: { value: 'whatsapp' } });

    fireEvent.click(screen.getByRole('button', { name: /Save & activate/i }));

    await waitFor(() => expect(notify.success).toHaveBeenCalled());
    const stepCalls = fetchApiMock.mock.calls.filter(([url, options]) => url === '/api/sequences/90/steps' && options?.method === 'POST');
    expect(stepCalls).toHaveLength(1);
  });

  it('saves the WhatsApp payment-due lead time with one template', async () => {
    render(<GenericWhatsAppTriggerMappings campaigns={[]} onSaved={vi.fn()} />);
    fireEvent.change(await screen.findByRole('combobox', { name: 'WhatsApp sequence trigger' }), { target: { value: 'payment.due' } });
    fireEvent.change(screen.getByRole('spinbutton', { name: 'Payment due reminder amount' }), { target: { value: '3' } });
    fireEvent.change(screen.getByRole('combobox', { name: 'Payment due reminder unit' }), { target: { value: 'days' } });
    fireEvent.change(screen.getByRole('combobox', { name: 'WhatsApp template for step 1' }), { target: { value: '9' } });
    fireEvent.click(screen.getByRole('button', { name: /Save & activate/i }));

    await waitFor(() => expect(notify.success).toHaveBeenCalled());
    const scheduleCall = fetchApiMock.mock.calls.find(([url]) => url === '/api/marketing/campaigns/22/schedule');
    expect(JSON.parse(scheduleCall[1].body).filters).toMatchObject({
      eventTrigger: 'payment.due',
      dueBefore: { amount: '3', unit: 'days' },
      steps: [{ type: 'whatsapp', templateId: '9' }],
    });
  });

  it('offers immediate send and conditions without a stop option', async () => {
    render(<GenericWhatsAppTriggerMappings campaigns={[]} onSaved={vi.fn()} />);
    const nextStep = await screen.findByRole('combobox', { name: 'Next step type after step 1' });
    expect(within(nextStep).getAllByRole('option').map(option => ({ value: option.value, label: option.textContent }))).toEqual([
      { value: '', label: 'Choose next step' },
      { value: 'whatsapp', label: 'WhatsApp message' },
      { value: 'reply', label: 'Reply condition' },
      { value: 'field', label: 'CRM column condition' },
    ]);
  });

  it('opens the next WhatsApp message editor and lets the same card switch step type', async () => {
    render(<GenericWhatsAppTriggerMappings campaigns={[]} onSaved={vi.fn()} />);
    const nextStep = await screen.findByRole('combobox', { name: 'Next step type after step 1' });
    expect(nextStep).toHaveValue('');
    fireEvent.click(screen.getByRole('button', { name: 'Add step after step 1' }));
    expect(nextStep).toHaveValue('whatsapp');
    expect(nextStep).toHaveStyle({ width: '210px' });
    expect(screen.getByText('STEP 2')).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: 'WhatsApp template for step 3' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Add next step' })).toBeInTheDocument();

    fireEvent.change(nextStep, { target: { value: 'reply' } });
    expect(nextStep).toHaveValue('reply');
    expect(screen.queryByRole('button', { name: 'Add step after step 1' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Add reply condition' })).toBeInTheDocument();
    fireEvent.change(nextStep, { target: { value: 'field' } });
    expect(screen.getByRole('button', { name: 'Add CRM column condition' })).toBeInTheDocument();
  });

  it('automatically links a wait to the following WhatsApp template', async () => {
    render(<GenericWhatsAppTriggerMappings campaigns={[]} onSaved={vi.fn()} />);
    const nextStep = await screen.findByRole('combobox', { name: 'Next step type after step 1' });

    expect(within(nextStep).queryByRole('option', { name: 'Wait' })).not.toBeInTheDocument();
    fireEvent.change(nextStep, { target: { value: 'whatsapp' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add next step' }));

    expect(screen.getByRole('spinbutton', { name: 'Wait duration step 2' })).toHaveValue(1);
    expect(screen.getByRole('combobox', { name: 'WhatsApp template for step 3' })).toBeInTheDocument();
    expect(screen.queryByText('Wait added')).not.toBeInTheDocument();
    expect(screen.getByText('Last step · the sequence ends here when saved')).toBeInTheDocument();
    expect(notify.success).toHaveBeenCalledWith(
      'Next step added: wait 1 day, then send the next WhatsApp message.',
    );
  });

  it('reports trigger changes and removed WhatsApp steps', async () => {
    render(<GenericWhatsAppTriggerMappings campaigns={[]} onSaved={vi.fn()} />);

    const trigger = await screen.findByRole('combobox', { name: 'WhatsApp sequence trigger' });
    fireEvent.change(trigger, { target: { value: 'payment.due' } });
    expect(notify.info).toHaveBeenCalledWith(
      expect.stringMatching(/^Starting event updated: .*The sequence will begin when this happens\.$/),
    );

    fireEvent.change(screen.getByRole('combobox', { name: 'Next step type after step 1' }), { target: { value: 'whatsapp' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add next step' }));
    fireEvent.click(screen.getByRole('button', { name: 'Remove step 3' }));
    expect(notify.info).toHaveBeenCalledWith(
      'Step removed: WhatsApp message and its wait condition.',
    );
  });

  it('shows the selected WhatsApp immediate-send editor only after selection', async () => {
    render(<GenericWhatsAppTriggerMappings campaigns={[]} onSaved={vi.fn()} />);
    const nextStep = await screen.findByRole('combobox', { name: 'Next step type after step 1' });

    fireEvent.focus(nextStep);
    expect(screen.queryByRole('article', { name: 'WhatsApp selected condition preview' })).not.toBeInTheDocument();
    fireEvent.change(nextStep, { target: { value: 'whatsapp' } });

    const combinedPreview = screen.getByRole('article', { name: 'WhatsApp selected condition preview' });
    expect(combinedPreview).toBeInTheDocument();
    const waitDuration = screen.getByRole('spinbutton', { name: 'Wait duration step 2' });
    expect(combinedPreview).toContainElement(waitDuration);
    fireEvent.change(waitDuration, { target: { value: '4' } });
    expect(screen.getByRole('combobox', { name: 'WhatsApp template for step 3' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Add next step' }));
    expect(screen.getByRole('spinbutton', { name: 'Wait duration step 2' })).toHaveValue(4);
    expect(screen.getByRole('combobox', { name: 'WhatsApp template for step 3' })).toBeInTheDocument();
  });

  it('scrolls to a newly added WhatsApp step or condition', async () => {
    render(<GenericWhatsAppTriggerMappings campaigns={[]} onSaved={vi.fn()} />);
    await screen.findByRole('combobox', { name: 'Next step type after step 1' });

    const nextStep = screen.getByRole('combobox', { name: 'Next step type after step 1' });
    fireEvent.change(nextStep, { target: { value: 'whatsapp' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add next step' }));

    const canvas = screen.getByRole('region', { name: 'WhatsApp sequence steps' });
    expect(canvas).toHaveStyle({ overflowY: 'auto', overscrollBehaviorY: 'contain' });
    await waitFor(() => expect(scrollToMock).toHaveBeenCalledWith({ top: canvas.scrollHeight, behavior: 'smooth' }));
    expect(scrollIntoViewMock).not.toHaveBeenCalled();
  });

  it('keeps Wait out of dropdowns and offers it on each WhatsApp template', async () => {
    render(<GenericWhatsAppTriggerMappings campaigns={[]} onSaved={vi.fn()} />);
    const firstNextStep = await screen.findByRole('combobox', { name: 'Next step type after step 1' });
    expect(within(firstNextStep).queryByRole('option', { name: 'Wait' })).not.toBeInTheDocument();

    fireEvent.change(firstNextStep, { target: { value: 'whatsapp' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add next step' }));

    expect(screen.queryByRole('combobox', { name: 'Next step type after step 2' })).not.toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: 'Next step type after step 3' })).toBeInTheDocument();
  });

  it('adds wait, reply-condition, and later WhatsApp steps in order', async () => {
    render(<GenericWhatsAppTriggerMappings campaigns={[]} onSaved={vi.fn()} />);
    await screen.findByRole('option', { name: 'welcome_lead' });

    const firstNextStep = screen.getByRole('combobox', { name: 'Next step type after step 1' });
    fireEvent.change(firstNextStep, { target: { value: 'whatsapp' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add next step' }));
    expect(screen.getByText('CONDITION · WAIT')).toBeInTheDocument();

    fireEvent.change(screen.getByRole('combobox', { name: 'Next step type after step 3' }), { target: { value: 'reply' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add reply condition' }));
    expect(screen.getByText('CONDITION · CHECK CUSTOMER REPLY')).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: 'If replied — send' })).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: 'If no reply — send' })).toBeInTheDocument();
  });

  it('persists a durable sequence and links it to the WhatsApp campaign', async () => {
    const onSaved = vi.fn();
    render(<GenericWhatsAppTriggerMappings campaigns={[]} onSaved={onSaved} />);
    await screen.findByRole('option', { name: 'welcome_lead' });

    fireEvent.change(screen.getByRole('combobox', { name: 'WhatsApp template for step 1' }), { target: { value: '9' } });
    const nextStep = screen.getByRole('combobox', { name: 'Next step type after step 1' });
    fireEvent.change(nextStep, { target: { value: 'whatsapp' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add next step' }));
    fireEvent.change(screen.getByRole('spinbutton', { name: 'Wait duration step 2' }), { target: { value: '2' } });
    fireEvent.change(screen.getByRole('combobox', { name: 'Wait unit step 2' }), { target: { value: 'days' } });
    fireEvent.change(screen.getByRole('combobox', { name: 'WhatsApp template for step 3' }), { target: { value: '10' } });
    expect(screen.getByText('STEP 2 · SEND WHATSAPP')).toBeInTheDocument();
    const combinedStep = screen.getByRole('article', { name: 'WhatsApp sequence step 3' });
    expect(combinedStep).toContainElement(screen.getByRole('spinbutton', { name: 'Wait duration step 2' }));
    expect(combinedStep).toContainElement(screen.getByRole('combobox', { name: 'WhatsApp template for step 3' }));
    expect(screen.getByLabelText('WhatsApp DND and opt-out check')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Save & activate/i }));

    await waitFor(() => expect(notify.success).toHaveBeenCalledWith('WhatsApp sequence saved and activated'));
    const stepCalls = fetchApiMock.mock.calls.filter(([url, options]) => url === '/api/sequences/90/steps' && options?.method === 'POST');
    expect(stepCalls.map(([, options]) => JSON.parse(options.body))).toMatchObject([
      { position: 0, kind: 'whatsapp' },
      { position: 1, kind: 'wait', delayMinutes: 2880 },
      { position: 2, kind: 'whatsapp' },
    ]);
    const campaignCall = fetchApiMock.mock.calls.find(([url, options]) => url === '/api/marketing/campaigns' && options?.method === 'POST');
    expect(JSON.parse(campaignCall[1].body)).toMatchObject({ channel: 'WHATSAPP', status: 'Active', sequenceId: 90 });
    const scheduleCall = fetchApiMock.mock.calls.find(([url]) => url === '/api/marketing/campaigns/22/schedule');
    const savedFilters = JSON.parse(scheduleCall[1].body).filters;
    expect(savedFilters).not.toHaveProperty('conditions');
    expect(savedFilters.steps).toMatchObject([
      { type: 'whatsapp', templateId: '9' },
      { type: 'wait', amount: '2', unit: 'days' },
      { type: 'whatsapp', templateId: '10' },
    ]);
    const activationCall = fetchApiMock.mock.calls.find(([url, options]) => url === '/api/marketing/campaigns/22' && options?.method === 'PUT');
    expect(JSON.parse(activationCall[1].body)).toEqual({ status: 'Active', sequenceId: 90 });
    expect(onSaved).toHaveBeenCalled();
  });

  it('updates an existing WhatsApp sequence with the same trigger instead of creating another one', async () => {
    const baseImplementation = fetchApiMock.getMockImplementation();
    const existing = {
      id: 45,
      sequenceId: 95,
      channel: 'WHATSAPP',
      scheduleFilters: JSON.stringify({
        automationType: 'whatsapp_event',
        eventTrigger: 'contact.created',
      }),
    };
    fetchApiMock.mockImplementation((url, options = {}) => {
      if (url === '/api/marketing/campaigns?channel=WHATSAPP&sequenceTrigger=contact.created') {
        return Promise.resolve([existing]);
      }
      return baseImplementation(url, options);
    });

    render(<GenericWhatsAppTriggerMappings campaigns={[]} onSaved={vi.fn()} />);
    fireEvent.change(await screen.findByRole('combobox', { name: 'WhatsApp template for step 1' }), { target: { value: '9' } });
    fireEvent.click(screen.getByRole('button', { name: /Save & activate/i }));

    await waitFor(() => expect(notify.success).toHaveBeenCalledWith('WhatsApp sequence updated and activated'));
    expect(fetchApiMock).toHaveBeenCalledWith('/api/sequences/95', expect.objectContaining({ method: 'PATCH' }));
    expect(fetchApiMock).toHaveBeenCalledWith('/api/marketing/campaigns/45', expect.objectContaining({ method: 'PUT' }));
    expect(fetchApiMock).not.toHaveBeenCalledWith('/api/sequences', expect.objectContaining({ method: 'POST' }));
    expect(fetchApiMock).not.toHaveBeenCalledWith('/api/marketing/campaigns', expect.objectContaining({ method: 'POST' }));
  });

  it('configures WhatsApp CRM-field conditions', async () => {
    render(<GenericWhatsAppTriggerMappings campaigns={[]} onSaved={vi.fn()} />);
    await screen.findByRole('option', { name: 'welcome_lead' });

    fireEvent.change(screen.getByRole('combobox', { name: 'Next step type after step 1' }), { target: { value: 'field' } });
    expect(screen.getByText('Check a standard or custom CRM column and send the matching outcome.')).toBeInTheDocument();
    const confirmCondition = screen.getByRole('button', { name: 'Add CRM column condition' });
    expect(screen.getByRole('article', { name: 'WhatsApp selected condition preview' })).toContainElement(confirmCondition);
    expect(confirmCondition).toHaveTextContent('');
    expect(confirmCondition.querySelector('.lucide-check')).toBeInTheDocument();
    fireEvent.click(confirmCondition);

    expect(screen.getByText('CONDITION · CHECK CRM COLUMN')).toBeInTheDocument();
    expect(screen.getByRole('spinbutton', { name: 'Wait duration step 2' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'CRM column step 3' })).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: 'CRM operator step 3' })).toBeInTheDocument();
    const operator = screen.getByRole('combobox', { name: 'CRM operator step 3' });
    expect(within(operator).getAllByRole('option').map(option => option.value)).toEqual(['eq', 'neq']);
    const value = screen.getByRole('button', { name: 'CRM value step 3' });
    fireEvent.click(value);
    expect(screen.getByRole('listbox')).toHaveStyle({ maxHeight: '260px' });
    expect((await screen.findAllByRole('checkbox')).map(option => option.getAttribute('aria-label'))).toEqual(['New', 'Contacted', 'Qualified']);
    fireEvent.click(value);
    expect(screen.getByRole('combobox', { name: 'If matched — send' })).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: 'If not matched — send' })).toBeInTheDocument();

    expect(within(screen.getByRole('combobox', { name: 'Next step type after step 3' })).queryByRole('option', { name: 'Stop sequence' })).not.toBeInTheDocument();
  });

  it('keeps the existing operators and lists values for non-status WhatsApp columns', async () => {
    render(<GenericWhatsAppTriggerMappings campaigns={[]} onSaved={vi.fn()} />);
    const nextStep = await screen.findByRole('combobox', { name: 'Next step type after step 1' });
    fireEvent.change(nextStep, { target: { value: 'field' } });
    expect(screen.getByRole('spinbutton', { name: 'Wait duration step 2' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'CRM column step 3' }));
    expect(screen.getByRole('listbox')).toHaveStyle({ maxHeight: '260px' });
    fireEvent.change(screen.getByRole('textbox', { name: 'Search options' }), { target: { value: 'comp' } });
    fireEvent.click(screen.getByRole('radio', { name: 'Company' }));

    expect(within(screen.getByRole('combobox', { name: 'CRM operator step 3' })).getAllByRole('option').map(option => option.value)).toEqual(['eq', 'neq', 'contains', 'notContains']);
    const value = screen.getByRole('button', { name: 'CRM value step 3' });
    fireEvent.click(value);
    await waitFor(() => expect(screen.getByRole('checkbox', { name: 'Acme' })).toBeInTheDocument());
    fireEvent.change(screen.getByRole('textbox', { name: 'Search options' }), { target: { value: 'ac' } });
    expect(screen.getByRole('checkbox', { name: 'Acme' })).toBeInTheDocument();
    expect(screen.queryByRole('checkbox', { name: 'Globex' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('checkbox', { name: 'Acme' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Search options' }), { target: { value: '' } });
    fireEvent.click(screen.getByRole('checkbox', { name: 'Globex' }));
    expect(value).toHaveTextContent('2 selected');
  });

  it('loads all saved steps when editing an existing WhatsApp sequence', async () => {
    const metadata = {
      eventTrigger: 'contact.status_changed', whatsappTemplateId: 9,
      steps: [
        { type: 'whatsapp', templateId: '9' },
        { type: 'wait', amount: 3, unit: 'hours' },
        { type: 'whatsapp', templateId: '10' },
      ],
    };
    render(<GenericWhatsAppTriggerMappings campaigns={[{ id: 31, sequenceId: 91, channel: 'WHATSAPP', scheduleFilters: JSON.stringify(metadata) }]} editCampaignId={31} onEditLoaded={vi.fn()} onSaved={vi.fn()} />);

    await waitFor(() => expect(screen.getByRole('combobox', { name: 'WhatsApp sequence trigger' })).toHaveValue('contact.status_changed'));
    expect(screen.getByRole('spinbutton', { name: 'Wait duration step 2' })).toHaveValue(3);
    expect(screen.getByRole('combobox', { name: 'WhatsApp template for step 3' })).toHaveValue('10');
  });
});
