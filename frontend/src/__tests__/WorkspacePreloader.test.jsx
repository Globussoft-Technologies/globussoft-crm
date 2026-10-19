import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import WorkspacePreloader from '../components/WorkspacePreloader';

const styles = readFileSync(resolve(process.cwd(), 'src/components/WorkspacePreloader.css'), 'utf8');

describe('WorkspacePreloader', () => {
  it('announces loading and preserves the original brand without fake progress', () => {
    render(<WorkspacePreloader />);
    const status = screen.getByRole('status', { name: 'Bringing your workspace together' });
    expect(status).toHaveAttribute('aria-busy', 'true');
    expect(status).toHaveAttribute('aria-live', 'polite');
    expect(screen.getByRole('img', { name: 'GlobusCRM' }))
      .toHaveAttribute('src', '/preloaders/globuscrm-loader.gif');
    const image = screen.getByRole('img', { name: 'GlobusCRM' });
    expect(image).toHaveAttribute('width', '320');
    expect(image).toHaveAttribute('height', '320');
    const reducedMotion = image.closest('picture').querySelector('source');
    expect(reducedMotion).toHaveAttribute('media', '(prefers-reduced-motion: reduce)');
    expect(reducedMotion).toHaveAttribute('srcset', '/preloaders/globuscrm-loader-static.png');
    expect(status.querySelector('.workspace-preloader__rail')).toBeNull();
    expect(screen.queryByRole('progressbar')).not.toBeInTheDocument();
    expect(status).not.toHaveClass('workspace-preloader--fullscreen');
  });

  it('supports a full-screen splash and a meaningful custom loading message', () => {
    render(<WorkspacePreloader fullScreen label="Loading your page…" />);
    expect(screen.getByRole('status', { name: 'Loading your page…' }))
      .toHaveClass('workspace-preloader--fullscreen');
  });

  it('does not leave an overlay behind when loading finishes', () => {
    const { rerender } = render(<WorkspacePreloader fullScreen />);
    rerender(<button>Workspace ready</button>);
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Workspace ready' })).toBeEnabled();
  });

  it('uses a transparent, borderless container without an extra loading rail', () => {
    const cardStyles = styles.match(/\.workspace-preloader__card\s*\{([^}]+)\}/)[1];
    expect(cardStyles).toContain('background: transparent');
    expect(cardStyles).toContain('border: 0');
    expect(cardStyles).toContain('box-shadow: none');
    expect(styles).not.toContain('workspace-preloader__rail');
  });
});
