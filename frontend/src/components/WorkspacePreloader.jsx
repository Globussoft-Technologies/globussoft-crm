import './WorkspacePreloader.css';
import { useContext, useLayoutEffect } from 'react';
import { WorkspaceLoadingContext } from './workspaceLoadingContext';

/** Generic CRM's indeterminate loading view. Keep buttons and tables on their
 * own lightweight loading indicators rather than blocking the whole app. */
export function WorkspacePreloaderView({
  label = 'Bringing your workspace together',
  fullScreen = false,
}) {
  return (
    <div
      className={`workspace-preloader${fullScreen ? ' workspace-preloader--fullscreen' : ''}`}
      role="status"
      aria-live="polite"
      aria-label={label}
      aria-busy="true"
    >
      <div className="workspace-preloader__card">
        <picture>
          <source media="(prefers-reduced-motion: reduce)" srcSet="/preloaders/globuscrm-loader-static.png" />
          <img
            className="workspace-preloader__logo"
            src="/preloaders/globuscrm-loader.gif"
            alt="GlobusCRM"
            width="320"
            height="320"
          />
        </picture>
        <p className="workspace-preloader__label">{label}</p>
      </div>
    </div>
  );
}

export default function WorkspacePreloader(props) {
  const loading = useContext(WorkspaceLoadingContext);
  useLayoutEffect(() => loading?.(), [loading]);
  // Without the app coordinator, preserve the standalone loading state for
  // isolated screens, component previews and non-app renderers.
  return loading ? null : <WorkspacePreloaderView {...props} />;
}
