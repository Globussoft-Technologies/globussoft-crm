import { forwardRef, useState } from 'react';
import { Eye, EyeOff } from 'lucide-react';

/**
 * Password input with show/hide toggle. Forwards every prop (value,
 * onChange, placeholder, autoComplete, className, style, etc.) to the
 * underlying <input>; the only extras are the relatively-positioned
 * wrapper and the eye-icon button.
 *
 * Default type is 'password' — assertions like
 * `expect(input.getAttribute('type')).toBe('password')` continue to
 * pass on initial mount (the type only flips to 'text' after the user
 * clicks the toggle).
 *
 * Icon color uses --text-secondary (muted) and shifts to
 * --primary-color (wellness teal) / --accent-color (generic blue) on
 * hover + focus, so it inherits the active vertical theme automatically.
 */
const PasswordInput = forwardRef(function PasswordInput(
  { className = 'input-field', style, wrapperStyle, ...rest },
  ref,
) {
  const [visible, setVisible] = useState(false);
  return (
    <div
      style={{
        position: 'relative',
        display: 'block',
        width: '100%',
        ...wrapperStyle,
      }}
    >
      <input
        {...rest}
        ref={ref}
        type={visible ? 'text' : 'password'}
        className={className}
        // paddingRight is enforced last so the eye-icon button always has
        // room — caller `style` (which may use the `padding` shorthand)
        // cannot accidentally clobber it.
        style={{ width: '100%', ...style, paddingRight: '2.5rem' }}
      />
      <button
        type="button"
        onClick={() => setVisible((v) => !v)}
        aria-label={visible ? 'Hide password' : 'Show password'}
        title={visible ? 'Hide password' : 'Show password'}
        tabIndex={-1}
        style={{
          position: 'absolute',
          right: '0.6rem',
          top: '50%',
          transform: 'translateY(-50%)',
          background: 'transparent',
          border: 'none',
          padding: '0.25rem',
          cursor: 'pointer',
          color: 'var(--text-secondary)',
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          lineHeight: 1,
          borderRadius: 4,
          transition: 'color 0.15s ease',
        }}
        onMouseEnter={(e) => {
          e.currentTarget.style.color =
            'var(--primary-color, var(--accent-color))';
        }}
        onMouseLeave={(e) => {
          e.currentTarget.style.color = 'var(--text-secondary)';
        }}
        onFocus={(e) => {
          e.currentTarget.style.color =
            'var(--primary-color, var(--accent-color))';
        }}
        onBlur={(e) => {
          e.currentTarget.style.color = 'var(--text-secondary)';
        }}
      >
        {visible ? <EyeOff size={16} /> : <Eye size={16} />}
      </button>
    </div>
  );
});

export default PasswordInput;
