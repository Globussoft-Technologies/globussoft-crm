import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';

const fetchApiMock = vi.fn();
const notifySuccess = vi.fn();
const notifyError = vi.fn();
const notifyInfo = vi.fn();
const notifyConfirm = vi.fn(() => Promise.resolve(true));

vi.mock('../utils/api', () => ({ fetchApi: (...args) => fetchApiMock(...args) }));
vi.mock('../utils/notify', () => ({
  useNotify: () => ({ success: notifySuccess, error: notifyError, info: notifyInfo, confirm: notifyConfirm }),
}));

import GenericWhatsAppTemplates from '../components/GenericWhatsAppTemplates';

describe('<GenericWhatsAppTemplates />', () => {
  beforeEach(() => {
    fetchApiMock.mockReset();
    notifySuccess.mockReset();
    notifyError.mockReset();
    notifyInfo.mockReset();
    notifyConfirm.mockReset().mockResolvedValue(true);
    fetchApiMock.mockResolvedValue([]);
  });

  it('shows default messages in Marketing templates and opens them for editing', async () => {
    render(<GenericWhatsAppTemplates />);

    expect(await screen.findByText(/WhatsApp messages need Meta approval/)).toBeInTheDocument();
    expect(screen.queryByText('Default templates ready to submit')).not.toBeInTheDocument();
    expect(screen.queryByText('Submitted WhatsApp templates')).not.toBeInTheDocument();
    expect(screen.getByText('New lead — welcome & pickup/plot')).toBeInTheDocument();
    expect(screen.getByText('Lead details updated')).toBeInTheDocument();
    expect(screen.getByText('Pickup & plot selection request')).toBeInTheDocument();
    fireEvent.click(screen.getAllByRole('button', { name: 'Edit' })[0]);

    expect(screen.getByRole('dialog', { name: 'WhatsApp template editor' })).toBeInTheDocument();
    expect(screen.getByDisplayValue('generic_new_lead_pickup_plot')).toBeInTheDocument();
    expect(screen.getByDisplayValue(/\{\{7\}\}/)).toBeInTheDocument();
    fireEvent.click(screen.getAllByRole('button', { name: 'Edit' })[1]);
    expect(screen.getByDisplayValue('generic_lead_details_updated')).toBeInTheDocument();
    expect(screen.queryByDisplayValue(/\{\{7\}\}/)).not.toBeInTheDocument();
    fireEvent.click(screen.getAllByRole('button', { name: 'Edit' })[2]);
    expect(screen.getByDisplayValue('generic_pickup_plot_request')).toBeInTheDocument();
    expect(screen.getByDisplayValue(/\{\{3\}\}/)).toBeInTheDocument();
  });

  it('submits a default through the WhatsApp template API and reloads its Meta status', async () => {
    fetchApiMock
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce({ id: 5, name: 'generic_new_lead_pickup_plot', status: 'PENDING' })
      .mockResolvedValueOnce([{ id: 5, name: 'generic_new_lead_pickup_plot', body: 'Hi {{1}} {{7}}', status: 'PENDING' }]);
    render(<GenericWhatsAppTemplates />);
    const defaultButtons = await screen.findAllByRole('button', { name: 'Edit' });
    fireEvent.click(defaultButtons[0]);
    fireEvent.click(screen.getByRole('button', { name: 'Save Template' }));

    await waitFor(() => expect(fetchApiMock).toHaveBeenCalledWith('/api/whatsapp/templates', expect.objectContaining({ method: 'POST' })));
    expect(await screen.findByText(/New lead.*welcome.*pickup\/plot/)).toBeInTheDocument();
  });

  it('keeps approval submission in Marketing New Template instead of a separate bulk-submit action', async () => {
    render(<GenericWhatsAppTemplates />);
    expect(await screen.findByRole('button', { name: 'Create New Template' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Submit both defaults/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Create Sequence Copy Template/ })).not.toBeInTheDocument();
  });

  it('shows the latest Meta approval status on every submitted template', async () => {
    fetchApiMock.mockResolvedValueOnce([
      { id: 1, name: 'approved_message', body: 'Approved', category: 'UTILITY', language: 'en_US', status: 'APPROVED' },
      { id: 2, name: 'pending_message', body: 'Pending', category: 'UTILITY', language: 'en_US', status: 'PENDING' },
      { id: 3, name: 'rejected_message', body: 'Rejected', category: 'MARKETING', language: 'en_US', status: 'REJECTED' },
    ]);

    render(<GenericWhatsAppTemplates />);

    expect(await screen.findByLabelText('Meta approval status: Approved')).toBeInTheDocument();
    expect(screen.getByLabelText('Meta approval status: Pending')).toBeInTheDocument();
    expect(screen.getByLabelText('Meta approval status: Rejected')).toBeInTheDocument();
  });

  it('previews a submitted WhatsApp template from the document icon', async () => {
    fetchApiMock.mockResolvedValueOnce([
      { id: 8, name: 'appointment_notice', body: 'Hi {{1}}, your appointment is tomorrow.', footer: 'NovaCrest', category: 'UTILITY', language: 'en_US', status: 'APPROVED', variableMapping: { 1: 'contact.first_name' } },
    ]);

    render(<GenericWhatsAppTemplates />);
    fireEvent.click(await screen.findByRole('button', { name: 'Preview appointment_notice' }));

    const dialog = screen.getByRole('dialog', { name: 'Preview WhatsApp template' });
    expect(dialog).toHaveTextContent('appointment_notice');
    expect(dialog).toHaveTextContent('Hi Rahul, your appointment is tomorrow.');
    expect(dialog).not.toHaveTextContent('{{1}}');
    expect(dialog).toHaveTextContent('NovaCrest');
    expect(dialog).toHaveStyle({ background: 'var(--modal-bg)', opacity: '1' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Close preview' }));
    expect(screen.queryByRole('dialog', { name: 'Preview WhatsApp template' })).not.toBeInTheDocument();
  });

  it('keeps a pending badge compact when its template title wraps', async () => {
    fetchApiMock.mockResolvedValueOnce([
      { id: 7, name: 'a_very_long_whatsapp_template_name_that_wraps', body: 'Message', category: 'UTILITY', language: 'en_US', status: 'PENDING' },
    ]);

    render(<GenericWhatsAppTemplates />);

    const badge = await screen.findByLabelText('Meta approval status: Pending');
    expect(badge).toHaveStyle({ alignSelf: 'flex-start', whiteSpace: 'nowrap', lineHeight: '1.2' });
  });

  it('does not show lead-assignment options on WhatsApp template cards', async () => {
    fetchApiMock.mockResolvedValueOnce([
      { id: 1, name: 'approved_message', body: 'Approved', category: 'UTILITY', language: 'en_US', status: 'APPROVED' },
    ]);

    render(<GenericWhatsAppTemplates />);

    expect(await screen.findByLabelText('Meta approval status: Approved')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Use for new leads/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Use for lead updates/i })).not.toBeInTheDocument();
  });

  it('does not offer Delete for submitted Generic CRM defaults but keeps it for custom templates', async () => {
    fetchApiMock.mockResolvedValueOnce([
      { id: 1, name: 'generic_new_lead_pickup_plot', body: 'Default', category: 'UTILITY', language: 'en_US', status: 'PENDING' },
      { id: 2, name: 'custom_notice', body: 'Custom', category: 'UTILITY', language: 'en_US', status: 'APPROVED' },
    ]);

    render(<GenericWhatsAppTemplates />);

    const defaultCard = (await screen.findByText(/New lead .* welcome & pickup\/plot/i)).closest('article');
    const customCard = screen.getByText('custom_notice').closest('article');
    expect(within(defaultCard).queryByRole('button', { name: 'Delete' })).not.toBeInTheDocument();
    expect(within(customCard).getByRole('button', { name: 'Delete' })).toBeInTheDocument();
  });
});
