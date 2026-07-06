/**
 * FormBlock.test.jsx — vitest coverage for form endpoint selection logic
 *
 * SUT: frontend/src/components/landing-blocks/BasicBlocks.jsx::FormBlock
 *
 * Focuses on testing the critical endpoint selection logic:
 *   1. Uses /api/landing-pages/:id/submit when pageId provided (new authenticated)
 *   2. Uses /api/pages/:slug/submit when pageId not provided (fallback to old)
 *   3. Success response shows thank-you message
 *   4. Error response shows error message
 *   5. Redirect URL from response is handled
 *
 * Pattern: vitest + React Testing Library, minimal assertion brittleness
 */
import { describe, test, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { FormBlock } from '../components/landing-blocks/BasicBlocks';

// Mock fetch globally
global.fetch = vi.fn();

const defaultFields = [
  { name: 'testname', label: 'Name', required: false, type: 'text' },
  { name: 'testemail', label: 'Email', required: false, type: 'email' },
];

const defaultProps = {
  fields: defaultFields,
  submitText: 'Submit Form',
  thankYouMessage: 'Thanks for submitting!',
  enableCaptcha: false,
  successRedirectUrl: '',
};

describe('<FormBlock /> — form submission endpoint routing', () => {
  beforeEach(() => {
    fetch.mockReset();
    delete window.location;
    window.location = { assign: vi.fn() };
  });

  test('renders form with submit button', () => {
    render(
      <FormBlock props={defaultProps} slug="test-page" pageId={null} />
    );
    expect(screen.getByRole('button', { name: /Submit Form/i })).toBeInTheDocument();
  });

  test('routes to /api/landing-pages/:id/submit when pageId provided', async () => {
    fetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ success: true, message: 'OK' }),
    });

    render(
      <FormBlock props={defaultProps} slug="test-page" pageId={456} />
    );

    const submitBtn = screen.getByRole('button', { name: /Submit Form/i });
    fireEvent.click(submitBtn);

    await waitFor(() => {
      expect(fetch).toHaveBeenCalledWith(
        '/api/landing-pages/456/submit',
        expect.any(Object)
      );
    });
  });

  test('routes to /api/pages/:slug/submit when pageId not provided', async () => {
    fetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ success: true, message: 'OK' }),
    });

    render(
      <FormBlock props={defaultProps} slug="fallback-page" pageId={null} />
    );

    const submitBtn = screen.getByRole('button', { name: /Submit Form/i });
    fireEvent.click(submitBtn);

    await waitFor(() => {
      expect(fetch).toHaveBeenCalledWith(
        '/api/pages/fallback-page/submit',
        expect.any(Object)
      );
    });
  });

  test('shows thank-you message on successful submission', async () => {
    fetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ success: true, message: 'OK' }),
    });

    render(
      <FormBlock props={defaultProps} slug="test-page" pageId={123} />
    );

    const submitBtn = screen.getByRole('button', { name: /Submit Form/i });
    fireEvent.click(submitBtn);

    await waitFor(() => {
      expect(screen.getByText(/Thanks for submitting!/i)).toBeInTheDocument();
    });
  });

  test('shows error message on failed submission', async () => {
    fetch.mockResolvedValueOnce({
      ok: false,
      json: async () => ({ error: 'Email is invalid' }),
    });

    render(
      <FormBlock props={defaultProps} slug="test-page" pageId={123} />
    );

    const submitBtn = screen.getByRole('button', { name: /Submit Form/i });
    fireEvent.click(submitBtn);

    await waitFor(() => {
      expect(screen.getByText(/Email is invalid/i)).toBeInTheDocument();
    });
  });

  test('handles network errors gracefully', async () => {
    fetch.mockRejectedValueOnce(new Error('Network failure'));

    render(
      <FormBlock props={defaultProps} slug="test-page" pageId={123} />
    );

    const submitBtn = screen.getByRole('button', { name: /Submit Form/i });
    fireEvent.click(submitBtn);

    await waitFor(() => {
      expect(screen.getByText(/Something went wrong/i)).toBeInTheDocument();
    });
  });

  test('redirects to URL from response.successRedirectUrl when it is valid', async () => {
    fetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        success: true,
        message: 'OK',
        successRedirectUrl: 'https://example.com/confirmation',
      }),
    });

    render(
      <FormBlock props={defaultProps} slug="test-page" pageId={123} />
    );

    const submitBtn = screen.getByRole('button', { name: /Submit Form/i });
    fireEvent.click(submitBtn);

    // window.location.assign is called after async response
    await waitFor(() => {
      expect(window.location.assign).toHaveBeenCalledWith('https://example.com/confirmation');
    });
  });

  test('handles relative redirect URLs safely', async () => {
    fetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        success: true,
        message: 'OK',
        successRedirectUrl: '/relative/path',
      }),
    });

    render(
      <FormBlock props={defaultProps} slug="test-page" pageId={123} />
    );

    const submitBtn = screen.getByRole('button', { name: /Submit Form/i });
    fireEvent.click(submitBtn);

    await waitFor(() => {
      // Relative URLs are not valid per the new URL() constructor
      // So they should fall through to thank-you message
      expect(screen.getByText(/Thanks for submitting!/i)).toBeInTheDocument();
    });
  });

  test('does not redirect for invalid URLs (XSS protection)', async () => {
    fetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        success: true,
        message: 'OK',
        successRedirectUrl: 'javascript:alert(1)',
      }),
    });

    render(
      <FormBlock props={defaultProps} slug="test-page" pageId={123} />
    );

    const submitBtn = screen.getByRole('button', { name: /Submit Form/i });
    fireEvent.click(submitBtn);

    await waitFor(() => {
      // Should show thank-you instead of redirecting to malicious URL
      expect(screen.getByText(/Thanks for submitting!/i)).toBeInTheDocument();
      expect(window.location.assign).not.toHaveBeenCalled();
    });
  });

  test('button shows loading state while submitting', async () => {
    fetch.mockImplementationOnce(
      () => new Promise(resolve => setTimeout(() => {
        resolve({
          ok: true,
          json: async () => ({ success: true, message: 'OK' }),
        });
      }, 200))
    );

    render(
      <FormBlock props={defaultProps} slug="test-page" pageId={123} />
    );

    const submitBtn = screen.getByRole('button', { name: /Submit Form/i });
    fireEvent.click(submitBtn);

    // Button should show loading state
    await waitFor(() => {
      expect(submitBtn.textContent).toMatch(/Submitting/i);
    });
  });

  test('sends form data as JSON in request body', async () => {
    fetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ success: true, message: 'OK' }),
    });

    render(
      <FormBlock props={defaultProps} slug="test-page" pageId={123} />
    );

    const submitBtn = screen.getByRole('button', { name: /Submit Form/i });
    fireEvent.click(submitBtn);

    await waitFor(() => {
      const call = fetch.mock.calls[0];
      expect(call[1].method).toBe('POST');
      expect(call[1].headers['Content-Type']).toBe('application/json');
    });
  });
});
