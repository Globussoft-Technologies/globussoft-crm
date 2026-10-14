import { act, render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { MemoryRouter, useLocation, useNavigate } from 'react-router-dom';

import { beforeEach, describe, expect, test, vi } from 'vitest';



import { AuthContext } from '../App';

import WebForms from '../pages/WebForms';
import { confirmActiveFormExit } from '../utils/formNavigationGuard';



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



function installFetchMock(form = FORM_FIXTURE, leadFields = [
  { id: 1, fieldKey: 'submit_source', label: 'Submit source', fieldType: 'text', options: null, placeholder: 'contact-us' },
  { id: 2, fieldKey: 'keyword', label: 'Keyword', fieldType: 'text', options: null, placeholder: 'campaign keyword' },
]) {

  fetchApiMock.mockImplementation((url, opts) => {

    const method = opts?.method || 'GET';

    if (url === '/api/forms' && method === 'GET') {

      return Promise.resolve([form]);

    }

    if (url === '/api/lead-custom-fields' && method === 'GET') {
      return Promise.resolve(leadFields);

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



function renderPage(form = FORM_FIXTURE, leadFields, authValue = { user: { id: 1, role: 'ADMIN' }, tenant: { id: 14, vertical: 'generic' } }, configureFetch) {

  installFetchMock(form, leadFields);
  configureFetch?.(fetchApiMock.getMockImplementation());

  return render(

    <AuthContext.Provider value={authValue}>

      <WebForms />

    </AuthContext.Provider>,

  );

}

function renderTravelPage(form = FORM_FIXTURE) {
  fetchApiMock.mockImplementation((url, opts) => {
    const method = opts?.method || 'GET';
    if (url === '/api/forms?scope=travel' && method === 'GET') return Promise.resolve([{ ...form, scope: 'travel' }]);
    if (url === '/api/forms/logo-upload?scope=travel' && method === 'POST') {
      return Promise.resolve({ url: 'https://objectstorage.example.com/travel-logo.png', storage: 'ocs' });
    }
    return Promise.resolve(null);
  });
  return render(
    <AuthContext.Provider value={{ user: { id: 1, role: 'ADMIN' }, tenant: { id: 14, vertical: 'travel' } }}>
      <WebForms scope="travel" />
    </AuthContext.Provider>,
  );
}

function NavigationProbe() {
  const location = useLocation();
  const navigate = useNavigate();
  return (
    <>
      <a href="/dashboard">Leave Web Forms</a>
      <button type="button" onClick={() => navigate(-1)}>Browser back</button>
      <button type="button" onClick={() => navigate(1)}>Browser forward</button>
      <span data-testid="navigation-probe-path">{location.pathname}{location.search}</span>
    </>
  );
}

function renderRoutedPage(form = FORM_FIXTURE) {
  installFetchMock(form);
  return render(
    <MemoryRouter initialEntries={['/forms']}>
      <AuthContext.Provider value={{ user: { id: 1, role: 'ADMIN' }, tenant: { id: 14, vertical: 'generic' } }}>
        <WebForms />
        <NavigationProbe />
      </AuthContext.Provider>
    </MemoryRouter>,
  );
}

test('contact notification channel controls are limited to Generic web forms', async () => {
  renderTravelPage();
  await openBuilder();

  fireEvent.click(screen.getByRole('button', { name: /Settings/i }));

  expect(screen.queryByText(/Send an automatic message to all leads/i)).toBeNull();
  expect(screen.queryByText(/Send WhatsApp automatically to all leads/i)).toBeNull();
});



async function openBuilder(formName = 'Brand intake') {
  await screen.findByText(formName);
  fireEvent.click(screen.getByRole('button', { name: /Open builder/i }));
  await screen.findAllByDisplayValue(formName);
}

test('browser Back returns from a form builder to the forms list', async () => {
  renderRoutedPage();
  await openBuilder();
  expect(screen.getByTestId('navigation-probe-path')).toHaveTextContent('/forms?form=101');

  fireEvent.click(screen.getByRole('button', { name: 'Browser back' }));
  await waitFor(() => expect(screen.getByRole('heading', { name: 'All web forms' })).toBeInTheDocument());
  expect(screen.getByTestId('navigation-probe-path')).toHaveTextContent('/forms');
  expect(screen.queryByRole('button', { name: 'Back to all forms' })).toBeNull();

  fireEvent.click(screen.getByRole('button', { name: 'Browser forward' }));
  await waitFor(() => expect(screen.getByRole('button', { name: 'Back to all forms' })).toBeInTheDocument());

  fireEvent.click(screen.getByRole('button', { name: 'Back to all forms' }));
  await waitFor(() => expect(screen.getByRole('heading', { name: 'All web forms' })).toBeInTheDocument());
  expect(screen.getByTestId('navigation-probe-path')).toHaveTextContent('/forms');
});

beforeEach(() => {

  fetchApiMock.mockReset();

  window.sessionStorage.clear();

  notifyError.mockReset();

  notifySuccess.mockReset();

  notifyInfo.mockReset();

  notifyConfirm.mockReset();

  notifyConfirm.mockResolvedValue(true);

  installFetchMock();

});



describe('WebForms builder page', () => {
  test('does not copy or restore another account draft when identity changes in the same tab', async () => {
    const view = renderPage();
    await openBuilder();
    fireEvent.change(screen.getByDisplayValue('Name'), { target: { value: 'First account draft' } });
    const firstKey = 'globuscrm:web-form-draft:generic:14:1';
    await waitFor(() => expect(window.sessionStorage.getItem(firstKey)).toContain('First account draft'));
    view.rerender(<AuthContext.Provider value={{ user: { id: 2, role: 'ADMIN' }, tenant: { id: 14, vertical: 'generic' } }}><WebForms /></AuthContext.Provider>);
    await waitFor(() => expect(fetchApiMock.mock.calls.filter(([url]) => url === '/api/forms').length).toBeGreaterThan(1));
    expect(screen.queryByDisplayValue('First account draft')).not.toBeInTheDocument();
    expect(window.sessionStorage.getItem('globuscrm:web-form-draft:generic:14:2')).toBeNull();
    expect(window.sessionStorage.getItem(firstKey)).toContain('First account draft');
  });

  test('does not persist drafts under a shared unknown identity key', async () => {
    renderPage(FORM_FIXTURE, undefined, { user: { role: 'ADMIN' }, tenant: { vertical: 'generic' } });
    await openBuilder();
    fireEvent.change(screen.getByDisplayValue('Name'), { target: { value: 'Unresolved draft' } });
    await waitFor(() => expect(screen.getByDisplayValue('Unresolved draft')).toBeInTheDocument());
    expect(window.sessionStorage.length).toBe(0);
  });

  test('supports the legacy userId identity without sharing across tenants', async () => {
    const view = renderPage(FORM_FIXTURE, undefined, { user: { userId: 9, role: 'ADMIN' }, tenant: { id: 14, vertical: 'generic' } });
    await openBuilder();
    fireEvent.change(screen.getByDisplayValue('Name'), { target: { value: 'Tenant fourteen draft' } });
    await waitFor(() => expect(window.sessionStorage.getItem('globuscrm:web-form-draft:generic:14:9')).toContain('Tenant fourteen draft'));
    view.rerender(<AuthContext.Provider value={{ user: { userId: 9, role: 'ADMIN' }, tenant: { id: 15, vertical: 'generic' } }}><WebForms /></AuthContext.Provider>);
    await waitFor(() => expect(fetchApiMock.mock.calls.filter(([url]) => url === '/api/forms').length).toBeGreaterThan(1));
    expect(screen.queryByDisplayValue('Tenant fourteen draft')).not.toBeInTheDocument();
    expect(window.sessionStorage.getItem('globuscrm:web-form-draft:generic:15:9')).toBeNull();
  });

  test('pins the selected landing-page form first without reordering the other forms', async () => {
    const firstForm = { ...FORM_FIXTURE, id: 201, name: 'First form', slug: 'first-form' };
    const landingForm = { ...FORM_FIXTURE, id: 202, name: 'Landing form', slug: 'landing-form' };
    const thirdForm = { ...FORM_FIXTURE, id: 203, name: 'Third form', slug: 'third-form' };

    fetchApiMock.mockImplementation((url, opts) => {
      const method = opts?.method || 'GET';
      if (url === '/api/forms' && method === 'GET') {
        return Promise.resolve([firstForm, landingForm, thirdForm]);
      }
      if (url === '/api/lead-custom-fields' && method === 'GET') return Promise.resolve([]);
      if (url === '/api/landing-form-config/access') return Promise.resolve({ canManage: true });
      if (url === '/api/landing-form-config/mine') return Promise.resolve({ webFormId: landingForm.id });
      return Promise.resolve(null);
    });

    const { container } = render(
      <AuthContext.Provider value={{ user: { userId: 1, role: 'ADMIN' }, tenant: { vertical: 'generic' } }}>
        <WebForms />
      </AuthContext.Provider>,
    );

    await screen.findByText('Landing form');
    await waitFor(() => {
      const cardNames = Array.from(container.querySelectorAll('.wf-library-card h4'))
        .map((heading) => heading.textContent);
      expect(cardNames).toEqual(['Landing form', 'First form', 'Third form']);
    });
  });

  test('persists Generic multi-page definitions and field assignment', async () => {
    renderPage({ ...FORM_FIXTURE, scope: 'generic' });
    await openBuilder();

    for (const title of ['Contact details', 'Requirements']) {
      fireEvent.click(screen.getByRole('button', { name: /Add page/i }));
      const dialog = screen.getByRole('dialog', { name: /Add form page/i });
      fireEvent.change(dialog.querySelector('input[placeholder="Enter page title"]'), { target: { value: title } });
      fireEvent.click(Array.from(dialog.querySelectorAll('button')).find((button) => button.textContent === 'Add page'));
    }

    const stepSelect = screen.getByText('Form step').closest('label').querySelector('select');
    fireEvent.change(stepSelect, { target: { value: stepSelect.options[1].value } });
    fireEvent.click(screen.getByRole('button', { name: /^Save$/i }));

    await waitFor(() => {
      const update = fetchApiMock.mock.calls.find(([url, opts]) => url === '/api/forms/101' && opts?.method === 'PUT');
      expect(update).toBeTruthy();
      const body = JSON.parse(update[1].body);
      expect(body.settings.steps.map((step) => step.title)).toEqual(['Contact details', 'Requirements']);
      expect(body.settings.multiStepEnabled).toBe(true);
      expect(body.settings.whatsappEnabled).toBe(false);
      expect(body.fields[0].stepId).toBe(body.settings.steps[1].id);
    });
  });

  test('renders conditional children in an indented branch card beneath their parent', async () => {
    const conditionalForm = {
      ...FORM_FIXTURE,
      scope: 'generic',
      fields: [
        {
          id: 'root-question', sourceKind: 'custom', sourceKey: 'root-question', fieldType: 'dropdown',
          label: 'Interested in', optionsText: 'Shopify\nWordPress', options: ['Shopify', 'WordPress'],
          required: false, hidden: false, showWhen: null,
        },
        {
          id: 'child-question', sourceKind: 'custom', sourceKey: 'child-question', fieldType: 'text',
          label: 'Shopify Store URL', options: [], required: false, hidden: false,
          showWhen: { fieldId: 'root-question', fieldKey: 'root-question', value: 'Shopify' },
        },
      ],
    };

    const { container } = renderPage(conditionalForm);
    await openBuilder();

    expect(screen.getByText('Conditional flow')).toBeInTheDocument();
    expect(screen.getByText('Show question')).toBeInTheDocument();
    const childCard = container.querySelector('.wf-conditional-child-card');
    expect(childCard).toBeInTheDocument();
    expect(childCard).toHaveTextContent('Shopify');
    expect(childCard).toHaveTextContent('Shopify Store URL');
    expect(childCard.querySelector('[data-testid="wf-field-editor-grid"]')).toBeInTheDocument();
    expect(childCard.querySelector('.wf-conditional-config')).toBeNull();
  });

  test('preserves comma separators while editing conditional flow options', async () => {
    const conditionalForm = {
      ...FORM_FIXTURE,
      scope: 'generic',
      fields: [{
        id: 'root-question', sourceKind: 'custom', sourceKey: 'root-question', fieldType: 'dropdown',
        label: 'Interested in', optionsText: 'sea', options: ['sea'],
        required: false, hidden: false, showWhen: null,
      }],
    };

    renderPage(conditionalForm);
    await openBuilder();

    const options = screen.getByDisplayValue('sea');
    fireEvent.change(options, { target: { value: 'sea,' } });

    expect(options).toHaveValue('sea,');
  });

  test('restores unsaved changes after refresh without a native unload alert', async () => {
    const firstRender = renderPage();
    await openBuilder();
    fireEvent.change(screen.getByDisplayValue('Name'), { target: { value: 'Changed name' } });

    await waitFor(() => {
      expect(Object.keys(window.sessionStorage).some((key) => window.sessionStorage.getItem(key)?.includes('Changed name'))).toBe(true);
    });

    const event = new Event('beforeunload', { cancelable: true });
    const preventDefault = vi.spyOn(event, 'preventDefault');
    window.dispatchEvent(event);

    expect(preventDefault).not.toHaveBeenCalled();

    firstRender.unmount();
    renderPage();

    expect(await screen.findByDisplayValue('Changed name')).toBeInTheDocument();
    expect(notifyConfirm).toHaveBeenCalledWith(expect.objectContaining({
      title: 'Unsaved changes',
      message: expect.stringContaining('continue editing'),
      confirmText: 'Continue editing',
      cancelText: 'Discard changes',
    }));
  });

  test('asks for confirmation before an internal navigation can discard changes', async () => {
    renderRoutedPage();
    await openBuilder();
    fireEvent.change(screen.getByDisplayValue('Name'), { target: { value: 'Changed name' } });

    fireEvent.click(screen.getByRole('link', { name: 'Leave Web Forms' }));

    await waitFor(() => {
      expect(notifyConfirm).toHaveBeenCalledWith(expect.objectContaining({
        title: 'Leave this form?',
        message: expect.stringContaining('will discard them'),
        confirmText: 'Continue editing',
        cancelText: 'Discard changes',
        confirmValue: false,
        cancelValue: true,
        dismissValue: false,
      }));
    });
    await waitFor(() => expect(screen.getByTestId('navigation-probe-path')).toHaveTextContent('/dashboard'));
  });

  test('offers one form-specific sign-out decision and preserves edits when cancelled', async () => {
    renderRoutedPage();
    await openBuilder();
    expect(await confirmActiveFormExit()).toBeNull();
    fireEvent.change(screen.getByDisplayValue('Name'), { target: { value: 'Changed name' } });
    const draftKey = 'globuscrm:web-form-draft:generic:14:1';
    await waitFor(() => expect(window.sessionStorage.getItem(draftKey)).toContain('Changed name'));

    notifyConfirm.mockResolvedValueOnce(false);
    let canSignOut;
    await act(async () => { canSignOut = await confirmActiveFormExit(); });
    expect(canSignOut).toBe(false);
    expect(notifyConfirm).toHaveBeenCalledWith(expect.objectContaining({
      title: 'Unsaved changes',
      confirmText: 'Discard & sign out',
      cancelText: 'Continue editing',
      destructive: true,
    }));
    expect(screen.getByDisplayValue('Changed name')).toBeInTheDocument();
    expect(window.sessionStorage.getItem(draftKey)).toContain('Changed name');

    await act(async () => { canSignOut = await confirmActiveFormExit(); });
    expect(canSignOut).toBe(true);
    expect(window.sessionStorage.getItem(draftKey)).toBeNull();
  });

  test('travel logo selection immediately sends a multipart upload request', async () => {
    const { container } = renderTravelPage();
    await openBuilder();
    const input = container.querySelector('input[type="file"][accept="image/*"]');
    const file = new File(['logo bytes'], 'travel-logo.png', { type: 'image/png' });

    fireEvent.change(input, { target: { files: [file] } });

    await waitFor(() => {
      expect(fetchApiMock).toHaveBeenCalledWith(
        '/api/forms/logo-upload?scope=travel',
        expect.objectContaining({ method: 'POST', body: expect.any(FormData) }),
      );
    });
    const [, options] = fetchApiMock.mock.calls.find(([url]) => url === '/api/forms/logo-upload?scope=travel');
    expect(options.body.get('image')).toBe(file);
    expect(await screen.findByAltText('Form logo preview')).toHaveAttribute('src', 'https://objectstorage.example.com/travel-logo.png');
    expect(notifySuccess).toHaveBeenCalledWith('Logo uploaded to OCS.');
  });

  test('renders web form builder chrome and opens the embed + preview modals', async () => {

    renderPage();



    await openBuilder();

    expect(screen.getByRole('heading', { name: /Web Forms/i })).toBeInTheDocument();

    expect(screen.getByRole('button', { name: /New form/i })).toBeInTheDocument();

    expect(screen.getByRole('button', { name: /Get embed code and URL/i })).toBeInTheDocument();

    expect(screen.getByRole('button', { name: /Preview form/i })).toBeInTheDocument();

    expect(screen.getByRole('button', { name: /Add fields/i })).toBeInTheDocument();

    expect(screen.getByRole('button', { name: /Customize text and colors/i })).toBeInTheDocument();

    expect(screen.getByRole('button', { name: /Settings/i })).toBeInTheDocument();

    expect(screen.getByTestId('wf-field-editor-grid')).toHaveStyle({

      gridTemplateColumns: 'minmax(220px, 1fr) minmax(180px, 0.8fr) minmax(260px, max-content)',

    });

    fireEvent.click(screen.getByRole('button', { name: /Settings/i }));

    await screen.findByText(/Send email notification to this address/i);

    expect(screen.getByText(/Send an automatic message to all leads/i)).toBeInTheDocument();

    expect(screen.getByText(/Send email automatically to all leads/i)).toBeInTheDocument();

    expect(screen.getByText(/Send SMS automatically to all leads/i)).toBeInTheDocument();

    expect(screen.getByText(/Send WhatsApp automatically to all leads/i)).toBeInTheDocument();

    const whatsappToggle = screen.getByRole('checkbox', { name: /Enable WhatsApp number field and same-as-phone checkbox/i });
    expect(whatsappToggle).not.toBeChecked();
    fireEvent.click(whatsappToggle);
    expect(whatsappToggle).toBeChecked();
    fireEvent.click(screen.getByRole('button', { name: /^Save$/i }));
    await waitFor(() => {
      const update = fetchApiMock.mock.calls.find(([url, opts]) => url === '/api/forms/101' && opts?.method === 'PUT');
      expect(update).toBeTruthy();
      expect(JSON.parse(update[1].body).settings.whatsappEnabled).toBe(true);
    });

    expect(screen.getByText('Logo and form text')).toBeInTheDocument();

    expect(screen.getByRole('button', { name: /Upload/i })).toBeInTheDocument();

    expect(screen.getByText(/Send email notification to this address/i)).toBeInTheDocument();

    expect(screen.getByText(/Include an opt-in checkbox at the end of the form/i)).toBeInTheDocument();

    expect(screen.getByRole('button', { name: /Edit link/i })).toBeInTheDocument();

    expect(screen.queryByText(/Submit button label/i)).toBeNull();



    fireEvent.click(screen.getByRole('button', { name: /Get embed code and URL/i }));

    expect(screen.getAllByDisplayValue(/embed\/web-form\.html\?id=101/).length).toBeGreaterThan(0);

    expect(screen.getAllByDisplayValue(/iframe src=/i).length).toBeGreaterThan(0);



    fireEvent.click(screen.getByRole('button', { name: /Preview form/i }));

    const previewFrame = screen.getByTitle('Web form preview');
    expect(previewFrame).toBeInTheDocument();
    expect(previewFrame).toHaveStyle({ height: 'auto', minHeight: '0px' });

    Object.defineProperty(previewFrame, 'contentWindow', { configurable: true, value: {} });
    window.dispatchEvent(new MessageEvent('message', {
      source: previewFrame.contentWindow,
      data: { source: 'gbs-web-form', type: 'size', height: 1234.2 },
    }));
    expect(previewFrame.style.height).toBe('1235px');
    expect(previewFrame.style.minHeight).toBe('0px');

  });



  test('locks Generic field types while keeping labels editable', async () => {
    const fields = [
      { ...FORM_FIXTURE.fields[0], id: 'name-field', sourceKey: 'name', label: 'Name', fieldType: 'number' },
      { ...FORM_FIXTURE.fields[0], id: 'email-field', sourceKey: 'email', label: 'Email', fieldType: 'text' },
      { ...FORM_FIXTURE.fields[0], id: 'phone-field', sourceKey: 'phone', label: 'Phone', fieldType: 'number' },
    ];
    renderPage({ ...FORM_FIXTURE, scope: 'generic', fields });
    await openBuilder();

    const nameType = screen.getByRole('combobox', { name: 'Field type for Name' });
    const emailType = screen.getByRole('combobox', { name: 'Field type for Email' });
    const phoneType = screen.getByRole('combobox', { name: 'Field type for Phone' });

    expect(nameType).toBeDisabled();
    expect(nameType).toHaveValue('text');
    expect(emailType).toBeDisabled();
    expect(emailType).toHaveValue('email');
    expect(phoneType).toBeDisabled();
    expect(phoneType).toHaveValue('tel');

    const nameLabel = screen.getByDisplayValue('Name');
    expect(nameLabel).not.toBeDisabled();
    fireEvent.change(nameLabel, { target: { value: 'Full name' } });
    expect(screen.getByDisplayValue('Full name')).toBeInTheDocument();
  });

  test('keeps Travel field types editable', async () => {
    const phoneField = { ...FORM_FIXTURE.fields[0], sourceKey: 'phone', label: 'Phone', fieldType: 'number' };
    renderTravelPage({ ...FORM_FIXTURE, scope: 'travel', fields: [phoneField] });
    await openBuilder();

    const phoneType = screen.getByRole('combobox', { name: 'Field type for Phone' });
    expect(phoneType).not.toBeDisabled();
    expect(phoneType).toHaveValue('number');
    expect(within(phoneType).queryByRole('option', { name: 'Tel' })).toBeNull();
  });

  test('opens contact picker with dynamic fields from Contacts and Leads pages', async () => {

    renderPage();



    await openBuilder();

    fireEvent.click(screen.getByRole('button', { name: /Add contact fields/i }));



    await waitFor(() => {

      expect(fetchApiMock).toHaveBeenCalledWith('/api/lead-custom-fields');

    });

    expect(await screen.findByText('CONTACT FIELDS')).toBeInTheDocument();

    expect(screen.queryByText('Contact and lead custom fields')).toBeNull();

    expect(screen.getByText('Submit source')).toBeInTheDocument();

    expect(screen.getByText('Keyword')).toBeInTheDocument();

  });

  test('loads configured options when a lead custom choice field is added', async () => {
    renderPage(FORM_FIXTURE, [
      { id: 7, fieldKey: 'business_type', label: 'Business type', fieldType: 'dropdown', options: ['SaaS', 'E-Commerce', 'Freelancer'], placeholder: 'Select one' },
    ]);

    await openBuilder();
    fireEvent.click(screen.getByRole('button', { name: /Add contact fields/i }));
    fireEvent.click(await screen.findByRole('button', { name: /Business type.*custom/i }));

    expect(await screen.findByDisplayValue('SaaS, E-Commerce, Freelancer')).toBeInTheDocument();
  });

  test('creates a lead field from the Generic contact picker plus action', async () => {
    let customFields = [
      { id: 1, fieldKey: 'submit_source', label: 'Submit source', fieldType: 'text' },
    ];
    // Configure every response before mount so the initial effect cannot
    // fetch a different field catalogue than the one this test owns.
    renderPage(FORM_FIXTURE, customFields, undefined, (baseFetch) => {
      fetchApiMock.mockImplementation((url, opts) => {
        const method = opts?.method || 'GET';
        if (url === '/api/lead-custom-fields' && method === 'GET') {
          return Promise.resolve(customFields);
        }
        if (url === '/api/lead-custom-fields' && method === 'POST') {
          const body = JSON.parse(opts.body);
          const created = { id: 91, fieldKey: 'referral_source', ...body };
          customFields = [...customFields, created];
          return Promise.resolve(created);
        }
        return baseFetch(url, opts);
      });
    });

    await openBuilder();
    fireEvent.click(screen.getByRole('button', { name: /Add contact fields/i }));
    const picker = screen.getByPlaceholderText('Type to search').closest('.wf-field-picker');
    fireEvent.click(within(picker).getByRole('button', { name: /Add lead custom field/i }));

    const dialog = await screen.findByRole('dialog', { name: /Add Lead Field/i });
    expect(within(dialog).getByLabelText('Field Type')).not.toBeDisabled();
    fireEvent.change(within(dialog).getByPlaceholderText('e.g. Referral Source'), {
      target: { value: 'Referral Source' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: /Save Field/i }));

    await waitFor(() => {
      expect(fetchApiMock).toHaveBeenCalledWith(
        '/api/lead-custom-fields',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({
            label: 'Referral Source',
            fieldType: 'text',
            isRequired: false,
          }),
        }),
      );
    });
    expect(notifySuccess).toHaveBeenCalledWith('Field created');
    expect(screen.queryByPlaceholderText('Type to search')).toBeNull();
    expect(await screen.findByDisplayValue('Referral Source')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /Add contact fields/i }));
    const reopenedPicker = screen.getByPlaceholderText('Type to search').closest('.wf-field-picker');
    const addedItem = within(reopenedPicker).getByText('Referral Source').closest('.wf-field-picker-item');
    expect(addedItem).toHaveAttribute('title', 'Already added to form');
    expect(within(addedItem).getByText('Added')).toBeInTheDocument();
  }, 10000); // Multi-dialog integration flow needs headroom on loaded CI runners.

  test('does not show the lead-field plus action in the Travel form picker', async () => {
    renderTravelPage();
    await openBuilder();

    fireEvent.click(screen.getByRole('button', { name: /Add contact fields/i }));
    expect(await screen.findByText('CONTACT FIELDS')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Add lead custom field/i })).toBeNull();
  });

  test('supports draft edits and save on the form name field', async () => {

    renderPage();



    await openBuilder();

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

    const renameCall = fetchApiMock.mock.calls.find(
      ([url, opts]) => url === '/api/forms/101' && opts?.method === 'PUT',
    );
    // Renaming the header name must not rewrite the slug — public links use the stable id.
    expect(JSON.parse(renameCall[1].body)).toEqual(
      expect.objectContaining({ name: 'Saved form', slug: 'brand-intake' }),
    );

    expect(notifySuccess).toHaveBeenCalledWith('Form saved');

  });

  test('allows clearing and saving the form title', async () => {

    renderPage();



    await openBuilder();

    const [nameField] = await screen.findAllByDisplayValue('Brand intake');

    fireEvent.change(nameField, { target: { value: '' } });

    expect(nameField).toHaveValue('');

    fireEvent.click(screen.getByRole('button', { name: /^Save$/ }));



    await waitFor(() => {

      const saveCall = fetchApiMock.mock.calls.find(

        ([url, opts]) => url === '/api/forms/101' && opts?.method === 'PUT',

      );

      expect(saveCall).toBeTruthy();

      expect(JSON.parse(saveCall[1].body)).toEqual(

        expect.objectContaining({ name: '' }),

      );

    });

    expect(notifySuccess).toHaveBeenCalledWith('Form saved');

  });

  test('keeps the internal form name and the public display title independent', async () => {

    renderPage();



    await openBuilder();

    const matches = await screen.findAllByDisplayValue('Brand intake');

    expect(matches).toHaveLength(2);

    fireEvent.change(matches[1], { target: { value: 'Public title' } });

    expect(matches[0]).toHaveValue('Brand intake');

    expect(matches[1]).toHaveValue('Public title');

    fireEvent.click(screen.getByRole('button', { name: /^Save$/ }));



    await waitFor(() => {

      const saveCall = fetchApiMock.mock.calls.find(

        ([url, opts]) => url === '/api/forms/101' && opts?.method === 'PUT',

      );

      expect(saveCall).toBeTruthy();

      const body = JSON.parse(saveCall[1].body);

      expect(body.name).toBe('Brand intake');

      expect(body.settings).toEqual(expect.objectContaining({ formTitle: 'Public title' }));

      // Renames must not rewrite the slug — public links use the stable id.
      expect(body.slug).toBe('brand-intake');

    });

    expect(notifySuccess).toHaveBeenCalledWith('Form saved');

  });

  test('saves edits across fields, settings, and colors in one request', async () => {
    renderPage();

    await openBuilder();

    fireEvent.change(screen.getByDisplayValue('Name'), { target: { value: 'Full name' } });
    fireEvent.change(screen.getByDisplayValue('Submit'), { target: { value: 'Send request' } });
    const formColorPicker = screen.getAllByLabelText('Form color *').find((element) => element.type === 'color');
    const buttonColorPicker = screen.getAllByLabelText('Color of Submit button *').find((element) => element.type === 'color');
    fireEvent.change(formColorPicker, { target: { value: '#F4F5F6' } });
    fireEvent.change(buttonColorPicker, { target: { value: '#99B177' } });

    fireEvent.click(screen.getByRole('button', { name: /^Save$/ }));

    await waitFor(() => {
      const saveCall = fetchApiMock.mock.calls.find(
        ([url, opts]) => url === '/api/forms/101' && opts?.method === 'PUT',
      );
      expect(saveCall).toBeTruthy();
      const body = JSON.parse(saveCall[1].body);
      expect(body.fields[0]).toEqual(expect.objectContaining({ label: 'Full name' }));
      expect(body.settings).toEqual(expect.objectContaining({ submitButtonLabel: 'Send request' }));
      expect(body.style).toEqual(expect.objectContaining({ formColor: '#F4F5F6', buttonColor: '#99B177' }));
    });

    expect(notifySuccess).toHaveBeenCalledWith('Form saved');
  });

  test('saves the title and description spacing controls', async () => {
    renderPage({ ...FORM_FIXTURE, scope: 'generic' });
    await openBuilder();

    fireEvent.click(screen.getByRole('button', { name: 'Layout' }));

    const titleDescriptionGap = screen.getByText('Title to description gap (px)').closest('label').querySelector('input');
    const descriptionFieldsGap = screen.getByText('Description to fields gap (px)').closest('label').querySelector('input');
    fireEvent.change(titleDescriptionGap, { target: { value: '28' } });
    fireEvent.change(descriptionFieldsGap, { target: { value: '36' } });
    fireEvent.click(screen.getByRole('button', { name: /^Save$/ }));

    await waitFor(() => {
      const saveCall = fetchApiMock.mock.calls.find(
        ([url, opts]) => url === '/api/forms/101' && opts?.method === 'PUT',
      );
      expect(saveCall).toBeTruthy();
      expect(JSON.parse(saveCall[1].body).style).toEqual(expect.objectContaining({
        titleDescriptionGap: 28,
        descriptionFieldsGap: 36,
      }));
    });
  });

  test('saves the selected desktop two-column layout', async () => {
    renderPage({ ...FORM_FIXTURE, scope: 'generic' });
    await openBuilder();

    fireEvent.click(screen.getByRole('button', { name: 'Layout' }));
    const desktopColumns = screen.getByText('Desktop columns').closest('label').querySelector('select');
    fireEvent.change(desktopColumns, { target: { value: 'two' } });
    fireEvent.click(screen.getByRole('button', { name: /^Save$/ }));

    await waitFor(() => {
      const saveCall = fetchApiMock.mock.calls.find(
        ([url, opts]) => url === '/api/forms/101' && opts?.method === 'PUT',
      );
      expect(saveCall).toBeTruthy();
      expect(JSON.parse(saveCall[1].body).style).toEqual(expect.objectContaining({
        layoutColumns: 'two',
      }));
    });
  });

  test('custom choice fields expose an editable options textarea', async () => {

    const customForm = {

      ...FORM_FIXTURE,

      name: 'Choice form',

      slug: 'choice-form',

      fields: [

        {

          id: 'field-2',

          sourceKind: 'custom',

          sourceKey: 'custom_gender',

          fieldType: 'dropdown',

          label: 'Gender',

          placeholder: '',

          helpText: '',

          required: false,

          hidden: false,

          options: ['Male', 'Female'],

          width: 'full',

        },

      ],

    };



    renderPage(customForm);



    await openBuilder('Choice form');

    expect(screen.getByText('Options')).toBeInTheDocument();

    expect(screen.getByDisplayValue('Male, Female')).toBeInTheDocument();

  });

  test('saves horizontal radio layout for choice fields', async () => {
    const radioForm = {
      ...FORM_FIXTURE,
      name: 'Radio form',
      slug: 'radio-form',
      fields: [
        {
          id: 'field-radio',
          sourceKind: 'custom',
          sourceKey: 'platform',
          fieldType: 'radio',
          label: 'Which platform?',
          placeholder: '',
          helpText: '',
          required: false,
          hidden: false,
          options: ['TikTok', 'Instagram', 'Both'],
          width: 'full',
        },
      ],
    };

    renderPage(radioForm);
    await openBuilder('Radio form');

    const layoutSelect = screen.getByText('Radio layout').closest('label').querySelector('select');
    expect(layoutSelect).toHaveValue('vertical');
    fireEvent.change(layoutSelect, { target: { value: 'horizontal' } });
    fireEvent.click(screen.getByRole('button', { name: /^Save$/ }));

    await waitFor(() => {
      const saveCall = fetchApiMock.mock.calls.find(
        ([url, opts]) => url === '/api/forms/101' && opts?.method === 'PUT',
      );
      expect(saveCall).toBeTruthy();
      expect(JSON.parse(saveCall[1].body).fields[0].choiceLayout).toBe('horizontal');
    });
  });



  test('hidden date fields expose a date picker for the default value', async () => {

    const dateForm = {

      ...FORM_FIXTURE,

      name: 'Date form',

      slug: 'date-form',

      fields: [

        {

          id: 'field-3',

          sourceKind: 'custom',

          sourceKey: 'custom_birth_date',

          fieldType: 'date',

          label: 'Birth date',

          placeholder: '',

          helpText: '',

          required: false,

          hidden: true,

          defaultValue: '',

          options: [],

          width: 'full',

        },

      ],

    };



    renderPage(dateForm);



    await openBuilder('Date form');

    expect(document.querySelector('input[type="date"]')).toBeTruthy();

  });
});

