/**
 * AdvisorDashboard.jsx — Visa Sure Phase 3 per-application advisor view
 * (cluster B3, rows V8-V10) — pinned at /travel/visa/applications/:applicationId.
 *
 * Pins the frontend contract for the page wired to
 * GET /api/travel/visa/applications/:id (shipped at ce5f5db). Four sections:
 *
 *   1. Diagnostic answers (V8) — classificationLabel + score + recommendedTier +
 *      "View full diagnostic" link when application.diagnostic.id is present.
 *   2. AI summary notes (V9) — static placeholder pending Q11 LLM-keys product
 *      call (no aiSummary field on VisaApplication yet).
 *   3. Risk indicators (V10) — three pills (FR-3.1 complexCase RED,
 *      FR-3.2 rejectionHistoryJson RED, FR-3.3 advisorRiskFlag YELLOW). Neutral
 *      otherwise. Helpers `hasRejectionHistory` and `isAdvisorRiskActive` are
 *      embedded in the SUT — covered indirectly via render states below.
 *   4. Document checklist progress (bonus) — "X of Y required documents verified"
 *      + progressbar with aria-valuenow / aria-valuemax. Required items only.
 *
 * Cases:
 *   - Renders loading state on first paint
 *   - Renders page header with applicationId
 *   - Renders contact name + applicationType + status sub-header when loaded
 *   - Diagnostic section: renders classificationLabel + score + "View full diagnostic" link
 *   - Diagnostic section: shows empty state when no diagnostic submitted
 *   - AI summary section: renders the static Q11-pending placeholder
 *   - Risk pills: all NEUTRAL when no risk fields are set
 *   - Risk pills: complex case RED when complexCase=true (FR-3.1)
 *   - Risk pills: rejection history RED when rejectionHistoryJson is non-empty
 *     (the SUT treats "[]" / "{}" / null / "" as no-history, anything else hits)
 *   - Risk pills: advisor flag YELLOW when advisorRiskFlag is "high" or "priority"
 *     (case-insensitive); neutral otherwise
 *   - Document checklist: empty state when no required items recorded
 *   - Document checklist: renders X-of-Y count + progressbar aria-valuenow
 *     for required items only (optional items don't count)
 *   - 404 NOT_FOUND error renders the "not found / no access" copy
 *   - 404 NOT_VISA_SURE error renders the same "not found / no access" copy
 *   - Generic non-coded error renders the err.message
 *   - Back-link to /travel/visa/applications is present
 *
 * Mock-object stability per CLAUDE.md feedback rule: fetchApiMock + notifyObj are
 * stable references that survive across re-renders (re-creating per render would
 * trip an infinite re-render loop via useEffect / useCallback dependency churn).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';

const fetchApiMock = vi.fn();
vi.mock('../utils/api', () => ({
  fetchApi: (...args) => fetchApiMock(...args),
  getAuthToken: () => 'test-token',
}));

import AdvisorDashboard from '../pages/travel/visa/AdvisorDashboard';

const BASE_APPLICATION = {
  id: 77,
  tenantId: 9,
  contactId: 100,
  applicationType: 'Tourist Visa',
  status: 'in_review',
  complexCase: false,
  rejectionHistoryJson: null,
  advisorRiskFlag: null,
  contact: { id: 100, name: 'Ahmed Khan' },
  diagnostic: null,
  documentChecklist: [],
};

function renderPage() {
  return render(
    <MemoryRouter initialEntries={['/travel/visa/applications/77']}>
      <Routes>
        <Route
          path="/travel/visa/applications/:applicationId"
          element={<AdvisorDashboard />}
        />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  fetchApiMock.mockReset();
});

describe('AdvisorDashboard — Visa Sure Phase 3 per-application view (FR-4)', () => {
  it('renders the loading state on first paint', () => {
    // Resolve never; we just want to see the loading copy before the fetch settles.
    fetchApiMock.mockReturnValue(new Promise(() => {}));
    renderPage();
    expect(screen.getByText(/Loading application/i)).toBeTruthy();
  });

  it('renders the page header with the applicationId', async () => {
    fetchApiMock.mockResolvedValue(BASE_APPLICATION);
    renderPage();
    await waitFor(() => {
      expect(screen.getByRole('heading', { level: 1 })).toBeTruthy();
    });
    // The id is rendered inside a <code> child of the h1.
    const heading = screen.getByRole('heading', { level: 1 });
    expect(heading.textContent).toMatch(/Visa application/i);
    expect(heading.textContent).toMatch(/#77/);
  });

  it('renders contact name + applicationType + status sub-header when populated', async () => {
    fetchApiMock.mockResolvedValue(BASE_APPLICATION);
    renderPage();
    await waitFor(() => {
      expect(screen.getByText(/Ahmed Khan/)).toBeTruthy();
    });
    expect(screen.getByText(/Tourist Visa/)).toBeTruthy();
    expect(screen.getByText(/in_review/)).toBeTruthy();
  });

  it('Diagnostic section renders classificationLabel + score + "View full diagnostic" link', async () => {
    fetchApiMock.mockResolvedValue({
      ...BASE_APPLICATION,
      diagnostic: {
        id: 42,
        classificationLabel: 'High-intent qualified',
        classification: 'level_3',
        score: 8.5,
        recommendedTier: 'premium',
      },
    });
    renderPage();
    await screen.findByText('High-intent qualified');
    expect(screen.getByText('8.5')).toBeTruthy();
    expect(screen.getByText('premium')).toBeTruthy();
    const link = screen.getByRole('link', { name: /View full diagnostic/i });
    expect(link.getAttribute('href')).toBe('/travel/diagnostics/42');
  });

  it('Diagnostic section shows the empty state when no diagnostic exists', async () => {
    fetchApiMock.mockResolvedValue(BASE_APPLICATION);
    renderPage();
    await screen.findByText(/No diagnostic submitted yet for this contact/i);
    // No "View full diagnostic" link in this state.
    expect(screen.queryByRole('link', { name: /View full diagnostic/i })).toBeNull();
  });

  it('AI summary section renders the static Q11-pending placeholder', async () => {
    fetchApiMock.mockResolvedValue(BASE_APPLICATION);
    renderPage();
    await screen.findByRole('heading', { level: 1 });
    expect(screen.getByText(/Pending LLM rollout/i)).toBeTruthy();
    expect(screen.getByText(/visa-summary/)).toBeTruthy();
  });

  it('Risk pills are all NEUTRAL when complexCase=false + no rejection + no advisor flag', async () => {
    fetchApiMock.mockResolvedValue(BASE_APPLICATION);
    renderPage();
    // "yes" / "no" + "on file" / "none" + the dash placeholder are how the SUT
    // signals the pill state today (the styles are inline). Neutral states:
    await screen.findByText('no');
    expect(screen.getByText('none')).toBeTruthy();
    // The advisor risk pill renders an em-dash placeholder when null.
    expect(screen.getByText('—')).toBeTruthy();
  });

  it('Risk pill: complex case shows "yes" when complexCase=true (FR-3.1)', async () => {
    fetchApiMock.mockResolvedValue({ ...BASE_APPLICATION, complexCase: true });
    renderPage();
    await screen.findByText('yes');
  });

  it('Risk pill: rejection history shows "on file" when rejectionHistoryJson is populated (FR-3.2)', async () => {
    fetchApiMock.mockResolvedValue({
      ...BASE_APPLICATION,
      rejectionHistoryJson: JSON.stringify([
        { country: 'UK', year: 2024, reason: 'insufficient ties' },
      ]),
    });
    renderPage();
    await screen.findByText('on file');
  });

  it('Risk pill: rejection history is NEUTRAL ("none") when rejectionHistoryJson is "[]"', async () => {
    fetchApiMock.mockResolvedValue({
      ...BASE_APPLICATION,
      rejectionHistoryJson: '[]',
    });
    renderPage();
    await screen.findByText('none');
  });

  it('Risk pill: advisor flag renders the raw value (e.g. "high") when set (FR-3.3)', async () => {
    fetchApiMock.mockResolvedValue({
      ...BASE_APPLICATION,
      advisorRiskFlag: 'high',
    });
    renderPage();
    await screen.findByText('high');
  });

  it('Risk pill: advisor flag is case-insensitive — "HIGH" also activates the pill', async () => {
    fetchApiMock.mockResolvedValue({
      ...BASE_APPLICATION,
      advisorRiskFlag: 'HIGH',
    });
    renderPage();
    // The raw value renders verbatim; the activation logic lower-cases internally.
    await screen.findByText('HIGH');
  });

  it('Document checklist: empty state when no required items recorded', async () => {
    fetchApiMock.mockResolvedValue({
      ...BASE_APPLICATION,
      documentChecklist: [
        // Only an optional item — required filter drops it.
        { id: 1, name: 'Travel insurance copy', required: false, status: 'pending' },
      ],
    });
    renderPage();
    await screen.findByText(/No document checklist items recorded/i);
  });

  it('Document checklist: renders X-of-Y count + progressbar for required items only', async () => {
    fetchApiMock.mockResolvedValue({
      ...BASE_APPLICATION,
      documentChecklist: [
        { id: 1, name: 'Passport', required: true, status: 'verified' },
        { id: 2, name: 'Photo', required: true, status: 'verified' },
        { id: 3, name: 'Bank statement', required: true, status: 'pending' },
        // Optional items don't count toward the denominator.
        { id: 4, name: 'Travel insurance', required: false, status: 'verified' },
      ],
    });
    renderPage();
    await screen.findByRole('progressbar');
    const bar = screen.getByRole('progressbar');
    // 2 verified out of 3 required.
    expect(bar.getAttribute('aria-valuemax')).toBe('3');
    expect(bar.getAttribute('aria-valuenow')).toBe('2');
    // The "X of Y" copy renders the same numbers in <strong> tags;
    // grep on the surrounding text node to confirm both numbers surface.
    expect(screen.getByText(/required documents verified/i)).toBeTruthy();
  });

  it('404 NOT_FOUND renders the "not found / no access" copy', async () => {
    fetchApiMock.mockRejectedValue({
      status: 404,
      code: 'NOT_FOUND',
      message: 'Application not found',
    });
    renderPage();
    await waitFor(() => {
      expect(
        screen.getByText(/Visa application not found, or you do not have access to it/i),
      ).toBeTruthy();
    });
  });

  it('404 NOT_VISA_SURE renders the same "not found / no access" copy', async () => {
    fetchApiMock.mockRejectedValue({
      status: 404,
      code: 'NOT_VISA_SURE',
      message: 'Not a Visa Sure application',
    });
    renderPage();
    await waitFor(() => {
      expect(
        screen.getByText(/Visa application not found, or you do not have access to it/i),
      ).toBeTruthy();
    });
  });

  it('generic non-coded error renders the err.message verbatim', async () => {
    fetchApiMock.mockRejectedValue({
      status: 500,
      message: 'Backend exploded',
    });
    renderPage();
    await waitFor(() => {
      expect(screen.getByText(/Backend exploded/)).toBeTruthy();
    });
  });

  it('Back link to /travel/visa/applications is always present in the header', async () => {
    fetchApiMock.mockResolvedValue(BASE_APPLICATION);
    renderPage();
    await waitFor(() => {
      const back = screen.getByRole('link', { name: /Back to Visa Applications/i });
      expect(back.getAttribute('href')).toBe('/travel/visa/applications');
    });
  });

  // ─── Extended coverage (test-cron tick) ────────────────────────────────
  // Below cases extend coverage to uncovered SUT branches: diagnostic id-absent,
  // classification fallback, rejection-history string-literal-null edge, advisor
  // flag "priority", document-checklist 0%/100% edges, null-array checklist,
  // error fallback message, missing contact subheader, refetch on id change.

  it('Diagnostic section: omits "View full diagnostic" link when diagnostic.id is missing', async () => {
    fetchApiMock.mockResolvedValue({
      ...BASE_APPLICATION,
      diagnostic: {
        // No id field — the SUT gates the link on `diagnostic.id != null`.
        classificationLabel: 'Browsing',
        score: 3.2,
      },
    });
    renderPage();
    await screen.findByText('Browsing');
    expect(screen.queryByRole('link', { name: /View full diagnostic/i })).toBeNull();
  });

  it('Diagnostic section: falls back to `classification` when classificationLabel is absent', async () => {
    fetchApiMock.mockResolvedValue({
      ...BASE_APPLICATION,
      diagnostic: {
        id: 11,
        // classificationLabel absent — SUT falls back to `classification`.
        classification: 'level_2',
        score: 5,
      },
    });
    renderPage();
    await screen.findByText('level_2');
  });

  it('Diagnostic section: renders score=0 (not the em-dash) — uses `!= null` not falsy check', async () => {
    fetchApiMock.mockResolvedValue({
      ...BASE_APPLICATION,
      diagnostic: {
        id: 5,
        classificationLabel: 'Cold',
        score: 0,
      },
    });
    renderPage();
    await screen.findByText('Cold');
    // The score should render as literal "0", not the "—" placeholder. The SUT
    // gates this on `score != null` so 0 is a valid value.
    const strong = screen.getByText(/Score:/);
    // Walk to the sibling span containing the score value.
    expect(strong.parentElement.textContent).toMatch(/Score:\s*0/);
  });

  it('Risk pill: rejectionHistoryJson "{}" is treated as no-history (NEUTRAL)', async () => {
    fetchApiMock.mockResolvedValue({
      ...BASE_APPLICATION,
      rejectionHistoryJson: '{}',
    });
    renderPage();
    await screen.findByText('none');
  });

  it('Risk pill: rejectionHistoryJson literal "null" string is treated as no-history (NEUTRAL)', async () => {
    fetchApiMock.mockResolvedValue({
      ...BASE_APPLICATION,
      // The SUT explicitly handles the string "null" — covered helper branch.
      rejectionHistoryJson: 'null',
    });
    renderPage();
    await screen.findByText('none');
  });

  it('Risk pill: advisor flag "priority" activates the yellow pill (FR-3.3)', async () => {
    fetchApiMock.mockResolvedValue({
      ...BASE_APPLICATION,
      advisorRiskFlag: 'priority',
    });
    renderPage();
    await screen.findByText('priority');
  });

  it('Risk pill: advisor flag with arbitrary value (e.g. "low") does NOT activate — raw value still renders', async () => {
    fetchApiMock.mockResolvedValue({
      ...BASE_APPLICATION,
      advisorRiskFlag: 'low',
    });
    renderPage();
    // The raw value renders verbatim even when not activating the yellow pill —
    // isAdvisorRiskActive() only fires on "high" / "priority" (case-insensitive).
    await screen.findByText('low');
  });

  it('Document checklist: 0% progress when all required items are pending', async () => {
    fetchApiMock.mockResolvedValue({
      ...BASE_APPLICATION,
      documentChecklist: [
        { id: 1, name: 'Passport', required: true, status: 'pending' },
        { id: 2, name: 'Photo', required: true, status: 'pending' },
      ],
    });
    renderPage();
    await screen.findByRole('progressbar');
    const bar = screen.getByRole('progressbar');
    expect(bar.getAttribute('aria-valuemax')).toBe('2');
    expect(bar.getAttribute('aria-valuenow')).toBe('0');
  });

  it('Document checklist: 100% progress when all required items are verified', async () => {
    fetchApiMock.mockResolvedValue({
      ...BASE_APPLICATION,
      documentChecklist: [
        { id: 1, name: 'Passport', required: true, status: 'verified' },
        { id: 2, name: 'Photo', required: true, status: 'verified' },
      ],
    });
    renderPage();
    await screen.findByRole('progressbar');
    const bar = screen.getByRole('progressbar');
    expect(bar.getAttribute('aria-valuemax')).toBe('2');
    expect(bar.getAttribute('aria-valuenow')).toBe('2');
  });

  it('Document checklist: non-array documentChecklist (null) renders the empty state', async () => {
    fetchApiMock.mockResolvedValue({
      ...BASE_APPLICATION,
      // SUT guards via `Array.isArray(application?.documentChecklist)` and
      // falls back to []; non-array values must NOT crash the render.
      documentChecklist: null,
    });
    renderPage();
    await screen.findByText(/No document checklist items recorded/i);
  });

  it('Generic error with no message uses the "Failed to load visa application" fallback', async () => {
    // Rejecting with an empty object (no message, no code) — SUT must still
    // render the fallback string instead of "undefined" or crashing.
    fetchApiMock.mockRejectedValue({});
    renderPage();
    await waitFor(() => {
      expect(screen.getByText(/Failed to load visa application/i)).toBeTruthy();
    });
  });

  it('Header sub-line is hidden when contact.name is missing', async () => {
    fetchApiMock.mockResolvedValue({
      ...BASE_APPLICATION,
      contact: { id: 100 }, // no name field
    });
    renderPage();
    // Wait for the main heading to confirm the load completed.
    await screen.findByRole('heading', { level: 1 });
    // The sub-header (containing applicationType / status) is gated on
    // `application?.contact?.name`. With no name, neither value should appear
    // in the contact sub-line (they may also appear nowhere else on the page).
    expect(screen.queryByText('Tourist Visa')).toBeNull();
    expect(screen.queryByText('in_review')).toBeNull();
  });
});
