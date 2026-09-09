/**
 * DiagnosticFormRenderer.jsx — shared diagnostic form renderer (used by the
 * public form, admin preview, embed widget parity, etc).
 *
 * Pins the "text position" styling controls added 2026-09-08 (surfaced in
 * DiagnosticPublicFormPanel's "Question cards" section as "Question text
 * position" / "Option text position" / "Question title vertical position"):
 *   - styling.questionAlign sets text-align on the visible question title
 *     (default "left")
 *   - styling.optionAlign sets justify-content on each option row, moving
 *     the marker + label as one group rather than just the text (default
 *     "left" / flex-start)
 *   - styling.questionTitleOffset (px, default 0) sets `top` (with
 *     position: relative) on the visible question title — NOT margin-top,
 *     which pushed every sibling below it (and so the whole card, and the
 *     whole form) down instead of just moving the title text
 *
 * DOM shape pinned by this file (2026-09-08 rewrite): each question renders
 * a visually-hidden <legend> (still gives the <fieldset> a real accessible
 * name for screen readers) PLUS a separate, visible `data-testid=
 * "question-title"` <div> that carries all of the above styling. An
 * earlier version styled the <legend> itself directly — abandoned because
 * (1) painting a background on a full-width straddling legend read as an
 * unwanted colored bar the moment the card had any fill/tint, and (2) some
 * browsers don't reliably honor margin-top on a legend, so the position
 * slider had no visible effect. Assert against the visible title div, not
 * the (now visually-hidden, unstyled) legend.
 */
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import DiagnosticFormRenderer from '../components/travel/DiagnosticFormRenderer';

const QUESTIONS = [
  {
    id: 'q1',
    text: 'Approximate group size (students)?',
    type: 'single-choice',
    options: [
      { value: 'under20', label: 'Under 20' },
      { value: '20-50', label: '20-50' },
    ],
  },
];

function baseConfig(stylingConfigJson) {
  return {
    form: {
      title: 'Diagnostic Form',
      stylingConfigJson,
    },
  };
}

function renderForm(stylingConfigJson) {
  render(
    <DiagnosticFormRenderer
      config={baseConfig(stylingConfigJson)}
      questions={QUESTIONS}
      answers={{}}
      mode="preview"
      preview
    />,
  );
  return screen.getByTestId('question-title');
}

describe('DiagnosticFormRenderer — question title is a normal in-flow element, not a styled <legend>', () => {
  it('the fieldset still has a real (visually-hidden) accessible name via <legend>', () => {
    renderForm(undefined);
    const legend = document.querySelector('fieldset > legend');
    expect(legend).toBeTruthy();
    expect(legend.textContent).toContain('Approximate group size (students)?');
    // sr-only clipping, not display:none — stays in the accessibility tree.
    expect(legend.style.position).toBe('absolute');
    expect(legend.style.width).toBe('1px');
  });

  it('the visible title carries no background (no more "colored bar" behind the text)', () => {
    const title = renderForm(undefined);
    expect(title.style.background).toBe('');
  });
});

describe('DiagnosticFormRenderer — question text position', () => {
  it('defaults to left-aligned when no styling is set', () => {
    const title = renderForm(undefined);
    expect(title.style.textAlign).toBe('left');
  });

  it('applies a center question alignment from styling.questionAlign', () => {
    const title = renderForm(JSON.stringify({ questionAlign: 'center' }));
    expect(title.style.textAlign).toBe('center');
  });
});

describe('DiagnosticFormRenderer — question title vertical position', () => {
  it('defaults to top: 0, positioned relatively (not margin — must not push sibling content)', () => {
    const title = renderForm(undefined);
    expect(title.style.position).toBe('relative');
    expect(title.style.top).toBe('0px');
    expect(title.style.marginTop).toBe('');
  });

  it('applies a positive styling.questionTitleOffset to move the title down via `top`', () => {
    const title = renderForm(JSON.stringify({ questionTitleOffset: 24 }));
    expect(title.style.top).toBe('24px');
  });

  it('applies a negative styling.questionTitleOffset to float the title up via `top`', () => {
    const title = renderForm(JSON.stringify({ questionTitleOffset: -8 }));
    expect(title.style.top).toBe('-8px');
  });
});

describe('DiagnosticFormRenderer — option text position', () => {
  it('defaults to left (flex-start) when no styling is set', () => {
    renderForm(undefined);
    const optionRow = screen.getByText('Under 20').closest('label');
    expect(optionRow.style.justifyContent).toBe('flex-start');
  });

  it('applies a right option alignment from styling.optionAlign', () => {
    renderForm(JSON.stringify({ optionAlign: 'right' }));
    const optionRow = screen.getByText('Under 20').closest('label');
    expect(optionRow.style.justifyContent).toBe('flex-end');
  });

  it('applies a center option alignment from styling.optionAlign', () => {
    renderForm(JSON.stringify({ optionAlign: 'center' }));
    const optionRow = screen.getByText('Under 20').closest('label');
    expect(optionRow.style.justifyContent).toBe('center');
  });
});