test.each(['generic', 'wellness', 'travel'])('View All Leads is available only for Generic CRM (%s)', async (vertical) => {
  installFetchMock();
  render(<AuthContext.Provider value={{ user: { userId: 1, role: 'ADMIN' }, tenant: { vertical } }}><WebForms /></AuthContext.Provider>);
  await screen.findByText('Brand intake');
  expect(screen.queryByRole('button', { name: 'View All Leads' }) !== null).toBe(vertical === 'generic');
  expect(screen.queryByRole('button', { name: 'New Folder' }) !== null).toBe(vertical === 'generic');
  if (vertical === 'generic') {
    fireEvent.click(screen.getByRole('button', { name: 'View All Leads' }));
    expect(screen.getByRole('dialog', { name: /Leads .* Brand intake/ })).toBeInTheDocument();
    fireEvent.click(screen.getByLabelText('Close dialog'));
  }
});

test('Changing folder views closes and resets the new folder editor', async () => {
  installFetchMock();
  const baseFetch = fetchApiMock.getMockImplementation();
  fetchApiMock.mockImplementation((url, opts) => {
    if (url === '/api/forms/folders' && !opts) return Promise.resolve([{ id: 9, name: 'Campaigns' }]);
    return baseFetch(url, opts);
  });
  render(<AuthContext.Provider value={{ user: { userId: 1, role: 'ADMIN' }, tenant: { id: 14, vertical: 'generic' } }}><WebForms /></AuthContext.Provider>);
  await screen.findByText('Brand intake');

  fireEvent.click(screen.getByRole('button', { name: 'New Folder' }));
  fireEvent.change(screen.getByRole('textbox', { name: 'Folder name' }), { target: { value: 'Unused draft' } });
  fireEvent.click(screen.getByRole('button', { name: 'All Forms (1)' }));
  expect(screen.queryByRole('textbox', { name: 'Folder name' })).toBeNull();

  fireEvent.click(screen.getByRole('button', { name: 'New Folder' }));
  expect(screen.getByRole('textbox', { name: 'Folder name' })).toHaveValue('');
  fireEvent.click(screen.getByRole('button', { name: 'All Folders' }));
  expect(screen.queryByRole('textbox', { name: 'Folder name' })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: /Campaigns.*0/ }));
  expect(screen.getByText('Campaigns')).toBeInTheDocument();
});

