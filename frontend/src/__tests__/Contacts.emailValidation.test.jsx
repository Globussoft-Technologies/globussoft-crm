/**
 * Contacts.jsx — client-side email validation on Add Contact (#607).
 *
 * Pre-fix: the Add Contact form had no client-side validator. Invalid
 * emails round-tripped to the server, returned a generic 400, and the
 * user saw a toast that didn't point at the email field. Mobile users
 * also got the alphabet-only keyboard because the input lacked
 * type="email".
 *
 * Fix: input is type="email" (was already), plus an onBlur handler that
 * validates against EMAIL_RE (the same regex the CSV importer uses) and
 * surfaces an inline "Please enter a valid email address" error when the
 * field is invalid. Submit handler short-circuits on invalid email so the
 * network call is NOT fired.
 *
 * Contracts pinned here:
 *   1. Submitting the form with an invalid email does NOT call fetchApi
 *      POST /api/contacts.
 *   2. Submitting with an invalid email shows an inline error message
 *      "Please enter a valid email address".
 *   3. Blurring the email field with an invalid value surfaces the same
 *      inline error.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

const fetchApiMock = vi.fn();
vi.mock('../utils/api', () => ({
  fetchApi: (...args) => fetchApiMock(...args),
}));

vi.mock('../utils/notify', () => ({
  useNotify: () => ({
    error: vi.fn(),
    success: vi.fn(),
    info: vi.fn(),
    confirm: () => Promise.resolve(true),
    prompt: () => Promise.resolve(''),
  }),
}));

import Contacts from '../pages/Contacts';

beforeEach(() => {
  fetchApiMock.mockReset();
  fetchApiMock.mockImplementation((url) => {
    if (url === '/api/contacts') return Promise.resolve([]);
    if (url === '/api/staff') return Promise.resolve([]);
    return Promise.resolve(null);
  });
});

function renderContacts() {
  return render(
    <MemoryRouter>
      <Contacts />
    </MemoryRouter>,
  );
}

async function openAddContactModal() {
  const btn = await screen.findByRole('button', { name: /Add Contact/i });
  fireEvent.click(btn);
}

function getPostCalls() {
  return fetchApiMock.mock.calls.filter(
    ([url, opts]) => url === '/api/contacts' && opts?.method === 'POST',
  );
}

describe('Contacts.jsx — Add Contact email validation (#607)', () => {
  // Fire `submit` on the form directly. The HTML5 `required` + `type=email`
  // attributes mean a button-click in jsdom may short-circuit on native
  // validation before React's onSubmit fires; firing the submit event
  // directly bypasses that and exercises the handler we want to pin.
  function submitAddContactForm() {
    const form = screen.getByPlaceholderText('Email').closest('form');
    fireEvent.submit(form);
  }

  it('does NOT POST /api/contacts when the email is invalid', async () => {
    renderContacts();
    await openAddContactModal();

    fireEvent.change(screen.getByPlaceholderText('Name'), { target: { value: 'Aarav Sharma' } });
    fireEvent.change(screen.getByPlaceholderText('Email'), { target: { value: 'not-an-email' } });
    fireEvent.change(screen.getByPlaceholderText('Company'), { target: { value: 'Acme' } });

    submitAddContactForm();

    // Wait a tick to make sure no async POST slips through.
    await new Promise(r => setTimeout(r, 20));
    expect(getPostCalls()).toHaveLength(0);
  });

  it('shows the inline "Please enter a valid email address" error on submit with invalid email', async () => {
    renderContacts();
    await openAddContactModal();

    fireEvent.change(screen.getByPlaceholderText('Name'), { target: { value: 'Aarav Sharma' } });
    fireEvent.change(screen.getByPlaceholderText('Email'), { target: { value: 'not-an-email' } });
    fireEvent.change(screen.getByPlaceholderText('Company'), { target: { value: 'Acme' } });

    submitAddContactForm();

    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent(/Please enter a valid email address/i);
    });
  });

  it('surfaces the inline error on blur when the email is invalid', async () => {
    renderContacts();
    await openAddContactModal();

    const emailInput = screen.getByPlaceholderText('Email');
    fireEvent.change(emailInput, { target: { value: 'bad@' } });
    fireEvent.blur(emailInput);

    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent(/Please enter a valid email address/i);
    });
  });

  it('clears the inline error and POSTs when the email is corrected and re-submitted', async () => {
    renderContacts();
    await openAddContactModal();

    fireEvent.change(screen.getByPlaceholderText('Name'), { target: { value: 'Aarav Sharma' } });
    const emailInput = screen.getByPlaceholderText('Email');
    fireEvent.change(emailInput, { target: { value: 'not-an-email' } });
    fireEvent.blur(emailInput);
    await waitFor(() => expect(screen.queryByRole('alert')).toBeInTheDocument());

    // Correct the value.
    fireEvent.change(emailInput, { target: { value: 'aarav@example.com' } });
    fireEvent.change(screen.getByPlaceholderText('Company'), { target: { value: 'Acme' } });

    submitAddContactForm();

    await waitFor(() => expect(getPostCalls()).toHaveLength(1));
    const body = JSON.parse(getPostCalls()[0][1].body);
    expect(body.email).toBe('aarav@example.com');
  });
});
