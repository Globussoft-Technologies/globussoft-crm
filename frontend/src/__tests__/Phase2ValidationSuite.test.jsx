import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import Phase2ValidationSuite from '../pages/Phase2ValidationSuite';

// Mock fetch globally
global.fetch = vi.fn();

describe('Phase2ValidationSuite', () => {
  beforeEach(() => {
    fetch.mockClear();
  });

  afterEach(() => {
    fetch.mockReset();
  });

  it('renders the page title', () => {
    fetch.mockImplementation(() =>
      new Promise((resolve) => {
        setTimeout(() => {
          resolve({ ok: true, json: async () => ({}) });
        }, 100);
      })
    );

    render(<Phase2ValidationSuite />);
    expect(screen.getByText('🚀 Phase 2 Validation Suite')).toBeInTheDocument();
  });

  it('displays loading state initially', () => {
    fetch.mockImplementation(
      () =>
        new Promise((resolve) => {
          setTimeout(() => {
            resolve({ ok: true, json: async () => ({}) });
          }, 100);
        })
    );

    render(<Phase2ValidationSuite />);
    expect(screen.getByText(/running phase 2 validation suite/i)).toBeInTheDocument();
  });

  it('runs all four validation suites', async () => {
    fetch
      .mockResolvedValueOnce({ ok: true, json: async () => ({ id: '123' }) }) // Create page
      .mockResolvedValueOnce({ ok: true, json: async () => ({ id: '123' }) }) // PATCH page
      .mockResolvedValueOnce({ ok: true }) // Versions
      .mockResolvedValueOnce({ ok: true, json: async () => ({ status: 'PUBLISHED' }) }) // PATCH publish
      .mockResolvedValueOnce({ ok: true }) // HTML access
      .mockResolvedValueOnce({ ok: true }) // React access
      .mockResolvedValueOnce({ ok: true, status: 200 }) // DELETE cleanup
      .mockResolvedValueOnce({ ok: true, json: async () => [] }) // Block-array test
      .mockResolvedValueOnce({ ok: true, json: async () => [] }) // Wanderlux test
      .mockResolvedValueOnce({ ok: true, json: async () => [] }) // Family test
      .mockResolvedValueOnce({ ok: false, status: 400 }) // Malformed JSON rejection
      .mockResolvedValueOnce({ ok: true, json: async () => [{ id: '1', slug: 'test' }] }) // Dataset query
      .mockResolvedValueOnce({ ok: true }) // Template coverage
      .mockResolvedValueOnce({ ok: true }) // Sample pages
      .mockResolvedValueOnce({ ok: true }) // /trips
      .mockResolvedValueOnce({ ok: true }) // /p/:slug
      .mockResolvedValueOnce({ ok: false }) // Non-existent page
      .mockResolvedValueOnce({ ok: false }) // Invalid slug
      .mockResolvedValueOnce({ ok: true }); // Test route

    render(<Phase2ValidationSuite />);

    await waitFor(() => {
      expect(screen.queryByText(/running phase 2 validation/i)).not.toBeInTheDocument();
    });

    // Should show all four validation suites
    await waitFor(() => {
      expect(screen.getByText(/Builder Round-Trip Validation/i)).toBeInTheDocument();
      expect(screen.getByText(/Schema Compatibility Testing/i)).toBeInTheDocument();
      expect(screen.getByText(/Regression Dataset Validation/i)).toBeInTheDocument();
      expect(screen.getByText(/Production Route Validation/i)).toBeInTheDocument();
    });
  });

  it('displays builder round-trip test results', async () => {
    fetch
      .mockResolvedValueOnce({ ok: true, json: async () => ({ id: '123' }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ id: '123' }) })
      .mockResolvedValueOnce({ ok: true })
      .mockResolvedValueOnce({ ok: true })
      .mockResolvedValueOnce({ ok: true })
      .mockResolvedValueOnce({ ok: true })
      .mockResolvedValueOnce({ ok: true, status: 200 })
      .mockResolvedValueOnce({ ok: true, json: async () => [] })
      .mockResolvedValueOnce({ ok: true, json: async () => [] })
      .mockResolvedValueOnce({ ok: true, json: async () => [] })
      .mockResolvedValueOnce({ ok: false })
      .mockResolvedValueOnce({ ok: true, json: async () => [] })
      .mockResolvedValueOnce({ ok: true })
      .mockResolvedValueOnce({ ok: true })
      .mockResolvedValueOnce({ ok: true })
      .mockResolvedValueOnce({ ok: true })
      .mockResolvedValueOnce({ ok: false })
      .mockResolvedValueOnce({ ok: false })
      .mockResolvedValueOnce({ ok: true });

    render(<Phase2ValidationSuite />);

    await waitFor(() => {
      expect(screen.getByText(/Create draft page/i)).toBeInTheDocument();
      expect(screen.getByText(/Edit draft page/i)).toBeInTheDocument();
      expect(screen.getByText(/Version history preserved/i)).toBeInTheDocument();
      expect(screen.getByText(/Publish page/i)).toBeInTheDocument();
    });
  });

  it('displays schema compatibility test results', async () => {
    fetch
      .mockResolvedValueOnce({ ok: true, json: async () => ({ id: '123' }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ id: '123' }) })
      .mockResolvedValueOnce({ ok: true })
      .mockResolvedValueOnce({ ok: true })
      .mockResolvedValueOnce({ ok: true })
      .mockResolvedValueOnce({ ok: true })
      .mockResolvedValueOnce({ ok: true, status: 200 })
      .mockResolvedValueOnce({ ok: true, json: async () => [] })
      .mockResolvedValueOnce({ ok: true, json: async () => [] })
      .mockResolvedValueOnce({ ok: true, json: async () => [] })
      .mockResolvedValueOnce({ ok: false })
      .mockResolvedValueOnce({ ok: true, json: async () => [] })
      .mockResolvedValueOnce({ ok: true })
      .mockResolvedValueOnce({ ok: true })
      .mockResolvedValueOnce({ ok: true })
      .mockResolvedValueOnce({ ok: true })
      .mockResolvedValueOnce({ ok: false })
      .mockResolvedValueOnce({ ok: false })
      .mockResolvedValueOnce({ ok: true });

    render(<Phase2ValidationSuite />);

    await waitFor(() => {
      expect(screen.getByText(/Block-array JSON schema/i)).toBeInTheDocument();
      expect(screen.getByText(/Wanderlux v1 JSON schema/i)).toBeInTheDocument();
      expect(screen.getByText(/Family template JSON schema/i)).toBeInTheDocument();
      expect(screen.getByText(/Malformed JSON rejection/i)).toBeInTheDocument();
    });
  });

  it('displays regression dataset validation results', async () => {
    fetch
      .mockResolvedValueOnce({ ok: true, json: async () => ({ id: '123' }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ id: '123' }) })
      .mockResolvedValueOnce({ ok: true })
      .mockResolvedValueOnce({ ok: true })
      .mockResolvedValueOnce({ ok: true })
      .mockResolvedValueOnce({ ok: true })
      .mockResolvedValueOnce({ ok: true, status: 200 })
      .mockResolvedValueOnce({ ok: true, json: async () => [] })
      .mockResolvedValueOnce({ ok: true, json: async () => [] })
      .mockResolvedValueOnce({ ok: true, json: async () => [] })
      .mockResolvedValueOnce({ ok: false })
      .mockResolvedValueOnce({ ok: true, json: async () => [{ id: '1', slug: 'test', templateType: 'block-array' }] })
      .mockResolvedValueOnce({ ok: true })
      .mockResolvedValueOnce({ ok: true })
      .mockResolvedValueOnce({ ok: true })
      .mockResolvedValueOnce({ ok: true })
      .mockResolvedValueOnce({ ok: false })
      .mockResolvedValueOnce({ ok: false })
      .mockResolvedValueOnce({ ok: true });

    render(<Phase2ValidationSuite />);

    await waitFor(() => {
      expect(screen.getByText(/Published pages exist/i)).toBeInTheDocument();
      expect(screen.getByText(/Template type coverage/i)).toBeInTheDocument();
    });
  });

  it('displays production route validation results', async () => {
    fetch
      .mockResolvedValueOnce({ ok: true, json: async () => ({ id: '123' }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ id: '123' }) })
      .mockResolvedValueOnce({ ok: true })
      .mockResolvedValueOnce({ ok: true })
      .mockResolvedValueOnce({ ok: true })
      .mockResolvedValueOnce({ ok: true })
      .mockResolvedValueOnce({ ok: true, status: 200 })
      .mockResolvedValueOnce({ ok: true, json: async () => [] })
      .mockResolvedValueOnce({ ok: true, json: async () => [] })
      .mockResolvedValueOnce({ ok: true, json: async () => [] })
      .mockResolvedValueOnce({ ok: false })
      .mockResolvedValueOnce({ ok: true, json: async () => [] })
      .mockResolvedValueOnce({ ok: true })
      .mockResolvedValueOnce({ ok: true })
      .mockResolvedValueOnce({ ok: true })
      .mockResolvedValueOnce({ ok: true })
      .mockResolvedValueOnce({ ok: false })
      .mockResolvedValueOnce({ ok: false })
      .mockResolvedValueOnce({ ok: true });

    render(<Phase2ValidationSuite />);

    await waitFor(() => {
      expect(screen.getByText(/\/trips route works/i)).toBeInTheDocument();
      expect(screen.getByText(/\/p\/:slug direct access/i)).toBeInTheDocument();
      expect(screen.getByText(/404 for non-existent page/i)).toBeInTheDocument();
    });
  });

  it('shows READY FOR PHASE 2 when all tests pass', async () => {
    fetch
      .mockResolvedValueOnce({ ok: true, json: async () => ({ id: '123' }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ id: '123' }) })
      .mockResolvedValueOnce({ ok: true })
      .mockResolvedValueOnce({ ok: true })
      .mockResolvedValueOnce({ ok: true })
      .mockResolvedValueOnce({ ok: true })
      .mockResolvedValueOnce({ ok: true, status: 200 })
      .mockResolvedValueOnce({ ok: true, json: async () => [] })
      .mockResolvedValueOnce({ ok: true, json: async () => [] })
      .mockResolvedValueOnce({ ok: true, json: async () => [] })
      .mockResolvedValueOnce({ ok: false })
      .mockResolvedValueOnce({ ok: true, json: async () => [{ id: '1' }] })
      .mockResolvedValueOnce({ ok: true })
      .mockResolvedValueOnce({ ok: true })
      .mockResolvedValueOnce({ ok: true })
      .mockResolvedValueOnce({ ok: true })
      .mockResolvedValueOnce({ ok: false })
      .mockResolvedValueOnce({ ok: false })
      .mockResolvedValueOnce({ ok: true });

    render(<Phase2ValidationSuite />);

    await waitFor(() => {
      expect(screen.getByText(/READY FOR PHASE 2/i)).toBeInTheDocument();
    });
  });

  it('shows detailed test results', async () => {
    fetch
      .mockResolvedValueOnce({ ok: true, json: async () => ({ id: '123' }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ id: '123' }) })
      .mockResolvedValueOnce({ ok: true })
      .mockResolvedValueOnce({ ok: true })
      .mockResolvedValueOnce({ ok: true })
      .mockResolvedValueOnce({ ok: true })
      .mockResolvedValueOnce({ ok: true, status: 200 })
      .mockResolvedValueOnce({ ok: true, json: async () => [] })
      .mockResolvedValueOnce({ ok: true, json: async () => [] })
      .mockResolvedValueOnce({ ok: true, json: async () => [] })
      .mockResolvedValueOnce({ ok: false })
      .mockResolvedValueOnce({ ok: true, json: async () => [] })
      .mockResolvedValueOnce({ ok: true })
      .mockResolvedValueOnce({ ok: true })
      .mockResolvedValueOnce({ ok: true })
      .mockResolvedValueOnce({ ok: true })
      .mockResolvedValueOnce({ ok: false })
      .mockResolvedValueOnce({ ok: false })
      .mockResolvedValueOnce({ ok: true });

    render(<Phase2ValidationSuite />);

    await waitFor(() => {
      // Should show detailed results section
      expect(screen.getByText(/Detailed Results/i)).toBeInTheDocument();
    });
  });

  it('provides next steps recommendations', async () => {
    fetch
      .mockResolvedValueOnce({ ok: true, json: async () => ({ id: '123' }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ id: '123' }) })
      .mockResolvedValueOnce({ ok: true })
      .mockResolvedValueOnce({ ok: true })
      .mockResolvedValueOnce({ ok: true })
      .mockResolvedValueOnce({ ok: true })
      .mockResolvedValueOnce({ ok: true, status: 200 })
      .mockResolvedValueOnce({ ok: true, json: async () => [] })
      .mockResolvedValueOnce({ ok: true, json: async () => [] })
      .mockResolvedValueOnce({ ok: true, json: async () => [] })
      .mockResolvedValueOnce({ ok: false })
      .mockResolvedValueOnce({ ok: true, json: async () => [] })
      .mockResolvedValueOnce({ ok: true })
      .mockResolvedValueOnce({ ok: true })
      .mockResolvedValueOnce({ ok: true })
      .mockResolvedValueOnce({ ok: true })
      .mockResolvedValueOnce({ ok: false })
      .mockResolvedValueOnce({ ok: false })
      .mockResolvedValueOnce({ ok: true });

    render(<Phase2ValidationSuite />);

    await waitFor(() => {
      expect(screen.getByText(/Next Steps/i)).toBeInTheDocument();
    });
  });

  it('handles API errors gracefully', async () => {
    fetch.mockRejectedValue(new Error('Network error'));

    render(<Phase2ValidationSuite />);

    await waitFor(() => {
      expect(screen.getByText(/validation error/i)).toBeInTheDocument();
    });
  });

  it('shows test pass/fail indicators', async () => {
    fetch
      .mockResolvedValueOnce({ ok: true, json: async () => ({ id: '123' }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ id: '123' }) })
      .mockResolvedValueOnce({ ok: true })
      .mockResolvedValueOnce({ ok: true })
      .mockResolvedValueOnce({ ok: true })
      .mockResolvedValueOnce({ ok: true })
      .mockResolvedValueOnce({ ok: true, status: 200 })
      .mockResolvedValueOnce({ ok: true, json: async () => [] })
      .mockResolvedValueOnce({ ok: true, json: async () => [] })
      .mockResolvedValueOnce({ ok: true, json: async () => [] })
      .mockResolvedValueOnce({ ok: false })
      .mockResolvedValueOnce({ ok: true, json: async () => [] })
      .mockResolvedValueOnce({ ok: true })
      .mockResolvedValueOnce({ ok: true })
      .mockResolvedValueOnce({ ok: true })
      .mockResolvedValueOnce({ ok: true })
      .mockResolvedValueOnce({ ok: false })
      .mockResolvedValueOnce({ ok: false })
      .mockResolvedValueOnce({ ok: true });

    render(<Phase2ValidationSuite />);

    await waitFor(() => {
      // Should show checkmark indicators
      expect(screen.getByText(/✅|❌/)).toBeInTheDocument();
    });
  });

  it('shows test suite summary cards', async () => {
    fetch
      .mockResolvedValueOnce({ ok: true, json: async () => ({ id: '123' }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ id: '123' }) })
      .mockResolvedValueOnce({ ok: true })
      .mockResolvedValueOnce({ ok: true })
      .mockResolvedValueOnce({ ok: true })
      .mockResolvedValueOnce({ ok: true })
      .mockResolvedValueOnce({ ok: true, status: 200 })
      .mockResolvedValueOnce({ ok: true, json: async () => [] })
      .mockResolvedValueOnce({ ok: true, json: async () => [] })
      .mockResolvedValueOnce({ ok: true, json: async () => [] })
      .mockResolvedValueOnce({ ok: false })
      .mockResolvedValueOnce({ ok: true, json: async () => [] })
      .mockResolvedValueOnce({ ok: true })
      .mockResolvedValueOnce({ ok: true })
      .mockResolvedValueOnce({ ok: true })
      .mockResolvedValueOnce({ ok: true })
      .mockResolvedValueOnce({ ok: false })
      .mockResolvedValueOnce({ ok: false })
      .mockResolvedValueOnce({ ok: true });

    render(<Phase2ValidationSuite />);

    await waitFor(() => {
      // Should show grid of 4 test suite cards
      expect(screen.getByText(/Builder Round-Trip/i)).toBeInTheDocument();
      expect(screen.getByText(/Schema Compatibility/i)).toBeInTheDocument();
      expect(screen.getByText(/Regression Dataset/i)).toBeInTheDocument();
      expect(screen.getByText(/Production Route/i)).toBeInTheDocument();
    });
  });

  it('includes test count in each suite', async () => {
    fetch
      .mockResolvedValueOnce({ ok: true, json: async () => ({ id: '123' }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ id: '123' }) })
      .mockResolvedValueOnce({ ok: true })
      .mockResolvedValueOnce({ ok: true })
      .mockResolvedValueOnce({ ok: true })
      .mockResolvedValueOnce({ ok: true })
      .mockResolvedValueOnce({ ok: true, status: 200 })
      .mockResolvedValueOnce({ ok: true, json: async () => [] })
      .mockResolvedValueOnce({ ok: true, json: async () => [] })
      .mockResolvedValueOnce({ ok: true, json: async () => [] })
      .mockResolvedValueOnce({ ok: false })
      .mockResolvedValueOnce({ ok: true, json: async () => [] })
      .mockResolvedValueOnce({ ok: true })
      .mockResolvedValueOnce({ ok: true })
      .mockResolvedValueOnce({ ok: true })
      .mockResolvedValueOnce({ ok: true })
      .mockResolvedValueOnce({ ok: false })
      .mockResolvedValueOnce({ ok: false })
      .mockResolvedValueOnce({ ok: true });

    render(<Phase2ValidationSuite />);

    await waitFor(() => {
      // Should show test count like "6/6 tests passed"
      expect(screen.getByText(/tests passed/i)).toBeInTheDocument();
    });
  });
});
