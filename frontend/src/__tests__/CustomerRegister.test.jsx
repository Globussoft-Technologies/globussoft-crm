import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

const navigateMock = vi.fn();

vi.mock('react-router-dom', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    useNavigate: () => navigateMock,
  };
});

vi.mock('../utils/api', () => ({ setAuthToken: vi.fn(), fetchApi: vi.fn() }));
vi.mock('../hooks/usePermissions', () => ({ invalidatePermissionCache: vi.fn() }));

import { AuthContext } from '../App';
import CustomerRegister from '../pages/CustomerRegister';

const TENANTS = [
  { id: 11, name: 'Dr. Enhanced Wellness', slug: 'dr-enhanced-wellness', vertical: 'wellness' },
  { id: 12, name: 'Dr. Enhanced Wellness South', slug: 'dr-enhanced-wellness-south', vertical: 'wellness' },
  { id: 13, name: 'Globussoft', slug: 'globussoft', vertical: 'generic' },
];

function fetchResponse(body, status = 200) {
  return Promise.resolve({
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
  });
}

function renderPage(url = '/customer/register') {
  const authValue = {
    user: null,
    token: '',
    tenant: null,
    setUser: vi.fn(),
    setToken: vi.fn(),
    setTenant: vi.fn(),
  };

  return render(
    <MemoryRouter initialEntries={[url]}>
      <AuthContext.Provider value={authValue}>
        <CustomerRegister />
      </AuthContext.Provider>
    </MemoryRouter>,
  );
}

function installCustomerRegisterFetch() {
  global.fetch = vi.fn(async (url) => {
    const path = String(url);
    if (path.startsWith('/api/auth/public/tenants')) {
      return fetchResponse(TENANTS);
    }
    if (path.startsWith('/api/auth/check-email')) {
      return fetchResponse({ exists: false });
    }
    if (path.startsWith('/api/auth/email-otp/request')) {
      return fetchResponse({ devCode: '123456' }, 201);
    }
    if (path.startsWith('/api/auth/email-otp/verify')) {
      return fetchResponse({ verificationToken: 'email-verified-token' });
    }
    if (path.startsWith('/api/auth/customer/register')) {
      return fetchResponse({
        token: 'jwt-new',
        user: { userId: 99, email: 'jane@example.com', role: 'CUSTOMER' },
        tenant: { id: 11, name: 'Dr. Enhanced Wellness', vertical: 'wellness' },
      });
    }
    return fetchResponse({ error: 'not mocked' }, 404);
  });
}

describe('<CustomerRegister /> organization autocomplete', () => {
  let originalFetch;

  beforeEach(() => {
    navigateMock.mockReset();
    originalFetch = global.fetch;
    installCustomerRegisterFetch();
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('shows typeahead suggestions and lets a picked organization complete registration', async () => {
    renderPage();

    const orgInput = await screen.findByLabelText(/Organization/i);
    fireEvent.change(orgInput, { target: { value: 'Dr Enh' } });

    const listbox = await screen.findByRole('listbox');
    expect(listbox).toHaveStyle({ background: 'var(--modal-bg)' });
    expect(await screen.findByRole('option', { name: 'Dr. Enhanced Wellness' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'Dr. Enhanced Wellness South' })).toBeInTheDocument();

    fireEvent.mouseDown(screen.getByRole('option', { name: 'Dr. Enhanced Wellness' }));

    fireEvent.change(screen.getByLabelText(/Email Address/i), { target: { value: 'jane@example.com' } });
    fireEvent.click(screen.getByTestId('otp-validate'));

    await waitFor(() => {
      expect(screen.getByTestId('otp-box')).toBeInTheDocument();
    });

    fireEvent.change(screen.getByTestId('otp-code'), { target: { value: '123456' } });
    fireEvent.click(screen.getByTestId('otp-verify'));

    await waitFor(() => {
      expect(screen.getByTestId('otp-verified')).toBeInTheDocument();
    });

    fireEvent.change(screen.getByLabelText(/Full name/i), { target: { value: 'Jane Doe' } });
    fireEvent.change(screen.getByLabelText(/^Password$/i), { target: { value: 'Secret123' } });
    fireEvent.change(screen.getByLabelText(/Confirm password/i), { target: { value: 'Secret123' } });
    fireEvent.click(screen.getByRole('button', { name: /Create account/i }));

    await waitFor(() => {
      expect(navigateMock).toHaveBeenCalledWith('/wellness');
    });

    const registerCall = global.fetch.mock.calls.find(([url]) => String(url).startsWith('/api/auth/customer/register'));
    expect(registerCall).toBeTruthy();
    expect(JSON.parse(registerCall[1].body)).toMatchObject({
      email: 'jane@example.com',
      name: 'Jane Doe',
      registrationTenantId: 11,
    });
  });

  it('renders the empty suggestion state on the same opaque theme-aware surface', async () => {
    renderPage();

    const orgInput = await screen.findByLabelText(/Organization/i);
    fireEvent.change(orgInput, { target: { value: 'zzzz' } });

    const status = await screen.findByRole('status');
    expect(status).toHaveStyle({ background: 'var(--modal-bg)' });
    expect(status).toHaveTextContent(/No matching organizations found/i);
  });

  it('keeps organization suggestions hidden until at least three characters are typed', async () => {
    renderPage();

    const orgInput = await screen.findByLabelText(/Organization/i);
    fireEvent.change(orgInput, { target: { value: 'e' } });

    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    expect(screen.queryByRole('option', { name: 'Dr. Enhanced Wellness' })).not.toBeInTheDocument();

    fireEvent.change(orgInput, { target: { value: 'enh' } });

    expect(await screen.findByRole('option', { name: 'Dr. Enhanced Wellness' })).toBeInTheDocument();
  });

  it('accepts a near-exact organization name without punctuation and lets email validation proceed', async () => {
    renderPage();

    fireEvent.change(await screen.findByLabelText(/Organization/i), {
      target: { value: 'Dr Enhanced Wellness' },
    });

    fireEvent.change(screen.getByLabelText(/Email Address/i), { target: { value: 'jane@example.com' } });
    fireEvent.click(screen.getByTestId('otp-validate'));

    await waitFor(() => {
      expect(screen.getByTestId('otp-box')).toBeInTheDocument();
    });

    const checkEmailCall = global.fetch.mock.calls.find(([url]) => String(url).startsWith('/api/auth/check-email'));
    expect(checkEmailCall).toBeTruthy();
    expect(JSON.parse(checkEmailCall[1].body)).toMatchObject({
      email: 'jane@example.com',
      registrationTenantId: 11,
    });
    expect(screen.queryByText(/Select your organization first/i)).not.toBeInTheDocument();
  });
});
