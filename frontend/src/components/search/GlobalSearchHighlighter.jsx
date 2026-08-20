import { useEffect, useRef } from 'react';
import { useLocation } from 'react-router-dom';
import { useSearchQuery } from './SearchQueryContext';
import {
  clearGlobalSearchHighlightRoots,
  highlightGlobalSearchRoots,
} from './globalSearchHighlightDom';

export default function GlobalSearchHighlighter() {
  const { query } = useSearchQuery();
  const { pathname } = useLocation();
  const applyTimerRef = useRef(null);
  const settleTimerRef = useRef(null);
  const isApplyingRef = useRef(false);

  useEffect(() => {
    if (typeof document === 'undefined') return undefined;
    if (typeof MutationObserver === 'undefined') return undefined;

    const trimmed = String(query ?? '').trim();

    const clearTimers = () => {
      if (applyTimerRef.current != null) {
        clearTimeout(applyTimerRef.current);
        applyTimerRef.current = null;
      }
      if (settleTimerRef.current != null) {
        clearTimeout(settleTimerRef.current);
        settleTimerRef.current = null;
      }
    };

    const settleHighlighting = () => {
      if (settleTimerRef.current != null) {
        clearTimeout(settleTimerRef.current);
      }
      settleTimerRef.current = window.setTimeout(() => {
        isApplyingRef.current = false;
        settleTimerRef.current = null;
      }, 0);
    };

    const applyHighlights = () => {
      clearTimers();
      clearGlobalSearchHighlightRoots(document);
      if (trimmed.length < 2) return;

      isApplyingRef.current = true;
      highlightGlobalSearchRoots(document, trimmed);
      settleHighlighting();
    };

    applyHighlights();

    if (trimmed.length < 2) {
      return () => {
        clearTimers();
        clearGlobalSearchHighlightRoots(document);
        isApplyingRef.current = false;
      };
    }

    const scheduleApply = () => {
      if (isApplyingRef.current || applyTimerRef.current != null) return;
      applyTimerRef.current = window.setTimeout(() => {
        applyTimerRef.current = null;
        applyHighlights();
      }, 0);
    };

    const observer = new MutationObserver(() => {
      if (isApplyingRef.current) return;
      scheduleApply();
    });

    observer.observe(document.body, {
      childList: true,
      subtree: true,
      characterData: true,
    });

    return () => {
      observer.disconnect();
      clearTimers();
      clearGlobalSearchHighlightRoots(document);
      isApplyingRef.current = false;
    };
  }, [pathname, query]);

  return null;
}
