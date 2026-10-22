import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import GenericChannelTriggerMappings from '../components/GenericChannelTriggerMappings';

const fetchApiMock = vi.fn();
const notify = { success: vi.fn(), error: vi.fn(), confirm: vi.fn() };
const scrollIntoViewMock = vi.fn();
const scrollToMock = vi.fn();

vi.mock('../utils/api', () => ({ fetchApi: (...args) => fetchApiMock(...args) }));
vi.mock('../utils/notify', () => ({ useNotify: () => notify }));

const channelTemplates = channel => [
  { id: 6, name: 'Welcome', channel, subject: 'Welcome', body: `Welcome by ${channel}` },
  { id: 7, name: 'Follow up', channel, subject: 'Follow up', body: `Follow up by ${channel}` },
  { id: 8, name: 'Thank you', channel, subject: 'Thank you', body: `Thank you by ${channel}` },
];

function arrange(channel, sequenceId = 90, campaignId = 77) {
  const templates = channelTemplates(channel);
  fetchApiMock.mockImplementation((url, options = {}) => {
    if (url === `/api/email-templates?fields=summary&channel=${channel}`) return Promise.resolve(templates);
    if (url === '/api/lead-custom-fields') return Promise.resolve([]);
    if (url === '/api/marketing/generic-condition-metadata') return Promise.resolve({ statusOptions: [{ value: 'Lead', label: 'Lead' }, { value: 'Prospect', label: 'Prospect' }, { value: 'Customer', label: 'Customer' }] });
    if (url === '/api/contacts/filter-values/lifecycleStageKey') return Promise.resolve({ values: [{ value: 'new', label: 'New' }, { value: 'contacted', label: 'Contacted' }, { value: 'qualified', label: 'Qualified' }] });
    if (url === '/api/contacts/filter-values/company') return Promise.resolve({ values: [{ value: 'Acme', label: 'Acme' }, { value: 'Globex', label: 'Globex' }] });
    if (url === '/api/email-templates/preview' && options.method === 'POST') return Promise.resolve({ subject: 'Rendered subject', body: `<p>Rendered ${channel}</p>` });
    if (/^\/api\/email-templates\/\d+$/.test(url)) return Promise.resolve(templates.find(item => String(item.id) === url.split('/').at(-1)));
    if (url === '/api/sequences' && options.method === 'POST') return Promise.resolve({ id: sequenceId });
    if (url === '/api/marketing/campaigns' && options.method === 'POST') return Promise.resolve({ id: campaignId });
    return Promise.resolve([]);
  });
}

beforeEach(() => {
  fetchApiMock.mockReset();
  notify.success.mockReset();
  notify.error.mockReset();
  notify.confirm.mockReset().mockResolvedValue('save');
  scrollIntoViewMock.mockReset();
  scrollToMock.mockReset();
  Element.prototype.scrollIntoView = scrollIntoViewMock;
  Element.prototype.scrollTo = scrollToMock;
});

