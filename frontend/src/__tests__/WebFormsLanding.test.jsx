/**
 * WebFormsLanding.test.jsx — per-card landing-page control on the generic
 * Web Forms library page.
 *
 * SUT: frontend/src/pages/WebForms.jsx (landing-form additions)
 *   - For generic scope + allowlisted login (authed
 *     GET /api/landing-form-config/access → { canManage: true }), each form
 *     card shows either an "On landing page" badge (current selection from
 *     the public GET /api/landing-form-config) or a "Use this form in landing page"
 *     button that PUTs the choice and moves the badge.
 *   - Non-allowlisted logins see neither control.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import WebForms from '../pages/WebForms';

const fetchApiMock = vi.fn();
vi.mock('../utils/api', () => ({
  fetchApi: (...args) => fetchApiMock(...args),
}));

const notifySuccess = vi.fn();
const notifyError = vi.fn();
vi.mock('../utils/notify', () => ({
  useNotify: () => ({
    error: notifyError,
    info: vi.fn(),
    success: notifySuccess,
  }),
}));

const navigateMock = vi.fn();
vi.mock('react-router-dom', async () => {
  const real = await vi.importActual('react-router-dom');
  return { ...real, useNavigate: () => navigateMock };
});

const FORMS = [
  { id: 9, name: 'Landing Page', slug: 'globus-crm-landing', description: '', isActive: true, submissionCount: 2, fields: [], style: {}, settings: {} },
  { id: 10, name: 'Contact Us', slug: 'contact-us', description: '', isActive: true, submissionCount: 5, fields: [], style: {}, settings: {} },
];

function renderWebForms() {
  return render(
    <MemoryRouter initialEntries={['/web-forms']}>
      <WebForms scope="generic" />
    </MemoryRouter>
  );
}

describe('WebForms landing-page control', () => {
  let realFetch;

  beforeEach(() => {
    realFetch = global.fetch;
    fetchApiMock.mockReset();
    notifySuccess.mockReset();
    notifyError.mockReset();
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ webFormId: 9, webFormName: 'Landing Page' }),
    });
  });

  afterEach(() => {
    global.fetch = realFetch;
    vi.restoreAllMocks();
  });

  function mockBackend({ canManage }) {
    fetchApiMock.mockImplementation((url, opts) => {
      if (url === '/api/landing-form-config/access') {
        return Promise.resolve({ canManage });
      }
      if (url === '/api/forms' && !opts) {
        return Promise.resolve(FORMS);
      }
      if (url === '/api/lead-custom-fields') {
        return Promise.resolve([]);
      }
      if (url === '/api/landing-form-config' && opts?.method === 'PUT') {
        const body = JSON.parse(opts.body);
        const picked = FORMS.find((f) => f.id === body.webFormId);
        return Promise.resolve({ webFormId: picked.id, webFormName: picked.name });
      }
      return Promise.reject(new Error(`unexpected ${opts?.method || 'GET'} ${url}`));
    });
  }

  it('allowlisted admin sees the badge on the current form + button on others', async () => {
    mockBackend({ canManage: true });
    renderWebForms();

    await waitFor(() => {
      expect(screen.getByText('On landing page')).toBeInTheDocument();
    });
    expect(screen.getByRole('checkbox', { name: /Use this form in landing page: Contact Us/i })).toBeInTheDocument();
  });

  it('Leads eye button + landing button both carry hover tooltips', async () => {
    mockBackend({ canManage: true });
    renderWebForms();

    expect(screen.queryByRole('button', { name: /View leads from Contact Us/i })).toBeNull();

    const landingBtn = await screen.findByRole('checkbox', { name: /Use this form in landing page: Contact Us/i });
    expect(landingBtn.closest('label')).toHaveAttribute('data-tip', 'Use Contact Us as the public landing page form');
    expect(landingBtn.closest('label').getAttribute('title')).toContain('Use this form in landing page');

    expect(screen.getByText('On landing page')).toHaveAttribute('data-tip');
  });

  it('clicking Use this form in landing page PUTs the choice and moves the badge', async () => {
    mockBackend({ canManage: true });
    renderWebForms();

    const useBtn = await screen.findByRole('checkbox', { name: /Use this form in landing page: Contact Us/i });
    fireEvent.click(useBtn);

    await waitFor(() => {
      expect(fetchApiMock).toHaveBeenCalledWith(
        '/api/landing-form-config',
        expect.objectContaining({ method: 'PUT' }),
      );
    });
    const putBody = JSON.parse(
      fetchApiMock.mock.calls.find(([url, opts]) => url === '/api/landing-form-config' && opts?.method === 'PUT')[1].body,
    );
    expect(putBody).toEqual({ webFormId: 10 });

    await waitFor(() => {
      const badges = screen.getAllByText('On landing page');
      expect(badges).toHaveLength(1);
    });
    expect(notifySuccess).toHaveBeenCalledWith(expect.stringContaining('Contact Us'));
  });

  it('non-allowlisted login sees no landing controls', async () => {
    mockBackend({ canManage: false });
    renderWebForms();

    await waitFor(() => {
      expect(screen.getByText('Contact Us')).toBeInTheDocument();
    });
    expect(screen.queryByText('On landing page')).toBeNull();
    expect(screen.queryByRole('button', { name: /Use this form in landing page/i })).toBeNull();
  });
});
