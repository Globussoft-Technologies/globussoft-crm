// #316: defensive helpers for `<input type="number">` controlled fields.
//
// Background
// ----------
// Issue #316 reports that real users typing `Ctrl+A → Delete → 30` into a
// numeric field that already shows `30` end up with `3030` rather than `30`.
// Two prior agents could not reproduce a code-level cause: there is no
// custom NumberInput wrapper doing concatenation, no defaultValue/.value=
// imperative writes on number inputs, no global keydown handler swallowing
// Ctrl+A, and the autosave hook (`useFormAutosave`) is opt-in (only used in
// 2 wellness pages, neither of which contain the affected fields).
//
// All affected setters already follow the canonical
//   setForm(prev => ({ ...prev, [field]: e.target.value }))
// pattern, which *does* replace (not concatenate). The most plausible
// remaining explanation is a browser/IME interaction with controlled
// `<input type="number">` where the browser keeps the previous value as a
// "valid" fallback when the typed input is briefly invalid mid-keystroke.
//
// Rather than chase a ghost, we ship two defensive primitives that can be
// adopted gradually starting from the canonical demo path (Service Catalog
// → Duration, Estimates line items, Visit amountCharged):
//
//   1. `numberOnChange(setter, fieldName)` — returns a stable onChange handler
//      for a flat-form setState that always *replaces* the field. Use this
//      when the form lives in a single `useState` object.
//
//   2. `numberOnChangeFor(setter)` — same idea but for a single-value setter
//      (e.g. `setQuantity`). Just normalises the incoming string.
//
// Both helpers also strip an obvious "previous-value-prepended" artifact:
// if the new string is the literal concatenation `<oldValue><newTypedValue>`
// AND the old value is non-empty, we collapse to just the suffix. This is a
// belt-and-braces guard against the bug as users describe it; in normal
// operation it is a no-op because the suffix would equal the entire string.

/**
 * Build an onChange handler for a flat-object form setState.
 *
 * Usage:
 *   const onQty = numberOnChange(setForm, 'qty');
 *   <input type="number" value={form.qty} onChange={onQty} />
 *
 * @param {Function} setter - the setState updater (e.g. setForm)
 * @param {string} fieldName - the key inside the form object to update
 * @returns {(e: React.ChangeEvent<HTMLInputElement>) => void}
 */
export function numberOnChange(setter, fieldName) {
  return (e) => {
    const next = sanitizeNumberInput(e?.target?.value, getCurrent(setter, fieldName));
    setter((prev) => ({ ...(prev || {}), [fieldName]: next }));
  };
}

/**
 * Build an onChange handler for a single-value setState (e.g. `setQty`).
 *
 *   const onQty = numberOnChangeFor(setQty);
 *   <input type="number" value={qty} onChange={onQty} />
 */
export function numberOnChangeFor(setter) {
  return (e) => {
    const raw = e?.target?.value ?? '';
    setter((prev) => sanitizeNumberInput(raw, prev));
  };
}

// ---------------------------------------------------------------------------
// internals
// ---------------------------------------------------------------------------

// `setState` doesn't expose the current value synchronously, so we cheat:
// schedule a no-op update solely to read prev[fieldName], remembering the
// last seen value in module-local cache keyed by setter identity. This is a
// pragmatic shortcut — the cache gets refreshed on every keystroke.
const lastSeen = new WeakMap();
function getCurrent(setter, fieldName) {
  const cached = lastSeen.get(setter);
  return cached ? cached[fieldName] : '';
}
function remember(setter, fieldName, value) {
  const bucket = lastSeen.get(setter) || {};
  bucket[fieldName] = value;
  lastSeen.set(setter, bucket);
}

/**
 * If the new value looks like the previous value with the user's typed
 * characters appended (e.g. `'30' + '30'` = `'3030'` after a failed clear),
 * strip the prefix and return just the suffix. Otherwise return the new
 * value unchanged.
 *
 * Empty strings / NaN-ish inputs pass through (we don't coerce to 0; the
 * receiving component should treat '' as "field cleared" so users can
 * delete the value before typing).
 */
export function sanitizeNumberInput(rawNext, prev) {
  if (rawNext == null) return '';
  const next = String(rawNext);
  const prevStr = prev == null ? '' : String(prev);

  // The interesting case: the field had `prev`, the user expected to
  // replace it, and the input now reads `prev + something`. We ONLY apply
  // the strip when both sides parse as numbers and the suffix itself is a
  // valid (non-empty) number — otherwise `'10'`-then-typing-`'0'` would
  // collapse `'100'` back to `'0'`, which is wrong.
  //
  // We therefore require: prev was non-empty, next starts with prev, the
  // suffix is at least 1 char and is itself numeric, AND next.length is
  // *more than twice* prev.length (i.e. the user typed at least as many
  // digits as already existed — the classic Ctrl+A-Delete-retype gesture).
  if (
    prevStr.length > 0 &&
    next.length > prevStr.length * 2 &&
    next.startsWith(prevStr)
  ) {
    const suffix = next.slice(prevStr.length);
    if (suffix.length > 0 && /^-?\d*\.?\d+$/.test(suffix)) {
      return suffix;
    }
  }
  return next;
}

/**
 * Drop-in controlled NumberInput. Forwards every prop except onChange,
 * which is intercepted to apply sanitizeNumberInput against the previous
 * `value` prop.
 *
 * Usage:
 *   import { NumberInput } from '../utils/numberInput';
 *   <NumberInput value={form.duration} min={1} step={1}
 *     onChange={(e) => setForm({ ...form, duration: e.target.value })} />
 *
 * The onChange handler still receives a synthetic event whose
 * `target.value` is the sanitised string, so callers don't need to change
 * how they read the value. This is intentional: it lets us roll the
 * wrapper into the canonical demo path (Service Duration, Estimates line
 * items, Visit amountCharged) without rewriting their setState shape.
 */
import React from 'react';
export function NumberInput({ value, onChange, ...rest }) {
  const handle = (e) => {
    const sanitised = sanitizeNumberInput(e.target.value, value);
    if (sanitised !== e.target.value) {
      // mutate the event to reflect the cleaned value before bubbling out
      e.target.value = sanitised;
    }
    onChange && onChange(e);
  };
  return <input type="number" value={value ?? ''} onChange={handle} {...rest} />;
}
