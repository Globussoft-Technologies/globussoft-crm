import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import Phase2ValidationSuite from '../pages/Phase2ValidationSuite';

// URL-aware mock fetch so the four validation suites can run in any order.
global.fetch = vi.fn(async (url, options = {}) => {
  const method = options.method || 'GET';
  let body = {};
  if (typeof options.body === 'string') {
    try {
      body = JSON.parse(options.body);
    } catch {
      body = {};
    }
  } else if (options.body) {
    body = options.body;
  }

  if (url === '/api/landing-pages' && method === 'POST') {
    // Malformed JSON must be rejected for the schema test.
    if (body.title && body.title.startsWith('Malformed')) {
      return { ok: false, status: 400, json: async () => ({ error: 'Invalid content' }) };
    }
    return { ok: true, json: async () => ({ id: '123', slug: body.slug || 'test-page' }) };
  }

  if (url.startsWith('/api/landing-pages/') && method === 'PATCH') {
    return { ok: true, json: async () => ({ id: '123', status: 'PUBLISHED' }) };
  }

  if (url.startsWith('/api/landing-pages/') && url.endsWith('/versions')) {
    return { ok: true, json: async () => [] };
  }

  if (url.startsWith('/api/landing-pages/') && method === 'DELETE') {
    return { ok: true, status: 200 };
  }

  if (url.startsWith('/api/landing-pages?')) {
    return {
      ok: true,
      json: async () => [
        { id: '1', slug: 'page-one', templateType: 'block-array' },
        { id: '2', slug: 'page-two', templateType: 'wanderlux-v1' },
        { id: '3', slug: 'page-three', templateType: 'family-trip-v1' },
      ],
    };
  }

  if (url === '/trips') {
    return { ok: true, status: 200, text: async () => '' };
  }

  if (url.startsWith('/p/')) {
    if (url.includes('non-existent') || url.includes('/..')) {
      return { ok: false, status: 404, text: async () => 'Not found' };
    }
    return { ok: true, status: 200, text: async () => '<div>HTML</div>' };
  }

  if (url.startsWith('/test/react-landing-page')) {
    return { ok: true, status: 200, text: async () => '<div>React</div>' };
  }

  return { ok: true, json: async () => ({}), text: async () => '' };
});

describe('Phase2ValidationSuite', () => {
  beforeEach(() => {
    fetch.mockClear();
  });

  afterEach(() => {
    fetch.mockClear();
  });

  it('renders the page title', () => {
    render(<Phase2ValidationSuite />);
    expect(screen.getByText('🚀 Phase 2 Validation Suite')).toBeInTheDocument();
  });

  it('displays loading state initially', () => {
    render(<Phase2ValidationSuite />);
    expect(screen.getByText(/running phase 2 validation suite/i)).toBeInTheDocument();
  });

  it('runs all four validation suites', async () => {
    render(<Phase2ValidationSuite />);

    await waitFor(() => {
      expect(screen.queryByText(/running phase 2 validation/i)).not.toBeInTheDocument();
    });

    await waitFor(() => {
      expect(screen.getAllByText(/Builder Round-Trip Validation/i).length).toBeGreaterThan(0);
      expect(screen.getAllByText(/Schema Compatibility Testing/i).length).toBeGreaterThan(0);
      expect(screen.getAllByText(/Regression Dataset Validation/i).length).toBeGreaterThan(0);
      expect(screen.getAllByText(/Production Route Validation/i).length).toBeGreaterThan(0);
    });
  });

  it('displays builder round-trip test results', async () => {
    render(<Phase2ValidationSuite />);

    await waitFor(() => {
      expect(screen.getByText(/Create draft page/i)).toBeInTheDocument();
      expect(screen.getByText(/Edit draft page/i)).toBeInTheDocument();
      expect(screen.getByText(/Version history preserved/i)).toBeInTheDocument();
      expect(screen.getByText(/Publish page/i)).toBeInTheDocument();
    });
  });

  it('displays schema compatibility test results', async () => {
    render(<Phase2ValidationSuite />);

    await waitFor(() => {
      expect(screen.getByText(/Block-array JSON schema/i)).toBeInTheDocument();
      expect(screen.getByText(/Wanderlux v1 JSON schema/i)).toBeInTheDocument();
      expect(screen.getByText(/Family template JSON schema/i)).toBeInTheDocument();
      expect(screen.getByText(/Malformed JSON rejection/i)).toBeInTheDocument();
    });
  });

  it('displays regression dataset validation results', async () => {
    render(<Phase2ValidationSuite />);

    await waitFor(() => {
      expect(screen.getByText(/Published pages exist/i)).toBeInTheDocument();
      expect(screen.getByText(/Template type coverage/i)).toBeInTheDocument();
    });
  });

  it('displays production route validation results', async () => {
    render(<Phase2ValidationSuite />);

    await waitFor(() => {
      expect(screen.getByText(/\/trips route works/i)).toBeInTheDocument();
      expect(screen.getByText(/\/p\/:slug direct access/i)).toBeInTheDocument();
      expect(screen.getByText(/404 for non-existent page/i)).toBeInTheDocument();
    });
  });

  it('shows READY FOR PHASE 2 when all tests pass', async () => {
    render(<Phase2ValidationSuite />);

    await waitFor(() => {
      expect(screen.getByText(/READY FOR PHASE 2/i)).toBeInTheDocument();
    });
  });

  it('shows detailed test results', async () => {
    render(<Phase2ValidationSuite />);

    await waitFor(() => {
      expect(screen.getByText(/Detailed Results/i)).toBeInTheDocument();
    });
  });

  it('provides next steps recommendations', async () => {
    render(<Phase2ValidationSuite />);

    await waitFor(() => {
      expect(screen.getByText(/Next Steps/i)).toBeInTheDocument();
    });
  });

  it('handles API errors gracefully', async () => {
    fetch.mockRejectedValueOnce(new Error('Network error'));

    render(<Phase2ValidationSuite />);

    await waitFor(() => {
      expect(screen.getByText(/NOT READY FOR PHASE 2/i)).toBeInTheDocument();
    });
  });

  it('shows test pass/fail indicators', async () => {
    render(<Phase2ValidationSuite />);

    await waitFor(() => {
      expect(screen.getAllByText(/✅|❌/).length).toBeGreaterThan(0);
    });
  });

  it('shows test suite summary cards', async () => {
    render(<Phase2ValidationSuite />);

    await waitFor(() => {
      expect(screen.getAllByText(/Builder Round-Trip/i).length).toBeGreaterThan(0);
      expect(screen.getAllByText(/Schema Compatibility/i).length).toBeGreaterThan(0);
      expect(screen.getAllByText(/Regression Dataset/i).length).toBeGreaterThan(0);
      expect(screen.getAllByText(/Production Route/i).length).toBeGreaterThan(0);
    });
  });

  it('includes test count in each suite', async () => {
    render(<Phase2ValidationSuite />);

    await waitFor(() => {
      expect(screen.getAllByText(/tests passed/i).length).toBeGreaterThanOrEqual(4);
    });
  });
});
