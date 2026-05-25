/**
 * Placeholder.test.jsx — vitest + RTL coverage for the generic Placeholder page.
 *
 * Scope: pins the surface of the tiny 23-LOC stub at frontend/src/pages/Placeholder.jsx
 * used as the React Router fallback for not-yet-built enterprise modules. The
 * SUT derives its heading from `useLocation().pathname` (capitalised first
 * letter), renders a Construction icon from lucide-react, and a fixed
 * "currently under active development" paragraph.
 *
 * Cases:
 *   1. Smoke render — no crash inside MemoryRouter at an arbitrary path
 *   2. Renders the fixed "currently under active development" copy literally
 *   3. Derives the heading from the pathname — "/billing" → "Billing Module"
 *   4. Heading capitalises only the first character — "/customObjects" stays
 *      "CustomObjects Module" (no smart-case, no spacing) to pin the
 *      deliberately-simple `charAt(0).toUpperCase() + slice(1)` contract
 *   5. Renders the Construction icon (lucide-react svg with the
 *      `lucide-construction` class)
 *   6. Re-render idempotency — same path twice → no error + heading stable
 *
 * Pure pin — no source changes. SUT contract is intentionally minimal; the
 * test stays minimal too. If the page grows real behaviour, replace this
 * file with a real test rather than padding it.
 */
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

import Placeholder from '../pages/Placeholder';

function renderAt(path) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Placeholder />
    </MemoryRouter>
  );
}

describe('Placeholder page', () => {
  it('renders without crashing inside MemoryRouter', () => {
    const { container } = renderAt('/anything');
    expect(container.firstChild).toBeTruthy();
  });

  it('renders the fixed under-development copy verbatim', () => {
    renderAt('/billing');
    expect(
      screen.getByText(
        'This enterprise feature is currently under active development and will be available in the upcoming release.'
      )
    ).toBeTruthy();
  });

  it('derives the heading from the pathname — "/billing" → "Billing Module"', () => {
    renderAt('/billing');
    const heading = screen.getByRole('heading', { level: 1 });
    expect(heading.textContent).toBe('Billing Module');
  });

  it('capitalises only the first character of the pathname — no smart-case', () => {
    // SUT contract: pathname.replace('/','') then charAt(0).toUpperCase() + slice(1)
    // — so "customObjects" stays "CustomObjects" (the rest is untouched).
    renderAt('/customObjects');
    const heading = screen.getByRole('heading', { level: 1 });
    expect(heading.textContent).toBe('CustomObjects Module');
  });

  it('renders the lucide-react Construction icon', () => {
    const { container } = renderAt('/billing');
    // lucide-react ships each icon with a stable `lucide-<name>` class on
    // the rendered <svg>.
    const icon = container.querySelector('svg.lucide-construction');
    expect(icon).toBeTruthy();
  });

  it('is idempotent across re-renders at the same path', () => {
    const { rerender } = renderAt('/billing');
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Billing Module');

    // Re-render the same tree — heading should still be present + stable.
    rerender(
      <MemoryRouter initialEntries={['/billing']}>
        <Placeholder />
      </MemoryRouter>
    );
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Billing Module');
  });
});
