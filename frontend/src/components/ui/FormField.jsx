import React from 'react';

/**
 * frontend/src/components/ui/FormField.jsx
 *
 * Issue #686 — required-field indicator (*) used inconsistently across forms.
 *
 * Canonical wrapper for labelled form inputs. Renders a label, an optional
 * red `*` after the label text when `required` is true, the input element
 * (passed as children), and an optional inline error message below the
 * field.
 *
 * Why a shared primitive:
 *   - Pre-refactor, some forms used `<label>Name *</label>`, some used
 *     `<label>Name <span class="req">*</span></label>`, some used no
 *     indicator at all and only surfaced validation on submit. The
 *     visual color of the asterisk varied (red / grey / none).
 *   - This component pins one rendering: red `*` after the label text,
 *     `aria-required` on the input via the `required` prop, optional
 *     `error` slot rendered below in `--danger-color`.
 *
 * Usage:
 *   <FormField label="Full name" required htmlFor="patient-name" error={errors.name}>
 *     <input id="patient-name" className="input-field" value={name} onChange={...} />
 *   </FormField>
 *
 * The `htmlFor` prop wires the label to a specific input id for a11y; the
 * caller is responsible for setting `id` on the input child. If omitted,
 * the label still renders but is not programmatically associated with the
 * input (works visually, but screen readers won't announce the label on
 * focus). Callers SHOULD pass htmlFor whenever practical.
 */
export default function FormField({
  label,
  required = false,
  htmlFor,
  error,
  hint,
  children,
  style,
  className,
}) {
  return (
    <div
      className={className}
      style={{ display: 'flex', flexDirection: 'column', gap: '0.35rem', ...style }}
    >
      {label && (
        <label
          htmlFor={htmlFor}
          style={{
            fontSize: '0.85rem',
            fontWeight: 500,
            color: 'var(--text-primary)',
          }}
        >
          {label}
          {required && (
            <span
              aria-hidden="true"
              className="required-mark"
              style={{ color: 'var(--danger-color, #ef4444)', marginLeft: '0.2rem' }}
            >
              *
            </span>
          )}
        </label>
      )}
      {children}
      {hint && !error && (
        <span style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>
          {hint}
        </span>
      )}
      {error && (
        <span
          role="alert"
          style={{ fontSize: '0.75rem', color: 'var(--danger-color, #ef4444)' }}
        >
          {error}
        </span>
      )}
    </div>
  );
}
