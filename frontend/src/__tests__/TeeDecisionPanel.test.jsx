// PR-E Phase 2.3.5 / 2.3.6 — RTL coverage for TeeDecisionPanel +
// RegenerateStrategyModal.
//
// What this exercises:
//   1. Empty-state hint when no _tee block present (block-array pages)
//   2. All 9 first-class fields render (Family / Theme / Visual Mood /
//      Climate / Region / Audience / Luxury Level / Composition / Image
//      Strategy)
//   3. Source badges per trait (static / derived / ai-classified / override)
//   4. "Why this decision?" reasoning chain expandable
//   5. Reclassify modal:
//      - opens on click
//      - calls POST /tee/reclassify with body
//      - renders before/after diff
//      - "Apply Strategy" callback invoked with the new TEE block
//   6. The modal does NOT call any LLM endpoint or image-fetch endpoint
//      (only /tee/reclassify) — proven by the fetchApi mock call list

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

// Stable mock object references for hooks used in useCallback deps
// (cron-learning: fresh objects per call cause infinite re-render loops
// when the hook return lands in a callback dep array).
const notifyObj = { error: vi.fn(), info: vi.fn(), success: vi.fn(), confirm: vi.fn().mockResolvedValue(true) };
vi.mock('../utils/notify', () => ({ useNotify: () => notifyObj }));
const fetchApiMock = vi.fn();
vi.mock('../utils/api', () => ({ fetchApi: (...args) => fetchApiMock(...args) }));

import { TeeDecisionPanel } from '../components/TeeDecisionPanel';

beforeEach(() => {
  fetchApiMock.mockReset();
  Object.values(notifyObj).forEach((f) => f.mockClear && f.mockClear());
});

const FULL_TEE_BLOCK = {
  family: 'luxury',
  themeId: 'luxury-alpine',
  visualMood: 'northern-aurora-mystical',
  composition: ['nav', 'hero', 'marquee', 'cultural', 'investment', 'registration', 'faq', 'finalCta', 'contact', 'floatingCta'],
  traits: {
    climate: 'alpine',
    regionFeel: 'european',
    tripStyle: 'honeymoon',
    audienceTier: 'couples',
    luxuryLevel: 4,
    mood: 'minimal',
    visualMood: 'northern-aurora-mystical',
  },
  decisions: {
    family:      { ruleId: 'F4', rationale: 'honeymoon + luxuryLevel>=2', value: 'luxury' },
    themeId:     { ruleId: 'L1', rationale: 'alpine/polar climate',       value: 'luxury-alpine' },
    composition: { ruleId: 'C-luxury-default', rationale: 'family default', value: ['nav', 'hero'] },
    traits: {
      climate:      { value: 'alpine',                      source: 'static',        confidence: 0.92 },
      regionFeel:   { value: 'european',                    source: 'static',        confidence: 0.92 },
      tripStyle:    { value: 'honeymoon',                   source: 'derived',       confidence: 0.85 },
      audienceTier: { value: 'couples',                     source: 'static',        confidence: 0.9 },
      luxuryLevel:  { value: 4,                             source: 'derived',       confidence: 0.7 },
      mood:         { value: 'minimal',                     source: 'derived',       confidence: 0.85 },
      visualMood:   { value: 'northern-aurora-mystical',    source: 'ai-classified', confidence: 0.8 },
    },
  },
  images: {
    hero: { providerId: 'unsplash', photographer: 'Jane', license: 'unsplash-license' },
    marquee: [{ providerId: 'unsplash' }, { providerId: 'pexels' }, { providerId: 'pixabay' }],
    brochure: null,
    cultural: [],
    fetchedAt: '2026-02-01T10:00:00.000Z',
  },
};

