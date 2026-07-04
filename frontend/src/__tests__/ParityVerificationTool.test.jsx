import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import ParityVerificationTool from '../pages/ParityVerificationTool';

// Mock fetch globally
global.fetch = vi.fn();

function renderWithRouter(ui, { search = 'id=123' } = {}) {
  const initialEntries = [`/test?${search}`];
  return render(<MemoryRouter initialEntries={initialEntries}>{ui}</MemoryRouter>);
}

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

    renderWithRouter(<ParityVerificationTool />);
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

    renderWithRouter(<ParityVerificationTool />);

    await waitFor(() => {
      expect(fetch).toHaveBeenCalledWith('/api/landing-pages/123');
    });
  });

  it('displays error when page not found', async () => {
    fetch.mockResolvedValueOnce({
      ok: false,
      status: 404,
    });

    renderWithRouter(<ParityVerificationTool />);

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

    renderWithRouter(<ParityVerificationTool />);

    await waitFor(() => {
      // Should show report after loading
      expect(screen.queryByText(/loading/i)).not.toBeInTheDocument();
    });
  });

  it('handles URL parameters (id query)', () => {
    fetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ id: '456', slug: 'page', content: '[]' }),
    });

    renderWithRouter(<ParityVerificationTool />, { search: 'id=456' });

    expect(fetch).toHaveBeenCalled();
  });

  it('handles URL parameters (slug query)', () => {
    fetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ id: '123', slug: 'my-page', content: '[]' }),
    });

    renderWithRouter(<ParityVerificationTool />, { search: 'slug=my-page' });

    expect(fetch).toHaveBeenCalled();
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

    renderWithRouter(<ParityVerificationTool />);

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

    renderWithRouter(<ParityVerificationTool />);

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

    renderWithRouter(<ParityVerificationTool />);

    await waitFor(() => {
      expect(screen.queryByText('DOM Structure')).toBeInTheDocument();
    });

    // Expand the DOM structure check to reveal the difference details
    const domCheck = screen.getByText('DOM Structure').closest('div').parentElement;
    fireEvent.click(domCheck);

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

    renderWithRouter(<ParityVerificationTool />);

    await waitFor(() => {
      // Should detect text content mismatch
      expect(screen.queryAllByText(/text content/i).length).toBeGreaterThan(0);
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

    renderWithRouter(<ParityVerificationTool />);

    await waitFor(() => {
      expect(screen.queryByText(/links/i)).toBeInTheDocument();
    });
  });

  it('handles network errors gracefully', async () => {
    fetch.mockRejectedValueOnce(new Error('Network error'));

    renderWithRouter(<ParityVerificationTool />);

    await waitFor(() => {
      expect(screen.getByText(/network error/i)).toBeInTheDocument();
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

    renderWithRouter(<ParityVerificationTool />);

    await waitFor(() => {
      // Should show recommendations section
      expect(screen.queryByText(/recommendation/i)).toBeInTheDocument();
    });
  });

  it('supports detailed comparison mode', () => {
    fetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ id: '123', slug: 'test', content: '[]' }),
    });

    renderWithRouter(<ParityVerificationTool />, { search: 'id=123&detailed=true' });

    expect(fetch).toHaveBeenCalled();
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

    renderWithRouter(<ParityVerificationTool />);

    await waitFor(() => {
      expect(screen.queryByText('Text Content')).toBeInTheDocument();
    });

    // Expand the text-content check to reveal the side-by-side diff labels
    const textCheck = screen.getByText('Text Content').closest('div').parentElement;
    fireEvent.click(textCheck);

    await waitFor(() => {
      // Should show comparison results
      expect(screen.queryByText(/HTML:/i)).toBeInTheDocument();
      expect(screen.queryByText(/React:/i)).toBeInTheDocument();
    });
  });

  it('handles missing query parameters with default ID', async () => {
    fetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ id: '1', slug: 'default', content: '[]' }),
    });

    renderWithRouter(<ParityVerificationTool />, { search: '' });

    // Should display the missing-parameter error and not call fetch
    await waitFor(() => {
      expect(screen.getByText(/please provide either \?id=/i)).toBeInTheDocument();
    });
    expect(fetch).not.toHaveBeenCalled();
  });
});