describe('GenericChannelTriggerMappings', () => {
  it.each(['EMAIL', 'SMS'])('shows one trigger and a first %s send step', async channel => {
    arrange(channel);
    const label = channel === 'SMS' ? 'SMS' : 'Email';
    render(<GenericChannelTriggerMappings channel={channel} campaigns={[]} onSaved={vi.fn()} />);

    expect(await screen.findByRole('heading', { name: `Build a ${label} sequence` })).toBeInTheDocument();
    expect(screen.getByText('WHEN · TRIGGER')).toBeInTheDocument();
    expect(screen.getByText(`STEP 1 · SEND ${channel}`)).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: `${label} sequence trigger` })).toHaveValue('contact.created');
    expect(screen.queryByText('Lead field filters')).not.toBeInTheDocument();
  });

  it.each(['EMAIL', 'SMS'])('previews the selected %s template and opens its template creator', async channel => {
    arrange(channel);
    const label = channel === 'SMS' ? 'SMS' : 'Email';
    render(<GenericChannelTriggerMappings channel={channel} campaigns={[]} onSaved={vi.fn()} />);

    fireEvent.change(await screen.findByRole('combobox', { name: `${label} template for step 1` }), { target: { value: '6' } });
    fireEvent.click(screen.getByRole('button', { name: 'Preview' }));
    const dialog = within(await screen.findByRole('dialog', { name: `Preview ${label} template` }));
    expect(dialog.getByTitle('Rendered sequence template preview')).toHaveAttribute('srcdoc', expect.stringContaining(`Rendered ${channel}`));
    fireEvent.click(dialog.getByRole('button', { name: 'Close' }));

    fireEvent.click(screen.getByRole('button', { name: 'Add template' }));
    const creator = within(await screen.findByRole('dialog', { name: 'Create campaign template' }));
    expect(screen.getByRole('combobox', { name: 'Template Type' })).toHaveValue(channel);
    fireEvent.click(creator.getByRole('button', { name: 'Close' }));
    expect(screen.getByRole('combobox', { name: `${label} template for step 1` })).toHaveValue('6');
  });

  it.each(['EMAIL', 'SMS'])('offers only the seven supported Generic CRM sequence triggers for %s', async channel => {
    arrange(channel);
    const label = channel === 'SMS' ? 'SMS' : 'Email';
    render(<GenericChannelTriggerMappings channel={channel} campaigns={[]} onSaved={vi.fn()} />);
    const trigger = await screen.findByRole('combobox', { name: `${label} sequence trigger` });
    expect(within(trigger).getAllByRole('option').map(option => option.value)).toEqual([
      'contact.created', 'contact.status_changed', 'payment.due', 'pickup_plot.selection_requested',
      'pickup_plot.selected', 'payment.collected', 'plot.confirmed',
    ]);
  });

  it.each(['EMAIL', 'SMS'])('loads the requested trigger-specific presets for %s', async channel => {
    arrange(channel);
    const label = channel === 'SMS' ? 'SMS' : 'Email';
    render(<GenericChannelTriggerMappings channel={channel} campaigns={[]} onSaved={vi.fn()} />);
    const trigger = await screen.findByRole('combobox', { name: `${label} sequence trigger` });

    fireEvent.focus(trigger);
    expect(screen.queryByRole('spinbutton', { name: 'Wait duration step 2' })).not.toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: `${label} template for step 1` })).toBeInTheDocument();
    expect(screen.getByText('Last step · the sequence ends here when saved')).toBeInTheDocument();

    fireEvent.change(trigger, { target: { value: 'contact.status_changed' } });
    expect(screen.getByRole('button', { name: 'CRM column step 1' })).toHaveTextContent('Lead stage');
    expect(screen.getByRole('button', { name: 'CRM column step 1' })).toBeDisabled();
    expect(screen.queryByText('Wait added')).not.toBeInTheDocument();
    expect(screen.queryByRole('spinbutton', { name: 'Wait duration step 2' })).not.toBeInTheDocument();

    fireEvent.change(trigger, { target: { value: 'payment.due' } });
    expect(screen.getByRole('article', { name: 'Payment due timing condition' })).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: `${label} template for step 1` })).toBeInTheDocument();
    expect(screen.queryByRole('spinbutton', { name: 'Wait duration step 2' })).not.toBeInTheDocument();

    fireEvent.change(trigger, { target: { value: 'pickup_plot.selection_requested' } });
    expect(screen.getByRole('combobox', { name: `${label} template for step 1` })).toBeInTheDocument();
    expect(screen.queryByRole('combobox', { name: 'If replied — send' })).not.toBeInTheDocument();

    fireEvent.change(trigger, { target: { value: 'payment.collected' } });
    expect(screen.getByRole('combobox', { name: `${label} template for step 1` })).toBeInTheDocument();
    expect(screen.queryByRole('spinbutton', { name: 'Wait duration step 2' })).not.toBeInTheDocument();
  });

  it.each(['EMAIL', 'SMS'])('shows the exact missing-template error for %s', async channel => {
    arrange(channel);
    const label = channel === 'SMS' ? 'SMS' : 'Email';
    render(<GenericChannelTriggerMappings channel={channel} campaigns={[]} onSaved={vi.fn()} />);
    await screen.findByRole('combobox', { name: `${label} template for step 1` });

    fireEvent.click(screen.getByRole('button', { name: /Save & activate/i }));

    expect(notify.error).toHaveBeenCalledWith(`Select an ${label} template in Step 1.`);
  });

  it.each(['EMAIL', 'SMS'])('reports every incomplete %s step instead of always reporting only Step 1', async channel => {
    arrange(channel);
    const label = channel === 'SMS' ? 'SMS' : 'Email';
    render(<GenericChannelTriggerMappings channel={channel} campaigns={[]} onSaved={vi.fn()} />);
    fireEvent.change(await screen.findByRole('combobox', { name: `${label} sequence trigger` }), { target: { value: 'contact.status_changed' } });
    fireEvent.change(screen.getByRole('combobox', { name: 'Next step type after step 1' }), { target: { value: 'send' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add next step' }));

    fireEvent.click(screen.getByRole('button', { name: /Save & activate/i }));

    expect(notify.error).toHaveBeenCalledWith(
      `Select a Lead stage in Step 1. Select an ${label} template in Step 2.`,
    );
  });

  it.each(['EMAIL', 'SMS'])('numbers the second visible %s message as Step 2 after its automatic wait', async channel => {
    arrange(channel);
    const label = channel === 'SMS' ? 'SMS' : 'Email';
    render(<GenericChannelTriggerMappings channel={channel} campaigns={[]} onSaved={vi.fn()} />);
    fireEvent.change(await screen.findByRole('combobox', { name: `${label} template for step 1` }), { target: { value: '6' } });
    fireEvent.change(screen.getByRole('combobox', { name: 'Next step type after step 1' }), { target: { value: 'send' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add next step' }));

    expect(screen.getByText(`STEP 2 · SEND ${channel}`)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Save & activate/i }));

    expect(notify.error).toHaveBeenCalledWith(`Select an ${label} template in Step 2.`);
  });

  it.each(['EMAIL', 'SMS'])('offers to save an unticked %s step and includes it when confirmed', async channel => {
    arrange(channel);
    const label = channel === 'SMS' ? 'SMS' : 'Email';
    render(<GenericChannelTriggerMappings channel={channel} campaigns={[]} onSaved={vi.fn()} />);
    fireEvent.change(await screen.findByRole('combobox', { name: `${label} template for step 1` }), { target: { value: '6' } });
    fireEvent.change(screen.getByRole('combobox', { name: 'Next step type after step 1' }), { target: { value: 'send' } });
    fireEvent.change(screen.getByRole('combobox', { name: `${label} template for step 3` }), { target: { value: '7' } });

    fireEvent.click(screen.getByRole('button', { name: /Save & activate/i }));

    await waitFor(() => expect(notify.success).toHaveBeenCalled());
    expect(notify.confirm).toHaveBeenCalledWith(expect.objectContaining({
      title: 'Save unfinished step?',
      confirmText: 'Save step',
      cancelText: 'Discard & save',
    }));
    const stepCalls = fetchApiMock.mock.calls.filter(([url, options]) => url === '/api/sequences/90/steps' && options?.method === 'POST');
    expect(stepCalls.map(([, options]) => JSON.parse(options.body).kind)).toEqual([
      channel === 'SMS' ? 'sms' : 'email',
      'wait',
      channel === 'SMS' ? 'sms' : 'email',
    ]);
  });

  it.each(['EMAIL', 'SMS'])('discards an unticked %s step and saves only committed steps when requested', async channel => {
    arrange(channel);
    notify.confirm.mockResolvedValue('discard');
    const label = channel === 'SMS' ? 'SMS' : 'Email';
    render(<GenericChannelTriggerMappings channel={channel} campaigns={[]} onSaved={vi.fn()} />);
    fireEvent.change(await screen.findByRole('combobox', { name: `${label} template for step 1` }), { target: { value: '6' } });
    fireEvent.change(screen.getByRole('combobox', { name: 'Next step type after step 1' }), { target: { value: 'send' } });

    fireEvent.click(screen.getByRole('button', { name: /Save & activate/i }));

    await waitFor(() => expect(notify.success).toHaveBeenCalled());
    const stepCalls = fetchApiMock.mock.calls.filter(([url, options]) => url === '/api/sequences/90/steps' && options?.method === 'POST');
    expect(stepCalls).toHaveLength(1);
  });

  it.each(['EMAIL', 'SMS'])('saves the %s payment-due lead time with one template', async channel => {
    arrange(channel);
    const label = channel === 'SMS' ? 'SMS' : 'Email';
    render(<GenericChannelTriggerMappings channel={channel} campaigns={[]} onSaved={vi.fn()} />);
    fireEvent.change(await screen.findByRole('combobox', { name: `${label} sequence trigger` }), { target: { value: 'payment.due' } });
    fireEvent.change(screen.getByRole('spinbutton', { name: 'Payment due reminder amount' }), { target: { value: '2' } });
    fireEvent.change(screen.getByRole('combobox', { name: 'Payment due reminder unit' }), { target: { value: 'hours' } });
    fireEvent.change(screen.getByRole('combobox', { name: `${label} template for step 1` }), { target: { value: '6' } });
    fireEvent.click(screen.getByRole('button', { name: /Save & activate/i }));

    await waitFor(() => expect(notify.success).toHaveBeenCalled());
    const scheduleCall = fetchApiMock.mock.calls.find(([url]) => url === '/api/marketing/campaigns/77/schedule');
    expect(JSON.parse(scheduleCall[1].body).filters).toMatchObject({
      triggerEvent: 'payment.due',
      dueBefore: { amount: '2', unit: 'hours' },
      steps: [{ type: 'send', templateId: '6' }],
    });
  });

  it.each(['EMAIL', 'SMS'])('configures every next-step dropdown option for %s', async channel => {
    arrange(channel);
    render(<GenericChannelTriggerMappings channel={channel} campaigns={[]} onSaved={vi.fn()} />);
    const nextStep = await screen.findByRole('combobox', { name: 'Next step type after step 1' });
    expect(within(nextStep).getAllByRole('option').map(option => ({ value: option.value, label: option.textContent }))).toEqual([
      { value: '', label: 'Choose next step' },
      { value: 'send', label: `${channel === 'SMS' ? 'SMS' : 'Email'} message` },
      { value: 'reply', label: 'Reply condition' },
      { value: 'field', label: 'CRM column condition' },
    ]);
  });

  it.each(['EMAIL', 'SMS'])('shows a confirmation only after selecting the next %s step type', async channel => {
    arrange(channel);
    render(<GenericChannelTriggerMappings channel={channel} campaigns={[]} onSaved={vi.fn()} />);
    const nextStep = await screen.findByRole('combobox', { name: 'Next step type after step 1' });
    expect(nextStep).toHaveValue('');
    expect(screen.queryByRole('button', { name: 'Add next step' })).not.toBeInTheDocument();

    fireEvent.change(nextStep, { target: { value: 'reply' } });
    expect(screen.getByRole('button', { name: 'Add reply condition' })).toBeInTheDocument();
    fireEvent.change(nextStep, { target: { value: 'field' } });
    expect(screen.getByRole('button', { name: 'Add CRM column condition' })).toBeInTheDocument();
  });

  it.each(['EMAIL', 'SMS'])('automatically links a wait to the following %s template', async channel => {
    arrange(channel);
    const label = channel === 'SMS' ? 'SMS' : 'Email';
    render(<GenericChannelTriggerMappings channel={channel} campaigns={[]} onSaved={vi.fn()} />);
    const nextStep = await screen.findByRole('combobox', { name: 'Next step type after step 1' });

    expect(within(nextStep).queryByRole('option', { name: 'Wait' })).not.toBeInTheDocument();
    fireEvent.change(nextStep, { target: { value: 'send' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add next step' }));

    expect(screen.getByRole('spinbutton', { name: 'Wait duration step 2' })).toHaveValue(1);
    expect(screen.getByRole('combobox', { name: `${label} template for step 3` })).toBeInTheDocument();
    expect(screen.queryByText('Wait added')).not.toBeInTheDocument();
    expect(screen.getByText('Last step · the sequence ends here when saved')).toBeInTheDocument();
  });

  it.each(['EMAIL', 'SMS'])('shows the selected %s immediate-send editor only after selection', async channel => {
    arrange(channel);
    const label = channel === 'SMS' ? 'SMS' : 'Email';
    render(<GenericChannelTriggerMappings channel={channel} campaigns={[]} onSaved={vi.fn()} />);
    const nextStep = await screen.findByRole('combobox', { name: 'Next step type after step 1' });

    fireEvent.focus(nextStep);
    expect(screen.queryByRole('article', { name: `${label} selected condition preview` })).not.toBeInTheDocument();
    fireEvent.change(nextStep, { target: { value: 'send' } });

    const combinedPreview = screen.getByRole('article', { name: `${label} selected condition preview` });
    expect(combinedPreview).toBeInTheDocument();
    const waitDuration = screen.getByRole('spinbutton', { name: 'Wait duration step 2' });
    expect(combinedPreview).toContainElement(waitDuration);
    fireEvent.change(waitDuration, { target: { value: '4' } });
    expect(screen.getByRole('combobox', { name: `${label} template for step 3` })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Add next step' }));
    expect(screen.getByRole('spinbutton', { name: 'Wait duration step 2' })).toHaveValue(4);
    expect(screen.getByRole('combobox', { name: `${label} template for step 3` })).toBeInTheDocument();
  });

  it.each(['EMAIL', 'SMS'])('scrolls to a newly added %s step', async channel => {
    arrange(channel);
    render(<GenericChannelTriggerMappings channel={channel} campaigns={[]} onSaved={vi.fn()} />);
    await screen.findByRole('combobox', { name: 'Next step type after step 1' });

    const nextStep = screen.getByRole('combobox', { name: 'Next step type after step 1' });
    fireEvent.change(nextStep, { target: { value: 'send' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add next step' }));

    const label = channel === 'SMS' ? 'SMS' : 'Email';
    const canvas = screen.getByRole('region', { name: `${label} sequence steps` });
    expect(canvas).toHaveStyle({ overflowY: 'auto', overscrollBehaviorY: 'contain' });
    await waitFor(() => expect(scrollToMock).toHaveBeenCalledWith({ top: canvas.scrollHeight, behavior: 'smooth' }));
    expect(scrollIntoViewMock).not.toHaveBeenCalled();
  });

  it.each(['EMAIL', 'SMS'])('keeps Wait out of dropdowns and offers it on each %s template', async channel => {
    arrange(channel);
    render(<GenericChannelTriggerMappings channel={channel} campaigns={[]} onSaved={vi.fn()} />);
    const firstNextStep = await screen.findByRole('combobox', { name: 'Next step type after step 1' });
    expect(within(firstNextStep).queryByRole('option', { name: 'Wait' })).not.toBeInTheDocument();

    fireEvent.change(firstNextStep, { target: { value: 'send' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add next step' }));

    expect(screen.queryByRole('combobox', { name: 'Next step type after step 2' })).not.toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: 'Next step type after step 3' })).toBeInTheDocument();
  });

  it('persists ordered SMS, wait, and SMS steps in one durable sequence', async () => {
    arrange('SMS');
    const onSaved = vi.fn();
    render(<GenericChannelTriggerMappings channel="SMS" campaigns={[]} onSaved={onSaved} />);
    await screen.findByRole('option', { name: 'Welcome' });

    fireEvent.change(screen.getByRole('combobox', { name: 'SMS template for step 1' }), { target: { value: '6' } });
    const nextStep = screen.getByRole('combobox', { name: 'Next step type after step 1' });
    fireEvent.change(nextStep, { target: { value: 'send' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add next step' }));
    fireEvent.change(screen.getByRole('spinbutton', { name: 'Wait duration step 2' }), { target: { value: '2' } });
    fireEvent.change(screen.getByRole('combobox', { name: 'Wait unit step 2' }), { target: { value: 'hours' } });
    fireEvent.change(screen.getByRole('combobox', { name: 'SMS template for step 3' }), { target: { value: '7' } });
    expect(screen.getByText('STEP 2 · SEND SMS')).toBeInTheDocument();
    const combinedStep = screen.getByRole('article', { name: 'SMS sequence step 3' });
    expect(combinedStep).toContainElement(screen.getByRole('spinbutton', { name: 'Wait duration step 2' }));
    expect(combinedStep).toContainElement(screen.getByRole('combobox', { name: 'SMS template for step 3' }));
    expect(screen.getByLabelText('SMS DND and opt-out check')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Save & activate/i }));

    await waitFor(() => expect(notify.success).toHaveBeenCalledWith('SMS sequence saved and activated'));
    const stepCalls = fetchApiMock.mock.calls.filter(([url, options]) => url === '/api/sequences/90/steps' && options?.method === 'POST');
    expect(stepCalls.map(([, options]) => JSON.parse(options.body))).toMatchObject([
      { position: 0, kind: 'sms', smsBody: 'Welcome by SMS' },
      { position: 1, kind: 'wait', delayMinutes: 120 },
      { position: 2, kind: 'sms', smsBody: 'Follow up by SMS' },
    ]);
    const scheduleCall = fetchApiMock.mock.calls.find(([url]) => url === '/api/marketing/campaigns/77/schedule');
    const savedFilters = JSON.parse(scheduleCall[1].body).filters;
    expect(savedFilters).not.toHaveProperty('conditions');
    expect(savedFilters.steps).toMatchObject([
      { type: 'send', templateId: '6' },
      { type: 'wait', amount: '2', unit: 'hours' },
      { type: 'send', templateId: '7' },
    ]);
    expect(onSaved).toHaveBeenCalled();
  });

  it('persists an Email reply branch and continues to the next step', async () => {
    arrange('EMAIL', 91, 78);
    render(<GenericChannelTriggerMappings channel="EMAIL" campaigns={[]} onSaved={vi.fn()} />);
    await screen.findByRole('option', { name: 'Welcome' });

    fireEvent.change(screen.getByRole('combobox', { name: 'Email template for step 1' }), { target: { value: '6' } });
    fireEvent.change(screen.getByRole('combobox', { name: 'Next step type after step 1' }), { target: { value: 'reply' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add reply condition' }));
    expect(screen.getByRole('spinbutton', { name: 'Wait duration step 2' })).toBeInTheDocument();
    fireEvent.change(screen.getByRole('combobox', { name: 'If replied — send' }), { target: { value: '8' } });
    fireEvent.change(screen.getByRole('combobox', { name: 'If no reply — send' }), { target: { value: '7' } });
    fireEvent.click(screen.getByRole('button', { name: /Save & activate/i }));

    await waitFor(() => expect(notify.success).toHaveBeenCalledWith('Email sequence saved and activated'));
    const conditionCall = fetchApiMock.mock.calls.find(([url, options]) => url === '/api/sequences/91/steps' && options?.method === 'POST' && JSON.parse(options.body).kind === 'condition');
    const condition = JSON.parse(JSON.parse(conditionCall[1].body).conditionJson);
    expect(condition).toMatchObject({
      conditions: [{ type: 'email_activity', event: 'replied' }],
      yesAction: { type: 'send_email', emailTemplateId: 8 },
      noAction: { type: 'send_email', emailTemplateId: 7 },
    });
  });

  it.each(['EMAIL', 'SMS'])('updates an existing %s sequence with the same trigger instead of creating another one', async channel => {
    arrange(channel);
    const baseImplementation = fetchApiMock.getMockImplementation();
    const existing = {
      id: 44,
      sequenceId: 94,
      channel,
      scheduleFilters: JSON.stringify({
        automationType: 'generic_channel_event',
        channel,
        triggerEvent: 'contact.created',
      }),
    };
    fetchApiMock.mockImplementation((url, options = {}) => {
      if (url === `/api/marketing/campaigns?channel=${channel}&sequenceTrigger=contact.created`) {
        return Promise.resolve([existing]);
      }
      return baseImplementation(url, options);
    });

    render(<GenericChannelTriggerMappings channel={channel} campaigns={[]} onSaved={vi.fn()} />);
    const label = channel === 'SMS' ? 'SMS' : 'Email';
    fireEvent.change(await screen.findByRole('combobox', { name: `${label} template for step 1` }), { target: { value: '6' } });
    fireEvent.click(screen.getByRole('button', { name: /Save & activate/i }));

    await waitFor(() => expect(notify.success).toHaveBeenCalledWith(`${label} sequence updated and activated`));
    expect(fetchApiMock).toHaveBeenCalledWith('/api/sequences/94', expect.objectContaining({ method: 'PATCH' }));
    expect(fetchApiMock).toHaveBeenCalledWith('/api/marketing/campaigns/44', expect.objectContaining({ method: 'PUT' }));
    expect(fetchApiMock).not.toHaveBeenCalledWith('/api/sequences', expect.objectContaining({ method: 'POST' }));
    expect(fetchApiMock).not.toHaveBeenCalledWith('/api/marketing/campaigns', expect.objectContaining({ method: 'POST' }));
  });

  it.each(['EMAIL', 'SMS'])('configures CRM-field conditions for %s', async channel => {
    arrange(channel);
    render(<GenericChannelTriggerMappings channel={channel} campaigns={[]} onSaved={vi.fn()} />);
    await screen.findByRole('option', { name: 'Welcome' });

    fireEvent.change(screen.getByRole('combobox', { name: 'Next step type after step 1' }), { target: { value: 'field' } });
    expect(screen.getByText('Check a standard or custom CRM column and send the matching outcome.')).toBeInTheDocument();
    const confirmCondition = screen.getByRole('button', { name: 'Add CRM column condition' });
    expect(screen.getByRole('article', { name: `${channel === 'SMS' ? 'SMS' : 'Email'} selected condition preview` })).toContainElement(confirmCondition);
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

  it.each(['EMAIL', 'SMS'])('keeps the existing operators and lists values for non-status %s columns', async channel => {
    arrange(channel);
    render(<GenericChannelTriggerMappings channel={channel} campaigns={[]} onSaved={vi.fn()} />);
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

  it.each(['EMAIL', 'SMS'])('loads all saved %s steps when editing', async channel => {
    arrange(channel);
    const metadata = {
      automationType: 'generic_channel_event', channel, triggerEvent: 'contact.status_changed', templateId: 6,
      steps: [
        { type: 'send', templateId: '6' },
        { type: 'wait', amount: 3, unit: 'days' },
        { type: 'send', templateId: '7' },
      ],
    };
    const label = channel === 'SMS' ? 'SMS' : 'Email';
    render(<GenericChannelTriggerMappings channel={channel} campaigns={[{ id: 31, sequenceId: 91, channel, scheduleFilters: JSON.stringify(metadata) }]} editCampaignId={31} onEditLoaded={vi.fn()} onSaved={vi.fn()} />);

    await waitFor(() => expect(screen.getByRole('combobox', { name: `${label} sequence trigger` })).toHaveValue('contact.status_changed'));
    expect(screen.getByRole('spinbutton', { name: 'Wait duration step 2' })).toHaveValue(3);
    expect(screen.getByRole('combobox', { name: `${label} template for step 3` })).toHaveValue('7');
  });
});
