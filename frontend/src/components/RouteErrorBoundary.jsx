import React from 'react';

/**
 * Catches any error that escapes a lazy route — most often a stale chunk
 * fetch that the lazyWithRetry helper couldn't auto-recover from. Surfaces
 * a "Reload" CTA so the user can fix it manually instead of staring at a
 * blank screen. See #249.
 */
export default class RouteErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    console.error('[RouteErrorBoundary]', error, info);
  }

  handleReload = () => {
    sessionStorage.removeItem('lazyChunkReloaded');
    window.location.reload();
  };

  render() {
    if (!this.state.error) return this.props.children;
    const isChunkError =
      this.state.error?.message?.includes('Failed to fetch dynamically imported module') ||
      this.state.error?.message?.includes('error loading dynamically imported module') ||
      this.state.error?.name === 'ChunkLoadError';

    return (
      <div style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        minHeight: '60vh',
        padding: '2rem',
        textAlign: 'center',
        color: 'var(--text-primary)',
      }}>
        <h2 style={{ marginBottom: '0.5rem' }}>
          {isChunkError ? 'Page needs a refresh' : 'Something went wrong'}
        </h2>
        <p style={{ marginBottom: '1.5rem', opacity: 0.75, maxWidth: 480 }}>
          {isChunkError
            ? 'The CRM was updated since you opened this tab. Reload to load the new version.'
            : (this.state.error?.message || 'An unexpected error occurred.')}
        </p>
        <button
          onClick={this.handleReload}
          style={{
            padding: '0.6rem 1.5rem',
            background: 'var(--brand-primary, #6366f1)',
            color: 'white',
            border: 'none',
            borderRadius: 8,
            cursor: 'pointer',
            fontWeight: 600,
          }}
        >
          Reload page
        </button>
      </div>
    );
  }
}
