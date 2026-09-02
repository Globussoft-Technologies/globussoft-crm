import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import ExplorePage from '../pages/public/ExplorePage';

const here = dirname(fileURLToPath(import.meta.url));
const SRC = resolve(here, '..');

function mockExplorePayload(payload = {}) {
  vi.stubGlobal('fetch', vi.fn((url, options) => {
    const path = String(url);
    if (path.startsWith('/api/explore')) {
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({
          trips: [],
          catalogue: [],
          files: [],
          ...payload,
        }),
      });
    }
    if (path.includes('/api/travel/diagnostics/public/form/') && options?.method !== 'POST') {
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({
          tenantSlug: 'travel-demo',
          subBrand: 'tmc',
          form: {
            title: 'Student travel fit finder',
            subtitle: 'Tell us what matters most for this journey.',
            includeName: true,
            includeEmail: true,
            includePhone: false,
            nameRequired: true,
            emailRequired: true,
          },
          questions: [
            {
              id: 'growth',
              text: "What's the one outcome you most want this trip to produce?",
              type: 'single-select',
              options: [
                { value: 'confidence', label: 'Confidence' },
                { value: 'curiosity', label: 'Curiosity' },
              ],
            },
            {
              id: 'skills',
              text: 'Which two skills would you most want this trip to strengthen?',
              type: 'multi-select',
              max: 2,
              options: [
                { value: 'empathy', label: 'Empathy' },
                { value: 'teamwork', label: 'Collaboration and teamwork' },
              ],
            },
          ],
        }),
      });
    }
    if (path.includes('/api/travel/diagnostics/public/form/') && options?.method === 'POST') {
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({
          diagnosticId: 42,
          reportSlug: '42-abc123abc123abcd',
          classificationLabel: 'Curriculum-Aligned & Outcome-Focused',
          recommendedTier: 'TMC Signature',
          curriculumFit: {
            recommendations: [
              { destination: 'Hampi Heritage Trail', fitScore: 92, reasons: [] },
            ],
          },
        }),
      });
    }
    if (path.includes('/api/travel/diagnostics/public/report/') && options?.method !== 'POST') {
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({
          diagnosticId: 42,
          classificationLabel: 'Curriculum-Aligned & Outcome-Focused',
          recommendedTier: 'TMC Signature',
          reportPdfUrl: '/api/reports/42.pdf',
          curriculumFit: {
            recommendations: [
              {
                destination: 'Hampi Heritage Trail',
                fitScore: 92,
                reasons: [{ rationale: 'Strong link to history and architecture outcomes.' }],
                brochurePdfUrl: 'https://drive.example/hampi',
              },
            ],
          },
          ragResult: {
            recommendations: {
              summary: 'A strong curriculum-led school expedition profile.',
              recommendedTrips: [
                { name: 'Hampi Heritage Trail', summary: 'Temples, geology, and design thinking.', driveLink: 'https://drive.example/hampi' },
              ],
            },
          },
          chosenInterests: { interests: [], submittedAt: null },
        }),
      });
    }
    if (path.includes('/api/travel/diagnostics/public/report/') && options?.method === 'POST') {
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ ok: true, submittedAt: '2026-09-01T10:00:00.000Z' }),
      });
    }
    return Promise.resolve({ ok: false, json: () => Promise.resolve({ error: 'Unexpected request' }) });
  }));
}