test('Generic forms can be filed into a manually created folder', async () => {
  installFetchMock();
  const baseFetch = fetchApiMock.getMockImplementation();
  fetchApiMock.mockImplementation((url, opts) => {
    if (url === '/api/forms/folders' && !opts) return Promise.resolve([]);
    if (url === '/api/forms/folders' && opts?.method === 'POST') {
      const name = JSON.parse(opts.body).name;
      return Promise.resolve({ id: name === 'Campaigns' ? 9 : 10, name });
    }
    if (url === '/api/forms/101/folder' && opts?.method === 'PUT') return Promise.resolve({ id: 101, folderId: JSON.parse(opts.body).folderId });
    return baseFetch(url, opts);
  });
  render(<AuthContext.Provider value={{ user: { userId: 1, role: 'ADMIN' }, tenant: { id: 14, vertical: 'generic' } }}><WebForms /></AuthContext.Provider>);
  await screen.findByText('Brand intake');
  expect(screen.queryByRole('button', { name: /Unfiled/ })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'New Folder' }));
  fireEvent.change(screen.getByRole('textbox', { name: 'Folder name' }), { target: { value: 'Campaigns' } });
  fireEvent.click(screen.getByRole('button', { name: 'Create folder' }));
  fireEvent.click(screen.getByRole('button', { name: 'All Folders' }));
  expect(await screen.findByRole('button', { name: /Campaigns.*0/ })).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'All Forms (1)' }));
  expect(screen.queryByRole('combobox', { name: 'Folder for Brand intake' })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Move Brand intake to folder' }));
  fireEvent.click(screen.getByRole('menuitem', { name: 'Campaigns' }));
  await waitFor(() => expect(fetchApiMock).toHaveBeenCalledWith('/api/forms/101/folder', expect.objectContaining({ method: 'PUT', body: JSON.stringify({ folderId: 9 }) })));
  fireEvent.click(screen.getByRole('button', { name: 'All Folders' }));
  expect(await screen.findByRole('button', { name: /Campaigns.*1/ })).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'All Folders' }));
  expect(screen.getByText('Folder: Campaigns')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Move Brand intake to folder' }));
  expect(screen.getByRole('menuitem', { name: 'Move to All Forms' })).toBeEnabled();
  expect(screen.getByRole('menuitem', { name: 'Campaigns' })).toHaveAttribute('aria-current', 'true');
  fireEvent.click(screen.getByRole('menuitem', { name: 'New Folder' }));
  fireEvent.change(screen.getByRole('textbox', { name: 'New folder name for Brand intake' }), { target: { value: 'Projects' } });
  fireEvent.click(screen.getByRole('button', { name: 'Create and move' }));
  await waitFor(() => expect(fetchApiMock).toHaveBeenCalledWith('/api/forms/101/folder', expect.objectContaining({ method: 'PUT', body: JSON.stringify({ folderId: 10 }) })));
  expect(await screen.findByText('Folder: Projects')).toBeInTheDocument();
  const formCard = screen.getByText('Brand intake').closest('article');
  const dataTransfer = { setData: vi.fn(), getData: vi.fn(() => '101'), setDragImage: vi.fn(), effectAllowed: '', dropEffect: '' };
  const moveCallsBeforeDrop = fetchApiMock.mock.calls.filter(([url, opts]) => url === '/api/forms/101/folder' && opts?.method === 'PUT').length;
  fireEvent.dragStart(formCard, { dataTransfer });
  expect(dataTransfer.setDragImage).toHaveBeenCalledOnce();
  const [dragPreview] = dataTransfer.setDragImage.mock.calls[0];
  expect(dragPreview).not.toBe(formCard);
  expect(dragPreview).toHaveClass('wf-form-drag-preview');
  expect(dragPreview).toHaveTextContent('Moving form');
  expect(dragPreview).toHaveTextContent('Brand intake');
  expect(dragPreview.querySelector('svg')).toBeInTheDocument();
  fireEvent.dragOver(screen.getByRole('button', { name: /Campaigns.*0/ }), { dataTransfer });
  expect(screen.getByRole('button', { name: /Campaigns.*0/ })).toHaveClass('wf-folder-drop-target');
  fireEvent.drop(screen.getByRole('button', { name: /Campaigns.*0/ }), { dataTransfer });
  await waitFor(() => expect(fetchApiMock.mock.calls.filter(([url, opts]) => url === '/api/forms/101/folder' && opts?.method === 'PUT').length).toBe(moveCallsBeforeDrop + 1));
  expect(await screen.findByText('Folder: Campaigns')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Move Brand intake to folder' }));
  fireEvent.click(screen.getByRole('menuitem', { name: 'Move to All Forms' }));
  await waitFor(() => expect(fetchApiMock).toHaveBeenCalledWith('/api/forms/101/folder', expect.objectContaining({ method: 'PUT', body: JSON.stringify({ folderId: null }) })));
  await waitFor(() => expect(screen.queryByText('Folder: Campaigns')).toBeNull());
}, 15000);