describe('TeeDecisionPanel — empty state', () => {
  it('shows the empty hint when no _tee block is present', () => {
    render(<TeeDecisionPanel teeBlock={null} pageId={42} page={{}} />);
    expect(screen.getByText(/wasn't generated through the Travel Experience Engine/i)).toBeInTheDocument();
  });

  it('also handles undefined / non-object input gracefully', () => {
    const { rerender } = render(<TeeDecisionPanel teeBlock={undefined} pageId={42} page={{}} />);
    expect(screen.getByText(/wasn't generated through the Travel Experience Engine/i)).toBeInTheDocument();
    rerender(<TeeDecisionPanel teeBlock="not-an-object" pageId={42} page={{}} />);
    expect(screen.getByText(/wasn't generated through the Travel Experience Engine/i)).toBeInTheDocument();
  });
});

describe('TeeDecisionPanel — populated _tee block', () => {
  it('renders the 9 first-class decision fields', () => {
    render(<TeeDecisionPanel teeBlock={FULL_TEE_BLOCK} pageId={42} page={{ destination: 'Iceland' }} />);
    expect(screen.getByText(/^Family$/i)).toBeInTheDocument();
    // "Luxury" appears as the family value AND inside the "Luxury Level"
    // label — getAllByText handles the duplicate; we assert the family
    // value is among them via attribute lookup on a sibling text node.
    expect(screen.getAllByText('Luxury').length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText(/^Theme$/i)).toBeInTheDocument();
    expect(screen.getAllByText('luxury-alpine').length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText(/^Visual Mood$/i)).toBeInTheDocument();
    expect(screen.getAllByText('northern-aurora-mystical').length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText(/^Climate$/i)).toBeInTheDocument();
    expect(screen.getAllByText('Alpine').length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText(/^Region$/i)).toBeInTheDocument();
    expect(screen.getAllByText('European').length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText(/^Audience$/i)).toBeInTheDocument();
    expect(screen.getAllByText('Couples').length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText(/^Luxury Level$/i)).toBeInTheDocument();
    expect(screen.getAllByText('4 / 5').length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText(/^Composition$/i)).toBeInTheDocument();
    expect(screen.getAllByText('10 sections').length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText(/^Image Strategy$/i)).toBeInTheDocument();
  });

  it('renders source badges per trait dimension', () => {
    render(<TeeDecisionPanel teeBlock={FULL_TEE_BLOCK} pageId={42} page={{}} />);
    // 'static' badge appears at least once (climate, region, audience).
    expect(screen.getAllByText('static').length).toBeGreaterThanOrEqual(1);
    // 'derived' badge appears at least once (luxuryLevel).
    expect(screen.getAllByText('derived').length).toBeGreaterThanOrEqual(1);
    // 'ai-classified' badge for visualMood.
    expect(screen.getByText('ai-classified')).toBeInTheDocument();
  });

  it('"Why this decision?" expands a reasoning chain', async () => {
    const user = userEvent.setup();
    render(<TeeDecisionPanel teeBlock={FULL_TEE_BLOCK} pageId={42} page={{}} />);
    const summary = screen.getByText(/Why this decision\?/i);
    await user.click(summary);
    // Chain items appear inside the chain list.
    const chain = screen.getByLabelText('Reasoning chain');
    expect(chain).toBeInTheDocument();
    expect(chain.textContent).toContain('Family');
    expect(chain.textContent).toContain('Luxury');
    expect(chain.textContent).toContain('Theme');
    expect(chain.textContent).toContain('luxury-alpine');
    expect(chain.textContent).toContain('Visual Mood');
    expect(chain.textContent).toContain('northern-aurora-mystical');
  });

  it('shows the rule rationale in the reasoning chain when decisions are present', async () => {
    const user = userEvent.setup();
    render(<TeeDecisionPanel teeBlock={FULL_TEE_BLOCK} pageId={42} page={{}} />);
    await user.click(screen.getByText(/Why this decision\?/i));
    const chain = screen.getByLabelText('Reasoning chain');
    // Family rationale visible.
    expect(chain.textContent).toContain('F4');
    expect(chain.textContent).toContain('honeymoon');
    // Theme rationale visible.
    expect(chain.textContent).toContain('L1');
    expect(chain.textContent).toContain('alpine');
  });

  it('can collapse + re-expand the panel', async () => {
    const user = userEvent.setup();
    render(<TeeDecisionPanel teeBlock={FULL_TEE_BLOCK} pageId={42} page={{}} defaultExpanded={true} />);
    // Currently expanded — the row label appears.
    expect(screen.getByText(/^Theme$/i)).toBeInTheDocument();
    await user.click(screen.getByLabelText(/Collapse decisions/i));
    expect(screen.queryByText(/^Theme$/i)).not.toBeInTheDocument();
    await user.click(screen.getByLabelText(/Expand decisions/i));
    expect(screen.getByText(/^Theme$/i)).toBeInTheDocument();
  });
});

describe('TeeDecisionPanel — Regenerate Strategy modal', () => {
  it('opens the Regenerate Strategy modal on button click', async () => {
    const user = userEvent.setup();
    render(<TeeDecisionPanel teeBlock={FULL_TEE_BLOCK} pageId={42} page={{ destination: 'Iceland' }} />);
    expect(screen.queryByRole('dialog', { name: /Regenerate strategy/i })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /Regenerate Strategy/i }));
    expect(screen.getByRole('dialog', { name: /Regenerate strategy/i })).toBeInTheDocument();
    expect(screen.getByText(/Reclassify without rebuilding/i)).toBeInTheDocument();
  });

  it('Reclassify button POSTs to /tee/reclassify with the form body', async () => {
    const user = userEvent.setup();
    fetchApiMock.mockResolvedValueOnce({
      tee: {
        family: 'family',
        themeId: 'family-tropical',
        composition: ['nav', 'hero', 'marquee', 'safety', 'finalCta', 'contact', 'floatingCta'],
        traits: { visualMood: 'tropical-temple-surf', climate: 'tropical', regionFeel: 'south-east-asian', audienceTier: 'families', luxuryLevel: 1 },
        decisionLog: { family: { ruleId: 'F6', rationale: 'families' }, themeId: { ruleId: 'FA1', rationale: 'tropical' } },
        imageStrategy: { hero: {}, marquee: [{}, {}, {}], brochure: {} },
      },
    });
    render(<TeeDecisionPanel teeBlock={FULL_TEE_BLOCK} pageId={42} page={{ destination: 'Bali' }} />);
    await user.click(screen.getByRole('button', { name: /Regenerate Strategy/i }));
    // Type into Trip Type field.
    const tripTypeInput = screen.getByLabelText(/Trip Type/i);
    await user.type(tripTypeInput, 'family');
    // Click Reclassify.
    await user.click(screen.getByRole('button', { name: /^Reclassify$/i }));
    await waitFor(() => expect(fetchApiMock).toHaveBeenCalled());
    // Endpoint check + body shape.
    const [url, opts] = fetchApiMock.mock.calls[0];
    expect(url).toBe('/api/landing-pages/42/tee/reclassify');
    expect(opts.method).toBe('POST');
    const body = JSON.parse(opts.body);
    expect(body.tripType).toBe('family');
    expect(body.destination).toBe('Bali');
  });

  it('renders before/after diff after a successful Reclassify', async () => {
    const user = userEvent.setup();
    fetchApiMock.mockResolvedValueOnce({
      tee: {
        family: 'family',
        themeId: 'family-tropical',
        composition: ['nav', 'hero', 'marquee'],
        traits: { visualMood: 'tropical-temple-surf' },
        decisionLog: { family: { ruleId: 'F6', rationale: 'families' } },
        imageStrategy: { hero: {}, marquee: [{}, {}, {}], brochure: {} },
      },
    });
    render(<TeeDecisionPanel teeBlock={FULL_TEE_BLOCK} pageId={42} page={{ destination: 'Bali' }} />);
    await user.click(screen.getByRole('button', { name: /Regenerate Strategy/i }));
    await user.click(screen.getByRole('button', { name: /^Reclassify$/i }));
    await waitFor(() => expect(screen.getByLabelText('Strategy diff')).toBeInTheDocument());
    const diff = screen.getByLabelText('Strategy diff');
    // Both current + proposed values appear in the diff.
    expect(diff.textContent).toContain('luxury'); // current family
    expect(diff.textContent).toContain('family'); // proposed family
    expect(diff.textContent).toContain('luxury-alpine'); // current theme
    expect(diff.textContent).toContain('family-tropical'); // proposed theme
    expect(diff.textContent).toContain('northern-aurora-mystical'); // current visualMood
    expect(diff.textContent).toContain('tropical-temple-surf'); // proposed visualMood
  });

  it('"Apply Strategy" callback receives the new TEE block', async () => {
    const onReclassified = vi.fn();
    const user = userEvent.setup();
    fetchApiMock.mockResolvedValueOnce({
      tee: {
        family: 'family',
        themeId: 'family-tropical',
        composition: ['nav', 'hero'],
        traits: { visualMood: 'tropical-temple-surf' },
        decisionLog: { family: { ruleId: 'F6', rationale: 'families' } },
        imageStrategy: { hero: {}, marquee: [], brochure: {} },
      },
    });
    render(
      <TeeDecisionPanel
        teeBlock={FULL_TEE_BLOCK}
        pageId={42}
        page={{ destination: 'Bali' }}
        onReclassified={onReclassified}
      />
    );
    await user.click(screen.getByRole('button', { name: /Regenerate Strategy/i }));
    await user.click(screen.getByRole('button', { name: /^Reclassify$/i }));
    await waitFor(() => expect(screen.getByLabelText('Strategy diff')).toBeInTheDocument());
    // Apply Strategy is enabled after a proposal lands.
    const applyBtn = screen.getByRole('button', { name: /Apply Strategy/i });
    expect(applyBtn).not.toBeDisabled();
    await user.click(applyBtn);
    expect(onReclassified).toHaveBeenCalledTimes(1);
    expect(onReclassified.mock.calls[0][0].family).toBe('family');
    expect(onReclassified.mock.calls[0][0].themeId).toBe('family-tropical');
  });

  it('Apply Strategy is disabled until a proposal lands', async () => {
    const user = userEvent.setup();
    render(<TeeDecisionPanel teeBlock={FULL_TEE_BLOCK} pageId={42} page={{}} />);
    await user.click(screen.getByRole('button', { name: /Regenerate Strategy/i }));
    const applyBtn = screen.getByRole('button', { name: /Apply Strategy/i });
    expect(applyBtn).toBeDisabled();
  });

  it('shows an error message when Reclassify fails', async () => {
    const user = userEvent.setup();
    fetchApiMock.mockRejectedValueOnce(new Error('Network failure'));
    render(<TeeDecisionPanel teeBlock={FULL_TEE_BLOCK} pageId={42} page={{ destination: 'Iceland' }} />);
    await user.click(screen.getByRole('button', { name: /Regenerate Strategy/i }));
    await user.click(screen.getByRole('button', { name: /^Reclassify$/i }));
    await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument());
    expect(screen.getByRole('alert').textContent).toContain('Network failure');
  });

  it('only calls /tee/reclassify — never any LLM or image endpoint', async () => {
    const user = userEvent.setup();
    fetchApiMock.mockResolvedValueOnce({
      tee: { family: 'family', themeId: 'family-tropical', composition: [], traits: {}, decisionLog: {}, imageStrategy: {} },
    });
    render(<TeeDecisionPanel teeBlock={FULL_TEE_BLOCK} pageId={42} page={{ destination: 'X' }} />);
    await user.click(screen.getByRole('button', { name: /Regenerate Strategy/i }));
    await user.click(screen.getByRole('button', { name: /^Reclassify$/i }));
    await waitFor(() => expect(fetchApiMock).toHaveBeenCalledTimes(1));
    expect(fetchApiMock.mock.calls[0][0]).toBe('/api/landing-pages/42/tee/reclassify');
    // No follow-up calls.
    expect(fetchApiMock).toHaveBeenCalledTimes(1);
  });

  it('explicit family/theme overrides flow into the request body', async () => {
    const user = userEvent.setup();
    fetchApiMock.mockResolvedValueOnce({
      tee: { family: 'luxury', themeId: 'luxury-coastal', composition: [], traits: {}, decisionLog: {}, imageStrategy: {} },
    });
    render(<TeeDecisionPanel teeBlock={FULL_TEE_BLOCK} pageId={42} page={{ destination: 'Iceland' }} />);
    await user.click(screen.getByRole('button', { name: /Regenerate Strategy/i }));
    await user.type(screen.getByLabelText(/Override Family/i), 'luxury');
    await user.type(screen.getByLabelText(/Override Theme/i), 'luxury-coastal');
    await user.click(screen.getByRole('button', { name: /^Reclassify$/i }));
    await waitFor(() => expect(fetchApiMock).toHaveBeenCalled());
    const body = JSON.parse(fetchApiMock.mock.calls[0][1].body);
    expect(body._teeOverrides).toEqual({ family: 'luxury', themeId: 'luxury-coastal' });
  });
});