describe('ExplorePage public shell', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    sessionStorage.clear();
  });

  it('renders the travel header navigation', async () => {
    mockExplorePayload();

    render(<ExplorePage />);

    expect(screen.getByRole('link', { name: /The Modern School/i })).toHaveAttribute('href', '/explore');
    expect(screen.getByRole('link', { name: 'Explore' })).toHaveAttribute('href', '#top');
    expect(screen.getByRole('link', { name: 'Current Journeys' })).toHaveAttribute('href', '#trips');
    expect(screen.getByRole('link', { name: 'Catalogues' })).toHaveAttribute('href', '#catalogues');
    expect(screen.queryByRole('link', { name: 'Destinations' })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Experiences' })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'About' })).not.toBeInTheDocument();

    await waitFor(() => expect(global.fetch).toHaveBeenCalledWith(
      expect.stringMatching(/^\/api\/explore\?ts=\d+$/),
      { cache: 'no-store' },
    ));
  });

  it('renders the enhanced hero actions without the removed search bar', () => {
    mockExplorePayload();

    render(<ExplorePage />);

    expect(screen.getByText('Journeys that')).toBeInTheDocument();
    expect(screen.getByText('inspire growth.')).toBeInTheDocument();
    expect(screen.queryByLabelText('Search destinations')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Travel timing')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Travel type')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Search trips' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Take the Diagnostic/i })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Browse Catalogues/i })).toHaveAttribute('href', '#catalogues');
    expect(screen.getByRole('navigation', { name: 'Explore navigation' }).querySelector('a[href="#trips"]')).toHaveTextContent('Current Journeys');
    expect(screen.queryByRole('link', { name: 'Destinations' })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Experiences' })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'About' })).not.toBeInTheDocument();
    expect(screen.queryByText('Curated journeys')).not.toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: /Where would you like to begin\?/i })).not.toBeInTheDocument();
  });

  it('loads the existing diagnostic questions into a native Explore-page UI', async () => {
    mockExplorePayload({ tenantSlug: 'travel-demo' });

    render(<ExplorePage />);

    await waitFor(() => expect(global.fetch).toHaveBeenCalledWith(
      expect.stringMatching(/^\/api\/explore\?ts=\d+$/),
      { cache: 'no-store' },
    ));
    fireEvent.click(screen.getByRole('button', { name: /Take the Diagnostic/i }));

    expect(await screen.findByText(/Student travel fit finder/i)).toBeInTheDocument();
    expect(screen.getByText(/What's the one outcome/i)).toBeInTheDocument();
    expect(screen.getByText(/Which two skills/i)).toBeInTheDocument();
    expect(screen.queryByTitle('Travel diagnostic')).not.toBeInTheDocument();
    expect(global.fetch).toHaveBeenCalledWith('/api/travel/diagnostics/public/form/travel-demo/tmc');
  });

  it('shows catalogue names without the trailing PDF extension', async () => {
    mockExplorePayload({
      files: [
        {
          id: 'file-1',
          fileName: 'Nagarhole & Coorg (1).pdf',
          driveViewLink: 'https://drive.example/nagarhole',
          imageUrl: 'https://images.example/nagarhole.jpg',
        },
      ],
    });

    render(<ExplorePage />);

    expect(await screen.findByText('Nagarhole & Coorg (1)')).toBeInTheDocument();
    expect(screen.queryByText('Nagarhole & Coorg (1).pdf')).not.toBeInTheDocument();
    expect(screen.getByRole('img', { name: 'Nagarhole & Coorg (1)' })).toBeInTheDocument();
    expect(screen.getByLabelText('Nagarhole & Coorg (1) highlights')).toHaveTextContent('Wildlife');
    expect(screen.getByLabelText('Nagarhole & Coorg (1) highlights')).toHaveTextContent('Nature');
    expect(screen.getByLabelText('Nagarhole & Coorg (1) highlights')).toHaveTextContent('Adventure');
    expect(screen.queryByText('2025 Edition')).not.toBeInTheDocument();
    expect(screen.queryByText('2026 Edition')).not.toBeInTheDocument();
  });

  it('shows eight catalogue cards per page and keeps checkbox selection behavior', async () => {
    mockExplorePayload({
      files: Array.from({ length: 9 }, (_, index) => ({
        id: `file-${index + 1}`,
        fileName: `Catalogue ${index + 1}.pdf`,
        driveViewLink: `https://drive.example/catalogue-${index + 1}`,
        imageUrl: `https://images.example/catalogue-${index + 1}.jpg`,
      })),
    });

    render(<ExplorePage />);

    expect(await screen.findByText('Catalogue 1')).toBeInTheDocument();
    expect(screen.getByText('Catalogue 8')).toBeInTheDocument();
    expect(screen.queryByText('Catalogue 9')).not.toBeInTheDocument();
    expect(screen.getAllByRole('link', { name: /View Catalogue \d/i })).toHaveLength(8);

    const checkbox = screen.getByLabelText('Choose Catalogue 1');
    fireEvent.click(checkbox);

    expect(checkbox.checked).toBe(true);
    expect(screen.getByText('Submit interest (1)')).toBeInTheDocument();
    expect(checkbox.closest('article')).toHaveClass('is-selected');

    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    expect(await screen.findByText('Catalogue 9')).toBeInTheDocument();
    expect(screen.queryByText('Catalogue 8')).not.toBeInTheDocument();
  });

  it('submits the native diagnostic and saves selected recommendation interests', async () => {
    mockExplorePayload({ tenantSlug: 'travel-demo' });

    render(<ExplorePage />);

    fireEvent.click(screen.getByRole('button', { name: /Take the Diagnostic/i }));
    await screen.findByText(/Student travel fit finder/i);

    fireEvent.click(screen.getByLabelText('Confidence'));
    fireEvent.click(screen.getByLabelText('Empathy'));
    fireEvent.change(screen.getByLabelText(/Name/i), { target: { value: 'Asha Sharma' } });
    fireEvent.change(screen.getByLabelText(/Email/i), { target: { value: 'asha@example.test' } });
    fireEvent.click(screen.getByRole('button', { name: /See my recommendations/i }));

    await screen.findByText(/Diagnostic submitted/i);
    expect(screen.getAllByText('Hampi Heritage Trail').length).toBeGreaterThan(0);
    expect(screen.getByText(/A strong curriculum-led school expedition profile/i)).toBeInTheDocument();

    const submitCall = global.fetch.mock.calls.find(
      ([url, options]) => String(url).includes('/submit') && options?.method === 'POST',
    );
    expect(submitCall).toBeTruthy();
    expect(JSON.parse(submitCall[1].body)).toEqual({
      answers: { growth: 'confidence', skills: ['empathy'] },
      name: 'Asha Sharma',
      email: 'asha@example.test',
    });

    fireEvent.click(screen.getByLabelText(/I'm interested in Hampi Heritage Trail/i));
    fireEvent.click(screen.getByRole('button', { name: /Submit chosen interests \(1\)/i }));

    await screen.findByText(/Your interests are saved for the advisor team/i);
    const interestsCall = global.fetch.mock.calls.find(
      ([url, options]) => String(url).includes('/interests') && options?.method === 'POST',
    );
    expect(interestsCall).toBeTruthy();
    expect(JSON.parse(interestsCall[1].body)).toEqual({
      interests: [{ name: 'Hampi Heritage Trail', driveLink: 'https://drive.example/hampi' }],
    });
  });

  it('uses the reference-style full-bleed desktop header and hero rules', () => {
    const css = readFileSync(resolve(SRC, 'pages/public/ExplorePageOverrides.css'), 'utf8');

    expect(css).toContain('position: absolute;');
    expect(css).toContain("url('https://images.unsplash.com/photo-1530789253388-582c481c54b0?w=2400&q=95') center/cover");
    expect(css).toContain('.explore-hero-cards');
    expect(css).toContain('.explore-diagnostic-panel');
    expect(css).toContain('margin-top: 46px;');
    expect(css).toContain('grid-template-columns: repeat(3, minmax(0, 1fr));');
    expect(css).toContain('.explore-question-card');
    expect(css).toContain('.explore-result-block');
    expect(css).toContain('.catalogue-tags');
    expect(css).toContain('grid-template-columns: repeat(4, minmax(0, 1fr));');
    expect(css).toContain('height: 134px;');
  });
});
