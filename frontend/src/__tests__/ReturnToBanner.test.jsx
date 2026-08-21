/**
 * ReturnToBanner.test.jsx — the drill-down return affordance shared by the
 * Leads and Contacts pages (frontend/src/components/ReturnToBanner.jsx).
 *
 * Two jobs, both worth pinning:
 *   1. Give a reader who arrived from a report a way back to it.
 *   2. Say WHICH filter was applied — otherwise a drill-down that matches
 *      nothing looks like a broken, empty page.
 *
 * `returnTo` comes from the URL, so it is attacker-controllable; the
 * open-redirect guard is the security-relevant case here.
 */
import React from 'react';
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

import ReturnToBanner, { isSafeInternalPath } from '../components/ReturnToBanner';

const at = (search) =>
  render(
    <MemoryRouter initialEntries={[`/leads${search}`]}>
      <ReturnToBanner />
    </MemoryRouter>,
  );

describe('ReturnToBanner — visibility', () => {
  it('renders nothing on a normal visit', () => {
    const { container } = at('');
    expect(container).toBeEmptyDOMElement();
  });

  it('renders a back link when returnTo is present', () => {
    at('?returnTo=%2Flead-reports&returnLabel=Lead%20Funnel');
    const link = screen.getByRole('link', { name: /Back to Lead Funnel/i });
    expect(link).toHaveAttribute('href', '/lead-reports');
  });

  it('falls back to generic wording when no label is supplied', () => {
    at('?returnTo=%2Flead-reports');
    expect(screen.getByRole('link', { name: /Back to the previous page/i })).toBeInTheDocument();
  });
});

describe('ReturnToBanner — open-redirect guard', () => {
  it.each([
    ['//evil.com', 'protocol-relative'],
    ['https://evil.com', 'absolute URL'],
    ['javascript:alert(1)', 'javascript scheme'],
    ['/\\evil.com', 'backslash protocol-relative'],
    ['leads', 'relative path'],
  ])('refuses %s (%s)', (value) => {
    const { container } = at(`?returnTo=${encodeURIComponent(value)}`);
    expect(container).toBeEmptyDOMElement();
  });

  it('isSafeInternalPath accepts only same-origin absolute paths', () => {
    expect(isSafeInternalPath('/leads')).toBe(true);
    expect(isSafeInternalPath('/lead-reports?tab=funnel')).toBe(true);
    expect(isSafeInternalPath('//evil.com')).toBe(false);
    expect(isSafeInternalPath('https://evil.com')).toBe(false);
    expect(isSafeInternalPath('')).toBe(false);
    expect(isSafeInternalPath(null)).toBe(false);
  });
});

describe('ReturnToBanner — explains the applied filter', () => {
  it('names a call-status filter in plain English', () => {
    at('?callStatus=qualified&returnTo=%2Flead-reports&returnLabel=Lead%20Funnel');
    expect(screen.getByText(/call status is Qualified/)).toBeInTheDocument();
    expect(screen.getByText(/Clear the filters below/)).toBeInTheDocument();
  });

  it('translates the internal yet_to_call value', () => {
    at('?callStatus=yet_to_call&returnTo=%2Flead-reports');
    expect(screen.getByText(/call status is not called yet/)).toBeInTheDocument();
  });

  it('names a lifecycle-status filter', () => {
    at('?status=Customer&returnTo=%2Flead-reports');
    expect(screen.getByText(/status is Customer/)).toBeInTheDocument();
  });

  it('names a source filter', () => {
    at('?source=Website&returnTo=%2Flead-reports');
    expect(screen.getByText(/source is Website/)).toBeInTheDocument();
  });

  it('spells out the unassigned case rather than showing a raw token', () => {
    at('?assignee=unassigned&returnTo=%2Flead-reports');
    expect(screen.getByText(/nobody is assigned/)).toBeInTheDocument();
  });

  it('joins multiple filters', () => {
    at('?source=Website&callStatus=junk&returnTo=%2Flead-reports');
    expect(screen.getByText(/call status is Junk and source is Website/)).toBeInTheDocument();
  });

  it('falls back to generic copy when no known filter is carried', () => {
    at('?returnTo=%2Flead-reports&returnLabel=Report');
    expect(screen.getByText(/Filters below were applied from there/)).toBeInTheDocument();
  });
});
