import { useCallback, useEffect, useRef, useState } from 'react';
import { WorkspaceLoadingContext } from './workspaceLoadingContext';
import { WorkspacePreloaderView } from './WorkspacePreloader';

// Keep a single animation mounted across sequential auth, lazy-route and
// permission checks. The short quiet period absorbs handoffs, not API work:
// protected pages still obey their existing guards and cannot mount early.
export default function WorkspaceLoadingProvider({ children }) {
  const pending = useRef(0);
  const settleTimer = useRef(null);
  const fadeTimer = useRef(null);
  const [visible, setVisible] = useState(false);
  const [closing, setClosing] = useState(false);
  const begin = useCallback(() => {
    pending.current += 1;
    clearTimeout(settleTimer.current);
    clearTimeout(fadeTimer.current);
    setClosing(false);
    setVisible(true);
    let finished = false;
    return () => {
      if (finished) return;
      finished = true;
      pending.current -= 1;
      if (pending.current !== 0) return;
      settleTimer.current = setTimeout(() => {
        setClosing(true);
        fadeTimer.current = setTimeout(() => setVisible(false), 180);
      }, 180);
    };
  }, []);
  useEffect(() => () => {
    clearTimeout(settleTimer.current);
    clearTimeout(fadeTimer.current);
  }, []);

  return (
    <WorkspaceLoadingContext.Provider value={begin}>
      <div style={{ display: 'contents' }} inert={visible ? '' : undefined} aria-hidden={visible ? true : undefined}>
        {children}
      </div>
      {visible && (
        <div className={`workspace-loading-overlay${closing ? ' workspace-loading-overlay--closing' : ''}`}>
          <WorkspacePreloaderView fullScreen />
        </div>
      )}
    </WorkspaceLoadingContext.Provider>
  );
}