test('Travel forms do not show folder controls', async () => {
  renderTravelPage();
  await screen.findByText('Brand intake');
  expect(screen.queryByRole('button', { name: 'New Folder' })).toBeNull();
  expect(fetchApiMock).not.toHaveBeenCalledWith('/api/forms/folders');
});

test('All Folders searches folders without adding them to the toolbar', async () => {
  installFetchMock();
  const baseFetch = fetchApiMock.getMockImplementation();
  fetchApiMock.mockImplementation((url, opts) => {
    if (url === '/api/forms/folders' && !opts) return Promise.resolve([
      { id: 9, name: 'Campaigns' },
      { id: 10, name: 'Projects' },
    ]);
    return baseFetch(url, opts);
  });
  render(<AuthContext.Provider value={{ user: { userId: 1, role: 'ADMIN' }, tenant: { id: 14, vertical: 'generic' } }}><WebForms /></AuthContext.Provider>);
  await screen.findByText('Brand intake');
  const toolbar = screen.getByLabelText('Form folders');
  expect(toolbar.children).toHaveLength(3);
  fireEvent.click(screen.getByRole('button', { name: 'All Folders' }));
  fireEvent.change(screen.getByRole('textbox', { name: 'Search folders' }), { target: { value: 'proj' } });
  expect(screen.getByRole('button', { name: /Projects.*0/ })).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: /Campaigns.*0/ })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: /Projects.*0/ }));
  expect(screen.getByRole('button', { name: 'All Folders' })).toHaveAttribute('aria-expanded', 'false');
  expect(screen.getByRole('button', { name: 'All Folders' })).toHaveClass('wf-folder-active');
  fireEvent.click(screen.getByRole('button', { name: 'All Folders' }));
  expect(screen.getByRole('textbox', { name: 'Search folders' })).toHaveValue('');
  expect(screen.getByRole('button', { name: /Campaigns.*0/ })).toBeInTheDocument();
});

