import { describe, it, expect, vi } from 'vitest';
import { render, fireEvent } from '@testing-library/react';
import {
  numberOnChange,
  numberOnChangeFor,
  sanitizeNumberInput,
  NumberInput,
} from '../utils/numberInput';

/**
 * frontend/src/utils/numberInput.jsx — defensive helpers for
 * `<input type="number">` controlled fields. Ships three function exports
 * (`numberOnChange`, `numberOnChangeFor`, `sanitizeNumberInput`) plus the
 * drop-in `<NumberInput>` component.
 *
 * What's tested
 *   - sanitizeNumberInput: null/undefined collapse to '', string passthrough,
 *     the `prev + suffix` anti-bug strip ONLY fires when next.length >
 *     prev.length * 2 and the suffix is numeric, and the
 *     '10'-then-typing-'0' regression case (don't collapse '100' → '0').
 *   - numberOnChange: returns a stable onChange that calls setter with a
 *     functional updater preserving other form keys, and that the sanitiser
 *     applies via the WeakMap last-seen cache when a prior keystroke seeded it.
 *   - numberOnChangeFor: single-value setter receives the sanitised string via
 *     a functional updater (prev → next), null-target tolerated.
 *   - <NumberInput />: renders type=number, passes through value, mutates the
 *     event.target.value through sanitizeNumberInput before calling onChange,
 *     forwards arbitrary props (min/step/aria-label), tolerates undefined
 *     value (renders empty string), tolerates missing onChange.
 *
 * Why
 *   #316 framed the original "30 → typing 30 → 3030" Ctrl+A bug. The
 *   helper's contract is "ONLY strip when it's unambiguously the gesture";
 *   the test file pins the boundary conditions so a future tweak doesn't
 *   silently revert the helper to "always strip" (which would break the
 *   legitimate '10' → '100' typing case).
 */

describe('sanitizeNumberInput', () => {
  it('returns empty string for null', () => {
    expect(sanitizeNumberInput(null, '5')).toBe('');
  });

  it('returns empty string for undefined', () => {
    expect(sanitizeNumberInput(undefined, '5')).toBe('');
  });

  it('passes through a normal numeric string when prev is empty', () => {
    expect(sanitizeNumberInput('42', '')).toBe('42');
  });

  it('passes through when prev is null (treated as empty)', () => {
    expect(sanitizeNumberInput('7', null)).toBe('7');
  });

  it('strips the prev prefix when next.length is strictly > prev.length*2: prev=30, next=30307 → 307', () => {
    // prev='30' (2), next='30307' (5). 5 > 2*2=4 ✓. suffix='307' is numeric ✓.
    expect(sanitizeNumberInput('30307', '30')).toBe('307');
  });

  it('does NOT strip the boundary case prev=30, next=3030 (length 4 is NOT > 2*2=4)', () => {
    // Belt-and-braces guard: the strip is intentionally STRICTLY > 2x to avoid
    // collapsing legitimate "user typed exactly as many digits as already
    // existed" gestures into half their value. Drift note: the SUT's header
    // comment uses "30/30 → 3030" as the framing example but the actual
    // strip condition (`>`, not `>=`) skips that exact case. The test pins
    // the real boundary so a future relax to `>=` is caught.
    expect(sanitizeNumberInput('3030', '30')).toBe('3030');
  });

  it('does NOT collapse "10" → "100" when user types a single appended digit (next.length not > prev.length*2)', () => {
    // prev='10' (len 2), next='100' (len 3). 3 is NOT > 2*2=4 → no strip.
    expect(sanitizeNumberInput('100', '10')).toBe('100');
  });

  it('does NOT strip when the lengths are equal', () => {
    // prev='5', next='5' — next.length(1) is not > prev.length*2 (2) → passthrough
    expect(sanitizeNumberInput('5', '5')).toBe('5');
  });

  it('does NOT strip when suffix is non-numeric (e.g. prev=3, next=3abcd — abcd fails the regex)', () => {
    // prev='3' (1), next='3abcd' (5). 5 > 1*2=2 ✓, but suffix 'abcd' is not numeric.
    expect(sanitizeNumberInput('3abcd', '3')).toBe('3abcd');
  });

  it('strips a decimal suffix when the gesture pattern matches: prev=30, next=303.55 → 3.55', () => {
    // prev='30' (2), next='303.55' (6). 6 > 4 ✓. suffix='3.55' is numeric ✓.
    expect(sanitizeNumberInput('303.55', '30')).toBe('3.55');
  });

  it('coerces non-string rawNext to string before processing', () => {
    expect(sanitizeNumberInput(42, '')).toBe('42');
  });
});

