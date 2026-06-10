import { useEffect } from "react";

// Module-level counter so nested modals don't fight each other.
// When the first modal opens we save the original overflow;
// when the last modal closes we restore it.
let lockCount = 0;
let originalOverflow = "";

/**
 * Lock body scroll while the component is mounted.
 * Safe for nested modals — only the outermost lock/restore pair
 * touches document.body.style.overflow.
 */
export function useScrollLock(enabled = true) {
  useEffect(() => {
    if (!enabled) return;

    if (lockCount === 0) {
      originalOverflow = document.body.style.overflow;
      document.body.style.overflow = "hidden";
    }
    lockCount++;

    return () => {
      lockCount--;
      if (lockCount <= 0) {
        lockCount = 0;
        document.body.style.overflow = originalOverflow;
      }
    };
  }, [enabled]);
}
