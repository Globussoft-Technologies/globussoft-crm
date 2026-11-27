import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

const fetchApiMock = vi.fn();
const notify = { error: vi.fn(), success: vi.fn() };

vi.mock('../utils/api', () => ({
  fetchApi: (...args) => fetchApiMock(...args),
}));

vi.mock('../utils/notify', () => ({
  useNotify: () => notify,
}));

import { AuthContext } from '../appContexts';
import { SmsModal } from '../components/contact/ActionModals';

function renderModal(vertical = 'generic') {
  return render(
    <AuthContext.Provider value={{ tenant: { vertical } }}>
      <SmsModal
        contact={{ id: 649, name: 'Sanjeev Kumar Gupta', company: 'Globussoft', phone: '+201234567890' }}
        onClose={vi.fn()}
        onDone={vi.fn()}
      />
    </AuthContext.Provider>,
  );
}

beforeEach(() => {
  fetchApiMock.mockReset();
  notify.error.mockReset();
  notify.success.mockReset();
});

describe('SmsModal', () => {
  it('uses the isolated Generic contact context and shows the actionable API error once', async () => {
    const error = new Error('Request failed.');
    error.serverMessage = 'The configured SMS provider supports Indian numbers only.';
    fetchApiMock.mockRejectedValue(error);
    renderModal('generic');

    fireEvent.change(screen.getByLabelText('Message'), { target: { value: 'hello' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send SMS' }));

    await waitFor(() => expect(fetchApiMock).toHaveBeenCalledWith('/api/sms/send', {
      method: 'POST',
      body: JSON.stringify({
        to: '+201234567890',
        body: 'hello',
        contactId: 649,
        sendContext: 'generic-contact-profile',
      }),
      silent: true,
    }));
    expect(notify.error).toHaveBeenCalledTimes(1);
    expect(notify.error).toHaveBeenCalledWith('The configured SMS provider supports Indian numbers only.');
  });

  it('does not add the Generic context or silent handling to other verticals', async () => {
    fetchApiMock.mockRejectedValue(new Error('Provider detail'));
    renderModal('wellness');

    fireEvent.change(screen.getByLabelText('Message'), { target: { value: 'hello' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send SMS' }));

    await waitFor(() => expect(fetchApiMock).toHaveBeenCalledWith('/api/sms/send', {
      method: 'POST',
      body: JSON.stringify({ to: '+201234567890', body: 'hello', contactId: 649 }),
    }));
    expect(notify.error).toHaveBeenCalledWith('Failed to send SMS.');
    expect(screen.queryByRole('checkbox', { name: 'Use SMS template' })).not.toBeInTheDocument();
    expect(fetchApiMock).not.toHaveBeenCalledWith('/api/email-templates?channel=SMS', expect.anything());
  });

  it('loads Generic SMS templates dynamically and sends the personalized preview body', async () => {
    const template = { id: 31, name: 'Welcome SMS', channel: 'SMS', body: 'Hi {{name}} from {{company}}' };
    fetchApiMock.mockImplementation((url, options) => {
      if (url === '/api/email-templates?channel=SMS') return Promise.resolve([template]);
      if (url === '/api/email-templates/preview' && options?.method === 'POST') {
        return Promise.resolve({ body: 'Hi Sanjeev Kumar Gupta from Globussoft' });
      }
      if (url === '/api/sms/send' && options?.method === 'POST') return Promise.resolve({ success: true });
      return Promise.resolve({});
    });
    renderModal('generic');

    fireEvent.click(await screen.findByRole('checkbox', { name: 'Use SMS template' }));
    fireEvent.change(screen.getByRole('combobox', { name: 'SMS template' }), { target: { value: '31' } });

    expect(await screen.findByText('Hi Sanjeev Kumar Gupta from Globussoft')).toBeInTheDocument();
    expect(fetchApiMock).toHaveBeenCalledWith('/api/email-templates/preview', {
      method: 'POST',
      silent: true,
      body: JSON.stringify({ subject: '', body: template.body, contactId: 649 }),
    });

    fireEvent.click(screen.getByRole('button', { name: 'Send SMS' }));
    await waitFor(() => expect(fetchApiMock).toHaveBeenCalledWith('/api/sms/send', {
      method: 'POST',
      body: JSON.stringify({
        to: '+201234567890',
        body: 'Hi Sanjeev Kumar Gupta from Globussoft',
        contactId: 649,
        sendContext: 'generic-contact-profile',
      }),
      silent: true,
    }));
    expect(notify.success).toHaveBeenCalledWith('SMS sent.');
  });
});
