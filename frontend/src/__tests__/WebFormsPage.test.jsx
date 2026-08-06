import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, test, vi } from 'vitest';

import { AuthContext } from '../App';
import WebForms from '../pages/WebForms';

const fetchApiMock = vi.fn();
vi.mock('../utils/api', () => ({
  fetchApi: (...args) => fetchApiMock(...args),
}));

const notifyError = vi.fn();
const notifySuccess = vi.fn();
const notifyInfo = vi.fn();
const notifyConfirm = vi.fn(() => Promise.resolve(true));
vi.mock('../utils/notify', () => ({
  useNotify: () => ({
    error: notifyError,
    success: notifySuccess,
    info: notifyInfo,
    confirm: notifyConfirm,
  }),
}));

const FORM_FIXTURE = {
  id: 101,
  name: 'Brand intake',
  slug: 'brand-intake',
  description: 'Capture leads from the widget',
  isActive: true,
  fields: [
    {
      id: 'field-1',
      sourceKind: 'contact',
      sourceKey: 'name',
      fieldType: 'text',
      label: 'Name',
      placeholder: 'Your name',
      helpText: '',
      required: true,
      hidden: false,
      options: [],
      width: 'full',
    },
  ],
  style: {
    fontFamily: 'Inter, system-ui, sans-serif',
    backgroundColor: '#EBEFF3',
    formColor: '#FFFFFF',
    titleColor: '#000000',
    textColor: '#111827',
    fieldLabelColor: '#666666',
    buttonColor: '#12344D',
    accentColor: '#12344D',
    logoUrl: '',
  },
  settings: {
    submitButtonLabel: 'Submit',
    successMessage: 'Thanks',
    afterSubmitAction: 'message',
    redirectUrl: '',
    notificationEnabled: true,
    notificationEmail: 'owner@example.com',
    optInEnabled: true,
    optInText: 'I agree to receive communication on newsletters, promotional content, offers and events.',
    optInLinkText: 'privacy policy',
    optInLinkUrl: 'https://example.com/privacy',
    createDeal: false,
  },
  submissionCount: 3,
};

function installFetchMock(form = FORM_FIXTURE) {
  fetchApiMock.mockImplementation((url, opts) => {
    const method = opts?.method || 'GET';
    if (url === '/api/forms' && method === 'GET') {
      return Promise.resolve([form]);
    }
    if (url === '/api/lead-custom-fields' && method === 'GET') {
      return Promise.resolve([
        { id: 1, fieldKey: 'submit_source', label: 'Submit source', fieldType: 'text', options: null, placeholder: 'contact-us' },
        { id: 2, fieldKey: 'keyword', label: 'Keyword', fieldType: 'text', options: null, placeholder: 'campaign keyword' },
      ]);
    }
    if (url === `/api/forms/${form.id}` && method === 'PUT') {
      const body = JSON.parse(opts?.body || '{}');
      return Promise.resolve({
        ...form,
        ...body,
        fields: Array.isArray(body.fields) ? body.fields : form.fields,
        style: body.style || form.style,
        settings: body.settings || form.settings,
      });
    }
    if (url === `/api/forms/${form.id}` && method === 'DELETE') {
      return Promise.resolve({ success: true });
    }
    if (url === '/api/forms' && method === 'POST') {
      const body = JSON.parse(opts?.body || '{}');
      return Promise.resolve({
        ...form,
        ...body,
        id: 202,
        slug: 'new-widget',
        name: body.name || 'New widget',
        submissionCount: 0,
      });
    }
    return Promise.resolve(null);
  });
}

function renderPage() {
  return render(
    <AuthContext.Provider value={{ user: { userId: 1, role: 'ADMIN' }, tenant: { vertical: 'generic' } }}>
      <WebForms />
    </AuthContext.Provider>,
  );
}

beforeEach(() => {
  fetchApiMock.mockReset();
  notifyError.mockReset();
  notifySuccess.mockReset();
  notifyInfo.mockReset();
  notifyConfirm.mockReset();
  notifyConfirm.mockResolvedValue(true);
  installFetchMock();
});

describe('WebForms builder page', () => {
  test('renders web form builder chrome and opens the embed + preview modals', async () => {
    renderPage();

    await screen.findAllByDisplayValue('Brand intake');
    expect(screen.getByRole('heading', { name: /Web Forms/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /New form/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Get embed code and URL/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Preview form/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Add fields/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Customize text and colors/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Settings/i })).toBeInTheDocument();
    expect(screen.getByText('Logo and form text')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Upload/i })).toBeInTheDocument();
    expect(screen.getByText(/Send email notification to this address/i)).toBeInTheDocument();
    expect(screen.getByText(/Include an opt-in checkbox at the end of the form/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Insert link/i })).toBeInTheDocument();
    expect(screen.queryByText(/Submit button label/i)).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: /Get embed code and URL/i }));
    expect(screen.getAllByDisplayValue(/api\/forms\/public\/brand-intake/).length).toBeGreaterThan(0);
    expect(screen.getAllByDisplayValue(/iframe src=/i).length).toBeGreaterThan(0);

    fireEvent.click(screen.getByRole('button', { name: /Preview form/i }));
    expect(screen.getByTitle('Web form preview')).toBeInTheDocument();
  });

  test('opens contact picker with dynamic fields from Contacts and Leads pages', async () => {
    renderPage();

    await screen.findAllByDisplayValue('Brand intake');
    fireEvent.click(screen.getByRole('button', { name: /Add contact fields/i }));

    await waitFor(() => {
      expect(fetchApiMock).toHaveBeenCalledWith('/api/lead-custom-fields');
    });
    expect(await screen.findByText('Contact fields')).toBeInTheDocument();
    expect(screen.queryByText('Contact and lead custom fields')).toBeNull();
    expect(screen.getByText('Submit source')).toBeInTheDocument();
    expect(screen.getByText('Keyword')).toBeInTheDocument();
  });
  test('supports draft edits and save on the form name field', async () => {
    renderPage();

    await screen.findAllByDisplayValue('Brand intake');
    const [nameField] = await screen.findAllByDisplayValue('Brand intake');
    fireEvent.change(nameField, { target: { value: 'Saved form' } });
    expect(screen.getByText(/Unsaved changes/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /^Save$/ }));

    await waitFor(() => {
      expect(fetchApiMock).toHaveBeenCalledWith(
        '/api/forms/101',
        expect.objectContaining({ method: 'PUT' }),
      );
    });
    expect(notifySuccess).toHaveBeenCalledWith('Form saved');
  });
});
