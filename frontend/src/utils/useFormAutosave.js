import { useEffect, useState } from 'react';

/**
 * Persist form state to sessionStorage and rehydrate on refresh.
 * Also installs a beforeunload listener while the form is dirty so the
 * browser warns the user before they lose their input (#226).
 *
 * Usage:
 *   const [draft, setDraft, isDirty, clear] = useFormAutosave('rx-285', INITIAL);
 *   // ... after a successful submit, call clear() to remove the draft.
 *
 * The beforeunload listener is removed automatically once the form is
 * back in its initial state (e.g. after clear() or after the user manually
 * resets the fields), so navigation is unimpeded when there's nothing to lose.
 */
export function useFormAutosave(key, initial) {
  const storageKey = `gbs.form.${key}`;
  const [state, setState] = useState(() => {
    try {
      const saved = sessionStorage.getItem(storageKey);
      return saved ? { ...initial, ...JSON.parse(saved) } : initial;
    } catch {
      return initial;
    }
  });
  const isDirty = JSON.stringify(state) !== JSON.stringify(initial);

  useEffect(() => {
    if (isDirty) {
      try {
        sessionStorage.setItem(storageKey, JSON.stringify(state));
      } catch {
        /* storage may be full or disabled; fail silently */
      }
    } else {
      try {
        sessionStorage.removeItem(storageKey);
      } catch {
        /* ignore */
      }
    }
  }, [state, storageKey, isDirty]);

  useEffect(() => {
    if (!isDirty) return;
    const handler = (e) => {
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [isDirty]);

  // Helper to clear after a successful submit (or to discard a restored draft).
  const clear = () => {
    try {
      sessionStorage.removeItem(storageKey);
    } catch {
      /* ignore */
    }
    setState(initial);
  };

  return [state, setState, isDirty, clear];
}
