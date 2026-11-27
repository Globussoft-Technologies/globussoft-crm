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
import { EmailModal } from '../components/contact/ActionModals';

function renderModal(vertical = 'generic') {
  return render(
    <AuthContext.Provider value={{ tenant: { id: 1, vertical }, user: { userId: 2 } }}>
      <EmailModal
        contact={{ id: 649, name: 'Sanjeev Kumar Gupta', email: 'sanjeevg@gmail.com' }}
        onClose={vi.fn()}
        onDone={vi.fn()}
      />
    </AuthContext.Provider>,
  );
}

beforeEach(() => {
  localStorage.clear();
  fetchApiMock.mockReset();
  notify.error.mockReset();
  notify.success.mockReset();
});

describe('EmailModal', () => {
  it('hides the Generic email template list until Use email template is checked', async () => {
    const template = { id: 31, name: 'Welcome email', subject: 'Welcome {{name}}', body: '<p>Hello {{name}}</p>' };
    fetchApiMock.mockImplementation((url, options) => {
      if (url === '/api/email-templates?fields=summary') return Promise.resolve([template]);
      if (url === '/api/generic/email-provider') {
        return Promise.resolve({ configured: true, source: 'tenant', fromEmail: 'tithibera@globussoft.in', fromName: 'nova' });
      }
      if (url === '/api/email-templates/31') return Promise.resolve(template);
      if (url === '/api/email-templates/preview' && options?.method === 'POST') {
        return Promise.resolve({ subject: 'Welcome Sanjeev Kumar Gupta', body: '<p>Hello Sanjeev Kumar Gupta</p>' });
      }
      return Promise.resolve({});
    });
    renderModal();

    const checkbox = await screen.findByRole('checkbox', { name: 'Use email template' });
    expect(screen.getByLabelText('Cc')).toBeInTheDocument();
    expect(screen.getByLabelText('Bcc')).toBeInTheDocument();
    expect(await screen.findByLabelText('From')).toHaveValue('tithibera@globussoft.in');
    expect(screen.getByText(/Subject/)).toHaveTextContent('*');
    expect(screen.getByText(/Body/)).toHaveTextContent('*');
    expect(screen.queryByRole('combobox', { name: 'Select email template' })).not.toBeInTheDocument();

    fireEvent.click(checkbox);
    const selector = screen.getByRole('combobox', { name: 'Select email template' });
    expect(screen.getByRole('option', { name: 'Welcome email' })).toBeInTheDocument();

    fireEvent.change(selector, { target: { value: '31' } });
    await waitFor(() => expect(screen.getByLabelText('Subject')).toHaveValue('Welcome Sanjeev Kumar Gupta'));
    expect(screen.getByRole('textbox', { name: 'Email body' })).toContainHTML('<p>Hello Sanjeev Kumar Gupta</p>');

    fireEvent.click(checkbox);
    expect(screen.queryByRole('combobox', { name: 'Select email template' })).not.toBeInTheDocument();
  });

  it('does not expose or load Generic email templates for other verticals', () => {
    renderModal('wellness');

    expect(screen.queryByRole('checkbox', { name: 'Use email template' })).not.toBeInTheDocument();
    expect(screen.queryByRole('combobox', { name: 'Select email template' })).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Cc')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Bcc')).not.toBeInTheDocument();
    expect(screen.queryByText('Subject')).not.toBeInTheDocument();
    expect(screen.queryByText('Body')).not.toBeInTheDocument();
    expect(fetchApiMock).not.toHaveBeenCalledWith('/api/email-templates?fields=summary', expect.anything());
    expect(fetchApiMock).not.toHaveBeenCalledWith('/api/generic/email-provider', expect.anything());
  });
});