test.each([
  [false, 'Delete folder only'],
  [true, 'Delete folder and forms'],
])('folder deletion offers whether to delete its forms (%s)', async (deleteForms, actionLabel) => {
  installFetchMock({ ...FORM_FIXTURE, folderId: 9 });
  const baseFetch = fetchApiMock.getMockImplementation();
  fetchApiMock.mockImplementation((url, opts) => {
    if (url === '/api/forms/folders' && !opts) return Promise.resolve([{ id: 9, name: 'Campaigns' }]);
    if (url === '/api/forms/folders/9' && opts?.method === 'DELETE') return Promise.resolve({ success: true });
    return baseFetch(url, opts);
  });
  render(<AuthContext.Provider value={{ user: { userId: 1, role: 'ADMIN' }, tenant: { id: 14, vertical: 'generic' } }}><WebForms /></AuthContext.Provider>);
  fireEvent.click(await screen.findByRole('button', { name: 'All Folders' }));
  await screen.findByRole('button', { name: /Campaigns.*1/ });
  fireEvent.click(screen.getByRole('button', { name: /Campaigns.*1/ }));
  fireEvent.click(screen.getByRole('button', { name: 'Delete folder' }));
  expect(screen.getByRole('dialog', { name: 'Delete folder?' })).toHaveTextContent('1 form');
  fireEvent.click(screen.getByRole('button', { name: actionLabel }));
  await waitFor(() => expect(fetchApiMock).toHaveBeenCalledWith('/api/forms/folders/9', expect.objectContaining({ method: 'DELETE', body: JSON.stringify({ deleteForms }) })));
  if (deleteForms) {
    await waitFor(() => expect(screen.queryByText('Brand intake')).toBeNull());
  } else {
    expect(await screen.findByText('Brand intake')).toBeInTheDocument();
    expect(screen.queryByText('Folder: Campaigns')).toBeNull();
  }
});
