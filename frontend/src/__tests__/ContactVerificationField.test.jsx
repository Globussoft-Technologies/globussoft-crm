import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

import ContactVerificationField from '../components/ContactVerificationField';

const response = (body, ok = true) => Promise.resolve({
  ok,
  json: () => Promise.resolve(body),
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('<ContactVerificationField />', () => {
  it('blocks OTP delivery when the email is already registered', async () => {
    const fetchMock = vi.fn(() => response({ exists: true }));
    vi.stubGlobal('fetch', fetchMock);
    render(<ContactVerificationField purpose="signup" onVerifiedChange={vi.fn()} />);

    fireEvent.change(screen.getByTestId('otp-email'), { target: { value: 'used@example.com' } });
    fireEvent.click(screen.getByTestId('otp-validate'));

    expect(await screen.findByText(/already registered/i)).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith('/api/auth/check-email', expect.any(Object));
  });

  it('requests and verifies an email OTP, returning its token and email', async () => {
    const onVerifiedChange = vi.fn();
    const onContactChange = vi.fn();
    const fetchMock = vi.fn((url) => {
      if (url === '/api/auth/check-email') return response({ exists: false });
      if (url === '/api/auth/email-otp/request') return response({});
      return response({ verificationToken: 'verified-token' });
    });
    vi.stubGlobal('fetch', fetchMock);
    render(
      <ContactVerificationField
        purpose="signup"
        onVerifiedChange={onVerifiedChange}
        onContactChange={onContactChange}
      />,
    );

    fireEvent.change(screen.getByTestId('otp-email'), { target: { value: 'new@example.com' } });
    fireEvent.click(screen.getByTestId('otp-validate'));
    fireEvent.change(await screen.findByTestId('otp-code'), { target: { value: '123456' } });
    fireEvent.click(screen.getByTestId('otp-verify'));

    await waitFor(() => expect(onVerifiedChange).toHaveBeenCalledWith('verified-token'));
    expect(onContactChange).toHaveBeenCalledWith({ type: 'email', value: 'new@example.com' });
    expect(screen.getByTestId('otp-verified')).toBeInTheDocument();
  });
});
