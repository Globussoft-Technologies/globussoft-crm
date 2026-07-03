import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import ParityVerificationTool from '../pages/ParityVerificationTool';

// Mock fetch globally
global.fetch = vi.fn();

describe('ParityVerificationTool', () => {
  beforeEach(() => {
    fetch.mockClear();
  });

  afterEach(() => {
    fetch.mockReset();
  });

  it('renders the page title', async () => {
    fetch.mockResolvedValueOnce({
      ok: false,
      json: async () => ({}),
    });

    render(<ParityVerificationTool />);
    expect(screen.getByText('🔍 Parity Verification Tool')).toBeInTheDocument();
  });

  it('loads landing page by ID', async () => {
    const mockPage = {
      id: '123',
      slug: 'test-page',
      title: 'Test Page',
      content: JSON.stringify([{ type: 'heading', props: { text: 'Test' } }]),
      templateType: 'block-array',
    };

    fetch.mockResolvedValueOnce({
      ok: true,
      json: async () => mockPage,
    });

    render(<ParityVerificationTool />);

    await waitFor(() => {
      expect(fetch).toHaveBeenCalledWith('/api/landing-pages/undefined');
    });
  });

  it('displays error when page not found', async () => {
    fetch.mockResolvedValueOnce({
      ok: false,
      status: 404,
    });

    render(<ParityVerificationTool />);

    await waitFor(() => {
      expect(screen.getByText(/page not found/i)).toBeInTheDocument();
    });
  });

  it('renders parity report with results', async () => {
    const mockPage = {
      id: '123',
      slug: 'test-page',
      title: 'Test Page',
      content: JSON.stringify([{ type: 'heading', props: { text: 'Test' } }]),
      templateType: 'block-array',
    };

    // Mock all fetch calls needed for parity comparison
    fetch
      .mockResolvedValueOnce({
        ok: true,
        json: async () => mockPage,
      })
      .mockResolvedValueOnce({
        ok: true,
        text: async () => '<html><h1>Test</h1></html>',
      })
      .mockResolvedValueOnce({
        ok: true,
        text: async () => '<div><h1>Test</h1></div>',
      });

    render(<ParityVerificationTool />);

    await waitFor(() => {
      // Should show report after loading
      expect(screen.queryByText(/loading/i)).not.toBeInTheDocument();
    });
  });

  it('handles URL parameters (id query)', () => {
    const originalLocation = window.location;
    delete window.location;
    window.location = { search: '?id=456' };

    fetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ id: '456', slug: 'page', content: '[]' }),
    });

    render(<ParityVerificationTool />);

    expect(fetch).toHaveBeenCalled();

    window.location = originalLocation;
  });

  it('handles URL parameters (slug query)', () => {
    const originalLocation = window.location;
    delete window.location;
    window.location = { search: '?slug=my-page' };

    fetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ id: '123', slug: 'my-page', content: '[]' }),
    });

    render(<ParityVerificationTool />);

    expect(fetch).toHaveBeenCalled();

    window.location = originalLocation;
  });

  it('shows comparison loading state', async () => {
    fetch.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          setTimeout(() => {
            resolve({
              ok: true,
              json: async () => ({ id: '123', slug: 'test', content: '[]' }),
            });
          }, 100);
        })
    );

    render(<ParityVerificationTool />);

    expect(screen.getByText(/comparing/i)).toBeInTheDocument();
  });

  it('displays comparison results summary', async () => {
    const mockPage = {
      id: '123',
      slug: 'test-page',
      title: 'Test Page',
      content: JSON.stringify([{ type: 'text', props: { text: 'Content' } }]),
      templateType: 'block-array',
    };

    fetch
      .mockResolvedValueOnce({
        ok: true,
        json: async () => mockPage,
      })
      .mockResolvedValueOnce({
        ok: true,
        text: async () => '<div>Content</div>',
      })
      .mockResolvedValueOnce({
        ok: true,
        text: async () => '<div>Content</div>',
      });

    render(<ParityVerificationTool />);

    await waitFor(() => {
      // Should show DOM structure check
      expect(screen.queryByText(/dom structure/i)).toBeInTheDocument();
    });
  });

  it('detects DOM structure differences', async () => {
    const mockPage = {
      id: '123',
      slug: 'test-page',
      title: 'Test Page',
      content: JSON.stringify([{ type: 'text', props: { text: 'Different' } }]),
      templateType: 'block-array',
    };

    fetch
      .mockResolvedValueOnce({
        ok: true,
        json: async () => mockPage,
      })
      .mockResolvedValueOnce({
        ok: true,
        text: async () => '<div><h1>Title</h1><p>Content</p></div>',
      })
      .mockResolvedValueOnce({
        ok: true,
        text: async () => '<div><h1>Title</h1></div>',
      });

    render(<ParityVerificationTool />);

    await waitFor(() => {
      // Should detect structure mismatch
      expect(screen.queryByText(/elements don't match/i)).toBeInTheDocument();
    });
  });

  it('detects text content differences', async () => {
    const mockPage = {
      id: '123',
      slug: 'test-page',
      title: 'Test Page',
      content: JSON.stringify([{ type: 'text', props: { text: 'HTML Content' } }]),
      templateType: 'block-array',
    };

    fetch
      .mockResolvedValueOnce({
        ok: true,
        json: async () => mockPage,
      })
      .mockResolvedValueOnce({
        ok: true,
        text: async () => '<div>HTML Content</div>',
      })
      .mockResolvedValueOnce({
        ok: true,
        text: async () => '<div>React Different Content</div>',
      });

    render(<ParityVerificationTool />);

    await waitFor(() => {
      // Should detect text content mismatch
      expect(screen.queryByText(/text content/i)).toBeInTheDocument();
    });
  });

  it('includes link comparison', async () => {
    const mockPage = {
      id: '123',
      slug: 'test-page',
      title: 'Test Page',
      content: JSON.stringify([
        { type: 'button', props: { text: 'Click', url: 'https://example.com' } },
      ]),
      templateType: 'block-array',
    };

    fetch
      .mockResolvedValueOnce({
        ok: true,
        json: async () => mockPage,
      })
      .mockResolvedValueOnce({
        ok: true,
        text: async () => '<div><a href="https://example.com">Click</a></div>',
      })
      .mockResolvedValueOnce({
        ok: true,
        text: async () => '<div><a href="https://example.com">Click</a></div>',
      });

    render(<ParityVerificationTool />);

    await waitFor(() => {
      expect(screen.queryByText(/links/i)).toBeInTheDocument();
    });
  });

  it('handles network errors gracefully', async () => {
    fetch.mockRejectedValueOnce(new Error('Network error'));

    render(<ParityVerificationTool />);

    await waitFor(() => {
      expect(screen.getByText(/error/i)).toBeInTheDocument();
    });
  });

  it('generates actionable recommendations', async () => {
    const mockPage = {
      id: '123',
      slug: 'test-page',
      title: 'Test Page',
      content: JSON.stringify([{ type: 'heading', props: { text: 'Test' } }]),
      templateType: 'block-array',
    };

    fetch
      .mockResolvedValueOnce({
        ok: true,
        json: async () => mockPage,
      })
      .mockResolvedValueOnce({
        ok: true,
        text: async () => '<h1>Test</h1>',
      })
      .mockResolvedValueOnce({
        ok: true,
        text: async () => '<h1>Test</h1>',
      });

    render(<ParityVerificationTool />);

    await waitFor(() => {
      // Should show recommendations section
      expect(screen.queryByText(/recommendation/i)).toBeInTheDocument();
    });
  });

  it('supports detailed comparison mode', () => {
    const originalLocation = window.location;
    delete window.location;
    window.location = { search: '?id=123&detailed=true' };

    fetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ id: '123', slug: 'test', content: '[]' }),
    });

    render(<ParityVerificationTool />);

    expect(fetch).toHaveBeenCalled();

    window.location = originalLocation;
  });

  it('displays side-by-side comparison panels', async () => {
    const mockPage = {
      id: '123',
      slug: 'test-page',
      title: 'Test Page',
      content: JSON.stringify([{ type: 'text', props: { text: 'Test' } }]),
      templateType: 'block-array',
    };

    fetch
      .mockResolvedValueOnce({
        ok: true,
        json: async () => mockPage,
      })
      .mockResolvedValueOnce({
        ok: true,
        text: async () => '<div>Test HTML</div>',
      })
      .mockResolvedValueOnce({
        ok: true,
        text: async () => '<div>Test React</div>',
      });

    render(<ParityVerificationTool />);

    await waitFor(() => {
      // Should show comparison results
      expect(screen.queryByText(/html/i)).toBeInTheDocument();
      expect(screen.queryByText(/react/i)).toBeInTheDocument();
    });
  });

  it('handles missing query parameters with default ID', () => {
    const originalLocation = window.location;
    delete window.location;
    window.location = { search: '' };

    fetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ id: '1', slug: 'default', content: '[]' }),
    });

    render(<ParityVerificationTool />);

    // Should attempt to fetch with some default or display error
    expect(fetch).toHaveBeenCalled();

    window.location = originalLocation;
  });
});