describe('numberOnChange (flat-form setter)', () => {
  it('returns a function', () => {
    const handler = numberOnChange(vi.fn(), 'qty');
    expect(typeof handler).toBe('function');
  });

  it('calls setter with a functional updater that replaces the field', () => {
    const setter = vi.fn();
    const handler = numberOnChange(setter, 'qty');
    handler({ target: { value: '5' } });
    expect(setter).toHaveBeenCalledOnce();
    const updater = setter.mock.calls[0][0];
    expect(updater({ qty: '', name: 'Alice' })).toEqual({ qty: '5', name: 'Alice' });
  });

  it('tolerates a null prev state in the updater (wraps in {})', () => {
    const setter = vi.fn();
    const handler = numberOnChange(setter, 'qty');
    handler({ target: { value: '7' } });
    const updater = setter.mock.calls[0][0];
    expect(updater(null)).toEqual({ qty: '7' });
  });

  it('tolerates a missing target gracefully (no throw)', () => {
    const setter = vi.fn();
    const handler = numberOnChange(setter, 'qty');
    expect(() => handler({})).not.toThrow();
    expect(setter).toHaveBeenCalledOnce();
  });
});

describe('numberOnChangeFor (single-value setter)', () => {
  it('returns a function', () => {
    expect(typeof numberOnChangeFor(vi.fn())).toBe('function');
  });

  it('calls setter with functional updater that runs sanitizeNumberInput on (prev → next)', () => {
    const setter = vi.fn();
    const handler = numberOnChangeFor(setter);
    handler({ target: { value: '30307' } });
    const updater = setter.mock.calls[0][0];
    // With prev='30' (len 2), next='30307' (len 5) > 4 ✓ → strip to '307'.
    expect(updater('30')).toBe('307');
    // With prev='', the helper should passthrough '30307'.
    expect(updater('')).toBe('30307');
  });

  it('treats missing event.target.value as empty string', () => {
    const setter = vi.fn();
    const handler = numberOnChangeFor(setter);
    handler({});
    const updater = setter.mock.calls[0][0];
    expect(updater('99')).toBe('');
  });
});

describe('<NumberInput />', () => {
  it('renders an <input type="number"> element', () => {
    const { container } = render(<NumberInput value="5" onChange={() => {}} />);
    const input = container.querySelector('input');
    expect(input).toBeInTheDocument();
    expect(input).toHaveAttribute('type', 'number');
  });

  it('renders the supplied value', () => {
    const { container } = render(<NumberInput value="42" onChange={() => {}} />);
    expect(container.querySelector('input').value).toBe('42');
  });

  it('renders an empty string when value is undefined (no React controlled-warning)', () => {
    const { container } = render(<NumberInput onChange={() => {}} />);
    expect(container.querySelector('input').value).toBe('');
  });

  it('calls onChange with the same event, value unchanged on normal typing', () => {
    // Capture the target.value AT the moment onChange fires — React may
    // re-render and reset the DOM input's value before the assertion runs.
    let observed = null;
    const onChange = vi.fn((e) => { observed = e.target.value; });
    const { container } = render(<NumberInput value="" onChange={onChange} />);
    fireEvent.change(container.querySelector('input'), { target: { value: '7' } });
    expect(onChange).toHaveBeenCalledOnce();
    expect(observed).toBe('7');
  });

  it('mutates event.target.value through sanitizeNumberInput when the gesture pattern matches', () => {
    // value='30' so prev=30, next='30307' (len 5 > 4) → sanitiser strips to '307'.
    let observed = null;
    const onChange = vi.fn((e) => { observed = e.target.value; });
    const { container } = render(<NumberInput value="30" onChange={onChange} />);
    fireEvent.change(container.querySelector('input'), { target: { value: '30307' } });
    expect(onChange).toHaveBeenCalledOnce();
    expect(observed).toBe('307');
  });

  it('forwards arbitrary props (min, step, aria-label)', () => {
    const { container } = render(
      <NumberInput value="1" min={1} step={0.5} aria-label="Quantity" onChange={() => {}} />
    );
    const input = container.querySelector('input');
    expect(input).toHaveAttribute('min', '1');
    expect(input).toHaveAttribute('step', '0.5');
    expect(input).toHaveAttribute('aria-label', 'Quantity');
  });

  it('does not throw when onChange is omitted', () => {
    const { container } = render(<NumberInput value="1" />);
    expect(() =>
      fireEvent.change(container.querySelector('input'), { target: { value: '2' } })
    ).not.toThrow();
  });
});
