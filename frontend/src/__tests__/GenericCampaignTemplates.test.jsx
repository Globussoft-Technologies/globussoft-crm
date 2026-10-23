import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act, within } from '@testing-library/react';

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
  localStorage.clear();
  window.history.pushState({}, '', '/marketing');
  fetchApiMock.mockReset();
  notifyObj.error.mockReset();
  notifyObj.info.mockReset();
  notifyObj.success.mockReset();
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
  it('reorders Generic CRM template cards and persists the new position', async () => {
    fetchApiMock.mockImplementation((url, options = {}) => {
      if (String(url).startsWith('/api/email-templates?paginate=1')) {
        return Promise.resolve({
          items: [
            { id: 1, name: 'First template', subject: 'First', body: 'First body', channel: 'EMAIL', category: 'General' },
            { id: 2, name: 'Second template', subject: 'Second', body: 'Second body', channel: 'EMAIL', category: 'General' },
          ],
          pagination: { page: 1, pageSize: 10, total: 2, totalPages: 1 },
        });
      }
      if (url === '/api/email-templates/reorder' && options.method === 'PUT') return Promise.resolve({ success: true });
      if (url === '/api/email-templates/personalization-fields') return Promise.resolve({ fields: [] });
      if (String(url).startsWith('/api/contacts')) return Promise.resolve({ data: [] });
      return Promise.resolve([]);
    });

    render(<GenericCampaignTemplates />);
    fireEvent.click(await screen.findByRole('button', { name: 'Move template First template later' }));

    await waitFor(() => expect(fetchApiMock).toHaveBeenCalledWith('/api/email-templates/reorder', {
      method: 'PUT',
      body: JSON.stringify({ channel: 'EMAIL', orderedIds: [2, 1] }),
    }));
    expect(screen.getByRole('button', { name: 'Drag template First template to reorder' })).toBeInTheDocument();
    expect(notifyObj.success).toHaveBeenCalledWith('Template order saved');
  });

  it.each(['EMAIL', 'SMS'])('opens a rendered %s preview from the document icon', async (channel) => {
    window.history.pushState({}, '', `/marketing?tab=templates&templateChannel=${channel}`);
    fetchApiMock.mockImplementation((url, options = {}) => {
      if (String(url).startsWith('/api/email-templates?paginate=1')) {
        return Promise.resolve({
          items: [{ id: 71, name: `${channel} welcome`, subject: 'Hello {{contact.first_name}}', body: 'Welcome {{contact.name}}', channel }],
          pagination: { page: 1, pageSize: 10, total: 1, totalPages: 1 },
        });
      }
      if (url === '/api/email-templates/preview' && options.method === 'POST') {
        return Promise.resolve({ subject: 'Hello Rahul', body: '<p>Welcome Rahul Sharma</p>', isSample: true });
      }
      if (url === '/api/email-templates/personalization-fields') return Promise.resolve({ fields: [] });
      if (String(url).startsWith('/api/contacts')) return Promise.resolve({ data: [] });
      return Promise.resolve([]);
    });

    render(<GenericCampaignTemplates />);
    fireEvent.click(await screen.findByRole('button', { name: `Preview ${channel} welcome` }));

    await waitFor(() => expect(fetchApiMock).toHaveBeenCalledWith('/api/email-templates/preview', expect.objectContaining({ method: 'POST' })));
    const dialog = await screen.findByRole('dialog', { name: `Preview ${channel === 'SMS' ? 'SMS' : 'Email'} template` });
    expect(dialog).toHaveTextContent('Hello Rahul');
    expect(within(dialog).getByTitle('Rendered template preview')).toHaveAttribute('srcdoc', '<p>Welcome Rahul Sharma</p>');
  });

  it('uses the shared contact preview for WhatsApp and constrains the contact list height', async () => {
    window.history.pushState({}, '', '/marketing?tab=templates&templateChannel=WHATSAPP');
    const contacts = Array.from({ length: 30 }, (_, index) => ({ id: index + 1, name: `Contact ${index + 1}`, email: `contact${index + 1}@example.com` }));
    fetchApiMock.mockImplementation((url, options = {}) => {
      if (String(url).startsWith('/api/email-templates?paginate=1')) return Promise.resolve({ items: [], pagination: { totalPages: 1 } });
      if (url === '/api/whatsapp/templates' && !options.method) return Promise.resolve([{ id: 81, name: 'contact_notice', body: 'Hi {{1}}, your appointment is tomorrow.', category: 'UTILITY', language: 'en_US', status: 'APPROVED', variableMapping: { 1: 'contact.first_name' } }]);
      if (url === '/api/email-templates/preview' && options.method === 'POST') {
        const payload = JSON.parse(options.body);
        return Promise.resolve({ subject: '', body: payload.contactId ? `Hi Contact ${payload.contactId}, your appointment is tomorrow.` : 'Hi Rahul, your appointment is tomorrow.' });
      }
      if (url === '/api/email-templates/personalization-fields') return Promise.resolve({ fields: [] });
      if (String(url).startsWith('/api/contacts')) return Promise.resolve({ data: contacts });
      return Promise.resolve([]);
    });

    render(<GenericCampaignTemplates />);
    fireEvent.click(await screen.findByRole('button', { name: 'Preview contact_notice' }));

    const dialog = await screen.findByRole('dialog', { name: 'Preview WhatsApp template' });
    expect(within(dialog).getByTitle('Rendered template preview')).toHaveAttribute('srcdoc', expect.stringContaining('Hi Contact 1, your appointment is tomorrow.'));
    const previewRequest = fetchApiMock.mock.calls.find(([url, options]) => url === '/api/email-templates/preview' && options?.method === 'POST');
    expect(JSON.parse(previewRequest[1].body).body).toContain('{{contact.first_name}}');

    fireEvent.click(within(dialog).getByRole('combobox', { name: 'Preview contact' }));
    const list = within(dialog).getByRole('listbox', { name: 'Preview contacts' });
    expect(list).toHaveStyle({ maxHeight: '220px', overflowY: 'auto' });
    const contactSearch = within(dialog).getByRole('searchbox', { name: 'Search preview contacts' });
    fireEvent.change(contactSearch, { target: { value: 'contact9@example.com' } });
    expect(within(list).getByRole('option', { name: 'Contact 9 — contact9@example.com' })).toBeInTheDocument();
    expect(within(list).queryByRole('option', { name: 'Contact 8 — contact8@example.com' })).not.toBeInTheDocument();
    fireEvent.click(within(list).getByRole('option', { name: 'Contact 9 — contact9@example.com' }));
    await waitFor(() => expect(within(dialog).getByTitle('Rendered template preview')).toHaveAttribute('srcdoc', expect.stringContaining('Hi Contact 9, your appointment is tomorrow.')));
  });

  it.each([
    ['EMAIL', 'Email body'],
    ['SMS', 'Email body'],
    ['WHATSAPP', 'WhatsApp message'],
  ])('restores an unsaved %s template after leaving the page', async (channel, bodyLabel) => {
    window.history.pushState({}, '', `/marketing?tab=templates&templateChannel=${channel}`);
    const firstRender = render(<GenericCampaignTemplates />);
    fireEvent.click(await screen.findByRole('button', { name: 'Create New Template' }));
    fireEvent.change(screen.getByLabelText('Template Name'), { target: { value: `${channel.toLowerCase()} draft` } });
    if (channel !== 'WHATSAPP') {
      fireEvent.change(screen.getByLabelText('Subject'), { target: { value: `${channel} subject` } });
    }
    const firstBody = screen.getByRole('textbox', { name: bodyLabel });
    firstBody.textContent = `${channel} message in progress`;
    fireEvent.input(firstBody);

    firstRender.unmount();
    render(<GenericCampaignTemplates />);
    fireEvent.click(await screen.findByRole('button', { name: 'Create New Template' }));

    expect(screen.getByLabelText('Template Name')).toHaveValue(`${channel.toLowerCase()} draft`);
    expect(screen.getByRole('textbox', { name: bodyLabel })).toHaveTextContent(`${channel} message in progress`);
    if (channel !== 'WHATSAPP') expect(screen.getByLabelText('Subject')).toHaveValue(`${channel} subject`);
  });

  it('clears the saved draft and resets the new-template form', async () => {
    render(<GenericCampaignTemplates />);
    fireEvent.click(await screen.findByRole('button', { name: 'Create New Template' }));
    fireEvent.change(screen.getByLabelText('Template Name'), { target: { value: 'Temporary draft' } });
    fireEvent.change(screen.getByLabelText('Subject'), { target: { value: 'Temporary subject' } });
    const body = screen.getByRole('textbox', { name: 'Email body' });
    body.textContent = 'Temporary body';
    fireEvent.input(body);

    fireEvent.click(screen.getByRole('button', { name: 'Clear draft' }));

    expect(screen.getByLabelText('Template Name')).toHaveValue('');
    expect(screen.getByLabelText('Subject')).toHaveValue('');
    expect(screen.getByRole('textbox', { name: 'Email body' })).toHaveTextContent('');
    expect(notifyObj.success).toHaveBeenCalledWith('Template draft cleared');

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    fireEvent.click(screen.getByRole('button', { name: 'Create New Template' }));
    expect(screen.getByLabelText('Template Name')).toHaveValue('');
  });

  it('offers an All filter and shows CRM and Meta WhatsApp templates together', async () => {
    fetchApiMock.mockImplementation((url) => {
      if (url === '/api/email-templates?paginate=1&page=1&limit=10') {
        return Promise.resolve({
          items: [
            { id: 1, name: 'Email welcome', subject: 'Welcome', channel: 'EMAIL' },
            { id: 2, name: 'SMS reminder', subject: 'Reminder', channel: 'SMS' },
          ],
          pagination: { page: 1, pageSize: 10, total: 2, totalPages: 1 },
        });
      }
      if (String(url).startsWith('/api/email-templates?paginate=1')) {
        return Promise.resolve({ items: [], pagination: { page: 1, pageSize: 10, total: 0, totalPages: 1 } });
      }
      if (url === '/api/whatsapp/templates') {
        return Promise.resolve([{ id: 3, name: 'meta_notice', body: 'Meta message', category: 'UTILITY', language: 'en_US', status: 'APPROVED' }]);
      }
      if (url === '/api/email-templates/personalization-fields') return Promise.resolve({ fields: [] });
      if (String(url).startsWith('/api/contacts')) return Promise.resolve({ data: [] });
      return Promise.resolve([]);
    });
    render(<GenericCampaignTemplates />);

    const typeFilter = await screen.findByRole('combobox', { name: 'Template type' });
    expect(within(typeFilter).getByRole('option', { name: 'All' })).toBeInTheDocument();
    fireEvent.change(typeFilter, { target: { value: 'ALL' } });

    expect(await screen.findByText('Email welcome')).toBeInTheDocument();
    expect(screen.getByText('SMS reminder')).toBeInTheDocument();
    expect(await screen.findByText('meta_notice')).toBeInTheDocument();
    expect(screen.getByTestId('generic-all-template-grid')).toHaveStyle({ display: 'grid' });
    expect(fetchApiMock).toHaveBeenCalledWith('/api/email-templates?paginate=1&page=1&limit=10');

    fireEvent.click(screen.getByRole('button', { name: 'Create New Template' }));
    expect(screen.getByRole('combobox', { name: 'Template Type' })).toHaveValue('EMAIL');
  });

  it('opens the shared Marketing template editor for WhatsApp and submits new messages to Meta', async () => {
    window.history.pushState({}, '', '/marketing?tab=templates&templateChannel=WHATSAPP');
    fetchApiMock.mockImplementation((url) => {
      if (String(url).startsWith('/api/email-templates?paginate=1')) return Promise.resolve({ items: [], pagination: { totalPages: 1 } });
      if (url === '/api/whatsapp/templates') return Promise.resolve([]);
      return Promise.resolve({ fields: [] });
    });
    render(<GenericCampaignTemplates />);
    const channelSelect = await screen.findByRole('combobox', { name: 'Template type' });
    const createButton = screen.getByRole('button', { name: 'Create New Template' });
    expect(channelSelect.parentElement?.parentElement).toContainElement(createButton);
    fireEvent.click(await screen.findByRole('button', { name: 'Create New Template' }));
    expect(await screen.findByRole('dialog', { name: 'Create campaign template' })).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Template Name'), { target: { value: 'generic_custom_notice' } });
    const body = screen.getByRole('textbox', { name: 'WhatsApp message' });
    body.textContent = 'Hello, thanks for getting in touch.';
    fireEvent.input(body);
    expect(screen.getByRole('combobox', { name: 'Template Type' })).toHaveValue('WHATSAPP');
    fireEvent.click(screen.getByRole('button', { name: 'Save Template' }));

    await waitFor(() => expect(fetchApiMock).toHaveBeenCalledWith('/api/whatsapp/templates', expect.objectContaining({ method: 'POST' })));
    const request = fetchApiMock.mock.calls.find(([url, options]) => url === '/api/whatsapp/templates' && options?.method === 'POST');
    expect(JSON.parse(request[1].body)).toMatchObject({ name: 'generic_custom_notice', body: 'Hello, thanks for getting in touch.', variableMapping: {} });
    window.history.pushState({}, '', '/marketing');
  });

  it('suggests a Meta-compatible WhatsApp name while the operator types', async () => {
    window.history.pushState({}, '', '/marketing?tab=templates&templateChannel=WHATSAPP');
    fetchApiMock.mockImplementation((url) => {
      if (String(url).startsWith('/api/email-templates?paginate=1')) return Promise.resolve({ items: [], pagination: { totalPages: 1 } });
      if (url === '/api/whatsapp/templates') return Promise.resolve([]);
      return Promise.resolve({ fields: [] });
    });
    render(<GenericCampaignTemplates />);
    fireEvent.click(await screen.findByRole('button', { name: 'Create New Template' }));

    fireEvent.change(screen.getByLabelText('Template Name'), { target: { value: 'Pickup Plot-Selection' } });
    const suggestion = screen.getByRole('button', { name: 'Use pickup_plot_selection' });
    expect(suggestion).toBeInTheDocument();
    fireEvent.click(suggestion);

    expect(screen.getByLabelText('Template Name')).toHaveValue('pickup_plot_selection');
    expect(screen.getByRole('status')).toHaveTextContent('Meta-compatible template name');
    window.history.pushState({}, '', '/marketing');
  });

  it('offers a one-click pickup/plot link field in the WhatsApp editor', async () => {
    window.history.pushState({}, '', '/marketing?tab=templates&templateChannel=WHATSAPP');
    fetchApiMock.mockImplementation((url) => {
      if (String(url).startsWith('/api/email-templates?paginate=1')) return Promise.resolve({ items: [], pagination: { totalPages: 1 } });
      if (url === '/api/whatsapp/templates') return Promise.resolve([]);
      return Promise.resolve({ fields: [] });
    });
    render(<GenericCampaignTemplates />);
    fireEvent.click(await screen.findByRole('button', { name: 'Create New Template' }));

    const addLink = screen.getByRole('button', { name: 'Add Pickup / Plot Selection Link' });
    fireEvent.click(addLink);

    expect(screen.getByRole('button', { name: 'Pickup/plot link added' })).toBeDisabled();
    expect(screen.getByText(/Pickup \/ Plot Selection Link is included as/)).toHaveTextContent('{{1}}');
    expect(screen.getByRole('textbox', { name: 'WhatsApp message' })).toHaveTextContent('Pickup / plot link');
    window.history.pushState({}, '', '/marketing');
  });

  it('reuses a manually entered WhatsApp placeholder for the pickup/plot link', async () => {
    window.history.pushState({}, '', '/marketing?tab=templates&templateChannel=WHATSAPP');
    fetchApiMock.mockImplementation((url, options = {}) => {
      if (String(url).startsWith('/api/email-templates?paginate=1')) return Promise.resolve({ items: [], pagination: { totalPages: 1 } });
      if (url === '/api/whatsapp/templates' && !options.method) return Promise.resolve([]);
      if (url === '/api/whatsapp/templates' && options.method === 'POST') return Promise.resolve({ id: 81 });
      return Promise.resolve({ fields: [] });
    });
    render(<GenericCampaignTemplates />);
    fireEvent.click(await screen.findByRole('button', { name: 'Create New Template' }));
    fireEvent.change(screen.getByLabelText('Template Name'), { target: { value: 'pickup_plot_selection' } });

    const body = screen.getByRole('textbox', { name: 'WhatsApp message' });
    body.textContent = 'Hi {{1}}, your plot-selection request is ready.\n\nReply to this message to view the available plots, or use this link: {{2}}.\n\nThank you.';
    fireEvent.input(body);
    fireEvent.click(screen.getByRole('button', { name: 'Add Pickup / Plot Selection Link' }));

    expect(screen.getByText(/Pickup \/ Plot Selection Link is included as/)).toHaveTextContent('{{2}}');
    expect(body).toHaveTextContent('Pickup / plot link');
    expect(body.textContent.match(/Pickup \/ plot link/g)).toHaveLength(1);
    expect(body).toHaveTextContent('Thank you.');

    fireEvent.click(screen.getByRole('button', { name: 'Save Template' }));
    await waitFor(() => expect(fetchApiMock).toHaveBeenCalledWith('/api/whatsapp/templates', expect.objectContaining({ method: 'POST' })));
    const request = fetchApiMock.mock.calls.find(([url, options]) => url === '/api/whatsapp/templates' && options?.method === 'POST');
    expect(JSON.parse(request[1].body)).toMatchObject({
      name: 'pickup_plot_selection',
      variableMapping: { 1: 'contact.first_name', 2: 'system.pickupPlotLink' },
    });
    window.history.pushState({}, '', '/marketing');
  });

  it('writes a WhatsApp pickup/plot draft with AI and preserves Meta variable mappings', async () => {
    window.history.pushState({}, '', '/marketing?tab=templates&templateChannel=WHATSAPP');
    fetchApiMock.mockImplementation((url, options = {}) => {
      if (String(url).startsWith('/api/email-templates?paginate=1')) return Promise.resolve({ items: [], pagination: { totalPages: 1 } });
      if (url === '/api/whatsapp/templates' && !options.method) return Promise.resolve([]);
      if (url === '/api/email-templates/ai-draft') return Promise.resolve({
        body: 'Hi {{contact.first_name}}, reply to choose a plot or use {{system.pickupPlotLink}}. Thank you.',
      });
      if (url === '/api/whatsapp/templates' && options.method === 'POST') return Promise.resolve({ id: 80 });
      return Promise.resolve({ fields: [] });
    });
    render(<GenericCampaignTemplates />);
    fireEvent.click(await screen.findByRole('button', { name: 'Create New Template' }));
    fireEvent.change(screen.getByLabelText('Template Name'), { target: { value: 'pickup_plot_selection' } });
    fireEvent.click(screen.getByRole('button', { name: 'Write with AI' }));

    await waitFor(() => expect(fetchApiMock).toHaveBeenCalledWith('/api/email-templates/ai-draft', expect.objectContaining({
      method: 'POST',
      body: expect.stringContaining('"channel":"WHATSAPP"'),
    })));
    await waitFor(() => expect(screen.getByRole('textbox', { name: 'WhatsApp message' })).toHaveTextContent('First Name'));
    expect(screen.getByRole('textbox', { name: 'WhatsApp message' })).toHaveTextContent('Pickup / plot link');
    expect(notifyObj.success).toHaveBeenCalledWith('AI draft added to the WhatsApp message');

    fireEvent.click(screen.getByRole('button', { name: 'Save Template' }));
    await waitFor(() => expect(fetchApiMock).toHaveBeenCalledWith('/api/whatsapp/templates', expect.objectContaining({ method: 'POST' })));
    const request = fetchApiMock.mock.calls.find(([url, options]) => url === '/api/whatsapp/templates' && options?.method === 'POST');
    expect(JSON.parse(request[1].body)).toMatchObject({
      name: 'pickup_plot_selection',
      variableMapping: { 1: 'contact.first_name', 2: 'system.pickupPlotLink' },
    });
    window.history.pushState({}, '', '/marketing');
  });

  it('explains how to correct a WhatsApp message that ends with personalization', async () => {
    window.history.pushState({}, '', '/marketing?tab=templates&templateChannel=WHATSAPP');
    fetchApiMock.mockImplementation((url) => {
      if (String(url).startsWith('/api/email-templates?paginate=1')) return Promise.resolve({ items: [], pagination: { totalPages: 1 } });
      if (url === '/api/whatsapp/templates') return Promise.resolve([]);
      return Promise.resolve({ fields: [] });
    });
    render(<GenericCampaignTemplates />);
    fireEvent.click(await screen.findByRole('button', { name: 'Create New Template' }));
    fireEvent.change(screen.getByLabelText('Template Name'), { target: { value: 'personalized_notice' } });
    const body = screen.getByRole('textbox', { name: 'WhatsApp message' });
    body.textContent = 'Hi {{1}}';
    fireEvent.input(body);

    fireEvent.click(screen.getByRole('button', { name: 'Save Template' }));

    expect(notifyObj.error).toHaveBeenCalledWith(expect.stringContaining('Example: Hi [Contact Name], thank you for contacting NovaCrest.'));
    expect(fetchApiMock).not.toHaveBeenCalledWith('/api/whatsapp/templates', expect.objectContaining({ method: 'POST' }));
    window.history.pushState({}, '', '/marketing');
  });

  it('recovers the field mapping for legacy numeric WhatsApp placeholders', async () => {
    window.history.pushState({}, '', '/marketing?tab=templates&templateChannel=WHATSAPP');
    fetchApiMock.mockImplementation((url, options = {}) => {
      if (String(url).startsWith('/api/email-templates?paginate=1')) return Promise.resolve({ items: [], pagination: { totalPages: 1 } });
      if (url === '/api/whatsapp/templates' && !options.method) return Promise.resolve([{
        id: 41,
        name: 'new_lead',
        body: 'Hi {{1}}, thank you for contacting us.',
        category: 'UTILITY',
        language: 'en_US',
        status: 'APPROVED',
        variableMapping: null,
      }]);
      return Promise.resolve({ fields: [] });
    });

    render(<GenericCampaignTemplates />);
    const templateName = await screen.findByText('new_lead');
    fireEvent.click(within(templateName.closest('article')).getByRole('button', { name: 'Edit' }));
    const message = await screen.findByRole('textbox', { name: 'WhatsApp message' });
    await waitFor(() => expect(message).toHaveTextContent('[First Name]'));
    fireEvent.click(screen.getByRole('button', { name: 'Save Template' }));

    await waitFor(() => expect(fetchApiMock).toHaveBeenCalledWith('/api/whatsapp/templates/41', expect.objectContaining({ method: 'PUT' })));
    const update = fetchApiMock.mock.calls.find(([url, options]) => url === '/api/whatsapp/templates/41' && options?.method === 'PUT');
    expect(JSON.parse(update[1].body)).toMatchObject({
      body: 'Hi {{1}}, thank you for contacting us.',
      variableMapping: { 1: 'contact.first_name' },
    });
    expect(notifyObj.error).not.toHaveBeenCalledWith(expect.stringMatching(/Personalization panel/));
  });

  it('syncs WhatsApp templates from Meta and refreshes their approval status', async () => {
    window.history.pushState({}, '', '/marketing?tab=templates&templateChannel=WHATSAPP');
    let templateReads = 0;
    fetchApiMock.mockImplementation((url, options = {}) => {
      if (String(url).startsWith('/api/email-templates?paginate=1')) return Promise.resolve({ items: [], pagination: { totalPages: 1 } });
      if (url === '/api/whatsapp/templates/sync' && options.method === 'POST') return Promise.resolve({ success: true, synced: 1, total: 1 });
      if (url === '/api/whatsapp/templates' && !options.method) {
        templateReads += 1;
        return Promise.resolve([{ id: 44, name: 'payment_received', body: 'Thank you', category: 'UTILITY', language: 'en_US', status: templateReads > 1 ? 'APPROVED' : 'PENDING' }]);
      }
      if (String(url).startsWith('/api/contacts')) return Promise.resolve({ data: [] });
      return Promise.resolve({ fields: [] });
    });

    render(<GenericCampaignTemplates />);
    expect(await screen.findByLabelText('Meta approval status: Pending')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Sync from Meta' }));

    await waitFor(() => expect(fetchApiMock).toHaveBeenCalledWith('/api/whatsapp/templates/sync', {
      method: 'POST',
      body: JSON.stringify({}),
    }));
    expect(await screen.findByLabelText('Meta approval status: Approved')).toBeInTheDocument();
    expect(notifyObj.info).toHaveBeenCalledWith('Synced 1 WhatsApp template from Meta');
  });

  it('syncs and reuses a Meta template when the selected default already exists', async () => {
    window.history.pushState({}, '', '/marketing?tab=templates&templateChannel=WHATSAPP');
    const duplicate = Object.assign(new Error('Content in this language already exists: There is already English (US) content for this template.'), {
      code: 'META_REJECTED',
      serverMessage: 'Content in this language already exists: There is already English (US) content for this template.',
    });
    fetchApiMock.mockImplementation((url, options = {}) => {
      if (String(url).startsWith('/api/email-templates?paginate=1')) return Promise.resolve({ items: [], pagination: { totalPages: 1 } });
      if (url === '/api/whatsapp/templates' && options.method === 'POST') return Promise.reject(duplicate);
      if (url === '/api/whatsapp/templates/sync' && options.method === 'POST') return Promise.resolve({ success: true, synced: 1, total: 1 });
      if (url === '/api/whatsapp/templates' && !options.method) return Promise.resolve([]);
      if (String(url).startsWith('/api/contacts')) return Promise.resolve({ data: [] });
      return Promise.resolve({ fields: [] });
    });

    render(<GenericCampaignTemplates />);
    const defaultTitle = await screen.findByText(/New lead .* welcome & pickup\/plot/i);
    fireEvent.click(within(defaultTitle.closest('article')).getByRole('button', { name: 'Edit' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Save Template' }));

    await waitFor(() => expect(fetchApiMock).toHaveBeenCalledWith('/api/whatsapp/templates/sync', {
      method: 'POST',
      body: JSON.stringify({}),
      silent: true,
    }));
    expect(fetchApiMock).toHaveBeenCalledWith('/api/whatsapp/templates', expect.objectContaining({
      method: 'POST',
      silent: true,
    }));
    expect(screen.queryByRole('dialog', { name: 'Create campaign template' })).not.toBeInTheDocument();
    expect(notifyObj.success).toHaveBeenCalledWith('This template already existed in Meta, so the Meta version was synced into CRM');
    expect(notifyObj.error).not.toHaveBeenCalled();
  });

  it('shows a load error instead of an empty state and retries the template request', async () => {
    fetchApiMock.mockImplementation((url) => {
      if (String(url).startsWith('/api/email-templates?paginate=1')) {
        return Promise.reject(new Error('Failed to fetch email templates'));
      }
      if (String(url).startsWith('/api/contacts')) return Promise.resolve({ data: [] });
      return Promise.resolve({ fields: [] });
    });
    render(<GenericCampaignTemplates />);

    expect(await screen.findByRole('alert')).toHaveTextContent('Templates could not be loaded');
    expect(screen.queryByText('No templates yet')).not.toBeInTheDocument();

    fetchApiMock.mockImplementation((url) => {
      if (String(url).startsWith('/api/email-templates?paginate=1')) {
        return Promise.resolve({ items: [{ id: 7, name: 'Welcome', subject: 'Hello' }], pagination: { totalPages: 1 } });
      }
      return Promise.resolve({ fields: [] });
    });
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('Welcome')).toBeInTheDocument();
  });

  it('does not let an old channel response replace the newly selected channel', async () => {
    let resolveEmail;
    fetchApiMock.mockImplementation((url) => {
      if (String(url).includes('paginate=1') && String(url).includes('channel=EMAIL')) return new Promise(resolve => { resolveEmail = resolve; });
      if (String(url).includes('paginate=1')) return Promise.resolve({ items: [{ id: 2, name: 'Latest SMS', subject: 'SMS', channel: 'SMS' }], pagination: { totalPages: 1 } });
      return Promise.resolve([]);
    });
    render(<GenericCampaignTemplates />);
    fireEvent.change(screen.getByRole('combobox', { name: 'Template type' }), { target: { value: 'SMS' } });
    expect(await screen.findByText('Latest SMS')).toBeInTheDocument();
    await act(async () => resolveEmail({ items: [{ id: 1, name: 'Stale Email', subject: 'Email' }], pagination: { totalPages: 5 } }));
    expect(screen.queryByText('Stale Email')).not.toBeInTheDocument();
    expect(screen.getByText('Latest SMS')).toBeInTheDocument();
  });
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

  it('marks required template fields with an asterisk without changing their accessible labels', async () => {
    render(<GenericCampaignTemplates />);
    fireEvent.click(await screen.findByRole('button', { name: /create new template/i }));

    expect(screen.getByLabelText('Template Name').closest('label')).toHaveTextContent('Template Name *');
    expect(screen.getByRole('combobox', { name: 'Template Type' }).closest('label')).toHaveTextContent('Template Type *');
    expect(screen.getByLabelText('Subject').closest('label')).toHaveTextContent('Subject *');
    expect(screen.getByText('Message', { selector: 'div' })).toHaveTextContent('Message *');
    expect(screen.getByLabelText('Category').closest('label')).not.toHaveTextContent('*');
  });

  it('reports exactly which required Generic CRM email fields are missing', async () => {
    render(<GenericCampaignTemplates />);
    fireEvent.click(await screen.findByRole('button', { name: /create new template/i }));

    fireEvent.click(screen.getByRole('button', { name: 'Save Template' }));
    expect(notifyObj.error).toHaveBeenLastCalledWith('Template name, Subject, and Message are required');

    fireEvent.change(screen.getByLabelText('Template Name'), { target: { value: 'Welcome lead' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save Template' }));
    expect(notifyObj.error).toHaveBeenLastCalledWith('Subject and Message are required');

    fireEvent.change(screen.getByLabelText('Subject'), { target: { value: 'Welcome' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save Template' }));
    expect(notifyObj.error).toHaveBeenLastCalledWith('Message is required');
    expect(fetchApiMock.mock.calls.some(([, options]) => options?.method === 'POST')).toBe(false);
  });

  it('reports only the missing WhatsApp template fields', async () => {
    window.history.pushState({}, '', '/marketing?tab=templates&templateChannel=WHATSAPP');
    render(<GenericCampaignTemplates />);
    fireEvent.click(await screen.findByRole('button', { name: /create new template/i }));
    fireEvent.change(screen.getByLabelText('Template Name'), { target: { value: 'lead_notice' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save Template' }));

    expect(notifyObj.error).toHaveBeenLastCalledWith('Message is required');
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

  it('does not offer Delete for Generic CRM default email and SMS templates', async () => {
    fetchApiMock.mockImplementation((url) => {
      if (String(url).startsWith('/api/email-templates?paginate=1')) {
        return Promise.resolve({
          items: [
            { id: 1, name: 'New Lead Default', subject: 'Welcome', body: 'Default', channel: 'EMAIL', category: 'System: Generic CRM: New Lead' },
            { id: 2, name: 'Custom Email', subject: 'Custom', body: 'Custom', channel: 'EMAIL', category: 'General' },
          ],
          pagination: { page: 1, pageSize: 10, total: 2, totalPages: 1 },
        });
      }
      if (String(url).startsWith('/api/contacts')) return Promise.resolve({ data: [] });
      return Promise.resolve({ fields: [] });
    });

    render(<GenericCampaignTemplates />);

    const defaultCard = (await screen.findByText('New Lead Default')).closest('.card');
    const customCard = screen.getByText('Custom Email').closest('.card');
    expect(within(defaultCard).queryByRole('button', { name: 'Delete' })).not.toBeInTheDocument();
    expect(within(customCard).getByRole('button', { name: 'Delete' })).toBeInTheDocument();
  });
});
